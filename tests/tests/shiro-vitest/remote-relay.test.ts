/**
 * `remote start` (src/remote-relay.ts, server.mjs createSignaling and
 * createRemoteRelay). A remote code is `<id>#<secret>`: the server is given
 * the id; the offer, the answer and every relayed message are sealed with a
 * key derived from the secret, which is never sent (issue #117, item 3:
 * before protocol 3 the whole code was posted to /offer and logged, and the
 * code was the key).
 *
 * The relay is the transport for a peer that can't do WebRTC (a cloud
 * container with only an HTTPS proxy): the tab names a mailbox in its offer,
 * the peer answers {type: 'relay'}, and both long-poll the server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  RelayChannel, newRelayInfo, relayKey, sealMessage, openMessage,
  parseRemoteCode, formatRemoteCode, newRemoteSecret, sealSignal, openSignal,
  registerOffer, fetchOffer, sendAnswer, fetchAnswer, RemoteProtocolError, REMOTE_PROTOCOL,
} from '@shiro/remote-relay';
// shiro-mcp's copy, used by the peer side here
import { RelayChannel as PeerRelayChannel, fetchOffer as peerFetchOffer, sendAnswer as peerSendAnswer, parseRemoteCode as peerParse } from '../../../shiro-mcp/src/relay';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);

async function startServer(): Promise<{ proc: ChildProcess; base: string; output: () => string }> {
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stderr!.on('data', (d) => { out += String(d); });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`server exited (${code})`)));
    proc.stdout!.on('data', (d) => { out += String(d); const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  });
  return { proc, base: `http://127.0.0.1:${port}`, output: () => out };
}

const json = (r: Response) => r.json() as Promise<any>;
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const nextMessage = (ch: { onmessage: any }) => new Promise<string>((resolve) => { ch.onmessage = (e: { data: string }) => resolve(e.data); });
const opened = (ch: { onopen: any; readyState: string }) => new Promise<void>((resolve) => { if (ch.readyState === 'open') resolve(); else ch.onopen = () => resolve(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
/** A fresh code, as `remote start` makes them */
const newCode = () => formatRemoteCode(`relay-test${++n}-${Date.now().toString(36)}`, newRemoteSecret());
const OFFER = { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB' };

describe('remote relay', () => {
  it('shiro-mcp carries an identical copy of the relay module', () => {
    const tab = readFileSync(new URL('../../../src/remote-relay.ts', import.meta.url), 'utf8');
    const peer = readFileSync(new URL('../../../shiro-mcp/src/relay.ts', import.meta.url), 'utf8');
    expect(peer).toBe(tab);
  });

  it('a code is <id>#<secret>; one without a secret part (an older build\'s) is refused, not used', () => {
    const secret = newRemoteSecret();
    expect(secret).toMatch(/^[a-z2-7]{26}$/);
    expect(new Set(Array.from({ length: 200 }, newRemoteSecret)).size).toBe(200);
    expect(parseRemoteCode(`fluffy-cloud-shimutako#${secret}`)).toEqual({ id: 'fluffy-cloud-shimutako', secret });
    expect(parseRemoteCode(`  fluffy-cloud-shimutako#${secret}\n`).id).toBe('fluffy-cloud-shimutako');
    // before protocol 3 the whole code was the key, and the server had it
    expect(() => parseRemoteCode('fluffy-cloud-shimutako')).toThrow(RemoteProtocolError);
    expect(() => parseRemoteCode('fluffy-cloud-shimutako')).toThrow(/older tabcomputer/);
    expect(() => parseRemoteCode('fluffy-cloud-shimutako#short')).toThrow(/Not a remote code/);
    expect(() => parseRemoteCode(`../etc#${secret}`)).toThrow(/Not a remote code/);
    expect(() => parseRemoteCode('')).toThrow(RemoteProtocolError);
  });

  it('seals messages so they only open for the right secret, direction and order', async () => {
    const info = newRelayInfo();
    const key = await relayKey('abcdefghijklmnopqrstuvwxyz', info.salt);
    const wrong = await relayKey('abcdefghijklmnopqrstuvwxyy', info.salt);
    const env = await sealMessage(key, 'peer', 1, '{"type":"exec","command":"ls"}');
    expect(env).not.toContain('exec');
    expect((await openMessage(key, 'peer', env, 0)).text).toBe('{"type":"exec","command":"ls"}');
    await expect(openMessage(wrong, 'peer', env, 0)).rejects.toThrow();          // another secret
    await expect(openMessage(key, 'tab', env, 0)).rejects.toThrow();             // reflected back
    await expect(openMessage(key, 'peer', env, 1)).rejects.toThrow(/replayed/);  // replay
    await expect(openMessage(key, 'peer', env.replace(/^1\./, '2.'), 0)).rejects.toThrow(); // renumbered
    const bytes = env.split('.')[1];
    const flipped = `1.${bytes.slice(0, 20)}${bytes[20] === 'A' ? 'B' : 'A'}${bytes.slice(21)}`;
    await expect(openMessage(key, 'peer', flipped, 0)).rejects.toThrow();        // tampered
  });

  it('seals the offer and the answer so they open only with the secret, for that id and kind', async () => {
    const code = parseRemoteCode(newCode());
    const sealed = await sealSignal(code, 'offer', { offer: OFFER, candidates: [] });
    expect(sealed).not.toContain('fingerprint');
    expect(atob(sealed)).not.toContain('fingerprint');
    expect((await openSignal(code, 'offer', sealed)).offer).toEqual(OFFER);
    await expect(openSignal({ ...code, secret: newRemoteSecret() }, 'offer', sealed)).rejects.toThrow(/does not open/);
    await expect(openSignal({ ...code, id: 'other-id-x' }, 'offer', sealed)).rejects.toThrow();   // moved to another rendezvous
    await expect(openSignal(code, 'answer', sealed)).rejects.toThrow();                            // an offer played back as an answer
  });

  describe('through server.mjs', () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    beforeAll(async () => { server = await startServer(); }, 30_000);
    afterAll(() => { server?.proc.kill(); });

    it('negotiates through the sealed offer and answer, then carries messages both ways in order', async () => {
      const whole = newCode();
      const code = parseRemoteCode(whole);
      const info = newRelayInfo();
      await registerOffer(server.base, code, { offer: OFFER, candidates: [{ candidate: 'c1' }], relay: info });

      // The peer (shiro-mcp's copy) finds the mailbox through the id, and reads it with the secret
      const offer = (await peerFetchOffer(server.base, peerParse(whole)))!;
      expect(offer.offer).toEqual(OFFER);
      expect(offer.candidates).toEqual([{ candidate: 'c1' }]);
      expect(offer.relay).toEqual(info);
      expect(await fetchAnswer(server.base, code)).toEqual({ waiting: true });
      await peerSendAnswer(server.base, peerParse(whole), { answer: { type: 'relay', v: 2 }, candidates: [] });
      expect(await fetchAnswer(server.base, code)).toEqual({ answer: { type: 'relay', v: 2 }, candidates: [] });

      const peer = new PeerRelayChannel({ base: server.base, info: offer.relay!, secret: code.secret, as: 'peer', waitMs: 2000 });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 2000 });
      await Promise.all([opened(peer), opened(tab)]);

      const atTab: string[] = [];
      tab.onmessage = (e) => { atTab.push(e.data); tab.send(JSON.stringify({ echo: JSON.parse(e.data).n })); };
      const atPeer: string[] = [];
      const allBack = new Promise<void>((resolve) => { peer.onmessage = (e) => { atPeer.push(e.data); if (atPeer.length === 50) resolve(); }; });
      for (let i = 0; i < 50; i++) peer.send(JSON.stringify({ n: i }));
      await allBack;
      expect(atTab.map((m) => JSON.parse(m).n)).toEqual([...Array(50).keys()]);
      expect(atPeer.map((m) => JSON.parse(m).echo)).toEqual([...Array(50).keys()]);

      // A large reply (a file read) goes through in one piece
      const big = 'x'.repeat(600_000);
      const got = nextMessage(peer);
      tab.send(big);
      expect((await got).length).toBe(600_000);

      peer.close();
      tab.close();
    }, 30_000);

    it('what the server holds and answers is sealed: the id is not enough', async () => {
      const code = parseRemoteCode(newCode());
      const info = newRelayInfo();
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      // What anyone with the id gets
      const raw = await json(await fetch(`${server.base}/offer/${code.id}?v=${REMOTE_PROTOCOL}`));
      expect(Object.keys(raw).sort()).toEqual(['relay', 'sealed', 'v']);
      expect(raw.relay).toEqual({ id: info.id });         // the mailbox to open; its salt is inside the seal
      expect(JSON.stringify(raw)).not.toContain(info.salt);
      expect(JSON.stringify(raw)).not.toContain('fingerprint');
      // The id without the secret reads nothing, and an answer made without it is not taken
      await expect(fetchOffer(server.base, { id: code.id, secret: newRemoteSecret() })).rejects.toThrow(/does not open/);
      await sendAnswer(server.base, { id: code.id, secret: newRemoteSecret() }, { answer: { type: 'answer', sdp: 'v=0 attacker' }, candidates: [] });
      expect(await fetchAnswer(server.base, code)).toEqual({ bad: expect.stringMatching(/does not open/) });
      expect(await fetchOffer(server.base, parseRemoteCode(newCode()))).toBeNull();   // nothing registered
      expect(await fetchAnswer(server.base, parseRemoteCode(newCode()))).toEqual({ expired: true });
    }, 30_000);

    it('the server only queues opaque strings, and refuses unknown mailboxes', async () => {
      const code = parseRemoteCode(newCode());
      const info = newRelayInfo();
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 500 });
      await opened(tab);
      tab.send('{"type":"exec_result","stdout":"secret file contents"}');
      await sleep(300);
      // What sits in the mailbox for the peer is sealed
      const raw = await json(await fetch(`${server.base}/relay/${info.id}/recv?as=peer`));
      expect(raw.msgs).toHaveLength(1);
      expect(raw.msgs[0]).not.toContain('secret');
      tab.close();

      const other = newRelayInfo();
      expect((await fetch(`${server.base}/relay/${other.id}/recv?as=peer`)).status).toBe(404);
      expect((await post(`${server.base}/relay/${other.id}/send?as=peer`, { msgs: ['x'] })).status).toBe(404);
      expect((await fetch(`${server.base}/relay/${info.id}/recv?as=admin`)).status).toBe(404);
      expect((await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: [1] })).status).toBe(400);
    }, 30_000);

    it('a forged message from someone without the secret is dropped (the id is known to the server)', async () => {
      const code = parseRemoteCode(newCode());
      const info = newRelayInfo();
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 500 });
      await opened(tab);
      const seen: string[] = [];
      tab.onmessage = (e) => seen.push(e.data);
      // The best a server could try: the id it was given, the whole old-style code
      for (const guess of [code.id, 'guessed-code-nope', info.id]) {
        const forger = await relayKey(guess, info.salt);
        await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: [await sealMessage(forger, 'peer', 1, '{"type":"eval","code":"1"}')] });
      }
      const honest = await relayKey(code.secret, info.salt);
      await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: [await sealMessage(honest, 'peer', 2, '{"type":"ping"}')] });
      await sleep(1500);
      expect(seen).toEqual(['{"type":"ping"}']);
      tab.close();
    }, 30_000);

    it('a restarted peer rejoins a live tab on the same mailbox (v2 epochs); the old epoch stays closed', async () => {
      const code = parseRemoteCode(newCode());
      const info = newRelayInfo();
      expect(info.v).toBe(2);
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 300 });
      const seen: string[] = [];
      tab.onmessage = (e) => { seen.push(e.data); tab.send(`echo ${e.data}`); };
      // The first peer, and what it sent (for a replay later)
      const sent: string[] = [];
      const realFetch = globalThis.fetch;
      const spy = ((u: any, init: any) => { if (String(u).includes('/send?as=peer')) sent.push(...JSON.parse(init.body).msgs); return realFetch(u, init); }) as typeof fetch;
      const first = new PeerRelayChannel({ base: server.base, info, secret: code.secret, as: 'peer', waitMs: 300, fetch: spy });
      await Promise.all([opened(first), opened(tab)]);
      const r1 = nextMessage(first); first.send('one'); expect(await r1).toBe('echo one');
      first.onclose = null; first.close(); // shiro-mcp restarted: no goodbye, the tab doesn't know

      // It fetches the same offer again and joins the mailbox it names
      const again = (await peerFetchOffer(server.base, code))!;
      expect(again.relay).toEqual(info);
      const second = new PeerRelayChannel({ base: server.base, info: again.relay!, secret: code.secret, as: 'peer', waitMs: 300 });
      await opened(second);
      const r2 = nextMessage(second); second.send('two'); expect(await r2).toBe('echo two');
      // The first peer's messages, replayed after the second took over, are dropped
      await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: sent });
      await sleep(800);
      expect(seen).toEqual(['one', 'two']);
      second.close(); tab.close();
    }, 30_000);

    it('v1 envelopes (no epoch) still work', async () => {
      const code = parseRemoteCode(newCode());
      const info = { ...newRelayInfo(), v: 1 as const };
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 300 });
      const peer = new PeerRelayChannel({ base: server.base, info, secret: code.secret, as: 'peer', waitMs: 300 });
      await Promise.all([opened(peer), opened(tab)]);
      tab.onmessage = (e) => tab.send(`v1 ${e.data}`);
      const r = nextMessage(peer); peer.send('x'); expect(await r).toBe('v1 x');
      // v1 envelopes carry no epoch
      const raw = await json(await fetch(`${server.base}/relay/${info.id}/recv?as=tab`));
      expect(raw.msgs.every((m: string) => /^\d+\./.test(m))).toBe(true);
      peer.close(); tab.close();
    }, 30_000);

    it('closes when the other side stops polling', async () => {
      const code = parseRemoteCode(newCode());
      const info = newRelayInfo();
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: info });
      const peer = new PeerRelayChannel({ base: server.base, info, secret: code.secret, as: 'peer', waitMs: 200, peerGoneMs: 1500 });
      const tab = new RelayChannel({ base: server.base, info, secret: code.secret, as: 'tab', waitMs: 200, peerGoneMs: 1500 });
      await Promise.all([opened(peer), opened(tab)]);
      const closed = new Promise<void>((resolve) => { tab.onclose = () => resolve(); });
      peer.close();
      await closed;
      expect(tab.readyState).toBe('closed');
    }, 30_000);

    // ── A rolling deploy: an old page or an old shiro-mcp against this server ──

    it('refuses what clients from before protocol 3 send, with 426, and logs none of it', async () => {
      const oldCode = 'sneaky-otter-kashimuteso'; // an old code was the whole key
      // an old tab registering (it posted the code itself)
      const reg = await post(`${server.base}/offer`, { code: oldCode, offer: OFFER, candidates: [], relay: newRelayInfo() });
      expect(reg.status).toBe(426);
      expect(await json(reg)).toMatchObject({ error: 'upgrade_required', protocol: 3, message: expect.stringMatching(/Reload the tab/) });
      // an old shiro-mcp or probe fetching and answering
      const get = await fetch(`${server.base}/offer/${oldCode}`);
      expect(get.status).toBe(426);
      expect((await json(get)).message).toMatch(/update shiro-mcp/);
      expect((await post(`${server.base}/answer/${oldCode}`, { answer: { type: 'relay', v: 2 }, candidates: [] })).status).toBe(426);
      // the old tab's answer poll just sees "expired", as for a forgotten offer
      expect(await json(await fetch(`${server.base}/answer/${oldCode}`))).toEqual({ expired: true });
      // nothing was registered under it
      expect((await fetch(`${server.base}/offer/${oldCode}?v=3`)).status).toBe(404);
      await sleep(100);
      expect(server.output()).not.toContain(oldCode);
      expect(server.output()).not.toContain('kashimuteso');
    }, 30_000);

    it('an old client given a new code cannot send the secret: it is the URL fragment', async () => {
      const whole = newCode();
      const code = parseRemoteCode(whole);
      await registerOffer(server.base, code, { offer: OFFER, candidates: [], relay: null });
      // exactly what shiro-mcp and probe.mjs did before protocol 3
      const res = await fetch(`${server.base}/offer/${whole}`);
      expect(res.status).toBe(426);
      expect(res.url).not.toContain(code.secret);   // a fragment is never put on the wire
      const ans = await fetch(`${server.base}/answer/${whole}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: { type: 'relay', v: 2 }, candidates: [] }) });
      expect(ans.status).toBe(426);
      await sleep(100);
      expect(server.output()).not.toContain(code.secret);
      // the registered id is logged; that is the public half
      expect(server.output()).toContain(`[signal] offer registered: ${code.id}`);
    }, 30_000);
  });

  // ── …and this client against a server from before protocol 3 ──

  describe('against an older signaling server', () => {
    /** server.mjs before protocol 3: it wants {code, offer}, and answers {offer, candidates, relay} */
    function oldServer() {
      const sent: string[] = [];
      const f = (async (url: any, init: any = {}) => {
        sent.push(`${init.method || 'GET'} ${url} ${init.body ?? ''}`);
        const path = new URL(String(url)).pathname;
        const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (path === '/offer') {
          const data = JSON.parse(init.body);
          return !data.code || !data.offer ? reply(400, { error: 'Missing code or offer' }) : reply(200, { ok: true });
        }
        if (path.startsWith('/offer/')) return reply(200, { offer: OFFER, candidates: [], relay: newRelayInfo() });
        if (path.startsWith('/answer/') && init.method === 'POST') return reply(200, { ok: true });
        return reply(200, { answer: { type: 'answer', sdp: 'v=0' }, candidates: [] });
      }) as unknown as typeof fetch;
      return { f, sent };
    }

    it('says so and sends no secret, instead of falling back to posting the code', async () => {
      const whole = newCode();
      const code = parseRemoteCode(whole);
      const old = oldServer();
      await expect(registerOffer('http://old.test', code, { offer: OFFER, candidates: [], relay: newRelayInfo() }, old.f)).rejects.toThrow(RemoteProtocolError);
      await expect(registerOffer('http://old.test', code, { offer: OFFER, candidates: [], relay: null }, old.f)).rejects.toThrow(/older remote protocol/);
      await expect(fetchOffer('http://old.test', code, old.f)).rejects.toThrow(RemoteProtocolError);
      await expect(fetchAnswer('http://old.test', code, old.f)).rejects.toThrow(RemoteProtocolError);
      expect(old.sent.length).toBe(4);
      const all = old.sent.join('\n');
      expect(all).not.toContain(code.secret);
      expect(all).not.toContain(encodeURIComponent(whole));
      expect(all).not.toContain('fingerprint');   // not even the SDP went in the clear
    });
  });
});

describe('the server-side handlers never see a value the session key can be derived from', () => {
  // server.mjs's own createSignaling and createRemoteRelay (in a child process: server.mjs
  // does not load under this config's polyfills), behind an http server that records
  // every request exactly as the handlers receive it, and every line they log.
  let proc: ChildProcess; let base = '';
  beforeAll(async () => {
    const script = `
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
const { createSignaling, createRemoteRelay } = await import(${JSON.stringify(serverPath)});
const seen = [];
const relay = createRemoteRelay();
const signaling = createSignaling({ relay, log: (...a) => seen.push({ log: a.join(' ') }) });
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/__seen') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(seen)); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: body.toString('utf8') });
  const again = Object.assign(Readable.from(body.length ? [body] : []), { method: req.method, url: req.url, headers: req.headers });
  if (pathname.startsWith('/relay/')) return relay.handle(again, res, pathname);
  return signaling.handle(again, res, pathname);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
`;
    proc = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
      proc.stdout!.on('data', (d) => { const line = String(d).split('\n').find((l) => l.startsWith('{')); if (line) resolve(JSON.parse(line).port); });
    });
    base = `http://127.0.0.1:${port}`;
  }, 30_000);
  afterAll(() => { proc?.kill(); });

  /** Every string the server was handed: whole values and their parts */
  function stringsIn(seen: any[]): string[] {
    const out = new Set<string>();
    const add = (v: unknown) => {
      if (typeof v === 'string') {
        if (!v) return;
        out.add(v);
        for (const part of v.split(/[\/?&=#.:,;\s"'{}\[\]]+/)) if (part) out.add(part);
        try { add(JSON.parse(v)); } catch { /* not JSON */ }
        try { out.add(decodeURIComponent(v)); } catch { /* not encoded */ }
      } else if (Array.isArray(v)) v.forEach(add);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); add(x); }
    };
    add(seen);
    return [...out];
  }

  it('a whole session (offer, answer, relayed commands and replies) gives the server nothing to derive it from', async () => {
    const whole = newCode();
    const code = parseRemoteCode(whole);
    const info = newRelayInfo();

    // The tab registers; the peer fetches, answers "relay"; both talk through the mailbox
    await registerOffer(base, code, { offer: OFFER, candidates: [{ candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host' }], relay: info });
    const offer = (await peerFetchOffer(base, peerParse(whole)))!;
    await peerSendAnswer(base, peerParse(whole), { answer: { type: 'relay', v: offer.relay!.v }, candidates: [] });
    const answer = await fetchAnswer(base, code) as { answer: { type: string } };
    expect(answer.answer.type).toBe('relay');
    const tab = new RelayChannel({ base, info, secret: code.secret, as: 'tab', waitMs: 300 });
    const peer = new PeerRelayChannel({ base, info: offer.relay!, secret: code.secret, as: 'peer', waitMs: 300 });
    await Promise.all([opened(tab), opened(peer)]);
    tab.onmessage = (e) => tab.send(JSON.stringify({ type: 'exec_result', stdout: 'TOP-SECRET-FILE-CONTENTS', for: JSON.parse(e.data).command }));
    const reply = nextMessage(peer);
    peer.send(JSON.stringify({ type: 'exec', command: 'cat ~/.claude/.credentials.json' }));
    expect(JSON.parse(await reply).stdout).toBe('TOP-SECRET-FILE-CONTENTS');
    // a WebRTC answer too (the other transport's signaling)
    await peerSendAnswer(base, peerParse(whole), { answer: { type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 CC:DD' }, candidates: [] });
    tab.close(); peer.close();
    await sleep(200);

    const seen = await json(await fetch(`${base}/__seen`)) as any[];
    expect(seen.filter((e) => e.method).length).toBeGreaterThan(6);
    expect(seen.some((e) => e.log?.includes(code.id))).toBe(true);   // the handler did log, and only the id

    // 1. The secret is nowhere in what the handlers were given or logged, in any encoding
    const everything = JSON.stringify(seen);
    const b64 = (s: string) => btoa(s);
    const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
    for (const form of [code.secret, whole, encodeURIComponent(whole), b64(code.secret), b64(whole), hex(code.secret), code.secret.toUpperCase()]) {
      expect(everything.includes(form), `the server saw ${form.slice(0, 12)}…`).toBe(false);
    }
    // …nor the plaintext it protects, nor the relay salt
    for (const plain of ['TOP-SECRET-FILE-CONTENTS', '.credentials.json', 'fingerprint', '192.168.1.20', info.salt]) expect(everything).not.toContain(plain);

    // 2. No value it saw works as the key material: try each one as the secret
    const sealedOffer = JSON.parse(seen.find((e) => e.method === 'POST' && e.url === '/offer').body).sealed as string;
    const sealedAnswer = JSON.parse(seen.find((e) => e.method === 'POST' && e.url.startsWith('/answer/')).body).sealed as string;
    const relayed = JSON.parse(seen.find((e) => e.method === 'POST' && e.url.includes('/send?as=peer')).body).msgs[0] as string;
    const opens = async (secret: string) => {
      const results = await Promise.allSettled([
        openSignal({ id: code.id, secret }, 'offer', sealedOffer),
        openSignal({ id: code.id, secret }, 'answer', sealedAnswer),
        relayKey(secret, info.salt).then((k) => openMessage(k, 'peer', relayed, 0)),
      ]);
      return results.filter((r) => r.status === 'fulfilled').length;
    };
    expect(await opens(code.secret)).toBe(3);                 // the check itself works
    const candidates = stringsIn(seen);
    expect(candidates).toContain(code.id);
    expect(candidates.length).toBeGreaterThan(30);
    for (const c of candidates) expect(await opens(c), `a value the server saw opens the session: ${c.slice(0, 40)}`).toBe(0);
  }, 60_000);
});
