/**
 * Package layers, the server's side (docs/DEBIAN.md "Package layers"):
 * server.mjs's `/debian/layers/set` in package-layers-harness.mjs with a
 * stand-in for the builder (the real one, scripts/debian/build-set.sh, needs
 * root and a Linux chroot), and the builder's helpers that run anywhere: the
 * key, the limits on what a set installs, and the disk cap.
 * The tab's side is package-sets.test.ts; a real layer in a browser is
 * tests/browser/package-layers.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const HARNESS = resolve(__dirname, 'package-layers-harness.mjs');
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The route on a port of its own, over a made-up Debian base `base1` at snapshot `S1` */
async function harness(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-layers-'));
  mkdirSync(join(dir, 'static/debian'), { recursive: true });
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'static/debian/rootfs.json'), JSON.stringify({ id: 'base1', snapshot: 'S1' }));
  const p = spawn('node', [HARNESS], { env: { ...process.env, DIR: join(dir, 'layers'), WORK: join(dir, 'work'), ROOTFS: join(dir, 'static'), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  const port = await new Promise<number>((ok, fail) => {
    p.stdout!.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); });
    p.on('exit', () => fail(new Error('the harness exited')));
  });
  const get = async (path: string, from = '10.0.0.1') => (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'x-forwarded-for': from } })).json() as Promise<any>;
  const set = (packages: string, more = '', from?: string) => get(`/debian/layers/set?base=base1&packages=${encodeURIComponent(packages)}${more}`, from);
  /** Ask until the set is no longer queued or building */
  const settled = async (packages: string, from?: string) => {
    for (let i = 0; i < 400; i++) {
      const a = await set(packages, '', from);
      if (a.state !== 'queued' && a.state !== 'building') return a;
      await sleep(25);
    }
    throw new Error(`${packages}: still building`);
  };
  /** Ask until `want` holds */
  const until = async (packages: string, want: (a: any) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const a = await set(packages);
      if (want(a)) return a;
      await sleep(10);
    }
    throw new Error(`${packages}: never got there`);
  };
  return { dir, sets: join(dir, 'layers/sets'), port, get, set, settled, until, spawned: () => get('/__spawned') as Promise<{ file: string; args: string[]; env: Record<string, string> }[]> };
}
afterAll(() => { for (const p of procs) p.kill(); });

/** `code` (an expression over the module `m`) in plain Node: vitest's polyfilled modules can't load server.mjs or the builder's scripts */
const inModule = (file: string, code: string): any => JSON.parse(execFileSync('node', ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(new URL(`../../../${file}`, import.meta.url).href)}); console.log('\\n' + JSON.stringify(await (${code}))); process.exit(0);`],
{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()!);
const inServer = (code: string): any => inModule('server.mjs', code);

describe('a set\'s key and names', () => {
  it('the key is the base, the snapshot and the sorted names, and the builder\'s copy agrees', () => {
    const k = inServer(`[
      m.packageSetKey('base1', 'S1', ['qpdf', 'ghostscript']), m.packageSetKey('base1', 'S1', ['ghostscript', 'qpdf']),
      m.packageSetKey('base2', 'S1', ['ghostscript', 'qpdf']), m.packageSetKey('base1', 'S2', ['ghostscript', 'qpdf']),
      m.packageSetKey('base1', 'S1', ['ghostscript']),
    ]`) as string[];
    expect(k[0]).toMatch(/^p-[0-9a-f]{24}$/);
    expect(k[1]).toBe(k[0]);
    expect(new Set(k).size).toBe(4);
    // scripts/debian/set-key.mjs (release.sh's builds) for the base this repository ships
    const base = JSON.parse(readFileSync(join(ROOT, 'public/debian/rootfs.json'), 'utf8'));
    const theirs = execFileSync('node', [join(ROOT, 'scripts/debian/set-key.mjs'), 'key', join(ROOT, 'public/debian'), 'qpdf', 'ghostscript'], { encoding: 'utf8' }).trim();
    expect(theirs).toBe(inServer(`m.packageSetKey(${JSON.stringify(base.id)}, ${JSON.stringify(base.snapshot)}, ['ghostscript', 'qpdf'])`));
  });

  it('names are Debian package names and nothing else', () => {
    const r = inServer(`[
      m.packageSetNames('tesseract-ocr, qpdf  qpdf'), m.packageSetNames(['g++', 'libstdc++6', 'python3.13']),
      m.packageSetNames(['Tesseract']), m.packageSetNames(['a']), m.packageSetNames(['-rf']), m.packageSetNames(['qpdf=1.0']),
      m.packageSetNames(['qpdf/stable']), m.packageSetNames(['qpdf;id']), m.packageSetNames(['$(id)']), m.packageSetNames(['../x']),
      m.packageSetNames(['x'.repeat(64)]), m.packageSetNames([]), m.packageSetNames(Array.from({ length: 13 }, (_, i) => 'pkg' + i)),
      m.packageSetNames(['linux-image-amd64']), m.packageSetNames(['grub-pc', 'jq']), m.packageSetNames(['systemd-sysv']), m.packageSetNames(['nvidia-kernel-dkms']),
      m.packageSetNames(['initscripts', 'linux-libc-dev', 'dockerfile-mode'].slice(0, 2)),
    ]`) as any[];
    expect(r[0]).toEqual({ ok: true, names: ['qpdf', 'tesseract-ocr'] });
    expect(r[1]).toEqual({ ok: true, names: ['g++', 'libstdc++6', 'python3.13'] });
    for (const bad of r.slice(2, 11)) expect(bad).toMatchObject({ ok: false, reason: 'bad-name' });
    expect(r[11]).toMatchObject({ ok: false, reason: 'bad-name', message: 'No package was named.' });
    expect(r[12]).toMatchObject({ ok: false, reason: 'too-many', message: 'A set has at most 12 packages; this one names 13.' });
    expect(r[13]).toMatchObject({ ok: false, reason: 'not-allowed', message: 'linux-image-amd64 is not built on this server.' });
    for (const refused of r.slice(14, 17)) expect(refused).toMatchObject({ ok: false, reason: 'not-allowed' });
    // (names that only look like the refused ones are ordinary packages)
    expect(r[17]).toMatchObject({ ok: true });
  });

  it('a name ends in a letter, a digit or +, in every copy of the grammar', async () => {
    // to apt, `name-` is "remove name"; no Debian package's name ends in - or .
    const r = inServer(`[m.packageSetNames(['jq-']), m.packageSetNames(['jq.']), m.packageSetNames(['jq', 'coreutils-']), m.packageSetNames(['g++']), m.packageSetNames(['a+']), m.packageSetNames(['x'.repeat(63)]), m.PACKAGE_NAME.source]`) as any[];
    for (const bad of r.slice(0, 3)) expect(bad).toMatchObject({ ok: false, reason: 'bad-name' });
    for (const good of r.slice(3, 6)) expect(good).toMatchObject({ ok: true });
    const grammar = r[6] as string;
    expect(grammar).toBe('^[a-z0-9][a-z0-9+.-]{0,61}[a-z0-9+]$');
    // the builder's key script, the builder itself, and the tab
    expect(inModule('scripts/debian/set-key.mjs', 'm.PACKAGE_NAME.source')).toBe(grammar);
    const builder = readFileSync(join(ROOT, 'scripts/debian/build-set.sh'), 'utf8');
    expect(builder).toContain(`[[ "$p" =~ ${grammar} ]]`);
    const { PACKAGE_NAME, plainInstall } = await import('@shiro/debian/package-sets');
    expect(PACKAGE_NAME.source).toBe(grammar);
    // an app's `needs` takes the same names, and a toolchain set's one letter
    const { PACKAGE, validateManifest } = await import('@shiro/apps/manifest');
    for (const n of ['jq', 'g++', 'libstdc++6', 'python3.13', 'c', 'x'.repeat(63)]) expect(PACKAGE.test(n), n).toBe(true);
    for (const n of ['jq-', 'jq.', '-', '.', '+', 'x'.repeat(64), 'Jq', '']) expect(PACKAGE.test(n), n).toBe(false);
    for (const n of ['jq', 'g++', 'tesseract-ocr', 'jq-', 'jq.', 'a', 'x'.repeat(63), 'x'.repeat(64)]) expect(PACKAGE.test(n), n).toBe(n.length === 1 || PACKAGE_NAME.test(n));
    expect(() => validateManifest({ name: 'Tidy', run: 'jq . {in}', needs: ['coreutils-'] })).toThrow(/needs\[0\] must be the name of a Debian package/);
    // typed at the prompt, `apt install jq-` is apt's own business (a removal), never a set
    expect(plainInstall(['install', 'jq-'])).toBeNull();
    expect(plainInstall(['install', 'jq', 'g++'])).toEqual(['jq', 'g++']);
    // names after `--` (how tabcomputer's own fallbacks hand them to apt) are still a plain install
    expect(plainInstall(['install', '-y', '--', 'jq', 'g++'])).toEqual(['jq', 'g++']);
    expect(plainInstall(['install', '--', '-y'])).toBeNull();
  });

  it('the builder checks each name against the snapshot before apt sees it, and the tab hands apt names after --', () => {
    const builder = readFileSync(join(ROOT, 'scripts/debian/build-set.sh'), 'utf8');
    const check = builder.indexOf('grep -qxF -- "$p" "$WORK/names.now"');
    const firstInstall = builder.indexOf('apt-get "${APT_OPTS[@]}" -o Dir::Cache::archives=/var/tmp/tc-none install');
    expect(check).toBeGreaterThan(0);
    expect(firstInstall).toBeGreaterThan(check);
    expect(builder.slice(check, firstInstall)).toContain('::tc:: refused unknown-package');
    // every install line of the builder and of the tab's apt fallbacks ends its options first
    const installs = builder.split('\n').filter((l) => /apt-get .* install /.test(l));
    expect(installs).toHaveLength(3);
    for (const l of installs) expect(l).toMatch(/ -- "\$\{PKGS\[@\]\}"/);
    for (const [file, names] of [['src/apps/runtime.ts', 'names'], ['src/commands/toolchain.ts', 'packages'], ['src/commands/pkg.ts', 'other']]) {
      const line = readFileSync(join(ROOT, file), 'utf8').split('\n').filter((l) => l.includes('apt-get install -y'));
      expect(line, file).toHaveLength(1);
      expect(line[0], file).toContain(`apt-get install -y -- \${${names}.join(' ')}`);
    }
  });

  it('the builder is a transient systemd unit that is given the key and a file, never a name', () => {
    const c = inServer(`m.packageBuildCommand(m.packageLayersConfig({ TABCOMPUTER_DEBIAN_LAYERS: '/l', TABCOMPUTER_LAYER_BUILDER: '1', STATIC_DIR: '/s' }), 'p-0123456789abcdef01234567', '/w/specs/p-0123456789abcdef01234567.json')`);
    expect(c.file).toBe('systemd-run');
    const a: string[] = c.args;
    for (const p of ['PrivateMounts=yes', 'PrivateDevices=yes', 'Nice=19', 'IOSchedulingClass=idle', 'CPUQuota=50%', 'MemoryMax=900M', 'RuntimeMaxSec=900']) expect(a[a.indexOf(p) - 1], p).toBe('-p');
    expect(a).toContain('--wait');
    expect(a).toContain('--pipe');
    expect(a.slice(-3)).toEqual(['bash', '/opt/tabcomputer/set-build/tools/build-set.sh', 'p-0123456789abcdef01234567']);
    for (const e of ['BASE=/s/debian', 'OUT=/l/sets', 'WORK=/opt/tabcomputer/set-build', 'SPEC=/w/specs/p-0123456789abcdef01234567.json', 'TC_SET_MAX_PACKAGES=400', 'TC_SET_MAX_DEB_MB=200', 'TC_SETS_MAX_MB=3072']) expect(a[a.indexOf(e) - 1], e).toBe('-E');
    // off unless asked for, and off without a layers directory
    expect(inServer(`[m.packageLayersConfig({}).builder, m.packageLayersConfig({ TABCOMPUTER_LAYER_BUILDER: '1' }).builder, m.packageLayersConfig({ TABCOMPUTER_DEBIAN_LAYERS: '/l' }).builder, m.packageLayersConfig({ TABCOMPUTER_DEBIAN_LAYERS: '/l', TABCOMPUTER_LAYER_BUILDER: '1' }).builder]`))
      .toEqual([false, false, false, true]);
  });
});

describe('/debian/layers/set', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => { h = await harness(); }, 20_000);

  it('builds a set the first time it is asked for, says how far it is, and has it from then on', async () => {
    const first = await h.set('hold-jq,qpdf');
    expect(first.state).toBe('building');
    expect(first.key).toMatch(/^p-[0-9a-f]{24}$/);
    // 4 packages (the two and two more): all downloaded, then the build waits in "installing" with one set up
    const mid = await h.until('qpdf hold-jq', (a) => a.phase === 'installing' && a.done === 1);
    expect(mid).toEqual({ state: 'building', key: first.key, phase: 'installing', done: 1, total: 4 });
    // the same set from someone else, in another order: the same build
    expect((await h.set('qpdf,hold-jq', '', '10.0.0.2')).key).toBe(first.key);
    await h.get(`/__release?key=${first.key}`);
    const done = await h.settled('hold-jq,qpdf');
    expect(done).toMatchObject({ state: 'ready', key: first.key, base: '/debian/layers/sets/', layer: { kind: 'layer', name: first.key, base: 'base1', requested: ['hold-jq', 'qpdf'], title: 'hold-jq, qpdf' } });
    expect(await h.set('qpdf hold-jq')).toMatchObject({ state: 'ready', key: first.key });
    const spawned = await h.spawned();
    expect(spawned).toHaveLength(1);
    // The builder got the key and a file; the names are in the file and nowhere else
    expect(spawned[0].args.at(-1)).toBe(first.key);
    expect(JSON.stringify([spawned[0].args, spawned[0].env])).not.toMatch(/hold-jq|qpdf/);
    expect(JSON.parse(readFileSync(spawned[0].env.SPEC, 'utf8')).layers[first.key].packages).toEqual(['hold-jq', 'qpdf']);
    expect(spawned[0].env).toMatchObject({ OUT: h.sets, BASE: join(h.dir, 'static/debian'), TC_SET_MAX_DEB_MB: '200' });
  }, 30_000);

  it('refuses what is not a set of package names, and starts nothing for it', async () => {
    const before = (await h.spawned()).length;
    expect(await h.set('qpdf;rm -rf /')).toMatchObject({ state: 'unavailable', reason: 'bad-name' });
    expect(await h.set('$(id)')).toMatchObject({ state: 'unavailable', reason: 'bad-name' });
    expect(await h.set('qpdf=1.0')).toMatchObject({ state: 'unavailable', reason: 'bad-name' });
    expect(await h.set('')).toMatchObject({ state: 'unavailable', reason: 'bad-name' });
    expect(await h.set('linux-image-amd64')).toMatchObject({ state: 'unavailable', reason: 'not-allowed' });
    expect(await h.set(Array.from({ length: 13 }, (_, i) => `pkg${i}`).join(','))).toMatchObject({ state: 'unavailable', reason: 'too-many' });
    // another Debian base than this server's
    expect(await h.get('/debian/layers/set?base=other&packages=jq')).toMatchObject({ state: 'unavailable', reason: 'base' });
    // a question only: no build
    expect(await h.set('never-built', '&build=0')).toMatchObject({ state: 'unavailable', reason: 'not-built' });
    expect((await fetch(`http://127.0.0.1:${h.port}/debian/layers/set?packages=jq`, { method: 'POST' })).status).toBe(405);
    expect((await h.spawned()).length).toBe(before);
  });

  it('a failed build is said once and not started again for a while; a refusal carries the builder\'s sentence', async () => {
    const before = (await h.spawned()).length;
    expect(await h.settled('fail-pkg')).toMatchObject({ state: 'failed', reason: 'failed', message: 'The build failed.' });
    expect(await h.set('fail-pkg')).toMatchObject({ state: 'failed', reason: 'failed' });
    expect(await h.settled('huge-pkg')).toMatchObject({ state: 'failed', reason: 'too-large', message: 'This set downloads 900 MB of packages; the builder takes at most 200 MB.' });
    expect(await h.settled('ghost-pkg')).toMatchObject({ state: 'failed', reason: 'unknown-package', message: 'Unable to locate package ghost-pkg.' });
    expect((await h.spawned()).length).toBe(before + 3);
    expect(existsSync(join(h.sets, 'chunks'))).toBe(true);
  }, 30_000);

  it('once the builder has listed the archive, a name it lacks is answered at once', async () => {
    const before = (await h.spawned()).length;
    writeFileSync(join(h.sets, 'names.txt'), Array.from({ length: 2000 }, (_, i) => `lib${i}`).concat(['jq', 'qpdf', 'hold-jq']).sort().join('\n') + '\n');
    expect(await h.set('jq,tesseract-ocrr,nosuch')).toEqual({
      state: 'unavailable', reason: 'unknown-package', unknown: ['nosuch', 'tesseract-ocrr'],
      message: "nosuch, tesseract-ocrr are not in Debian's main archive under those names.",
    });
    expect(await h.set('nosuch', '&build=0')).toMatchObject({ unknown: ['nosuch'], message: "nosuch is not in Debian's main archive under that name." });
    // a set that is built stays served, whatever the list says
    expect(await h.set('hold-jq,qpdf')).toMatchObject({ state: 'ready' });
    expect((await h.spawned()).length).toBe(before);
    rmSync(join(h.sets, 'names.txt'));
  });
});

describe('one build at a time, and limits per address', () => {
  it('queues the next set, counts what an address has waiting, and refuses past the queue', async () => {
    const h = await harness({ QUEUE: '2', PER_ADDRESS: '2', PER_HOUR: '50' });
    const a = await h.set('hold-a', '', '10.1.0.1');
    expect(a.state).toBe('building');
    const b = await h.set('hold-b', '', '10.1.0.1');
    expect(b).toEqual({ state: 'queued', key: b.key, ahead: 1 });
    // the same address has two builds waiting: no third
    expect(await h.set('hold-c', '', '10.1.0.1')).toMatchObject({ state: 'unavailable', reason: 'busy', message: 'This address already has 2 builds waiting.' });
    // another address may queue one more; then the queue (2) is full for everyone
    expect(await h.set('hold-c', '', '10.1.0.2')).toMatchObject({ state: 'queued', ahead: 2 });
    expect(await h.set('hold-d', '', '10.1.0.3')).toMatchObject({ state: 'unavailable', reason: 'busy', message: 'The builder has a full queue.' });
    expect((await h.get('/__stats')).queued).toHaveLength(2);
    expect(await h.spawned()).toHaveLength(1);
    await h.get(`/__release?key=${a.key}`);
    expect(await h.settled('hold-a')).toMatchObject({ state: 'ready' });
    // the next one started by itself
    expect((await h.until('hold-b', (x) => x.state === 'building')).key).toBe(b.key);
    expect(await h.spawned()).toHaveLength(2);
    await h.get(`/__release?key=${b.key}`);
    const c = await h.set('hold-c', '', '10.1.0.2');
    await h.get(`/__release?key=${c.key}`);
    expect(await h.settled('hold-b')).toMatchObject({ state: 'ready' });
    expect(await h.settled('hold-c')).toMatchObject({ state: 'ready' });
    expect(await h.spawned()).toHaveLength(3);
  }, 30_000);

  it('an address starts only so many builds in an hour', async () => {
    const h = await harness({ PER_HOUR: '2', PER_ADDRESS: '5' });
    expect(await h.settled('jq', '10.2.0.1')).toMatchObject({ state: 'ready' });
    expect(await h.settled('qpdf', '10.2.0.1')).toMatchObject({ state: 'ready' });
    expect(await h.set('pandoc', '', '10.2.0.1')).toMatchObject({ state: 'unavailable', reason: 'rate' });
    // what is built is served to that address all the same, and another address may build
    expect(await h.set('jq', '', '10.2.0.1')).toMatchObject({ state: 'ready' });
    expect(await h.settled('pandoc', '10.2.0.9')).toMatchObject({ state: 'ready' });
  }, 30_000);

  it('a server without the builder serves the sets it has and says so for the rest', async () => {
    const h = await harness({ BUILDER: '0' });
    expect(await h.set('jq')).toEqual({ state: 'unavailable', reason: 'no-builder', message: 'This server does not build package sets.' });
    // a set built ahead (release.sh's): there
    const key = inServer(`m.packageSetKey('base1', 'S1', ['jq'])`) as string;
    mkdirSync(join(h.sets, key), { recursive: true });
    writeFileSync(join(h.sets, key, 'layer.json'), JSON.stringify({ format: 1, kind: 'layer', id: 'x1', name: key, base: 'base1', snapshot: 'S1', index: `${key}/index-00.json.gz`, packages: 3, chunkBytes: 5 }));
    expect(await h.set('jq')).toMatchObject({ state: 'ready', key, layer: { id: 'x1', requested: ['jq'] } });
    // a layer of another base under that key is not this set
    writeFileSync(join(h.sets, key, 'layer.json'), JSON.stringify({ format: 1, kind: 'layer', id: 'x1', name: key, base: 'older', index: 'x' }));
    expect(await h.set('jq')).toMatchObject({ state: 'unavailable', reason: 'no-builder' });
    expect(await h.spawned()).toHaveLength(0);
  }, 20_000);
});

describe('what a set may install (scripts/debian/set-limits.mjs)', () => {
  const uris = (list: [string, number, string?][]) => list.map(([name, bytes, pool = 'pool/main']) =>
    `'https://snapshot.debian.org/archive/debian/20261001T000000Z/${pool}/x/${name}_1.0_amd64.deb' ${name}_1.0_amd64.deb ${bytes} SHA256:${'0'.repeat(64)}`).join('\n') + '\n';
  const limits = async (text: string, o: object = {}) => inModule('scripts/debian/set-limits.mjs', `m.checkSet(${JSON.stringify(text)}, ${JSON.stringify(o)})`);
  const refuse = () => inServer('m.PACKAGE_REFUSED.source') as string;

  it('counts the packages and their bytes, dependencies included', async () => {
    const text = 'Reading package lists...\nBuilding dependency tree...\n' + uris([['libjq1', 150_000], ['libonig5', 180_000], ['jq', 80_000], ['libssl3t64', 2_000_000, 'pool/updates/main']]);
    expect(await limits(text)).toEqual({ ok: true, total: 4, bytes: 2_410_000 });
    expect(await limits(text, { maxPackages: 3 })).toEqual({ ok: false, reason: 'too-large', message: 'This set installs 4 packages; the builder takes at most 3.' });
    expect(await limits(text, { maxDebMb: 2 })).toEqual({ ok: false, reason: 'too-large', message: 'This set downloads 2 MB of packages; the builder takes at most 2 MB.' });
  });

  it('refuses a set that pulls in a package of a refused kind, or one from outside main', async () => {
    const pulled = uris([['some-tool', 1000], ['linux-image-6.12.0-amd64', 90_000_000], ['kmod', 1000]]);
    expect(await limits(pulled, { refuse: refuse() })).toMatchObject({ ok: false, reason: 'not-allowed', message: 'This set installs linux-image-6.12.0-amd64, kmod, which are not built on this server.' });
    expect(await limits(uris([['some-tool', 1000], ['libc6-dev', 1000]]), { refuse: refuse() })).toMatchObject({ ok: true, total: 2 });
    expect(await limits(uris([['jq', 1000], ['unrar', 1000, 'pool/non-free']]))).toEqual({ ok: false, reason: 'not-allowed', message: "unrar is not in Debian's main archive." });
  });

  it('as the builder runs it: one line for server.mjs, exit 4 when refused', () => {
    const run = (text: string, env: Record<string, string> = {}) => {
      try { return { code: 0, out: execFileSync('node', [join(ROOT, 'scripts/debian/set-limits.mjs')], { input: text, encoding: 'utf8', env: { ...process.env, ...env } }) }; }
      catch (e: any) { return { code: e.status, out: String(e.stdout) }; }
    };
    expect(run(uris([['jq', 1], ['libjq1', 1]]))).toEqual({ code: 0, out: '::tc:: total 2\n' });
    expect(run(uris([['jq', 1], ['libjq1', 1]]), { TC_SET_MAX_PACKAGES: '1' })).toEqual({ code: 4, out: '::tc:: refused too-large This set installs 2 packages; the builder takes at most 1.\n' });
    expect(run(uris([['grub-pc', 1]]), { TC_SET_REFUSE: refuse() }).code).toBe(4);
  });
});

describe('the disk cap (scripts/debian/set-evict.mjs)', () => {
  const evict = async (dir: string, o: object) => inModule('scripts/debian/set-evict.mjs', `m.evictSets(${JSON.stringify(dir)}, ${JSON.stringify(o)})`);
  /** A set of `chunks` chunk names of 1000 bytes each, last used `daysAgo` days ago */
  function addSet(dir: string, id: string, chunks: string[], daysAgo: number, pinned = false) {
    mkdirSync(join(dir, id), { recursive: true });
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    writeFileSync(join(dir, id, 'index-aa.json.gz'), gzipSync(JSON.stringify({ chunks: chunks.map((c) => [c, 1000, 1000]) })));
    writeFileSync(join(dir, id, 'layer.json'), JSON.stringify({ name: id, index: `${id}/index-aa.json.gz` }));
    for (const c of chunks) writeFileSync(join(dir, 'chunks', `${c}.gz`), Buffer.alloc(1000));
    const t = new Date(Date.now() - daysAgo * 86400_000);
    utimesSync(join(dir, id, 'layer.json'), t, t);
    if (pinned) writeFileSync(join(dir, id, 'pinned'), '');
  }

  it('removes the sets used longest ago until the chunks fit, never a pinned one or the one being built', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-evict-'));
    addSet(dir, 'p-old', ['a1', 'a2', 'shared'], 30);
    addSet(dir, 'p-mid', ['b1', 'b2', 'shared'], 10);
    addSet(dir, 'p-new', ['c1', 'c2'], 1);
    addSet(dir, 'p-pinned', ['d1', 'd2'], 99, true);
    writeFileSync(join(dir, 'chunks', 'orphan.gz'), Buffer.alloc(5000)); // a build that failed part-way
    // 9 chunks (9000 bytes) are named; under a 9000-byte cap nothing goes but the orphan
    expect(await evict(dir, { maxBytes: 9000 })).toMatchObject({ sets: 4, removed: [], chunkBytes: 9000, chunksDeleted: 1 });
    // 7000: the oldest set that is not pinned goes; the chunk it shared with p-mid stays
    expect(await evict(dir, { maxBytes: 7000 })).toMatchObject({ sets: 3, removed: ['p-old'], chunkBytes: 7000, chunksDeleted: 2 });
    expect(existsSync(join(dir, 'chunks', 'shared.gz'))).toBe(true);
    // 3000 with p-mid kept (it is the one about to be built again): p-new goes, and then nothing else can
    expect(await evict(dir, { maxBytes: 3000, keepId: 'p-mid' })).toMatchObject({ sets: 2, removed: ['p-new'], chunkBytes: 5000 });
    expect(readdirSync(dir).sort()).toEqual(['chunks', 'p-mid', 'p-pinned']);
    expect(readdirSync(join(dir, 'chunks')).sort()).toEqual(['b1.gz', 'b2.gz', 'd1.gz', 'd2.gz', 'shared.gz']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the newest two indexes of a set and trims the downloaded .debs, oldest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkg-evict-'));
    addSet(dir, 'p-one', ['n1'], 1);
    for (const [name, chunk, daysAgo] of [['index-bb.json.gz', 'o1', 5], ['index-cc.json.gz', 'o2', 9]] as const) {
      writeFileSync(join(dir, 'p-one', name), gzipSync(JSON.stringify({ chunks: [[chunk, 1000, 1000]] })));
      const t = new Date(Date.now() - daysAgo * 86400_000);
      utimesSync(join(dir, 'p-one', name), t, t);
      writeFileSync(join(dir, 'chunks', `${chunk}.gz`), Buffer.alloc(1000));
    }
    const debs = join(dir, 'debs');
    mkdirSync(debs);
    for (const [name, daysAgo] of [['old_1_amd64.deb', 9], ['mid_1_amd64.deb', 5], ['new_1_amd64.deb', 1]] as const) {
      writeFileSync(join(debs, name), Buffer.alloc(1000));
      const t = new Date(Date.now() - daysAgo * 86400_000);
      utimesSync(join(debs, name), t, t);
    }
    expect(await evict(dir, { maxBytes: 1e9, debs, debsMax: 2000 })).toMatchObject({ sets: 1, removed: [], chunkBytes: 2000, chunksDeleted: 1, debsDeleted: 1 });
    expect(readdirSync(join(dir, 'p-one')).sort()).toEqual(['index-aa.json.gz', 'index-bb.json.gz', 'layer.json']);
    expect(readdirSync(debs).sort()).toEqual(['mid_1_amd64.deb', 'new_1_amd64.deb']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the sets built ahead (src/debian/package-sets.json)', () => {
  const sets: string[][] = JSON.parse(readFileSync(join(ROOT, 'src/debian/package-sets.json'), 'utf8')).sets;

  it('are sets the server would take, in the order it keys them', () => {
    for (const s of sets) {
      expect(inServer(`m.packageSetNames(${JSON.stringify(s)})`)).toEqual({ ok: true, names: [...s].sort() });
      expect(s, s.join(' ')).toEqual([...s].sort());
    }
    expect(new Set(sets.map((s) => s.join(' '))).size).toBe(sets.length);
  });

  it('hold what the example apps need, so an example starts in seconds', () => {
    const dir = join(ROOT, 'apps/examples');
    const needs = readdirSync(dir).map((d) => JSON.parse(readFileSync(join(dir, d, 'app.json'), 'utf8')).needs as string[] | undefined).filter((n): n is string[] => !!n?.length);
    expect(needs.length).toBeGreaterThan(0);
    for (const n of needs) expect(sets.map((s) => s.join(' '))).toContain([...n].sort().join(' '));
  });

  it('become one spec file each for the builder, named by the key', () => {
    const out = mkdtempSync(join(tmpdir(), 'pkg-specs-'));
    const lines = execFileSync('node', [join(ROOT, 'scripts/debian/set-key.mjs'), 'specs', join(ROOT, 'public/debian'), join(ROOT, 'src/debian/package-sets.json'), out], { encoding: 'utf8' }).trim().split('\n');
    expect(lines).toHaveLength(sets.length);
    const base = JSON.parse(readFileSync(join(ROOT, 'public/debian/rootfs.json'), 'utf8'));
    for (const [i, line] of lines.entries()) {
      const [key, file] = line.split(' ');
      expect(key).toBe(inServer(`m.packageSetKey(${JSON.stringify(base.id)}, ${JSON.stringify(base.snapshot)}, ${JSON.stringify(sets[i])})`));
      expect(JSON.parse(readFileSync(file, 'utf8')).layers[key].packages).toEqual(sets[i]);
    }
    rmSync(out, { recursive: true, force: true });
  });

  // build-set.sh needs root and a Linux chroot; what can be checked anywhere is that it parses
  it('the builder scripts parse', () => {
    for (const f of ['scripts/debian/build-set.sh', 'scripts/debian/build-deploy.sh', 'deploy/tabcomputer/release.sh']) execFileSync('bash', ['-n', join(ROOT, f)]);
  });
});
