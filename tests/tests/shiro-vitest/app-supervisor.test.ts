/**
 * An app's backend under supervision (src/apps/supervisor.ts, docs/APPS.md
 * "Lifecycle"): started, found ready by its port and health path, restarted
 * when it dies with a growing wait, given up on after repeated failures, and
 * stopped. The process and the clock are stand-ins.
 */
import { describe, it, expect } from 'vitest';
import { Supervisor, pickPort, BACKOFF_MS, MAX_FAILURES, STABLE_MS, type BackendState, type SupervisorDeps } from '@shiro/apps/supervisor';

interface Proc { line: string; env: Record<string, string>; cwd: string; exit(code: number): void; killed: boolean; out(s: string): void }

function world(opts: { health?: (path: string) => number } = {}) {
  let now = 0;
  let seq = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const ports = new Set<number>();
  const portListeners = new Set<(port: number, up: boolean) => void>();
  const procs: Proc[] = [];
  const closed: number[] = [];
  const deps: SupervisorDeps = {
    spawn(line, cwd, env, onOutput) {
      let exit!: (code: number) => void;
      const done = new Promise<number>((r) => { exit = r; });
      const p: Proc = { line, env, cwd, exit, killed: false, out: onOutput };
      procs.push(p);
      return { done, kill: () => { p.killed = true; } };
    },
    portUp: (p) => ports.has(p),
    onPort: (cb) => { portListeners.add(cb); return () => { portListeners.delete(cb); }; },
    probe: async (_port, path) => (opts.health ? opts.health(path) : 200),
    closePort: (p) => { closed.push(p); ports.delete(p); },
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimeout: (t) => { const i = timers.findIndex((x) => x.id === t); if (i >= 0) timers.splice(i, 1); },
  };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    deps, procs, ports, closed,
    listen: async (port: number) => { ports.add(port); for (const cb of [...portListeners]) cb(port, true); await flush(); },
    unlisten: async (port: number) => { ports.delete(port); for (const cb of [...portListeners]) cb(port, false); await flush(); },
    /** Let `ms` pass, running the timers that come due, in order */
    advance: async (ms: number) => {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
    flush,
  };
}

const spec = (extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) => ({ id: 'demo', start: 'node server.js', cwd: '/home/user/Apps/demo', port: 4900, env: { APP_ID: 'demo' }, health: null, ...extra });
const track = (s: Supervisor) => { const seen: BackendState[] = []; s.on((st) => seen.push(st)); return seen; };

describe('app backend supervisor', () => {
  it('starts the command with PORT set, and is running once the port is open', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    const seen = track(s);
    const started = s.start();
    expect(s.state).toBe('starting');
    expect(w.procs[0]).toMatchObject({ line: 'node server.js', cwd: '/home/user/Apps/demo', env: { APP_ID: 'demo', PORT: '4900' } });
    await w.listen(4900);
    expect(await started).toBe(true);
    expect(s.state).toBe('running');
    expect(seen).toEqual(['starting', 'running']);
    // asking again starts nothing
    expect(await s.start()).toBe(true);
    expect(w.procs).toHaveLength(1);
  });

  it('waits for the health path to answer 2xx', async () => {
    let status = 503;
    const w = world({ health: () => status });
    const s = new Supervisor(spec({ health: { path: '/api/ping', timeout: 5 } }), w.deps);
    const started = s.start();
    await w.listen(4900);
    await w.advance(300);
    expect(s.state).toBe('starting');
    status = 204;
    await w.advance(200);
    expect(await started).toBe(true);
    expect(s.state).toBe('running');
  });

  it('a health path that never answers is a failed start', async () => {
    const w = world({ health: () => 500 });
    const s = new Supervisor(spec({ health: { path: '/ok', timeout: 2 } }), w.deps);
    void s.start();
    await w.listen(4900);
    await w.advance(2100);
    expect(s.state).toBe('backoff');
    expect(s.error).toMatch(/\/ok did not answer within 2 s/);
    expect(w.procs[0].killed).toBe(true);
    expect(w.closed).toContain(4900);
  });

  it('restarts a backend that dies, waiting longer each time, and gives up after repeated failures', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    const seen = track(s);
    const started = s.start();
    for (let n = 1; n <= MAX_FAILURES; n++) {
      expect(s.state).toBe('starting');
      expect(w.procs).toHaveLength(n);
      w.procs[n - 1].out(`boom ${n}\n`);
      w.procs[n - 1].exit(1);
      await w.flush();
      if (n < MAX_FAILURES) {
        expect(s.state).toBe('backoff');
        expect(s.failures).toBe(n);
        // not before its wait is over
        await w.advance(BACKOFF_MS[n - 1] - 1);
        expect(w.procs).toHaveLength(n);
        await w.advance(1);
      }
    }
    expect(s.state).toBe('failed');
    expect(await started).toBe(false);
    expect(s.error).toMatch(/exited with status 1 before listening on port 4900; it failed 5 times in a row and was not started again/);
    expect(s.tail().join('\n')).toMatch(/boom 5/);
    expect(seen.filter((x) => x === 'backoff')).toHaveLength(MAX_FAILURES - 1);
    // nothing more happens by itself
    await w.advance(60_000);
    expect(w.procs).toHaveLength(MAX_FAILURES);
    // Retry starts over
    const again = s.retry();
    expect(s.state).toBe('starting');
    expect(s.failures).toBe(0);
    await w.listen(4900);
    expect(await again).toBe(true);
  });

  it('a backend that ran for a while is started again at once, and its failures are forgotten', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    w.procs[0].exit(1);
    await w.flush();
    expect(s.failures).toBe(1);
    await w.advance(BACKOFF_MS[0]);
    await w.listen(4900);
    expect(s.state).toBe('running');
    await w.advance(STABLE_MS + 1);
    // it dies after running well
    w.ports.delete(4900);
    w.procs[1].exit(137);
    await w.flush();
    expect(s.failures).toBe(0);
    expect(s.state).toBe('starting');
    expect(w.procs).toHaveLength(3);
    expect(s.error).toMatch(/it exited \(status 137\)/);
  });

  it('dying soon after it came up counts as a failure', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    await w.listen(4900);
    await w.advance(500);
    await w.unlisten(4900);
    expect(s.state).toBe('backoff');
    expect(s.failures).toBe(1);
    expect(s.error).toMatch(/stopped listening on port 4900/);
  });

  it('a server that hands over its port and returns stays running while the port is open', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    await w.listen(4900);
    w.procs[0].exit(0);
    await w.flush();
    expect(s.state).toBe('running');
    await w.unlisten(4900);
    expect(s.state).toBe('backoff');
  });

  it('nothing listening in time is a failed start', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    await w.advance(20_100);
    expect(s.state).toBe('backoff');
    expect(s.error).toMatch(/nothing listened on port 4900 within 20 s/);
  });

  it('stop kills the process, frees the port and ends the waiting', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    const started = s.start();
    await w.listen(4900);
    await started;
    s.stop();
    expect(s.state).toBe('stopped');
    expect(w.procs[0].killed).toBe(true);
    expect(w.closed).toContain(4900);
    // its late exit changes nothing
    w.procs[0].exit(143);
    await w.advance(60_000);
    expect(s.state).toBe('stopped');
    expect(w.procs).toHaveLength(1);
  });

  it('stop during a backoff cancels the restart; a pending start resolves false', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    const started = s.start();
    w.procs[0].exit(1);
    await w.flush();
    expect(s.state).toBe('backoff');
    s.stop();
    expect(await started).toBe(false);
    await w.advance(60_000);
    expect(w.procs).toHaveLength(1);
  });

  it('restart stops and starts (app dev on save)', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    await w.listen(4900);
    const again = s.restart();
    expect(w.procs[0].killed).toBe(true);
    expect(w.procs).toHaveLength(2);
    await w.listen(4900);
    expect(await again).toBe(true);
    expect(s.starts).toBe(2);
  });

  it('a start that throws is a failure like any other', async () => {
    const w = world();
    w.deps.spawn = () => { throw new Error('no shell'); };
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    expect(s.state).toBe('backoff');
    expect(s.error).toMatch(/could not be started: no shell/);
  });

  it('keeps a bounded log without escape sequences', async () => {
    const w = world();
    const s = new Supervisor(spec(), w.deps);
    void s.start();
    w.procs[0].out('\x1b[32mlistening\x1b[0m on 4900\r\npartial');
    expect(s.tail()).toEqual(['$ node server.js', 'listening on 4900', 'partial']);
    for (let i = 0; i < 1000; i++) w.procs[0].out(`line ${i}\n`);
    expect(s.lines.length).toBeLessThanOrEqual(400);
  });

  it('pickPort: stable for an id, skipping ports in use', () => {
    const a = pickPort('converter', () => false);
    expect(pickPort('converter', () => false)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(4800);
    expect(pickPort('converter', (p) => p === a)).not.toBe(a);
    expect(pickPort('converter', () => false, new Set([a]))).not.toBe(a);
    expect(() => pickPort('x', () => true)).toThrow(/no free port/);
  });
});
