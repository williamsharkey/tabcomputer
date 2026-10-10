import { Command, CommandContext } from './index';
import { kernelDiagnostics } from '../kernel-diag';
import { diagnostics, formatDiagnostics, clearWatchdog, WATCHDOG_OFF_KEY, watchdogDisabled, watchdogInstalled } from '../watchdog';

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
 *   watchdog off | on      Turn it off from the next load on (safe mode too), or back on
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
        ctx.stdout = 'usage: watchdog [--prev] [-n N] [-k KINDS] [--since SECONDS] [--json] [--clear] | watchdog --kernel [RE] | watchdog off|on\n';
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
