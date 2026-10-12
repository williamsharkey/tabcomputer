/**
 * The tab's side of `remote start` (src/commands/remote.ts) and remote
 * protocol 3 (issue #117, item 3): the signaling server is given the code's
 * id and a sealed offer, never the secret; a code saved by an older build is
 * dropped instead of being registered; an older server is an error, not a
 * downgrade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseRemoteCode, openSignal, sealSignal, REMOTE_PROTOCOL } from '@shiro/remote-relay';

const store = new Map<string, string>();
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const realFetch = globalThis.fetch;

/** The least of WebRTC the command touches */
class FakeChannel { readyState = 'connecting'; onopen: any = null; onclose: any = null; onmessage: any = null; send() {} close() { this.readyState = 'closed'; } }
class FakePeerConnection {
  iceGatheringState = 'complete'; connectionState = 'new'; localDescription: any = null; remote: any = null;
  onicecandidate: any = null; onicegatheringstatechange: any = null; onconnectionstatechange: any = null;
  createDataChannel() { return new FakeChannel(); }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB:CC' }; }
  async setLocalDescription(d: any) { this.localDescription = d; }
  async setRemoteDescription(d: any) { this.remote = d; }
  async addIceCandidate() {}
  close() {}
}

interface Sent { method: string; url: string; body: string }
let sent: Sent[] = [];
let answerSealed: string | null = null;
let serverKind: 'v3' | 'old' = 'v3';

beforeEach(() => {
  store.clear(); sent = []; answerSealed = null; serverKind = 'v3';
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } },
  });
  (globalThis as any).RTCPeerConnection = FakePeerConnection;
  (window as any).__tabcomputer = { ...(window as any).__tabcomputer, fs: {}, commands: { get: () => undefined, list: () => [] } };
  delete (window as any).__shiroRemoteSession;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    sent.push({ method: init.method || 'GET', url: String(url), body: String(init.body ?? '') });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (serverKind === 'old') return u.pathname === '/offer' ? reply(400, { error: 'Missing code or offer' }) : reply(200, { waiting: true });
    if (u.pathname === '/offer') return reply(200, { ok: true, v: REMOTE_PROTOCOL });
    if (u.pathname.startsWith('/answer/')) return answerSealed ? reply(200, { v: REMOTE_PROTOCOL, sealed: answerSealed }) : reply(200, { waiting: true });
    return reply(404, { error: 'Not found' });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as any).__shiroRemoteSession;
  delete (globalThis as any).RTCPeerConnection;
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage); else delete (globalThis as any).localStorage;
  vi.useRealTimers();
});

async function startRemote(args: string[] = ['start']) {
  const { remoteCmd } = await import('@shiro/commands/remote');
  const ctx: any = { args, stdout: '', stderr: '', env: {}, cwd: '/', stdin: '' };
  const status = await remoteCmd.exec(ctx);
  return { status, ctx, session: (window as any).__shiroRemoteSession };
}
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

describe('remote start: what reaches the signaling server', () => {
  it('registers the id and a sealed offer; the secret part and the SDP stay in the tab', async () => {
    const { status, session } = await startRemote();
    expect(status).toBe(0);
    const whole = store.get('tabcomputer-remote-code')!;
    const code = parseRemoteCode(whole);
    expect(code.id).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(session.displayCode).toBe(code.id.split('-').slice(0, 2).join('-'));
    await until(() => sent.some((s) => s.url.endsWith('/offer')));

    const reg = sent.find((s) => s.url.endsWith('/offer'))!;
    const body = JSON.parse(reg.body);
    expect(Object.keys(body).sort()).toEqual(['id', 'relay', 'sealed', 'v']);
    expect(body).toMatchObject({ v: 3, id: code.id, relay: { id: session.relay.id } });
    expect(Object.keys(body.relay)).toEqual(['id']);
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(code.secret);
    expect(everything).not.toContain('fingerprint');
    expect(everything).not.toContain(session.relay.salt);
    // …and what was sealed is the offer, for whoever holds the secret
    const opened = await openSignal(code, 'offer', body.sealed);
    expect(opened.offer.sdp).toContain('fingerprint');
    expect(opened.relay).toEqual(session.relay);

    // the answer poll names the id only
    await until(() => sent.some((s) => s.url.includes('/answer/')));
    expect(sent.find((s) => s.url.includes('/answer/'))!.url).toMatch(new RegExp(`/answer/${code.id}\\?v=3$`));
    await startRemote(['stop']);
  });

  it('takes a WebRTC answer only when it opens with the secret', async () => {
    const { session } = await startRemote();
    const code = parseRemoteCode(store.get('tabcomputer-remote-code')!);
    await until(() => sent.some((s) => s.url.includes('/answer/')));
    answerSealed = await sealSignal(code, 'answer', { answer: { type: 'answer', sdp: 'v=0 peer' }, candidates: [] });
    // (the next poll is 5 s away: ask now, the way the poll does)
    const { fetchAnswer } = await import('@shiro/remote-relay');
    expect(await fetchAnswer('http://x.test', code)).toMatchObject({ answer: { sdp: 'v=0 peer' } });
    answerSealed = await sealSignal({ id: code.id, secret: 'a'.repeat(26) }, 'answer', { answer: { type: 'answer', sdp: 'v=0 attacker' }, candidates: [] });
    expect(await fetchAnswer('http://x.test', code)).toEqual({ bad: expect.stringMatching(/does not open/) });
    expect(session.pc.remote).toBeNull();
    await startRemote(['stop']);
  });

  it('a code saved by a build from before protocol 3 is dropped, not registered', async () => {
    store.set('tabcomputer-remote-code', 'sneaky-otter-kashimuteso');
    const { startRemoteWithCode } = await import('@shiro/commands/remote');
    expect(await startRemoteWithCode('sneaky-otter-kashimuteso')).toBe(false);
    expect(store.has('tabcomputer-remote-code')).toBe(false);
    expect((window as any).__shiroRemoteSession).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('an older signaling server is an error the user sees, and gets no code', async () => {
    serverKind = 'old';
    const { session } = await startRemote();
    const code = parseRemoteCode(store.get('tabcomputer-remote-code')!);
    await until(() => session.status === 'error');
    expect(session.error).toMatch(/older remote protocol/);
    const status = await startRemote(['status']);
    expect(status.ctx.stdout).toMatch(/older remote protocol/);
    expect(JSON.stringify(sent)).not.toContain(code.secret);
    expect(sent.filter((s) => s.url.endsWith('/offer')).length).toBe(1);   // no retry in another shape
    await startRemote(['stop']);
  });
});
