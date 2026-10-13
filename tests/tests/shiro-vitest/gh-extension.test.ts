/**
 * gh extensions (tabcomputer#127) against an in-memory GitHub: a script
 * extension cloned and run with GH_TOKEN from the tab's sign-in, a
 * precompiled one installed from its release's linux-amd64 asset (the
 * "binary" here is a script, so no emulator is needed), list, upgrade,
 * remove, exec, `gh NAME`, and the refusals. Nothing leaves the process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import git from '@shiro/commands/git-cached';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { ghCmd } from '@shiro/commands/gh';
import { assetPlatform, pickAsset, extensionsDir } from '@shiro/commands/gh-extension';
import { GITHUB_TOKEN_STORAGE_KEY } from '@shiro/credentials';
import { createTestShell } from './helpers';
import { fakeGitHub, parseCommit, parseTree, type FakeGitHub } from './git-github-api-fake';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
}

const HOME = '/home/user';
const TOKEN = 'ghp_' + 'b'.repeat(36);
const who = { name: 'Ann Lee', email: 'ann@x.org', timestamp: 1700000000, timezoneOffset: 0 };

let fs: FileSystem;
let shell: Shell;
let gfs: any;
let realFetch: typeof fetch;
/** Repositories by "owner/name": their git data, and their releases newest first */
const repos = new Map<string, FakeGitHub>();
const releases = new Map<string, { tag_name: string; assets: { name: string; body: string }[] }[]>();
const calls: string[] = [];
let commits = 0;

async function publish(target: FakeGitHub, files: Record<string, string>): Promise<string> {
  const dir = `/tmp/ext-src-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs: gfs, dir, defaultBranch: 'main' });
  for (const [path, text] of Object.entries(files)) {
    await fs.writeFile(`${dir}/${path}`, text);
    await git.add({ fs: gfs, dir, filepath: path });
  }
  const parent = target.refs.get('main');
  const tip = await git.commit({ fs: gfs, dir, message: `Commit ${++commits}`, author: who, committer: who, ...(parent ? { parent: [parent] } : {}) });
  const walk = async (oid: string): Promise<void> => {
    if (target.objects.has(oid)) return;
    const { type, object } = await git.readObject({ fs: gfs, dir, oid, format: 'content' }).catch(() => ({ type: '', object: null }));
    if (!object) return; // the parent: already there
    const bytes = Uint8Array.from(object as Uint8Array);
    target.objects.set(oid, { type: type as any, bytes });
    if (type === 'commit') { const c = parseCommit(bytes); await walk(c.tree); for (const p of c.parents) await walk(p); }
    else if (type === 'tree') for (const e of parseTree(bytes)) await walk(e.sha);
  };
  await walk(tip);
  target.refs.set('main', tip);
  return tip;
}

/** GitHub for these tests: releases and the contents check here, everything git through the fakes */
const github = (async (input: any, init: any = {}) => {
  const url = new URL(String(input));
  const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(url.pathname);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.host === 'api.github.com' && m) {
    const [, full, rest = ''] = m;
    calls.push(`${init.method ?? 'GET'} ${url.pathname}`);
    const list = releases.get(full) ?? [];
    const shape = (r: (typeof list)[number]) => ({
      tag_name: r.tag_name,
      assets: r.assets.map((a, i) => ({
        name: a.name, size: a.body.length,
        url: `https://api.github.com/repos/${full}/releases/assets/${r.tag_name}-${i}`,
        browser_download_url: `https://github.com/${full}/releases/download/${r.tag_name}/${a.name}`,
      })),
    });
    if (rest === '/releases/latest') return list.length ? json(200, shape(list[0])) : json(404, { message: 'Not Found' });
    let t: RegExpExecArray | null;
    if ((t = /^\/releases\/tags\/(.+)$/.exec(rest))) {
      const r = list.find((x) => x.tag_name === decodeURIComponent(t![1]));
      return r ? json(200, shape(r)) : json(404, { message: 'Not Found' });
    }
    if ((t = /^\/releases\/assets\/(.+)-(\d+)$/.exec(rest))) {
      const a = list.find((x) => x.tag_name === t![1])?.assets[Number(t[2])];
      if (!a) return json(404, { message: 'Not Found' });
      expect(new Headers(init.headers).get('accept')).toBe('application/octet-stream');
      return new Response(new TextEncoder().encode(a.body), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    const repo = repos.get(full);
    if (!repo) return json(404, { message: 'Not Found' });
    if ((t = /^\/contents\/([^/]+)$/.exec(rest)) && (init.method ?? 'GET') === 'GET') {
      // (the executable is looked for at the top of the default branch)
      const tip = repo.refs.get('main');
      const tree = tip ? parseTree(repo.objects.get(parseCommit(repo.objects.get(tip)!.bytes).tree)!.bytes) : [];
      return tree.some((e) => e.path === t![1]) ? json(200, { name: t[1], type: 'file' }) : json(404, { message: 'Not Found' });
    }
    if (rest === '') return json(200, { full_name: full, default_branch: 'main', private: false });
    return repo.fetch(input, init);
  }
  const first = [...repos.values()][0];
  return first ? first.fetch(input, init) : json(404, { message: 'Not Found' });
}) as typeof fetch;

async function gh(args: string): Promise<{ out: string; err: string; code: number }> {
  let out = '';
  let err = '';
  const code = await shell.execute(`gh ${args}`, (s: string) => { out += s; }, (s: string) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  gfs = fs.toIsomorphicGitFS();
  shell.commands.register(ghCmd);
  shell.env['TABCOMPUTER_NETWORK_MODE'] = 'private';
  shell.env['TABCOMPUTER_GITHUB_PROMPT'] = '0';
  shell.env['HOME'] = HOME;
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(`${HOME}/.gitconfig`, '[user]\n\tname = Ann Lee\n\temail = ann@x.org\n');
  realFetch = globalThis.fetch;
  globalThis.fetch = github;
  localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
});
afterAll(() => { globalThis.fetch = realFetch; localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY); });

describe('release assets', () => {
  it('knows the platform an asset is for', () => {
    expect(assetPlatform('gh-student_linux-amd64')).toBe('linux-amd64');
    expect(assetPlatform('gh-dash_v4.26.1_darwin-arm64')).toBe('darwin-arm64');
    expect(assetPlatform('gh-x-windows-amd64.exe')).toBe('windows-amd64');
    expect(assetPlatform('checksums.txt')).toBeNull();
  });

  it('picks the linux-amd64 build, and tells a precompiled extension from one that is not', () => {
    const asset = (name: string) => ({ name, url: '', browser_download_url: '', size: 1 });
    const r = { tag_name: 'v1', assets: ['checksums.txt', 'gh-x_darwin-arm64', 'gh-x_linux-amd64', 'gh-x_linux-arm64', 'gh-x_windows-amd64.exe'].map(asset) };
    expect(pickAsset(r).asset?.name).toBe('gh-x_linux-amd64');
    expect(pickAsset(r).binary).toBe(true);
    const mac = pickAsset({ tag_name: 'v1', assets: ['gh-x_darwin-arm64', 'gh-x_windows-amd64.exe'].map(asset) });
    expect(mac).toMatchObject({ binary: true, asset: null, platforms: ['darwin-arm64', 'windows-amd64'] });
    expect(pickAsset({ tag_name: 'v1', assets: [asset('notes.pdf')] }).binary).toBe(false);
    expect(pickAsset(null).binary).toBe(false);
  });
});

describe('a script extension', () => {
  const SCRIPT = [
    '#!/usr/bin/env bash',
    'set -e',
    'if [ "$1" = "--help" ]; then echo "Usage: gh hello [NAME]"; exit 0; fi',
    'echo "hello ${1:-world} from $(basename "$0")"',
    'echo "token ${GH_TOKEN:+is set}"',
    'if [ "$1" = "fail" ]; then echo "no such person" >&2; exit 7; fi',
    '',
  ].join('\n');

  it('is cloned, listed and run as `gh NAME` with the sign-in in GH_TOKEN', async () => {
    const repo = fakeGitHub('ann', 'gh-hello');
    repos.set('ann/gh-hello', repo);
    const tip = await publish(repo, { 'gh-hello': SCRIPT, 'README.md': '# gh-hello\n' });

    expect((await gh('extension list')).err).toBe('no installed extensions found\n');
    const r = await gh('extension install ann/gh-hello');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(await fs.readFile(`${extensionsDir({ HOME })}/gh-hello/gh-hello`, 'utf8')).toBe(SCRIPT);

    expect((await gh('extension list')).out).toBe(`gh hello\tann/gh-hello\t${tip.slice(0, 8)}\n`);
    expect((await gh('hello --help')).out).toBe('Usage: gh hello [NAME]\n');
    const run = await gh('hello Ann');
    expect(run.out).toBe('hello Ann from gh-hello\ntoken is set\n');
    expect(run.code).toBe(0);
    // its exit status and its stderr are the extension's
    const failed = await gh('hello fail');
    expect(failed.code).toBe(7);
    expect(failed.err).toBe('no such person\n');
    expect((await gh('extension exec hello Bo')).out).toMatch(/^hello Bo from gh-hello\n/);
    // the token is the extension's alone: the shell that ran it has none
    expect(shell.env.GH_TOKEN).toBeUndefined();
    // without a sign-in it still runs, with no token
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    expect((await gh('hello')).out).toBe('hello world from gh-hello\ntoken \n');
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
  }, 60_000);

  it('refuses a second install, upgrades to the newest commit, and is removed', async () => {
    const again = await gh('extension install ann/gh-hello');
    expect(again.code).toBe(1);
    expect(again.err).toBe('there is already an installed extension that provides the "hello" command\n');

    expect((await gh('extension upgrade hello')).out).toBe('[hello]: already up to date\n');
    const before = (await gh('extension list')).out.trim().split('\t')[2];
    const tip = await publish(repos.get('ann/gh-hello')!, { 'gh-hello': SCRIPT.replace('hello ${1:-world}', 'hi ${1:-world}'), 'README.md': '# gh-hello\n' });
    expect((await gh('extension upgrade --all --dry-run')).out).toBe(`[hello]: would have upgraded from ${before} to ${tip.slice(0, 8)}\n`);
    expect((await gh('hello')).out).toMatch(/^hello world/);
    expect((await gh('extension upgrade --all')).out).toBe(`[hello]: upgraded from ${before} to ${tip.slice(0, 8)}\n`);
    expect((await gh('hello')).out).toMatch(/^hi world from gh-hello\n/);

    expect((await gh('extension remove hello')).code).toBe(0);
    expect(await fs.exists(`${extensionsDir({ HOME })}/gh-hello`)).toBe(false);
    const gone = await gh('hello');
    expect(gone.code).toBe(1);
    expect(gone.err).toMatch(/'hello' is not a valid command/);
    expect((await gh('extension remove hello')).err).toBe('no extension found: "hello"\n');
  }, 60_000);

  it('says why a repository is not an extension', async () => {
    expect((await gh('extension install ann/hello')).err).toBe('extension repository name must start with `gh-`\n');
    expect((await gh('extension install ann/gh-pr')).err).toBe('"pr" matches the name of a built-in command or alias\n');
    expect((await gh('extension install gh-hello')).err).toBe('expected the "OWNER/REPO" format, got "gh-hello"\n');
    const empty = fakeGitHub('ann', 'gh-empty');
    repos.set('ann/gh-empty', empty);
    await publish(empty, { 'README.md': 'nothing to run\n' });
    expect((await gh('extension install ann/gh-empty')).err).toBe('extension is not installable: missing executable\n');
    expect((await gh('extension install ann/gh-nowhere')).err).toMatch(/^Could not find extension 'ann\/gh-nowhere' on host github\.com/);
    expect((await gh('extension upgrade')).err).toBe('specify an extension to upgrade or `--all`\n');
    expect((await gh('extension')).out).toMatch(/gh extension install OWNER\/REPO/);
  }, 60_000);

  it('installs a folder of this computer as a link', async () => {
    await fs.mkdir('/home/user/src/gh-local', { recursive: true });
    await fs.writeFile('/home/user/src/gh-local/gh-local', '#!/bin/sh\necho local one\n');
    shell.cwd = '/home/user/src/gh-local';
    expect((await gh('extension install .')).code).toBe(0);
    expect((await gh('local')).out).toBe('local one\n');
    await fs.writeFile('/home/user/src/gh-local/gh-local', '#!/bin/sh\necho local two\n');
    expect((await gh('local')).out).toBe('local two\n');
    expect((await gh('extension list')).out).toBe('gh local\t\t\n');
    expect((await gh('extension remove local')).code).toBe(0);
    expect(await fs.exists('/home/user/src/gh-local/gh-local')).toBe(true);
    shell.cwd = HOME;
  }, 60_000);
});

describe('a precompiled extension', () => {
  const build = (tag: string, os: string) => `#!/bin/sh\necho "tool ${tag} for ${os}: $*"\n`;
  const release = (tag: string, platforms: string[]) => ({
    tag_name: tag,
    assets: [{ name: 'checksums.txt', body: 'sums\n' }, ...platforms.map((p) => ({ name: `gh-tool_${tag}_${p}${p.startsWith('windows') ? '.exe' : ''}`, body: build(tag, p) }))],
  });

  it('is installed from the linux-amd64 asset of its latest release, and upgraded by tag', async () => {
    releases.set('ann/gh-tool', [release('v1.0.0', ['darwin-arm64', 'linux-amd64', 'linux-arm64', 'windows-amd64'])]);
    calls.length = 0;
    const r = await gh('extension install ann/gh-tool');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // no clone: one release lookup and one asset download
    expect(calls).toEqual(['GET /repos/ann/gh-tool/releases/latest', 'GET /repos/ann/gh-tool/releases/assets/v1.0.0-2']);
    const dir = `${extensionsDir({ HOME })}/gh-tool`;
    expect(await fs.readFile(`${dir}/gh-tool`, 'utf8')).toBe(build('v1.0.0', 'linux-amd64'));
    expect(await fs.readFile(`${dir}/manifest.yml`, 'utf8')).toBe(
      `owner: ann\nname: gh-tool\nhost: github.com\ntag: v1.0.0\nispinned: false\npath: ${dir}/gh-tool\n`);
    expect((await gh('tool a "b c"')).out).toBe('tool v1.0.0 for linux-amd64: a b c\n');
    expect((await gh('extension list')).out).toBe('gh tool\tann/gh-tool\tv1.0.0\n');

    expect((await gh('extension upgrade tool')).out).toBe('[tool]: already up to date\n');
    releases.get('ann/gh-tool')!.unshift(release('v1.1.0', ['linux-amd64']));
    expect((await gh('extension upgrade tool --dry-run')).out).toBe('[tool]: would have upgraded from v1.0.0 to v1.1.0\n');
    expect((await gh('extension upgrade tool')).out).toBe('[tool]: upgraded from v1.0.0 to v1.1.0\n');
    expect((await gh('tool')).out).toBe('tool v1.1.0 for linux-amd64: \n');
    expect((await gh('extension remove tool')).code).toBe(0);
  }, 60_000);

  it('can be pinned to a tag, which upgrade then leaves alone', async () => {
    expect((await gh('extension install ann/gh-tool --pin v1.0.0')).code).toBe(0);
    expect((await gh('tool')).out).toBe('tool v1.0.0 for linux-amd64: \n');
    const up = await gh('extension upgrade tool');
    expect(up.out).toBe('[tool]: pinned extensions can not be upgraded\n');
    expect(up.code).toBe(1);
    expect((await gh('extension upgrade tool --force')).out).toBe('[tool]: upgraded from v1.0.0 to v1.1.0\n');
    expect((await gh('extension remove tool')).code).toBe(0);
    expect((await gh('extension install ann/gh-tool --pin v9')).err).toMatch(/Could not find extension|missing executable/);
  }, 60_000);

  it('says so in one line when the release has no linux-amd64 build', async () => {
    releases.set('ann/gh-maconly', [release('v2', ['darwin-arm64', 'windows-amd64'])]);
    const r = await gh('extension install ann/gh-maconly');
    expect(r.code).toBe(1);
    expect(r.err).toBe("gh-maconly unsupported for linux-amd64 (its release has darwin-arm64, windows-amd64; this computer runs linux-amd64 programs). Open an issue: `gh issue create -R ann/gh-maconly -t'Support linux-amd64'`\n");
    expect(await fs.exists(`${extensionsDir({ HOME })}/gh-maconly`)).toBe(false);
  }, 60_000);
});
