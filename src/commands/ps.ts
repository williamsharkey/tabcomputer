/**
 * ps - list running processes, in procps-ng's formats: the default
 * (PID TTY TIME CMD), -f, BSD `aux`, and -o/-eo column lists (pid, ppid,
 * pgid, sid, stat, state, user, uid, time, etime, etimes, rss, vsz, tty,
 * comm, args/cmd, ...; `col=` renames or blanks a header). Kernel processes'
 * fields come from /proc; the page's own (windows, servers) have init as
 * their parent and no tty. -e/-A/-a/-x select all, as every process here is
 * the user's; -p and -C narrow it; --no-headers.
 * kill - re-exported from ./trap
 */

import { Command, CommandContext } from './index';
import { processTable } from '../process-table';

const HZ = 100;

export interface Info {
  pid: number; ppid: number; pgid: number; sid: number;
  state: string; uid: number; user: string;
  cpuMs: number; startMs: number; tty: string;
  comm: string; args: string;
}

/** A column: header, width, right-aligned, value */
interface Col { header: string; width: number; right: boolean; value: (p: Info) => string }

const pad2 = (n: number) => String(n).padStart(2, '0');
/** TIME: [dd-]hh:mm:ss */
function cpuTime(ms: number): string {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  return (d ? `${d}-` : '') + `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}
/** ELAPSED: [[dd-]hh:]mm:ss */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24;
  return (d ? `${d}-${pad2(h)}:` : h ? `${pad2(h)}:` : '') + `${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}
const hhmm = (ms: number) => { const t = new Date(ms); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
/** command lines on one line: control characters escaped */
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, (c) => c === '\n' ? '\\n' : c === '\t' ? '\\t' : '?');

const COLUMNS: Record<string, Col> = {};
const def = (names: string[], header: string, width: number, right: boolean, value: (p: Info) => string) => {
  for (const n of names) COLUMNS[n] = { header, width, right, value };
};
def(['pid', 'tgid'], 'PID', 5, true, (p) => String(p.pid));
def(['ppid'], 'PPID', 5, true, (p) => String(p.ppid));
def(['pgid', 'pgrp'], 'PGID', 5, true, (p) => String(p.pgid));
def(['sid', 'sess', 'session'], 'SID', 5, true, (p) => String(p.sid));
def(['stat'], 'STAT', 4, false, (p) => p.state + (p.sid === p.pid ? 's' : ''));
def(['state', 's'], 'S', 1, false, (p) => p.state);
def(['user', 'uname', 'euser', 'ruser'], 'USER', 8, false, (p) => p.user);
def(['uid', 'euid', 'ruid'], 'UID', 5, true, (p) => String(p.uid));
def(['gid', 'egid'], 'GID', 5, true, (p) => String(p.uid));
def(['group', 'egroup'], 'GROUP', 8, false, (p) => p.user);
def(['time', 'cputime'], 'TIME', 8, true, (p) => cpuTime(p.cpuMs));
def(['times', 'cputimes'], 'TIME', 6, true, (p) => String(Math.floor(p.cpuMs / 1000)));
def(['etime'], 'ELAPSED', 11, true, (p) => elapsed(Date.now() - p.startMs));
def(['etimes'], 'ELAPSED', 7, true, (p) => String(Math.floor((Date.now() - p.startMs) / 1000)));
def(['rss', 'rssize', 'rsz'], 'RSS', 5, true, () => '0');
def(['vsz', 'vsize'], 'VSZ', 6, true, () => '0');
def(['%cpu', 'pcpu', 'c'], '%CPU', 4, true, (p) => { const t = Date.now() - p.startMs; return (t > 0 ? (100 * p.cpuMs) / t : 0).toFixed(1); });
def(['%mem', 'pmem'], '%MEM', 4, true, () => '0.0');
def(['nice', 'ni'], 'NI', 3, true, () => '0');
def(['pri'], 'PRI', 3, true, () => '19');
def(['tty', 'tt', 'tname'], 'TT', 8, false, (p) => p.tty);
def(['stime', 'start_time'], 'STIME', 5, false, (p) => hhmm(p.startMs));
def(['start'], 'STARTED', 8, true, (p) => hhmm(p.startMs));
def(['lstart'], 'STARTED', 24, true, (p) => new Date(p.startMs).toString().replace(/^(\w+) (\w+) (\d+) (\d+) ([\d:]+).*$/, (_, w, m, d, y, t) => `${w} ${m} ${d.padStart(2)} ${t} ${y}`));
def(['comm', 'ucomm', 'ucmd', 'fname'], 'COMMAND', 15, false, (p) => p.comm);
def(['args', 'command'], 'COMMAND', 27, false, (p) => p.args);
def(['cmd'], 'CMD', 27, false, (p) => p.args);
def(['nlwp', 'thcount'], 'NLWP', 4, true, () => '1');
def(['wchan'], 'WCHAN', 6, false, () => '-');
def(['f', 'flags'], 'F', 1, true, () => '0');
def(['cls', 'class', 'policy'], 'CLS', 3, false, () => 'TS');

let bootAt: number | null | undefined;
/** When the machine booted, from /proc/stat's btime */
async function bootMs(ctx: CommandContext): Promise<number | null> {
  if (bootAt !== undefined) return bootAt;
  try {
    const m = /^btime (\d+)/m.exec(await ctx.fs.readFile('/proc/stat', 'utf8') as string);
    bootAt = m ? Number(m[1]) * 1000 : null;
  } catch { bootAt = null; }
  return bootAt;
}

/** A process's fields: the kernel's /proc for its processes, defaults for the page's */
async function infoOf(ctx: CommandContext, p: ReturnType<typeof processTable.list>[number], users: Map<number, string>): Promise<Info | null> {
  const read = async (f: string) => { try { return await ctx.fs.readFile(`/proc/${p.pid}/${f}`, 'utf8') as string; } catch { return null; } };
  const args = oneLine(p.command);
  const base = args.split(/\s+/)[0] ?? '';
  const info: Info = {
    pid: p.pid, ppid: 1, pgid: p.pid, sid: p.pid,
    state: p.zombie ? 'Z' : p.status === 'stopped' ? 'T' : 'S', uid: 1000, user: users.get(1000) ?? 'user',
    cpuMs: 0, startMs: p.startTime, tty: '?',
    comm: (base.split('/').pop() || base).slice(0, 15), args,
  };
  const stat = await read('stat');
  if (!stat && !p.command) return null;
  if (stat) {
    // "pid (comm) S ppid pgid sid tty_nr ..." (comm may hold spaces and parentheses)
    const close = stat.lastIndexOf(')');
    const f = stat.slice(close + 2).trim().split(' ');
    info.comm = stat.slice(stat.indexOf('(') + 1, close);
    info.state = f[0] || info.state;
    info.ppid = Number(f[1]); info.pgid = Number(f[2]); info.sid = Number(f[3]);
    info.cpuMs = (Number(f[11]) + Number(f[12])) * (1000 / HZ);
    // starttime: ticks since boot
    const boot = await bootMs(ctx);
    if (boot !== null && f[19]) info.startMs = boot + Number(f[19]) * (1000 / HZ);
    const ttyNr = Number(f[4]);
    if (ttyNr) info.tty = (ttyNr >> 8) === 136 ? `pts/${ttyNr & 0xff}` : (ttyNr >> 8) === 4 ? `tty${ttyNr & 0xff}` : '?';
    const status = await read('status');
    const uid = status ? /^Uid:\s+(\d+)/m.exec(status) : null;
    if (uid) { info.uid = Number(uid[1]); info.user = users.get(info.uid) ?? String(info.uid); }
    const cmdline = await read('cmdline');
    if (cmdline) info.args = oneLine(cmdline.replace(/\0$/, '').split('\0').join(' '));
    else if (info.state === 'Z') info.args = `[${info.comm}] <defunct>`;
  }
  return info;
}

/** Every process's fields, by pid: the kernel's (/proc) and the page's own */
export async function processInfos(ctx: CommandContext): Promise<Info[]> {
  const users = new Map<number, string>([[0, 'root'], [1000, 'user']]);
  try {
    const passwd = await ctx.fs.readFile('/etc/passwd', 'utf8') as string;
    for (const l of passwd.split('\n')) { const f = l.split(':'); if (f.length > 2) users.set(Number(f[2]), f[0]); }
  } catch { /* defaults */ }

  // The kernel's processes (/proc), and the page's: live ones, and zombies until their
  // parent reaps them; not the exited windows the table keeps a while
  const procs = processTable.list().filter((p) => p.zombie || p.status === 'running' || p.status === 'stopped');
  const known = new Set(procs.map((p) => p.pid));
  try {
    for (const e of await ctx.fs.readdir('/proc')) {
      const pid = Number(e);
      if (!/^\d+$/.test(e) || known.has(pid)) continue;
      known.add(pid);
      procs.push({ pid, command: '', status: 'running', startTime: Date.now() } as (typeof procs)[number]);
    }
  } catch { /* no /proc */ }
  procs.sort((a, b) => a.pid - b.pid);
  return (await Promise.all(procs.map((p) => infoOf(ctx, p, users)))).filter((p): p is Info => !!p);
}

const USAGE = '\nUsage:\n ps [options]\n\n Try \'ps --help <simple|list|output|threads|misc|all>\'\n';

export const psCmd: Command = {
  name: 'ps',
  description: 'List running processes',
  async exec(ctx) {
    const formats: string[] = [];
    let full = false, bsdUser = false, headers = true;
    const pids = new Set<number>();
    const names = new Set<string>();
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      let a = args[i];
      const eq = a.indexOf('=');
      const long = a.startsWith('--') ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
      if (long !== null) {
        const val = () => (eq > 0 ? a.slice(eq + 1) : args[++i] ?? '');
        if (long === 'no-headers' || long === 'no-heading') headers = false;
        else if (long === 'format') formats.push(val());
        else if (long === 'pid' || long === 'quick-pid') for (const p of val().split(/[,\s]+/)) pids.add(Number(p));
        else if (long === 'ppid' || long === 'sort' || long === 'cols' || long === 'columns' || long === 'width' || long === 'user') val();
        else if (long !== 'forest' && long !== 'headers') { ctx.stderr += `error: unknown gnu long option${USAGE}`; return 1; }
        continue;
      }
      // BSD options: no dash (aux, ax, axo FMT)
      const bsd = !a.startsWith('-');
      if (bsd) a = '-' + a;
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        const val = () => { const v = a.slice(j + 1) || args[++i] || ''; j = a.length; return v; };
        if ('eAaxgdNT'.includes(c)) continue;
        if (c === 'f' && !bsd) full = true;
        else if (c === 'u' && bsd) bsdUser = true;
        else if (c === 'o' || c === 'O') formats.push(val());
        else if (c === 'p' || c === 'q') for (const p of val().split(/[,\s]+/)) pids.add(Number(p));
        else if (c === 'C') for (const n of val().split(/[,\s]+/)) names.add(n);
        else if (c === 'u' || c === 'U' || c === 'g' || c === 'G' || c === 't' || c === 's') val();
        else if (c === 'w' || c === 'l' || c === 'j' || c === 'F' || c === 'H' || c === 'L' || c === 'h' || c === 'r' || c === 'c' || c === 'f' || c === 'M' || c === 'y') { if (c === 'h') headers = false; }
        else { ctx.stderr += `error: unsupported option (BSD syntax)${USAGE}`; return 1; }
      }
    }

    // The columns: -o's list, else -f's, aux's, or the default
    const spec = formats.length ? formats.join(',')
      : bsdUser ? 'user,pid,%cpu,%mem,vsz,rss,tty,stat,start,bsdtime,args'
      : full ? 'uid_name,pid,ppid,c,stime,tty,time,cmd'
      : 'pid,tty,time,comm=CMD';
    const cols: Col[] = [];
    // `col=header` takes the rest of its list item (the header may hold commas only as the last item)
    const items = spec.split(/[,\s]+/).filter(Boolean);
    for (const item of items) {
      const e = item.indexOf('=');
      const name = (e < 0 ? item : item.slice(0, e)).toLowerCase();
      const col = name === 'uid_name' ? { header: 'UID', width: 8, right: false, value: (p: Info) => p.user }
        : name === 'bsdtime' ? { header: 'TIME', width: 6, right: true, value: (p: Info) => { const s = Math.floor(p.cpuMs / 1000); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; } }
        : name === 'c' && full ? { header: 'C', width: 2, right: true, value: () => '0' }
        : name === 'tty' && !formats.length ? { header: 'TTY', width: 8, right: false, value: (p: Info) => p.tty }
        : name === 'stat' && bsdUser ? { ...COLUMNS.stat, width: 4 }
        : name === 'start' && bsdUser ? { header: 'START', width: 5, right: false, value: (p: Info) => hhmm(p.startMs) }
        : COLUMNS[name];
      if (!col) { ctx.stderr += `error: unknown user-defined format specifier "${name}"${USAGE}`; return 1; }
      cols.push(e < 0 ? col : { ...col, header: item.slice(e + 1) });
    }

    let infos = await processInfos(ctx);
    if (pids.size) infos = infos.filter((p) => pids.has(p.pid));
    if (names.size) infos = infos.filter((p) => names.has(p.comm));

    const rows: string[][] = infos.map((p) => cols.map((c) => c.value(p)));
    const lines: string[] = [];
    const render = (cells: string[]) => cells.map((v, k) => {
      if (k === cols.length - 1) return cols[k].right ? v.padStart(cols[k].width) : v;
      return cols[k].right ? v.padStart(cols[k].width) : v.padEnd(cols[k].width);
    }).join(' ');
    if (headers && cols.some((c) => c.header)) lines.push(render(cols.map((c) => c.header)).replace(/ +$/, ''));
    for (const r of rows) lines.push(render(r));
    ctx.stdout += lines.map((l) => l + '\n').join('');
    // procps: status 1 when -p/-C selected nothing
    return (pids.size || names.size) && !infos.length ? 1 : 0;
  },
};

/** The real `kill` lives with `trap` (bash builtin semantics, kernel signals) */
export { kill as killCmd } from './trap';
