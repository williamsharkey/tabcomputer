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
 * The question is the desktop's sheet (src/desktop/network.ts registers it); the
 * terminal UI goes straight to the one-time code (`deviceFlowAsker`).
 */

import type { CommandContext } from './commands/index';
import { networkCredential, setNetworkStatus } from './net-signin';

export type GitHubNeedKind = 'private' | 'rate-limit' | 'account';

export interface GitHubNeed {
  /** What the user was doing, as they typed it: "git clone", "gh issue list" */
  action: string;
  kind: GitHubNeedKind;
  /** Nothing is waiting for the answer: the command has already failed */
  afterFailure?: boolean;
}

/** Why GitHub wants the sign-in, one sentence per kind */
export const GITHUB_NEED_REASON: Record<GitHubNeedKind, string> = {
  private: 'GitHub did not give this repository to a visitor who is not signed in. The repository is private, or its name is wrong.',
  'rate-limit': 'GitHub allows 60 requests an hour from one network address without a sign-in, and they are used up. A signed-in account gets 5,000.',
  account: 'GitHub only does this for a signed-in account.',
};

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

/** Ask for the sign-in. The token, or null: no UI, "not now", cancelled, or asked and declined in the last minute. */
export function askGitHubSignIn(need: GitHubNeed): Promise<string | null> {
  const saved = networkCredential();
  if (saved) return Promise.resolve(saved);
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
export async function deviceFlowAsker(): Promise<string | null> {
  const gh = await import('./github-auth');
  try {
    const code = await gh.requestDeviceCode(gh.DEFAULT_GITHUB_SCOPES);
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
 * Run a command; if it failed for want of a GitHub sign-in, ask for one and
 * run it again. `run` must be safe to call twice (the first call failed before
 * it changed anything: no token, or GitHub refused the first request).
 */
export async function retrySignedIn(ctx: CommandContext, action: string, run: () => Promise<number>): Promise<number> {
  const args = [...ctx.args];
  const code = await run();
  if (code === 0 || hasToken(ctx) || ctx.env['TABCOMPUTER_GITHUB_PROMPT'] === '0') return code;
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
