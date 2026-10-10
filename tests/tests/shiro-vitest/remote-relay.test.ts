/**
 * `remote start` over the HTTPS relay (src/remote-relay.ts, server.mjs
 * createRemoteRelay): for a peer that can't do WebRTC (a cloud container with
 * only an HTTPS proxy). The tab names a mailbox in its offer, the peer answers
 * {type: 'relay'}, and both long-poll the server with messages sealed by a key
 * derived from the remote code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RelayChannel, newRelayInfo, relayKey, sealMessage, openMessage } from '@shiro/remote-relay';
// shiro-mcp's copy, used by the peer side here
import { RelayChannel as PeerRelayChannel } from '../../../shiro-mcp/src/relay';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);

async function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once('exit', (code) => reject(new Error(`server exited (${code})`)));
    proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

const json = (r: Response) => r.json() as Promise<any>;
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const nextMessage = (ch: { onmessage: any }) => new Promise<string>((resolve) => { ch.onmessage = (e: { data: string }) => resolve(e.data); });
const opened = (ch: { onopen: any; readyState: string }) => new Promise<void>((resolve) => { if (ch.readyState === 'open') resolve(); else ch.onopen = () => resolve(); });

describe('remote relay', () => {
  it('shiro-mcp carries an identical copy of the relay module', () => {
    const tab = readFileSync(new URL('../../../src/remote-relay.ts', import.meta.url), 'utf8');
    const peer = readFileSync(new URL('../../../shiro-mcp/src/relay.ts', import.meta.url), 'utf8');
    expect(peer).toBe(tab);
  });

  it('seals messages so they only open for the right code, direction and order', async () => {
    const info = newRelayInfo();
    const key = await relayKey('fluffy-cloud-shimutako', info.salt);
    const wrong = await relayKey('fluffy-cloud-shimutakx', info.salt);
    const env = await sealMessage(key, 'peer', 1, '{"type":"exec","command":"ls"}');
    expect(env).not.toContain('exec');
    expect((await openMessage(key, 'peer', env, 0)).text).toBe('{"type":"exec","command":"ls"}');
    await expect(openMessage(wrong, 'peer', env, 0)).rejects.toThrow();          // another code
    await expect(openMessage(key, 'tab', env, 0)).rejects.toThrow();             // reflected back
    await expect(openMessage(key, 'peer', env, 1)).rejects.toThrow(/replayed/);  // replay
    await expect(openMessage(key, 'peer', env.replace(/^1\./, '2.'), 0)).rejects.toThrow(); // renumbered
    const bytes = env.split('.')[1];
    const flipped = `1.${bytes.slice(0, 20)}${bytes[20] === 'A' ? 'B' : 'A'}${bytes.slice(21)}`;
    await expect(openMessage(key, 'peer', flipped, 0)).rejects.toThrow();        // tampered
  });

  describe('through server.mjs', () => {
    let server: { proc: ChildProcess; base: string };
    beforeAll(async () => { server = await startServer(); }, 30_000);
    afterAll(() => { server?.proc.kill(); });

    it('negotiates through the offer and answer, then carries messages both ways in order', async () => {
      const code = `relay-test-${Date.now().toString(36)}`;
      const info = newRelayInfo();
      expect((await post(`${server.base}/offer`, { code, offer: { type: 'offer', sdp: 'v=0' }, candidates: [], relay: info })).ok).toBe(true);

      // The peer finds the mailbox only through the code
      const offer = await json(await fetch(`${server.base}/offer/${code}`));
      expect(offer.relay).toEqual(info);
      expect((await post(`${server.base}/answer/${code}`, { answer: { type: 'relay', v: 1 }, candidates: [] })).ok).toBe(true);
      expect((await json(await fetch(`${server.base}/answer/${code}`))).answer).toEqual({ type: 'relay', v: 1 });

      const peer = new PeerRelayChannel({ base: server.base, info: offer.relay, code, as: 'peer', waitMs: 2000 });
      const tab = new RelayChannel({ base: server.base, info, code, as: 'tab', waitMs: 2000 });
      await Promise.all([opened(peer), opened(tab)]);

      const atTab: string[] = [];
      tab.onmessage = (e) => { atTab.push(e.data); tab.send(JSON.stringify({ echo: JSON.parse(e.data).n })); };
      const atPeer: string[] = [];
      const allBack = new Promise<void>((resolve) => { peer.onmessage = (e) => { atPeer.push(e.data); if (atPeer.length === 50) resolve(); }; });
      for (let n = 0; n < 50; n++) peer.send(JSON.stringify({ n }));
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

    it('the server only queues opaque strings, and refuses unknown mailboxes', async () => {
      const code = `relay-test2-${Date.now().toString(36)}`;
      const info = newRelayInfo();
      await post(`${server.base}/offer`, { code, offer: { type: 'offer', sdp: 'v=0' }, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, code, as: 'tab', waitMs: 500 });
      await opened(tab);
      tab.send('{"type":"exec_result","stdout":"secret file contents"}');
      await new Promise((r) => setTimeout(r, 300));
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

    it('a forged message from someone without the code is dropped', async () => {
      const code = `relay-test3-${Date.now().toString(36)}`;
      const info = newRelayInfo();
      await post(`${server.base}/offer`, { code, offer: { type: 'offer', sdp: 'v=0' }, candidates: [], relay: info });
      const tab = new RelayChannel({ base: server.base, info, code, as: 'tab', waitMs: 500 });
      await opened(tab);
      const seen: string[] = [];
      tab.onmessage = (e) => seen.push(e.data);
      const forger = await relayKey('guessed-code-nope', info.salt);
      await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: [await sealMessage(forger, 'peer', 1, '{"type":"eval","code":"1"}')] });
      const honest = await relayKey(code, info.salt);
      await post(`${server.base}/relay/${info.id}/send?as=peer`, { msgs: [await sealMessage(honest, 'peer', 2, '{"type":"ping"}')] });
      await new Promise((r) => setTimeout(r, 1500));
      expect(seen).toEqual(['{"type":"ping"}']);
      tab.close();
    }, 30_000);

    it('closes when the other side stops polling', async () => {
      const code = `relay-test4-${Date.now().toString(36)}`;
      const info = newRelayInfo();
      await post(`${server.base}/offer`, { code, offer: { type: 'offer', sdp: 'v=0' }, candidates: [], relay: info });
      const peer = new PeerRelayChannel({ base: server.base, info, code, as: 'peer', waitMs: 200, peerGoneMs: 1500 });
      const tab = new RelayChannel({ base: server.base, info, code, as: 'tab', waitMs: 200, peerGoneMs: 1500 });
      await Promise.all([opened(peer), opened(tab)]);
      const closed = new Promise<void>((resolve) => { tab.onclose = () => resolve(); });
      peer.close();
      await closed;
      expect(tab.readyState).toBe('closed');
    }, 30_000);
  });
});
