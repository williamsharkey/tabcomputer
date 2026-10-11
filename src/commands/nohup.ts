/**
 * nohup COMMAND [ARG]... — run COMMAND immune to hangups (#61; it used to be a
 * stub that only logged the command line to nohup.out and never ran it).
 *
 * As GNU coreutils' nohup:
 * - COMMAND runs in a child of this shell (as timeout's does), with SIGHUP
 *   ignored: a hangup the shell gets doesn't reach it (its abort), and the
 *   kernel programs it starts have SIGHUP's disposition set to ignore
 *   (Shell.ignoredSignals, shell-kernel.ts);
 * - stdin that is the terminal is replaced by an empty one;
 * - stdout that is the terminal is appended to ./nohup.out, or ~/nohup.out
 *   when the working directory isn't writable; stderr that is the terminal
 *   goes where stdout goes; output arrives as COMMAND writes it;
 * - the status is COMMAND's (126 when it can't run, 127 when it isn't found);
 *   125 when nohup itself fails.
 * `nohup COMMAND &` keeps running after the shell that started it ends, as
 * every background job does (shell.ts, #53).
 */
import type { Command } from './index';
import { quoteArgsForShell, terminalForCommand } from '../shell';
import { SIGHUP } from '../kernel/signals';

export const nohup: Command = {
  name: "nohup",
  description: "Run a command immune to hangups",
  async exec(ctx) {
    const args = ctx.args[0] === '--' ? ctx.args.slice(1) : ctx.args;
    if (args.length === 0) {
      ctx.stderr += "nohup: missing operand\nTry 'nohup --help' for more information.\n";
      return 125;
    }

    // (a shell running as a kernel process, an agent's `sh -c`: its fd 1 and 2 say whether they are a terminal)
    const kio = (ctx.shell as any).kernelStdio as { file(fd: number): { kind?: string } | undefined } | undefined;
    const isPty = (fd: number) => !kio || kio.file(fd)?.kind === 'pty';
    const inTerminal = ctx.stdinIsTTY !== false && !ctx.stdinReadable;
    const outTerminal = ctx.stdoutIsTTY === true && isPty(1);
    const errTerminal = ctx.stderrIsTTY === true && isPty(2);

    // Where output goes when it would have gone to the terminal
    let outPath: string | null = null;
    let shown = 'nohup.out';
    if (outTerminal) {
      const here = ctx.fs.resolvePath('nohup.out', ctx.cwd);
      const home = ctx.fs.resolvePath('nohup.out', ctx.env['HOME'] || '/home/user');
      for (const [path, name] of [[here, 'nohup.out'], [home, home]] as const) {
        try { await ctx.fs.appendFile(path, ''); outPath = path; shown = name; break; } catch { /* not writable: the next */ }
      }
      if (!outPath) {
        ctx.stderr += `nohup: failed to open '${here}': Permission denied\n`;
        return 125;
      }
    }
    if (outPath) ctx.stderr += inTerminal ? `nohup: ignoring input and appending output to '${shown}'\n` : `nohup: appending output to '${shown}'\n`;
    else if (errTerminal) ctx.stderr += inTerminal ? 'nohup: ignoring input and redirecting stderr to stdout\n' : 'nohup: redirecting stderr to stdout\n';
    else if (inTerminal) ctx.stderr += 'nohup: ignoring input\n';

    const child = ctx.shell.fork();
    // SIGHUP ignored: the shell's own aborts reach COMMAND unless they are a hangup,
    // and its kernel programs ignore one sent to them
    child.ignoredSignals = new Set([...child.ignoredSignals, SIGHUP]);
    const own = new AbortController();
    const outer = ctx.shell.abortController ?? child.inheritedAbort;
    const onOuter = () => {
      const sig = (outer!.signal.reason as { signal?: unknown } | undefined)?.signal;
      if (sig !== SIGHUP) own.abort(outer!.signal.reason);
    };
    if (outer?.signal.aborted) onOuter();
    else outer?.signal.addEventListener('abort', onOuter, { once: true });
    child.inheritedAbort = own;
    child.cwd = ctx.cwd;
    // Programs inside don't write on the terminal what goes to nohup.out (or our own redirect)
    if (ctx.terminal) child.setTerminal(terminalForCommand(ctx.terminal, { stdoutIsTTY: !outPath && ctx.stdoutIsTTY, stderrIsTTY: !outPath && !errTerminal && ctx.stderrIsTTY }) as any);

    // Output: appended to nohup.out as it comes (a server's log grows while it runs), else ours
    let pending: Promise<void> = Promise.resolve();
    const toFile = (s: string) => { if (s) pending = pending.then(() => ctx.fs.appendFile(outPath!, s.replace(/\r\n/g, '\n'))).catch(() => {}); };
    let out = '', err = '';
    const stdout = outPath ? toFile : (ctx.streamStdout ?? ((s: string) => { out += s; }));
    const stderr = outPath && errTerminal ? toFile : (ctx.streamStderr ?? ((s: string) => { err += s; }));

    let code: number;
    try {
      // (stdin that is the terminal is empty; otherwise COMMAND reads what we were given)
      code = await child.executeWithStdin(quoteArgsForShell(args), inTerminal ? '' : (ctx.stdin || ''), stdout, stderr);
    } finally {
      outer?.signal.removeEventListener('abort', onOuter);
      await pending;
    }
    ctx.stdout += out.replace(/\r\n/g, '\n');
    ctx.stderr += err.replace(/\r\n/g, '\n');
    return code;
  },
};
