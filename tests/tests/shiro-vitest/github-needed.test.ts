/**
 * A command that fails because the tab is not signed in to GitHub asks for the
 * sign-in and runs again (src/github-needed.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { githubSignInWanted, missingScopes, retrySignedIn, fetchSignedIn, scopesSentence, setGitHubNeedHandler, setTokenScopesReader, resetGitHubNeedDecline, askGitHubSignIn, actionText, ACTION_MAX, SCOPES_ASKED, type GitHubNeed } from '@shiro/github-needed';
import { gitRemoteIsGitHub } from '@shiro/commands/git';
import { sheetFocus } from '@shiro/desktop/network';
import { GITHUB_RATE_LIMITED, githubMissing, githubNotThere, githubRateLimited, githubTokenFetch, handleRunLink, loadScript, parseRunUrl } from '@shiro/run-url';
import { fetchGhApp, handleAppLink } from '@shiro/apps/links';
import { hotswapCmd } from '@shiro/commands/hotswap';
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
    // what a link or `app install gh:` says (src/run-url.ts)
    expect(githubSignInWanted(GITHUB_RATE_LIMITED)).toBe('rate-limit');
    expect(githubSignInWanted(githubMissing('github.com/a/b, setup.sh', false))).toBe('private');
    expect(githubSignInWanted(githubMissing('github.com/a/b, setup.sh', true))).toBeNull();
    expect(githubSignInWanted('hotswap push: not signed in to GitHub: run gh auth login')).toBe('account');
  });
  it('tells GitHub\'s rate limit from another refusal', () => {
    const res = (status: number, remaining?: string) => new Response('{}', { status, headers: remaining === undefined ? {} : { 'x-ratelimit-remaining': remaining } });
    expect(githubRateLimited(res(403, '0'))).toBe(true);
    expect(githubRateLimited(res(429, '0'))).toBe(true);
    expect(githubRateLimited(res(403, '12'))).toBe(false); // refused for another reason
    expect(githubRateLimited(res(403))).toBe(false);
    expect(githubRateLimited(res(404, '0'))).toBe(false);
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

describe('github-needed: a token that lacks scopes (tabcomputer#153)', () => {
  const STUDENT = 'gh-student: your github.com token (source: GH_TOKEN) is missing scopes gh student needs (admin:org, read:org, repo, workflow); it wasn\'t set by `gh auth login`, so re-running won\'t fix it. Re-issue the token with those scopes, or unset it and run `gh student login`\n';
  let asked: GitHubNeed[] = [];
  let answer: string | null = 'gho_more';
  let off = () => {};
  beforeEach(() => {
    asked = []; answer = 'gho_more';
    localStorage.setItem(KEY, 'gho_saved');
    resetGitHubNeedDecline();
    setTokenScopesReader(async () => ['gist', 'read:org', 'repo', 'user:email', 'workflow']);
    off = setGitHubNeedHandler(async (need) => { asked.push(need); if (answer) localStorage.setItem(KEY, answer); return answer; });
  });
  afterEach(() => { off(); setTokenScopesReader(null); });

  it('reads the scopes a failure names, in the forms gh and its extensions use', () => {
    expect(missingScopes(STUDENT)).toEqual(['admin:org', 'read:org', 'repo', 'workflow']);
    expect(missingScopes('error: your authentication token is missing required scopes [read:project]\nTo request it, run:  gh auth refresh -s read:project\n')).toEqual(['read:project']);
    expect(missingScopes('This API operation needs the "codespace" scope. To request it, run:  gh auth refresh -h github.com -s codespace\n')).toEqual(['codespace']);
    expect(missingScopes('your token is missing the required scopes (delete_repo)')).toEqual(['delete_repo']);
    // not a list of scopes: other failures, markup, a made-up name
    for (const text of ['', 'fatal: repository not found', 'HTTP 403: Resource not accessible by integration', 'missing scopes (<script>alert(1)</script>)', 'error: missing scope']) expect(missingScopes(text), text).toBeNull();
    expect(scopesSentence(['admin:org'])).toBe('This adds permission to manage your organizations, their teams and their members (admin:org).');
    expect(scopesSentence(['project', 'delete_repo', 'made_up'])).toBe('This adds 3 permissions: to read and change projects (project); to delete repositories (delete_repo); and to do what GitHub calls made_up.');
  });

  it('at a terminal: asks for exactly the scopes the sign-in lacks, then runs the command again', async () => {
    const { ctx, written } = fakeCtx({ args: ['student', 'whoami'] });
    let runs = 0;
    const run = async () => {
      runs++;
      // (a gh extension writes to the terminal itself: gh keeps the end of it in stderrSeen)
      if (localStorage.getItem(KEY) !== 'gho_more') { ctx.stderrSeen = STUDENT; return 1; }
      ctx.stdout += 'you are octocat\n';
      return 0;
    };
    expect(await retrySignedIn(ctx, 'gh student whoami', run)).toBe(0);
    expect(runs).toBe(2);
    // admin:org is the one it lacks; the request keeps what the sign-in has
    expect(asked).toEqual([{ action: 'gh student whoami', kind: 'scopes', add: ['admin:org'], scopes: ['repo', 'read:org', 'gist', 'workflow', 'user:email', 'admin:org'] }]);
    expect(ctx.stdout).toBe('you are octocat\n');
    expect(written.join('')).toContain('gh student whoami needs a permission the GitHub sign-in here does not have (admin:org). A window opened to add it.');
    expect(written.join('')).toContain('GitHub added it. Running gh student whoami again.');
  });

  it('"Not now" leaves the failure; a scope the token holds inside another is not asked for', async () => {
    answer = null;
    const { ctx } = fakeCtx();
    expect(await retrySignedIn(ctx, 'gh student whoami', async () => { ctx.stderr = STUDENT; return 1; })).toBe(1);
    expect(asked).toHaveLength(1);
    expect(ctx.stderr).toBe(STUDENT);
    // read:org and public_repo are inside admin:org and repo: nothing is lacking, so the failure is about something else
    asked = []; resetGitHubNeedDecline();
    setTokenScopesReader(async () => ['admin:org', 'repo', 'workflow']);
    const held = fakeCtx();
    expect(await retrySignedIn(held.ctx, 'gh x', async () => { held.ctx.stderr = 'missing scopes (read:org, public_repo, workflow)\n'; return 1; })).toBe(1);
    expect(asked).toEqual([]);
  });

  it('a token the person exported themselves is theirs to re-issue; without a terminal the question opens beside the failure', async () => {
    const own = fakeCtx({ env: { GH_TOKEN: 'ghp_their_own' } });
    expect(await retrySignedIn(own.ctx, 'gh student whoami', async () => { own.ctx.stderr = STUDENT; return 1; })).toBe(1);
    expect(asked).toEqual([]);
    // the tab's own token in the environment (gh auth login puts it there) is the tab's
    const tabs = fakeCtx({ env: { GITHUB_TOKEN: 'gho_saved' } });
    let n = 0;
    expect(await retrySignedIn(tabs.ctx, 'gh student whoami', async () => { if (n++) return 0; tabs.ctx.stderr = STUDENT; return 1; })).toBe(0);
    expect(tabs.ctx.env.GITHUB_TOKEN).toBe('gho_more');
    asked = []; resetGitHubNeedDecline();
    localStorage.setItem(KEY, 'gho_saved');
    const quiet = fakeCtx({ terminal: undefined });
    let release!: (t: string | null) => void;
    off(); off = setGitHubNeedHandler((need) => { asked.push(need); return new Promise((r) => { release = r; }); });
    expect(await retrySignedIn(quiet.ctx, 'gh student whoami', async () => { quiet.ctx.stderr = STUDENT; return 1; })).toBe(1);
    expect(asked).toMatchObject([{ kind: 'scopes', add: ['admin:org'], afterFailure: true }]);
    expect(quiet.ctx.stderr).toContain('(A window opened to give the GitHub sign-in here that permission. Approve there, then run gh student whoami again.)');
    release(null);
  });
});

describe('github-needed: which commands and which scopes get the sheet', () => {
  const lacks = (...scopes: string[]) => `error: your authentication token is missing required scopes [${scopes.join(', ')}]\n`;
  let asked: GitHubNeed[] = [];
  let off = () => {};
  beforeEach(() => {
    asked = [];
    localStorage.setItem(KEY, 'gho_saved');
    resetGitHubNeedDecline();
    setTokenScopesReader(async () => ['gist', 'read:org', 'repo', 'user:email', 'workflow']);
    off = setGitHubNeedHandler(async (need) => { asked.push(need); return null; });
  });
  afterEach(() => { off(); setTokenScopesReader(null); });
  const fail = async (action: string, stderr: string, opts?: Parameters<typeof retrySignedIn>[3]) => {
    const { ctx } = fakeCtx();
    const code = await retrySignedIn(ctx, action, async () => { ctx.stderr = stderr; return 1; }, opts);
    resetGitHubNeedDecline();
    return { code, stderr: ctx.stderr as string };
  };

  it('the list is short, and has nothing that deletes or administers', () => {
    expect([...SCOPES_ASKED].sort()).toEqual(['admin:org', 'codespace', 'gist', 'notifications', 'project', 'public_repo', 'read:discussion', 'read:org', 'read:packages', 'read:project', 'read:user', 'repo', 'repo:status', 'user:email', 'workflow', 'write:org']);
    for (const s of ['delete_repo', 'admin:enterprise', 'admin:public_key', 'admin:repo_hook', 'admin:org_hook', 'admin:gpg_key', 'delete:packages', 'write:packages', 'user', 'site_admin']) expect(SCOPES_ASKED.has(s), s).toBe(false);
  });

  it('a scope outside the list is never asked for: the failure stands, with a line naming gh auth refresh -s', async () => {
    for (const scope of ['delete_repo', 'admin:enterprise', 'admin:public_key', 'user', 'made_up']) {
      const r = await fail('gh x', lacks(scope));
      expect(r.code).toBe(1);
      expect(asked, scope).toEqual([]);
      expect(r.stderr).toBe(`${lacks(scope)}tabcomputer does not add ${scope} to the GitHub sign-in because a command asked. To add it yourself: gh auth refresh -s ${scope}\n`);
    }
    // one scope outside the list among ones inside it: nothing is asked, and the line names the lot
    const mixed = await fail('gh student x', lacks('admin:org', 'delete_repo', 'repo'));
    expect(asked).toEqual([]);
    expect(mixed.stderr).toContain('tabcomputer does not add delete_repo to the GitHub sign-in because a command asked. To add what this command named yourself: gh auth refresh -s admin:org,delete_repo\n');
    // without a terminal too: no window opens beside the failure
    const quiet = fakeCtx({ terminal: undefined });
    await retrySignedIn(quiet.ctx, 'gh x', async () => { quiet.ctx.stderr = lacks('delete_repo'); return 1; });
    expect(asked).toEqual([]);
    expect(quiet.ctx.stderr).toContain('gh auth refresh -s delete_repo');
    expect(quiet.ctx.stderr).not.toContain('A window opened');
    // a scope inside the list is asked for as before
    await fail('gh project list', lacks('read:project'));
    expect(asked).toMatchObject([{ action: 'gh project list', kind: 'scopes', add: ['read:project'] }]);
  });

  it('only gh and its extensions, and git on a github.com remote', async () => {
    const text = lacks('read:project');
    // another command that goes through the same wrapper, and a program that only prints the words
    for (const action of ['hotswap push', 'ghost x', 'npm run gh', 'link']) {
      const r = await fail(action, text);
      expect(asked, action).toEqual([]);
      expect(r.stderr, action).toBe(text);   // no sheet, and no line either: nothing was GitHub's word
    }
    // git: what the remote said is GitHub's only when the remote is github.com
    await fail('git push', text);
    await fail('git push', text, { githubRemote: () => false });
    await fail('git push', text, { githubRemote: async () => { throw new Error('no repository'); } });
    expect(asked).toEqual([]);
    await fail('git push', text, { githubRemote: async () => true });
    expect(asked).toMatchObject([{ action: 'git push', kind: 'scopes', add: ['read:project'] }]);
    asked = [];
    for (const action of ['gh', 'gh student whoami', 'gh api']) await fail(action, text);
    expect(asked.map((n) => n.action)).toEqual(['gh', 'gh student whoami', 'gh api']);
  });

  it('git knows the remote it talked to', async () => {
    const { shell, fs } = await createTestShell();
    const w = () => {};
    await shell.execute('mkdir -p /tmp/hub /tmp/other /tmp/none && cd /tmp/hub && git init -q && git remote add origin https://github.com/a/b && git remote add mirror https://git.example.com/a/b', w, w);
    await shell.execute('cd /tmp/other && git init -q && git remote add origin https://git.example.com/a/b && mkdir -p deep/er', w, w);
    const at = (cwd: string, ...args: string[]) => gitRemoteIsGitHub({ fs, cwd, args } as any);
    expect(await at('/tmp/hub', 'push')).toBe(true);
    expect(await at('/tmp/hub', 'push', 'origin', 'main')).toBe(true);
    expect(await at('/tmp/hub', 'push', 'mirror', 'main')).toBe(false);
    expect(await at('/tmp/hub', 'pull', '--rebase')).toBe(true);
    expect(await at('/tmp/other', 'fetch')).toBe(false);
    expect(await at('/tmp/other/deep/er', 'fetch')).toBe(false);
    expect(await at('/tmp/none', 'push')).toBe(false);
    expect(await at('/tmp', '-C', '/tmp/hub', 'push')).toBe(true);
    expect(await at('/tmp/hub', '-C', '/tmp/other', 'push')).toBe(false);
    // an address among the words decides, wherever the command runs
    expect(await at('/tmp/other', 'clone', 'https://github.com/a/b')).toBe(true);
    expect(await at('/tmp/hub', 'clone', 'https://git.example.com/a/b')).toBe(false);
    expect(await at('/tmp/hub', 'ls-remote', 'https://github.com.evil.example/a/b')).toBe(false);
    expect(await at('/tmp/hub', 'push', 'https://user@github.com/a/b', 'main')).toBe(true);
    expect(await at('/tmp/hub', 'clone', 'git@github.com:a/b.git')).toBe(false);   // ssh is not sent the token
    expect(await at('/tmp/hub', 'status')).toBe(false);
  });

  it('the action a sheet shows is one line of at most 60 characters', async () => {
    expect(ACTION_MAX).toBe(60);
    expect(actionText('gh repo list')).toBe('gh repo list');
    const long = `gh api ${'x'.repeat(200)}`;
    expect(actionText(long)).toBe(long.slice(0, 60) + '…');
    expect(actionText(long)).toHaveLength(61);
    expect(actionText('gh x\nYour session ended.\u202e Sign in again')).toBe('gh x Your session ended. Sign in again');
    // what reaches the sheet is the short text, for a sign-in and for more permissions
    localStorage.removeItem(KEY);
    await askGitHubSignIn({ action: long, kind: 'account' });
    resetGitHubNeedDecline();
    localStorage.setItem(KEY, 'gho_saved');
    await fail(long, lacks('read:project'));
    expect(asked.map((n) => n.action)).toEqual([long.slice(0, 60) + '…', long.slice(0, 60) + '…']);
  });

  it('a sheet a command opened has the focus on "Not now"; one opened on purpose, on the sign-in', () => {
    expect(sheetFocus(true, false)).toBe('[data-act=later]');
    expect(sheetFocus(true, true)).toBe('[data-act=github]');
    expect(sheetFocus(false, true)).toBe('[data-act=github]');
    expect(sheetFocus(false, false)).toBe('');
  });

  it('in the page: both sheets are put in the page first and then focus "Not now", with the action cut short', async () => {
    const { initNetwork } = await import('@shiro/desktop/network');
    const page = document.createElement('div');
    document.body.appendChild(page);
    // (the test DOM has no focus of its own: record what is focused, and whether it was in the page by then)
    const focused: string[] = [];
    let proto: any = Object.getPrototypeOf(document.createElement('button'));
    while (proto && proto.constructor?.name !== 'HTMLElement' && Object.getPrototypeOf(proto)?.constructor?.name !== 'Object') proto = Object.getPrototypeOf(proto);
    const had = Object.getOwnPropertyDescriptor(proto, 'focus');
    proto.focus = function (this: HTMLElement) { focused.push(`${this.dataset?.act ?? this.tagName}:${page.contains(this)}`); };
    try {
      off();
      initNetwork({ root: page, openApp: async () => {} } as any, {} as any, document.createElement('button'));
      const long = `gh api ${'y'.repeat(100)}`;
      // the sign-in sheet
      localStorage.removeItem(KEY);
      const signIn = askGitHubSignIn({ action: long, kind: 'account' });
      let sheet = page.querySelector('.sd-sheet')!;
      expect(sheet.querySelector('h3')!.textContent).toBe('Sign in with GitHub to finish');
      expect(focused).toEqual(['later:true']);
      expect(sheet.querySelector('code')!.textContent).toBe(long.slice(0, 60) + '…');
      expect(sheet.textContent).not.toContain('y'.repeat(61));
      (sheet.querySelector('[data-act=later]') as HTMLElement).click();
      expect(await signIn).toBeNull();
      // the sheet for more permissions
      focused.length = 0;
      resetGitHubNeedDecline();
      localStorage.setItem(KEY, 'gho_saved');
      const more = askGitHubSignIn({ action: long, kind: 'scopes', add: ['read:project'], scopes: ['repo', 'read:project'] });
      sheet = [...page.querySelectorAll('.sd-sheet')].at(-1)!;
      expect(sheet.querySelector('h3')!.textContent).toBe('One more permission from GitHub');
      expect(focused).toEqual(['later:true']);
      expect(sheet.querySelector('code')!.textContent).toBe(long.slice(0, 60) + '…');
      expect([...sheet.querySelectorAll('.sd-sheet-actions button')].map((b) => b.textContent)).toEqual(['Not now', 'Approve on GitHub']);
      (sheet.querySelector('[data-act=later]') as HTMLElement).click();
      expect(await more).toBeNull();
    } finally {
      if (had) Object.defineProperty(proto, 'focus', had); else delete proto.focus;
      page.remove();
      resetGitHubNeedDecline();
    }
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

  it('hotswap push, not signed in, opens the question', async () => {
    const { shell } = await createTestShell();
    shell.commands.register(hotswapCmd);
    let out = '';
    const w = (s: string) => { out += s; };
    const code = await shell.execute('mkdir -p /tmp/co && hotswap push try-it -m msg --root /tmp/co', w, w);
    expect(code).toBe(1);
    expect(out).toContain('not signed in to GitHub');
    expect(asked.map((n) => n.action)).toEqual(['hotswap push']);
  });
});

describe('github-needed: links and installs from GitHub', () => {
  const COMMIT = 'c0ffee'.padEnd(40, '0');
  const MANIFEST = JSON.stringify({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public' });
  const SCRIPT = '#!/bin/sh\necho hello\n';
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

  /** A stand-in GitHub: `limited` answers visitors with the rate limit, `isPrivate` with 404; a token gets the files */
  function github(opts: { limited?: boolean; isPrivate?: boolean }) {
    const calls: { url: string; auth: string | undefined }[] = [];
    const files: Record<string, string> = {
      'https://api.github.com/repos/a/b/commits/HEAD': COMMIT,
      [`https://api.github.com/repos/a/b/contents/app.json?ref=${COMMIT}`]: MANIFEST,
      [`https://raw.githubusercontent.com/a/b/${COMMIT}/app.json`]: MANIFEST,
      'https://api.github.com/repos/a/b/contents/.tabcomputer/run.sh?ref=HEAD': SCRIPT,
      'https://raw.githubusercontent.com/a/b/HEAD/.tabcomputer/run.sh': SCRIPT,
      // (the account is there for anyone to see, and so is its public repository `open`, which has no script)
      'https://api.github.com/users/a': '{"login":"a"}',
      'https://api.github.com/repos/a/open': '{"full_name":"a/open","private":false}',
    };
    const fetchFn = async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push({ url, auth });
      const api = url.startsWith('https://api.github.com/');
      if (!auth && opts.limited && api) return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      if (!auth && opts.isPrivate && !url.startsWith('https://api.github.com/users/')) return new Response('Not Found', { status: 404 });
      if (auth && !api) return new Response('preflight refused', { status: 403 }); // the raw host takes no token from a page
      return files[url] === undefined ? new Response('Not Found', { status: 404 }) : new Response(files[url], { status: 200, headers: { 'content-type': api ? 'application/vnd.github.raw+json' : 'text/plain' } });
    };
    return { calls, fetchFn };
  }

  it('the rate limit for visitors: asks, then fetches again signed in', async () => {
    const { calls, fetchFn } = github({ limited: true });
    await expect(fetchGhApp({ owner: 'a', repo: 'b', path: '' }, fetchFn)).rejects.toThrow(GITHUB_RATE_LIMITED);
    calls.length = 0;
    const app = await fetchSignedIn('app install gh:a/b', (token) => fetchGhApp({ owner: 'a', repo: 'b', path: '' }, fetchFn, token));
    expect(app.manifest.id).toBe('demo');
    expect(asked).toEqual([{ action: 'app install gh:a/b', kind: 'rate-limit' }]);
    // the visitor's one request, then every request with the token, files through the API
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      ['https://api.github.com/repos/a/b/commits/HEAD', undefined],
      ['https://api.github.com/repos/a/b/commits/HEAD', 'Bearer gho_test'],
      [`https://api.github.com/repos/a/b/contents/app.json?ref=${COMMIT}`, 'Bearer gho_test'],
    ]);
  });

  it('a private repository: a run link and an app link ask, then go on', async () => {
    const run = github({ isPrivate: true });
    const target = parseRunUrl('?run=gh:a/b')!.target;
    await expect(loadScript(target, 'https://tab.example', run.fetchFn)).rejects.toThrow(/a private repository needs a GitHub sign-in/);
    const reports: string[] = [];
    const opened: string[] = [];
    const outcome = await handleRunLink({
      search: '?run=gh:a/b', origin: 'https://tab.example', home: '/home/user', framed: false, fetch: run.fetchFn,
      github: fetchSignedIn,
      fs: { mkdir: async () => {}, writeFile: async () => {}, exists: async () => false },
      cleanUrl: () => {}, confirm: async (info) => { expect(info.script).toBe(SCRIPT); return true; },
      openTerminal: (o) => { opened.push(o.command); }, report: (m) => { reports.push(m); },
    });
    expect(reports).toEqual([]);
    expect(outcome).toBe('ran');
    expect(opened).toHaveLength(1);
    expect(asked).toEqual([{ action: 'gh:a/b', kind: 'private' }]);
    expect(run.calls.at(-1)).toEqual({ url: 'https://api.github.com/repos/a/b/contents/.tabcomputer/run.sh?ref=HEAD', auth: 'Bearer gho_test' });

    // signed in now: the app link uses the token after the visitor's try, without asking again
    asked = [];
    const app = github({ isPrivate: true });
    const shown: string[] = [];
    expect(await handleAppLink({
      search: '?app=gh:a/b', origin: 'https://tab.example', framed: false, fetch: app.fetchFn, github: fetchSignedIn,
      cleanUrl: () => {}, installedSource: async () => `gh:a/b@${COMMIT}`, confirm: async () => 'install',
      install: async () => {}, open: async (id) => { shown.push(id); }, openInGuest: async () => false, report: (m) => { reports.push(m); },
    })).toBe('opened');
    expect(reports).toEqual([]);
    expect(shown).toEqual(['demo']);
    expect(asked).toEqual([]);
  });

  it('"Not now", or no one to ask: the visitor\'s failure stands', async () => {
    answer = null;
    const { fetchFn } = github({ isPrivate: true });
    const reports: string[] = [];
    expect(await handleAppLink({
      search: '?app=gh:a/b', origin: 'https://tab.example', framed: false, fetch: fetchFn, github: fetchSignedIn,
      cleanUrl: () => {}, installedSource: async () => null, confirm: async () => 'install',
      install: async () => {}, open: async () => {}, openInGuest: async () => false, report: (m) => { reports.push(m); },
    })).toBe('refused');
    expect(reports).toEqual(['github.com/a/b does not exist, or it is private: a private repository needs a GitHub sign-in']);
    // a command with no terminal does not wait: the question opens beside the failure
    asked = []; resetGitHubNeedDecline();
    let release!: (t: string | null) => void;
    off(); off = setGitHubNeedHandler((need) => { asked.push(need); return new Promise((r) => { release = r; }); });
    await expect(fetchSignedIn('app install gh:a/b', (token) => fetchGhApp({ owner: 'a', repo: 'b', path: '' }, fetchFn, token), { wait: false }))
      .rejects.toThrow(/needs a GitHub sign-in\n\(A window opened to sign in to GitHub\. Sign in there, then run app install gh:a\/b again\.\)/);
    expect(asked).toEqual([{ action: 'app install gh:a/b', kind: 'private', afterFailure: true }]);
    release(null);
    await new Promise((r) => setTimeout(r, 0));
    // a repository that is not there for the signed-in account either: GitHub's answer, once
    localStorage.setItem(KEY, 'gho_saved');
    const none = github({});
    await expect(fetchSignedIn('gh:a/zzz', (token) => fetchGhApp({ owner: 'a', repo: 'zzz', path: '' }, none.fetchFn, token)))
      .rejects.toThrow('github.com/a/zzz does not exist (or this GitHub account cannot read it)');
    // (the visitor's try, whether the account exists, the try with the token)
    expect(none.calls.map((c) => [c.url.replace('https://api.github.com/', ''), !!c.auth])).toEqual([['repos/a/zzz/commits/HEAD', false], ['users/a', false], ['repos/a/zzz/commits/HEAD', true]]);
  });

  it('a 404 that no sign-in would change is said at once, and nobody is asked', async () => {
    const { fetchFn, calls } = github({});
    const reports: string[] = [];
    const link = (search: string) => handleRunLink({
      search, origin: 'https://tab.example', home: '/home/user', framed: false, fetch: fetchFn, github: fetchSignedIn,
      fs: { mkdir: async () => {}, writeFile: async () => {}, exists: async () => false },
      cleanUrl: () => {}, confirm: async () => true, openTerminal: () => {}, report: (m) => { reports.push(m); },
    });
    // a typo in the account's name: GitHub has no such account, so it has no private repository either
    expect(await link('?run=gh:nobody/missing')).toBe('refused');
    expect(reports.pop()).toBe('github.com/nobody/missing does not exist: GitHub has no account named nobody');
    // a public repository without the script: the repository answers a visitor for itself
    expect(await link('?run=gh:a/open')).toBe('refused');
    expect(reports.pop()).toBe('github.com/a/open has no .tabcomputer/run.sh');
    expect(asked).toEqual([]);
    // the same for an app in a repository
    await expect(fetchSignedIn('gh:nobody/tool', (token) => fetchGhApp({ owner: 'nobody', repo: 'tool', path: '' }, fetchFn, token))).rejects.toThrow('github.com/nobody/tool does not exist: GitHub has no account named nobody');
    expect(asked).toEqual([]);
    // an account that exists and a repository GitHub does not show a visitor: it may be private, so the sign-in is offered
    answer = null;
    expect(await link('?run=gh:a/secret')).toBe('refused');
    expect(asked).toEqual([{ action: 'gh:a/secret', kind: 'private' }]);
    expect(reports.pop()).toBe('github.com/a/secret, .tabcomputer/run.sh does not exist, or it is private: a private repository needs a GitHub sign-in');
    // GitHub's limit reached while asking: nothing is known, so the visitor's message stands
    expect(await githubNotThere('a', 'b', async () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 'x.sh')).toBeNull();
    expect(await githubNotThere('a', 'b', async () => { throw new Error('offline'); })).toBeNull();
    // every question went to GitHub's API, as a visitor
    expect(calls.filter((c) => c.auth).length).toBe(0);
  });

  it('the token goes to GitHub only, and a redirected answer stays a redirect', async () => {
    const seen: (string | undefined)[] = [];
    const f = githubTokenFetch(async (url, init) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.authorization);
      return url.includes('moved') ? Object.defineProperty(new Response('x'), 'redirected', { value: true }) : new Response('x');
    }, 'gho_t');
    await f('https://example.com/app.tar.gz');
    await f('https://gist.githubusercontent.com/u/abc/raw');
    await f('https://api.github.com/gists/abc');
    expect(seen).toEqual([undefined, undefined, 'Bearer gho_t']);
    expect((await f('https://raw.githubusercontent.com/a/b/HEAD/moved.sh')).redirected).toBe(true);
  });
});
