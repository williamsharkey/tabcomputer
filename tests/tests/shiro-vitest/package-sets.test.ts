/**
 * Package layers, the tab's side (docs/DEBIAN.md "Package layers",
 * src/debian/package-sets.ts): what the tab does with the server's answers.
 * The server is a stand-in (`setPackageSetServer`); the layers are real ones,
 * packed by scripts/debian/pack-layer.mjs from the base rootfs and the same
 * tree with a package "installed", as toolchain-layers.test.ts makes them.
 *
 * `apt install` before Debian mode (#136), `apt install` in Debian mode, an
 * app's `needs`, `toolchain install NAME`, the wait for a build with its
 * sentences, and the fallback. The server's side is package-layers.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import {
  setPackageSetServer, installPackageSet, plainInstall, setProgressLine, fallbackSentence, setNames, missingPackages,
  type SetAnswer, type AskSet,
} from '@shiro/debian/package-sets';
import { appliedLayers } from '@shiro/debian/layers';
import { installedRootfs } from '@shiro/debian/rootfs';
import { collectInventory } from '@shiro/install-inventory';
import { plainInstallLine } from '@shiro/apps/progress';
import { configureApps, instanceFor, resetApps, setTabJsSource } from '@shiro/apps/runtime';
import { loadManifest } from '@shiro/apps/registry';

const ROOT = resolve(__dirname, '../../..');
const haveRootfs = existsSync(resolve(ROOT, 'public/debian/rootfs.json'));
const KEY_HELLO = 'p-' + 'a'.repeat(24);
const KEY_SCAN = 'p-' + 'b'.repeat(24);

/** A shell line with what it wrote to each stream */
async function sh(shell: Shell, line: string): Promise<{ code: number; out: string; err: string }> {
  let out = '', err = '';
  const code = await shell.execute(line, (s: string) => { out += s; }, (s: string) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

/** "Install" a package into a tree the way dpkg would leave it */
function addPackage(root: string, name: string, files: Record<string, string>, depends = ''): void {
  const w = (p: string, text: string, mode = 0o644) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text, { mode });
  };
  const dirs = new Set<string>(['/.']);
  let md5 = '';
  for (const [p, text] of Object.entries(files)) {
    w(p, text, p.startsWith('/usr/bin/') ? 0o755 : 0o644);
    const parts = p.split('/');
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    md5 += createHash('md5').update(text).digest('hex') + '  ' + p.slice(1) + '\n';
  }
  w(`/var/lib/dpkg/info/${name}.list`, [...dirs, ...Object.keys(files)].join('\n') + '\n');
  w(`/var/lib/dpkg/info/${name}.md5sums`, md5);
  const status = join(root, 'var/lib/dpkg/status');
  writeFileSync(status, readFileSync(status, 'utf8').replace(/\n*$/, '\n\n')
    + `Package: ${name}\nStatus: install ok installed\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: tabcomputer tests <tests@tabcomputer.invalid>\nArchitecture: all\nVersion: 1.0-1\n${depends ? `Depends: ${depends}\n` : ''}Description: package set test package\n`);
}

describe('what the tab says and takes', () => {
  it('an `apt install` a layer can do is names and the usual flags, nothing else', () => {
    expect(plainInstall(['install', 'tesseract-ocr'])).toEqual(['tesseract-ocr']);
    expect(plainInstall(['-y', 'install', '--no-install-recommends', 'qpdf', 'g++', 'libstdc++6'])).toEqual(['qpdf', 'g++', 'libstdc++6']);
    expect(plainInstall(['install', '-qq', 'jq', '-y'])).toEqual(['jq']);
    for (const not of [
      ['install'], ['remove', 'jq'], ['update'], ['install', 'jq=1.7'], ['install', 'jq/stable'], ['install', './jq.deb'], ['install', 'jq-'],
      ['install', '-s', 'jq'], ['install', '--reinstall', 'jq'], ['install', '-t', 'trixie-backports', 'jq'], ['install', '-o', 'Foo=1', 'jq'],
      ['install', '--download-only', 'jq'], ['install', '-f'], ['install', 'JQ'], ['install', 'jq', 'x;y'],
    ]) expect(plainInstall(not), not.join(' ')).toBeNull();
  });

  it('a set is its names, sorted, once each', () => {
    expect(setNames(['qpdf', 'ghostscript', 'qpdf'])).toEqual(['ghostscript', 'qpdf']);
    expect(setNames(['qpdf', 'Bad'])).toBeNull();
    expect(setNames([])).toBeNull();
  });

  it('says in a sentence what the server is doing', () => {
    const n = ['tesseract-ocr'];
    expect(setProgressLine({ state: 'queued', ahead: 2 }, n)).toBe('The server is building other programs first: 2 builds are ahead of tesseract-ocr.');
    expect(setProgressLine({ state: 'queued', ahead: 1 }, n)).toBe('The server is building other programs first: 1 build is ahead of tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'starting' }, n)).toBe('The server is preparing tesseract-ocr for the first time.');
    expect(setProgressLine({ state: 'building', phase: 'resolving' }, n)).toBe('The server is preparing tesseract-ocr for the first time.');
    expect(setProgressLine({ state: 'building', phase: 'waiting' }, n)).toBe('The server is finishing another build before tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'downloading', done: 12, total: 71 }, n)).toBe('The server is downloading package 12 of 71 for tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'installing', done: 0, total: 71 }, n)).toBe('The server is installing package 1 of 71 for tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'installing', done: 71, total: 71 }, n)).toBe('The server is installing package 71 of 71 for tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'packing', done: 0, total: 71 }, n)).toBe('The server is packing tesseract-ocr.');
    expect(setProgressLine({ state: 'building', phase: 'installing', done: 3, total: 9 }, ['a1', 'b2', 'c3', 'd4', 'e5'])).toBe('The server is installing package 3 of 9 for a1, b2, c3 and 2 more.');
  });

  it('says in one sentence why apt does the install after all', () => {
    const f = (reason: string, more: object = {}) => fallbackSentence(['tesseract-ocr'], { ok: false, reason, message: 'x', ...more });
    expect(f('no-builder')).toBe('No ready-made copy of tesseract-ocr (this server keeps none): apt installs it here, which takes a few minutes.');
    expect(f('no-server')).toBe(f('no-builder'));
    expect(f('failed')).toBe('No ready-made copy of tesseract-ocr (the server could not build it): apt installs it here, which takes a few minutes.');
    expect(f('too-large')).toMatch(/\(the set is larger than the server builds\)/);
    expect(f('busy')).toMatch(/\(the server's builder is busy\)/);
    expect(f('stalled')).toMatch(/\(the server's build is taking too long\)/);
    expect(f('unknown-package', { unknown: ['tesseract-ocr'] })).toMatch(/\(the server does not know tesseract-ocr\)/);
    expect(fallbackSentence(['qpdf', 'ghostscript'], { ok: false, reason: 'base', message: 'x' }))
      .toBe('No ready-made copy of qpdf, ghostscript (the server builds for another Debian base than this tab has): apt installs them here, which takes a few minutes.');
  });

  it('an app\'s placeholder shows the server\'s progress, not "a few minutes"', () => {
    expect(plainInstallLine('The server is installing package 12 of 71 for tesseract-ocr.'))
      .toBe('The server is installing package 12 of 71 for tesseract-ocr. This build happens once: the next person gets these programs in seconds.');
    expect(plainInstallLine('The server is building other programs first: 1 build is ahead of tesseract-ocr.')).toMatch(/^The server is building other programs first: 1 build is ahead of tesseract-ocr\. This build happens once/);
    expect(plainInstallLine('tesseract-ocr: 71 packages to add, 40 MB streamed on first use')).toBe('The programs are being added.');
    expect(plainInstallLine('tesseract-ocr: 71 packages installed in 0.9 s (1151 paths; files load on first use).')).toBe('The programs are installed.');
    expect(plainInstallLine('jq: 1 package installed in 0.4 s (12 paths; files load on first use).')).toBe('The programs are installed.');
    const fallback = fallbackSentence(['tesseract-ocr'], { ok: false, reason: 'no-builder', message: 'x' });
    expect(plainInstallLine(fallback)).toBe(fallback);
  });
});

describe.skipIf(!haveRootfs)('package sets in the tab', () => {
  let dir: string;
  let asked: { names: string[]; base: string; build: boolean }[] = [];
  /** What the stand-in server says for a set (by its names joined with a blank); a list is one answer per question */
  const answers = new Map<string, SetAnswer | SetAnswer[]>();
  const layer = (key: string): SetAnswer => ({
    state: 'ready', key, base: 'file://' + join(dir, 'sets') + '/',
    layer: { ...JSON.parse(readFileSync(join(dir, 'sets', key, 'layer.json'), 'utf8')), title: '', description: 'Debian packages', requested: [] },
  });
  const server: AskSet = async (names, base, build) => {
    asked.push({ names, base, build });
    const a = answers.get(names.join(' '));
    if (Array.isArray(a)) return a.length > 1 ? a.shift()! : a[0];
    return a ?? { state: 'unavailable', reason: 'no-builder', message: 'This server does not build package sets.' };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pkg-sets-'));
    const base = join(dir, 'base'), out = join(dir, 'sets');
    execFileSync('node', [join(ROOT, 'scripts/debian/unpack-rootfs.mjs'), join(ROOT, 'public/debian'), base]);
    const baseId = JSON.parse(readFileSync(join(ROOT, 'public/debian/rootfs.json'), 'utf8')).id;
    const pack = (key: string, add: (tree: string) => void) => {
      const tree = join(dir, `tree-${key}`);
      cpSync(base, tree, { recursive: true, verbatimSymlinks: true });
      add(tree);
      execFileSync('node', [join(ROOT, 'scripts/debian/pack-layer.mjs'), base, tree, out, '--id', key, '--base-id', baseId, '--snapshot', 'test', '--recipe', 'test']);
      rmSync(tree, { recursive: true, force: true });
    };
    pack(KEY_HELLO, (t) => {
      addPackage(t, 'tc-lib', { '/usr/share/tc-lib/greeting': 'layered\n' });
      addPackage(t, 'tc-hello', { '/usr/bin/tc-hello': '#!/bin/sh\necho "hello from the set: $(cat /usr/share/tc-lib/greeting)"\n' }, 'tc-lib');
    });
    pack(KEY_SCAN, (t) => addPackage(t, 'tc-scan', { '/usr/bin/tc-scan': '#!/bin/sh\necho scanned\n', '/usr/share/tc-scan/data': 'x\n' }));
    setPackageSetServer(server);
  }, 120_000);
  afterAll(() => {
    setPackageSetServer(null);
    resetApps(); configureApps(null); setTabJsSource(null); setTabJsSource(null, 'page.js');
    rmSync(dir, { recursive: true, force: true });
  });

  // #136: `apt install tesseract-ocr imagemagick` stopped at "unable to locate package tesseract-ocr"
  it('apt install before Debian mode: a name neither has is said, and Debian is not set up for it', async () => {
    const { fs, shell } = await createTestShell();
    expect(await installedRootfs(fs)).toBeNull();
    answers.set('nosuch-zz', { state: 'unavailable', reason: 'unknown-package', unknown: ['nosuch-zz'], message: 'x' });
    const r = await sh(shell, 'apt install -y nosuch-zz');
    expect(r.code).toBe(100);
    expect(r.err).toBe("E: unable to locate package nosuch-zz: it is not one of tabcomputer's own packages, and Debian has no package of that name\n");
    // the question was a question: no build was asked for
    expect(asked).toEqual([{ names: ['nosuch-zz'], base: '', build: false }]);
    expect(await installedRootfs(fs)).toBeNull();
    // `pkg` is tabcomputer's own list only, and says where else to look
    const p = await sh(shell, 'pkg install nosuch-zz');
    expect(p.err).toMatch(/^E: unable to locate package nosuch-zz\n {3}pkg installs tabcomputer's own packages \(pkg available\)\. Debian may have it: apt install NAME\n$/);
  }, 60_000);

  it('apt install before Debian mode: a Debian package goes on to Debian by itself, from the set\'s layer; the server\'s build is shown as it goes', async () => {
    const { fs, shell } = await createTestShell();
    asked = [];
    answers.set('nosuch-zz tc-hello', { state: 'unavailable', reason: 'unknown-package', unknown: ['nosuch-zz'], message: 'x' });
    answers.set('tc-hello', [
      { state: 'queued', key: KEY_HELLO, ahead: 1 },
      { state: 'building', key: KEY_HELLO, phase: 'installing', done: 1, total: 2 },
      { state: 'building', key: KEY_HELLO, phase: 'installing', done: 1, total: 2 },
      { state: 'building', key: KEY_HELLO, phase: 'packing', done: 0, total: 2 },
      layer(KEY_HELLO),
    ]);
    const r = await sh(shell, 'apt install tc-hello nosuch-zz');
    // one name could not be found, and that is said; the other is installed all the same
    expect(r.code).toBe(100);
    expect(r.err).toContain("E: unable to locate package nosuch-zz: it is not one of tabcomputer's own packages, and Debian has no package of that name\n");
    expect(r.out).toContain("tc-hello: not in tabcomputer's own packages; installing from Debian (Debian is set up first, once).\n");
    expect(await installedRootfs(fs)).not.toBeNull();
    // each change at the server is one line, in order (a repeated answer is not said twice)
    const said = r.err.split('\n').filter((l) => /^The server is |packages installed in /.test(l));
    expect(said.slice(0, 3)).toEqual([
      'The server is building other programs first: 1 build is ahead of tc-hello.',
      'The server is installing package 1 of 2 for tc-hello.',
      'The server is packing tc-hello.',
    ]);
    expect(said[3]).toMatch(/^tc-hello: 2 packages installed in \d+\.\d s \(\d+ paths; files load on first use\)\.$/);
    // the build was asked for by Debian's apt, for this machine's base
    const base = (await installedRootfs(fs))!.id;
    expect(asked.filter((a) => a.build).every((a) => a.names.join() === 'tc-hello' && a.base === base)).toBe(true);
    expect(asked.filter((a) => a.build)).toHaveLength(5);

    // dpkg's database has the packages, the files are there, and the program runs under Debian's sh
    expect(await missingPackages(fs, ['tc-hello', 'tc-lib'])).toEqual([]);
    expect((await sh(shell, '/usr/bin/tc-hello')).out).toBe('hello from the set: layered\n');
    // recorded as a package set, which is not a toolchain to reinstall by name
    const applied = await appliedLayers(fs);
    expect(applied[KEY_HELLO]).toMatchObject({ kind: 'packages', name: KEY_HELLO, packages: ['tc-hello', 'tc-lib'] });
    expect((await collectInventory(fs as any))?.toolchains ?? []).not.toContain(KEY_HELLO);
  }, 600_000);

  it('apt install in Debian mode: only what is missing is asked for; what apt alone can do goes to apt', async () => {
    const { fs, shell } = await createTestShell();
    asked = [];
    answers.set('tc-scan', layer(KEY_SCAN));
    // tc-hello is installed (above): the set asked for is tc-scan alone
    const r = await sh(shell, '/usr/bin/apt-get install -y tc-scan tc-hello');
    expect(r.code).toBe(0);
    expect(asked).toEqual([{ names: ['tc-scan'], base: (await installedRootfs(fs))!.id, build: true }]);
    expect(r.err).toMatch(/tc-scan: 1 package installed in /);
    expect(r.out).toBe('tc-hello was already installed.\n');
    expect((await sh(shell, '/usr/bin/tc-scan')).out).toBe('scanned\n');
    expect((await appliedLayers(fs))[KEY_SCAN]).toMatchObject({ kind: 'packages' });
  }, 600_000);

  it('gives up on a build that stands still, and on a server that cannot build: the caller uses apt', async () => {
    const { fs } = await createTestShell();
    let t = 0;
    const lines: string[] = [];
    answers.set('tc-slow', { state: 'building', key: 'p-x', phase: 'installing', done: 3, total: 9 });
    const stalled = await installPackageSet(fs, ['tc-slow'], { progress: (l) => lines.push(l), now: () => t, sleep: async (ms) => { t += ms; }, patienceMs: 30_000 });
    expect(stalled).toEqual({ ok: false, reason: 'stalled', message: 'The build reported no progress.' });
    expect(lines).toEqual(['The server is installing package 3 of 9 for tc-slow.']);
    expect(t).toBeGreaterThanOrEqual(30_000);
    expect(t).toBeLessThan(40_000);

    for (const [answer, reason] of [
      [{ state: 'unavailable', reason: 'no-builder', message: 'This server does not build package sets.' }, 'no-builder'],
      [{ state: 'failed', key: 'p-x', reason: 'too-large', message: 'This set downloads 900 MB of packages; the builder takes at most 200 MB.' }, 'too-large'],
      [{ state: 'failed', key: 'p-x' }, 'failed'],
      [{ state: 'ready', key: 'p-x', base: 'file:///nowhere/', layer: { ...layer(KEY_SCAN).layer!, base: 'another-base' } }, 'apply'],
    ] as [SetAnswer, string][]) {
      answers.set('tc-none', answer);
      expect(await installPackageSet(fs, ['tc-none']), reason).toMatchObject({ ok: false, reason });
    }
    // a stopped wait (Ctrl-C) asks nothing more
    const stop = new AbortController();
    stop.abort();
    asked = [];
    expect(await installPackageSet(fs, ['tc-slow'], { signal: stop.signal })).toMatchObject({ ok: false, reason: 'stopped' });
    expect(asked).toEqual([]);
    expect(await installPackageSet(fs, ['Not A Name'])).toMatchObject({ ok: false, reason: 'bad-name' });
  }, 60_000);

  it('toolchain install NAME for a name that is no toolchain set installs that package set', async () => {
    const { shell } = await createTestShell();
    const have = await sh(shell, 'toolchain install tc-scan tc-hello');
    expect(have.out).toContain('tc-scan, tc-hello: already installed.\n');
    expect(have.code).toBe(0);
    const bad = await sh(shell, 'toolchain install Not_A_Name');
    expect(bad.code).toBe(1);
    expect(bad.err).toBe('toolchain: Not_A_Name is not a toolchain (toolchain list) or a Debian package name\n');
  }, 120_000);

  it('an app\'s `needs` come from the set\'s layer, with a sentence per step', async () => {
    const { fs, shell } = await createTestShell();
    // a fresh package for the app: remove tc-scan's record so the app has something to install
    const status = await fs.readFile('/var/lib/dpkg/status', 'utf8') as string;
    await fs.writeFile('/var/lib/dpkg/status', status.split(/\n\n+/).filter((s) => !/^Package: tc-scan$/m.test(s)).join('\n\n'));
    await fs.unlink('/usr/bin/tc-scan');
    expect(await missingPackages(fs, ['tc-scan'])).toEqual(['tc-scan']);
    answers.set('tc-scan', [{ state: 'building', key: KEY_SCAN, phase: 'downloading', done: 1, total: 1 }, layer(KEY_SCAN)]);
    configureApps({ fs, shell, download: () => {}, toolchains: { known: async () => [], installed: async () => ({}), install: async () => 0 } });
    setTabJsSource('// tab.js', 'tab.js');
    setTabJsSource('// page.js', 'page.js');
    const appDir = '/home/user/decl/scanner';
    await fs.mkdir(appDir, { recursive: true });
    await fs.rm('/home/user/.local/share/apps/scanner', { recursive: true }).catch(() => {});
    await fs.writeFile(`${appDir}/app.json`, JSON.stringify({ name: 'Scanner', run: 'tc-scan {in}', needs: ['tc-scan'] }));
    const inst = instanceFor({ manifest: await loadManifest(fs, appDir), dir: appDir, source: `dev:${appDir}` });
    const stages: string[] = [];
    await inst.prepare((stage) => { if (stages.at(-1) !== stage) stages.push(stage); });
    expect(stages).toEqual([
      'Scanner needs some programs. They are being downloaded. This happens once.',
      'The server is downloading package 1 of 1 for tc-scan. This build happens once: the next person gets these programs in seconds.',
      'The programs are being added.',
      'The programs are installed.',
    ]);
    expect((await sh(shell, '/usr/bin/tc-scan')).out).toBe('scanned\n');
    expect(await fs.readFile('/home/user/.local/share/apps/scanner/.toolchains', 'utf8')).toBe('package:tc-scan\n');
  }, 120_000);
});
