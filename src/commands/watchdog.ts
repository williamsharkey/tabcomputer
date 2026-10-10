import { Command, CommandContext } from './index';
import { diagnostics, formatDiagnostics, clearWatchdog } from '../watchdog';

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
 */
export const watchdogCmd: Command = {
  name: 'watchdog',
  description: 'Show page freezes: event-loop lag, long tasks, commands in flight',

  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
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
      else if (a === '-h' || a === '--help') {
        ctx.stdout = 'usage: watchdog [--prev] [-n N] [-k KINDS] [--since SECONDS] [--json] [--clear]\n';
        return 0;
      } else {
        ctx.stderr = `watchdog: unknown option ${a}\n`;
        return 2;
      }
    }
    const d = diagnostics({ limit, kind, since, previous });
    ctx.stdout = (json ? JSON.stringify(d) : formatDiagnostics(d)) + '\n';
    return 0;
  },
};
