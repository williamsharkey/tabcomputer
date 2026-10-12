/**
 * Run links from a gist (src/run-url.ts, docs/RUN_LINKS.md):
 * `?run=gist:<user>/<id>[/<file>]` and `?run=gist:<id>`. The same attack
 * cases the other forms have: path tricks, redirects, HTML answers, control
 * characters, and that nothing runs without the prompt.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRunUrl, cleanRunUrl, loadScript, handleRunLink, RunLinkError, SCRIPT_FILE, START_FILE, SCRIPT_MAX, PAGE_PARAMS,
  type RunLinkDeps, type RunPromptInfo,
} from '@shiro/run-url';

const ORIGIN = 'https://tabcomputer.com';
const ID = '7087fd12c8c6ce0e718aa046a163b4b0';
const RAW = `https://gist.githubusercontent.com/octocat/${ID}/raw`;
const SCRIPT = '#!/bin/sh\n# title: From a gist\n# args: name\n# on-open: cd ~\necho "hello $RUN_NAME"\n';
const refused = (search: string) => { try { parseRunUrl(search); } catch (e) { return e instanceof RunLinkError ? e.message : 'threw'; } return ''; };

function site(files: Record<string, string | (() => Response)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = files[url];
    if (body === undefined) return new Response('404: Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (typeof body === 'function') return body();
    return new Response(body, { status: 200, headers: { 'content-type': url.includes('api.github.com') ? 'application/json' : 'text/plain; charset=utf-8' } });
  };
  return { fetchFn, calls };
}

function harness(search: string, fetchFn: RunLinkDeps['fetch'], answer = false, over: Partial<RunLinkDeps> = {}) {
  const files = new Map<string, string>();
  const log = { cleaned: 0, prompts: [] as RunPromptInfo[], terminals: [] as Parameters<RunLinkDeps['openTerminal']>[0][], reports: [] as string[] };
  const deps: RunLinkDeps = {
    search, origin: ORIGIN, home: '/home/user', framed: false, fetch: fetchFn,
    fs: { mkdir: async () => {}, writeFile: async (p, d) => { files.set(p, d); }, exists: async (p) => files.has(p) },
    cleanUrl: () => { log.cleaned++; },
    confirm: async (info) => { log.prompts.push(info); return answer; },
    openTerminal: (o) => { log.terminals.push(o); },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, files, log };
}

describe('run links: gist:', () => {
  it('names a gist by user and id, with an optional file, or by id alone', () => {
    expect(parseRunUrl(`?run=gist:octocat/${ID}`)!.target).toEqual({ kind: 'gist', name: `gist-octocat-${ID.slice(0, 12)}`, user: 'octocat', id: ID, file: '' });
    expect(parseRunUrl(`?run=gist:Octo-Cat/${ID}/Set_up.sh`)!.target).toEqual({ kind: 'gist', name: `gist-octo-cat-${ID.slice(0, 12)}-set-up-sh`, user: 'Octo-Cat', id: ID, file: 'Set_up.sh' });
    expect(parseRunUrl(`?run=gist:${ID}`)!.target).toEqual({ kind: 'gist', name: `gist-${ID.slice(0, 12)}`, user: '', id: ID, file: '' });
    expect(parseRunUrl('?run=gist:octocat/1234567')!.target).toMatchObject({ id: '1234567' });
    expect(parseRunUrl(`?run=gist:o/${ID}&name=Ada&utm=x`)!.params).toEqual({ name: 'Ada', utm: 'x' });
  });

  it('refuses anything that could reach another file, gist or host', () => {
    for (const bad of [
      'gist:', 'gist:/', `gist:/${ID}`, `gist:octocat/`, `gist:octocat/${ID}/`, `gist:octocat/${ID}/a/b`, `gist:octocat/${ID}/..`, `gist:octocat/${ID}/.`,
      `gist:octocat/../${ID}`, `gist:../${ID}`, `gist:octocat/${ID}/..%2f..%2fx`, `gist:octocat/${ID}/a%2fb`, `gist:octocat/${ID}/a\\b`, `gist:octocat/${ID}/a?x=1`,
      `gist:octocat/${ID}/a#b`, `gist:octocat@evil.example/${ID}`, `gist:evil.example/${ID}`, `gist:octocat:8080/${ID}`, `gist:-octocat/${ID}`,
      `gist:octocat/${ID.toUpperCase()}`, 'gist:octocat/not-hex', `gist:octocat/${ID}z`, 'gist:octocat/abc', `gist:octocat/${'a'.repeat(41)}`,
      'gist:xyz', `gist:${ID}/file.sh/more/parts`, `gist:octocat/${ID}/a b`, `gist:octocat/${ID}/a\u202eb`, `gist:octocat/${ID}/a\nb`, `gist:%2e%2e/${ID}`,
    ]) expect(refused(`?run=${encodeURIComponent(bad).replace(/%3A/g, ':').replace(/%2F/g, '/')}`), bad).toMatch(/gist: link/);
    // an encoded slash is still a slash by the time the page reads it
    expect(refused(`?run=gist:octocat/${ID}/..%2f..%2fx`)).toMatch(/gist: link/);
    // `gist-…` is not a recipe name: a curated recipe can't take a gist's directory
    expect(refused('?run=gist-octocat-7087fd12c8c6')).toMatch(/no such recipe/);
    expect(refused('?run=gist')).toMatch(/no such recipe/);
  });

  it('the address is cleaned like any run link', () => {
    expect(cleanRunUrl(`https://tabcomputer.com/?ui=desktop&run=gist:o/${ID}&name=x#frag`)).toBe('https://tabcomputer.com/?ui=desktop#frag');
    expect(PAGE_PARAMS.has('run')).toBe(true);
  });

  it('fetches the gist\'s raw content, without cookies, a referrer or a redirect, and is never curated', async () => {
    const { fetchFn, calls } = site({ [RAW]: SCRIPT, [`${RAW}/setup.sh`]: 'echo named\n' });
    const s = await loadScript(parseRunUrl(`?run=gist:octocat/${ID}`)!.target, ORIGIN, fetchFn);
    expect(s).toMatchObject({ curated: false, text: SCRIPT, name: `gist-octocat-${ID.slice(0, 12)}`, from: `gist.github.com/octocat/${ID}, its first file` });
    expect(s.header).toMatchObject({ title: 'From a gist', args: 'name' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: RAW, init: { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' } });
    const named = await loadScript(parseRunUrl(`?run=gist:octocat/${ID}/setup.sh`)!.target, ORIGIN, fetchFn);
    expect(named).toMatchObject({ text: 'echo named\n', from: `gist.github.com/octocat/${ID}, setup.sh` });
    expect(calls[1].url).toBe(`${RAW}/setup.sh`);
    // a gist is never a recipe of this site, whatever it is called
    const copy = site({ [`https://gist.githubusercontent.com/tabcomputer/${ID}/raw/c-class.sh`]: SCRIPT });
    expect((await loadScript(parseRunUrl(`?run=gist:tabcomputer/${ID}/c-class.sh`)!.target, ORIGIN, copy.fetchFn)).curated).toBe(false);
  });

  it('gist:<id> looks the owner up, and takes only a plain account name from the answer', async () => {
    const api = `https://api.github.com/gists/${ID}`;
    const ok = site({ [api]: JSON.stringify({ owner: { login: 'octocat' }, files: { 'x.sh': { raw_url: 'https://evil.example/x.sh' } } }), [RAW]: SCRIPT });
    const s = await loadScript(parseRunUrl(`?run=gist:${ID}`)!.target, ORIGIN, ok.fetchFn);
    expect(s).toMatchObject({ text: SCRIPT, name: `gist-${ID.slice(0, 12)}`, from: `gist.github.com/octocat/${ID}, its first file` });
    // the raw URL is built here, never taken from the answer
    expect(ok.calls.map((c) => c.url)).toEqual([api, RAW]);
    for (const login of ['../../evil', 'evil.example/x', 'a/b', '', 7, null, 'o@evil', 'o:80']) {
      const bad = site({ [api]: JSON.stringify({ owner: { login } }), [RAW]: SCRIPT });
      await expect(loadScript(parseRunUrl(`?run=gist:${ID}`)!.target, ORIGIN, bad.fetchFn), String(login)).rejects.toThrow(/has no owner to fetch it from/);
      expect(bad.calls).toHaveLength(1);
    }
    await expect(loadScript(parseRunUrl(`?run=gist:${ID}`)!.target, ORIGIN, site({ [api]: 'not json' }).fetchFn)).rejects.toThrow(/has no owner/);
    await expect(loadScript(parseRunUrl(`?run=gist:${ID}`)!.target, ORIGIN, site({}).fetchFn)).rejects.toThrow(new RegExp(`gist ${ID} does not exist`));
  });

  const answers: [string, () => Response, RegExp][] = [
    ['a missing gist', () => new Response('404: Not Found', { status: 404 }), /does not exist/],
    ['a server error', () => new Response('oops', { status: 502 }), /HTTP 502/],
    ['an answer that was redirected', () => Object.defineProperty(new Response(SCRIPT, { status: 200, headers: { 'content-type': 'text/plain' } }), 'redirected', { value: true }), /was redirected/],
    ['an answer from another address', () => Object.defineProperty(new Response(SCRIPT, { status: 200, headers: { 'content-type': 'text/plain' } }), 'url', { value: 'https://evil.example/x.sh' }), /was redirected/],
    ['an HTML page in place of the file', () => new Response('<!doctype html><script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), /a web page, not a file/],
    ['a script that is too long', () => new Response('x'.repeat(SCRIPT_MAX + 1), { status: 200, headers: { 'content-type': 'text/plain' } }), /too large/],
    ['bytes that are not UTF-8', () => new Response(new Uint8Array([0x65, 0x63, 0xff, 0xfe]), { status: 200, headers: { 'content-type': 'text/plain' } }), /not UTF-8/],
    ['a script with a terminal escape', () => new Response('echo hi\x1b[2K\n', { status: 200, headers: { 'content-type': 'text/plain' } }), /control or invisible characters/],
    ['a script with a right-to-left override', () => new Response('echo "safe"\u202e # rm -rf ~\n', { status: 200, headers: { 'content-type': 'text/plain' } }), /control or invisible characters/],
    ['a script with a zero-width character', () => new Response('ec\u200bho hi\n', { status: 200, headers: { 'content-type': 'text/plain' } }), /control or invisible characters/],
    ['an empty file', () => new Response('  \n', { status: 200, headers: { 'content-type': 'text/plain' } }), /empty/],
  ];
  for (const [what, res, why] of answers) {
    it(`refuses ${what}`, async () => {
      const { fetchFn } = site({ [RAW]: res });
      await expect(loadScript(parseRunUrl(`?run=gist:octocat/${ID}`)!.target, ORIGIN, fetchFn)).rejects.toThrow(why);
      const h = harness(`?run=gist:octocat/${ID}`, fetchFn, true);
      expect(await handleRunLink(h.deps)).toBe('refused');
      expect(h.log.prompts).toEqual([]);
      expect(h.log.terminals).toEqual([]);
      expect(h.files.size).toBe(0);
      expect(h.log.reports[0]).toMatch(why);
    });
  }

  it('a refused redirect or no network is refused', async () => {
    const fetchFn = async () => { throw new TypeError('Failed to fetch'); };
    await expect(loadScript(parseRunUrl(`?run=gist:octocat/${ID}`)!.target, ORIGIN, fetchFn)).rejects.toThrow(/could not fetch gist\.github\.com\/octocat/);
  });

  it('a target the parser did not make is refused before any fetch', async () => {
    const { fetchFn, calls } = site({});
    for (const t of [
      { kind: 'gist', name: 'x', user: '../..', id: ID, file: '' }, { kind: 'gist', name: 'x', user: 'o', id: '../x', file: '' },
      { kind: 'gist', name: 'x', user: 'o', id: ID, file: '../../x' }, { kind: 'gist', name: 'x', user: 'o', id: ID, file: '..' },
    ] as const) await expect(loadScript(t as never, ORIGIN, fetchFn)).rejects.toThrow(/no such gist/);
    expect(calls).toEqual([]);
  });

  it('always asks first: Cancel runs and writes nothing', async () => {
    const { fetchFn } = site({ [RAW]: SCRIPT });
    const h = harness(`?run=gist:octocat/${ID}&name=Ada&other=1`, fetchFn, false);
    expect(await handleRunLink(h.deps)).toBe('cancelled');
    expect(h.log.cleaned).toBe(1);
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0]).toMatchObject({ script: SCRIPT, from: `gist.github.com/octocat/${ID}, its first file`, env: { RUN_NAME: 'Ada' }, ignored: ['other'], dir: `/home/user/run/gist-octocat-${ID.slice(0, 12)}` });
    expect(h.log.terminals).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it('Run starts exactly the script that was shown, with its arguments as data', async () => {
    let n = 0;
    // (a gist that changes between the prompt and the run: it is not fetched again)
    const fetchFn = async () => new Response(n++ ? 'rm -rf ~\n' : SCRIPT, { status: 200, headers: { 'content-type': 'text/plain' } });
    const hostile = '$(touch /tmp/pwned)`id`; "';
    const h = harness(`?run=gist:octocat/${ID}&name=${encodeURIComponent(hostile)}`, fetchFn, true);
    expect(await handleRunLink(h.deps)).toBe('ran');
    expect(n).toBe(1);
    const dir = `/home/user/run/gist-octocat-${ID.slice(0, 12)}`;
    expect(h.files.get(`${dir}/${SCRIPT_FILE}`)).toBe(SCRIPT);
    expect(h.log.terminals).toEqual([{ cwd: dir, command: `. ~/run/gist-octocat-${ID.slice(0, 12)}/${START_FILE}`, env: { RUN_NAME: hostile }, title: `gist-octocat-${ID.slice(0, 12)}` }]);
    const start = h.files.get(`${dir}/${START_FILE}`)!;
    expect(start).not.toContain('pwned');
    expect(start).toContain(`echo 'running script gist-octocat-${ID.slice(0, 12)} (gist.github.com/octocat/${ID}, its first file)'`);
    // a second load asks again, and then only does the on-open line
    const again = harness(`?run=gist:octocat/${ID}`, async () => new Response(SCRIPT, { status: 200 }), true, { fs: { mkdir: async () => {}, writeFile: async () => {}, exists: async () => true } });
    expect(await handleRunLink(again.deps)).toBe('on-open');
    expect(again.log.prompts[0].onOpenOnly).toBe('cd ~');
  });

  it('a framed page takes no gist link, and a bad one says why without quoting it', async () => {
    const { fetchFn, calls } = site({ [RAW]: SCRIPT });
    const framed = harness(`?run=gist:octocat/${ID}`, fetchFn, true, { framed: true });
    expect(await handleRunLink(framed.deps)).toBe('refused');
    expect(framed.log.reports[0]).toMatch(/ignored inside a frame/);
    expect(calls).toEqual([]);
    const bad = harness('?run=gist:<img src=x onerror=alert(1)>/../../etc', fetchFn, true);
    expect(await handleRunLink(bad.deps)).toBe('refused');
    expect(bad.log.cleaned).toBe(1);
    expect(bad.log.reports[0]).toBe('a gist: link is gist:<user>/<id>[/<file>] or gist:<id>');
  });
});
