/**
 * pgrep, pkill - find or signal processes, as procps-ng's do: the pattern is
 * an extended regular expression matched against the process name (comm, 15
 * characters), or against the whole command line with -f; -x anchors it, -i
 * ignores case, -v inverts (pgrep). -u/-U, -P, -g, -s and -t narrow by user,
 * parent, group, session and terminal; -n/-o keep the newest or oldest.
 * pgrep prints pids (-l with names, -a with command lines, -c a count, -d a
 * delimiter); pkill sends -SIGNAL / --signal (default TERM), -e says what.
 * The processes are ps's (./ps processInfos). The process running the command
 * is never matched, as procps leaves itself out: a builtin runs in its shell,
 * so that is the shell, and `sh -c 'pkill -f x; ...'` doesn't kill itself.
 * Status: 0 matched, 1 nothing matched, 2 usage.
 */
import { Command, CommandContext } from './index';
import { processInfos, type Info } from './ps';
import { kill } from './trap';

interface Selection { matched: Info[]; sig: number; list: '' | 'l' | 'a'; count: boolean; echo: boolean; delim: string }

const SHORT_FLAGS = 'flaxivnoce';
const SHORT_VALUES: Record<string, string> = { u: 'euid', U: 'uid', P: 'parent', g: 'pgroup', G: 'group', s: 'session', t: 'terminal', d: 'delimiter' };
const LONG_FLAGS: Record<string, string> = {
  full: 'f', 'list-name': 'l', 'list-full': 'a', exact: 'x', 'ignore-case': 'i', inverse: 'v', newest: 'n', oldest: 'o', count: 'c', echo: 'e',
};
const LONG_VALUES = ['euid', 'uid', 'parent', 'pgroup', 'group', 'session', 'terminal', 'delimiter', 'signal'];

/** The processes `name ARGS` selects, or the status it fails with */
async function select(ctx: CommandContext, name: 'pgrep' | 'pkill'): Promise<Selection | number> {
  const { signalNumber, SIGTERM } = await import('../kernel/signals');
  const usage = (msg: string) => { ctx.stderr += `${name}: ${msg}\nTry \`${name} --help' for more information.\n`; return 2; };
  const args = [...ctx.args];
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const patterns: string[] = [];
  let sig = SIGTERM;
  // pkill's first argument may be the signal: -9, -KILL, -SIGKILL
  if (name === 'pkill' && args[0]?.startsWith('-') && signalNumber(args[0].slice(1)) !== undefined) sig = signalNumber(args.shift()!.slice(1))!;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { patterns.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const long = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (LONG_FLAGS[long] && eq < 0) { flags.add(LONG_FLAGS[long]); continue; }
      if (!LONG_VALUES.includes(long)) return usage(`unrecognized option '${a}'`);
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) return usage(`option '--${long}' requires an argument`);
      values[long] = v;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (SHORT_FLAGS.includes(c)) { flags.add(c); continue; }
        if (!SHORT_VALUES[c]) return usage(`invalid option -- '${c}'`);
        const v = a.slice(j + 1) || args[++i];
        if (v === undefined) return usage(`option requires an argument -- '${c}'`);
        values[SHORT_VALUES[c]] = v;
        break;
      }
      continue;
    }
    patterns.push(a);
  }
  if (values.signal !== undefined) {
    const n = signalNumber(values.signal);
    if (n === undefined) return usage(`Unknown signal "${values.signal}".`);
    sig = n;
  }
  // (each tool's own: pgrep has no -e, pkill no -l/-a/-v/-d)
  const foreign = name === 'pgrep' ? ['e'] : ['l', 'a', 'v'];
  const bad = foreign.find((f) => flags.has(f)) ?? (name === 'pkill' && values.delimiter !== undefined ? 'd' : undefined);
  if (bad) return usage(`invalid option -- '${bad}'`);
  if (flags.has('n') && flags.has('o')) return usage('-n and -o cannot be used together');
  if (patterns.length > 1) return usage('only one pattern can be provided');
  const criteria = ['euid', 'uid', 'parent', 'pgroup', 'group', 'session', 'terminal'].filter((k) => values[k] !== undefined);
  if (!patterns.length && !criteria.length) return usage('no matching criteria specified');

  let re: RegExp | null = null;
  if (patterns.length) {
    try { re = new RegExp(flags.has('x') ? `^(?:${patterns[0]})$` : patterns[0], flags.has('i') ? 'i' : ''); }
    catch (e) { return usage(`regex error: ${e instanceof Error ? e.message : String(e)}`); }
    if (!flags.has('f') && patterns[0].length > 15) {
      ctx.stderr += `${name}: pattern that searches for process name longer than 15 characters will result in zero matches\nTry \`${name} -f' option to match against the complete command line.\n`;
    }
  }

  const all = await processInfos(ctx);
  // Itself: the pid an in-page command has while it runs (/proc/self), its shell, and, as an
  // in-page shell (`sh -c`, `sh script`) runs inside its parent's process, the shells up to that one
  const { shellForPid } = await import('../shell');
  const self = new Set([Number(await ctx.fs.readlink('/proc/self').catch(() => NaN)), ctx.shell.shellPid]);
  for (let sh: typeof ctx.shell | undefined = ctx.shell; sh && sh.kernelPid === undefined && sh.shellPid !== 1 && !self.has(sh.parentPid); sh = shellForPid(sh.parentPid)) self.add(sh.parentPid);
  const own = all.find((p) => self.has(p.pid));
  const list = (k: string) => (values[k] === undefined ? null : values[k].split(',').filter(Boolean));
  const users = [...(list('euid') ?? []), ...(list('uid') ?? [])];
  const ids = (k: string, zero: number | undefined) => list(k)?.map((v) => (v === '0' && zero !== undefined ? zero : Number(v))) ?? null;
  const parents = ids('parent', undefined), groups = ids('pgroup', own?.pgid), sessions = ids('session', own?.sid);
  const ttys = list('terminal');
  const matches = (p: Info): boolean => {
    // (a user's group is its own, as ps prints it)
    if (![users, list('group')].every((names) => !names?.length || names.includes(p.user) || names.includes(String(p.uid)))) return false;
    if (parents && !parents.includes(p.ppid)) return false;
    if (groups && !groups.includes(p.pgid)) return false;
    if (sessions && !sessions.includes(p.sid)) return false;
    if (ttys && !ttys.includes(p.tty)) return false;
    return re ? re.test(flags.has('f') ? p.args : p.comm) : true;
  };
  let matched = all.filter((p) => !self.has(p.pid) && matches(p) !== flags.has('v'));
  if ((flags.has('n') || flags.has('o')) && matched.length) {
    const byAge = [...matched].sort((a, b) => a.startMs - b.startMs || a.pid - b.pid);
    matched = [flags.has('n') ? byAge[byAge.length - 1] : byAge[0]];
  }
  return { matched, sig, list: flags.has('a') ? 'a' : flags.has('l') ? 'l' : '', count: flags.has('c'), echo: flags.has('e'), delim: values.delimiter ?? '\n' };
}

export const pgrepCmd: Command = {
  name: 'pgrep',
  description: 'Find processes by name',
  async exec(ctx) {
    const s = await select(ctx, 'pgrep');
    if (typeof s === 'number') return s;
    if (s.count) ctx.stdout += `${s.matched.length}\n`;
    else if (s.matched.length) ctx.stdout += s.matched.map((p) => (s.list === 'a' ? `${p.pid} ${p.args}` : s.list === 'l' ? `${p.pid} ${p.comm}` : String(p.pid))).join(s.delim) + '\n';
    return s.matched.length ? 0 : 1;
  },
};

export const pkillCmd: Command = {
  name: 'pkill',
  description: 'Signal processes by name',
  async exec(ctx) {
    const s = await select(ctx, 'pkill');
    if (typeof s === 'number') return s;
    // init takes no signal it has no handler for, as on Linux
    const targets = s.matched.filter((p) => p.pid !== 1);
    if (s.count) ctx.stdout += `${targets.length}\n`;
    if (!targets.length) return 1;
    // kill's own delivery: kernel processes, shells, in-page jobs, windows (one that has just gone is no error)
    await kill.exec({ ...ctx, args: ['-s', String(s.sig), '--', ...targets.map((p) => String(p.pid))], stdout: '', stderr: '' });
    if (s.echo) ctx.stdout += targets.map((p) => `${p.comm} killed (pid ${p.pid})\n`).join('');
    return 0;
  },
};
