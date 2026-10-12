/**
 * The tab's side of tab.js (src/apps/host.ts, src/apps/access.ts, docs/APPS.md
 * "tab.js" and "What is confined"): the protocol on the port, and what the
 * host refuses whatever the page sends: paths outside the manifest's folders
 * (by `..`, by an absolute path, through a link), commands the manifest does
 * not list, toolchain sets it does not list.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { validateManifest } from '@shiro/apps/manifest';
import { AppHost, PROTOCOL_VERSION, accessRoots, type HostDeps, type PortLike } from '@shiro/apps/host';
import { normalizePath, pagePath, realOf, resolveAllowed, safeRelPath, AccessError } from '@shiro/apps/access';
import { configureApps, runLine } from '@shiro/apps/runtime';

const HOME = '/home/user';
const DIR = `${HOME}/Apps/demo`;
const DATA = `${HOME}/.local/share/apps/demo`;

/** Two ends of a port, delivering in a later task as a MessagePort does */
function pair(): [PortLike, PortLike] {
  const a: PortLike = { onmessage: null, postMessage: (m) => { setTimeout(() => b.onmessage?.({ data: m }), 0); } };
  const b: PortLike = { onmessage: null, postMessage: (m) => { setTimeout(() => a.onmessage?.({ data: m }), 0); } };
  return [a, b];
}

interface Client {
  call(op: string, a?: Record<string, unknown>, on?: (e: string, d: unknown) => void): Promise<any> & { cancel(): void };
  raw: PortLike;
  drop(): void;
}
function client(host: AppHost): Client {
  const [page, tab] = pair();
  const drop = host.connect(tab);
  let seq = 0;
  const calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; on?: (e: string, d: unknown) => void }>();
  page.onmessage = (ev) => {
    const m = ev.data as { t: string; id: number; v?: unknown; e?: string; d?: unknown; code?: string; message?: string };
    const c = calls.get(m.id);
    if (!c) return;
    if (m.t === 'ev') { c.on?.(m.e!, m.d); return; }
    calls.delete(m.id);
    if (m.t === 'ok') c.resolve(m.v); else c.reject(Object.assign(new Error(m.message), { code: m.code }));
  };
  return {
    raw: page, drop,
    call(op, a = {}, on) {
      const id = ++seq;
      const p = new Promise((resolve, reject) => { calls.set(id, { resolve, reject, on }); page.postMessage({ t: 'call', id, op, a }); }) as Promise<any> & { cancel(): void };
      p.cancel = () => page.postMessage({ t: 'cancel', id });
      return p;
    },
  };
}
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok'; } catch (e) { return (e as { code?: string }).code ?? 'threw'; } };

describe('tab.js host', () => {
  let fs: FileSystem;
  let shell: Shell;
  let downloads: { name: string; bytes: Uint8Array; type: string }[];
  let installed: string[];
  let title: string;

  const make = (access: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): { host: AppHost; c: Client } => {
    const manifest = validateManifest({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public', access, ...extra });
    const deps: HostDeps = {
      fs: fs as unknown as HostDeps['fs'], home: HOME, run: runLine,
      download: (name, bytes, type) => { downloads.push({ name, bytes, type }); },
      toolchains: {
        installed: async (sets) => Object.fromEntries(sets.map((s) => [s, installed.includes(s)])),
        install: async (set, onLine) => { onLine(`unpacking ${set}`); if (set === 'broken') return 1; installed.push(set); return 0; },
      },
      window: { setTitle: (t) => { title = t; }, resize: () => {}, close: () => {} },
    };
    const host = new AppHost({ manifest, dir: DIR, dataDir: DATA, confined: true }, deps);
    return { host, c: client(host) };
  };

  beforeEach(async () => {
    ({ fs, shell } = await createTestShell());
    configureApps({ fs, shell });
    downloads = []; installed = []; title = '';
    for (const d of [DIR + '/public', DATA, `${HOME}/Shared`, `${HOME}/ReadOnly`, `${HOME}/.secret`]) await fs.mkdir(d, { recursive: true });
    await fs.writeFile(`${DIR}/public/index.html`, '<h1>demo</h1>');
    await fs.writeFile(`${HOME}/.secret/token`, 'hunter2');
    await fs.writeFile(`${HOME}/ReadOnly/note.txt`, 'read me');
  });

  it('hello says who the app is and where its folders are', async () => {
    const { c } = make();
    const v = await c.call('hello', { v: 1 });
    expect(v).toMatchObject({ v: PROTOCOL_VERSION, id: 'demo', name: 'Demo', dir: DIR, dataDir: DATA, home: HOME, confined: true });
    expect(v.manifest.access.commands).toEqual([]);
  });

  it('reads and writes inside its data folder: text, bytes, list, stat, mkdir, rename, remove', async () => {
    const { c } = make();
    expect(await c.call('fs.write', { path: 'notes/a.txt', data: 'héllo' })).toMatchObject({ path: `${DATA}/notes/a.txt` });
    expect(await c.call('fs.read', { path: `${DATA}/notes/a.txt`, as: 'text' })).toBe('héllo');
    const bytes = new Uint8Array([0, 255, 10, 13, 128]);
    await c.call('fs.write', { path: '~/.local/share/apps/demo/b.bin', data: bytes });
    expect(new Uint8Array(await c.call('fs.read', { path: 'b.bin' }))).toEqual(bytes);
    await c.call('fs.mkdir', { path: 'empty/deep' });
    const list = await c.call('fs.list', { path: '.' });
    expect(list.map((e: { name: string; type: string }) => `${e.name}:${e.type}`)).toEqual(['b.bin:file', 'empty:dir', 'notes:dir']);
    expect(await c.call('fs.stat', { path: 'b.bin' })).toMatchObject({ type: 'file', size: 5 });
    expect(await c.call('fs.stat', { path: 'nope' })).toBeNull();
    await c.call('fs.rename', { from: 'b.bin', to: 'notes/c.bin' });
    expect(await fs.exists(`${DATA}/notes/c.bin`)).toBe(true);
    expect(await code(c.call('fs.remove', { path: 'notes' }))).toBe('EINVAL');
    expect(await c.call('fs.remove', { path: 'notes', recursive: true })).toBe(true);
    expect(await c.call('fs.remove', { path: 'notes' })).toBe(false);
    expect(await code(c.call('fs.read', { path: 'gone.txt' }))).toBe('ENOENT');
    expect(await code(c.call('fs.read', { path: 'empty' }))).toBe('EINVAL');
  });

  it('refuses paths outside its folders: by .., by an absolute path, by ~', async () => {
    const { c } = make({ fs: ['~/Shared'] });
    for (const path of [
      '../../../../.secret/token', `${HOME}/.secret/token`, '~/.secret/token', '/etc/passwd', '~', '/',
      `${HOME}/Shared/../.secret/token`, `${DATA}/../other/x`, `${HOME}/SharedButNot/x`, `${HOME}/Shared/./../../user/.secret/token`,
    ]) {
      expect(await code(c.call('fs.read', { path, as: 'text' })), path).toBe('EACCES');
      expect(await code(c.call('fs.write', { path, data: 'x' })), path).toBe('EACCES');
      expect(await code(c.call('fs.list', { path })), path).toBe('EACCES');
      expect(await code(c.call('fs.stat', { path })), path).toBe('EACCES');
      expect(await code(c.call('fs.remove', { path, recursive: true })), path).toBe('EACCES');
    }
    expect(await fs.readFile(`${HOME}/.secret/token`, 'utf8')).toBe('hunter2');
    // and inside the declared folder it works
    await c.call('fs.write', { path: '~/Shared/ok.txt', data: 'fine' });
    expect(await c.call('fs.read', { path: `${HOME}/Shared/sub/../ok.txt`, as: 'text' })).toBe('fine');
    for (const path of ['', 7, null, 'a\u0000b', `${DATA}/a\nb`]) expect(await code(c.call('fs.read', { path })), String(path)).toBe('EINVAL');
  });

  it('a read-only folder, and the app\'s own folder, cannot be written', async () => {
    const { c } = make({ fs: [{ path: '~/ReadOnly', mode: 'read' }] });
    expect(await c.call('fs.read', { path: '~/ReadOnly/note.txt', as: 'text' })).toBe('read me');
    expect(await c.call('fs.read', { path: `${DIR}/public/index.html`, as: 'text' })).toBe('<h1>demo</h1>');
    for (const path of ['~/ReadOnly/note.txt', '~/ReadOnly/new.txt', `${DIR}/public/index.html`, `${DIR}/app.json`]) {
      const e = await c.call('fs.write', { path, data: 'x' }).catch((x: Error & { code: string }) => x);
      expect(e.code, path).toBe('EACCES');
      expect(e.message).toMatch(/read only/);
    }
    expect(await code(c.call('fs.remove', { path: '~/ReadOnly/note.txt' }))).toBe('EACCES');
    expect(await code(c.call('fs.rename', { from: 'a', to: '~/ReadOnly/a' }))).toBe('EACCES');
    expect(await code(c.call('files.put', { dir: '~/ReadOnly', rel: 'x', data: 'x' }))).toBe('EACCES');
  });

  it('does not follow a link out of its folders', async () => {
    const { c } = make({ fs: ['~/Shared'] });
    await fs.symlink(`${HOME}/.secret`, `${HOME}/Shared/dirlink`);
    await fs.symlink(`${HOME}/.secret/token`, `${HOME}/Shared/filelink`);
    await fs.symlink(`${HOME}/.secret/not-there-yet`, `${HOME}/Shared/dangling`);
    await fs.symlink('../.secret/token', `${DATA}/relative`);
    await fs.writeFile(`${HOME}/Shared/real.txt`, 'inside');
    await fs.symlink(`${HOME}/Shared/real.txt`, `${HOME}/Shared/inside-link`);
    for (const path of ['~/Shared/dirlink/token', '~/Shared/filelink', '~/Shared/dangling', 'relative', '~/Shared/dirlink']) {
      expect(await code(c.call('fs.read', { path, as: 'text' })), path).toBe('EACCES');
      expect(await code(c.call('fs.write', { path, data: 'pwned' })), path).toBe('EACCES');
      expect(await code(c.call('fs.stat', { path })), path).toBe('EACCES');
    }
    expect(await code(c.call('fs.write', { path: '~/Shared/dirlink/new.txt', data: 'x' }))).toBe('EACCES');
    expect(await code(c.call('fs.list', { path: '~/Shared/dirlink' }))).toBe('EACCES');
    expect(await code(c.call('files.put', { dir: '~/Shared/dirlink', rel: 'x.txt', data: 'x' }))).toBe('EACCES');
    expect(await code(c.call('files.put', { dir: '~/Shared', rel: 'dirlink/x.txt', data: 'x' }))).toBe('EACCES');
    expect(await code(c.call('download', { paths: ['~/Shared/filelink'] }))).toBe('EACCES');
    expect(await code(c.call('run', { cmd: ['echo'], cwd: '~/Shared/dirlink' }))).toBe('EACCES');
    expect(await fs.readFile(`${HOME}/.secret/token`, 'utf8')).toBe('hunter2');
    expect(await fs.exists(`${HOME}/.secret/not-there-yet`)).toBe(false);
    expect(await fs.exists(`${HOME}/.secret/new.txt`)).toBe(false);
    // a link that stays inside is followed
    expect(await c.call('fs.read', { path: '~/Shared/inside-link', as: 'text' })).toBe('inside');
    // removing a link removes the link, never what it points at
    expect(await c.call('fs.remove', { path: '~/Shared/filelink' })).toBe(true);
    expect(await c.call('fs.remove', { path: '~/Shared/dirlink', recursive: true })).toBe(true);
    expect(await fs.readFile(`${HOME}/.secret/token`, 'utf8')).toBe('hunter2');
    // the listing names links without following them
    expect((await c.call('fs.list', { path: '~/Shared' })).find((e: { name: string }) => e.name === 'dangling')).toMatchObject({ type: 'symlink' });
  });

  it('an allowed folder that is itself a link is used where it really is', async () => {
    await fs.mkdir('/tmp/realshared', { recursive: true });
    await fs.symlink('/tmp/realshared', `${HOME}/LinkedShare`);
    const { c } = make({ fs: ['~/LinkedShare'] });
    await c.call('fs.write', { path: '~/LinkedShare/a.txt', data: 'x' });
    expect(await fs.readFile('/tmp/realshared/a.txt', 'utf8')).toBe('x');
  });

  it('runs only the commands the manifest lists, each argument one word', async () => {
    const { c } = make({ commands: ['echo', 'cat'] });
    let out = '';
    const r = await c.call('run', { cmd: ['echo', 'a  b', '$(echo pwned); `id`', '> /tmp/x', "it's"] }, (e, d) => { if (e === 'out') out += d; });
    expect(r).toEqual({ code: 0 });
    expect(out).toBe("a  b $(echo pwned); `id` > /tmp/x it's\n");
    expect(await fs.exists('/tmp/x')).toBe(false);
    for (const cmd of [['sh', '-c', 'echo hi'], ['rm', '-rf', DATA], ['/bin/echo', 'x'], ['echo;id'], ['./echo'], ['Echo']]) {
      const e = await c.call('run', { cmd }).catch((x: Error & { code: string }) => x);
      expect(e.code, cmd.join(' ')).toBe('EACCES');
      expect(e.message).toMatch(/does not list the command/);
    }
    // a shell line needs access.shell
    const e = await c.call('run', { cmd: 'echo hi | cat' }).catch((x: Error & { code: string }) => x);
    expect(e.code).toBe('EACCES');
    expect(e.message).toMatch(/access\.shell/);
    for (const cmd of [[], [7], ['echo', 'a\u0000b'], '', null, {}]) expect(await code(c.call('run', { cmd })), JSON.stringify(cmd)).toBe('EINVAL');
  });

  it('with access.shell a line runs as a shell line', async () => {
    const { c } = make({ shell: true });
    let out = '';
    expect(await c.call('run', { cmd: 'echo one | tr a-z A-Z; echo two >&2' }, (_e, d) => { out += d; })).toEqual({ code: 0 });
    expect(out).toContain('ONE');
    expect(out).toContain('two');
    // an argv call is still held to the list
    expect(await code(c.call('run', { cmd: ['echo', 'x'] }))).toBe('EACCES');
  });

  it('run: cwd, env, stdin, exit status, output to a file', async () => {
    const { c } = make({ fs: ['~/Shared'], commands: ['pwd', 'cat', 'printenv', 'false', 'echo'] });
    const run = async (a: Record<string, unknown>) => { let out = '', err = ''; const r = await c.call('run', a, (e, d) => { if (e === 'out') out += d; else err += d; }); return { ...r, out, err }; };
    expect((await run({ cmd: ['pwd'] })).out.trim()).toBe(DATA);
    expect((await run({ cmd: ['pwd'], cwd: '~/Shared' })).out.trim()).toBe(`${HOME}/Shared`);
    expect(await code(c.call('run', { cmd: ['pwd'], cwd: '~/.secret' }))).toBe('EACCES');
    expect((await run({ cmd: ['cat'], stdin: 'from the page\n' })).out).toBe('from the page\n');
    expect((await run({ cmd: ['printenv', 'GREETING'], env: { GREETING: 'hi there' } })).out.trim()).toBe('hi there');
    expect((await run({ cmd: ['printenv', 'APP_ID'] })).out.trim()).toBe('demo');
    expect((await run({ cmd: ['printenv', 'APP_DATA'] })).out.trim()).toBe(DATA);
    expect((await run({ cmd: ['false'] })).code).toBe(1);
    for (const env of [{ PATH: '/evil' }, { LD_PRELOAD: 'x' }, { HOME: '/' }]) expect(await code(c.call('run', { cmd: ['pwd'], env }))).toBe('EACCES');
    for (const env of [{ 'A B': 'x' }, { A: 7 }, 'PATH=/x']) expect(await code(c.call('run', { cmd: ['pwd'], env }))).toBe('EINVAL');
    expect(await code(c.call('run', { cmd: ['cat'], stdin: 7 }))).toBe('EINVAL');
    const r = await run({ cmd: ['echo', 'to a file'], stdout: '~/Shared/deep/out.txt' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(await fs.readFile(`${HOME}/Shared/deep/out.txt`, 'utf8')).toBe('to a file\n');
    expect(await code(c.call('run', { cmd: ['echo', 'x'], stdout: '~/.secret/token' }))).toBe('EACCES');
    expect(await code(c.call('run', { cmd: ['echo', 'x'], stderr: '/etc/x' }))).toBe('EACCES');
    expect(await fs.readFile(`${HOME}/.secret/token`, 'utf8')).toBe('hunter2');
  });

  it('output arrives as it is produced, not at the end', async () => {
    const { c } = make({ shell: true });
    const at: [string, number][] = [];
    const t0 = Date.now();
    const done = c.call('run', { cmd: 'echo one; sleep 0.5; echo two' }, (e, d) => { if (e === 'out') at.push([String(d).trim(), Date.now() - t0]); });
    await done;
    const total = Date.now() - t0;
    const one = at.find(([s]) => s.includes('one'))!, two = at.find(([s]) => s.includes('two'))!;
    expect(one && two).toBeTruthy();
    expect(two[1] - one[1]).toBeGreaterThanOrEqual(300);
    expect(one[1]).toBeLessThan(total - 300);
  });

  it('cancel stops a running command, and dropping the port stops everything', async () => {
    const { c } = make({ commands: ['sleep'] });
    const t0 = Date.now();
    const p = c.call('run', { cmd: ['sleep', '20'] });
    await new Promise((r) => setTimeout(r, 100));
    p.cancel();
    const r = await p;
    expect(r.code).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    const q = c.call('run', { cmd: ['sleep', '20'] });
    q.catch(() => {});
    await new Promise((r2) => setTimeout(r2, 100));
    c.drop();
    // (nothing left running: the test would hang at teardown otherwise)
  });

  it('commands: which of the manifest\'s programs are installed', async () => {
    const { c } = make({ commands: ['echo', 'no-such-program-here'] });
    expect(await c.call('commands')).toEqual({ echo: true, 'no-such-program-here': false });
    expect(await c.call('commands', { names: ['echo', 'rm', '$(id)'] })).toEqual({ echo: true });
  });

  it('files.put stores dropped files under names made safe', async () => {
    const { c } = make({ fs: ['~/Shared'] });
    const a = await c.call('files.put', { batch: 'b1', rel: 'folder/sub/a.bin', data: new Uint8Array([1, 2, 3]) });
    expect(a).toEqual({ path: `${DATA}/imports/b1/folder/sub/a.bin`, dir: `${DATA}/imports/b1`, rel: 'folder/sub/a.bin', size: 3 });
    const b = await c.call('files.put', { batch: 'b1', rel: '../../../../.secret/token', data: 'x' });
    expect(b.path).toBe(`${DATA}/imports/b1/.secret/token`);
    const d = await c.call('files.put', { batch: '../../x', rel: '/abs/olute.txt', data: 'x' });
    expect(d.path).toMatch(new RegExp(`^${DATA}/imports/b[a-z0-9]+/abs/olute.txt$`));
    const e = await c.call('files.put', { dir: '~/Shared/in', rel: 'C:\\Users\\me\\a b.txt', data: 'x' });
    expect(e.path).toBe(`${HOME}/Shared/in/C:/Users/me/a b.txt`);
    expect(await fs.readFile(`${HOME}/.secret/token`, 'utf8')).toBe('hunter2');
    expect(await code(c.call('files.put', { dir: '~/.secret', rel: 'x', data: 'x' }))).toBe('EACCES');
    for (const rel of ['', '..', './.', 7]) expect(await code(c.call('files.put', { rel, data: 'x' })), String(rel)).toBe('EINVAL');
    expect(await code(c.call('files.put', { rel: 'a', data: { not: 'bytes' } }))).toBe('EINVAL');
  });

  it('download: one file as it is, a folder or several files as a zip', async () => {
    const { c } = make({ fs: ['~/Shared'] });
    await fs.mkdir(`${DATA}/out/sub`, { recursive: true });
    await fs.writeFile(`${DATA}/out/a.txt`, 'A');
    await fs.writeFile(`${DATA}/out/sub/b.txt`, 'B');
    expect(await c.call('download', { paths: ['out/a.txt'] })).toEqual({ name: 'a.txt', size: 1, zip: false });
    expect(new TextDecoder().decode(downloads[0].bytes)).toBe('A');
    const z = await c.call('download', { paths: ['out'], name: 'results' });
    expect(z).toMatchObject({ name: 'results.zip', zip: true });
    const zipText = new TextDecoder('latin1').decode(downloads[1].bytes);
    expect(zipText.startsWith('PK')).toBe(true);
    expect(zipText).toContain('a.txt');
    expect(zipText).toContain('sub/b.txt');
    expect(downloads[1].type).toBe('application/zip');
    const two = await c.call('download', { paths: ['out/a.txt', 'out/sub'], name: 'evil/../name.zip' });
    expect(two).toMatchObject({ zip: true, name: 'evil_.._name.zip' });
    expect((await c.call('download', { paths: ['out/a.txt'], zip: true })).zip).toBe(true);
    expect(await code(c.call('download', { paths: ['~/.secret/token'] }))).toBe('EACCES');
    expect(await code(c.call('download', { paths: ['out/a.txt', '~/.secret'] }))).toBe('EACCES');
    expect(await code(c.call('download', { paths: ['out/missing'] }))).toBe('ENOENT');
    expect(await code(c.call('download', { paths: ['out/a.txt', '~/Shared'] }))).toBe('EINVAL');
    expect(downloads).toHaveLength(4);
    // nothing of the zip is left behind
    expect((await fs.readdir('/tmp')).filter((n) => n.startsWith('.app-demo-'))).toEqual([]);
  });

  it('toolchain.ensure installs the manifest\'s sets with progress, and no others', async () => {
    const { c } = make({}, { toolchains: ['c', 'python', 'broken'] });
    const lines: string[] = [];
    expect(await c.call('toolchain.status', {})).toEqual({ c: false, python: false, broken: false });
    expect(await c.call('toolchain.ensure', { sets: ['c', 'python'] }, (e, d) => { if (e === 'progress') lines.push(`${(d as { set: string }).set}: ${(d as { line: string }).line}`); })).toEqual({ installed: ['c', 'python'], sets: ['c', 'python'] });
    expect(lines).toEqual(['c: Installing c…', 'c: unpacking c', 'python: Installing python…', 'python: unpacking python']);
    expect(await c.call('toolchain.ensure', { sets: ['c'] })).toEqual({ installed: [], sets: ['c'] });
    const e = await c.call('toolchain.ensure', { sets: ['c', 'tex-full'] }).catch((x: Error & { code: string }) => x);
    expect(e.code).toBe('EACCES');
    expect(e.message).toMatch(/does not list the toolchain tex-full/);
    expect(await code(c.call('toolchain.ensure', { sets: ['broken'] }))).toBe('EIO');
    expect(installed).toEqual(['c', 'python']);
  });

  it('fs.watch reports changes under a folder until it is cancelled', async () => {
    const { c } = make();
    const seen: string[] = [];
    let watching = '';
    const w = c.call('fs.watch', { path: '.' }, (e, d) => { if (e === 'watching') watching = (d as { path: string }).path; else seen.push(`${(d as { event: string }).event} ${(d as { path: string }).path}`); });
    await new Promise((r) => setTimeout(r, 30));
    expect(watching).toBe(DATA);
    await fs.writeFile(`${DATA}/w.txt`, '1');
    await fs.writeFile(`${HOME}/Shared/elsewhere.txt`, '1');
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toContain(`write ${DATA}/w.txt`);
    expect(seen.some((s) => s.includes('elsewhere'))).toBe(false);
    w.cancel();
    expect(await w).toBeNull();
    const n = seen.length;
    await fs.writeFile(`${DATA}/w2.txt`, '1');
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(n);
    expect(await code(c.call('fs.watch', { path: '~/.secret' }))).toBe('EACCES');
  });

  it('the window: a title without control characters', async () => {
    const { c } = make();
    await c.call('window.set', { title: 'Demo: 3 of\n40\x1b[31m' });
    expect(title).toBe('Demo: 3 of 40 [31m');
  });

  it('unknown operations and malformed messages do nothing', async () => {
    const { c } = make();
    const e = await c.call('fs.chmod', { path: 'x' }).catch((x: Error & { code: string }) => x);
    expect(e.code).toBe('ENOSYS');
    expect(await code(c.call('__proto__', {}))).toBe('ENOSYS');
    expect(await code(c.call('eval', { code: 'window.parent' }))).toBe('ENOSYS');
    for (const m of [null, 'call', { t: 'call' }, { t: 'call', id: 'x', op: 'hello' }, { t: 'call', id: NaN, op: 'hello' }, { t: 'call', id: 900, op: 7 }, { id: 901, op: 'hello' }, { t: 'cancel', id: 12345 }]) c.raw.postMessage(m);
    await new Promise((r) => setTimeout(r, 20));
    expect((await c.call('hello')).id).toBe('demo');
  });

  it('the port decides who is talking: two apps, two sets of folders', async () => {
    const a = make({ fs: ['~/Shared'] });
    const manifestB = validateManifest({ manifest: 1, id: 'other', name: 'Other', entry: 'public' });
    const hostB = new AppHost({ manifest: manifestB, dir: `${HOME}/Apps/other`, dataDir: `${HOME}/.local/share/apps/other`, confined: true }, (a.host as unknown as { deps: HostDeps }).deps);
    const b = client(hostB);
    await a.c.call('fs.write', { path: 'mine.txt', data: 'a' });
    expect(await code(b.call('fs.read', { path: `${DATA}/mine.txt` }))).toBe('EACCES');
    expect(await code(b.call('fs.read', { path: '~/Shared/x' }))).toBe('EACCES');
    // (claiming to be another app changes nothing: there is no such field)
    expect((await b.call('hello', { id: 'demo' })).id).toBe('other');
  });

  it('access helpers', async () => {
    expect(normalizePath('/a/./b/../c//d/')).toBe('/a/c/d');
    expect(normalizePath('/../..')).toBe('/');
    expect(() => normalizePath('a/b')).toThrow(AccessError);
    expect(pagePath('x/y', HOME, '/base')).toBe('/base/x/y');
    expect(pagePath('~/x', HOME, '/base')).toBe(`${HOME}/x`);
    expect(pagePath('../../etc', HOME, '/base/deep')).toBe('/etc');
    expect(safeRelPath('a/../b/./c')).toBe('a/b/c');
    expect(await realOf(fs as never, `${DATA}/not/yet/there.txt`)).toBe(`${DATA}/not/yet/there.txt`);
    const m = validateManifest({ manifest: 1, id: 'demo', name: 'D', entry: 'p', access: { fs: ['~/Shared', { path: '/tmp/r', mode: 'read' }] } });
    expect(accessRoots({ manifest: m, dir: DIR, dataDir: DATA, confined: true }, HOME)).toEqual([
      { path: DATA, mode: 'write' }, { path: `${HOME}/Shared`, mode: 'write' }, { path: '/tmp/r', mode: 'read' }, { path: DIR, mode: 'read' },
    ]);
    await expect(resolveAllowed(fs as never, [{ path: DATA, mode: 'write' }], `${DATA}x/y`, 'read')).rejects.toThrow(/outside/);
  });
});
