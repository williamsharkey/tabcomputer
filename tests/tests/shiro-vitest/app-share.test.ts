/**
 * Sharing an app as a link (src/apps/share.ts, `app share`, docs/APPS.md
 * "Sharing").
 *
 * The rule under test for a shared link: the person who opens it is asked
 * first, in any profile; what is installed is what the link held.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { appCmd } from '@shiro/commands/app';
import { configureApps } from '@shiro/apps/runtime';
import { packApp, unpackApp, shareApp, shareStatement, siteOriginOf, collectAppFiles, SHARE_PAYLOAD_MAX, SHARE_UNPACKED_MAX } from '@shiro/apps/share';
import { parseAppUrl, parseAppSpec, appLinkQuery, linkApp, handleAppLink, type AppLinkDeps, type FetchedApp, type InstallChoice } from '@shiro/apps/links';
import { cleanRunUrl, RunLinkError } from '@shiro/run-url';

const HOME = '/home/user';
const ORIGIN = 'https://tabcomputer.com';
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const MANIFEST = JSON.stringify({ manifest: 1, id: 'notes', name: 'Notes', entry: 'public', access: { commands: ['wc'] } });
const FILES = () => new Map<string, Uint8Array>([
  ['app.json', enc(MANIFEST)],
  ['public/index.html', enc('<!doctype html><h1>notes</h1>')],
  ['public/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 254, 1, 2, 3])],
  ['public/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])],
]);
const packed = (doc: unknown) => gzipSync(Buffer.from(JSON.stringify(doc))).toString('base64url');
const message = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return ''; };
/** The link's payload unpacked to its JSON text (what a reader of the link could see) */
const gzipLess = (hash: string) => gunzipSync(Buffer.from(hash.replace(/^#app=/, ''), 'base64url')).toString('utf8');

describe('a link that carries an app', () => {
  it('holds every file byte for byte, text and binary', async () => {
    const payload = await packApp(FILES());
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await unpackApp(payload);
    expect([...back.keys()].sort()).toEqual([...FILES().keys()].sort());
    for (const [rel, bytes] of FILES()) expect([...back.get(rel)!], rel).toEqual([...bytes]);
  });

  it('refuses what is not a packed app, and names that are not plain paths', async () => {
    expect(await message(unpackApp(''))).toMatch(/does not hold an app/);
    expect(await message(unpackApp('not base64!'))).toMatch(/does not hold an app/);
    expect(await message(unpackApp('AAAA'))).toMatch(/does not hold an app/);
    expect(await message(unpackApp(packed({ v: 2, t: {} })))).toMatch(/newer tabcomputer/);
    expect(await message(unpackApp(packed({ v: 1, t: { 'public/index.html': 'x' } })))).toMatch(/no app\.json/);
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a//b', '.', 'a\\b', 'a\nb', 'x/./y']) {
      expect(await message(unpackApp(packed({ v: 1, t: { 'app.json': MANIFEST, [bad]: 'x' } }))), bad).toMatch(/not a plain path/);
    }
    expect(await message(unpackApp(packed({ v: 1, t: { 'app.json': MANIFEST }, b: { 'app.json': 'AAAA' } })))).toMatch(/not a plain path/);
    expect(await message(unpackApp(packed({ v: 1, t: { 'app.json': 7 } })))).toMatch(/not a plain path/);
    expect(await message(unpackApp(packed({ v: 1, t: [] })))).toMatch(/does not hold an app/);
  });

  it('stops unpacking a small link that expands past the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(SHARE_UNPACKED_MAX + 4096, 0x20)).toString('base64url');
    expect(bomb.length).toBeLessThan(SHARE_PAYLOAD_MAX);
    expect(await message(unpackApp(bomb))).toMatch(/too large/);
  });

  it('?app=link reads its files from the part after #, and nothing else does', async () => {
    const payload = await packApp(FILES());
    expect(parseAppUrl('?app=link', `#app=${payload}`)).toEqual({ target: { kind: 'link', payload }, become: false });
    expect(parseAppUrl('?app=link&become', `#app=${payload}`)!.become).toBe(true);
    for (const hash of ['', '#', '#app=', '#app=a b', `#x=${payload}`, `#app=${payload}&more=1`]) {
      expect(() => parseAppUrl('?app=link', hash), hash).toThrow(/incomplete/);
    }
    // another app's link is not changed by a # part
    expect(parseAppUrl('?app=converter', `#app=${payload}`)!.target).toEqual({ kind: 'site', id: 'converter' });
    // `app install link` is not a way in
    expect(() => parseAppSpec('link')).toThrow(RunLinkError);
    // "Open in a guest" carries the same files
    expect(appLinkQuery({ kind: 'link', payload })).toBe(`?app=link#app=${payload}`);
    // once taken, the files are gone from the address
    expect(cleanRunUrl(`${ORIGIN}/?app=link&ui=terminal#app=${payload}`)).toBe(`${ORIGIN}/?ui=terminal`);
    expect(cleanRunUrl(`${ORIGIN}/?run=x#section`)).toBe(`${ORIGIN}/#section`);
  });

  it('is never curated, and says where it came from', async () => {
    const payload = await packApp(FILES());
    const app = await linkApp(payload);
    expect(app.curated).toBe(false);
    expect(app.manifest.id).toBe('notes');
    expect(app.manifestText).toBe(MANIFEST);
    expect(app.source).toMatch(/^link:[0-9a-f]{16}$/);
    expect(app.from).toBe('a link that carries the app\'s own files (4 files, 1 KB)');
    expect((await linkApp(payload)).source).toBe(app.source);
    expect(await message(linkApp(packed({ v: 1, t: { 'app.json': '{"manifest":1,"id":"terminal","name":"T","entry":"public"}' } })))).toMatch(/not valid/);
  });
});

function harness(search: string, hash: string, answer: InstallChoice, over: Partial<AppLinkDeps> = {}) {
  const log = { cleaned: 0, fetched: [] as string[], prompts: [] as FetchedApp[], installs: [] as { app: FetchedApp; files: Map<string, Uint8Array> }[], opens: [] as [string, boolean][], guests: [] as string[], reports: [] as string[] };
  const sources = new Map<string, string>();
  const deps: AppLinkDeps = {
    search, hash, origin: ORIGIN, framed: false,
    fetch: async (url) => { log.fetched.push(url); return new Response('no', { status: 404 }); },
    cleanUrl: () => { log.cleaned++; },
    installedSource: async (id) => sources.get(id) ?? null,
    confirm: async (app) => { log.prompts.push(app); return answer; },
    install: async (app, files) => { log.installs.push({ app, files }); sources.set(app.manifest.id, app.source); },
    open: async (id, become) => { log.opens.push([id, become]); },
    openInGuest: async (query) => { log.guests.push(query); return true; },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, log, sources };
}

describe('opening a shared app link', () => {
  it('asks first; Cancel installs and opens nothing, and nothing is fetched', async () => {
    const payload = await packApp(FILES());
    const h = harness('?app=link', `#app=${payload}`, 'cancel');
    expect(await handleAppLink(h.deps)).toBe('cancelled');
    expect(h.log.cleaned).toBe(1);
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0].manifestText).toBe(MANIFEST);
    expect(h.log.installs).toEqual([]);
    expect(h.log.opens).toEqual([]);
    expect(h.log.fetched).toEqual([]);
  });

  it('Install installs exactly the files the link held, then opens it', async () => {
    const payload = await packApp(FILES());
    const h = harness('?app=link', `#app=${payload}`, 'install');
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.installs).toHaveLength(1);
    expect(dec(h.log.installs[0].files.get('app.json')!)).toBe(MANIFEST);
    expect([...h.log.installs[0].files.get('public/logo.png')!]).toEqual([...FILES().get('public/logo.png')!]);
    expect(h.log.opens).toEqual([['notes', false]]);
    // the same link again opens the copy it installed; a link with other files asks again
    expect(await handleAppLink(h.deps)).toBe('opened');
    expect(h.log.prompts).toHaveLength(1);
    const other = FILES();
    other.set('public/index.html', enc('<script>fetch("https://evil.example")</script>'));
    const h2 = harness('?app=link', `#app=${await packApp(other)}`, 'cancel');
    h2.sources.set('notes', h.sources.get('notes')!);
    expect(await handleAppLink(h2.deps)).toBe('cancelled');
    expect(h2.log.prompts).toHaveLength(1);
  });

  it('an app installed here from a folder is still asked about when a link names its id', async () => {
    const h = harness('?app=link', `#app=${await packApp(FILES())}`, 'cancel');
    h.sources.set('notes', 'dir:/home/user/src/notes');
    expect(await handleAppLink(h.deps)).toBe('cancelled');
    expect(h.log.prompts).toHaveLength(1);
  });

  it('"Open in a guest" sends the whole link there', async () => {
    const payload = await packApp(FILES());
    const h = harness('?app=link', `#app=${payload}`, 'guest');
    expect(await handleAppLink(h.deps)).toBe('guest');
    expect(h.log.guests).toEqual([`?app=link#app=${payload}`]);
    expect(h.log.installs).toEqual([]);
  });

  it('is ignored inside a frame, and a cut-short link is refused with the address cleaned', async () => {
    const payload = await packApp(FILES());
    const framed = harness('?app=link', `#app=${payload}`, 'install', { framed: true });
    expect(await handleAppLink(framed.deps)).toBe('refused');
    expect(framed.log.prompts).toEqual([]);
    expect(framed.log.reports[0]).toMatch(/inside a frame/);
    const cut = harness('?app=link', `#app=${payload.slice(0, 40)}`, 'install');
    expect(await handleAppLink(cut.deps)).toBe('refused');
    expect(cut.log.cleaned).toBe(1);
    expect(cut.log.prompts).toEqual([]);
    expect(cut.log.installs).toEqual([]);
    expect(cut.log.reports[0]).toMatch(/does not hold an app/);
    const none = harness('?app=link', '', 'install');
    expect(await handleAppLink(none.deps)).toBe('refused');
    expect(none.log.cleaned).toBe(1);
  });
});

describe('app share', () => {
  let fs: FileSystem;
  let shell: Shell;
  const app = async (line: string) => { const r = await run(shell, `app ${line}`); return { ...r, output: r.output.replace(/\r\n/g, '\n') }; };

  beforeEach(async () => {
    ({ fs, shell } = await createTestShell());
    shell.commands.register(appCmd);
    for (const p of ['/var/lib/tabcomputer/apps.json', `${HOME}/Apps`, `${HOME}/.local/share/apps`, `${HOME}/shared-notes`, `${HOME}/big-one`]) await fs.rm(p, { recursive: true }).catch(() => {});
    configureApps({ fs, shell, toolchains: { installed: async () => ({}), install: async () => 0 }, download: () => {} });
    shell.cwd = HOME;
  });

  it('says each person gets their own copy and their own data, with nothing shared', () => {
    const s = shareStatement({ id: 'notes', name: 'Notes', url: 'x', kind: 'files', files: 3, bytes: 2400, asks: true });
    expect(s.promise).toEqual([
      'Each person who opens this link gets their own copy of Notes.',
      'Each copy keeps its own data on that person\'s computer.',
      'Nothing is shared between the copies. Other people do not see your data, and you do not see theirs.',
    ]);
    expect(s.details.join(' ')).toMatch(/3 files, 3 KB/);
    expect(s.details.join(' ')).toMatch(/does not hold the data you stored in Notes/);
    expect(s.details.join(' ')).toMatch(/installs it only when they choose Install/);
    const site = shareStatement({ id: 'converter', name: 'Convert Old Files', url: 'x', kind: 'site', asks: false });
    expect(site.promise).toHaveLength(3);
    expect(site.details.join(' ')).toMatch(/without asking, because this site ships it/);
  });

  it('one command gives a link that installs the same app somewhere else, without its data', async () => {
    expect((await app('new shared-notes --template table')).exitCode).toBe(0);
    expect((await app('install shared-notes')).exitCode).toBe(0);
    await fs.mkdir(`${HOME}/.local/share/apps/shared-notes`, { recursive: true });
    await fs.writeFile(`${HOME}/.local/share/apps/shared-notes/private.csv`, 'my,own,data\n');
    const r = await app('share shared-notes');
    expect(r.exitCode, r.output).toBe(0);
    expect(r.output).toContain('Each person who opens this link gets their own copy of');
    expect(r.output).toContain('Each copy keeps its own data on that person\'s computer.');
    expect(r.output).toContain('Nothing is shared between the copies.');
    const printed = await app('share shared-notes --print');
    const url = new URL(printed.output.trim());
    expect(r.output).toContain(url.href);
    expect(url.search).toBe('?app=link');
    const parsed = parseAppUrl(url.search, url.hash)!;
    expect(parsed.target.kind).toBe('link');
    const fetched = await linkApp((parsed.target as { payload: string }).payload);
    const files = await fetched.files();
    const installed = await collectAppFiles(fs, `${HOME}/Apps/shared-notes`);
    expect([...files.keys()].sort()).toEqual([...installed.keys()].sort());
    for (const [rel, bytes] of installed) expect(dec(files.get(rel)!), rel).toBe(dec(bytes));
    expect(gzipLess(url.hash)).not.toContain('my,own,data');
    expect([...files.keys()].some((k) => k.includes('private'))).toBe(false);
  });

  it('names the repository or the site for an app that came from one', async () => {
    const base = { id: 'tool', name: 'Tool', version: '', dir: `${HOME}/Apps/tool`, installedAt: 0, icon: '' };
    const gh = await shareApp(fs, { ...base, source: `gh:someone/tools/apps/tool@${'a'.repeat(40)}` }, ORIGIN);
    expect(gh).toMatchObject({ kind: 'gh', url: `${ORIGIN}/?app=gh:someone/tools/apps/tool`, repo: 'github.com/someone/tools, apps/tool', asks: true });
    expect(parseAppUrl(new URL(gh.url).search)!.target).toEqual({ kind: 'gh', owner: 'someone', repo: 'tools', path: 'apps/tool' });
    const site = await shareApp(fs, { ...base, id: 'converter', source: 'site' }, ORIGIN);
    expect(site).toMatchObject({ kind: 'site', url: `${ORIGIN}/?app=converter`, asks: false });
  });

  it('an app too large for a link says so and names the other way', async () => {
    expect((await app('new big-one')).exitCode).toBe(0);
    const noise = new Uint8Array(randomBytes(60_000));
    await fs.writeFile(`${HOME}/big-one/public/noise.bin`, noise);
    expect((await app('install big-one')).exitCode).toBe(0);
    const r = await app('share big-one');
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/too large for a link/);
    expect(r.output).toMatch(/\?app=gh:OWNER\/REPO/);
    expect((await app('share nothing-here')).output).toMatch(/no app named nothing-here is installed/);
    expect((await app('share')).exitCode).toBe(2);
  });

  it('a guest shares the site\'s link, not its own host\'s', () => {
    expect(siteOriginOf({ protocol: 'https:', host: 'guest--abc--t.tabcomputer.com' }, true)).toBe('https://tabcomputer.com');
    expect(siteOriginOf({ protocol: 'http:', host: 'app.localhost:5960' }, false)).toBe('http://app.localhost:5960');
  });
});
