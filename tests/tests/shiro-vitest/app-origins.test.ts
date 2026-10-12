/**
 * App origins (server.mjs "Apps: app origins", docs/APPS.md "The page's
 * origin"): an app host serves the frame, the service worker and tab.js, and
 * nothing of tabcomputer; who may frame it; and that the page's label for an
 * app is one the server takes for an app host and for nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { appOriginLabel, appsConfig, setAppsConfigForTests } from '@shiro/apps/frame';
import { decodeOriginKey } from '@shiro/browser/origin-map';
import { parseGuestLabel } from '@shiro/guest';

// (node's own modules: the test config stands browser versions in for an `import`)
const nodeRequire = createRequire(import.meta.url);
const { spawn } = nodeRequire('node:child_process');
const http = nodeRequire('node:http');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = nodeRequire('node:fs');
const { tmpdir } = nodeRequire('node:os');
const path = nodeRequire('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const serverPath = path.join(ROOT, 'server.mjs');

interface Reply { status: number; headers: Record<string, string>; body: string }
async function start(env: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-origin-static-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title><body>APP SHELL</body>');
  mkdirSync(path.join(dir, 'apphost'));
  for (const f of ['frame.js', 'sw.js', 'tab.js']) writeFileSync(path.join(dir, 'apphost', f), readFileSync(path.join(ROOT, 'public/apphost', f)));
  writeFileSync(path.join(dir, 'apphost', 'secret.js'), '// not served');
  mkdirSync(path.join(dir, 'browse'));
  writeFileSync(path.join(dir, 'browse', 'boot.js'), '// browse boot');
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, TABCOMPUTER_GUESTS: '', TABCOMPUTER_GUEST_ORIGIN: '', TABCOMPUTER_TCP_RELAY: '', TABCOMPUTER_BROWSE: '', TABCOMPUTER_BROWSE_ORIGIN: '', TABCOMPUTER_BROWSE_APP_ORIGINS: '', ...env, PORT: '0', STATIC_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const upgrade = (p: string, host: string): Promise<number> => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    r.on('response', (res: any) => { res.resume(); resolve(res.statusCode); });
    r.on('upgrade', (_res: any, socket: any) => { socket.destroy(); resolve(101); });
    r.on('error', reject);
    r.end();
  });
  return { proc, port, req, upgrade };
}

describe('server.mjs and app hosts', () => {
  let on: Awaited<ReturnType<typeof start>>;
  let off: Awaited<ReturnType<typeof start>>;
  const LABEL = 'app--converter--0123456789abcdef';
  beforeAll(async () => { [on, off] = await Promise.all([start({}), start({ TABCOMPUTER_BROWSE: '0' })]); }, 30000);
  afterAll(() => { on?.proc.kill(); off?.proc.kill(); });
  const json = (r: Reply) => JSON.parse(r.body);

  it('tells the page where app pages live: the browse zone, or nowhere', async () => {
    expect(json(await on.req('/apps/config.json', `localhost:${on.port}`))).toEqual({ origin: `http://{app}.localhost:${on.port}` });
    expect(json(await on.req('/apps/config.json', `app.localhost:${on.port}`))).toEqual({ origin: `http://{app}.localhost:${on.port}` });
    expect(json(await on.req('/apps/config.json', 'tabcomputer.com'))).toEqual({ origin: 'https://{app}.web.tabcomputer.com' });
    expect(json(await on.req('/apps/config.json', 'music.tabcomputer.com'))).toEqual({ origin: 'https://{app}.web.tabcomputer.com' });
    expect(json(await on.req('/apps/config.json', 'example.org'))).toEqual({ origin: null });
    expect(json(await off.req('/apps/config.json', `localhost:${off.port}`))).toEqual({ origin: null });
    // a guest has them; a guest without network does not (its policy allows no frame of another origin)
    expect(json(await on.req('/apps/config.json', `guest--abc.localhost:${on.port}`))).toEqual({ origin: `http://{app}.localhost:${on.port}` });
    expect(json(await on.req('/apps/config.json', `guest--abc--x.localhost:${on.port}`))).toEqual({ origin: null });
  });

  it('an app host serves the frame, the worker and tab.js, isolated and framable only by the tab', async () => {
    for (const host of [`${LABEL}.localhost:${on.port}`, `${LABEL}.web.tabcomputer.com`]) {
      const frame = await on.req('/__tabcomputer/frame.html?n=abc', host);
      expect(frame.status, host).toBe(200);
      expect(frame.body).toContain('<script src="/__tabcomputer/frame.js"');
      expect(frame.body).not.toContain('APP SHELL');
      expect(frame.headers['cross-origin-embedder-policy']).toBe('credentialless');
      expect(frame.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(frame.headers['origin-agent-cluster']).toBe('?1');
      expect(frame.headers['cache-control']).toBe('no-store');
      const csp = frame.headers['content-security-policy'];
      expect(csp).toContain("default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ");
      const sw = await on.req('/__tabcomputer/sw.js', host);
      expect(sw.status).toBe(200);
      expect(sw.headers['service-worker-allowed']).toBe('/');
      expect(sw.headers['content-type']).toMatch(/javascript/);
      expect(sw.body).toContain('tc-fetch');
      expect((await on.req('/__tabcomputer/tab.js', host)).body).toContain('globalThis.tab');
      expect((await on.req('/__tabcomputer/frame.js', host)).status).toBe(200);
    }
    const local = (await on.req('/__tabcomputer/frame.html', `${LABEL}.localhost:${on.port}`));
    expect(local.headers['content-security-policy']).toContain(`frame-ancestors http://localhost:${on.port} http://*.localhost:${on.port}`);
    expect(local.body).toContain(`data-apps="http://localhost:${on.port} http://*.localhost:${on.port}" data-zone="localhost:${on.port}"`);
    const prod = (await on.req('/__tabcomputer/frame.html', `${LABEL}.web.tabcomputer.com`));
    expect(prod.headers['content-security-policy']).toContain('frame-ancestors https://tabcomputer.com https://*.tabcomputer.com');
    expect(prod.body).toContain('data-zone="web.tabcomputer.com"');
  });

  it('an app host serves nothing of tabcomputer: no app shell, no API, no relay, no other file', async () => {
    const host = `${LABEL}.localhost:${on.port}`;
    for (const p of ['/', '/index.html', '/app.js', '/apps/config.json', '/guest/config.json', '/browse/config.json', '/api/anthropic/v1/messages', '/git-proxy/github.com/x/y', '/recipes/index.json', '/s/abcd', '/oauth/callback', '/apphost/tab.js']) {
      const r = await on.req(p, host);
      expect(r.status, p).toBe(503);
      expect(r.body, p).not.toContain('APP SHELL');
      expect(r.headers['content-type'], p).toMatch(/text\/plain/);
    }
    for (const p of ['/__tabcomputer/secret.js', '/__tabcomputer/../index.html', '/__tabcomputer/', '/__tabcomputer/boot.js', '/__tabcomputer/%2e%2e/app.js']) {
      const r = await on.req(p, host);
      expect([404, 503], p).toContain(r.status);
      expect(r.body, p).not.toContain('APP SHELL');
      expect(r.body, p).not.toContain('not served');
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await on.req('/api/x', host, { method })).status, method).toBe(405);
    expect(await on.upgrade('/tcp', host)).toBe(404);
    expect(await on.upgrade('/channel/abc', host)).toBe(404);
  });

  it('only an app label is an app host; browse hosts and guests stay what they were', async () => {
    const p = on.port;
    // not app labels: a browse host's bootstrap, a guest's app shell, or the app itself
    for (const [label, what] of [
      ['app--converter', 'shell'], ['app--converter--0123', 'shell'], ['app--Converter--0123456789abcdef', 'app'], ['app--con-verter--0123456789abcdef', 'browse'],
      ['example-com', 'browse'], ['guest--abc', 'shell'], ['app', 'shell'], [`x.${LABEL}`, 'shell'],
    ] as const) {
      const r = await on.req('/', `${label}.localhost:${p}`);
      if (what === 'app') expect(r.status, label).toBe(503);
      else if (what === 'browse') expect(r.body, label).toContain('/__tc/boot.js');
      else expect(r.status === 200 && (r.body.includes('APP SHELL') || r.body.includes('/__tc/boot.js')), label).toBe(true);
    }
    // an app label is never a browse key
    expect((await on.req('/', `${LABEL}.localhost:${p}`)).body).not.toContain('/__tc/boot.js');
    expect((await on.req('/__tc/boot.js', `${LABEL}.localhost:${p}`)).status).toBe(503);
    // without browse origins there are no app hosts: the name is an ordinary host
    expect((await off.req('/', `${LABEL}.localhost:${off.port}`)).body).toContain('APP SHELL');
  });

  it('the label the page makes is one the server takes, and neither a browse key nor a guest', async () => {
    for (const [id, source, host] of [['converter', 'site', 'tabcomputer.com'], ['my-app-2', 'gh:o/r@abc', 'localhost:5299'], ['a'.repeat(32), 'dir:/x', 'guest--x.tabcomputer.com'], ['a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p', 'dev:/y', 'h']] as const) {
      const label = await appOriginLabel(id, source, host);
      expect((await on.req('/', `${label}.localhost:${on.port}`)).status, label).toBe(503);
      expect((await on.req('/__tabcomputer/frame.html', `${label}.web.tabcomputer.com`)).status, label).toBe(200);
      expect(decodeOriginKey(label), label).toBeNull();
      expect(parseGuestLabel(label), label).toBeNull();
      expect(label.length).toBeLessThanOrEqual(63);
    }
  });

  it('the page reads the server\'s answer strictly', async () => {
    const answer = (body: string, type = 'application/json') => (async () => new Response(body, { status: 200, headers: { 'content-type': type } })) as unknown as typeof fetch;
    setAppsConfigForTests(null);
    expect(await appsConfig(answer('{"origin":"https://{app}.web.tabcomputer.com"}'))).toEqual({ origin: 'https://{app}.web.tabcomputer.com' });
    for (const [body, type] of [
      ['<!doctype html><title>app shell</title>', 'text/html'], ['{"origin":null}', 'application/json'], ['{"origin":"https://evil.example"}', 'application/json'],
      ['{"origin":"javascript:alert(1)//{app}.x"}', 'application/json'], ['{"origin":"https://{app}.x.com/path"}', 'application/json'], ['not json', 'application/json'],
    ]) {
      setAppsConfigForTests(null);
      expect(await appsConfig(answer(body, type)), body).toEqual({ origin: null });
    }
    setAppsConfigForTests(null);
    expect(await appsConfig((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toEqual({ origin: null });
    setAppsConfigForTests(null);
  });
});
