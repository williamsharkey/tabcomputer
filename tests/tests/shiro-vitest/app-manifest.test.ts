/**
 * App manifests (src/apps/manifest.ts, docs/APPS.md): what an app.json may
 * say, the defaults, and that every mistake is named with its key.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  validateManifest, parseManifest, manifestText, describeManifest, cleanRelPath, cleanAbsPath, expandHome,
  ManifestError, MANIFEST_VERSION, type AppManifest,
} from '@shiro/apps/manifest';

const ROOT = resolve(__dirname, '../../..');
const base = (extra: Record<string, unknown> = {}) => ({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public', ...extra });
const problems = (raw: unknown): string[] => {
  try { validateManifest(raw); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};

describe('app manifest', () => {
  it('fills in the defaults of a minimal manifest', () => {
    const m = validateManifest(base());
    expect(m).toMatchObject({
      manifest: 1, id: 'demo', name: 'Demo', entry: 'public', icon: '', backend: null, toolchains: [], files: [],
      window: { width: 720, height: 560, resizable: true, multiple: false },
      access: { fs: [], network: false, commands: [], shell: false },
    });
  });

  it('reads every field', () => {
    const m = validateManifest({
      manifest: 1, id: 'notes-app', name: 'Notes', description: 'Notes in a tab', version: '1.2.0', icon: 'img/icon.svg',
      window: { width: 500, height: 400, minWidth: 300, minHeight: 200, resizable: false, multiple: true },
      entry: 'web/index.html',
      backend: { start: 'node server.js', port: 4100, health: { path: '/api/ping', timeout: 5 }, keepAlive: true },
      toolchains: ['node', 'python'],
      files: ['~/Notes/', 'data/seed.csv', '/etc/hostname'],
      access: { fs: ['~/Notes', { path: '/tmp/notes', mode: 'read' }], network: true, commands: ['sqlite3', 'zip'], shell: false },
    });
    expect(m.backend).toEqual({ start: 'node server.js', port: 4100, health: { path: '/api/ping', timeout: 5 }, lazy: false, keepAlive: true });
    expect(m.window).toEqual({ width: 500, height: 400, minWidth: 300, minHeight: 200, resizable: false, multiple: true });
    expect(m.access.fs).toEqual([{ path: '~/Notes', mode: 'write' }, { path: '/tmp/notes', mode: 'read' }]);
    expect(m.files).toEqual(['~/Notes/', 'data/seed.csv', '/etc/hostname']);
    expect(m.entry).toBe('web/index.html');
  });

  it('a backend may serve the page itself, and health may be just a path', () => {
    const m = validateManifest({ manifest: 1, id: 'srv', name: 'Srv', backend: { start: 'node s.js $PORT', health: '/ok' } });
    expect(m.entry).toBe('');
    expect(m.backend).toMatchObject({ port: 'auto', health: { path: '/ok', timeout: 20 }, lazy: false });
  });

  it('names what is missing', () => {
    // (the format version and the id have defaults: the current one, and the folder's or the name's)
    expect(problems({})).toEqual([expect.stringMatching(/^name is missing/), expect.stringMatching(/^entry is missing/)]);
    expect(problems({ name: 'Demo', id: 'Bad Id' })).toEqual(expect.arrayContaining([expect.stringMatching(/^id must be/)]));
    expect(problems({ name: '???' })).toEqual(expect.arrayContaining([expect.stringMatching(/^id is missing, and neither the folder nor the name/)]));
    expect(problems([])).toEqual(['it must be a JSON object']);
    expect(problems(null)).toEqual(['it must be a JSON object']);
  });

  it('refuses unknown keys, with the keys it knows', () => {
    expect(problems(base({ packages: ['x'] }))[0]).toMatch(/^unknown key packages \(known: manifest, id, /);
    expect(problems(base({ window: { depth: 3 } }))[0]).toMatch(/^unknown key window\.depth/);
    expect(problems(base({ backend: { start: 'x', socket: '/tmp/s' } }))[0]).toMatch(/^unknown key backend\.socket/);
    expect(problems(base({ access: { everything: true } }))[0]).toMatch(/^unknown key access\.everything/);
    expect(problems(base({ access: { fs: [{ path: '~/a', write: true }] } }))[0]).toMatch(/^unknown key access\.fs\[0\]\.write/);
  });

  it('refuses a newer format, and a bad one', () => {
    expect(problems(base({ manifest: MANIFEST_VERSION + 1 }))[0]).toMatch(/this tabcomputer reads up to 1/);
    expect(problems(base({ manifest: '1' }))[0]).toMatch(/a whole number/);
    expect(problems(base({ manifest: 0 }))[0]).toMatch(/a whole number/);
  });

  it('ids: lower case, short, not one of tabcomputer\'s own', () => {
    for (const id of ['A', 'x', 'Demo', '1app', 'a_b', 'a b', '-ab', 'a'.repeat(33), '', 7, '../x', 'a/b']) expect(problems(base({ id }))[0], String(id)).toMatch(/^id must be/);
    for (const id of ['terminal', 'files', 'api', 'guest', 'browse', 'code']) expect(problems(base({ id }))[0], id).toMatch(/taken by tabcomputer itself/);
    expect(problems(base({ id: 'my-app-2' }))).toEqual([]);
  });

  it('names and text: no control or invisible characters', () => {
    expect(problems(base({ name: 'A\u202eB' }))[0]).toMatch(/^name must be/);
    expect(problems(base({ name: 'x\ny' }))[0]).toMatch(/^name must be/);
    expect(problems(base({ name: ' ' }))[0]).toMatch(/^name must be/);
    expect(problems(base({ name: 'n'.repeat(61) }))[0]).toMatch(/^name must be/);
    expect(problems(base({ description: 'a\x1b[31m' }))[0]).toMatch(/^description must be/);
    expect(problems(base({ version: 3 }))[0]).toMatch(/^version must be/);
  });

  it('paths stay inside the app\'s folder', () => {
    for (const entry of ['../public', '/etc', 'a/../../b', '~/x', 'a\\b', '', 'a\x00b', 5]) expect(problems(base({ entry }))[0], String(entry)).toMatch(/^entry must be/);
    for (const icon of ['../icon.svg', '/icon.svg', 'https://x/icon.svg', 'icon.exe', 'icon']) expect(problems(base({ icon }))[0], icon).toMatch(/^icon must be/);
    expect(validateManifest(base({ entry: './public//index.html' })).entry).toBe('public/index.html');
    expect(validateManifest(base({ entry: '.' })).entry).toBe('.');
  });

  it('window sizes are numbers in range, and the minimum fits', () => {
    expect(problems(base({ window: { width: 'wide' } }))[0]).toBe('window.width must be a number from 120 to 10000 (got "wide")');
    expect(problems(base({ window: { height: 20 } }))[0]).toMatch(/^window\.height must be/);
    expect(problems(base({ window: { width: 400, minWidth: 500 } }))[0]).toMatch(/minWidth \(500\) is larger than window\.width \(400\)/);
    expect(problems(base({ window: { resizable: 'no' } }))[0]).toMatch(/^window\.resizable must be true or false/);
    expect(problems(base({ window: 'big' }))[0]).toMatch(/^window must be an object/);
    // a small window lowers the default minimum with it
    expect(validateManifest(base({ window: { width: 200, height: 150 } })).window).toMatchObject({ minWidth: 200, minHeight: 150 });
  });

  it('backend: a command, a port, a health path', () => {
    expect(problems(base({ backend: {} }))[0]).toMatch(/^backend\.start must be/);
    expect(problems(base({ backend: { start: 'a\nb' } }))[0]).toMatch(/^backend\.start must be/);
    expect(problems(base({ backend: { start: 'x', port: 80 } }))[0]).toMatch(/"auto" or a port from 1024 to 65535 \(got 80\); a unix socket is not supported/);
    expect(problems(base({ backend: { start: 'x', port: '/tmp/sock' } }))[0]).toMatch(/a unix socket is not supported/);
    expect(problems(base({ backend: { start: 'x', health: 'ping' } }))[0]).toMatch(/^backend\.health\.path must be/);
    expect(problems(base({ backend: { start: 'x', health: { path: '/p', timeout: 0 } } }))[0]).toMatch(/^backend\.health\.timeout must be/);
    expect(problems(base({ backend: { start: 'x', health: { path: '/p', retries: 3 } } }))[0]).toMatch(/^unknown key backend\.health\.retries/);
    expect(problems(base({ backend: { start: 'x', lazy: 1 } }))[0]).toMatch(/^backend\.lazy must be true or false/);
    expect(problems({ manifest: 1, id: 'srv', name: 'S', backend: { start: 'x', lazy: true } })[0]).toMatch(/backend\.lazy needs an entry/);
  });

  it('toolchains and files are lists of plain names and paths', () => {
    expect(problems(base({ toolchains: 'c' }))[0]).toMatch(/^toolchains must be a list/);
    expect(problems(base({ toolchains: ['c; rm -rf ~'] }))[0]).toMatch(/^toolchains\[0\] must be the name of a toolchain set/);
    expect(problems(base({ toolchains: ['--apt'] }))[0]).toMatch(/^toolchains\[0\]/);
    expect(problems(base({ files: ['../../etc/passwd'] }))[0]).toMatch(/^files\[0\] must be a path/);
    expect(problems(base({ files: ['/'] }))[0]).toMatch(/^files\[0\]/);
    expect(validateManifest(base({ toolchains: ['c', 'c', 'python'] })).toolchains).toEqual(['c', 'python']);
  });

  it('access: folders are absolute or under ~, never / and never climbing', () => {
    for (const f of ['/', 'relative/dir', '~/../x', '/tmp/../etc', '', 'C:\\x', 3, null]) expect(problems(base({ access: { fs: [f] } }))[0], String(f)).toMatch(/^access\.fs/);
    expect(problems(base({ access: { fs: [{ path: '~/a', mode: 'rw' }] } }))[0]).toMatch(/mode must be "read" or "write"/);
    expect(problems(base({ access: { fs: '~/a' } }))[0]).toMatch(/^access\.fs must be a list/);
    expect(problems(base({ access: { network: 'yes' } }))[0]).toMatch(/^access\.network must be true or false/);
    expect(validateManifest(base({ access: { fs: ['~/a/./b/', '~/a/b'] } })).access.fs).toEqual([{ path: '~/a/b', mode: 'write' }]);
    expect(validateManifest(base({ access: { fs: ['~'] } })).access.fs).toEqual([{ path: '~', mode: 'write' }]);
  });

  it('access.commands are program names: no paths, no arguments', () => {
    for (const c of ['/bin/sh', 'sh -c', 'a;b', '../x', '', '-rf', 'a b', '$(x)', 7]) expect(problems(base({ access: { commands: [c] } }))[0], String(c)).toMatch(/^access\.commands\[0\] must be a program's name/);
    expect(validateManifest(base({ access: { commands: ['mdb-tables', 'python3', 'g++', 'pdftotext'] } })).access.commands).toEqual(['mdb-tables', 'python3', 'g++', 'pdftotext']);
  });

  it('reports every problem at once', () => {
    const p = problems({ manifest: 1, id: 'Bad Id', name: '', entry: '../x', window: { width: 1 }, access: { fs: ['/'], commands: ['a b'] }, extra: 1 });
    expect(p.length).toBeGreaterThanOrEqual(7);
    const e = (() => { try { validateManifest({}); } catch (x) { return x as ManifestError; } })()!;
    expect(e.message.split('\n').every((l) => l.startsWith('app.json: '))).toBe(true);
  });

  it('parseManifest: JSON text, UTF-8, a size limit', () => {
    expect(parseManifest(JSON.stringify(base())).id).toBe('demo');
    expect(parseManifest(new TextEncoder().encode('\ufeff' + JSON.stringify(base()))).id).toBe('demo');
    expect(() => parseManifest('{ id: demo }')).toThrow(/not valid JSON/);
    expect(() => parseManifest(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/not UTF-8/);
    expect(() => parseManifest(JSON.stringify(base({ description: 'x'.repeat(70_000) })))).toThrow(/larger than 64 KB/);
  });

  it('manifestText writes a manifest that reads back the same', () => {
    const m = validateManifest({
      manifest: 1, id: 'round', name: 'Round', icon: 'icon.svg', entry: 'public', window: { width: 400, height: 300 },
      backend: { start: 'node s.js', port: 4200, health: '/ok', lazy: true }, toolchains: ['c'], files: ['~/Round/'],
      access: { fs: ['~/Round', { path: '/tmp/r', mode: 'read' }], network: true, commands: ['cc'], shell: true },
    });
    expect(parseManifest(manifestText(m))).toEqual(m);
  });

  it('describeManifest says what runs and what the page may touch', () => {
    const quiet = describeManifest(validateManifest(base()));
    expect(quiet.find((l) => l.label === 'Runs')!.text).toMatch(/nothing in the background/);
    expect(quiet.find((l) => l.label === 'Files')!.text).toBe('only its own data folder');
    expect(quiet.find((l) => l.label === 'Network')!.text).toMatch(/kept from other sites/);
    expect(quiet.some((l) => l.warn)).toBe(false);
    const loud = describeManifest(validateManifest(base({ backend: { start: 'node server.js' }, toolchains: ['rescue'], access: { fs: ['~'], network: true, shell: true } })));
    expect(loud.find((l) => l.label === 'Runs')).toMatchObject({ warn: true, text: expect.stringContaining('node server.js') });
    expect(loud.find((l) => l.label === 'Commands')).toMatchObject({ warn: true, text: expect.stringContaining('any shell command') });
    expect(loud.find((l) => l.label === 'Files')).toMatchObject({ warn: true, text: expect.stringContaining('whole home folder') });
    expect(loud.find((l) => l.label === 'Installs')!.text).toMatch(/rescue/);
  });

  it('path helpers', () => {
    expect(cleanRelPath('a/./b//c')).toBe('a/b/c');
    expect(cleanRelPath('a/../b')).toBe('');
    expect(cleanAbsPath('~/a/')).toBe('~/a');
    expect(cleanAbsPath('/a/./b')).toBe('/a/b');
    expect(cleanAbsPath('~x')).toBe('');
    expect(expandHome('~/a', '/home/user')).toBe('/home/user/a');
    expect(expandHome('~', '/home/user')).toBe('/home/user');
    expect(expandHome('/tmp/~', '/home/user')).toBe('/tmp/~');
  });

  it('every app.json shipped in the repository is valid', () => {
    const dirs = [join(ROOT, 'apps'), join(ROOT, 'apps/templates'), join(ROOT, 'apps/examples')].filter(existsSync);
    const found: AppManifest[] = [];
    for (const dir of dirs) for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'app.json');
      if (!existsSync(file)) continue;
      const m = parseManifest(readFileSync(file), { id: `x-${name}` });
      found.push(m);
      if (dir.endsWith('/apps')) expect(m.id, file).toBe(name);
      // an example is the single app.json, and takes its folder's name
      if (dir.endsWith('/examples')) { expect(readdirSync(join(dir, name)), file).toEqual(['app.json']); expect(m.kind, file).not.toBe('page'); }
    }
    expect(found.map((m) => m.id)).toContain('converter');
  });
});
