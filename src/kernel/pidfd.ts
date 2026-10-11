/**
 * pidfd_open(2): a descriptor for a process. It polls readable (POLLIN) once
 * the process has exited, which is how tokio (and Python's os.pidfd_open,
 * systemd) wait for children without SIGCHLD: epoll on the pidfd, then
 * waitpid(WNOHANG). pidfd_send_signal(2) signals through it.
 */
import { type KStat, EINVAL, POLLIN } from './abi';
import { type OpenFile, type OpenFileKind, ReadyListeners, charDevStat } from './fd';
import type { Process } from './process';

export class PidFdFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  path = 'anon_inode:[pidfd]';
  private listeners = new ReadyListeners();
  private off: (() => void) | null;

  constructor(readonly target: Process, public flags: number) {
    // (its exit wakes pollers: markExited notifies the process's state waiters)
    this.off = target.onStateChange(() => { if (this.exited) this.listeners.fire(); });
  }

  /** The process has exited (a zombie, or reaped since) */
  get exited(): boolean { return this.target.exitStatus !== undefined; }

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
