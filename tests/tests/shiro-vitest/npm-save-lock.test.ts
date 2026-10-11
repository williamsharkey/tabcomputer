/**
 * tabcomputer#59: `npm install <name>` saved "*" and wrote no package-lock.json.
 * Now it saves npm's range (`^<installed version>`) and writes a lockfile
 * (lockfileVersion 3). Against a fake registry: no network.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell, run } from './helpers';
import { saveSpec, integrityOf, isRange } from '@shiro/commands/npm-lock';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

describe('the range npm saves', () => {
  it('^<installed> for a bare name, a tag, a version or a range it fits in; the range itself otherwise', () => {
    expect(saveSpec('', '1.1.1')).toBe('^1.1.1'); // npm install picocolors
    expect(saveSpec('*', '3.0.0')).toBe('^3.0.0');
    expect(saveSpec('next', '2.0.0-rc.1')).toBe('^2.0.0-rc.1'); // a dist-tag
    expect(saveSpec('7.0.0', '7.0.0')).toBe('^7.0.0'); // an exact version, as npm (save-prefix)
    expect(saveSpec('^2.1.0', '2.1.3')).toBe('^2.1.3'); // ^2.1.3 is inside ^2.1.0
    expect(saveSpec('>=1', '1.4.0')).toBe('^1.4.0');
    expect(saveSpec('~2.1.0', '2.1.3')).toBe('~2.1.0'); // ^2.1.3 would allow 2.2: kept
    expect(saveSpec('1.x <1.2.3', '1.2.2')).toBe('1.x <1.2.3');
    expect(saveSpec('', '1.1.1', { exact: true })).toBe('1.1.1'); // --save-exact
    expect(saveSpec('^0.3.0', '0.3.4')).toBe('^0.3.4');
    expect(isRange('latest')).toBe(false);
    expect(isRange('^1.2')).toBe(true);
  });

  it('integrity: the registry\'s, else sha1 from the shasum', () => {
    expect(integrityOf({ integrity: 'sha512-abc', shasum: 'f'.repeat(40) })).toBe('sha512-abc');
    expect(integrityOf({ shasum: '0123456789abcdef0123456789abcdef01234567' })).toBe('sha1-ASNFZ4mrze8BI0VniavN7wEjRWc=');
    expect(integrityOf({})).toBeUndefined();
  });
});

// ─── A fake registry ──────────────────────────────────────────────

const enc = new TextEncoder();
/** A ustar archive of `files` */
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
async function sha512(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes as BufferSource));
  return 'sha512-' + btoa(String.fromCharCode(...d));
}

/** name → version → its package.json fields (dependencies, bin) */
const PACKAGES: Record<string, Record<string, Record<string, unknown>>> = {
  'tcfix-colors': { '1.0.0': {}, '1.1.1': { dependencies: { 'tcfix-dep': '^2.0.0' } } },
  'tcfix-dep': { '2.0.0': {}, '2.1.0': {} },
  'tcfix-dev': { '1.0.0': { bin: { 'tcfix-dev': 'cli.js' } } },
  'tcfix-exact': { '3.2.1': {} },
};
const tarballs = new Map<string, Uint8Array>();
const documents = new Map<string, unknown>();
let realFetch: typeof fetch;

beforeAll(async () => {
  for (const [name, versions] of Object.entries(PACKAGES)) {
    const doc: any = { name, 'dist-tags': { latest: Object.keys(versions).at(-1) }, versions: {} };
    for (const [version, extra] of Object.entries(versions)) {
      const manifest = { name, version, main: 'index.js', ...extra };
      const tgz = await gzip(tarOf({ 'package/package.json': JSON.stringify(manifest), 'package/index.js': `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`, 'package/cli.js': '' }));
      const url = `https://registry.test/${name}/-/${name}-${version}.tgz`;
      tarballs.set(url, tgz);
      doc.versions[version] = { ...manifest, dist: { tarball: url, integrity: await sha512(tgz), shasum: 'f'.repeat(40) } };
    }
    documents.set(`https://registry.npmjs.org/${name}`, doc);
  }
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (documents.has(url)) return new Response(JSON.stringify(documents.get(url)), { headers: { 'content-type': 'application/json' } });
    if (tarballs.has(url)) return new Response(tarballs.get(url)! as BodyInit);
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe('npm install: package.json and package-lock.json (#59)', () => {
  let shell: Shell;
  let fs: FileSystem;
  const json = async (p: string) => JSON.parse(await fs.readFile(p, 'utf8') as string);

  beforeAll(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.rm('/tmp/npm59', { recursive: true } as any).catch(() => {});
    await fs.mkdir('/tmp/npm59', { recursive: true } as any);
    await fs.writeFile('/tmp/npm59/package.json', JSON.stringify({ name: 'npm59', version: '1.0.0' }, null, 2));
    await run(shell, 'cd /tmp/npm59');
  });

  it('a bare name saves ^<installed version>, and the lockfile pins the tree', async () => {
    const r = await run(shell, 'npm install tcfix-colors');
    expect(r.exitCode, r.output).toBe(0);
    expect((await json('/tmp/npm59/package.json')).dependencies).toEqual({ 'tcfix-colors': '^1.1.1' });
    const lock = await json('/tmp/npm59/package-lock.json');
    expect(lock).toMatchObject({ name: 'npm59', version: '1.0.0', lockfileVersion: 3, requires: true });
    expect(lock.packages['']).toEqual({ name: 'npm59', version: '1.0.0', dependencies: { 'tcfix-colors': '^1.1.1' } });
    const colors = lock.packages['node_modules/tcfix-colors'];
    expect(colors).toEqual({
      version: '1.1.1',
      resolved: 'https://registry.test/tcfix-colors/-/tcfix-colors-1.1.1.tgz',
      integrity: (documents.get('https://registry.npmjs.org/tcfix-colors') as any).versions['1.1.1'].dist.integrity,
      dependencies: { 'tcfix-dep': '^2.0.0' },
    });
    expect(colors.integrity).toMatch(/^sha512-/);
    expect(lock.packages['node_modules/tcfix-dep']).toMatchObject({ version: '2.1.0' });
    expect(lock.packages['node_modules/tcfix-dep'].dev).toBeUndefined();
    // and what the lockfile says is what's installed
    expect((await json('/tmp/npm59/node_modules/tcfix-colors/package.json')).version).toBe('1.1.1');
  });

  it('-D adds a dev entry, keeps the others; -E saves the version alone (and isn\'t taken for a package)', async () => {
    expect((await run(shell, 'npm install -D tcfix-dev@1.0.0')).exitCode).toBe(0);
    expect((await run(shell, 'npm install -E tcfix-exact')).exitCode).toBe(0);
    const pkg = await json('/tmp/npm59/package.json');
    expect(pkg.devDependencies).toEqual({ 'tcfix-dev': '^1.0.0' }); // an exact version saves with the prefix, as npm
    expect(pkg.dependencies).toEqual({ 'tcfix-colors': '^1.1.1', 'tcfix-exact': '3.2.1' });
    const lock = await json('/tmp/npm59/package-lock.json');
    expect(Object.keys(lock.packages)).toEqual(['', 'node_modules/tcfix-colors', 'node_modules/tcfix-dep', 'node_modules/tcfix-dev', 'node_modules/tcfix-exact']);
    expect(lock.packages['node_modules/tcfix-dev']).toMatchObject({ version: '1.0.0', dev: true, bin: { 'tcfix-dev': 'cli.js' } });
    expect(lock.packages['node_modules/tcfix-colors'].version).toBe('1.1.1'); // kept from the first install
    expect(lock.packages['']).toEqual({ name: 'npm59', version: '1.0.0', dependencies: pkg.dependencies, devDependencies: pkg.devDependencies });
  });

  it('npm uninstall takes the package out of both files', async () => {
    expect((await run(shell, 'npm uninstall tcfix-dev')).exitCode).toBe(0);
    const lock = await json('/tmp/npm59/package-lock.json');
    expect(lock.packages['node_modules/tcfix-dev']).toBeUndefined();
    expect(lock.packages[''].devDependencies).toBeUndefined();
    expect(lock.packages['node_modules/tcfix-colors']).toBeDefined();
  });

  it('npm install with no arguments writes the whole tree, dev entries marked', async () => {
    await fs.rm('/tmp/npm59/package-lock.json').catch(() => {});
    await run(shell, 'npm install -D tcfix-dev');
    await fs.rm('/tmp/npm59/package-lock.json').catch(() => {});
    expect((await run(shell, 'npm install')).exitCode).toBe(0);
    const lock = await json('/tmp/npm59/package-lock.json');
    expect(Object.keys(lock.packages).sort()).toEqual(['', 'node_modules/tcfix-colors', 'node_modules/tcfix-dep', 'node_modules/tcfix-dev', 'node_modules/tcfix-exact']);
    expect(lock.packages['node_modules/tcfix-dev'].dev).toBe(true);
    expect(lock.packages['node_modules/tcfix-dep'].dev).toBeUndefined();
  });
});
