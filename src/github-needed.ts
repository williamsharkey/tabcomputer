/**
 * A command failed because this tab is not signed in to GitHub: ask for the
 * sign-in, then run the command again, instead of leaving the user with
 * "Run: gh auth login".
 *
 * `retrySignedIn(ctx, action, run)` wraps a command. It runs it; when it fails,
 * there is no token, and its stderr says a sign-in would have helped
 * (`githubSignInWanted`), the user is asked:
 *   - at a terminal the command waits for the answer, and runs again once
 *     signed in;
 *   - without a terminal (Claude's Bash tool, a script) nothing waits: the
 *     question opens beside the failure, and the message says to run it again.
 * `fetchSignedIn(action, run)` is the same for a fetch outside a command (a
 * `?run=gh:` or `?app=gh:` link, `app install gh:`): `run(null)` as a visitor;
 * when that fails for want of a sign-in, the tab's token (asked for if there
 * is none) and `run(token)`.
 * The question is the desktop's sheet (src/desktop/network.ts registers it); the
 * terminal UI goes straight to the one-time code (`deviceFlowAsker`).
 *
 * More permissions for the sign-in that is there (`retryWithScopes`) are asked
 * for only where the failure is GitHub's own word: `gh` and its extensions,
 * and `git` when the remote it talked to is github.com. And only for the
 * scopes of `SCOPES_ASKED`; for any other the command's failure stands, with
 * one line naming `gh auth refresh -s`.
 */

import type { CommandContext } from './commands/index';
import { networkCredential, setNetworkStatus } from './net-signin';

export type GitHubNeedKind = 'private' | 'rate-limit' | 'account' | 'scopes';

export interface GitHubNeed {
  /** What the user was doing, as they typed it: "git clone", "gh issue list" */
  action: string;
  kind: GitHubNeedKind;
  /** Nothing is waiting for the answer: the command has already failed */
  afterFailure?: boolean;
  /** kind 'scopes': the permissions the sign-in here lacks, which are being added */
  add?: string[];
  /** kind 'scopes': every permission to ask GitHub for (what the sign-in has, and `add`) */
  scopes?: string[];
}

/** Why GitHub wants the sign-in, one sentence per kind */
export const GITHUB_NEED_REASON: Record<GitHubNeedKind, string> = {
  private: 'GitHub did not give this repository to a visitor who is not signed in. The repository is private, or its name is wrong.',
  'rate-limit': 'GitHub allows 60 requests an hour from one network address without a sign-in, and they are used up. A signed-in account gets 5,000.',
  account: 'GitHub only does this for a signed-in account.',
  scopes: 'The GitHub sign-in on this computer does not allow it yet.',
};

/** What each permission GitHub calls a scope lets a program do, in plain words (after "to …") */
const SCOPE_WORDS: Record<string, string> = {
  repo: 'read and change your repositories, the private ones too',
  public_repo: 'read and change your public repositories',
  'repo:status': 'read and set commit statuses',
  delete_repo: 'delete repositories',
  workflow: 'change GitHub Actions workflow files',
  gist: 'create and change gists',
  user: 'read and change your profile',
  'read:user': 'read your profile',
  'user:email': 'see your email addresses',
  'user:follow': 'follow and unfollow people',
  'read:org': 'see which organizations and teams you belong to',
  'write:org': 'change who belongs to your organizations and their teams',
  'admin:org': 'manage your organizations, their teams and their members',
  project: 'read and change projects',
  'read:project': 'read projects',
  codespace: 'create and manage codespaces',
  notifications: 'read your notifications',
  'read:packages': 'download packages',
  'write:packages': 'publish packages',
  'delete:packages': 'delete packages',
  'admin:public_key': 'manage the SSH keys of your account',
  'admin:repo_hook': 'manage the webhooks of your repositories',
  'admin:org_hook': 'manage the webhooks of your organizations',
  'admin:gpg_key': 'manage the GPG keys of your account',
  security_events: 'read and change security alerts',
  'read:discussion': 'read team discussions',
  'write:discussion': 'read and write team discussions',
};
const SCOPE_NAME = /^[a-z][a-z_]*(:[a-z_]+)?$/;

/**
 * The scopes a failing command may get the sheet for: what a classroom or
 * developer tool needs to read and write repositories, gists, projects and
 * organization membership (`gh student`, Classroom 50's extension, needs
 * admin:org, tabcomputer#153). Deleting repositories, keys, webhooks,
 * enterprises, packages to publish or delete, and the profile itself are not
 * here: a person who wants one of those types `gh auth refresh -s` themselves.
 */
export const SCOPES_ASKED: ReadonlySet<string> = new Set([
  'repo', 'public_repo', 'repo:status', 'workflow', 'gist',
  'read:org', 'write:org', 'admin:org',
  'read:user', 'user:email',
  'read:project', 'project',
  'read:packages', 'read:discussion', 'notifications', 'codespace',
]);

/** Longest `action` a sheet shows: a command's first words are enough to know it by */
export const ACTION_MAX = 60;

/** What the person was doing, as the sheets show it: one line, at most ACTION_MAX characters and an ellipsis */
export function actionText(action: string): string {
  const line = String(action).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > ACTION_MAX ? line.slice(0, ACTION_MAX).trimEnd() + '…' : line;
}

/** The permissions being added, as a sentence: "This adds permission to manage your organizations, their teams and their members (admin:org)." */
export function scopesSentence(add: string[]): string {
  const said = add.map((s) => (SCOPE_WORDS[s] ? `${SCOPE_WORDS[s]} (${s})` : `do what GitHub calls ${s}`));
  if (said.length === 1) return `This adds permission to ${said[0]}.`;
  return `This adds ${said.length} permissions: to ${said.slice(0, -1).join('; to ')}; and to ${said[said.length - 1]}.`;
}

/**
 * The scopes a failed command's stderr says its token lacks, or null. gh and
 * its extensions name them in a few forms:
 *   … is missing scopes gh student needs (admin:org, read:org, repo, workflow) …
 *   error: your authentication token is missing required scopes [read:project]
 *   This API operation needs the "read:project" scope. To request it, run:  gh auth refresh -s read:project
 */
export function missingScopes(stderr: string): string[] | null {
  const found = new Set<string>();
  const take = (list: string) => { for (const s of list.split(/[\s,]+/)) { const name = s.replace(/^["'`]+|["'`.]+$/g, ''); if (SCOPE_NAME.test(name)) found.add(name); } };
  for (const m of stderr.matchAll(/missing (?:the )?(?:required |necessary )?scopes?[^\n([]*[([]([^)\]\n]+)[)\]]/gi)) take(m[1]);
  for (const m of stderr.matchAll(/needs? the ["'`]([a-z_:]+)["'`] scope/gi)) take(m[1]);
  for (const m of stderr.matchAll(/gh auth refresh(?:\s+(?:-h|--hostname)\s+\S+)?\s+(?:-s|--scopes)[ =]([a-z_:,]+)/gi)) take(m[1]);
  return found.size && found.size <= 20 ? [...found] : null;
}

/** What a failed command's stderr says about a missing sign-in, or null */
export function githubSignInWanted(stderr: string): GitHubNeedKind | null {
  if (/rate limit/i.test(stderr) && /gh auth login|not signed in|limit is 5,000/i.test(stderr)) return 'rate-limit';
  if (/private repositor(y|ies) needs? a GitHub sign-in/i.test(stderr)) return 'private';
  if (/not signed in to GitHub|not logged into any GitHub hosts|needs a GitHub sign-in/i.test(stderr)) return 'account';
  return null;
}

type Asker = (need: GitHubNeed) => Promise<string | null>;
let asker: Asker | null = null;
let pending: Promise<string | null> | null = null;
/** "Not now" holds for a while, so a loop of failing commands does not ask every time */
let declinedUntil = 0;
const DECLINE_MS = 60_000;

/** Register the UI that asks (the desktop's sheet, or the terminal UI's panel). Returns unregister. */
export function setGitHubNeedHandler(h: Asker): () => void {
  asker = h;
  return () => { if (asker === h) asker = null; };
}

/** Forget a "not now" (tests, and a sign-in the user started themselves) */
export function resetGitHubNeedDecline(): void {
  declinedUntil = 0;
}

/**
 * Ask for the sign-in (kind 'scopes': for more permissions on the sign-in
 * that is there). The token, or null: no UI, "not now", cancelled, or asked
 * and declined in the last minute.
 */
export function askGitHubSignIn(need: GitHubNeed): Promise<string | null> {
  // (the sheet shows the action: a command line of any length, cut to its first words)
  need = { ...need, action: actionText(need.action) };
  const saved = networkCredential();
  if (saved && need.kind !== 'scopes') return Promise.resolve(saved);
  if (pending) return pending;
  if (!asker || Date.now() < declinedUntil) return Promise.resolve(null);
  pending = asker(need).then((tok) => {
    if (!tok) declinedUntil = Date.now() + DECLINE_MS;
    else setNetworkStatus('signed-in');
    return tok;
  }, () => null).finally(() => { pending = null; });
  return pending;
}

/** The terminal UI has no sheet: open the one-time-code panel directly */
export async function deviceFlowAsker(need?: GitHubNeed): Promise<string | null> {
  const gh = await import('./github-auth');
  try {
    const code = await gh.requestDeviceCode(need?.scopes ?? gh.DEFAULT_GITHUB_SCOPES);
    const panel = gh.openGitHubLoginPanel(code);
    try {
      const token = await gh.pollForToken(code, { signal: panel.signal, onStatus: (s) => panel.setStatus(s === 'slow_down' ? 'Still waiting…' : 'Waiting for you to approve on GitHub…') });
      gh.saveGitHubToken(token);
      panel.setStatus('Signed in.', 'ok');
      setTimeout(() => panel.close(), 1200);
      return token;
    } catch (e) {
      panel.setStatus(`Sign-in failed: ${(e as Error)?.message ?? e}`, 'err');
      return null;
    }
  } catch { return null; }
}

function hasToken(ctx: CommandContext): boolean {
  return !!(ctx.env['GITHUB_TOKEN'] || ctx.env['GH_TOKEN'] || networkCredential());
}

/** A person is at this command: a terminal, with stdin and stderr not redirected, and no "do not prompt" setting */
function interactive(ctx: CommandContext): boolean {
  if (!ctx.terminal || ctx.stdinIsTTY === false || ctx.stderrIsTTY === false) return false;
  return !ctx.env['GH_PROMPT_DISABLED'] && !ctx.env['CI'] && ctx.env['GIT_TERMINAL_PROMPT'] !== '0';
}

/**
 * A fetch of GitHub that is not a command's: as a visitor first, and with the
 * tab's sign-in when GitHub refused the visitor (a private repository, the
 * rate limit). `wait: false` (nobody is at a terminal): the question opens
 * beside the failure and the failure stands.
 */
export async function fetchSignedIn<T>(action: string, run: (token: string | null) => Promise<T>, opts: { wait?: boolean } = {}): Promise<T> {
  try { return await run(null); } catch (e) {
    const kind = githubSignInWanted(String((e as Error)?.message ?? e));
    if (!kind) throw e;
    const saved = networkCredential();
    if (!saved && opts.wait === false) {
      if (asker && Date.now() >= declinedUntil && !pending) {
        void askGitHubSignIn({ action, kind, afterFailure: true });
        if (e instanceof Error) e.message += `\n(A window opened to sign in to GitHub. Sign in there, then run ${action} again.)`;
      }
      throw e;
    }
    const token = saved ?? await askGitHubSignIn({ action, kind });
    if (!token) throw e;
    return run(token);
  }
}

/** A scope that has others inside it: a token with the first can do what the others allow */
const HOLDS: Record<string, string[]> = {
  repo: ['public_repo', 'repo:status', 'repo_deployment', 'security_events'],
  user: ['read:user', 'user:email', 'user:follow'],
  'admin:org': ['write:org', 'read:org'], 'write:org': ['read:org'],
  project: ['read:project'],
  'write:packages': ['read:packages'],
  'write:discussion': ['read:discussion'],
};

let scopesReader: ((token: string) => Promise<string[]>) | null = null;
/** Tests: say what scopes a token has without asking GitHub */
export function setTokenScopesReader(fn: ((token: string) => Promise<string[]>) | null): void { scopesReader = fn; }

/**
 * A signed-in command failed, and what it printed names scopes its token
 * lacks (tabcomputer#153: `gh student` needs admin:org). The tab's sign-in can
 * be given them: ask for exactly those, and run the command again. A token
 * the person exported themselves is theirs to re-issue, so nothing is asked.
 */
async function retryWithScopes(ctx: CommandContext, action: string, run: () => Promise<number>, args: string[], code: number, opts: RetryOptions): Promise<number> {
  const named = missingScopes(ctx.stderr + (ctx.stderrSeen ?? ''));
  const saved = networkCredential();
  const own = ctx.env['GH_TOKEN'] || ctx.env['GITHUB_TOKEN'];
  if (!named || !asker || !saved || (own && own !== saved)) return code;
  // Only where the text that names the scopes is GitHub's or gh's: gh and its extensions, and git on a github.com remote
  const fromGitHub = /^gh(\s|$)/.test(action) || (/^git\s/.test(action) && !!(await Promise.resolve(opts.githubRemote?.()).catch(() => false)));
  if (!fromGitHub) return code;
  let have: string[];
  try { have = await (scopesReader ?? (async (t) => (await import('./github-auth')).tokenScopes(t)))(saved); } catch { return code; }
  const held = new Set([...have, ...have.flatMap((s) => HOLDS[s] ?? [])]);
  const add = named.filter((s) => !held.has(s));
  // (it has them all: the failure is about something else)
  if (!add.length) return code;
  // A permission outside the list is never asked for on a command's word: the failure stands, and one line says how to add it
  const refused = add.filter((s) => !SCOPES_ASKED.has(s));
  if (refused.length) {
    ctx.stderr += `tabcomputer does not add ${refused.join(', ')} to the GitHub sign-in because a command asked. To add ${add.length === 1 ? 'it' : 'what this command named'} yourself: gh auth refresh -s ${add.join(',')}\n`;
    return code;
  }
  const { DEFAULT_GITHUB_SCOPES } = await import('./github-auth');
  const need: GitHubNeed = { action, kind: 'scopes', add, scopes: [...new Set([...DEFAULT_GITHUB_SCOPES, ...have, ...add])] };
  if (!interactive(ctx)) {
    if (Date.now() >= declinedUntil && !pending) {
      void askGitHubSignIn({ ...need, afterFailure: true });
      ctx.stderr += `(A window opened to give the GitHub sign-in here ${add.length === 1 ? 'that permission' : 'those permissions'}. Approve there, then run ${action} again.)\n`;
    }
    return code;
  }
  const say = (s: string) => ctx.terminal!.writeOutput(s.replace(/\n/g, '\r\n'));
  say(`${action} needs ${add.length === 1 ? 'a permission' : 'permissions'} the GitHub sign-in here does not have (${add.join(', ')}). A window opened to add ${add.length === 1 ? 'it' : 'them'}.\n`);
  const token = await askGitHubSignIn(need);
  if (!token) return code; // the first run's message stands
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) if (ctx.env[name]) ctx.env[name] = token;
  say(`GitHub added ${add.length === 1 ? 'it' : 'them'}. Running ${action} again.\n`);
  ctx.args = args;
  ctx.stdout = '';
  ctx.stderr = '';
  ctx.stderrSeen = '';
  return run();
}

export interface RetryOptions {
  /** For `git`: whether the remote the command talked to is on github.com (asked only when a failure names scopes) */
  githubRemote?: () => boolean | Promise<boolean>;
}

/** A person is at this command (`fetchSignedIn`'s `wait`) */
export function atTerminal(ctx: CommandContext): boolean {
  return interactive(ctx) && ctx.env['TABCOMPUTER_GITHUB_PROMPT'] !== '0';
}

/**
 * Run a command; if it failed for want of a GitHub sign-in, ask for one and
 * run it again. `run` must be safe to call twice (the first call failed before
 * it changed anything: no token, or GitHub refused the first request).
 */
export async function retrySignedIn(ctx: CommandContext, action: string, run: () => Promise<number>, opts: RetryOptions = {}): Promise<number> {
  const args = [...ctx.args];
  const code = await run();
  if (code === 0 || ctx.env['TABCOMPUTER_GITHUB_PROMPT'] === '0') return code;
  if (hasToken(ctx)) return retryWithScopes(ctx, action, run, args, code, opts);
  const kind = githubSignInWanted(ctx.stderr);
  if (!kind || !asker) return code;
  if (!interactive(ctx)) {
    // Nobody to wait for: leave the failure as it is and open the question beside it
    if (Date.now() >= declinedUntil && !pending) {
      void askGitHubSignIn({ action, kind, afterFailure: true });
      ctx.stderr += `(A window opened to sign in to GitHub. Sign in there, then run ${action} again.)\n`;
    }
    return code;
  }
  const say = (s: string) => ctx.terminal!.writeOutput(s.replace(/\n/g, '\r\n'));
  say(`${action} needs a GitHub sign-in. A window opened to sign in.\n`); // (the window gives the reason)
  const token = await askGitHubSignIn({ action, kind });
  if (!token) return code; // the first run's message stands
  ctx.env['GITHUB_TOKEN'] = token;
  try {
    const gh = await import('./github-auth');
    await gh.ensureGitIdentity(ctx.fs, token);
  } catch { /* identity is a convenience */ }
  say(`Signed in to GitHub. Running ${action} again.\n`);
  ctx.args = args;
  ctx.stdout = '';
  ctx.stderr = '';
  return run();
}
