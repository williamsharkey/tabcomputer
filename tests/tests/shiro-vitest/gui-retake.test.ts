/**
 * Taking a GUI app's snapshot again in the background (src/gui/retake.ts,
 * docs/research/GUI_SNAPSHOTS.md "Retakes"): when a hidden start may run, and
 * what ends it. The start itself, with real apps, is
 * tests/browser/gui-snapshot-rules.mjs.
 */
import { describe, it, expect } from 'vitest';
import { RetakeQueue, retakeDecision, retakeFits, QUIET_MS, SMALL_IMAGE, TRIES_PER_APP, type RetakeDeps, type RetakeResult, type RetakeState } from '@shiro/gui/retake';

const idle: RetakeState = { on: true, safe: false, guest: false, hidden: false, launching: false, sinceInput: QUIET_MS, sinceAsked: QUIET_MS, triedApp: 0 };

describe('GUI snapshot retakes: when a hidden start may run', () => {
  it('starts when the page is shown, nothing is being started, and nobody pressed a key for a while', () => {
    expect(retakeDecision(idle)).toBe('start');
  });

  it('never in safe mode, in a guest, or with the setting off', () => {
    expect(retakeDecision({ ...idle, safe: true })).toBe('no');
    expect(retakeDecision({ ...idle, guest: true })).toBe('no');
    expect(retakeDecision({ ...idle, on: false })).toBe('no');
  });

  it('waits while the page is hidden, an app is being started, or someone is at the keyboard', () => {
    expect(retakeDecision({ ...idle, hidden: true })).toBe('wait');
    expect(retakeDecision({ ...idle, launching: true })).toBe('wait');
    expect(retakeDecision({ ...idle, sinceInput: QUIET_MS - 1 })).toBe('wait');
    // ... and for a while after the app quit: someone who quit by mistake opens it again at once
    expect(retakeDecision({ ...idle, sinceAsked: QUIET_MS - 1 })).toBe('wait');
  });

  it('on a machine with less than 8 GB only a small app is started hidden, and none whose size is unknown', () => {
    const geany = 57_300_000, gimp = 180_000_000;
    expect(retakeFits(8, gimp)).toBe(true);
    expect(retakeFits(8, undefined)).toBe(true);
    expect(retakeFits(4, geany)).toBe(true);
    expect(retakeFits(4, gimp)).toBe(false);
    expect(retakeFits(4, undefined)).toBe(false);
    expect(retakeFits(undefined, geany)).toBe(true);
    expect(retakeFits(undefined, gimp)).toBe(false);
    expect(retakeFits(4, SMALL_IMAGE)).toBe(true);
    expect(retakeFits(4, 0)).toBe(false);
  });

  it('gives up on an app whose hidden start failed twice in a row', () => {
    expect(retakeDecision({ ...idle, triedApp: TRIES_PER_APP })).toBe('no');
    expect(retakeDecision({ ...idle, triedApp: TRIES_PER_APP - 1 })).toBe('start');
  });
});

/** A queue on a clock the test moves */
function harness(over: Partial<RetakeDeps> = {}) {
  let now = 1_000_000;
  let lastInput = 0;
  const state = { on: true, safe: false, guest: false, hidden: false, launching: false };
  const timers: { at: number; cb: () => void }[] = [];
  const log: Record<string, unknown>[] = [];
  const takes: { app: string; signal: AbortSignal; gone: () => void; finish: (r: RetakeResult) => void }[] = [];
  const needs = new Map<string, string | null>();
  const d: RetakeDeps = {
    now: () => now,
    state: () => state,
    lastInput: () => lastInput,
    needs: async (app) => (needs.has(app) ? needs.get(app)! : 'its settings changed'),
    take: (app, signal, gone) => new Promise<RetakeResult>((finish) => {
      const t = { app, signal, gone, finish };
      takes.push(t);
      // (like the real one: killed at once when aborted, and it says so)
      signal.addEventListener('abort', () => { gone(); finish({ ok: false, cancelled: true, why: String(signal.reason) }); });
    }),
    log: (app, what) => { log.push({ app, ...what }); },
    timer: (cb, ms) => { timers.push({ at: now + ms, cb }); },
    idle: (cb) => { cb(); },
    ...over,
  };
  const q = new RetakeQueue(d);
  /** Let `ms` pass, running the timers that come due (and the promises between them) */
  const pass = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await new Promise((r) => setTimeout(r, 0));
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift()!;
      now = t.at;
      t.cb();
    }
    now = end;
    await new Promise((r) => setTimeout(r, 0));
  };
  return { q, state, takes, log, needs, pass, input: () => { lastInput = now; }, now: () => now };
}

describe('GUI snapshot retakes: the queue', () => {
  it('an app that quit is started hidden once the tab has been quiet, one app at a time', async () => {
    const h = harness();
    h.input();
    h.q.request('gimp');
    h.q.request('geany');
    await h.pass(QUIET_MS - 2000);
    expect(h.takes.length).toBe(0);            // too soon after the quit
    await h.pass(4000);
    expect(h.takes.map((t) => t.app)).toEqual(['gimp']);
    expect(h.q.current).toBe('gimp');
    await h.pass(5000);
    expect(h.takes.length).toBe(1);            // geany waits for gimp
    h.takes[0].finish({ ok: true, ms: 15000, bytes: { image: 180e6, stored: 85e6, x: 39e6 } });
    await h.pass(3000);
    expect(h.takes.map((t) => t.app)).toEqual(['gimp', 'geany']);
    h.takes[1].finish({ ok: true, ms: 6000 });
    await h.pass(3000);
    expect(h.q.current).toBeNull();
    expect(h.q.waiting).toEqual([]);
    expect(h.log.filter((l) => l.retaken === true).map((l) => l.app)).toEqual(['gimp', 'geany']);
  });

  it('waits for the person: a key pressed puts it off, a hidden page too', async () => {
    const h = harness();
    h.q.request('gimp');
    for (let i = 0; i < 6; i++) { await h.pass(QUIET_MS - 3000); h.input(); }
    expect(h.takes.length).toBe(0);
    h.state.hidden = true;
    await h.pass(QUIET_MS * 3);
    expect(h.takes.length).toBe(0);
    h.state.hidden = false;
    await h.pass(3000);
    expect(h.takes.length).toBe(1);
  });

  it('an app the person starts ends the hidden one at once, which is asked for again and does not count as a failure', async () => {
    const h = harness();
    h.q.request('gimp');
    await h.pass(QUIET_MS + 2000);
    expect(h.takes.length).toBe(1);
    let gone = false;
    h.takes[0].signal.addEventListener('abort', () => { gone = true; });
    h.state.launching = true;
    await h.q.userLaunch('geany');
    expect(gone).toBe(true);                   // before the person's app starts
    expect(h.takes[0].signal.aborted).toBe(true);
    await h.pass(QUIET_MS * 2);
    expect(h.takes.length).toBe(1);            // not while geany is starting
    h.state.launching = false;
    await h.pass(QUIET_MS + 3000);
    expect(h.takes.map((t) => t.app)).toEqual(['gimp', 'gimp']);
    // however often that happens, it is not given up on
    for (let i = 0; i < TRIES_PER_APP + 2; i++) {
      await h.q.userLaunch('xeyes');
      await h.pass(QUIET_MS + 3000);
    }
    expect(h.takes.length).toBe(TRIES_PER_APP + 4);
    expect(h.q.current).toBe('gimp');
  });

  it('the person starting the same app takes it off the list: that start keeps its own snapshot', async () => {
    const h = harness();
    h.q.request('gimp');
    await h.q.userLaunch('gimp');
    await h.pass(QUIET_MS * 3);
    expect(h.takes.length).toBe(0);
    expect(h.q.waiting).toEqual([]);
  });

  it('starts nothing for an app whose snapshot is good, or that can take none', async () => {
    const h = harness();
    h.needs.set('geany', null);
    h.q.request('geany');
    await h.pass(QUIET_MS * 2);
    expect(h.takes.length).toBe(0);
    expect(h.q.waiting).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it('a start that fails is tried again, TRIES_PER_APP times in all; one that never can is not', async () => {
    const h = harness();
    h.q.request('gimp');
    for (let i = 0; i < TRIES_PER_APP + 2; i++) {
      await h.pass(QUIET_MS + 3000);
      h.takes[h.takes.length - 1]?.finish({ ok: false, why: 'the app ended first' });
    }
    await h.pass(QUIET_MS * 2);
    expect(h.takes.length).toBe(TRIES_PER_APP);
    expect(h.q.waiting).toEqual([]);
    const g = harness();
    g.q.request('xterm');
    await g.pass(QUIET_MS + 3000);
    g.takes[0].finish({ ok: false, never: true, why: 'its shell is on a pty' });
    await g.pass(QUIET_MS * 3);
    expect(g.takes.length).toBe(1);
    expect(g.q.waiting).toEqual([]);
  });

  it('an app is retaken after every quit that needs it, however many: a snapshot kept is not a try used up', async () => {
    const h = harness();
    for (let i = 0; i < TRIES_PER_APP + 4; i++) {
      h.q.request('gimp');
      await h.pass(QUIET_MS + 3000);
      expect(h.takes.length).toBe(i + 1);
      h.takes[i].finish({ ok: true, ms: 15000 });
      await h.pass(2000);
    }
    // a failure in between is forgotten once a start works again
    h.q.request('gimp');
    await h.pass(QUIET_MS + 3000);
    h.takes[h.takes.length - 1].finish({ ok: false, why: 'the app ended first' });
    await h.pass(3000);
    h.takes[h.takes.length - 1].finish({ ok: true, ms: 15000 });
    await h.pass(2000);
    const n = h.takes.length;
    h.q.request('gimp');
    await h.pass(QUIET_MS + 3000);
    h.takes[n].finish({ ok: false, why: 'the app ended first' });
    await h.pass(3000);
    expect(h.takes.length).toBe(n + 2);       // tried again: the earlier failure does not count
  });

  it('nothing is started in safe mode', async () => {
    const h = harness();
    (h.state as { safe: boolean }).safe = true;
    h.q.request('gimp');
    await h.pass(QUIET_MS * 3);
    expect(h.takes.length).toBe(0);
    expect(h.q.waiting).toEqual([]);
  });
});
