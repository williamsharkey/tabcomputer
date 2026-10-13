/**
 * Network status in the menu bar, and the sign-in sheet behind
 * requireNetworkSignIn (src/net-signin.ts): the desktop boots straight to
 * work; the first time a program needs outbound network that requires a
 * sign-in, a non-blocking sheet offers "Sign in with GitHub" (OAuth device
 * flow, src/github-auth.ts). The token is saved, so later visits connect
 * silently.
 */

import { githubApiBase } from '../net-mode';
import {
  networkCredential, networkStatus, onNetworkStatus, setNetworkSignInHandler, setNetworkStatus,
  resetNetworkDecline, ownRelay, onOwnRelayChange, probeRelayToken, relayTokenUrlFor, type NetworkNeed, type NetworkStatus,
} from '../net-signin';
import type { Kernel } from '../kernel/kernel';
import type { FileSystem } from '../filesystem';
import type { WindowManager } from './wm';
import { GLYPHS } from './icons';
import { guestInfo } from '../guest';

const GLOBE = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.7 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.7-3.8-9S9.4 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;

let root: HTMLElement;
let fsRef: FileSystem;
let wmRef: WindowManager;
import { setGitHubNeedHandler, scopesSentence, GITHUB_NEED_REASON, type GitHubNeed } from '../github-needed';

/** What the sheet is asked for: a network sign-in, or a GitHub sign-in a command needs (github-needed.ts) */
type SheetNeed = NetworkNeed & { github?: GitHubNeed };

let current: { el: HTMLElement; done: (tok: string | null) => void; promise: Promise<string | null> } | null = null;

export function initNetwork(wm: WindowManager, fs: FileSystem, button: HTMLElement, _kernel?: Kernel): void {
  root = wm.root;
  fsRef = fs;
  wmRef = wm;
  // "Use my own connection" (Settings → Network): boot points the kernel's sockets at the
  // chosen relay in both UIs (followRelaySetting, src/kernel/net.ts); here only the status.
  onOwnRelayChange(() => { setNetworkStatus(navigator.onLine ? 'online' : 'offline'); });
  // A guest never asks for a sign-in by itself: a token saved there is the guest's to read
  if (!guestInfo()) setNetworkSignInHandler((need) => showSignInSheet(need));
  // A command that failed for want of a GitHub sign-in asks through the same sheet
  if (!guestInfo()) setGitHubNeedHandler((need) => showSignInSheet({ github: need }));
  const initial: NetworkStatus = guestInfo()?.noNetwork ? 'unavailable' : !navigator.onLine ? 'offline' : networkCredential() ? 'signed-in' : 'online';
  setNetworkStatus(initial);
  window.addEventListener('online', () => setNetworkStatus(guestInfo()?.noNetwork ? 'unavailable' : networkCredential() ? 'signed-in' : 'online'));
  window.addEventListener('offline', () => setNetworkStatus('offline'));
  const paint = (s: NetworkStatus) => {
    // Globe + status dot: green signed in, blue online, amber needs sign-in, gray offline
    button.innerHTML = `${GLYPHS.net}<span class="sd-net-dot"></span>`;
    button.title = statusText(s);
    button.setAttribute('aria-label', `Network: ${statusText(s)}`);
    button.dataset.status = s;
  };
  paint(networkStatus());
  onNetworkStatus(paint);
  button.addEventListener('click', (e) => { e.stopPropagation(); togglePopover(wm, button); });
}

export function statusText(s: NetworkStatus): string {
  switch (s) {
    case 'signed-in': return 'Connected — signed in';
    case 'online': return 'Online';
    case 'needs-sign-in': return 'Sign in to connect to the internet';
    case 'offline': return 'Offline';
    case 'unavailable': return guestInfo()?.noNetwork ? 'No network in this guest' : 'Internet relay is off on this server';
    default: return 'Checking…';
  }
}

/**
 * Check a relay of the user's own: fetch a token (from its token URL, or
 * where server.mjs would have one when none was given), then open (and close)
 * a WebSocket. Resolves to null when reachable, else why not.
 */
export async function testOwnRelay(url: string, tokenUrl?: string, timeoutMs = 6000): Promise<string | null> {
  let token: string | null = null;
  if (tokenUrl) {
    try {
      const r = await fetch(tokenUrl, { method: 'POST' });
      if (!r.ok) return `token request answered ${r.status}`;
      token = (await r.json().catch(() => null))?.token ?? null;
      if (typeof token !== 'string' || !token) return 'the token URL answered without a token (is it the relay\'s /tcp/token?)';
    } catch (e) { return `token request failed (${(e as Error)?.message ?? e}; is this site allowed by its CORS/origin list?)`; }
  } else {
    // No token URL: try where server.mjs has one; a relay with nothing there is used without a token
    const guess = relayTokenUrlFor(url);
    const r = guess ? await fetch(guess, { method: 'POST' }).catch(() => null) : null;
    if (r?.status === 401) return 'this relay requires a sign-in (tick the box to give it yours)';
    if (r?.status === 403) return 'the relay refused this site (is it in the relay\'s TABCOMPUTER_TCP_ORIGINS?)';
    const t = r?.ok ? (await r.json().catch(() => null))?.token : null;
    if (typeof t === 'string' && t) token = t;
  }
  return new Promise((resolve) => {
    let ws: WebSocket;
    try { ws = new WebSocket(token ? `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}` : url); }
    catch (e) { resolve(`bad URL: ${(e as Error)?.message ?? e}`); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve('no answer within 6 s'); }, timeoutMs);
    ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(null); };
    ws.onerror = () => { clearTimeout(timer); resolve('the relay refused the connection (wrong URL, not running, or this site is not in its allowed origins)'); };
  });
}

/**
 * Ask the relay whether it would let this browser connect: updates the status.
 * 'unavailable' when the server has no relay, or it refuses this page.
 */
export async function probeRelay(): Promise<NetworkStatus> {
  if (guestInfo()?.noNetwork) { setNetworkStatus('unavailable'); return 'unavailable'; }
  if (!navigator.onLine) { setNetworkStatus('offline'); return 'offline'; }
  const own = ownRelay();
  if (own) {
    const err = await testOwnRelay(own.url, own.tokenUrl);
    const s: NetworkStatus = err ? 'unavailable' : 'online';
    setNetworkStatus(s);
    return s;
  }
  const cred = networkCredential();
  // A 2xx is not enough: a server with no relay answers this path with the app shell.
  // The sign-in goes along only after the relay asked for one (a 401).
  let probe = await probeRelayToken('/tcp/token');
  if (probe === 'signin' && cred) probe = await probeRelayToken('/tcp/token', { credential: cred });
  const s: NetworkStatus = probe === 'on' ? (cred ? 'signed-in' : 'online')
    : probe === 'signin' ? 'needs-sign-in'
    : probe === 'unknown' ? 'offline'
    : 'unavailable';
  setNetworkStatus(s);
  return s;
}

/** The GitHub login of the saved token, if it is still valid. */
export async function signedInAccount(): Promise<string | null> {
  const tok = networkCredential();
  if (!tok) return null;
  try {
    const res = await fetch(`${githubApiBase('')}/user`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    return (await res.json())?.login ?? null;
  } catch { return null; }
}

export function signOut(): void {
  try { localStorage.removeItem('tabcomputer_github_token'); } catch {}
  setNetworkStatus(navigator.onLine ? 'online' : 'offline');
}

/** Open the sheet on purpose (Settings, the menu bar): resolves to the token or null. */
export function openSignIn(need: NetworkNeed = {}): Promise<string | null> {
  resetNetworkDecline();
  return showSignInSheet({ reason: need.reason ?? 'Sign in to let programs on this computer reach the internet.', ...need }, true);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The button a sheet opens with the focus on: "Not now" when a command asked for GitHub, the sign-in when a person opened it; none otherwise */
export function sheetFocus(forCommand: boolean, manual: boolean): string {
  return manual ? '[data-act=github]' : forCommand ? '[data-act=later]' : '';
}

function showSignInSheet(need: SheetNeed, manual = false): Promise<string | null> {
  if (current) return current.promise;
  const sheet = el('div', 'sd-sheet');
  sheet.setAttribute('role', 'dialog');
  const gh = need.github;
  sheet.setAttribute('aria-label', gh ? 'Sign in with GitHub' : 'Connect to the internet');
  let resolveFn!: (tok: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolveFn = r; });
  const abort = new AbortController();
  // What had the focus (the terminal a command waits in) gets it back when the sheet goes
  const before = document.activeElement as HTMLElement | null;
  const done = (tok: string | null) => {
    if (!current || current.el !== sheet) return;
    current = null;
    abort.abort();
    sheet.classList.add('sd-leaving');
    setTimeout(() => sheet.remove(), 220);
    if (sheet.contains(document.activeElement) && before?.isConnected) before.focus?.();
    resolveFn(tok);
  };
  current = { el: sheet, done, promise };

  const what = need.host ? `${esc(need.reason ?? 'A program wants to connect')} (${esc(need.host)}${need.port ? ':' + need.port : ''}).` : esc(need.reason ?? 'A program wants to connect to the internet.');
  const ask = () => {
    // A command needs permissions the sign-in here lacks (tabcomputer#153): what is added, in plain words, and one button
    if (gh?.kind === 'scopes') {
      const add = gh.add ?? [];
      sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
        <h3>${add.length === 1 ? 'One more permission from GitHub' : 'More permissions from GitHub'}</h3>
        <p><code>${esc(gh.action)}</code> needs ${add.length === 1 ? 'a permission' : 'permissions'} the GitHub sign-in on this computer does not have. ${esc(scopesSentence(add))}</p>
        <p class="sd-small sd-muted">${gh.afterFailure ? `Approve on GitHub, then run <code>${esc(gh.action)}</code> again.` : `<code>${esc(gh.action)}</code> runs again by itself once GitHub has your approval.`}</p>
      </div></div>
      <div class="sd-sheet-actions">
        <span class="sd-grow"></span>
        <button class="sd-btn" data-act="later" type="button">Not now</button>
        <button class="sd-btn sd-primary" data-act="github" type="button">Approve on GitHub</button>
      </div>`;
      return;
    }
    // A command needs GitHub: the sign-in is the one prominent button, the rest is behind "Other ways"
    if (gh) {
      sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
        <h3>Sign in with GitHub to finish</h3>
        <p><code>${esc(gh.action)}</code> needs a GitHub sign-in. ${esc(GITHUB_NEED_REASON[gh.kind])}</p>
        <p class="sd-small sd-muted">${gh.afterFailure ? `Sign in, then run <code>${esc(gh.action)}</code> again.` : `<code>${esc(gh.action)}</code> runs again by itself once you are signed in.`}</p>
      </div></div>
      <div class="sd-sheet-actions">
        <button class="sd-link sd-small" data-act="other" type="button">Other ways</button>
        <span class="sd-grow"></span>
        <button class="sd-btn" data-act="later" type="button">Not now</button>
        <button class="sd-btn sd-primary" data-act="github" type="button">Sign in with GitHub</button>
      </div>
      <div class="sd-other sd-small sd-muted" hidden style="margin-top:10px">
        <label for="sd-gh-token">Paste a GitHub token</label>
        <div class="sd-row" style="gap:8px;border:0;padding:4px 0">
          <input id="sd-gh-token" class="sd-input sd-grow" type="password" autocomplete="off" spellcheck="false" placeholder="ghp_… or github_pat_…">
          <button class="sd-btn" data-act="token" type="button">Use token</button></div>
        <div class="sd-status-line"></div>
        ${gh.kind === 'rate-limit' ? '<div>Or wait: GitHub\'s limit for visitors resets within the hour.</div>' : ''}
        ${gh.kind === 'private' ? '<div>A public repository clones without a sign-in. Check the name if this one should be public.</div>' : ''}
        <div>In a terminal: <code>gh auth login</code>, or <code>gh auth login --with-token</code>.</div>
      </div>`;
      return;
    }
    sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLOBE}</div><div>
        <h3>Connect to the internet</h3>
        <p>${what} ${manual ? '' : 'Sign in once to turn on outbound connections for this computer; you can keep working meanwhile.'}</p>
      </div></div>
      <div class="sd-sheet-actions">
        <button class="sd-link sd-small" data-act="other" type="button">Other ways to connect</button>
        <span class="sd-grow"></span>
        <button class="sd-btn" data-act="later" type="button">Not now</button>
        <button class="sd-btn sd-primary" data-act="github" type="button">Sign in with GitHub</button>
      </div>
      <div class="sd-other sd-small sd-muted" hidden style="margin-top:10px">
        Use your own connection: point this computer at a TCP relay you run
        (<button class="sd-link" data-act="own" type="button">set it up in Settings</button>);
        your GitHub sign-in is not sent to it unless you say so there. Downloads from this site
        (like <code>apt install</code>) never need a sign-in.
      </div>`;
  };
  sheet.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'later' || act === 'cancel') done(null);
    else if (act === 'other') { const o = sheet.querySelector<HTMLElement>('.sd-other'); if (o) o.hidden = !o.hidden; }
    else if (act === 'github' || act === 'retry') void deviceFlow();
    else if (act === 'own') { done(null); void wmRef?.openApp('settings', { pane: 'network' }); }
    else if (act === 'token') void useToken();
  });
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });

  // "Other ways": a token the user made at GitHub. Checked against GitHub before it is saved.
  const useToken = async () => {
    const input = sheet.querySelector<HTMLInputElement>('#sd-gh-token');
    const line = sheet.querySelector<HTMLElement>('.sd-other .sd-status-line');
    const tok = input?.value.trim() ?? '';
    const say = (text: string, cls = '') => { if (line) { line.textContent = text; line.className = 'sd-status-line ' + cls; } };
    if (!tok) { say('Paste a token first.', 'err'); return; }
    say('Checking the token with GitHub…');
    try {
      const res = await fetch(`${githubApiBase('')}/user`, { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' }, signal: abort.signal });
      if (!res.ok) { say(res.status === 401 ? 'GitHub does not accept this token.' : `GitHub answered ${res.status}.`, 'err'); return; }
      const gha = await import('../github-auth');
      gha.saveGitHubToken(tok);
      setNetworkStatus('signed-in');
      void gha.ensureGitIdentity(fsRef, tok).catch(() => {});
      say('Signed in.', 'ok');
      setTimeout(() => done(tok), 600);
    } catch (e) {
      if (!abort.signal.aborted) say(`The token could not be checked: ${(e as Error)?.message ?? e}`, 'err');
    }
  };

  const deviceFlow = async () => {
    sheet.innerHTML = `
      <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
        <h3>${gh?.kind === 'scopes' ? 'Approve on GitHub' : 'Sign in with GitHub'}</h3><p>Asking GitHub for a one-time code…</p></div></div>
      <div class="sd-status-line"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span><button class="sd-btn" data-act="cancel" type="button">Cancel</button></div>`;
    const status = (text: string, cls = '') => {
      const s = sheet.querySelector<HTMLElement>('.sd-status-line');
      if (s) { s.textContent = text; s.className = 'sd-status-line ' + cls; }
    };
    try {
      const gha = await import('../github-auth');
      // (for more permissions: what the sign-in has and what is added, as `gh auth refresh -s` asks)
      const code = await gha.requestDeviceCode(gh?.kind === 'scopes' && gh.scopes?.length ? gh.scopes : gha.DEFAULT_GITHUB_SCOPES);
      if (abort.signal.aborted) return;
      sheet.innerHTML = `
        <div class="sd-sheet-head"><div class="sd-sheet-icon">${GLYPHS.key}</div><div>
          <h3>Enter this code on GitHub</h3>
          <p>Copy the code, open GitHub, paste it and approve. This window updates by itself.</p></div></div>
        <div class="sd-code">${esc(code.user_code)}</div>
        <div class="sd-status-line">Waiting for you to approve on GitHub…</div>
        <div class="sd-sheet-actions">
          <button class="sd-btn" data-act="cancel" type="button">Cancel</button><span class="sd-grow"></span>
          <button class="sd-btn" data-act="copy" type="button">Copy code</button>
          <a class="sd-btn sd-primary" data-act="open" href="${esc(code.verification_uri)}" target="_blank" rel="noopener">Open GitHub</a>
        </div>`;
      const copy = () => { navigator.clipboard?.writeText(code.user_code).catch(() => {}); };
      sheet.querySelector('[data-act=copy]')!.addEventListener('click', (e) => { copy(); (e.currentTarget as HTMLElement).textContent = 'Copied'; });
      sheet.querySelector('[data-act=open]')!.addEventListener('click', copy);
      const token = await gha.pollForToken(code, { signal: abort.signal, onStatus: (s) => { if (s === 'slow_down') status('Still waiting…'); } });
      gha.saveGitHubToken(token);
      setNetworkStatus('signed-in');
      void gha.ensureGitIdentity(fsRef, token).catch(() => {});
      const did = gh?.kind === 'scopes' ? 'Approved.' : 'Signed in.';
      status(gh ? (gh.afterFailure ? `${did} Run ${gh.action} again.` : `${did} ${gh.action} is running again.`) : 'Connected. Programs can reach the internet now.', 'ok');
      setTimeout(() => done(token), 1200);
    } catch (e) {
      if (abort.signal.aborted) return;
      status(`Couldn't sign in: ${(e as Error)?.message ?? e}`, 'err');
      const actions = sheet.querySelector('.sd-sheet-actions');
      if (actions && !actions.querySelector('[data-act=retry]')) {
        const retry = el('button', 'sd-btn sd-primary', 'Try again');
        retry.dataset.act = 'retry';
        actions.appendChild(retry);
      }
    }
  };

  ask();
  root.appendChild(sheet);
  // A sheet a command opened has the focus on "Not now": Enter or Space already on its way
  // declines, and never starts a sign-in or an approval. One opened on purpose (Settings, the
  // menu bar) has it on the sign-in. (Focus needs the sheet in the page, so it comes last.)
  const first = sheetFocus(!!gh, manual);
  if (first) sheet.querySelector<HTMLElement>(first)?.focus();
  return promise;
}

// ── Menu bar popover ──

let popover: HTMLElement | null = null;

function togglePopover(wm: WindowManager, anchor: HTMLElement): void {
  if (popover) { closePopover(); return; }
  const p = el('div', 'sd-popover');
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'Network and accounts');
  const r = anchor.getBoundingClientRect();
  p.style.top = `${r.bottom + 6}px`;
  p.style.right = `${Math.max(8, window.innerWidth - r.right - 8)}px`;
  // The connection (re-rendered as the probe answers), then the accounts (accounts.ts)
  p.innerHTML = `<div class="sd-pop-net"></div>
    <div class="sd-pop-h sd-small sd-muted">Accounts</div><div class="sd-accounts sd-pop-accounts"></div>
    <div class="sd-row" style="padding-top:6px;border:0"><button class="sd-link sd-small" data-act="accounts" type="button">Accounts…</button>
      <span class="sd-grow"></span><button class="sd-link sd-small" data-act="settings" type="button">Network settings…</button></div>`;
  const net = p.querySelector<HTMLElement>('.sd-pop-net')!;
  const render = (s: NetworkStatus) => {
    const dot = s === 'signed-in' || s === 'online' ? 'ok' : s === 'needs-sign-in' ? 'warn' : 'off';
    net.innerHTML = `
      <div class="sd-row"><span class="sd-dot ${dot}"></span><b class="sd-grow">Network</b><span class="sd-small sd-muted">${esc(statusText(s))}</span></div>
      ${networkCredential() ? '' : '<div class="sd-row sd-small sd-muted">Downloads from this site work without signing in.</div>'}`;
  };
  render(networkStatus());
  p.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'settings') { closePopover(); void wm.openApp('settings', { pane: 'network' }); }
    if (act === 'accounts') { closePopover(); void wm.openApp('settings', { pane: 'accounts' }); }
  });
  wm.root.appendChild(p);
  popover = p;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  const host = p.querySelector<HTMLElement>('.sd-pop-accounts')!;
  void import('./accounts').then((m) => {
    if (popover !== p || !fsRef) return;
    popoverCleanup = m.renderAccounts(host, { wm, fs: fsRef, compact: true, onOpenSheet: closePopover });
  });
  void probeRelay().then((s) => { if (popover === p) render(s); });
}
let popoverCleanup: (() => void) | null = null;

function outside(e: Event): void {
  if (popover && !popover.contains(e.target as Node)) closePopover();
}

function closePopover(): void {
  popoverCleanup?.();
  popoverCleanup = null;
  popover?.remove();
  popover = null;
  document.removeEventListener('pointerdown', outside, true);
}
