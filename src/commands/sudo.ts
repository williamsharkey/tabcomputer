import type { Command } from './index';
import type { FileSystem } from '../filesystem';
import { capturingStdout, quoteArgsForShell } from '../shell';

/** The /etc/passwd entry named `target` (or `#UID`), when it is not root or the tab's user. */
async function account(fs: FileSystem, target: string): Promise<{ name: string; uid: number; home: string } | null> {
  let text = '';
  try { text = await fs.readFile('/etc/passwd', 'utf8') as string; } catch { return null; }
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length < 6 || !/^\d+$/.test(f[2])) continue;
    const uid = Number(f[2]);
    if ((f[0] === target || `#${uid}` === target) && uid !== 0 && uid !== 1000) return { name: f[0], uid, home: f[5] || '/' };
  }
  return null;
}

/**
 * sudo [-u USER] [-E] [-H] [-i|-s] [--] COMMAND [ARG]...
 *
 * Runs COMMAND with user id 0: kernel processes it starts (Debian's apt,
 * dpkg, ...) see getuid() == 0. There is one person at the keyboard and no
 * password; the browser tab is the security boundary. `-u user` (or the
 * user's uid) runs as the normal user, and `-u NAME` for another account of
 * /etc/passwd with that account's uid, name and home.
 */
export const sudoCmd: Command = {
  name: 'sudo',
  description: 'Run a command as root',
  async exec(ctx) {
    let target = 'root';
    let preserveEnv = false;
    let login = false;
    let shellMode = false;
    let i = 0;
    for (; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '--') { i++; break; }
      if (!a.startsWith('-') || a === '-') break;
      if (a === '-u' || a === '--user') { target = ctx.args[++i] ?? ''; continue; }
      if (a.startsWith('--user=')) { target = a.slice(7); continue; }
      if (a === '-E' || a.startsWith('--preserve-env')) { preserveEnv = true; continue; }
      if (a === '-i' || a === '--login') { login = true; continue; }
      if (a === '-s' || a === '--shell') { shellMode = true; continue; }
      if (a === '-v' || a === '--validate' || a === '-k' || a === '-K' || a === '--reset-timestamp' || a === '--remove-timestamp') {
        if (i === ctx.args.length - 1) return 0;
        continue;
      }
      if (a === '-l' || a === '--list') {
        ctx.stdout += `User ${ctx.env.USER || 'user'} may run the following commands on ${ctx.env.HOSTNAME || 'shiro'}:\n    (ALL : ALL) NOPASSWD: ALL\n`;
        return 0;
      }
      if (a === '-h' || a === '--help') {
        ctx.stdout += 'usage: sudo [-u user] [-E] [-H] [-i|-s] [--] command [arg ...]\n';
        return 0;
      }
      if (a === '-V' || a === '--version') { ctx.stdout += 'Sudo version 1.9 (tabcomputer)\n'; return 0; }
      if (/^-[nHSbAP]+$/.test(a)) continue; // non-interactive, set-home, stdin password, ...
      if (a === '-g' || a === '-C' || a === '-p' || a === '-r' || a === '-t' || a === '-D' || a === '-h') { i++; continue; }
      ctx.stderr += `sudo: invalid option -- '${a.replace(/^-+/, '')}'\n`;
      return 1;
    }
    let uid = target === 'root' || target === '#0' || target === '0' ? 0
      : target === (ctx.env.USER || 'user') || target === '#1000' || target === '1000' ? 1000 : -1;
    // An account a Debian package made (postgres, www-data): its uid, name and home from /etc/passwd
    const other = uid < 0 ? await account(ctx.fs, target) : null;
    if (other) uid = other.uid;
    // `sudo -u postgres psql` without Debian's PostgreSQL: the tab's own server has no account, so
    // the command runs as the tab's user under that name, which is the role psql then asks for
    const asPostgres = uid < 0 && target === 'postgres';
    if (asPostgres) uid = 1000;
    if (uid < 0) {
      ctx.stderr += `sudo: unknown user ${target}\n`;
      return 1;
    }
    let command = ctx.args.slice(i);
    if (!command.length) {
      if (!login && !shellMode) {
        ctx.stderr += 'usage: sudo [-u user] [-E] [-H] [-i|-s] [--] command [arg ...]\n';
        return 1;
      }
      command = [ctx.env.SHELL || 'bash'];
    } else if (login || shellMode) {
      command = ['sh', '-c', quoteArgsForShell(command)];
    }

    const toTerm = !!ctx.terminal && ctx.stdoutIsTTY !== false;
    const child = ctx.shell.fork();
    // Piped or redirected (`sudo apt-get update | tail -1`): programs keep the
    // tty for input but their stdout comes back here, as in $(...)
    if (ctx.terminal) child.setTerminal((toTerm ? ctx.terminal : capturingStdout(ctx.terminal)) as any);
    child.cwd = ctx.cwd;
    child.uid = uid;
    const me = ctx.env.USER || 'user';
    const env = preserveEnv ? { ...child.env } : { ...child.env };
    if (uid === 0) {
      Object.assign(env, { USER: 'root', LOGNAME: 'root', HOME: '/root', SUDO_USER: me, SUDO_UID: '1000', SUDO_GID: '1000', SUDO_COMMAND: command.join(' ') });
      if (preserveEnv) env.HOME = child.env.HOME ?? '/root';
      // sudo's secure_path: the sbin directories come first
      if (!preserveEnv) env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' + (child.env.PATH ? ':' + child.env.PATH : '');
      if (login) child.cwd = '/root';
    }
    if (other) Object.assign(env, { USER: other.name, LOGNAME: other.name, HOME: other.home, SUDO_USER: me, SUDO_UID: '1000', SUDO_GID: '1000' });
    if (asPostgres) Object.assign(env, { USER: 'postgres', LOGNAME: 'postgres', SUDO_USER: me });
    child.env = env;
    const out = (s: string) => { if (toTerm) (ctx.terminal as any).writeOutput(s); else ctx.stdout += s.replace(/\r\n/g, '\n'); };
    const err = (s: string) => { if (toTerm) (ctx.terminal as any).writeOutput(s); else ctx.stderr += s.replace(/\r\n/g, '\n'); };
    return child.executeWithStdinOf(ctx, quoteArgsForShell(command), ctx.streamStdout ?? out, ctx.streamStderr ?? err);
  },
};
