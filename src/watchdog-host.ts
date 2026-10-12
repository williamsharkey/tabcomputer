/**
 * The watchdog worker's logic (src/watchdog-worker.ts runs it; tests drive it
 * directly). Off the page's main thread, so it keeps working while the page is
 * frozen:
 *
 * - Wedge record: the page sends a heartbeat (with a snapshot of what it's
 *   running) every second; after WEDGE_MS without one the snapshot is saved
 *   (IndexedDB, by the worker), so the next load can report the freeze.
 * - Relay host: a remote session over the HTTPS relay runs its long-poll here
 *   (src/remote-relay.ts). Requests go on to the page; a `diag` or `ping` the
 *   page hasn't answered within REPLY_GRACE_MS is answered from here with the
 *   last snapshot and how long the page has been unresponsive, so an outside
 *   agent can see a wedged page. The page's late reply to it is dropped.
 * - Kill switch: an `abort` request from the peer (or a freeze longer than
 *   the page's `watchdog abort-after` setting) raises the abort flag, a
 *   SharedArrayBuffer word the page checks at its yield points
 *   (watchdogCheckpoint: the shell's, the x86 runner's), plus a message for
 *   pages without SAB. The page then aborts its foreground commands like
 *   Ctrl-C. A page stuck in one JS loop with no yield point can't be
 *   stopped this way; the next load offers safe mode instead.
 */
import { RelayChannel, type RelayInfo } from './remote-relay';

export const WEDGE_MS = 3000;
export const REPLY_GRACE_MS = 3000;

/** What the page sends: any message is also a heartbeat */
export type ToWorker =
  | { snap?: unknown; hidden?: boolean }
  | { init: { abortFlag?: SharedArrayBuffer; autoAbortMs?: number } }
  | { relayStart: { base: string; info: RelayInfo; secret: string } }
  | { relaySend: string }
  | { relayStop: true };

/** What the worker sends the page */
export type FromWorker =
  | { stall: number; since: number }
  | { abort: string }
  | { relayOpen: true }
  | { relayMessage: string }
  | { relayClose: true };

export interface WedgeRecordOut { since: number; seenAt: number; snapshot: unknown }

interface RelayLike {
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(text: string): void;
  close(): void;
}

export interface HostDeps {
  post(msg: FromWorker): void;
  saveWedge(rec: WedgeRecordOut | null): void;
  now?: () => number;
  makeRelay?: (opts: { base: string; info: RelayInfo; secret: string }) => RelayLike;
}

export class WatchdogHost {
  lastBeat: number;
  snap: unknown = null;
  hidden = false;
  wedged = false;
  relay: RelayLike | null = null;
  /** Requests from the peer the page hasn't answered: requestId -> when, type */
  pending = new Map<string, { t: number; type: string }>();
  /** Answered here because the page didn't: its late replies are dropped */
  answered = new Set<string>();
  abortFlag: Int32Array | null = null;
  autoAbortMs = 0;
  /** The auto-abort already fired for the current freeze */
  private autoAborted = false;
  private now: () => number;

  constructor(private deps: HostDeps) {
    this.now = deps.now ?? Date.now;
    this.lastBeat = this.now();
  }

  /** A message from the page */
  onMain(m: ToWorker): void {
    const now = this.now();
    if (this.wedged) {
      this.wedged = false;
      this.deps.saveWedge(null);
      this.deps.post({ stall: now - this.lastBeat, since: this.lastBeat });
    }
    this.lastBeat = now;
    this.autoAborted = false;
    if ('init' in m) {
      if (m.init.abortFlag) this.abortFlag = new Int32Array(m.init.abortFlag);
      this.autoAbortMs = m.init.autoAbortMs ?? 0;
      return;
    }
    if ('relayStart' in m) return this.startRelay(m.relayStart);
    if ('relayStop' in m) { this.stopRelay(); return; }
    if ('relaySend' in m) return this.sendFromPage(m.relaySend);
    if (m.hidden !== undefined) this.hidden = m.hidden;
    if (m.snap !== undefined) this.snap = m.snap;
  }

  /** Every second or so */
  tick(): void {
    const now = this.now();
    if (!this.hidden && now - this.lastBeat >= WEDGE_MS) {
      this.wedged = true;
      this.deps.saveWedge({ since: this.lastBeat, seenAt: now, snapshot: this.snap });
      if (this.autoAbortMs > 0 && !this.autoAborted && now - this.lastBeat >= this.autoAbortMs) {
        this.autoAborted = true;
        this.requestAbort(`frozen ${Math.round((now - this.lastBeat) / 1000)} s (watchdog abort-after)`);
      }
    }
    for (const [id, p] of this.pending) {
      if (now - p.t < REPLY_GRACE_MS) continue;
      if (p.type !== 'diag' && p.type !== 'ping') continue; // the page answers those when it can
      this.pending.delete(id);
      this.answered.add(id);
      if (this.answered.size > 1000) this.answered.delete(this.answered.values().next().value!);
      this.replyFrozen(id, p.type, now);
    }
  }

  /** Raise the abort flag; the page aborts its foreground commands at its next yield point */
  requestAbort(reason: string): void {
    if (this.abortFlag) Atomics.store(this.abortFlag, 0, 1);
    this.deps.post({ abort: reason });
  }

  private replyFrozen(requestId: string, type: string, now: number): void {
    const frozen = { frozen: true, frozenMs: now - this.lastBeat, lastBeat: this.lastBeat, answeredBy: 'watchdog worker (the page did not answer)' };
    const reply = type === 'ping'
      ? { type: 'pong', ts: now, ...frozen, requestId }
      : { type: 'diag_result', ...frozen, snapshot: this.snap, requestId };
    try { if (this.relay?.readyState === 'open') this.relay.send(JSON.stringify(reply)); } catch { /* closing */ }
  }

  private startRelay(opts: { base: string; info: RelayInfo; secret: string }): void {
    this.stopRelay();
    const relay = this.deps.makeRelay ? this.deps.makeRelay(opts) : new RelayChannel({ ...opts, as: 'tab' });
    this.relay = relay;
    relay.onopen = () => { if (this.relay === relay) this.deps.post({ relayOpen: true }); };
    relay.onclose = () => {
      if (this.relay !== relay) return;
      this.relay = null;
      this.pending.clear();
      this.deps.post({ relayClose: true });
    };
    relay.onmessage = (ev) => {
      if (this.relay !== relay) return;
      try {
        const m = JSON.parse(ev.data);
        // The kill switch is handled here: the page may be the thing that's stuck
        if (m?.type === 'abort') {
          this.requestAbort('remote request');
          const now = this.now();
          relay.send(JSON.stringify({ type: 'abort_result', requested: true, shared: !!this.abortFlag, frozenMs: now - this.lastBeat, requestId: m.requestId }));
          return;
        }
        if (m && typeof m.requestId === 'string') this.pending.set(m.requestId, { t: this.now(), type: String(m.type) });
      } catch { /* the page reports bad JSON */ }
      this.deps.post({ relayMessage: ev.data });
    };
  }

  private stopRelay(): void {
    const r = this.relay;
    this.relay = null;
    this.pending.clear();
    if (r) { r.onclose = null; r.close(); }
  }

  private sendFromPage(text: string): void {
    // requestId is the last key the page writes (JSON.stringify({...result, requestId}))
    const at = text.lastIndexOf('"requestId":"');
    if (at >= 0) {
      const id = text.slice(at + 13, text.indexOf('"', at + 13));
      this.pending.delete(id);
      if (this.answered.delete(id)) return; // answered here already
    }
    try { if (this.relay?.readyState === 'open') this.relay.send(text); } catch { /* closing */ }
  }
}
