/**
 * Toolchain layers (docs/DEBIAN.md "Toolchain layers"): a layer packed by
 * scripts/debian/pack-layer.mjs from a base tree and the same tree with a
 * package "installed", applied onto a fresh Debian rootfs with `toolchain
 * install`. Then dpkg must agree (status, file lists, diversions, apt's
 * auto marks), and apt must install one more package on top: a local .deb
 * built in the tab that depends on the layer's package.
 *
 * TABCOMPUTER_TEST_LAYERS=DIR (a build-layers.sh output) also applies the
 * real `c` layer and compiles hello.c with Debian's gcc.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, cpSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run as runRaw } from './helpers';
import { compareVersions } from '@shiro/debian/layers';

// Kernel programs' output comes through a pty (\r\n)
const run = async (...a: Parameters<typeof runRaw>) => {
  const r = await runRaw(...a);
  return { ...r, output: r.output.replace(/\r\n/g, '\n') };
};

const ROOT = resolve(__dirname, '../../..');
const haveRootfs = existsSync(resolve(ROOT, 'public/debian/rootfs.json'));

describe('dpkg version comparison', () => {
  it('orders versions as dpkg does', () => {
    const lt = (a: string, b: string) => { expect(compareVersions(a, b)).toBeLessThan(0); expect(compareVersions(b, a)).toBeGreaterThan(0); };
    lt('1.0', '1.1');
    lt('1.0~rc1', '1.0');
    lt('1.0', '1.0+b1');
    lt('1.0-1', '1.0-2');
    lt('1.9', '1.10');
    lt('2.41-11', '2.41-12');
    lt('9.9', '1:0.1');
    lt('14.2.0-19', '14.2.0-19+deb13u1');
    lt('1.0a', '1.0b');
    lt('1.0', '1.0a');
    lt('21.0.8+9-1~deb13u1', '21.0.12.1+1-1~deb13u1');
    expect(compareVersions('1.0-1', '1.0-1')).toBe(0);
    expect(compareVersions('0:1.0', '1.0')).toBe(0);
    expect(compareVersions('1.01', '1.1')).toBe(0);
  });
});

describe('the sets (src/debian/toolchains.json)', () => {
  type Set = { title: string; description: string; packages: string[]; extends?: string; disk_gb?: number; prepare?: string[]; check?: string };
  const sets: Record<string, Set> = JSON.parse(readFileSync(resolve(ROOT, 'src/debian/toolchains.json'), 'utf8')).layers;
  /** build-layers.sh's own reading of a set (its `spec` function), so the builder is what's tested */
  const builder = (id: string, what: string) => execFileSync('bash', ['-c',
    'eval "$(sed -n \'/^spec() {$/,/^}$/p\' "$1")"; spec "$2" "$3"', 'bash', resolve(ROOT, 'scripts/debian/build-layers.sh'), id, what],
  { env: { ...process.env, SPEC: resolve(ROOT, 'src/debian/toolchains.json') }, encoding: 'utf8' }).replace(/\n$/, '');

  it('are well formed', () => {
    for (const [id, s] of Object.entries(sets)) {
      // server.mjs serves /debian/layers/<id>/ for this shape only; `toolchain list` has 8 columns for it
      expect(id).toMatch(/^[a-z0-9-]{1,8}$/);
      expect(s.title && s.description && s.check, id).toBeTruthy();
      expect(s.packages.length, id).toBeGreaterThan(0);
      for (const p of s.packages) expect(p, id).toMatch(/^[a-z0-9][a-z0-9+.-]+$/); // Debian policy 5.6.1
      expect(new Set(s.packages).size, id).toBe(s.packages.length);
      if (s.extends) expect(Object.keys(sets), id).toContain(s.extends);
    }
  });

  it('tex-full is tex and the packages theses need (#111), built with tex\'s packages first', () => {
    expect(sets['tex-full'].extends).toBe('tex');
    expect(sets['tex-full'].packages).toEqual(['texlive-latex-extra', 'texlive-pictures', 'texlive-science', 'texlive-bibtex-extra', 'biber',
      'texlive-plain-generic', 'texlive-fonts-recommended', 'texlive-fonts-extra', 'texlive-xetex', 'texlive-luatex']);
    expect(builder('tex-full', 'packages').split(' ')).toEqual([...sets.tex.packages, ...sets['tex-full'].packages]);
    expect(builder('tex', 'packages').split(' ')).toEqual(sets.tex.packages);
    // 1 GB of .debs, 2.7 GB unpacked and the chunks, at once: not on a nearly full disk
    expect(Number(builder('tex-full', 'disk_gb'))).toBeGreaterThanOrEqual(8);
    expect(builder('tex', 'disk_gb')).toBe('0');
  });

  it('rescue has the converters for dead formats and pandoc (#114), and builds before the big tex-full', () => {
    expect(sets.rescue.packages).toEqual(['libwpd-tools', 'libmspub-tools', 'libwps-tools', 'libmwaw-tools', 'mdbtools', 'pandoc']);
    // LibreOffice is not in it: 163 more packages, and soffice is untested under Blink
    expect(sets.rescue.packages.join(' ')).not.toMatch(/libreoffice/);
    // The builder goes in file order and stops at a failure: the set most likely to fail goes last
    expect(Object.keys(sets).at(-1)).toBe('tex-full');
  });

  it('the builder reads prepare steps as the set wrote them', () => {
    expect(builder('go', 'prepare').split('\n')).toEqual(sets.go.prepare);
    expect(JSON.parse(builder('go', 'prepare-json'))).toEqual(sets.go.prepare);
    expect(builder('c', 'prepare')).toBe('');
    expect(builder('c', 'prepare-json')).toBe('[]');
  });
});

/** A tree with one more package, tc-hello (and its dependency tc-lib), "installed" the way dpkg would leave it. */
function addFakePackages(root: string): void {
  const w = (p: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text, { mode });
  };
  w('/usr/bin/tc-hello', '#!/bin/sh\necho "hello from the layer: $(cat /usr/share/tc-lib/greeting)"\n', 0o755);
  w('/usr/share/tc-lib/greeting', 'layered\n');
  w('/var/lib/dpkg/info/tc-hello.list', '/.\n/usr\n/usr/bin\n/usr/bin/tc-hello\n');
  const md5 = (p: string) => createHash('md5').update(readFileSync(join(root, p))).digest('hex') + '  ' + p.slice(1) + '\n';
  w('/var/lib/dpkg/info/tc-hello.md5sums', md5('/usr/bin/tc-hello'));
  w('/var/lib/dpkg/info/tc-lib.md5sums', md5('/usr/share/tc-lib/greeting'));
  w('/var/lib/dpkg/info/tc-lib.list', '/.\n/usr\n/usr/share\n/usr/share/tc-lib\n/usr/share/tc-lib/greeting\n');
  // What maintainer scripts leave behind: an alternative, a package diversion, apt's auto mark
  mkdirSync(join(root, 'var/lib/dpkg/alternatives'), { recursive: true });
  w('/var/lib/dpkg/alternatives/tc-hi', 'auto\n/usr/bin/tc-hi\n\n/usr/bin/tc-hello\n50\n\n');
  symlinkSync('/usr/bin/tc-hello', join(root, 'etc/alternatives/tc-hi'));
  symlinkSync('/etc/alternatives/tc-hi', join(root, 'usr/bin/tc-hi'));
  appendFileSync(join(root, 'var/lib/dpkg/diversions'), '/usr/bin/tc-old\n/usr/bin/tc-old.distrib\ntc-hello\n');
  const ext = join(root, 'var/lib/apt/extended_states');
  appendFileSync(ext, (existsSync(ext) && readFileSync(ext, 'utf8').trim() ? '\n' : '') + 'Package: tc-lib\nArchitecture: all\nAuto-Installed: 1\n');
  const stanza = (name: string, extra = '') => `Package: ${name}\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: tabcomputer tests <tests@tabcomputer.invalid>\nArchitecture: all\nVersion: 1.0-1\n${extra}Description: toolchain layer test package\n`;
  const status = join(root, 'var/lib/dpkg/status');
  writeFileSync(status, readFileSync(status, 'utf8').replace(/\n*$/, '\n\n') + stanza('tc-hello', 'Depends: tc-lib\n') + '\n' + stanza('tc-lib'));
}

describe.skipIf(!haveRootfs)('toolchain layers', () => {
  let dir: string;
  const saved = process.env.TABCOMPUTER_DEBIAN_LAYERS_URL;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-layers-'));
    const base = join(dir, 'base'), tree = join(dir, 'tree'), out = join(dir, 'layers');
    execFileSync('node', [join(ROOT, 'scripts/debian/unpack-rootfs.mjs'), join(ROOT, 'public/debian'), base]);
    cpSync(base, tree, { recursive: true, verbatimSymlinks: true });
    addFakePackages(tree);
    const baseId = JSON.parse(readFileSync(join(ROOT, 'public/debian/rootfs.json'), 'utf8')).id;
    const spec = join(dir, 'spec.json');
    // tex and tex-full are real set ids (`toolchain install` takes only those), here with the test tree
    writeFileSync(spec, JSON.stringify({ format: 1, layers: {
      hello: { title: 'Hello', description: 'test layer', packages: ['tc-hello'], check: 'tc-hello' },
      tex: { title: 'LaTeX', description: 'test layer', packages: ['tc-lib'] },
      'tex-full': { title: 'LaTeX, full', description: 'test layer', extends: 'tex', packages: ['tc-hello'] },
    } }));
    for (const id of ['hello', 'tex', 'tex-full']) {
      execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), base, tree, out, '--id', id, '--base-id', baseId, '--snapshot', 'test', '--recipe', 'test']);
    }
    execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), '--catalog', out, '--spec', spec]);
    process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = 'file://' + out + '/';
  }, 120000);
  afterAll(() => {
    if (saved === undefined) delete process.env.TABCOMPUTER_DEBIAN_LAYERS_URL; else process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('packs only what the install changed, with owners and merged databases', async () => {
    const { gunzipSync } = await import('node:zlib');
    const m = JSON.parse(readFileSync(join(dir, 'layers/hello/layer.json'), 'utf8'));
    const ix = JSON.parse(gunzipSync(readFileSync(join(dir, 'layers', m.index))).toString());
    expect(ix.packages.map((p: any) => p.name)).toEqual(['tc-hello', 'tc-lib']);
    const paths = ix.entries.map((e: any[]) => e[0]);
    expect(paths).toContain('/usr/bin/tc-hello');
    expect(paths).toContain('/etc/alternatives/tc-hi');
    expect(paths).not.toContain('/var/lib/dpkg/status');
    expect(paths).not.toContain('/usr/bin/dpkg');
    const owner = (p: string) => ix.entries.find((e: any[]) => e[0] === p).at(-1);
    expect(ix.packages[owner('/usr/bin/tc-hello')].name).toBe('tc-hello');
    expect(ix.packages[owner('/var/lib/dpkg/info/tc-lib.list')].name).toBe('tc-lib');
    expect(owner('/etc/alternatives/tc-hi')).toBe(-1);
    expect(Object.keys(ix.merged).sort()).toEqual(['/var/lib/apt/extended_states', '/var/lib/dpkg/diversions']);
    const cat = JSON.parse(readFileSync(join(dir, 'layers/index.json'), 'utf8'));
    expect(cat.layers[0]).toMatchObject({ name: 'hello', title: 'Hello', requested: ['tc-hello'] });
    expect(cat.layers[0].extends).toBeUndefined();
    expect(cat.layers.find((l: any) => l.name === 'tex-full')).toMatchObject({ extends: 'tex', requested: ['tc-hello'] });
  });

  // #109: work left for dpkg would run in the tab at the user's next apt
  // install (tex-common's triggers rebuild every TeX format under Blink)
  it('refuses a tree where dpkg still has triggers to run', () => {
    const base = join(dir, 'base'), tree = join(dir, 'tree');
    const pack = () => {
      try {
        execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), base, tree, join(dir, 'refused'), '--id', 'hello', '--base-id', 'x', '--snapshot', 'test', '--recipe', 'test'], { stdio: 'pipe' });
        return '';
      } catch (e: any) { return String(e.stderr); }
    };
    const status = join(tree, 'var/lib/dpkg/status');
    const unincorp = join(tree, 'var/lib/dpkg/triggers/Unincorp');
    const clean = readFileSync(status, 'utf8');
    try {
      // Activated (dpkg-trigger in a prepare step), not yet incorporated
      writeFileSync(unincorp, 'texmf-format tc-hello\n');
      expect(pack()).toMatch(/triggers were activated and never run .*texmf-format tc-hello/);
      writeFileSync(unincorp, '');
      // Incorporated, not yet run: the state `dpkg --unpack` or an interrupted apt leaves
      writeFileSync(status, clean.replace('Package: tc-lib\nStatus: install ok installed\n', 'Package: tc-lib\nStatus: install ok triggers-pending\nTriggers-Pending: texmf-format\n'));
      expect(pack()).toMatch(/tc-lib:all is "install ok triggers-pending"/);
      writeFileSync(status, clean.replace('Package: tc-hello\nStatus: install ok installed\n', 'Package: tc-hello\nStatus: install ok triggers-awaited\nTriggers-Awaited: tc-lib\n'));
      expect(pack()).toMatch(/tc-hello:all is "install ok triggers-awaited"/);
      writeFileSync(status, clean);
      expect(pack()).toBe('');
    } finally {
      writeFileSync(status, clean);
      rmSync(unincorp, { force: true });
    }
    expect(existsSync(join(dir, 'refused/hello/layer.json'))).toBe(true);
  });

  it('applies onto a fresh rootfs; dpkg and apt agree, and apt installs a package on top', async () => {
    const { fs, shell } = await createTestShell();
    expect((await run(shell, 'debian install')).exitCode).toBe(0);
    const before = await fs.readFile('/var/lib/dpkg/diversions', 'utf8') as string;
    // `toolchain list` knows the catalog's set; only the test spec's
    // ids are installable by name, so apply through the module here
    const { applyLayer, appliedLayers } = await import('@shiro/debian/layers');
    const r = await applyLayer(fs, 'hello');
    expect(r.installed).toEqual(['tc-hello', 'tc-lib']);
    expect(Object.keys(await appliedLayers(fs))).toEqual(['hello']);

    expect((await run(shell, '/usr/bin/tc-hello')).output).toBe('hello from the layer: layered\n');
    expect((await run(shell, 'readlink /usr/bin/tc-hi')).output.trim()).toBe('/etc/alternatives/tc-hi');
    // The machine's diversions (the overlay's) are kept, the package's added
    const divs = await fs.readFile('/var/lib/dpkg/diversions', 'utf8') as string;
    expect(divs.startsWith(before)).toBe(true);
    expect(divs).toContain('/usr/bin/tc-old\n/usr/bin/tc-old.distrib\ntc-hello\n');

    // Debian's dpkg (in Blink) reads the merged database
    expect((await run(shell, "dpkg-query -W -f='${Package} ${Version} ${Status}\\n' tc-hello tc-lib")).output)
      .toBe('tc-hello 1.0-1 install ok installed\ntc-lib 1.0-1 install ok installed\n');
    expect((await run(shell, 'dpkg -S /usr/bin/tc-hello')).output.trim()).toBe('tc-hello: /usr/bin/tc-hello');
    expect((await run(shell, 'dpkg-query -W -f=\'${Package}\\n\' dpkg apt bash')).output.split('\n').filter(Boolean)).toHaveLength(3);
    const audit = await run(shell, 'dpkg --audit');
    expect(audit.output).toBe('');
    expect(audit.exitCode).toBe(0);
    expect((await run(shell, 'apt-mark showauto tc-lib')).output.trim()).toBe('tc-lib');
    const verify = await run(shell, 'dpkg --verify tc-hello tc-lib');
    expect(verify.output).toBe('');
    expect(verify.exitCode).toBe(0);

    // Applying again changes nothing
    const again = await applyLayer(fs, 'hello');
    expect(again.installed).toEqual([]);
    expect(again.kept).toEqual(['tc-hello', 'tc-lib']);

    // apt sees the layer's packages as installed: installing one is a no-op
    const noop = await run(shell, 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y tc-hello 2>&1');
    expect(noop.output).toMatch(/tc-hello is already the newest version \(1\.0-1\)/);
    expect(noop.output).toMatch(/0 upgraded, 0 newly installed/);

    // apt installs one more package, whose dependency the layer provides
    const pkg = '/tmp/tc-extra';
    await fs.mkdir(`${pkg}/DEBIAN`, { recursive: true });
    await fs.mkdir(`${pkg}/usr/bin`, { recursive: true });
    await fs.writeFile(`${pkg}/DEBIAN/control`, 'Package: tc-extra\nVersion: 1.0\nArchitecture: all\nMaintainer: tabcomputer tests <tests@tabcomputer.invalid>\nDepends: tc-hello (>= 1.0)\nDescription: depends on the layer\n');
    await fs.writeFile(`${pkg}/usr/bin/tc-extra`, '#!/bin/sh\nexec tc-hello\n', { mode: 0o755 });
    const build = await run(shell, `dpkg-deb --root-owner-group -Zgzip --build ${pkg} /tmp/tc-extra.deb 2>&1`);
    expect(build.exitCode).toBe(0);
    const inst = await run(shell, 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/tc-extra.deb 2>&1');
    expect(inst.output).toContain('Setting up tc-extra');
    expect(inst.output).not.toMatch(/tc-hello|tc-lib/.source + ' \\(1\\.0-1\\) \\.\\.\\.'); // not reinstalled
    expect(inst.exitCode).toBe(0);
    expect((await run(shell, 'tc-extra')).output).toBe('hello from the layer: layered\n');
    expect((await run(shell, 'dpkg --audit')).output).toBe('');
  }, 900000);

  // tex-full extends tex (#111): its layer is a superset, applied instead of
  // tex's. (This machine is the one above: test shells share a filesystem.)
  it('a set that extends another replaces it: the smaller set is then already installed', async () => {
    const { fs, shell } = await createTestShell();
    const { appliedLayers } = await import('@shiro/debian/layers');
    expect((await run(shell, 'toolchain list')).output).toMatch(/^tex-full +no +\d+ MB +LaTeX, full: /m);
    const full = await run(shell, 'toolchain install tex-full');
    expect(full.output).toMatch(/LaTeX, full: \d+ packages installed in /);
    expect(full.exitCode).toBe(0);
    expect(Object.keys(await appliedLayers(fs))).toContain('tex-full');
    // tex's own copy of the files no package owns (ls-R, formats) would name
    // less than tex-full's: it is not applied over them
    const tex = await run(shell, 'toolchain install tex');
    expect(tex.output).toContain('LaTeX: already installed, as part of tex-full.');
    expect(tex.exitCode).toBe(0);
    expect(Object.keys(await appliedLayers(fs))).not.toContain('tex');
    expect((await run(shell, '/usr/bin/tc-hello')).output).toBe('hello from the layer: layered\n');
  }, 900000);
});

const realLayers = process.env.TABCOMPUTER_TEST_LAYERS;
describe.skipIf(!haveRootfs || !realLayers)('the real c layer (TABCOMPUTER_TEST_LAYERS)', () => {
  it('toolchain install c, then gcc hello.c && ./a.out', async () => {
    process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = 'file://' + resolve(realLayers!) + '/';
    try {
      const { shell } = await createTestShell();
      const inst = await run(shell, 'toolchain install c');
      expect(inst.exitCode).toBe(0);
      expect((await run(shell, 'dpkg --audit')).output).toBe('');
      expect((await run(shell, "dpkg-query -W -f='${Status}' gcc-14")).output).toBe('install ok installed');
      // Debian's gcc, not tabcomputer's builtin compiler
      expect((await run(shell, 'gcc --version')).output).toMatch(/^gcc \(Debian 14\./);
      expect((await run(shell, "printf '#include <stdio.h>\\nint main(void){puts(\"hi\");}\\n' > /tmp/h.c && cd /tmp && gcc h.c && ./a.out")).output).toBe('hi\n');
    } finally { delete process.env.TABCOMPUTER_DEBIAN_LAYERS_URL; }
  }, 1800000);
});
