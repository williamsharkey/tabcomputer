/**
 * Guests (src/guest.ts, server.mjs "Guests", docs/research/GUEST_PROFILE.md):
 * the hostname label, the addresses that ask for one, the statement of the
 * boundary, and what server.mjs refuses a guest host. The isolation itself is
 * the browser's and is checked in tests/browser/guest-profile.mjs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  parseGuestLabel, parseGuestHost, parseGuestOrigin, guestLabel, cleanGuestName, randomGuestName, guestRequest,
  guestUrl, inboundCodeLink, boundaryStatement, framedByGuest, wipeGuestStorage, guestConfig, guestInfo,
  setGuestHostForTests, resetGuestConfigForTests,
} from '@shiro/guest';
import { parentAppOrigin } from '@shiro/browser/origin-map';
import { relayNetConfig } from '@shiro/net-signin';
import { guestCmd } from '@shiro/commands/guest';

const nodeRequire = createRequire(import.meta.url);
const { spawn } = nodeRequire('node:child_process');
const { mkdtempSync, writeFileSync } = nodeRequire('node:fs');
const { tmpdir } = nodeRequire('node:os');
const path = nodeRequire('node:path');
const http = nodeRequire('node:http');

afterEach(() => { setGuestHostForTests(undefined); resetGuestConfigForTests(); });

describe('guest label', () => {
  it('parses a name and its flags', () => {
    expect(parseGuestLabel('guest--abc')).toEqual({ label: 'guest--abc', name: 'abc', ephemeral: false, noNetwork: false });
    expect(parseGuestLabel('guest--abc--t')).toMatchObject({ ephemeral: true, noNetwork: false });
    expect(parseGuestLabel('guest--abc--x')).toMatchObject({ ephemeral: false, noNetwork: true });
    expect(parseGuestLabel('GUEST--Abc--TX')).toMatchObject({ label: 'guest--abc--tx', ephemeral: true, noNetwork: true });
  });
  it('takes nothing else for a guest', () => {
    for (const l of ['guest', 'guest-abc', 'guest--', 'guest--a-b', 'guest--abc--xt', 'guest--abc--q', 'guest--abc--', 'xguest--abc', 'guest--' + 'a'.repeat(33), 'music', 'www-example-com']) {
      expect(parseGuestLabel(l), l).toBeNull();
    }
  });
  it('round-trips through guestLabel', () => {
    for (const g of [{ name: 'a1' }, { name: 'a1', ephemeral: true }, { name: 'a1', noNetwork: true }, { name: 'a1', ephemeral: true, noNetwork: true }]) {
      expect(parseGuestLabel(guestLabel(g))).toMatchObject({ name: 'a1', ephemeral: !!g.ephemeral, noNetwork: !!g.noNetwork });
    }
  });
  it('is the first label of a host that has a parent', () => {
    expect(parseGuestHost('guest--abc--x.tabcomputer.com')?.noNetwork).toBe(true);
    expect(parseGuestHost('guest--abc.app.localhost')?.name).toBe('abc');
    expect(parseGuestHost('guest--abc')).toBeNull();
    expect(parseGuestHost('www.guest--abc.tabcomputer.com')).toBeNull();
    expect(parseGuestHost('tabcomputer.com')).toBeNull();
    expect(parseGuestOrigin('https://guest--abc.tabcomputer.com')?.name).toBe('abc');
    expect(parseGuestOrigin('null')).toBeNull();
  });
  it('is never a browse key', async () => {
    const { decodeOriginKey } = await import('@shiro/browser/origin-map');
    for (const l of ['guest--abc', 'guest--abc--t', 'guest--abc--tx']) expect(decodeOriginKey(l)).toBeNull();
  });
  it('cleans names and makes random ones', () => {
    expect(cleanGuestName('My Repo-2!')).toBe('myrepo2');
    expect(cleanGuestName('---')).toBe('');
    const a = randomGuestName(), b = randomGuestName();
    expect(a).toMatch(/^[a-z0-9]{10}$/);
    expect(a).not.toBe(b);
  });
});

describe('asking for a guest', () => {
  it('reads ?guest, ?guest=NAME and &nonet', () => {
    expect(guestRequest('')).toBeNull();
    expect(guestRequest('?run=x')).toBeNull();
    expect(guestRequest('?guest=0')).toBeNull();
    expect(guestRequest('?guest')).toEqual({ noNetwork: false });
    expect(guestRequest('?guest=1&nonet')).toEqual({ noNetwork: true });
    expect(guestRequest('?guest=Work&nonet=0')).toEqual({ name: 'work', noNetwork: false });
  });
  it('builds the address, taking the path and the other parameters along', () => {
    const t = 'https://{guest}.tabcomputer.com';
    expect(guestUrl(t, { name: 'work' })).toBe('https://guest--work.tabcomputer.com/');
    expect(guestUrl(t, { name: 'work', noNetwork: true })).toBe('https://guest--work--x.tabcomputer.com/');
    expect(guestUrl(t, {})).toMatch(/^https:\/\/guest--[a-z0-9]{10}--t\.tabcomputer\.com\/$/);
    expect(guestUrl(t, { noNetwork: true }, 'https://tabcomputer.com/?guest&nonet&run=abc#x'))
      .toMatch(/^https:\/\/guest--[a-z0-9]{10}--tx\.tabcomputer\.com\/\?run=abc#x$/);
    expect(guestUrl('http://{guest}.app.localhost:5299', { name: 'seedabcd' }, 'http://app.localhost:5299/s/abcd'))
      .toBe('http://guest--seedabcd.app.localhost:5299/s/abcd');
  });
  it('knows the addresses that import or run code', () => {
    expect(inboundCodeLink('/s/abcd1234')).toEqual({ kind: 'seed', id: 'abcd1234' });
    expect(inboundCodeLink('/someone/repo')).toEqual({ kind: 'repo', user: 'someone', repo: 'repo' });
    for (const p of ['/', '/about', '/api/seed', '/guest/config.json', '/assets/x.js', '/a/b/c']) expect(inboundCodeLink(p), p).toBeNull();
  });
});

describe('the statement of the boundary', () => {
  const host = 'guest--abc.tabcomputer.com';
  const text = (g: Parameters<typeof boundaryStatement>[0], enforced: boolean) => boundaryStatement(g, { host, enforced }).lines.join('\n');
  it('names the origin and what cannot be read', () => {
    const st = boundaryStatement(parseGuestLabel('guest--abc')!, { host, enforced: true });
    expect(st.title).toBe('Guest');
    expect(st.lines[0]).toContain(host);
    expect(st.lines[0]).toContain('~/.claude');
    expect(st.lines.join('\n')).toContain('Anything you sign in to');
    expect(st.lines.join('\n')).toContain('It has internet access');
    expect(st.lines.join('\n')).toContain('Kept in this browser under the name "abc"');
  });
  it('claims no network only as far as it is enforced', () => {
    const g = parseGuestLabel('guest--abc--tx')!;
    expect(boundaryStatement(g, { host, enforced: true }).title).toBe('Guest, no network');
    expect(text(g, true)).toContain('the browser blocks requests to other sites');
    // never that nothing can leave
    expect(text(g, true)).toContain('can still send the tab to another address');
    expect(text(g, false)).toContain('this server does not enforce it');
    expect(text(g, false)).not.toContain('the browser blocks');
    expect(text(g, true)).toContain('Thrown away');
    expect(text(parseGuestLabel('guest--abc--x')!, true)).not.toContain('It has internet access');
  });
});

describe('in the page', () => {
  it('a main profile is not a guest, and its storage is never wiped', async () => {
    setGuestHostForTests('tabcomputer.com');
    expect(guestInfo()).toBeNull();
    await expect(wipeGuestStorage()).rejects.toThrow(/not a guest/);
  });
  it('a no-network guest has no relay', () => {
    const loc = { protocol: 'https:', host: 'guest--abc--x.tabcomputer.com' };
    setGuestHostForTests('guest--abc.tabcomputer.com');
    expect(relayNetConfig(loc).relayUrl).toBe('wss://guest--abc--x.tabcomputer.com/tcp');
    setGuestHostForTests('guest--abc--x.tabcomputer.com');
    expect(relayNetConfig(loc)).toEqual({ relayUrl: null, tokenUrl: null, credentials: false });
  });
  it('sees a guest among the frames above', () => {
    expect(framedByGuest({ ancestorOrigins: ['https://guest--abc.tabcomputer.com'] })).toBe(true);
    expect(framedByGuest({ ancestorOrigins: ['https://tabcomputer.com', 'https://guest--abc--tx.tabcomputer.com'] })).toBe(true);
    expect(framedByGuest({ ancestorOrigins: ['https://music.tabcomputer.com'] })).toBe(false);
    expect(framedByGuest({})).toBe(false);
  });
  it('a browse document never takes a guest for its app', () => {
    const pats = ['https://tabcomputer.com', 'https://*.tabcomputer.com'];
    const loc = (anc: string[]) => ({ ancestorOrigins: anc }) as unknown as Location;
    expect(parentAppOrigin(pats, loc(['https://music.tabcomputer.com']))).toBe('https://music.tabcomputer.com');
    expect(parentAppOrigin(pats, loc(['https://guest--abc.tabcomputer.com']))).toBeNull();
    expect(parentAppOrigin(pats, loc(['https://guest--abc--tx.tabcomputer.com']))).toBeNull();
  });
  it('takes an older server\'s answer (the app shell) for "no guests"', async () => {
    expect(await guestConfig((async () => new Response('<!doctype html>', { status: 200 })) as typeof fetch)).toEqual({ origin: null });
    resetGuestConfigForTests();
    expect(await guestConfig((async () => new Response('{"origin":"https://{guest}.x.test"}')) as typeof fetch)).toEqual({ origin: 'https://{guest}.x.test' });
  });
  it('the guest command says what this window is', async () => {
    const run = async (args: string[]) => {
      const ctx = { args, stdout: '', stderr: '', env: {}, fs: null } as any;
      const code = await guestCmd.exec(ctx);
      return { code, out: ctx.stdout as string, err: ctx.stderr as string };
    };
    setGuestHostForTests('tabcomputer.com');
    await guestConfig((async () => new Response('{"origin":"https://{guest}.tabcomputer.com"}')) as typeof fetch);
    expect((await run([])).out).toContain('This is not a guest');
    expect((await run(['url', '--keep', 'Work', '--no-network'])).out).toBe('https://guest--work--x.tabcomputer.com/\n');
    expect((await run(['discard', '--yes'])).code).toBe(1);
    expect((await run(['bogus'])).code).toBe(2);
  });
});

// ── server.mjs ──

const serverPath = path.resolve(__dirname, '../../../server.mjs');

interface Reply { status: number; headers: Record<string, string>; body: string }
async function start(env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'guest-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title><body>APP SHELL</body>');
  writeFileSync(path.join(dir, 'app.js'), '// app');
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, TABCOMPUTER_GUESTS: '', TABCOMPUTER_GUEST_ORIGIN: '', TABCOMPUTER_TCP_RELAY: '', ...env, PORT: '0', STATIC_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    proc.once('exit', (code: number) => reject(new Error(`server exited (${code})`)));
    proc.stdout.on('data', (d: Buffer) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
  });
  const req = (p: string, host: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method: opts.method ?? 'GET', headers: { host, ...opts.headers } }, (res: any) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      r.on('error', reject);
      r.end();
    });
  /** The status line a WebSocket upgrade gets */
  const upgrade = (p: string, host: string, origin: string): Promise<number> => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: { host, origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    r.on('response', (res: any) => { res.resume(); resolve(res.statusCode); });
    r.on('upgrade', (_res: any, socket: any) => { socket.destroy(); resolve(101); });
    r.on('error', reject);
    r.end();
  });
  return { proc, port, req, upgrade };
}

describe('server.mjs and guest hosts', () => {
  let on: Awaited<ReturnType<typeof start>>;
  let off: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => { [on, off] = await Promise.all([start({ TABCOMPUTER_GUESTS: '1' }), start({})]); }, 30000);
  afterAll(() => { on?.proc.kill(); off?.proc.kill(); });
  const json = (r: Reply) => JSON.parse(r.body);

  it('is inert on the brand domain until TABCOMPUTER_GUESTS=1', async () => {
    expect(json(await off.req('/guest/config.json', 'tabcomputer.com'))).toEqual({ origin: null });
    const r = await off.req('/', 'guest--abc--x.tabcomputer.com');
    expect(r.body).toContain('APP SHELL');
    expect(r.headers['content-security-policy']).toBeUndefined();
    // and its routes answer as for any host (404: no such API target, not a guest refusal)
    expect((await off.req('/api/nothing/x', 'guest--abc--x.tabcomputer.com')).status).toBe(404);
  });
  it('has guests on localhost without it, under the host asked', async () => {
    expect(json(await off.req('/guest/config.json', `localhost:${off.port}`))).toEqual({ origin: `http://{guest}.localhost:${off.port}` });
    expect(json(await off.req('/guest/config.json', `app.localhost:${off.port}`))).toEqual({ origin: `http://{guest}.app.localhost:${off.port}` });
  });
  it('tells an app host the template and a guest host what it is', async () => {
    expect(json(await on.req('/guest/config.json', 'tabcomputer.com'))).toEqual({ origin: 'https://{guest}.tabcomputer.com' });
    expect(json(await on.req('/guest/config.json', 'music.tabcomputer.com'))).toEqual({ origin: 'https://{guest}.tabcomputer.com' });
    expect(json(await on.req('/guest/config.json', 'guest--abc--tx.tabcomputer.com'))).toEqual({
      origin: 'https://{guest}.tabcomputer.com', guest: { name: 'abc', ephemeral: true, noNetwork: true }, enforced: true,
    });
    expect(json(await on.req('/guest/config.json', `guest--abc.app.localhost:${on.port}`))).toEqual({
      origin: `http://{guest}.app.localhost:${on.port}`, guest: { name: 'abc', ephemeral: false, noNetwork: false }, enforced: true,
    });
  });
  it('agrees with the page about which labels are guests', async () => {
    for (const l of ['guest--abc', 'guest--abc--t', 'guest--abc--x', 'guest--abc--tx', 'guest--abc--xt', 'guest-abc', 'guest--a-b', 'music', 'guest--abc--q']) {
      const cfg = json(await on.req('/guest/config.json', `${l}.tabcomputer.com`));
      const page = parseGuestLabel(l);
      expect(cfg.guest ?? null, l).toEqual(page ? { name: page.name, ephemeral: page.ephemeral, noNetwork: page.noNetwork } : null);
    }
  });
  it('serves a guest the app, cross-origin isolated, and not as a browse host', async () => {
    for (const host of ['guest--abc.tabcomputer.com', `guest--abc.localhost:${on.port}`]) {
      const r = await on.req('/', host);
      expect(r.body).toContain('APP SHELL');
      expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(r.headers['cross-origin-embedder-policy']).toBe('credentialless');
      expect(r.headers['origin-agent-cluster']).toBe('?1');
      expect(r.headers['content-security-policy']).toBeUndefined();
    }
    expect((await on.req('/', 'tabcomputer.com')).headers['origin-agent-cluster']).toBeUndefined();
  });
  it('turns the Browser app off in a guest', async () => {
    expect(json(await on.req('/browse/config.json', 'guest--abc.tabcomputer.com'))).toEqual({ origin: null });
    expect(json(await on.req('/browse/config.json', 'tabcomputer.com')).origin).toBe('https://{key}.web.tabcomputer.com');
  });
  it('refuses the device flow to a guest, by host and by origin', async () => {
    const post = { method: 'POST' };
    const a = await on.req('/api/github-login/login/device/code', 'guest--abc.tabcomputer.com', post);
    expect([a.status, json(a)]).toEqual([403, { error: 'guest', reason: 'sign-in is not offered to a guest' }]);
    const b = await on.req('/api/github-login/login/device/code', 'tabcomputer.com', { method: 'POST', headers: { origin: 'https://guest--abc.tabcomputer.com' } });
    expect(b.status).toBe(403);
    // a guest with network still has the other routes (404: no such target, so nothing is fetched here)
    expect((await on.req('/api/nothing/x', 'guest--abc.tabcomputer.com')).status).toBe(404);
  });
  it('sends a no-network guest the CSP on pages and scripts', async () => {
    for (const p of ['/', '/app.js', '/guest/config.json']) {
      const csp = (await on.req(p, 'guest--abc--x.tabcomputer.com')).headers['content-security-policy'];
      expect(csp, p).toContain("connect-src 'self' blob: data:");
      expect(csp).toContain("default-src 'self' blob: data:");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toMatch(/https?:|\*/);
    }
    expect((await on.req('/app.js', 'guest--abc--x.tabcomputer.com')).body).toBe('// app');
  });
  it('refuses a no-network guest every route that reaches out, by host and by origin', async () => {
    const host = 'guest--abc--tx.tabcomputer.com';
    for (const p of ['/api/anthropic/v1/messages', '/api/github/user', '/api/seed/abcd', '/api/ws-proxy', '/tcp/token', '/git-proxy/github.com/a/b', '/offer/x', '/answer/x', '/relay/' + 'a'.repeat(32) + '/recv', '/oauth/callback', '/browse/fetch']) {
      const r = await on.req(p, host);
      expect([p, r.status, json(r).reason]).toEqual([p, 403, 'this guest has no network']);
      const viaOrigin = await on.req(p, 'tabcomputer.com', { headers: { origin: `https://${host}` } });
      expect([p, viaOrigin.status]).toEqual([p, 403]);
    }
    expect((await on.req('/', host, { method: 'POST' })).status).toBe(403);
    expect((await on.req('/api/seed', host, { method: 'POST' })).status).toBe(403);
    // the main profile and a guest with network are not refused
    expect((await on.req('/api/nothing/x', 'tabcomputer.com')).status).toBe(404);
    expect((await on.req('/api/nothing/x', 'tabcomputer.com', { headers: { origin: 'https://guest--abc.tabcomputer.com' } })).status).toBe(404);
  });
  it('refuses a no-network guest every WebSocket', async () => {
    const host = 'guest--abc--x.tabcomputer.com';
    expect(await on.upgrade('/channel/abcd', host, `https://${host}`)).toBe(403);
    expect(await on.upgrade('/api/ws-proxy', host, `https://${host}`)).toBe(403);
    expect(await on.upgrade('/channel/abcd', 'tabcomputer.com', `https://${host}`)).toBe(403);
    expect(await on.upgrade('/channel/abcd', 'tabcomputer.com', 'https://tabcomputer.com')).toBe(101);
    expect(await on.upgrade('/channel/abcd', 'guest--abc.tabcomputer.com', 'https://guest--abc.tabcomputer.com')).toBe(101);
  });
  it('does not serve the main profile into a frame of a same-site page', async () => {
    const frame = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' };
    expect((await on.req('/', 'tabcomputer.com', { headers: frame })).status).toBe(403);
    expect((await on.req('/s/abcd', 'tabcomputer.com', { headers: frame })).status).toBe(403);
    // its own pages' frames, other sites' frames (partitioned storage) and plain loads are served
    expect((await on.req('/', 'tabcomputer.com', { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await on.req('/', 'tabcomputer.com', { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
    expect((await on.req('/', 'tabcomputer.com', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-site' } })).status).toBe(200);
    expect((await on.req('/app.js', 'tabcomputer.com', { headers: frame })).status).toBe(200);
    // without guests nothing changes
    expect((await off.req('/', 'tabcomputer.com', { headers: frame })).status).toBe(200);
  });
  it('takes a separate guest domain from TABCOMPUTER_GUEST_ORIGIN', async () => {
    const s = await start({ TABCOMPUTER_GUEST_ORIGIN: 'https://{guest}.tabguests.example' });
    try {
      expect(json(await s.req('/guest/config.json', 'tabcomputer.com'))).toEqual({ origin: 'https://{guest}.tabguests.example' });
      expect(json(await s.req('/guest/config.json', 'guest--abc--x.tabguests.example')).guest).toEqual({ name: 'abc', ephemeral: false, noNetwork: true });
      expect(json(await s.req('/guest/config.json', 'guest--abc--x.tabcomputer.com')).guest).toBeUndefined();
      expect((await s.req('/tcp/token', 'tabcomputer.com', { method: 'POST', headers: { origin: 'https://guest--abc--x.tabguests.example' } })).status).toBe(403);
    } finally { s.proc.kill(); }
  }, 20000);
});
