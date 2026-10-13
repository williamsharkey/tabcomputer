/**
 * clone, fetch and push through GitHub's REST API (src/commands/git-github-api.ts),
 * the private network mode's git transport, against an in-memory GitHub
 * (git-github-api-fake.ts) that keeps objects under their real sha1. The
 * repositories it serves are made here with isomorphic-git, so every sha in
 * these tests is one git computed.
 *
 * TABCOMPUTER_GITHUB_LIVE=1 also runs the last block against api.github.com
 * (read-only, about 20 unauthenticated requests).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import git from '@shiro/commands/git-cached';
import {
  parseGitHubRemote, apiCloneEstimate, apiClone, apiFetch, apiPush, rebuildCommit, GitHubApiError,
  DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES,
} from '@shiro/commands/git-github-api';
import { fakeGitHub, parseCommit, parseTree, sha1, type FakeGitHub } from './git-github-api-fake';

let fs: FileSystem;
let gfs: any;
beforeAll(async () => {
  fs = new FileSystem();
  await fs.init();
  gfs = fs.toIsomorphicGitFS();
});

let serial = 0;
const tmp = (name: string) => `/tmp/gha/${name}-${++serial}`;
const T0 = 1700000000;
/** isomorphic-git's timezoneOffset is minutes behind UTC: -540 is +0900 */
const who = (t: number, tz = 0) => ({ name: 'Ann Lee', email: 'ann@x.org', timestamp: t, timezoneOffset: tz });
const enc = new TextEncoder();

/** Write, add (or with null: remove) and commit */
async function commit(dir: string, files: Record<string, string | null>, message: string, o: { t?: number; tz?: number; ctz?: number } = {}): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      await fs.unlink(`${dir}/${path}`);
      await git.remove({ fs: gfs, dir, filepath: path });
      continue;
    }
    await fs.mkdir(`${dir}/${path}`.replace(/\/[^/]*$/, ''), { recursive: true });
    await fs.writeFile(`${dir}/${path}`, text);
    await git.add({ fs: gfs, dir, filepath: path });
  }
  const t = o.t ?? T0;
  return git.commit({ fs: gfs, dir, message, author: who(t, o.tz), committer: who(t + 5, o.ctz ?? o.tz) });
}

const raw = async (dir: string, oid: string) => Uint8Array.from((await git.readObject({ fs: gfs, dir, oid, format: 'content' })).object as Uint8Array);
/** Store a commit made of `oid`'s bytes changed by `edit`; returns the new oid */
async function recommit(dir: string, oid: string, edit: (text: string) => string): Promise<string> {
  return git.writeObject({ fs: gfs, dir, type: 'commit', format: 'content', object: enc.encode(edit(new TextDecoder().decode(await raw(dir, oid)))) });
}

/** Copy everything `branch` reaches from the repository in `dir` to the fake, and point its branch there */
async function publish(gh: FakeGitHub, dir: string, branch = 'main'): Promise<string> {
  const tip = await git.resolveRef({ fs: gfs, dir, ref: branch });
  const walk = async (oid: string): Promise<void> => {
    if (gh.objects.has(oid)) return;
    const { type, object } = await git.readObject({ fs: gfs, dir, oid, format: 'content' });
    const bytes = Uint8Array.from(object as Uint8Array);
    expect(sha1(type!, bytes)).toBe(oid);
    gh.objects.set(oid, { type: type as any, bytes });
    if (type === 'commit') {
      const c = parseCommit(bytes);
      await walk(c.tree);
      for (const p of c.parents) await walk(p);
    } else if (type === 'tree') {
      for (const e of parseTree(bytes)) if (e.mode !== '160000') await walk(e.sha);
    }
  };
  await walk(tip);
  gh.refs.set(branch, tip);
  return tip;
}

const SIG = '-----BEGIN PGP SIGNATURE-----\n\nwsFcBAABCAAQBQJqzJXMCRC1aQ7uu5UhlAAAxrYQADWeVEngnAjOtpE8od6VrHwC\n=Kquy\n-----END PGP SIGNATURE-----';
const SUBMODULE = '1234567890abcdef1234567890abcdef12345678';

/**
 * A repository with what the API makes hard: commits in +0900, in -0330 with
 * a +0200 committer, a merge, a signed commit, and a tip with an executable,
 * a symlink, a submodule and nested directories. Returns the work tree and
 * the first-parent history, oldest first.
 */
async function upstream(): Promise<{ dir: string; oids: string[] }> {
  const dir = tmp('up');
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs: gfs, dir, defaultBranch: 'main' });
  const c1 = await commit(dir, { 'README.md': '# proj\n', 'src/a.js': 'a1\n', 'src/lib/b.js': 'b\n' }, 'first', { t: T0, tz: -540 });
  await git.branch({ fs: gfs, dir, ref: 'side' });
  const c2 = await commit(dir, { 'src/a.js': 'a2\n' }, 'second\n\nwith a body', { t: T0 + 100, tz: 210, ctz: -120 });
  await git.checkout({ fs: gfs, dir, ref: 'side' });
  await commit(dir, { 'docs/x.md': 'x\n' }, 'side work', { t: T0 + 150, tz: 480 });
  await git.checkout({ fs: gfs, dir, ref: 'main' });
  const merged = await git.merge({ fs: gfs, dir, ours: 'main', theirs: 'side', message: 'Merge side', author: who(T0 + 200, -60), committer: who(T0 + 200, -60) });
  const c3 = merged.oid!;
  await git.checkout({ fs: gfs, dir, ref: 'main', force: true });
  // A signed commit: the gpgsig header goes last, continuation lines start with a space
  const plain = await commit(dir, { 'src/a.js': 'a3\n' }, 'signed', { t: T0 + 300, tz: -120 });
  const c4 = await recommit(dir, plain, text => text.replace('\n\n', `\ngpgsig ${SIG.replace(/\n/g, '\n ')}\n\n`));
  // The tip: modes a tree can carry
  const { tree } = await git.readTree({ fs: gfs, dir, oid: c4 });
  const blob = (text: string) => git.writeBlob({ fs: gfs, dir, blob: enc.encode(text) });
  const top = await git.writeTree({
    fs: gfs, dir, tree: [...tree,
      { mode: '100755', path: 'run.sh', oid: await blob('#!/bin/sh\necho hi\n'), type: 'blob' },
      { mode: '120000', path: 'link', oid: await blob('README.md'), type: 'blob' },
      { mode: '160000', path: 'vendor', oid: SUBMODULE, type: 'commit' },
    ],
  });
  const c5 = await git.writeCommit({ fs: gfs, dir, commit: { tree: top, parent: [c4], author: who(T0 + 400, 300), committer: who(T0 + 400, 300), message: 'modes\n' } });
  await git.writeRef({ fs: gfs, dir, ref: 'refs/heads/main', value: c5, force: true });
  return { dir, oids: [c1, c2, c3, c4, c5] };
}

/** Options for the fake; a null token is signed out */
const base = (gh: FakeGitHub, dir: string, token: string | null = 'tok') => ({ fs: gfs, dir, owner: 'ann', repo: 'proj', token: token ?? undefined, fetchImpl: gh.fetch });
const read = (p: string) => fs.readFile(p, 'utf8') as Promise<string>;
const logOids = async (dir: string, ref = 'main') => (await git.log({ fs: gfs, dir, ref })).map(c => c.oid);
/** Paths whose work tree or index differs from HEAD */
const dirty = async (dir: string) => (await git.statusMatrix({ fs: gfs, dir })).filter(r => !(r[1] === 1 && r[2] === 1 && r[3] === 1)).map(r => r[0]);
const failure = async (p: Promise<unknown>): Promise<GitHubApiError> => {
  const e = await p.then(() => null, x => x);
  expect(e).toBeInstanceOf(GitHubApiError);
  return e;
};

/** A published upstream and a clone of it */
async function cloned(o: { depth?: number; token?: string | null } = {}) {
  const gh = fakeGitHub();
  const up = await upstream();
  const tip = await publish(gh, up.dir);
  const dir = tmp('clone');
  const res = await apiClone({ ...base(gh, dir, o.token === undefined ? 'tok' : o.token), depth: o.depth });
  return { gh, up, tip, dir, res };
}

describe('parseGitHubRemote', () => {
  it('reads owner and repo from every form of github.com remote', () => {
    const want = { owner: 'ann', repo: 'my.proj' };
    for (const url of [
      'https://github.com/ann/my.proj', 'https://github.com/ann/my.proj.git', 'https://github.com/ann/my.proj/',
      'https://x-access-token@github.com/ann/my.proj.git', 'https://ann:secret@github.com/ann/my.proj',
      'http://github.com/ann/my.proj.git', 'git@github.com:ann/my.proj.git', 'git@github.com:ann/my.proj',
      'ssh://git@github.com/ann/my.proj.git', 'ssh://git@github.com:22/ann/my.proj', 'git://github.com/ann/my.proj.git',
      'https://www.github.com/ann/my.proj',
    ]) expect(parseGitHubRemote(url), url).toEqual(want);
    for (const url of [
      undefined, '', 'https://gitlab.com/ann/proj.git', 'https://github.com/ann', 'https://github.com/ann/proj/tree/main',
      'https://github.com.evil.org/ann/proj', 'https://evil.org/github.com/ann/proj', 'git@gitlab.com:ann/proj.git', '/home/user/proj',
    ]) expect(parseGitHubRemote(url), String(url)).toBeNull();
  });
});

describe('commits come back byte for byte', () => {
  it('finds the timezone offsets and the newline the API leaves out, and reattaches a signature', async () => {
    const gh = fakeGitHub();
    const up = await upstream();
    await publish(gh, up.dir);
    for (const oid of up.oids) {
      const j = await (await gh.fetch(`https://api.github.com/repos/ann/proj/git/commits/${oid}`)).json();
      // What the module has to work from: UTC dates
      expect(j.author.date).toMatch(/Z$/);
      const c = { sha: oid, tree: j.tree.sha, parents: j.parents.map((p: any) => p.sha), author: j.author, committer: j.committer, message: j.message, signature: j.verification.signature, payload: j.verification.payload };
      const bytes = await rebuildCommit(c);
      expect(bytes && sha1('commit', bytes), oid).toBe(oid);
      expect(bytes).toEqual(await raw(up.dir, oid));
    }
  });

  it('gives null for a commit with a header the API does not report', async () => {
    const up = await upstream();
    const odd = await recommit(up.dir, up.oids[1], t => t.replace('\n\n', '\nencoding ISO-8859-1\n\n'));
    const c = parseCommit(await raw(up.dir, odd));
    expect(await rebuildCommit({ sha: odd, tree: c.tree, parents: c.parents, author: c.author, committer: c.committer, message: c.message })).toBeNull();
  });
});

describe('apiClone', () => {
  it('depth 1 by default: one commit, a shallow boundary, a normal repository', async () => {
    const { gh, tip, dir, res } = await cloned();
    expect(res).toEqual({ branch: 'main', oid: tip, commits: 1, blobs: 6, shallow: true });
    expect(await git.currentBranch({ fs: gfs, dir })).toBe('main');
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/heads/main' })).toBe(tip);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/main' })).toBe(tip);
    expect(await read(`${dir}/.git/shallow`)).toBe(tip + '\n');
    expect(await logOids(dir)).toEqual([tip]);
    const cfg = (path: string) => git.getConfig({ fs: gfs, dir, path });
    expect(await cfg('remote.origin.url')).toBe('https://github.com/ann/proj.git');
    expect(await cfg('remote.origin.fetch')).toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await cfg('branch.main.remote')).toBe('origin');
    expect(await cfg('branch.main.merge')).toBe('refs/heads/main');
    expect(await read(`${dir}/src/a.js`)).toBe('a3\n');
    expect(await read(`${dir}/src/lib/b.js`)).toBe('b\n');
    expect(await read(`${dir}/docs/x.md`)).toBe('x\n');
    expect(await dirty(dir)).toEqual([]);
    // repository, ref, one page of commits, one recursive tree, a request per blob; signed in, all from the API
    expect(gh.count(/^GET .*\/git\/blobs\//)).toBe(6);
    expect(gh.count(/^RAW /)).toBe(0);
    expect(gh.calls.length).toBe(10);
  });

  it('keeps file modes: executable, symlink, submodule', async () => {
    const { tip, dir } = await cloned();
    const { tree } = await git.readTree({ fs: gfs, dir, oid: tip });
    const mode = (p: string) => tree.find(e => e.path === p)?.mode;
    expect([mode('run.sh'), mode('link'), mode('vendor'), mode('src'), mode('README.md')]).toEqual(['100755', '120000', '160000', '040000', '100644']);
    expect(tree.find(e => e.path === 'vendor')?.oid).toBe(SUBMODULE);
    expect(await fs.readlink(`${dir}/link`)).toBe('README.md');
    expect((await fs.stat(`${dir}/run.sh`)).mode & 0o111).not.toBe(0);
  });

  it('the whole history with depth 0 or Infinity: every commit under its own sha, shared objects fetched once', async () => {
    for (const depth of [0, Infinity]) {
      const { gh, up, tip, dir, res } = await cloned({ depth });
      expect(res.oid).toBe(tip);
      expect(res.shallow).toBe(false);
      expect(await fs.exists(`${dir}/.git/shallow`)).toBe(false);
      const want = await logOids(up.dir);
      expect(want.length).toBe(6);
      expect(res.commits).toBe(6);
      expect((await logOids(dir)).sort()).toEqual([...want].sort());
      for (const oid of want) expect(await raw(dir, oid), oid).toEqual(await raw(up.dir, oid));
      // 8 distinct blobs in the history, each asked for once
      expect(gh.count(/\/git\/blobs\//)).toBe(8);
      expect(res.blobs).toBe(8);
      // An old commit checks out
      await git.checkout({ fs: gfs, dir, ref: up.oids[0], force: true });
      expect(await read(`${dir}/src/a.js`)).toBe('a1\n');
    }
  });

  it('depth 3 stops three commits deep', async () => {
    const { up, dir } = await cloned({ depth: 3 });
    const [, , c3, c4, c5] = up.oids;
    expect((await logOids(dir)).slice(0, 3)).toEqual([c5, c4, c3]);
    expect((await read(`${dir}/.git/shallow`)).trim()).toBe(c3);
  });

  it('without a token the file contents come from the raw host, the symlink from the API', async () => {
    const { gh, tip, dir } = await cloned({ token: null });
    expect(gh.count(/^RAW /)).toBe(6);
    expect(gh.count(/^GET .*\/git\/blobs\//)).toBe(1);
    expect(gh.calls).toContain(`RAW /ann/proj/${tip}/src/lib/b.js`);
    expect(await dirty(dir)).toEqual([]);
  });

  it('a branch other than the default, and one that does not exist', async () => {
    const gh = fakeGitHub();
    const up = await upstream();
    await publish(gh, up.dir);
    const side = await publish(gh, up.dir, 'side');
    const dir = tmp('clone');
    expect((await apiClone({ ...base(gh, dir), ref: 'side' })).oid).toBe(side);
    expect(await git.currentBranch({ fs: gfs, dir })).toBe('side');
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/side' })).toBe(side);
    const e = await failure(apiClone({ ...base(gh, tmp('clone')), ref: 'nope' }));
    expect([e.code, e.message]).toEqual(['not-found', 'Remote branch nope not found in ann/proj']);
  });

  it('noCheckout leaves the work tree empty; onProgress counts objects and requests', async () => {
    const gh = fakeGitHub();
    await publish(gh, (await upstream()).dir);
    const dir = tmp('clone');
    const seen: string[] = [];
    await apiClone({ ...base(gh, dir), noCheckout: true, onProgress: m => seen.push(m) });
    expect((await fs.readdir(dir)).sort()).toEqual(['.git']);
    expect(seen.filter(m => /^Receiving objects: \d\/6 \(commit 1, \d+ requests\)$/.test(m)).length).toBe(6);
    expect(seen.some(m => m.startsWith('Receiving objects: 6/6 '))).toBe(true);
  });

  it('a truncated tree listing is walked tree by tree', async () => {
    const gh = fakeGitHub();
    const up = await upstream();
    const tip = await publish(gh, up.dir);
    gh.treeLimit = 3;
    expect((await apiCloneEstimate({ owner: 'ann', repo: 'proj', fetchImpl: gh.fetch })).truncated).toBe(true);
    const dir = tmp('clone');
    await apiClone({ ...base(gh, dir) });
    expect(await logOids(dir)).toEqual([tip]);
    expect(await read(`${dir}/src/lib/b.js`)).toBe('b\n');
    expect(await dirty(dir)).toEqual([]);
    // the root, src, src/lib, docs
    expect(gh.count(/^GET .*\/git\/trees\/[0-9a-f]{40}$/)).toBe(4);
  });

  it('history stops at the child of a commit that cannot be reproduced; such a tip is refused', async () => {
    const gh = fakeGitHub();
    const dir0 = tmp('up');
    await fs.mkdir(dir0, { recursive: true });
    await git.init({ fs: gfs, dir: dir0, defaultBranch: 'main' });
    await commit(dir0, { a: '1\n' }, 'one');
    const plain = await commit(dir0, { a: '2\n' }, 'two', { t: T0 + 10 });
    const odd = await recommit(dir0, plain, t => t.replace('\n\n', '\nencoding ISO-8859-1\n\n'));
    await git.writeRef({ fs: gfs, dir: dir0, ref: 'refs/heads/main', value: odd, force: true });
    await publish(gh, dir0);
    const e = await failure(apiClone({ ...base(gh, tmp('clone')) }));
    expect(e.code).toBe('unsupported');
    expect(e.message).toContain(odd);

    const top = await commit(dir0, { a: '3\n' }, 'three', { t: T0 + 20 });
    await publish(gh, dir0);
    const dir = tmp('clone');
    const said: string[] = [];
    const res = await apiClone({ ...base(gh, dir), depth: 0, onProgress: m => said.push(m) });
    expect(res).toMatchObject({ oid: top, commits: 1, shallow: true });
    expect(await read(`${dir}/.git/shallow`)).toBe(top + '\n');
    expect(await logOids(dir)).toEqual([top]);
    expect(said.join('\n')).toContain(`history stops at ${top.slice(0, 7)}`);
  });

  it('an empty repository clones to an empty one', async () => {
    const gh = fakeGitHub();
    const dir = tmp('clone');
    expect(await apiClone({ ...base(gh, dir) })).toEqual({ branch: 'main', oid: '', commits: 0, blobs: 0, shallow: false });
    expect(await git.currentBranch({ fs: gfs, dir })).toBe('main');
    expect(await git.getConfig({ fs: gfs, dir, path: 'remote.origin.url' })).toBe('https://github.com/ann/proj.git');
  });
});

describe('apiCloneEstimate and the limits', () => {
  it('reports the branch, its tip, the files and their bytes in three requests (two with a ref)', async () => {
    const gh = fakeGitHub();
    const tip = await publish(gh, (await upstream()).dir);
    const o = { owner: 'ann', repo: 'proj', fetchImpl: gh.fetch };
    // README 7, a.js 3, b.js 2, x.md 2, run.sh 18, link 9
    expect(await apiCloneEstimate(o)).toEqual({ branch: 'main', oid: tip, files: 6, bytes: 41, truncated: false });
    expect(gh.calls.length).toBe(3);
    await apiCloneEstimate({ ...o, ref: 'main' });
    expect(gh.calls.length).toBe(5);
    expect((await apiCloneEstimate({ owner: 'ann', repo: 'proj', fetchImpl: fakeGitHub().fetch })).oid).toBe('');
    expect([DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES]).toEqual([2000, 100_000_000]);
  });

  it('refuses a clone over the limits before writing anything', async () => {
    const gh = fakeGitHub();
    await publish(gh, (await upstream()).dir);
    for (const limit of [{ maxFiles: 5 }, { maxBytes: 40 }]) {
      const dir = tmp('clone');
      const e = await failure(apiClone({ ...base(gh, dir), ...limit }));
      expect(e.code).toBe('too-large');
      expect(e.message).toMatch(/^ann\/proj has 6 files \(0\.0 MB\), one request each: more than the limit of /);
      expect(await fs.exists(dir)).toBe(false);
      expect(gh.count(/blobs/)).toBe(0);
    }
  });

  it('a full clone that runs out of budget keeps what it has as a shallow clone', async () => {
    const gh = fakeGitHub();
    const up = await upstream();
    const tip = await publish(gh, up.dir);
    const dir = tmp('clone');
    // the tip's 6 blobs and the merge's src/a.js fit; the first version of src/a.js, which both of the merge's parents lead to, doesn't
    const res = await apiClone({ ...base(gh, dir), depth: 0, maxFiles: 7 });
    expect(res).toMatchObject({ oid: tip, shallow: true, blobs: 7 });
    const [, c2, c3, c4, c5] = up.oids;
    expect(await logOids(dir)).toEqual([c5, c4, c3]);
    // Every commit stored without its parents is a boundary, also the merge's first parent, which no log reaches yet
    expect((await read(`${dir}/.git/shallow`)).trim().split('\n').sort()).toEqual([c2, c3].sort());
    expect(await dirty(dir)).toEqual([]);
  });
});

describe('apiPush', () => {
  it('a local commit goes up under its own sha, with only the new objects', async () => {
    const { gh, dir, tip } = await cloned();
    const mine = await commit(dir, { 'src/a.js': 'mine\n', 'new/deep/file.txt': 'new\n' }, 'my change', { t: T0 + 1000, tz: -330 });
    gh.calls.length = 0;
    const said: string[] = [];
    const res = await apiPush({ ...base(gh, dir), onProgress: m => said.push(m) });
    expect(res).toEqual({ ok: true, oid: mine, created: false, commits: 1, rewritten: false });
    expect(gh.refs.get('main')).toBe(mine);
    expect(gh.objects.get(mine)!.bytes).toEqual(await raw(dir, mine));
    expect(parseCommit(gh.objects.get(mine)!.bytes).parents).toEqual([tip]);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/main' })).toBe(mine);
    // 2 blobs; the trees new/deep, new, src and the root; the commit; the ref read and its update
    expect(gh.count(/^POST .*\/git\/blobs$/)).toBe(2);
    expect(gh.count(/^POST .*\/git\/trees$/)).toBe(4);
    expect(gh.count(/^POST .*\/git\/commits$/)).toBe(1);
    expect(gh.count(/^PATCH /)).toBe(1);
    expect(gh.calls.length).toBe(9);
    expect(said.at(-1)).toMatch(/^Writing objects: 7 \(\d+ requests\)$/);
    // Nothing to do the second time
    expect(await apiPush({ ...base(gh, dir) })).toEqual({ ok: true, oid: mine, created: false, commits: 0, rewritten: false });
  });

  it('two commits, a deleted file and modes that are not 100644', async () => {
    const { gh, dir } = await cloned();
    const one = await commit(dir, { 'docs/x.md': null, 'run.sh': '#!/bin/sh\necho two\n' }, 'one', { t: T0 + 1000, tz: 420 });
    const two = await commit(dir, { 'README.md': '# more\n' }, 'two', { t: T0 + 1100, tz: 420 });
    expect(await apiPush({ ...base(gh, dir) })).toMatchObject({ ok: true, oid: two, commits: 2, rewritten: false });
    expect(gh.refs.get('main')).toBe(two);
    expect(parseCommit(gh.objects.get(two)!.bytes).parents).toEqual([one]);
    const top = parseTree(gh.objects.get(parseCommit(gh.objects.get(two)!.bytes).tree)!.bytes);
    expect(top.map(e => `${e.mode} ${e.path}`)).toEqual(['100644 README.md', '120000 link', '100755 run.sh', '40000 src', '160000 vendor']);
    // A fresh clone of what was pushed is the same commit
    const again = tmp('clone');
    expect((await apiClone({ ...base(gh, again), depth: 2 })).oid).toBe(two);
    expect(await read(`${again}/run.sh`)).toBe('#!/bin/sh\necho two\n');
  });

  it('a merge commit keeps both parents', async () => {
    const { gh, dir, tip } = await cloned();
    await git.branch({ fs: gfs, dir, ref: 'topic', checkout: true });
    const topic = await commit(dir, { 'topic.txt': 't\n' }, 'topic', { t: T0 + 1000 });
    await git.checkout({ fs: gfs, dir, ref: 'main' });
    const mainline = await commit(dir, { 'main.txt': 'm\n' }, 'mainline', { t: T0 + 1100 });
    const { oid: merge } = await git.merge({ fs: gfs, dir, ours: 'main', theirs: 'topic', message: 'Merge topic', author: who(T0 + 1200, -120), committer: who(T0 + 1200, -120) });
    const res = await apiPush({ ...base(gh, dir) });
    expect(res).toMatchObject({ ok: true, oid: merge, commits: 3, rewritten: false });
    expect(parseCommit(gh.objects.get(merge!)!.bytes).parents).toEqual([mainline, topic]);
    expect(parseCommit(gh.objects.get(topic)!.bytes).parents).toEqual([tip]);
  });

  it('is refused when the remote moved, and goes through with force', async () => {
    const { gh, up, dir, tip } = await cloned();
    const theirs = await commit(up.dir, { 'their.txt': 'theirs\n' }, 'theirs', { t: T0 + 900 });
    await git.checkout({ fs: gfs, dir: up.dir, ref: 'main', force: true }).catch(() => {});
    await publish(gh, up.dir);
    const mine = await commit(dir, { 'mine.txt': 'mine\n' }, 'mine', { t: T0 + 1000 });
    gh.calls.length = 0;
    const res = await apiPush({ ...base(gh, dir) });
    expect(res).toMatchObject({ ok: false, oid: theirs, commits: 0 });
    expect(res.error).toMatch(/^non-fast-forward: main on GitHub has commits this branch lacks/);
    expect(gh.refs.get('main')).toBe(theirs);
    expect(gh.count(/^(POST|PATCH|PUT) /)).toBe(0);
    // The stale tracking ref is left for a fetch to move
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/main' })).toBe(tip);

    expect(await apiPush({ ...base(gh, dir), force: true })).toMatchObject({ ok: true, oid: mine, commits: 1 });
    expect(gh.refs.get('main')).toBe(mine);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/main' })).toBe(mine);
  });

  it('is refused when the branch moves while the objects go up (GitHub\'s 422)', async () => {
    const { gh, up, dir } = await cloned();
    const theirs = await commit(up.dir, { 'their.txt': 'theirs\n' }, 'theirs', { t: T0 + 900 });
    await publish(gh, up.dir);
    gh.refs.set('main', (await logOids(up.dir))[1]);
    await commit(dir, { 'mine.txt': 'mine\n' }, 'mine', { t: T0 + 1000 });
    gh.hook = (call) => { if (call.startsWith('PATCH ')) gh.refs.set('main', theirs); };
    const res = await apiPush({ ...base(gh, dir) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^non-fast-forward/);
    expect(gh.refs.get('main')).toBe(theirs);
  });

  it('moves the local branch to GitHub\'s commits when GitHub stores them under other shas', async () => {
    const { gh, dir, tip } = await cloned();
    const one = await commit(dir, { 'one.txt': '1\n' }, 'one', { t: T0 + 1000, tz: -540 });
    const two = await commit(dir, { 'two.txt': '2\n' }, 'two', { t: T0 + 1100, tz: -540 });
    gh.normalizeDates = true;
    const res = await apiPush({ ...base(gh, dir) });
    expect(res).toMatchObject({ ok: true, commits: 2, rewritten: true, created: false });
    expect(res.oid).not.toBe(two);
    expect(gh.refs.get('main')).toBe(res.oid);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/heads/main' })).toBe(res.oid);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/main' })).toBe(res.oid);
    // The second commit was made on GitHub's version of the first
    const log = await git.log({ fs: gfs, dir, ref: 'main' });
    expect(log.map(c => c.commit.message)).toEqual(['two\n', 'one\n', 'modes\n']);
    expect(log[1].oid).not.toBe(one);
    expect(log[2].oid).toBe(tip);
    expect(log[0].commit.author).toMatchObject({ timestamp: T0 + 1100, timezoneOffset: 0 });
    for (const c of log.slice(0, 2)) expect(gh.objects.get(c.oid)!.bytes).toEqual(await raw(dir, c.oid));
    // Same trees: the work tree and index are still clean, and work goes on
    expect(await dirty(dir)).toEqual([]);
    gh.normalizeDates = false;
    const three = await commit(dir, { 'three.txt': '3\n' }, 'three', { t: T0 + 1200 });
    expect(await apiPush({ ...base(gh, dir) })).toMatchObject({ ok: true, oid: three, commits: 1, rewritten: false });
  });

  it('a signed commit goes up with its signature', async () => {
    const { gh, dir } = await cloned();
    const plain = await commit(dir, { 's.txt': 's\n' }, 'signed here', { t: T0 + 1000, tz: -120 });
    const signed = await recommit(dir, plain, t => t.replace('\n\n', `\ngpgsig ${SIG.replace(/\n/g, '\n ')}\n\n`));
    await git.writeRef({ fs: gfs, dir, ref: 'refs/heads/main', value: signed, force: true });
    expect(await apiPush({ ...base(gh, dir) })).toMatchObject({ ok: true, oid: signed, rewritten: false });
    expect(gh.objects.get(signed)!.bytes).toEqual(await raw(dir, signed));
  });

  it('creates a new branch, on commits GitHub already has', async () => {
    const { gh, dir, tip } = await cloned();
    await git.branch({ fs: gfs, dir, ref: 'feature/x', checkout: true });
    const mine = await commit(dir, { 'f.txt': 'f\n' }, 'feature', { t: T0 + 1000 });
    gh.calls.length = 0;
    expect(await apiPush({ ...base(gh, dir) })).toEqual({ ok: true, oid: mine, created: true, commits: 1, rewritten: false });
    expect(gh.refs.get('feature/x')).toBe(mine);
    expect(gh.refs.get('main')).toBe(tip);
    expect(gh.count(/^POST .*\/git\/refs$/)).toBe(1);
    expect(gh.count(/^POST .*\/git\/blobs$/)).toBe(1);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/feature/x' })).toBe(mine);
    // A branch with nothing new is only a ref
    await git.branch({ fs: gfs, dir, ref: 'same' });
    gh.calls.length = 0;
    expect(await apiPush({ ...base(gh, dir), branch: 'same' })).toMatchObject({ ok: true, oid: mine, created: true, commits: 0 });
    expect(gh.count(/^POST /)).toBe(1);
  });

  it('starts an empty repository through the contents API, then pushes the real history over it', async () => {
    const gh = fakeGitHub();
    const dir = tmp('clone');
    await apiClone({ ...base(gh, dir) });
    const one = await commit(dir, { 'README.md': 'hello\n' }, 'first', { tz: -60 });
    const two = await commit(dir, { 'b.txt': 'b\n' }, 'second', { t: T0 + 10, tz: -60 });
    expect(await apiPush({ ...base(gh, dir) })).toEqual({ ok: true, oid: two, created: true, commits: 2, rewritten: false });
    expect([...gh.refs]).toEqual([['main', two]]);
    expect(gh.count(/^PUT .*\/contents\/\.gitkeep$/)).toBe(1);
    expect(parseCommit(gh.objects.get(one)!.bytes).parents).toEqual([]);
    const three = await commit(dir, { 'c.txt': 'c\n' }, 'third', { t: T0 + 20 });
    expect(await apiPush({ ...base(gh, dir) })).toMatchObject({ ok: true, oid: three, created: false, commits: 1 });
    const again = tmp('clone');
    await apiClone({ ...base(gh, again), depth: 0 });
    expect(await logOids(again)).toEqual([three, two, one]);
  });

  it('needs a sign-in', async () => {
    const { gh, dir } = await cloned();
    const e = await failure(apiPush({ ...base(gh, dir, null) }));
    expect([e.code, e.message]).toEqual(['auth', 'Pushing needs a GitHub sign-in. Run: gh auth login']);
  });
});

describe('apiFetch', () => {
  it('brings new commits and only their new objects; a fast-forward merge then has everything', async () => {
    const { gh, up, dir, tip } = await cloned();
    await git.checkout({ fs: gfs, dir: up.dir, ref: 'main', force: true }).catch(() => {});
    const a = await commit(up.dir, { 'src/a.js': 'a4\n' }, 'upstream one', { t: T0 + 900, tz: -540 });
    const b = await commit(up.dir, { 'src/lib/c.js': 'c\n', 'README.md': '# proj 2\n' }, 'upstream two', { t: T0 + 950, tz: 240 });
    await publish(gh, up.dir);
    gh.calls.length = 0;
    expect(await apiFetch({ ...base(gh, dir) })).toEqual({ updated: [{ ref: 'refs/remotes/origin/main', from: tip, to: b }] });
    expect(gh.count(/\/git\/blobs\//)).toBe(3);
    expect(gh.count(/recursive/)).toBe(0);
    // Local branch and work tree untouched
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/heads/main' })).toBe(tip);
    expect(await read(`${dir}/src/a.js`)).toBe('a3\n');
    expect(await read(`${dir}/.git/shallow`)).toBe(tip + '\n');

    const merged = await git.merge({ fs: gfs, dir, ours: 'main', theirs: 'refs/remotes/origin/main', fastForwardOnly: true });
    expect(merged).toMatchObject({ oid: b, fastForward: true });
    await git.checkout({ fs: gfs, dir, ref: 'main', force: true });
    expect(await read(`${dir}/src/a.js`)).toBe('a4\n');
    expect(await read(`${dir}/src/lib/c.js`)).toBe('c\n');
    expect(await logOids(dir)).toEqual([b, a, tip]);
    expect(await dirty(dir)).toEqual([]);
    // Up to date: one request, nothing updated
    gh.calls.length = 0;
    expect(await apiFetch({ ...base(gh, dir) })).toEqual({ updated: [] });
    expect(gh.calls.length).toBe(1);
  });

  it('depth 1 cuts history at the new tip', async () => {
    const { gh, up, dir, tip } = await cloned();
    await commit(up.dir, { 'n1.txt': '1\n' }, 'n1', { t: T0 + 900 });
    const b = await commit(up.dir, { 'n2.txt': '2\n' }, 'n2', { t: T0 + 950 });
    await publish(gh, up.dir);
    await apiFetch({ ...base(gh, dir), depth: 1 });
    expect((await read(`${dir}/.git/shallow`)).trim().split('\n').sort()).toEqual([tip, b].sort());
    expect(await logOids(dir, 'refs/remotes/origin/main')).toEqual([b]);
  });

  it('all: every branch, across pages of the branch list', async () => {
    const { gh, up, dir, tip } = await cloned();
    const side = await publish(gh, up.dir, 'side');
    for (let i = 0; i < 120; i++) gh.refs.set(`b/${String(i).padStart(3, '0')}`, tip);
    gh.calls.length = 0;
    const { updated } = await apiFetch({ ...base(gh, dir), all: true });
    expect(updated.length).toBe(121);
    expect(updated).toContainEqual({ ref: 'refs/remotes/origin/side', from: null, to: side });
    expect(updated).toContainEqual({ ref: 'refs/remotes/origin/b/119', from: null, to: tip });
    expect(gh.count(/\/branches\?per_page=100&page=/)).toBe(2);
    expect(await git.resolveRef({ fs: gfs, dir, ref: 'refs/remotes/origin/b/007' })).toBe(tip);
    expect(await logOids(dir, 'refs/remotes/origin/side')).toEqual(await logOids(up.dir, 'side'));
  });

  it('a named branch that is not the current one', async () => {
    const { gh, up, dir } = await cloned();
    const side = await publish(gh, up.dir, 'side');
    expect((await apiFetch({ ...base(gh, dir), branch: 'side' })).updated).toEqual([{ ref: 'refs/remotes/origin/side', from: null, to: side }]);
    expect((await failure(apiFetch({ ...base(gh, dir), branch: 'gone' }))).code).toBe('not-found');
  });
});

describe('errors', () => {
  it('a 404 without a token says a sign-in may be needed; with one, that access may be missing', async () => {
    const gh = fakeGitHub();
    await publish(gh, (await upstream()).dir);
    gh.private = true;
    const e = await failure(apiClone({ ...base(gh, tmp('clone'), null) }));
    expect([e.code, e.status]).toEqual(['not-found', 404]);
    expect(e.message).toBe('ann/proj: not found. A private repository needs a GitHub sign-in: gh auth login');
    expect((await failure(apiCloneEstimate({ owner: 'ann', repo: 'proj', fetchImpl: gh.fetch }))).code).toBe('not-found');
    const other = await failure(apiClone({ ...base(gh, tmp('clone')), repo: 'other' }));
    expect(other.message).toBe('ann/other: not found, or your GitHub sign-in has no access to it');
    // Signed in, the private repository clones
    expect((await apiClone({ ...base(gh, tmp('clone')) })).commits).toBe(1);
  });

  it('a rate limit says when it resets', async () => {
    const gh = fakeGitHub();
    await publish(gh, (await upstream()).dir);
    gh.quota = 5;
    const e = await failure(apiClone({ ...base(gh, tmp('clone'), null), rawBase: null }));
    expect([e.code, e.status]).toEqual(['rate-limit', 403]);
    expect(e.message).toMatch(/^GitHub API rate limit reached; it resets at \d\d:\d\d \(in 30 min\)\. Signed in to GitHub the limit is 5,000 requests an hour instead of 60: gh auth login$/);
  });

  it('bad credentials, an unreachable network, an abort', async () => {
    const gh = fakeGitHub();
    await publish(gh, (await upstream()).dir);
    const bad = await failure(apiClone({ ...base(gh, tmp('clone'), 'bad') }));
    expect([bad.code, bad.status]).toEqual(['auth', 401]);
    const down = await failure(apiClone({ ...base(gh, tmp('clone')), fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as any }));
    expect([down.code, down.message]).toEqual(['network', 'could not reach GitHub (Failed to fetch)']);

    const stop = new AbortController();
    gh.hook = (call) => { if (/blobs/.test(call)) stop.abort(); };
    const e = await apiClone({ ...base(gh, tmp('clone')), signal: stop.signal }).then(() => null, x => x);
    expect(e?.name).toBe('AbortError');
  });
});

// Read-only, against the real API: what the fake's behaviour is modelled on
describe.skipIf(!process.env.TABCOMPUTER_GITHUB_LIVE)('against api.github.com', () => {
  const list = async (repo: string, n: number) => (await (await fetch(`https://api.github.com/repos/${repo}/commits?per_page=${n}`)).json()) as any[];
  const shape = (j: any) => ({
    sha: j.sha, tree: j.commit.tree.sha, parents: j.parents.map((p: any) => p.sha), author: j.commit.author, committer: j.commit.committer,
    message: j.commit.message, signature: j.commit.verification?.signature, payload: j.commit.verification?.payload,
  });

  it('rebuilds unsigned commits made in a non-UTC timezone (git/git) and signed ones (isomorphic-git)', async () => {
    for (const [repo, n] of [['git/git', 3], ['isomorphic-git/isomorphic-git', 4]] as const) {
      for (const j of await list(repo, n)) {
        const bytes = await rebuildCommit(shape(j));
        expect(bytes && sha1('commit', bytes), `${repo} ${j.sha}`).toBe(j.sha);
        console.log(repo, j.sha, j.commit.verification?.verified ? 'signed' : 'unsigned', new TextDecoder().decode(bytes!).match(/^author .*$/m)?.[0]);
      }
    }
  }, 60000);

  it('clones octocat/Spoon-Knife with its whole history, unauthenticated', async () => {
    const dir = tmp('live');
    const o = { fs: gfs, dir, owner: 'octocat', repo: 'Spoon-Knife' };
    const est = await apiCloneEstimate(o);
    const said: string[] = [];
    const res = await apiClone({ ...o, depth: 0, onProgress: m => said.push(m) });
    console.log(est, res, said.at(-1));
    expect(res.oid).toBe(est.oid);
    expect(res.shallow).toBe(false);
    expect((await logOids(dir)).length).toBe(res.commits);
    expect(await dirty(dir)).toEqual([]);
    expect(await read(`${dir}/README.md`)).toContain('Spoon-Knife');
  }, 120000);
});
