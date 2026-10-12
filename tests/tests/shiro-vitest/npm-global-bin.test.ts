/**
 * tabcomputer#110: after `npm install -g PKG`, `which CMD` printed nothing
 * while `type CMD` named /usr/local/bin/CMD. The bin's file had no x bit,
 * and Debian's `which` (as bash, dash and execvp) asks for it. npm marks a
 * bin's file executable. Against a fake registry: no network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell } from './helpers';

const haveRootfs = existsSync(resolve(__dirname, '../../../public/debian/rootfs.json'));

const enc = new TextEncoder();
/** A ustar archive of `files`, each mode 0644 as npm tarballs have them */
function tarOf(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(enc.encode(s), off);
    put(name, 0); put('0000644\0', 100); put('0000000\0', 108); put('0000000\0', 116);
    put(data.length.toString(8).padStart(11, '0') + '\0', 124); put('00000000000\0', 136);
    put('        ', 148); put('0', 156); put('ustar\0', 257); put('00', 263);
    put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

const NAME = '@tcfix/agent';
const TARBALL = 'https://registry.test/@tcfix/agent/-/agent-1.0.0.tgz';
let tgz: Uint8Array;
let realFetch: typeof fetch;

beforeAll(async () => {
  const manifest = { name: NAME, version: '1.0.0', bin: { tcagent: 'bin/tcagent.js' } };
  tgz = await gzip(tarOf({ 'package/package.json': JSON.stringify(manifest), 'package/bin/tcagent.js': '#!/usr/bin/env node\nconsole.log("tcagent here");\n' }));
  const doc = { name: NAME, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { ...manifest, dist: { tarball: TARBALL, shasum: 'f'.repeat(40) } } } };
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://registry.npmjs.org/${NAME}` || url === `https://registry.npmjs.org/${NAME.replace('/', '%2f')}` || url === `https://registry.npmjs.org/${NAME.replace('/', '%2F')}`) {
      return new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } });
    }
    if (url === TARBALL) return new Response(tgz as BodyInit);
    if (/^https:\/\/registry\./.test(url)) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return realFetch(input as RequestInfo, init); // (the Debian rootfs comes from public/debian)
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe('npm install -g: the command is found by which (#110)', () => {
  const sh = async (shell: any, cmd: string) => {
    let out = '', err = '';
    const code = await shell.execute(cmd, (s: string) => { out += s; }, (s: string) => { err += s; });
    return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
  };

  it('marks the bin file executable; which agrees with type and command -v, and is 1 with no output for a missing name', async () => {
    const { shell, fs } = await createTestShell();
    const r = await sh(shell, `npm install -g ${NAME}`);
    expect(r.code, r.out + r.err).toBe(0);
    expect(await fs.readlink('/usr/local/bin/tcagent')).toBe('/usr/local/lib/node_modules/@tcfix/agent/bin/tcagent.js');
    expect((await fs.stat('/usr/local/bin/tcagent')).mode & 0o111).toBe(0o111);
    expect(await sh(shell, 'which tcagent')).toMatchObject({ code: 0, out: '/usr/local/bin/tcagent\n' });
    expect((await sh(shell, 'type tcagent')).out).toBe('tcagent is /usr/local/bin/tcagent\n');
    expect((await sh(shell, 'command -v tcagent')).out).toBe('/usr/local/bin/tcagent\n');
    expect((await sh(shell, 'test -x /usr/local/bin/tcagent && echo x')).out).toBe('x\n');
    expect(await sh(shell, 'which tc-no-such-command')).toMatchObject({ code: 1, out: '' });
    // a script's `if which X` test
    expect((await sh(shell, 'if which tcagent >/dev/null; then echo found; else echo missing; fi')).out).toBe('found\n');
    expect((await sh(shell, 'if which tc-no-such-command >/dev/null 2>&1; then echo found; else echo missing; fi')).out).toBe('missing\n');
  }, 60_000);

  it.skipIf(!haveRootfs)("Debian's which (a /bin/sh script asking -f and -x) finds it too", async () => {
    const { shell, fs } = await createTestShell();
    expect((await sh(shell, 'debian install')).code).toBe(0);
    expect(await fs.readlink('/usr/bin/which')).toBe('/etc/alternatives/which');
    const r = await sh(shell, `npm install -g ${NAME}`);
    expect(r.code, r.out + r.err).toBe(0);
    expect((await sh(shell, 'which tcagent; echo "rc=$?"')).out).toBe('/usr/local/bin/tcagent\nrc=0\n');
    expect((await sh(shell, 'type tcagent')).out).toBe('tcagent is /usr/local/bin/tcagent\n');
    expect((await sh(shell, 'which tc-no-such-command; echo "rc=$?"')).out).toBe('rc=1\n');
    // without the x bit Debian's which doesn't see the file: what #110 reported
    await fs.chmod('/usr/local/lib/node_modules/@tcfix/agent/bin/tcagent.js', 0o644);
    expect((await sh(shell, 'which tcagent; echo "rc=$?"')).out).toBe('rc=1\n');
  }, 180_000);
});
