import { Command, CommandContext } from './index';
import { kernelDiagnostics } from '../kernel-diag';
import { diagnostics, formatDiagnostics, clearWatchdog, WATCHDOG_OFF_KEY, watchdogDisabled, watchdogInstalled, abortForeground, ABORT_AFTER_KEY, autoAbortMs } from '../watchdog';

/**
 * watchdog - what froze the page: event-loop lag, long tasks, commands in flight
 *
 * Usage:
 *   watchdog               Lag, long tasks, heap, commands in flight, recent events
 *   watchdog --prev        The events saved by the previous page load
 *   watchdog -n 50         Show the last 50 events (default 40)
 *   watchdog -k stall,lag  Only these kinds (lag stall longtask loaf cmd cmd-end wedge note)
 *   watchdog --since 600   Events in the last 600 seconds
 *   watchdog --json        Machine-readable (the remote `diag` request returns the same)
 *   watchdog --clear       Empty this load's ring
 *   watchdog --kernel [RE] Kernel processes as JSON: syscalls in progress, sockets, pipes, FIFOs
 *   watchdog abort         Abort the foreground commands everywhere (like Ctrl-C in every terminal)
 *   watchdog abort-after N Abort them by itself after the page has been frozen N s (off: never; from the next load)
 *   watchdog off | on      Turn it off from the next load on (safe mode too), or back on
 *   watchdog profile start [-d S] [-i MS] [-p RE] [LABEL]   Capture long tasks, input/echo latency,
 *                          syscalls and Blink lock stats for S seconds (src/live-profile.ts)
 *   watchdog profile stop|status|mark TEXT|save FILE         End it, show it, note a moment, write the JSON
 */
export const watchdogCmd: Command = {
  name: 'watchdog',
  description: 'Show page freezes: event-loop lag, long tasks, commands in flight',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    if (args[0] === 'off' || args[0] === 'on') {
      try { args[0] === 'off' ? localStorage.setItem(WATCHDOG_OFF_KEY, '1') : localStorage.removeItem(WATCHDOG_OFF_KEY); } catch { /* no storage */ }
      ctx.stdout = `watchdog ${args[0]} from the next load${watchdogInstalled() ? '' : ' (not running in this one)'}\n`;
      return 0;
    }
    if (args[0] === 'abort') {
      const hit = abortForeground('watchdog abort');
      ctx.stdout = (hit.length ? hit.join('\n') : 'nothing in the foreground') + '\n';
      return 0;
    }
    if (args[0] === 'abort-after') {
      const v = args[1];
      if (v === undefined) { ctx.stdout = `abort-after: ${autoAbortMs() ? autoAbortMs() / 1000 + ' s' : 'off'}\n`; return 0; }
      const n = v === 'off' ? 0 : Number(v);
      if (!Number.isFinite(n) || n < 0 || (n > 0 && n < 5)) { ctx.stderr = 'watchdog: abort-after takes seconds (5 or more) or off\n'; return 2; }
      try { n ? localStorage.setItem(ABORT_AFTER_KEY, String(n)) : localStorage.removeItem(ABORT_AFTER_KEY); } catch { /* no storage */ }
      ctx.stdout = `abort-after ${n ? n + ' s' : 'off'} from the next load\n`;
      return 0;
    }
    if (args[0] === 'profile') return profileCmd(ctx, args.slice(1));
    let limit = 40;
    let kind: string | undefined;
    let since: number | undefined;
    let previous = false;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-n') limit = parseInt(args[++i]) || limit;
      else if (a === '-k' || a === '--kind') kind = args[++i];
      else if (a === '--since') since = -1000 * (parseFloat(args[++i]) || 0);
      else if (a === '--prev' || a === '--previous') previous = true;
      else if (a === '--json') json = true;
      else if (a === '--clear') { clearWatchdog(); return 0; }
      else if (a === '--kernel') {
        const grep = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : undefined;
        ctx.stdout = JSON.stringify(kernelDiagnostics({ grep }), null, 1) + '\n';
        return 0;
      }
      else if (a === '-h' || a === '--help') {
        ctx.stdout = 'usage: watchdog [--prev] [-n N] [-k KINDS] [--since SECONDS] [--json] [--clear] | watchdog --kernel [RE] | watchdog abort | watchdog abort-after N|off | watchdog off|on | watchdog profile start|stop|status|mark|save\n';
        return 0;
      } else {
        ctx.stderr = `watchdog: unknown option ${a}\n`;
        return 2;
      }
    }
    const d = diagnostics({ limit, kind, since, previous });
    if (!watchdogInstalled() && !json) ctx.stdout = `watchdog: not running in this load (${watchdogDisabled() ?? 'no window'}); \`watchdog on\` to turn it back on\n`;
    ctx.stdout = (ctx.stdout || '') + (json ? JSON.stringify(d) : formatDiagnostics(d)) + '\n';
    return 0;
  },
};

async function profileCmd(ctx: CommandContext, a: string[]): Promise<number> {
  const lp = await import('../live-profile');
  const show = async () => {
    const p = await lp.fullProfile();
    return p ? lp.summarizeProfile(p).join('\n') + '\n' : 'no profile captured in this load\n';
  };
  switch (a[0]) {
    case 'start': {
      const o: { durationMs?: number; sampleMs?: number; procGrep?: string; label?: string } = {};
      const words: string[] = [];
      for (let i = 1; i < a.length; i++) {
        if (a[i] === '-d') o.durationMs = 1000 * (parseFloat(a[++i]) || 60);
        else if (a[i] === '-i') o.sampleMs = parseInt(a[++i]) || undefined;
        else if (a[i] === '-p') o.procGrep = a[++i];
        else words.push(a[i]);
      }
      if (words.length) o.label = words.join(' ');
      const m = await lp.startProfile(o);
      ctx.stdout = `profile ${m.id} started: ${m.durationMs / 1000} s, sample ${m.sampleMs} ms${m.procGrep ? `, processes /${m.procGrep}/` : ''}\n`;
      return 0;
    }
    case 'stop':
      if (!lp.stopProfile()) { ctx.stderr = 'watchdog: no profile running\n'; return 1; }
      ctx.stdout = await show();
      return 0;
    case 'status':
    case undefined:
      ctx.stdout = await show();
      return 0;
    case 'mark':
      if (!lp.markProfile(a.slice(1).join(' '))) { ctx.stderr = 'watchdog: no profile running\n'; return 1; }
      return 0;
    case 'save': {
      const p = await lp.fullProfile();
      if (!p || !a[1]) { ctx.stderr = p ? 'usage: watchdog profile save FILE\n' : 'watchdog: no profile captured in this load\n'; return p ? 2 : 1; }
      await ctx.fs.writeFile(ctx.fs.resolvePath(a[1], ctx.cwd), JSON.stringify(p));
      return 0;
    }
    default:
      ctx.stderr = 'usage: watchdog profile start [-d SECONDS] [-i SAMPLE_MS] [-p PROC_RE] [LABEL] | stop | status | mark TEXT | save FILE\n';
      return 2;
  }
}
