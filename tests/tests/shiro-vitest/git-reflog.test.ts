/**
 * The built-in git's reflogs (tabcomputer#86). isomorphic-git writes none, so a
 * built-in `reset --hard` lost commits for good and `git reflog` printed one
 * made-up line. Now each built-in ref update appends to .git/logs/HEAD and
 * .git/logs/refs/heads/<branch> as git does: the expected logs below are what
 * git 2.56 (the full git, `pkg install git`) wrote for the same commands, byte
 * for byte, with these dates. `git reflog` and `REF@{N}` read them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;

// The built-in alone: the full git package (which cherry-pick, revert and rebase prefer) out of reach
const realFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).startsWith(DEFAULT_MIRROR + '/pkg/')) throw new TypeError('fetch failed (offline in this test)');
    return realFetch(input, init);
  }) as typeof fetch;
  ({ fs, shell } = await createTestShell());
  await sh('rm -f /usr/bin/git');
});
afterAll(() => { globalThis.fetch = realFetch; });

const DATES = "export GIT_AUTHOR_DATE='1791733459 +0000' GIT_COMMITTER_DATE='1791733459 +0000'";
/** A fresh repository in DIR, as Ann, with fixed dates */
const repo = (dir: string) => `${DATES}; rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && git init -q -b main . && git config user.name Ann && git config user.email ann@x.org`;

describe('built-in ref updates write git\'s reflog', () => {
  it('commit, amend, reset, checkout/switch, merge, branch -f/-m, stash: the same bytes as git', async () => {
    const r = await sh(`${repo('/tmp/rl/a')}`
      + " && echo one > a && git add a && git commit -qm first && echo two >> a && git commit -qam two && git commit -q --amend -m 'two amended'"
      + ' && git reset -q --hard HEAD && git reset -q --hard HEAD~1 && git checkout -q main && git checkout -q -b feat'
      + ' && echo f > f && git add f && git commit -qm feat && git switch -q main && git checkout -q HEAD~0 && git checkout -q main && git merge -q feat'
      + ' && git branch b1 && git branch -f b1 HEAD~1 && git branch -m b1 b2'
      + ' && echo z >> a && git stash -q && git stash pop -q && git checkout -q -- a');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const Z = '0'.repeat(40), I = 'Ann <ann@x.org> 1791733459 +0000';
    const c1 = '4b009cd5822038c4470bc98f35938c2522fbab3d', c2 = 'a482266e6cb48483e0bf20af2bc3a0435ddf47a7';
    const c3 = '8757d11d56fec407f1e5be5be2eb31bfd5c1c96d', c4 = '7bfd5f9e9fd128c2a1ebfa78736dd002bb369420';
    const logs = '/tmp/rl/a/.git/logs';
    expect(await read(`${logs}/HEAD`)).toBe([
      `${Z} ${c1} ${I}\tcommit (initial): first`,
      `${c1} ${c2} ${I}\tcommit: two`,
      `${c2} ${c3} ${I}\tcommit (amend): two amended`,
      `${c3} ${c3} ${I}\treset: moving to HEAD`,
      `${c3} ${c1} ${I}\treset: moving to HEAD~1`,
      `${c1} ${c1} ${I}\tcheckout: moving from main to main`,
      `${c1} ${c1} ${I}\tcheckout: moving from main to feat`,
      `${c1} ${c4} ${I}\tcommit: feat`,
      `${c4} ${c1} ${I}\tcheckout: moving from feat to main`,
      `${c1} ${c1} ${I}\tcheckout: moving from main to HEAD~0`,
      `${c1} ${c1} ${I}\tcheckout: moving from ${c1} to main`,
      `${c1} ${c4} ${I}\tmerge feat: Fast-forward`,
      `${c4} ${c4} ${I}\treset: moving to HEAD`,
      '',
    ].join('\n'));
    expect(await read(`${logs}/refs/heads/main`)).toBe([
      `${Z} ${c1} ${I}\tcommit (initial): first`,
      `${c1} ${c2} ${I}\tcommit: two`,
      `${c2} ${c3} ${I}\tcommit (amend): two amended`,
      `${c3} ${c1} ${I}\treset: moving to HEAD~1`,
      `${c1} ${c4} ${I}\tmerge feat: Fast-forward`,
      '',
    ].join('\n'));
    expect(await read(`${logs}/refs/heads/feat`)).toBe(`${Z} ${c1} ${I}\tbranch: Created from HEAD\n${c1} ${c4} ${I}\tcommit: feat\n`);
    expect(await read(`${logs}/refs/heads/b2`)).toBe([
      `${Z} ${c4} ${I}\tbranch: Created from main`,
      `${c4} ${c1} ${I}\tbranch: Reset to HEAD~1`,
      `${c1} ${c1} ${I}\tBranch: renamed refs/heads/b1 to refs/heads/b2`,
      '',
    ].join('\n'));
    expect(await fs.exists(`${logs}/refs/heads/b1`)).toBe(false);
    // git branch -d takes the branch's log with it
    await sh('cd /tmp/rl/a && git branch -D b2');
    expect(await fs.exists(`${logs}/refs/heads/b2`)).toBe(false);
  });

  it('a commit lost to reset --hard: reflog shows both, and reset --hard HEAD@{1} brings it back', async () => {
    await sh(`${repo('/tmp/rl/b')} && echo 1 > f && git add f && git commit -qm base && echo 2 > f && git commit -qam precious`);
    const precious = (await sh('cd /tmp/rl/b && git rev-parse HEAD')).out.trim();
    expect((await sh('cd /tmp/rl/b && git reset -q --hard HEAD~1 && git log --format=%s')).out).toBe('base\n');
    const base = (await sh('cd /tmp/rl/b && git rev-parse HEAD')).out.trim();
    expect((await sh('cd /tmp/rl/b && git reflog')).out).toBe([
      `${base.slice(0, 7)} HEAD@{0}: reset: moving to HEAD~1`,
      `${precious.slice(0, 7)} HEAD@{1}: commit: precious`,
      `${base.slice(0, 7)} HEAD@{2}: commit (initial): base`,
      '',
    ].join('\n'));
    const back = await sh('cd /tmp/rl/b && git reset --hard HEAD@{1}');
    expect(back.out).toBe(`HEAD is now at ${precious.slice(0, 7)} precious\n`);
    expect(await read('/tmp/rl/b/f')).toBe('2\n');
    expect((await sh('cd /tmp/rl/b && git reflog -1')).out).toBe(`${precious.slice(0, 7)} HEAD@{0}: reset: moving to HEAD@{1}\n`);
  });

  it('a conflicted merge: merge --abort and the concluding commit, as git logs them', async () => {
    await sh(`${repo('/tmp/rl/c')} && echo one > a && git add a && git commit -qm one && git checkout -qb x && echo two > a && git commit -qam x`
      + ' && git checkout -q main && echo three > a && git commit -qam m');
    expect((await sh('cd /tmp/rl/c && git merge x')).code).toBe(1);
    expect((await sh('cd /tmp/rl/c && git merge --abort')).code).toBe(0);
    await sh('cd /tmp/rl/c && git merge x; echo r > a && git add a && git commit -q --no-edit && git checkout -q x && git merge -q main');
    const subjects = (await read('/tmp/rl/c/.git/logs/HEAD')).split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
    expect(subjects.slice(-4)).toEqual(['reset: moving to HEAD', "commit (merge): Merge branch 'x'", 'checkout: moving from main to x', 'merge main: Fast-forward']);
  });

  it('cherry-pick and revert (the built-in\'s, without the full git): one entry per commit', async () => {
    await sh(`${repo('/tmp/rl/d')} && echo 1 > a && git add a && git commit -qm base && git checkout -qb side && echo s > s && git add s && git commit -qm side`
      + ' && echo t > t && git add t && git commit -qm side2 && git checkout -q main');
    expect((await sh('cd /tmp/rl/d && git cherry-pick side~1 side')).code).toBe(0);
    expect((await sh('cd /tmp/rl/d && git revert --no-edit HEAD')).code).toBe(0);
    expect((await sh('cd /tmp/rl/d && git reflog -3 --format=%gs')).out).toBe('revert: Revert "side2"\ncherry-pick: side2\ncherry-pick: side\n');
    expect((await sh('cd /tmp/rl/d && git reflog show main -n 1 --format=%gd')).out).toBe('main@{0}\n');
  });

  it('core.logAllRefUpdates false: logs that exist grow, no new ones', async () => {
    await sh(`${repo('/tmp/rl/e')} && echo 1 > a && git add a && git commit -qm one && git config core.logAllRefUpdates false && git branch nolog && git commit -q --allow-empty -m two`);
    expect(await fs.exists('/tmp/rl/e/.git/logs/refs/heads/nolog')).toBe(false);
    expect((await sh('cd /tmp/rl/e && git reflog --format=%gs')).out).toBe('commit: two\ncommit (initial): one\n');
  });
});

describe('git reflog and REF@{N}', () => {
  it('show REF, -n, @{N} (the current branch), main@{N}', async () => {
    await sh(`${repo('/tmp/rl/f')} && echo 1 > a && git add a && git commit -qm one && echo 2 > a && git commit -qam two && git checkout -q -b b && git checkout -q main`);
    const [o1, o2] = (await sh('cd /tmp/rl/f && git rev-parse HEAD~1 HEAD')).out.trim().split('\n');
    expect((await sh('cd /tmp/rl/f && git reflog -n 2')).out).toBe(`${o2.slice(0, 7)} HEAD@{0}: checkout: moving from b to main\n${o2.slice(0, 7)} HEAD@{1}: checkout: moving from main to b\n`);
    expect((await sh('cd /tmp/rl/f && git reflog show main')).out).toBe(`${o2.slice(0, 7)} main@{0}: commit: two\n${o1.slice(0, 7)} main@{1}: commit (initial): one\n`);
    expect((await sh('cd /tmp/rl/f && git rev-parse main@{1} @{1} HEAD@{2} HEAD@{3}')).out).toBe(`${o1}\n${o1}\n${o2}\n${o1}\n`);
    expect((await sh('cd /tmp/rl/f && git rev-parse HEAD@{9}')).code).not.toBe(0);
  });

  it('expire, delete and exists are the full git\'s', async () => {
    const r = await sh('cd /tmp/rl/f && git reflog expire --all');
    expect(r.code).toBe(129);
    expect(r.err).toContain('unknown subcommand');
  });
});
