/**
 * Bun.serve, Bun.listen and Bun.connect for claude --vm (src/claude-vm/bun/
 * serve.ts, sockets.ts): Claude Code's artifact/preview servers and
 * reachability probe, its local relays and its direct-dial probe. On the
 * host's Node modules (the shim takes node-compat's in the page; the last
 * test runs there); the expected values are what Bun 1.4.2 did.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as childProcess from 'node:child_process';
import { createBun } from '@shiro/claude-vm/bun/index';
import { createTestShell } from './helpers';

// (the host's own modules, required: the test config maps node:net and node:http imports)
const hostRequire = createRequire(import.meta.url);
const net = hostRequire('net'), http = hostRequire('http');
const Bun: any = createBun({ fs, process, childProcess, net, http, Buffer });
/** (the host's listen is asynchronous; node-compat's binds at once, as Bun's) */
const bound = async (s: { port: number }) => { for (let i = 0; i < 100 && !s.port; i++) await new Promise((r) => setTimeout(r, 5)); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Bun.serve', () => {
  it('fetch(req, server): a Response back, the url, stop() a promise', async () => {
    const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req: Request, srv: any) => new Response(`hi ${new URL(req.url).pathname} ${req.method} ${typeof srv?.requestIP}`, { headers: { 'x-a': '1' } }) });
    await bound(s);
    expect(s.hostname).toBe('127.0.0.1');
    expect(s.url).toBeInstanceOf(URL);
    expect(String(s.url)).toBe(`http://127.0.0.1:${s.port}/`);
    const r = await fetch(new URL('a/b?q=1', s.url));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hi /a/b GET function');
    expect(r.headers.get('x-a')).toBe('1');
    expect(r.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
    // server.fetch: no network, and no server for the handler
    expect(await (await s.fetch(new Request('http://x/y'))).text()).toBe('hi /y GET undefined');
    const stopped = s.stop();
    expect(stopped).toBeInstanceOf(Promise);
    await stopped;
  });

  it('bodies, statuses, error(), a thrown handler is a 500, routes', async () => {
    const s = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: async (req: Request) => { if (req.method === 'PUT') throw new Error('boom'); return new Response((await req.text()) + '!', { status: 201 }); },
      error: () => new Response('E', { status: 500 }),
      routes: { '/fixed': new Response('fixed'), '/u/:id': (req: any) => new Response('user ' + req.params.id), '/m': { POST: () => new Response('posted') } },
    });
    await bound(s);
    const post = await fetch(s.url, { method: 'POST', body: 'data' });
    expect([post.status, await post.text()]).toEqual([201, 'data!']);
    const put = await fetch(s.url, { method: 'PUT', body: 'x' });
    expect([put.status, await put.text()]).toEqual([500, 'E']);
    expect(await (await fetch(new URL('fixed', s.url))).text()).toBe('fixed');
    expect(await (await fetch(new URL('u/42', s.url))).text()).toBe('user 42');
    expect(await (await fetch(new URL('m', s.url), { method: 'POST' })).text()).toBe('posted');
    await s.stop(true);
    const t = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { throw new Error('boom'); } });
    await bound(t);
    expect((await fetch(t.url)).status).toBe(500);
    await t.stop();
  });

  it('needs fetch or routes, as Bun says', () => {
    expect(() => Bun.serve({ port: 0 })).toThrow(/Bun\.serve\(\) needs either/);
  });
});

describe('Bun.listen and Bun.connect', () => {
  it('open, data as a Buffer, write counts, end, close', async () => {
    const log: string[] = [];
    const l = Bun.listen({
      hostname: '127.0.0.1', port: 0, data: { tag: 'L' },
      socket: {
        open(s: any) { log.push(`L open ${JSON.stringify(s.data)} ${s.remoteAddress}`); },
        data(s: any, d: any) { log.push(`L data ${d.constructor.name} ${d}`); log.push(`L wrote ${s.write('echo:' + d)}`); if (String(d) === 'bye') s.end(); },
        close(_s: any, err: any) { log.push(`L close ${err}`); },
      },
    });
    await bound(l);
    expect(l.hostname).toBe('127.0.0.1');
    expect(l.data).toEqual({ tag: 'L' });
    const c = await Bun.connect({
      hostname: '127.0.0.1', port: l.port, data: 7,
      socket: {
        open(s: any) { log.push(`C open ${s.data}`); },
        data(_s: any, d: any) { log.push(`C data ${d}`); },
        end() { log.push('C end'); },
        close(_s: any, err: any) { log.push(`C close ${err}`); },
      },
    });
    expect(c.readyState).toBe(1);
    expect(c.remotePort).toBe(l.port);
    c.write('hello');
    await sleep(50);
    c.write('bye');
    for (let i = 0; i < 100 && !log.includes('C close undefined'); i++) await sleep(10);
    // (the two ends' lines interleave; each end's order is Bun's)
    for (const want of ['C open 7', 'L data Buffer hello', 'L wrote 10', 'C data echo:hello', 'L wrote 8', 'C data echo:bye', 'C end', 'C close undefined']) expect(log).toContain(want);
    expect(log.indexOf('C data echo:hello')).toBeLessThan(log.indexOf('C data echo:bye'));
    expect(log.indexOf('C end')).toBeLessThan(log.indexOf('C close undefined'));
    l.stop(true);
  });

  it('a refused connect: connectError, then the promise rejects with "Failed to connect"', async () => {
    const seen: string[] = [];
    const err = await Bun.connect({ hostname: '127.0.0.1', port: 1, socket: { data() {}, connectError(_s: any, e: any) { seen.push(e.code); } } }).catch((e: any) => e);
    expect(err.message).toBe('Failed to connect');
    expect(err.code).toBe('ECONNREFUSED');
    expect(seen).toEqual(['ECONNREFUSED']);
  });
});

describe('on node-compat (the page)', () => {
  it('a listener and a server have their ports at once; serve answers fetch over loopback', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`node -e "
      (async () => {
        const { createBun } = await require('tabcomputer:claude-vm').load();
        const Bun = createBun({ fs: require('fs'), process, childProcess: require('child_process'), net: require('net'), http: require('http'), Buffer });
        const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(s, d) { s.write('re:' + d); } } });
        console.log('listen', l.port > 0);
        const got = [];
        const c = await Bun.connect({ hostname: '127.0.0.1', port: l.port, socket: { data(s, d) { got.push(String(d)); } } });
        c.write('x');
        for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
        console.log('echo', got.join());
        c.end(); l.stop(true);
        const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reachable') });
        console.log('serve', s.port > 0);
        const r = await new Promise((res) => require('http').get(s.url.href, (m) => { let b = ''; m.on('data', (d) => b += d); m.on('end', () => res(m.statusCode + ' ' + b)); }));
        console.log('get', r);
        await s.stop(true);
      })();
    "`, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('listen true\necho re:x\nserve true\nget 200 reachable\n');
  }, 30_000);
});
