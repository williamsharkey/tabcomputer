/**
 * A command that fails because the tab is not signed in to GitHub asks for the
 * sign-in and runs again (src/github-needed.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { githubSignInWanted, retrySignedIn, setGitHubNeedHandler, resetGitHubNeedDecline, askGitHubSignIn, type GitHubNeed } from '@shiro/github-needed';
import { createTestShell } from './helpers';
import { ghCmd } from '@shiro/commands/gh';

const KEY = 'tabcomputer_github_token';

// The vitest environment has no localStorage: an in-memory one for this file
const realStorage = (globalThis as any).localStorage;
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => { (globalThis as any).localStorage = realStorage; });

function fakeCtx(over: Record<string, unknown> = {}) {
  const written: string[] = [];
  const ctx: any = {
    args: ['clone', 'https://github.com/a/b'], env: {}, stdin: '', stdout: '', stderr: '', cwd: '/',
    fs: { readFile: async () => { throw new Error('none'); }, writeFile: async () => {}, exists: async () => false },
    terminal: { writeOutput: (s: string) => { written.push(s); } },
    ...over,
  };
  return { ctx, written };
}

describe('github-needed: what a failure says', () => {
  it('reads the messages git and gh print', () => {
    expect(githubSignInWanted('error: not signed in to GitHub. Run: gh auth login\n')).toBe('account');
    expect(githubSignInWanted('fatal: HTTP Error: 401\nhint: private repositories need a GitHub sign-in. Run: gh auth login\n')).toBe('private');
    expect(githubSignInWanted('a/b: not found. A private repository needs a GitHub sign-in: gh auth login')).toBe('private');
    expect(githubSignInWanted('fatal: Pushing needs a GitHub sign-in. Run: gh auth login')).toBe('account');
    expect(githubSignInWanted('GitHub API rate limit reached. Signed in to GitHub the limit is 5,000 requests an hour instead of 60: gh auth login')).toBe('rate-limit');
  });
  it('leaves other failures alone', () => {
    expect(githubSignInWanted('fatal: not a git repository')).toBeNull();
    expect(githubSignInWanted('error: authentication failed (HTTP 403)')).toBeNull();
    expect(githubSignInWanted('GitHub API rate limit reached; it resets at 3:00')).toBeNull(); // signed in already: a sign-in would not help
  });
});

describe('github-needed: ask, then run again', () => {
  let asked: GitHubNeed[] = [];
  let answer: string | null = 'gho_test';
  let off = () => {};
  beforeEach(() => {
    asked = []; answer = 'gho_test';
    localStorage.removeItem(KEY);
    resetGitHubNeedDecline();
    off = setGitHubNeedHandler(async (need) => { asked.push(need); if (answer) localStorage.setItem(KEY, answer); return answer; });
  });
  afterEach(() => { off(); });

  const failsUnsigned = (ctx: any, runs: { n: number }) => async () => {
    runs.n++;
    if (!localStorage.getItem(KEY)) { ctx.stderr += 'hint: private repositories need a GitHub sign-in. Run: gh auth login\n'; return 128; }
    ctx.stdout += 'done.\n';
    return 0;
  };

  it('at a terminal: asks, waits, and runs the command again signed in', async () => {
    const { ctx, written } = fakeCtx();
    const runs = { n: 0 };
    expect(await retrySignedIn(ctx, 'git clone', failsUnsigned(ctx, runs))).toBe(0);
    expect(runs.n).toBe(2);
    expect(asked).toEqual([{ action: 'git clone', kind: 'private' }]);
    expect(ctx.stderr).toBe(''); // the first run's failure is not shown twice
    expect(ctx.stdout).toBe('done.\n');
    expect(ctx.env.GITHUB_TOKEN).toBe('gho_test');
    expect(ctx.args).toEqual(['clone', 'https://github.com/a/b']);
    expect(written.join('')).toContain('git clone needs a GitHub sign-in. A window opened to sign in.');
    expect(written.join('')).toContain('Signed in to GitHub. Running git clone again.');
  });

  it('"Not now": the failure stands, and the next failure within a minute does not ask', async () => {
    answer = null;
    const { ctx } = fakeCtx();
    const runs = { n: 0 };
    expect(await retrySignedIn(ctx, 'git clone', failsUnsigned(ctx, runs))).toBe(128);
    expect(runs.n).toBe(1);
    expect(ctx.stderr).toContain('gh auth login');
    const again = fakeCtx();
    expect(await retrySignedIn(again.ctx, 'git clone', failsUnsigned(again.ctx, { n: 0 }))).toBe(128);
    expect(asked.length).toBe(1);
  });

  it('without a terminal nothing waits: the question opens and the message says to run it again', async () => {
    const { ctx } = fakeCtx({ terminal: undefined });
    const runs = { n: 0 };
    let release!: (t: string | null) => void;
    off(); off = setGitHubNeedHandler((need) => { asked.push(need); return new Promise((r) => { release = r; }); });
    expect(await retrySignedIn(ctx, 'git push', failsUnsigned(ctx, runs))).toBe(128);
    expect(runs.n).toBe(1);
    expect(asked).toEqual([{ action: 'git push', kind: 'private', afterFailure: true }]);
    expect(ctx.stderr).toContain('Sign in there, then run git push again.');
    release(null);
  });

  it('does not ask when output is redirected, when told not to prompt, when signed in, or for another failure', async () => {
    answer = null;
    for (const over of [{ stderrIsTTY: false }, { stdinIsTTY: false }]) {
      const { ctx } = fakeCtx(over);
      const runs = { n: 0 };
      expect(await retrySignedIn(ctx, 'git clone', failsUnsigned(ctx, runs))).toBe(128);
      expect(runs.n).toBe(1);
    }
    // (redirected commands open the question beside the failure once; a minute's quiet follows)
    asked = []; resetGitHubNeedDecline();
    const quiet = fakeCtx({ env: { TABCOMPUTER_GITHUB_PROMPT: '0' } });
    expect(await retrySignedIn(quiet.ctx, 'git clone', failsUnsigned(quiet.ctx, { n: 0 }))).toBe(128);
    const signed = fakeCtx({ env: { GH_TOKEN: 'x' } });
    expect(await retrySignedIn(signed.ctx, 'gh pr list', async () => { signed.ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n'; return 1; })).toBe(1);
    const other = fakeCtx();
    expect(await retrySignedIn(other.ctx, 'git clone', async () => { other.ctx.stderr = 'fatal: repository not found\n'; return 128; })).toBe(128);
    expect(asked).toEqual([]);
  });

  it('a saved token answers without asking', async () => {
    localStorage.setItem(KEY, 'gho_saved');
    expect(await askGitHubSignIn({ action: 'gh repo list', kind: 'account' })).toBe('gho_saved');
    expect(asked).toEqual([]);
  });
});

describe('github-needed: gh and git', () => {
  let off = () => {};
  let asked: GitHubNeed[] = [];
  beforeEach(() => { asked = []; localStorage.removeItem(KEY); resetGitHubNeedDecline(); off = setGitHubNeedHandler(async (n) => { asked.push(n); return null; }); });
  afterEach(() => { off(); });

  it('gh repo list, not signed in, opens the question; gh auth status does not', async () => {
    const { shell } = await createTestShell();
    shell.commands.register(ghCmd);
    let out = '';
    const code = await shell.execute('gh repo list', (s: string) => { out += s; }, (s: string) => { out += s; });
    expect(code).toBe(1);
    expect(out).toContain('not signed in to GitHub');
    expect(asked.map((n) => n.action)).toEqual(['gh repo list']);
    asked = []; resetGitHubNeedDecline();
    await shell.execute('gh auth status', () => {}, () => {});
    expect(asked).toEqual([]);
  });

  it('git push with no token opens the question', async () => {
    const { shell } = await createTestShell();
    let out = '';
    const w = (s: string) => { out += s; };
    await shell.execute('mkdir -p /tmp/r && cd /tmp/r && git init -q && git remote add origin https://github.com/a/b && echo x > f && git add f && git commit -qm one', w, w);
    const code = await shell.execute('cd /tmp/r && git push origin HEAD', w, w);
    expect(code).not.toBe(0);
    expect(asked.map((n) => n.action)).toEqual(['git push']);
  });
});
