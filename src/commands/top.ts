/**
 * top: procps-ng's layout. The summary (uptime and load from /proc, tasks by
 * state, %Cpu(s) from /proc/stat, MiB Mem/Swap from /proc/meminfo), then
 * PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND. -b (batch) prints
 * plain text, frames a blank line apart, cut to 80 columns (-w N, $COLUMNS);
 * -n, -d, -p, -u, -c (command lines). On a terminal: a full-screen view,
 * q quits, k kills, space refreshes. With neither, it fails as procps does.
 */
import type { Command, CommandContext } from './index';
import { processTable } from '../process-table';
import { processInfos, type Info } from './ps';

const read = async (ctx: CommandContext, path: string) => {
  try { return await ctx.fs.readFile(path, 'utf8') as string; } catch { return null; }
};

/** procps's "up" text: N min, H:MM, or D day(s), H:MM */
function upText(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  const days = d ? `${d} day${d === 1 ? '' : 's'}, ` : '';
  return days + (h ? `${String(h).padStart(2)}:${String(m).padStart(2, '0')}` : `${m} min`);
}

/** TIME+: minutes:seconds.hundredths */
function timePlus(ms: number): string {
  const cs = Math.floor(ms / 10);
  return `${Math.floor(cs / 6000)}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

const f1 = (n: number, w: number) => n.toFixed(1).padStart(w);

interface Options { pids: Set<number>; users: Set<string>; fullCommand: boolean }

/** One frame's lines; cpu is the /proc/stat counters seen last (for the %Cpu(s) deltas) */
async function frame(ctx: CommandContext, opts: Options, cpu: { last: number[] | null }): Promise<string[]> {
  const lines: string[] = [];
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const uptime = Number((await read(ctx, '/proc/uptime'))?.split(/\s+/)[0] ?? (performance.now() / 1000));
  const load = ((await read(ctx, '/proc/loadavg')) ?? '0.00 0.00 0.00').split(/\s+/).slice(0, 3);
  lines.push(`top - ${clock} up ${upText(uptime)},  1 user,  load average: ${load.join(', ')}`);

  let infos = await processInfos(ctx);
  const count = (re: RegExp) => infos.filter((p) => re.test(p.state)).length;
  lines.push(`Tasks: ${String(infos.length).padStart(3)} total, ${String(count(/^R/)).padStart(3)} running, ${String(count(/^[SDI]/)).padStart(3)} sleeping, ${String(count(/^[Tt]/)).padStart(3)} stopped, ${String(count(/^Z/)).padStart(3)} zombie`);

  // %Cpu(s): the share of each /proc/stat counter since the last frame (since boot, first)
  const stat = /^cpu\s+(.*)$/m.exec((await read(ctx, '/proc/stat')) ?? '');
  const ticks = stat ? stat[1].trim().split(/\s+/).map(Number).slice(0, 8) : [];
  const delta = ticks.map((t, k) => t - (cpu.last?.[k] ?? 0));
  cpu.last = ticks;
  const total = delta.reduce((a, b) => a + b, 0);
  const share = (k: number) => (total > 0 ? (100 * (delta[k] ?? 0)) / total : k === 3 ? 100 : 0);
  // us sy ni id wa hi si st, from user nice system idle iowait irq softirq steal
  const order: [string, number][] = [['us', 0], ['sy', 2], ['ni', 1], ['id', 3], ['wa', 4], ['hi', 5], ['si', 6], ['st', 7]];
  lines.push('%Cpu(s):' + order.map(([name, k]) => `${f1(share(k), 5)} ${name}`).join(',') + ' ');

  const mem: Record<string, number> = {};
  for (const l of ((await read(ctx, '/proc/meminfo')) ?? '').split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(l);
    if (m) mem[m[1]] = Number(m[2]) / 1024;
  }
  const memTotal = mem.MemTotal ?? 0, memFree = mem.MemFree ?? 0;
  const cache = (mem.Buffers ?? 0) + (mem.Cached ?? 0) + (mem.SReclaimable ?? 0);
  const used = Math.max(0, memTotal - memFree - cache);
  lines.push(`MiB Mem : ${f1(memTotal, 8)} total, ${f1(memFree, 8)} free, ${f1(used, 8)} used, ${f1(cache, 8)} buff/cache     `);
  const swapTotal = mem.SwapTotal ?? 0, swapFree = mem.SwapFree ?? 0;
  lines.push(`MiB Swap: ${f1(swapTotal, 8)} total, ${f1(swapFree, 8)} free, ${f1(swapTotal - swapFree, 8)} used. ${f1(mem.MemAvailable ?? memFree, 8)} avail Mem `);
  lines.push('');

  const pidMax = Number((await read(ctx, '/proc/sys/kernel/pid_max'))?.trim()) || 4194304;
  const pw = Math.max(5, String(pidMax).length);
  lines.push(`${'PID'.padStart(pw)} USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND`);
  if (opts.pids.size) infos = infos.filter((p) => opts.pids.has(p.pid));
  if (opts.users.size) infos = infos.filter((p) => opts.users.has(p.user) || opts.users.has(String(p.uid)));
  // busiest first; here every process shows 0.0, so by most CPU time, then pid
  infos.sort((a, b) => b.cpuMs - a.cpuMs || a.pid - b.pid);
  const user = (u: string) => (u.length > 8 ? u.slice(0, 7) + '+' : u.padEnd(8));
  for (const p of infos as Info[]) {
    lines.push(`${String(p.pid).padStart(pw)} ${user(p.user)}  20   0       0      0      0 ${p.state[0]}   0.0   0.0 ${timePlus(p.cpuMs).padStart(9)} ${opts.fullCommand ? p.args : p.comm}`);
  }
  return lines;
}

/** A line cut to the width, as top marks it: the last column a + */
const fit = (l: string, cols: number) => (l.length > cols ? l.slice(0, cols - 1) + '+' : l);

export const topCmd: Command = {
  name: 'top',
  description: 'Real-time process monitor',
  async exec(ctx) {
    let batch = false;
    let delay = 3000;
    let maxIter = 0;
    let width = 0;
    const opts: Options = { pids: new Set(), users: new Set(), fullCommand: false };
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-h' || a === '--help') { ctx.stdout = '\nUsage:\n  top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]\n'; return 0; }
      if (a === '-v' || a === '--version') { ctx.stdout = 'top from procps-ng 4.0.4 (tabcomputer built-in)\n'; return 0; }
      if (!a.startsWith('-')) { ctx.stderr = `top: unknown option '${a}'\n\nUsage:\n  top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]\n`; return 1; }
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        const value = () => { const v = a.slice(k + 1) || args[++i] || ''; k = a.length; return v; };
        if (ch === 'b') batch = true;
        else if (ch === 'c') opts.fullCommand = !opts.fullCommand;
        else if (ch === 'n') maxIter = parseInt(value(), 10) || 0;
        else if (ch === 'd') delay = Math.max(0, parseFloat(value()) || 0) * 1000;
        else if (ch === 'p') for (const p of value().split(',')) opts.pids.add(Number(p));
        else if (ch === 'u' || ch === 'U') opts.users.add(value());
        else if (ch === 'w') { const v = a.slice(k + 1) || (/^\d+$/.test(args[i + 1] ?? '') ? args[++i] : ''); k = a.length; width = parseInt(v, 10) || 512; }
        else if (ch === 'o' || ch === 'O') value();
        // -E, -e, -H, -i, -S, -s, -1: accepted
      }
    }
    const cpu = { last: null as number[] | null };
    const tty = !!ctx.terminal && ctx.stdoutIsTTY !== false;

    if (batch) {
      const cols = width || parseInt(ctx.env?.COLUMNS ?? '', 10) || 80;
      const signal = ctx.shell?.abortController?.signal;
      const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
      for (let iter = 0; maxIter === 0 || iter < maxIter; iter++) {
        if (iter) {
          await new Promise((r) => setTimeout(r, delay));
          if (signal?.aborted) return 130;
          out('\n');
        }
        out((await frame(ctx, opts, cpu)).map((l) => fit(l, cols) + '\n').join(''));
      }
      return 0;
    }

    if (!tty) { ctx.stderr = 'top: failed tty get\n'; return 1; }

    // Interactive: a full-screen view
    const terminal = ctx.terminal!;
    let { rows, cols } = terminal.getSize();

    return new Promise<number>((resolve) => {
      let running = true;
      let interval: ReturnType<typeof setInterval> | null = null;
      let iterations = 0;
      let killMode = false;
      let killInput = '';

      const render = async () => {
        if (!running) return;
        const lines = (await frame(ctx, opts, cpu)).slice(0, rows - 1);
        if (!running) return;
        const write = (s: string) => terminal.writeOutput(s);
        write('\x1b[?25l\x1b[H');
        lines.forEach((l, k) => {
          const text = fit(l, cols);
          // the column header in reverse video, as top shows it
          write('\x1b[2K' + (k === 6 ? `\x1b[7m${text.padEnd(cols)}\x1b[27m` : text) + '\r\n');
        });
        for (let k = lines.length; k < rows - 1; k++) write('\x1b[2K\r\n');
        write('\x1b[2K' + (killMode ? `PID to signal/kill [default pid = none] ${killInput}` : ''));
        iterations++;
        if (maxIter > 0 && iterations >= maxIter) { cleanup(); resolve(0); }
      };

      const cleanup = () => {
        running = false;
        if (interval) clearInterval(interval);
        unsubResize?.();
        terminal.exitRawMode();
        terminal.writeOutput('\x1b[?25h\x1b[?1049l');
      };

      const onKey = (key: string) => {
        if (!running) return;
        if (killMode) {
          if (key === '\r' || key === 'Enter') {
            killMode = false;
            const pid = parseInt(killInput, 10);
            if (!isNaN(pid)) processTable.kill(pid);
            killInput = '';
            void render();
          } else if (key === '\x1b' || key === 'Escape') {
            killMode = false;
            killInput = '';
            void render();
          } else if (key === '\x7f' || key === 'Backspace') {
            killInput = killInput.slice(0, -1);
            terminal.writeOutput(`\r\x1b[2KPID to signal/kill [default pid = none] ${killInput}`);
          } else if (key >= '0' && key <= '9') {
            killInput += key;
            terminal.writeOutput(`\r\x1b[2KPID to signal/kill [default pid = none] ${killInput}`);
          }
          return;
        }
        switch (key) {
          case 'q': case 'Q': case 'Ctrl+C': case '\x03':
            cleanup();
            resolve(key === 'q' || key === 'Q' ? 0 : 130);
            return;
          case 'k':
            killMode = true;
            killInput = '';
            terminal.writeOutput('\r\x1b[2KPID to signal/kill [default pid = none] ');
            return;
          case 'c':
            opts.fullCommand = !opts.fullCommand;
            void render();
            return;
          case ' ':
            void render();
            return;
        }
      };

      const unsubResize = terminal.onResize((newCols, newRows) => {
        cols = newCols;
        rows = newRows;
        void render();
      });

      const signal = ctx.shell?.abortController?.signal;
      signal?.addEventListener('abort', () => { cleanup(); resolve(130); }, { once: true });

      terminal.writeOutput('\x1b[?1049h'); // alternate screen
      terminal.enterRawMode(onKey);
      void render();
      interval = setInterval(() => void render(), delay || 3000);
    });
  },
};
