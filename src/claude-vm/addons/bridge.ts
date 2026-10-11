/**
 * How claude --vm's addon stand-ins (this directory) reach what only the page
 * has: navigator.clipboard, getUserMedia, AudioContext. node runs in a Worker
 * by default (src/node-worker/), so a call goes to the page as a message and
 * its result and events come back as messages (host.ts, guest.ts); node in
 * the page calls the page's operations directly.
 */

export interface PageBridge {
  /** Run `op` (page-ops.ts) in the page; `onEvent` hears what it streams back, such as microphone audio */
  call(op: string, args: unknown[], onEvent?: (ev: unknown) => void): Promise<unknown>;
}

/** guest → page: { id, op, args } */
export const PAGE_CALL = 'node-guest-page-call';
/** page → guest: { id, ok, value } or { id, ok: false, error: { name, message } } */
export const PAGE_REPLY = 'node-guest-page-reply';
/** page → guest: { id, value, last }; `last` ends the call's events */
export const PAGE_EVENT = 'node-guest-page-ev';

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onEvent?: (ev: unknown) => void;
  /** The reply came; the last event came (either may be first) */
  replied?: boolean;
  ended?: boolean;
}

/** An error as it crosses the bridge: its name (NotAllowedError …) and message */
export function errorFrom(e: { name?: string; message?: string } | undefined): Error {
  const err = new Error(e?.message ?? 'page call failed');
  err.name = e?.name ?? 'Error';
  return err;
}

/**
 * The guest's side: each call a message to the page. `receive` takes the
 * page's replies and events, and says whether a message was one of them.
 * A call with `onEvent` keeps hearing events after its reply, until one is `last`.
 */
export function guestBridge(post: (m: unknown) => void): PageBridge & { receive(m: unknown): boolean } {
  let lastId = 0;
  const pending = new Map<number, Pending>();
  return {
    call(op, args, onEvent) {
      const id = ++lastId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onEvent });
        post({ type: PAGE_CALL, id, op, args });
      });
    },
    receive(m) {
      const msg = m as { type?: string; id: number; ok?: boolean; value?: unknown; error?: { name?: string; message?: string }; last?: boolean } | null;
      if (msg?.type === PAGE_EVENT) {
        const p = pending.get(msg.id);
        if (!p) return true;
        if (msg.last) { p.ended = true; if (p.replied) pending.delete(msg.id); }
        p.onEvent?.(msg.value);
        return true;
      }
      if (msg?.type !== PAGE_REPLY) return false;
      const p = pending.get(msg.id);
      if (!p) return true;
      p.replied = true;
      if (!msg.ok || !p.onEvent || p.ended) pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value); else p.reject(errorFrom(msg.error));
      return true;
    },
  };
}

/** node in the page: the operations themselves */
export function directBridge(): PageBridge {
  return {
    async call(op, args, onEvent) {
      const { runPageOp } = await import('./page-ops');
      return runPageOp(op, args, (value) => onEvent?.(value));
    },
  };
}

/**
 * The page's side of one guest process's calls (host.ts): `serve` runs a call
 * and sends its events and then its result back; `close` (the process ended)
 * stops the recordings it left running.
 */
export function pageCallServer(send: (m: unknown) => void): { serve(m: { id: number; op: string; args: unknown[] }): Promise<void>; close(): void } {
  const sessions = new Set<string>();
  let ops: Promise<typeof import('./page-ops')> | null = null;
  const load = () => (ops ??= import('./page-ops'));
  return {
    async serve(m) {
      const args = Array.isArray(m.args) ? m.args : [];
      if (m.op === 'mic.start') sessions.add(String(args[0]));
      try {
        const { runPageOp } = await load();
        const value = await runPageOp(m.op, args, (ev, last) => send({ type: PAGE_EVENT, id: m.id, value: ev, last: !!last }));
        send({ type: PAGE_REPLY, id: m.id, ok: true, value });
      } catch (e: any) {
        send({ type: PAGE_REPLY, id: m.id, ok: false, error: { name: String(e?.name ?? 'Error'), message: String(e?.message ?? e) } });
      }
    },
    close() {
      if (!sessions.size) return;
      void load().then(({ runPageOp }) => { for (const s of sessions) void runPageOp('mic.stop', [s], () => {}).catch(() => {}); });
    },
  };
}
