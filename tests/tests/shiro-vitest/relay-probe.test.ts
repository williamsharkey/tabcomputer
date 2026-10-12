/**
 * Is there a relay? (issue #117, item 4.) A server without the TCP relay
 * answers POST /tcp/token with the app shell (200, text/html), so "it
 * answered" is not "there is a relay": the probe wants a real token.
 * The answers here are the ones server.mjs gives (the last test asks it).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRelayToken, networkStatus, setNetworkStatus } from '@shiro/net-signin';
import { probeRelay } from '@shiro/desktop/network';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);
const SHELL = '<!doctype html><html><head><title>tabcomputer</title></head><body></body></html>';

const answer = (status: number, body: string, type: string) => (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
const shell = answer(200, SHELL, 'text/html');
const token = answer(200, JSON.stringify({ token: '1.abc', expires: Date.now() + 60_000 }), 'application/json');

describe('probeRelayToken', () => {
  it('a token is a relay; the app shell, a 404 or other JSON is not', async () => {
    expect(await probeRelayToken('/tcp/token', { fetch: token })).toBe('on');
    expect(await probeRelayToken('/tcp/token', { fetch: shell })).toBe('off');
    expect(await probeRelayToken('/tcp/token', { fetch: answer(404, 'Not found', 'text/plain') })).toBe('off');
    expect(await probeRelayToken('/tcp/token', { fetch: answer(200, '{"ok":true}', 'application/json') })).toBe('off');
    expect(await probeRelayToken('/tcp/token', { fetch: answer(401, '{"error":"signin_required"}', 'application/json') })).toBe('signin');
    expect(await probeRelayToken('/tcp/token', { fetch: answer(403, 'Forbidden', 'text/plain') })).toBe('refused');
    expect(await probeRelayToken('/tcp/token', { fetch: answer(502, 'Bad gateway', 'text/plain') })).toBe('unknown');
    expect(await probeRelayToken('/tcp/token', { fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch })).toBe('unknown');
  });
});

describe('probeRelay (the menu bar and Settings → Network)', () => {
  const realFetch = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  beforeAll(() => { Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true }); });
  afterAll(() => { if (nav) Object.defineProperty(globalThis, 'navigator', nav); });
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); setNetworkStatus('unknown'); });

  it('says the relay is unavailable on a server that answers /tcp/token with the app shell', async () => {
    globalThis.fetch = shell;
    expect(await probeRelay()).toBe('unavailable');
    expect(networkStatus()).toBe('unavailable');
  });

  it('says online when a token comes back, and needs-sign-in on a 401', async () => {
    globalThis.fetch = token;
    expect(await probeRelay()).toBe('online');
    globalThis.fetch = answer(401, '{"error":"signin_required","provider":"github"}', 'application/json');
    expect(await probeRelay()).toBe('needs-sign-in');
  });
});

describe('what server.mjs answers', () => {
  const servers: ChildProcess[] = [];
  const dist = mkdtempSync(join(tmpdir(), 'relay-probe-'));
  writeFileSync(join(dist, 'index.html'), SHELL);
  afterAll(() => { for (const p of servers) p.kill(); rmSync(dist, { recursive: true, force: true }); });

  async function start(env: Record<string, string>): Promise<string> {
    const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', STATIC_DIR: dist, TABCOMPUTER_TCP_RELAY: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('exit', (code) => reject(new Error(`server exited (${code})`)));
      proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    });
    return `http://127.0.0.1:${port}`;
  }
  const from = (origin: string) => ((url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...(init.headers as object), origin } })) as unknown as typeof fetch;

  it('without the relay the path is the app shell (a 2xx), and the probe says off; with it, on', async () => {
    const off = await start({});
    const raw = await fetch(`${off}/tcp/token`, { method: 'POST' });
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain('<title>');
    expect(await probeRelayToken(`${off}/tcp/token`)).toBe('off');

    const on = await start({ TABCOMPUTER_TCP_RELAY: '1', TABCOMPUTER_TCP_ORIGINS: 'http://app.test' });
    expect(await probeRelayToken(`${on}/tcp/token`, { fetch: from('http://app.test') })).toBe('on');
    expect(await probeRelayToken(`${on}/tcp/token`, { fetch: from('http://other.test') })).toBe('refused');
  }, 30_000);
});
