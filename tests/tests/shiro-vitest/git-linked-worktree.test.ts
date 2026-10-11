/**
 * Linked worktrees (`git worktree add`, audit 7). Their .git is a file,
 * "gitdir: REPO/.git/worktrees/NAME", which isomorphic-git can't follow: in
 * one the built-in's log and diff printed nothing, add did nothing and commit
 * failed with "Cannot read properties of null". There the full git runs (or
 * the built-in says why it can't). And the built-in's `worktree list` showed
 * the main work tree alone; it lists the linked ones as git does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { DEFAULT_MIRROR } from '@shiro/pkg-manager';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let fs: FileSystem;
let shell: Shell;
const sh = async (cmd: string) => {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (e) => { err += e; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
};

// The full git package stays out of reach unless a test puts a stand-in at /usr/bin/git
const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).startsWith(DEFAULT_MIRROR + '/pkg/')) throw new TypeError('fetch failed (offline in this test)');
    return realFetch(input, init);
  }) as typeof fetch;
  ({ fs, shell } = await createTestShell());
});
afterAll(() => { globalThis.fetch = realFetch; });

let main = '', feat = '';
beforeEach(async () => {
  // (test FileSystems can share their storage: start from nothing)
  await sh('rm -rf /tmp/wl /usr/bin/git');
  await sh('mkdir -p /tmp/wl && cd /tmp/wl && git init -q -b main repo && cd repo && git config user.name Ann && git config user.email ann@x.org'
    + ' && echo one > a.txt && git add a.txt && git commit -qm first && git checkout -qb feat && echo two >> a.txt && git commit -qam second && git checkout -q main');
  main = (await sh('cd /tmp/wl/repo && git rev-parse main')).out.trim();
  feat = (await sh('cd /tmp/wl/repo && git rev-parse feat')).out.trim();
  // As `git worktree add` leaves them: wt on feat, a locked detached one, one whose directory is gone
  const admin = '/tmp/wl/repo/.git/worktrees';
  const linked: [string, string, string][] = [['wt', '/tmp/wl/wt', 'ref: refs/heads/feat'], ['det', '/tmp/wl/detached', main], ['gone', '/tmp/wl/gone', main]];
  for (const [name, path, head] of linked) {
    await fs.mkdir(`${admin}/${name}`, { recursive: true });
    await fs.writeFile(`${admin}/${name}/gitdir`, `${path}/.git\n`);
    await fs.writeFile(`${admin}/${name}/HEAD`, `${head}\n`);
    if (name === 'gone') continue;
    await fs.mkdir(`${path}/sub`, { recursive: true });
    await fs.writeFile(`${path}/.git`, `gitdir: ${admin}/${name}\n`);
    await fs.writeFile(`${path}/a.txt`, 'one\ntwo\n');
  }
  await fs.writeFile(`${admin}/det/locked`, 'moving');
});

describe('git worktree list', () => {
  it('the main work tree, then the linked ones by path, paths padded to one column', async () => {
    const r = await sh('cd /tmp/wl/repo && git worktree list');
    expect(r.code).toBe(0);
    expect(r.out).toBe([
      `/tmp/wl/repo     ${main.slice(0, 7)} [main]`,
      `/tmp/wl/detached ${main.slice(0, 7)} (detached HEAD) locked`,
      `/tmp/wl/gone     ${main.slice(0, 7)} (detached HEAD) prunable`,
      `/tmp/wl/wt       ${feat.slice(0, 7)} [feat]`,
      '',
    ].join('\n'));
  });

  it('--porcelain', async () => {
    expect((await sh('cd /tmp/wl/repo && git worktree list --porcelain')).out).toBe(
      `worktree /tmp/wl/repo\nHEAD ${main}\nbranch refs/heads/main\n\n`
      + `worktree /tmp/wl/detached\nHEAD ${main}\ndetached\nlocked moving\n\n`
      + `worktree /tmp/wl/gone\nHEAD ${main}\ndetached\nprunable gitdir file points to non-existent location\n\n`
      + `worktree /tmp/wl/wt\nHEAD ${feat}\nbranch refs/heads/feat\n\n`);
  });

  it('without linked worktrees: the main one alone, one space before the commit', async () => {
    await sh('rm -rf /tmp/wl/repo/.git/worktrees');
    expect((await sh('cd /tmp/wl/repo && git worktree list')).out).toBe(`/tmp/wl/repo ${main.slice(0, 7)} [main]\n`);
  });
});

describe('in a linked worktree', () => {
  it('the full git runs, there and below, -C too; the main work tree keeps the built-in', async () => {
    await fs.mkdir('/usr/bin', { recursive: true });
    await fs.writeFile('/usr/bin/git', '#!/bin/sh\necho "full git in $(pwd): $*"\n', { mode: 0o755 });
    expect((await sh('cd /tmp/wl/wt && git status --short')).out).toBe('full git in /tmp/wl/wt: status --short\n');
    expect((await sh('cd /tmp/wl/wt/sub && git log --oneline -1')).out).toBe('full git in /tmp/wl/wt/sub: log --oneline -1\n');
    expect((await sh('cd /tmp && git -C /tmp/wl/detached commit -qm x')).out).toBe('full git in /tmp: -C /tmp/wl/detached commit -qm x\n');
    expect((await sh('cd /tmp/wl/wt && git config user.name')).out).toBe('full git in /tmp/wl/wt: config user.name\n');
    const own = await sh('cd /tmp/wl/repo && git log --format=%s');
    expect([own.code, own.out]).toEqual([0, 'first\n']);
  });

  it('without the full git: says why and fails, instead of reading nothing', async () => {
    for (const cmd of ['git log', 'git status', 'git commit -qm x']) {
      const r = await sh(`cd /tmp/wl/wt && ${cmd}`);
      expect(r.code).toBe(128);
      expect(r.out).toBe('');
      expect(r.err).toContain("the built-in git can't work in a linked worktree");
    }
  });
});
