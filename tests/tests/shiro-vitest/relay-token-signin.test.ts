/**
 * The GitHub sign-in and the relay's token endpoint (issue #117, item 2).
 * server.mjs asks for it only when TABCOMPUTER_TCP_REQUIRE_SIGNIN=1 (a 401
 * {error: 'signin_required'}); the page used to send it with every token
 * request anyway. Now the first request carries no credential, and the
 * sign-in follows only a 401 that asks for it. A relay of the user's own
 * gets it only when they turned that on.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { NetStack } from '@shiro/kernel/net';
import { relayNetConfig, setOwnRelay, setNetworkSignInHandler } from '@shiro/net-signin';
import { probeRelay } from '@shiro/desktop/network';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);

const TOKEN = 'gho_savedGitHubSignIn0000000000000000000';
const ORIGIN = 'http://app.test';
const store = new Map<string, string>();
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } },
});
afterAll(() => { if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage); else delete (globalThis as any).localStorage; });

/**
 * server.mjs's own token handler (in a child process: server.mjs does not load
 * under this config's polyfills) behind an http server that records what each
 * token request carried; GET /seen returns the Authorization headers so far.
 */
async function relayServer(requireSignin: boolean): Promise<{ url: string; seen: () => Promise<(string | null)[]>; close: () => void }> {
  const script = `
import { createServer } from 'node:http';
const { createTcpRelay } = await import(${JSON.stringify(serverPath)});
const relay = createTcpRelay({ enabled: true, allowedOrigins: [${JSON.stringify(ORIGIN)}], requireSignin: ${requireSignin}, secret: 'test' },
  { log: () => {}, verifySignin: async (t) => (t === ${JSON.stringify(TOKEN)} ? 'someone' : null) });
const seen = [];
const server = createServer((req, res) => {
  if (req.url === '/seen') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(seen)); }
  if (req.method === 'POST') seen.push(req.headers.authorization ?? null);
  relay.handleToken(req, res);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
`;
  const proc: ChildProcess = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once('exit', (c) => reject(new Error(`relay harness exited ${c}`)));
    proc.stdout!.on('data', (d) => { const line = String(d).split('\n').find((l) => l.startsWith('{')); if (line) resolve(JSON.parse(line).port); });
  });
  const base = `http://127.0.0.1:${port}`;
  return { url: `${base}/tcp/token`, seen: async () => (await fetch(`${base}/seen`)).json(), close: () => { proc.kill(); } };
}

const asPage = ((u: any, init: any = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), origin: ORIGIN } })) as typeof fetch;
function stackFor(tokenUrl: string, credentials: boolean): NetStack {
  const s = new NetStack();
  s.configure({ relayUrl: 'ws://127.0.0.1:1/tcp', tokenUrl, fetch: asPage, portHost: null, dohUrl: null, credentials });
  return s;
}
const askToken = (s: NetStack) => (s as any).relayToken() as Promise<string | null>;
const expire = (s: NetStack) => { (s as any).token = null; };

describe('the saved GitHub sign-in and /tcp/token', () => {
  const open: { close: () => void }[] = [];
  afterAll(() => { for (const s of open) s.close(); });
  beforeEach(() => { store.clear(); store.set('tabcomputer_github_token', TOKEN); setOwnRelay(null); store.set('tabcomputer_github_token', TOKEN); });

  it("this site's relay, sign-in not required (tabcomputer.com today): the token never leaves", async () => {
    const srv = await relayServer(false); open.push(srv);
    const stack = stackFor(srv.url, true);
    expect(await askToken(stack)).toMatch(/^\d+\./);
    expire(stack);
    expect(await askToken(stack)).toMatch(/^\d+\./);
    expect(await srv.seen()).toEqual([null, null]);
  });

  it("this site's relay, sign-in required: asked without it first, then with it, and at once from then on", async () => {
    const srv = await relayServer(true); open.push(srv);
    const stack = stackFor(srv.url, true);
    expect(await askToken(stack)).toMatch(/^\d+\./);
    expect(await srv.seen()).toEqual([null, `Bearer ${TOKEN}`]);
    expire(stack);
    expect(await askToken(stack)).toMatch(/^\d+\./);
    expect(await srv.seen()).toEqual([null, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    // A new relay setting forgets that: the next relay is asked without it again
    stack.configure({ tokenUrl: srv.url });
    await askToken(stack);
    expect((await srv.seen()).slice(3)).toEqual([null, `Bearer ${TOKEN}`]);
  });

  it("a relay of the user's own never gets it, even when it answers 401, and nobody is asked to sign in", async () => {
    const srv = await relayServer(true); open.push(srv);
    setOwnRelay({ url: 'ws://127.0.0.1:1/tcp', tokenUrl: srv.url });
    const cfg = relayNetConfig({ protocol: 'https:', host: 'tabcomputer.com' });
    expect(cfg.credentials).toBe(false);
    const asked: unknown[] = [];
    const off = setNetworkSignInHandler(async (need) => { asked.push(need); return TOKEN; });
    const stack = stackFor(cfg.tokenUrl!, cfg.credentials);
    await expect(askToken(stack)).rejects.toThrow(/401/);
    await expect(askToken(stack)).rejects.toThrow(/401/);
    off();
    expect(await srv.seen()).toEqual([null, null]);
    expect(asked).toEqual([]);
  });

  it("…unless the user turned that on for it, and then only after it asked", async () => {
    const required = await relayServer(true); open.push(required);
    const free = await relayServer(false); open.push(free);
    setOwnRelay({ url: 'ws://127.0.0.1:1/tcp', tokenUrl: required.url, sendSignin: true });
    let cfg = relayNetConfig({ protocol: 'https:', host: 'tabcomputer.com' });
    expect(cfg.credentials).toBe(true);
    await askToken(stackFor(cfg.tokenUrl!, cfg.credentials));
    expect(await required.seen()).toEqual([null, `Bearer ${TOKEN}`]);
    setOwnRelay({ url: 'ws://127.0.0.1:1/tcp', tokenUrl: free.url, sendSignin: true });
    cfg = relayNetConfig({ protocol: 'https:', host: 'tabcomputer.com' });
    await askToken(stackFor(cfg.tokenUrl!, cfg.credentials));
    expect(await free.seen()).toEqual([null]);
  });

  it('a 401 that does not ask for a sign-in brings no credential', async () => {
    const seen: (string | null)[] = [];
    const s = new NetStack();
    s.configure({
      relayUrl: 'ws://127.0.0.1:1/tcp', tokenUrl: 'http://relay.test/tcp/token', portHost: null, dohUrl: null, credentials: true,
      fetch: (async (_u: any, init: any = {}) => { seen.push(init.headers?.Authorization ?? null); return new Response('Unauthorized', { status: 401 }); }) as typeof fetch,
    });
    await expect(askToken(s)).rejects.toThrow(/401/);
    expect(seen).toEqual([null]);
  });

  it('the menu bar probe does the same', async () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
    const realFetch = globalThis.fetch;
    try {
      for (const [requireSignin, want, status] of [[false, [null], 'signed-in'], [true, [null, `Bearer ${TOKEN}`], 'signed-in']] as const) {
        const srv = await relayServer(requireSignin); open.push(srv);
        globalThis.fetch = ((_u: any, init: any = {}) => realFetch(srv.url, { ...init, headers: { ...(init.headers || {}), origin: ORIGIN } })) as typeof fetch;
        const got = await probeRelay();
        globalThis.fetch = realFetch;
        expect(got).toBe(status);
        expect(await srv.seen()).toEqual(want);
      }
    } finally {
      globalThis.fetch = realFetch;
      if (nav) Object.defineProperty(globalThis, 'navigator', nav);
    }
  });
});
