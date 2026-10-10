/**
 * The watchdog worker's logic (src/watchdog-host.ts): it saves a wedge record
 * when the page stops sending heartbeats, and, hosting a remote session's
 * relay, answers `diag` for a page that doesn't.
 */
import { describe, it, expect } from 'vitest';
import { WatchdogHost, WEDGE_MS, REPLY_GRACE_MS } from '@shiro/watchdog-host';

function setup() {
  let t = 1_000_000;
  const posts: any[] = [];
  const saved: any[] = [];
  const sent: any[] = [];
  const relay: any = { readyState: 'open', onopen: null, onclose: null, onmessage: null, send: (x: string) => sent.push(JSON.parse(x)), close() { this.readyState = 'closed'; } };
  const host = new WatchdogHost({ post: (m) => posts.push(m), saveWedge: (r) => saved.push(r), now: () => t, makeRelay: () => relay });
  return { host, posts, saved, sent, relay, advance: (ms: number) => { t += ms; }, now: () => t };
}
const fromPeer = (relay: any, msg: object) => relay.onmessage({ data: JSON.stringify(msg) });

describe('watchdog worker', () => {
  it('saves a wedge record after missed heartbeats, and clears it when the page answers', () => {
    const { host, posts, saved, advance } = setup();
    host.onMain({ snap: { active: [{ line: 'claude', ms: 5 }] }, hidden: false });
    advance(WEDGE_MS - 1); host.tick();
    expect(saved).toEqual([]);
    advance(2); host.tick();
    expect(saved[0]).toMatchObject({ snapshot: { active: [{ line: 'claude' }] } });
    expect(saved[0].seenAt - saved[0].since).toBe(WEDGE_MS + 1);
    host.onMain({ hidden: false });
    expect(saved.at(-1)).toBeNull();
    expect(posts.at(-1)).toMatchObject({ stall: WEDGE_MS + 1 });
  });

  it('a hidden page (throttled timers) is not wedged', () => {
    const { host, saved, advance } = setup();
    host.onMain({ hidden: true });
    advance(60_000); host.tick();
    expect(saved).toEqual([]);
  });

  it('passes requests to the page and its replies back', () => {
    const { host, posts, sent, relay } = setup();
    host.onMain({ relayStart: { base: 'https://x', info: { v: 1, id: 'a'.repeat(32), salt: 'AAAA' }, code: 'c' } });
    relay.onopen();
    expect(posts.at(-1)).toEqual({ relayOpen: true });
    fromPeer(relay, { type: 'exec', command: 'ls', requestId: 'req-1' });
    expect(posts.at(-1)).toEqual({ relayMessage: '{"type":"exec","command":"ls","requestId":"req-1"}' });
    host.onMain({ relaySend: JSON.stringify({ type: 'exec_result', stdout: 'x', requestId: 'req-1' }) });
    expect(sent).toEqual([{ type: 'exec_result', stdout: 'x', requestId: 'req-1' }]);
    expect(host.pending.size).toBe(0);
  });

  it('answers diag and ping itself when the page does not, and drops the late reply', () => {
    const { host, sent, relay, advance } = setup();
    host.onMain({ snap: { active: [{ line: "js-eval 'for (;;) {}'", ms: 0 }] } });
    host.onMain({ relayStart: { base: 'https://x', info: { v: 1, id: 'a'.repeat(32), salt: 'AAAA' }, code: 'c' } });
    fromPeer(relay, { type: 'diag', requestId: 'req-2' });
    fromPeer(relay, { type: 'ping', requestId: 'req-3' });
    fromPeer(relay, { type: 'exec', command: 'sleep 9', requestId: 'req-4' });
    advance(REPLY_GRACE_MS - 1); host.tick();
    expect(sent).toEqual([]);
    advance(2); host.tick();
    expect(sent.map((m) => m.requestId)).toEqual(['req-2', 'req-3']);
    expect(sent[0]).toMatchObject({ type: 'diag_result', frozen: true, frozenMs: REPLY_GRACE_MS + 1, snapshot: { active: [{ line: "js-eval 'for (;;) {}'" }] } });
    expect(sent[1]).toMatchObject({ type: 'pong', frozen: true });
    // exec waits for the page; the page's late diag reply is dropped
    host.onMain({ relaySend: JSON.stringify({ type: 'diag_result', requestId: 'req-2' }) });
    host.onMain({ relaySend: JSON.stringify({ type: 'exec_result', stdout: '', requestId: 'req-4' }) });
    expect(sent.map((m) => m.requestId)).toEqual(['req-2', 'req-3', 'req-4']);
  });

  it('tells the page when the relay closes', () => {
    const { host, posts, relay } = setup();
    host.onMain({ relayStart: { base: 'https://x', info: { v: 1, id: 'a'.repeat(32), salt: 'AAAA' }, code: 'c' } });
    relay.onclose();
    expect(posts.at(-1)).toEqual({ relayClose: true });
    expect(host.relay).toBeNull();
  });
});
