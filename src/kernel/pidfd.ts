/**
 * pidfd_open(2): a descriptor for a process. It polls readable (POLLIN) once
 * the process has exited, which is how tokio (and Python's os.pidfd_open,
 * systemd) wait for children without SIGCHLD: epoll on the pidfd, then
 * waitpid(WNOHANG). pidfd_send_signal(2) signals through it, and
 * ioctl(PIDFD_GET_INFO) tells its pid, ids and, once it has exited, its
 * wait status.
 */
import { type KStat, EINVAL, ENOTTY, ESRCH, POLLIN } from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, charDevStat } from './fd';
import type { Process } from './process';

export class PidFdFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  path = 'anon_inode:[pidfd]';
  private listeners = new ReadyListeners();
  private off: (() => void) | null;

  /** `reaped`: its parent (or init) has reaped it */
  constructor(readonly target: Process, public flags: number, private reaped: () => boolean = () => false) {
    // (its exit wakes pollers: markExited notifies the process's state waiters)
    this.off = target.onStateChange(() => { if (this.exited) this.listeners.fire(); });
  }

  /** The process has exited (a zombie, or reaped since) */
  get exited(): boolean { return this.target.exitStatus !== undefined; }

  /**
   * PIDFD_GET_INFO, _IOWR(0xFF, 11, struct pidfd_info) of 64 bytes or more:
   * the process's pid, tgid, ppid and ids (PIDFD_INFO_PID, _CREDS), and once
   * it has been reaped its wait status (PIDFD_INFO_EXIT), if the mask asks
   * for that, else ESRCH (Linux 6.15)
   */
  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if ((req & 0xffff) !== 0xff0b || req >>> 30 !== 3) return -ENOTTY;
    if (((req >>> 16) & 0x3fff) < 64 || arg.length < 64) return -EINVAL;
    const dv = new DataView(arg.buffer, arg.byteOffset, 64);
    const ask = dv.getBigUint64(0, true);
    const t = this.target;
    const gone = this.exited && this.reaped();
    if (gone && !(ask & 8n)) return -ESRCH;
    arg.fill(0, 0, 64);
    // PIDFD_INFO_PID | PIDFD_INFO_CREDS, and PIDFD_INFO_EXIT once it has been
    // reaped (a zombie's isn't there yet, as on Linux; the ids stay either way)
    dv.setBigUint64(0, gone ? 11n : 3n, true);
    if (gone) dv.setInt32(60, t.exitStatus!, true); // exit_code
    const ids = [t.pid, t.pid, t.ppid, t.ruid ?? t.uid, t.rgid ?? t.gid, t.uid, t.gid, t.suid ?? t.uid, t.sgid ?? t.gid, t.uid, t.gid];
    ids.forEach((v, i) => dv.setUint32(16 + i * 4, v, true));
    return 0;
  }

  async read(): Promise<number> { return -EINVAL; }
  async write(): Promise<number> { return -EINVAL; }
  poll(events: number): number { return (this.exited ? POLLIN : 0) & events; }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<KStat> { return charDevStat(0); }
  async close(): Promise<void> {
    this.off?.();
    this.off = null;
  }
}
