/**
 * "Use my own connection" (issue #117, item 5):
 *  - the setting is applied to the kernel's sockets by boot, in the terminal
 *    UI as in the desktop (it used to be applied by the desktop only);
 *  - the token URL really is optional: server.mjs as a relay refuses a
 *    connection without a token, so an empty field means "/token next to the
 *    relay URL", and a relay with nothing there is used without a token.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { NetStack, installNet, followRelaySetting, netStackOf } from '@shiro/kernel/net';
import { Kernel } from '@shiro/kernel/kernel';
import { AF_INET, SOCK_STREAM } from '@shiro/kernel/abi';
import { setOwnRelay, relayNetConfig, relayTokenUrlFor } from '@shiro/net-signin';
import { dataFlowState } from '@shiro/data-flow';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);
const ORIGIN = 'http://app.test';
const store = new Map<string, string>();
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } },
});
afterAll(() => { if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage); else delete (globalThis as any).localStorage; });
beforeEach(() => { store.clear(); setOwnRelay(null); });

const SITE = { protocol: 'https:', host: 'tabcomputer.com' };

describe('the own-relay setting reaches the kernel in both UIs', () => {
  it('followRelaySetting points the sockets at the saved relay, and follows changes', () => {
    const kernel = new Kernel();
    const stack = new NetStack();
    stack.configure({ relayUrl: 'wss://site.test/tcp', tokenUrl: 'https://site.test/tcp/token', portHost: null, dohUrl: null });
    const offNet = installNet(kernel, stack);
    setOwnRelay({ url: 'wss://relay.example.com/tcp' });
    const off = followRelaySetting(kernel);
    expect(netStackOf(kernel)!.config.relayUrl).toBe('wss://relay.example.com/tcp');
    expect(netStackOf(kernel)!.config.credentials).toBe(false);
    setOwnRelay({ url: 'wss://other.example.com/tcp', tokenUrl: 'https://other.example.com/t' });
    expect(netStackOf(kernel)!.config.relayUrl).toBe('wss://other.example.com/tcp');
    expect(netStackOf(kernel)!.config.tokenUrl).toBe('https://other.example.com/t');
    off();
    offNet();
  });

  it('boot calls it for every UI, not the desktop alone', () => {
    const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8');
    const at = main.indexOf('followRelaySetting(kernel)');
    expect(at).toBeGreaterThan(-1);
    // right after the kernel's sockets are installed, outside any desktop-only branch
    const between = main.slice(main.indexOf('installNet(kernel);'), at).split('\n').filter((l) => !l.trim().startsWith('//') && !l.includes('installNet(kernel);')).join('\n');
    expect(between.trim()).toBe('');
    const desktop = readFileSync(new URL('../../../src/desktop/network.ts', import.meta.url), 'utf8');
    expect(desktop).not.toContain('.configure(relayNetConfig())');
  });

  it('the explainer says the terminal UI uses it', () => {
    const s = dataFlowState({
      host: 'tabcomputer.test', ui: 'terminal', guest: null, guestEnforced: false, guestsOffered: true, github: false, claude: false,
      apiKeys: [], remoteCode: false, ownRelayUrl: 'wss://relay.example.com/tcp', siteRelay: 'on', persisted: true,
    });
    expect(s.relay).toMatchObject({ kind: 'own', host: 'relay.example.com' });
  });
});

describe('the token URL is optional', () => {
  it('an empty token URL means /token next to the relay URL', () => {
    expect(relayTokenUrlFor('wss://relay.example.com/tcp')).toBe('https://relay.example.com/tcp/token');
    expect(relayTokenUrlFor('ws://localhost:8787/tcp/?x=1')).toBe('http://localhost:8787/tcp/token');
    expect(relayTokenUrlFor('https://relay.example.com/tcp')).toBeNull();
    setOwnRelay({ url: 'wss://relay.example.com/tcp' });
    expect(relayNetConfig(SITE)).toMatchObject({ tokenUrl: 'https://relay.example.com/tcp/token', tokenOptional: true, credentials: false });
    setOwnRelay({ url: 'wss://relay.example.com/tcp', tokenUrl: 'https://tokens.example.com/t' });
    expect(relayNetConfig(SITE)).toMatchObject({ tokenUrl: 'https://tokens.example.com/t' });
    expect(relayNetConfig(SITE).tokenOptional).toBeUndefined();
  });

  describe('against server.mjs as the relay', () => {
    let proc: ChildProcess; let echo: ChildProcess; let port = 0; let echoPort = 0;
    afterAll(() => { proc?.kill(); echo?.kill(); });

    it('connects with only the relay URL filled in (the server refuses a connection without a token)', async () => {
      // (child processes: node:net and server.mjs do not load under this config's polyfills)
      echo = spawn(process.execPath, ['-e', "require('net').createServer((c) => c.pipe(c)).listen(0, '127.0.0.1', function () { console.log(this.address().port); })"], { stdio: ['ignore', 'pipe', 'inherit'] });
      echoPort = await new Promise<number>((resolve) => { echo.stdout!.on('data', (d) => resolve(Number(String(d).trim()))); });
      proc = spawn(process.execPath, [serverPath], {
        env: { ...process.env, PORT: '0', TABCOMPUTER_TCP_RELAY: '1', TABCOMPUTER_TCP_ORIGINS: ORIGIN, TABCOMPUTER_TCP_ALLOW_CIDRS: '127.0.0.0/8', TABCOMPUTER_TCP_PORTS: String(echoPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      port = await new Promise<number>((resolve, reject) => {
        proc.once('exit', (c) => reject(new Error(`server exited (${c})`)));
        proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
      });

      // What the user typed: the relay URL, nothing else
      setOwnRelay({ url: `ws://127.0.0.1:${port}/tcp` });
      class OriginWebSocket extends WebSocket { constructor(url: string | URL) { super(url, { headers: { origin: ORIGIN } } as any); } }
      const asked: string[] = [];
      const stack = new NetStack();
      stack.configure({
        ...relayNetConfig(SITE), portHost: null, dohUrl: null, relayLoopback: true,
        fetch: ((u: any, init: any = {}) => { asked.push(String(u)); return fetch(u, { ...init, headers: { ...(init.headers || {}), origin: ORIGIN } }); }) as typeof fetch,
        WebSocket: OriginWebSocket as unknown as typeof WebSocket,
      });
      const s = stack.socket(AF_INET, SOCK_STREAM) as any;
      expect(await s.connect({ family: AF_INET, address: '127.0.0.1', port: echoPort })).toBe(0);
      await s.write(new TextEncoder().encode('hello'));
      const buf = new Uint8Array(16);
      expect(new TextDecoder().decode(buf.subarray(0, await s.read(buf)))).toBe('hello');
      await s.close();
      expect(asked).toEqual([`http://127.0.0.1:${port}/tcp/token`]);

      // Without a token the same relay refuses (what an empty token URL used to do)
      const bare = new NetStack();
      bare.configure({ relayUrl: `ws://127.0.0.1:${port}/tcp`, tokenUrl: null, portHost: null, dohUrl: null, relayLoopback: true, WebSocket: OriginWebSocket as unknown as typeof WebSocket });
      const s2 = bare.socket(AF_INET, SOCK_STREAM) as any;
      expect(await s2.connect({ family: AF_INET, address: '127.0.0.1', port: echoPort })).toBeLessThan(0);
    }, 30_000);
  });

  it('a relay with nothing at the guessed token URL is used without a token', async () => {
    for (const answer of [
      async () => new Response('<!doctype html><title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => new Response('Not found', { status: 404 }),
      async () => { throw new TypeError('Failed to fetch'); },
    ]) {
      const s = new NetStack();
      s.configure({ relayUrl: 'wss://relay.example.com/tcp', tokenUrl: 'https://relay.example.com/tcp/token', tokenOptional: true, credentials: false, portHost: null, dohUrl: null, fetch: answer as unknown as typeof fetch });
      expect(await (s as any).relayToken()).toBeNull();
    }
    // …but a refusal from it is a refusal, and a token URL the user gave must work
    const refuse = (async () => new Response('Forbidden', { status: 403 })) as unknown as typeof fetch;
    const s = new NetStack();
    s.configure({ relayUrl: 'wss://relay.example.com/tcp', tokenUrl: 'https://relay.example.com/tcp/token', tokenOptional: true, credentials: false, portHost: null, dohUrl: null, fetch: refuse });
    await expect((s as any).relayToken()).rejects.toThrow(/403/);
    const given = new NetStack();
    given.configure({ relayUrl: 'wss://relay.example.com/tcp', tokenUrl: 'https://tokens.example.com/t', credentials: false, portHost: null, dohUrl: null, fetch: (async () => new Response('Not found', { status: 404 })) as unknown as typeof fetch });
    await expect((given as any).relayToken()).rejects.toThrow(/404/);
  });
});
