/**
 * The Git app's home and Files' Repositories panel on screen (docs/DESKTOP.md
 * "Git"). Data and row HTML are in github-home.ts; this file mounts them:
 *
 * - signed out: a Sign in with GitHub button that runs the device flow in
 *   place (the code, Copy, Open GitHub, then the lists without a reload);
 * - signed in: your repositories (filter, Public/Private/All, sort by last
 *   push, name or stars, more pages), each with Open when it's on this
 *   computer or Clone (one click into ~/src/NAME, progress in the row, then
 *   opened); notifications, your open pull requests and assigned issues;
 * - always: the repositories on this computer, New Repository… and Clone
 *   from URL….
 */

import type { AppContext } from './index';
import { GLYPHS } from './icons';
import { glyphFor } from './iconsets';
import { cloneScript, openCloneSheet, sheet } from './gitsheets';
import { GLOBAL_GITCONFIG, parseGitConfig } from '../commands/git-config';
import { setNetworkStatus } from '../net-signin';
import {
  HOME, SRC, cloneTarget, createLocalRepo, discoverLocalRepos, esc, filterRepos, homeModel, issueRowHTML, localIndex,
  localRowHTML, notificationRowHTML, rememberRepo, repoRowHTML, skeletonRows, validRepoName,
  type GitHubHomeModel, type LocalRepo, type RepoSort, type RepoVisibility,
} from './github-home';

export interface HomeHooks {
  ctx: AppContext;
  /** Open a repository on this computer (Git: its view; Files: the folder) */
  openLocal(path: string): void;
  /** The other way to open it, and its button's label */
  altLabel?: string;
  openAlt?(path: string): void;
  /** A one-click clone finished */
  cloned(path: string): void;
}

const GIT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${glyphFor('git')}"/></svg>`;
const REFRESH = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Replace an element's HTML only when it changed (no image reloads, hover or focus lost on every update) */
const lastHTML = new WeakMap<Element, string>();
function setHTML(el: Element, html: string): void {
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

/** The model, with what a sign-in should also do on this page */
export function model(ctx: AppContext): GitHubHomeModel {
  return homeModel({
    onSignedIn: (token) => {
      setNetworkStatus('signed-in');
      void import('../github-auth').then(gh => gh.ensureGitIdentity(ctx.fs, token)).catch(() => {});
    },
  });
}

// ── Sign in ──

export function signInHTML(m: GitHubHomeModel, compact = false): string {
  const notice = m.notice && m.phase === 'signed-out' ? `<div class="sd-gh-notice sd-gh-${m.notice.kind}" role="status">${esc(m.notice.text)}</div>` : '';
  if (m.phase === 'requesting') return `<div class="sd-card sd-gh-signin"><div class="sd-gh-signin-text"><b>Sign in with GitHub</b><p class="sd-small sd-muted">Asking GitHub for a one-time code…</p></div>
    <div class="sd-gh-signin-actions"><button class="sd-btn" data-gh-cancel type="button">Cancel</button></div></div>`;
  if (m.phase === 'code' && m.code) return `<div class="sd-card sd-gh-signin"><div class="sd-gh-signin-text"><b>Enter this code on GitHub</b>
      <p class="sd-small sd-muted">Copy the code, open GitHub, paste it and approve. This updates by itself.</p></div>
    <div class="sd-code sd-gh-code">${esc(m.code.userCode)}</div>
    <div class="sd-status-line">Waiting for you to approve on GitHub…</div>
    <div class="sd-gh-signin-actions"><button class="sd-btn" data-gh-cancel type="button">Cancel</button><span class="sd-grow"></span>
      <button class="sd-btn" data-gh-copy="${esc(m.code.userCode)}" type="button">Copy Code</button>
      <a class="sd-btn sd-primary" data-gh-copy="${esc(m.code.userCode)}" href="${esc(m.code.uri)}" target="_blank" rel="noopener">Open GitHub</a></div></div>`;
  return `<div class="sd-card sd-gh-signin">${notice}
    <div class="sd-gh-signin-head"><span class="sd-gh-signin-icon">${GIT_ICON}</span><div class="sd-gh-signin-text"><b>Your GitHub, here</b>
      <p class="sd-small sd-muted">${compact ? 'Sign in to pick from your repositories and clone private ones with one click.' : 'Sign in to see your repositories, notifications and pull requests, and to clone any of them (private ones too) with one click.'}</p></div></div>
    <div class="sd-gh-signin-actions"><button class="sd-btn sd-primary" data-gh-signin type="button">Sign in with GitHub</button></div></div>`;
}

// ── Clone with one click ──

function lastLine(out: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** Clone owner/name into ~/src/NAME in a shell of its own; progress goes into the model (every window's row) */
export async function startClone(ctx: AppContext, m: GitHubHomeModel, full: string, done: (path: string) => void): Promise<void> {
  if (m.clones.get(full) && !m.clones.get(full)!.error) return;
  const [owner, name] = full.split('/');
  const dest = await cloneTarget(owner, name, (p) => ctx.fs.exists(p).catch(() => false));
  const token = m.token();
  const script = cloneScript({ owner, repo: name, url: `https://github.com/${full}` }, !!token, dest);
  const st = { dest, progress: 'Starting…' } as { dest: string; progress: string; error?: string; done?: boolean };
  m.clones.set(full, st);
  m.emit();
  const sh = ctx.shell.fork();
  sh.cwd = HOME;
  if (token) sh.env.GITHUB_TOKEN = token;
  let out = '';
  let pending: ReturnType<typeof setTimeout> | null = null;
  const onOut = (s: string) => {
    out = (out + s).slice(-6000);
    const line = lastLine(out);
    if (line) st.progress = line;
    if (!pending) pending = setTimeout(() => { pending = null; m.emit(); }, 150);
  };
  let code = 1;
  try { code = await sh.execute(script, onOut, onOut); } catch (e) { onOut(`\n${(e as Error)?.message ?? e}\n`); }
  if (pending) clearTimeout(pending);
  if (code === 0 && await ctx.fs.exists(`${dest}/.git`).catch(() => false)) {
    st.done = true;
    m.clones.delete(full);
    rememberRepo(dest);
    m.emit();
    done(dest);
  } else {
    st.error = lastLine(out) || `git exited with ${code}`;
    m.emit();
  }
}

function cloneInTerminal(ctx: AppContext, m: GitHubHomeModel, full: string): void {
  const st = m.clones.get(full);
  const [owner, name] = full.split('/');
  m.clones.delete(full);
  m.emit();
  const token = m.token();
  if (token) ctx.shell.env.GITHUB_TOKEN = token;
  ctx.openTerminal({ title: `Clone ${full}`, cwd: HOME, command: cloneScript({ owner, repo: name, url: `https://github.com/${full}` }, !!token, st?.dest) });
}

// ── New repository ──

async function globalAuthor(ctx: AppContext): Promise<{ name: string; email: string }> {
  let c: Record<string, string> = {};
  try { c = parseGitConfig(await ctx.fs.readFile(GLOBAL_GITCONFIG, 'utf8') as string); } catch {}
  return { name: c['user.name'] || 'user', email: c['user.email'] || 'user@localhost' };
}

/** New Repository: git init in ~/src/NAME, a README and first commit, and (signed in) the same repository on GitHub as origin */
export function openNewRepoSheet(ctx: AppContext, m: GitHubHomeModel, created: (path: string) => void): void {
  const signedIn = m.phase === 'signed-in';
  const login = m.data?.user?.login;
  const { el, close } = sheet(ctx, 'New repository', `
    <div class="sd-sheet-head"><div class="sd-sheet-icon">${GIT_ICON}</div><div>
      <h3>New Repository</h3><p>A new git repository in <code>~/src</code>.</p></div></div>
    <form class="sd-git-form">
      <input class="sd-input" name="name" type="text" placeholder="name" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Repository name">
      <div class="sd-small sd-muted sd-git-dest" aria-live="polite"></div>
      <label class="sd-gh-check"><input type="checkbox" name="readme" checked> Add a README and make the first commit</label>
      ${signedIn ? `<label class="sd-gh-check"><input type="checkbox" name="github" checked> Also create it on GitHub${login ? ` as @${esc(login)}` : ''}, as its origin</label>
      <div class="sd-seg sd-gh-vis" role="radiogroup" aria-label="Visibility"><button type="button" class="sd-active" data-vis="private" role="radio" aria-checked="true">Private</button><button type="button" data-vis="public" role="radio" aria-checked="false">Public</button></div>`
      : `<div class="sd-small sd-muted">Sign in with GitHub to create it there too.</div>`}
      <div class="sd-status-line"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span>
        <button class="sd-btn" data-act="cancel" type="button">Cancel</button>
        <button class="sd-btn sd-primary" type="submit" disabled>Create</button></div>
    </form>`);
  const input = el.querySelector<HTMLInputElement>('input[name=name]')!;
  const dest = el.querySelector<HTMLElement>('.sd-git-dest')!;
  const submit = el.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const status = el.querySelector<HTMLElement>('.sd-status-line')!;
  let vis: 'private' | 'public' = 'private';
  const check = async () => {
    const n = input.value.trim();
    if (!validRepoName(n)) { submit.disabled = true; dest.textContent = n ? 'Letters, digits, - _ and . only.' : ''; return false; }
    const exists = await ctx.fs.exists(`${SRC}/${n}`).catch(() => false);
    submit.disabled = exists;
    dest.innerHTML = exists ? `<b>~/src/${esc(n)}</b> already exists.` : `Into <b>~/src/${esc(n)}</b>`;
    return !exists;
  };
  input.addEventListener('input', () => void check());
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-vis]');
    if (!b) return;
    vis = b.dataset.vis as 'private' | 'public';
    for (const x of el.querySelectorAll<HTMLElement>('[data-vis]')) { x.classList.toggle('sd-active', x === b); x.setAttribute('aria-checked', String(x === b)); }
  });
  el.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await check())) return;
    const name = input.value.trim();
    const readme = el.querySelector<HTMLInputElement>('input[name=readme]')!.checked;
    const onGitHub = !!el.querySelector<HTMLInputElement>('input[name=github]')?.checked;
    submit.disabled = true;
    const dir = `${SRC}/${name}`;
    try {
      let origin: string | undefined;
      if (onGitHub) {
        status.textContent = 'Creating it on GitHub…';
        const repo = await m.api()!.createRepo(name, vis === 'private');
        origin = repo.clone_url ?? `${repo.html_url}.git`;
        if (m.data) { m.data = { ...m.data, repos: [repo, ...m.data.repos] }; m.emit(); }
      }
      status.textContent = 'Making the repository…';
      await createLocalRepo(ctx.fs, dir, { readme, author: await globalAuthor(ctx), origin });
      rememberRepo(dir);
      close();
      created(dir);
    } catch (err) {
      status.className = 'sd-status-line err';
      status.textContent = `Couldn't create it: ${(err as Error)?.message ?? err}`;
      submit.disabled = false;
    }
  });
  setTimeout(() => input.focus(), 50);
}

// ── Repositories on this computer: changed-file counts, read lazily ──

const changedCache = new Map<string, { at: number; n: number | null }>();
async function changedCount(ctx: AppContext, l: LocalRepo): Promise<number | null> {
  if (l.worktree) return null;
  const hit = changedCache.get(l.path);
  if (hit && hit.at >= l.mtime && Date.now() - hit.at < 30_000) return hit.n;
  let n: number | null = null;
  try {
    const git = await import('isomorphic-git');
    const rows = await git.statusMatrix({ fs: ctx.fs.toIsomorphicGitFS() as Parameters<typeof git.statusMatrix>[0]['fs'], dir: l.path });
    n = rows.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1)).length;
  } catch {}
  changedCache.set(l.path, { at: Date.now(), n });
  return n;
}

// ── The repository picker (Git's home and Files' Repositories) ──

export interface Picker { el: HTMLElement; render(): void; setLocals(l: LocalRepo[]): void }

export function createPicker(m: GitHubHomeModel, hooks: HomeHooks, opts: { pageSize?: number } = {}): Picker {
  const step = opts.pageSize ?? 20;
  const el = document.createElement('div');
  el.className = 'sd-gh-picker';
  el.innerHTML = `
    <div class="sd-gh-filters">
      <input class="sd-input sd-gh-filter" type="search" placeholder="Filter repositories" aria-label="Filter repositories" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="sd-seg" role="radiogroup" aria-label="Visibility">
        <button type="button" class="sd-active" data-vis="all" role="radio" aria-checked="true">All</button><button type="button" data-vis="public" role="radio" aria-checked="false">Public</button><button type="button" data-vis="private" role="radio" aria-checked="false">Private</button></div>
      <select class="sd-input sd-gh-sort" aria-label="Sort"><option value="pushed">Last push</option><option value="name">Name</option><option value="stars">Stars</option></select>
    </div>
    <div class="sd-gh-list" aria-live="polite"></div>`;
  const list = el.querySelector<HTMLElement>('.sd-gh-list')!;
  let query = '', visibility: RepoVisibility = 'all', sort: RepoSort = 'pushed', shown = step;
  let local = new Map<string, string>();
  const render = () => {
    const d = m.data;
    if (!d || (!d.repos.length && m.loading)) { setHTML(list, skeletonRows(Math.min(step, 5))); return; }
    const all = filterRepos(d.repos, { query, visibility, sort });
    const now = Date.now();
    const rows = all.slice(0, shown).map(r => repoRowHTML(r, { local: local.get(r.full_name.toLowerCase()), clone: m.clones.get(r.full_name), now, altLabel: hooks.altLabel })).join('');
    const more = all.length > shown || d.reposNext;
    setHTML(list, (rows || `<div class="sd-gh-empty sd-small sd-muted">${d.repos.length ? 'No repositories match.' : 'No repositories on this account yet.'}</div>`) +
      (more ? `<div class="sd-gh-more"><button class="sd-btn" data-gh-more type="button"${m.loadingMore ? ' disabled' : ''}>${m.loadingMore ? 'Loading…' : 'Show More'}</button></div>` : ''));
  };
  el.querySelector('.sd-gh-filter')!.addEventListener('input', (e) => { query = (e.target as HTMLInputElement).value; shown = step; render(); });
  el.querySelector('.sd-gh-sort')!.addEventListener('change', (e) => { sort = (e.target as HTMLSelectElement).value as RepoSort; render(); });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const v = t.closest<HTMLElement>('[data-vis]');
    if (v) {
      visibility = v.dataset.vis as RepoVisibility;
      for (const b of el.querySelectorAll<HTMLElement>('[data-vis]')) { b.classList.toggle('sd-active', b === v); b.setAttribute('aria-checked', String(b === v)); }
      shown = step; render(); return;
    }
    if (t.closest('[data-gh-more]')) {
      const all = filterRepos(m.data?.repos ?? [], { query, visibility, sort });
      shown += step;
      if (shown > all.length && m.data?.reposNext) void m.moreRepos();
      render();
    }
  });
  return { el, render, setLocals: (l) => { local = localIndex(l); render(); } };
}

/** Clicks shared by every mount: sign in, clone, open, notifications */
function wireActions(host: HTMLElement, m: GitHubHomeModel, hooks: HomeHooks, extra: (act: string, t: HTMLElement) => boolean = () => false): void {
  host.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const at = (k: string) => t.closest<HTMLElement>(`[data-${k}]`);
    if (at('gh-signin')) { void m.signIn(); return; }
    if (at('gh-cancel')) { m.cancelSignIn(); return; }
    const copy = at('gh-copy');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.ghCopy!).catch(() => {});
      if (copy.tagName === 'BUTTON') copy.textContent = 'Copied';
      return;
    }
    const clone = at('gh-clone');
    if (clone) { void startClone(hooks.ctx, m, clone.dataset.ghClone!, hooks.cloned); return; }
    const term = at('gh-clone-term');
    if (term) { cloneInTerminal(hooks.ctx, m, term.dataset.ghCloneTerm!); return; }
    const open = at('gh-open');
    if (open) { hooks.openLocal(open.dataset.ghOpen!); return; }
    const alt = at('gh-alt');
    if (alt) { hooks.openAlt?.(alt.dataset.ghAlt!); return; }
    const note = at('note');
    if (note) {
      const n = m.data?.notifications.find(x => x.id === note.dataset.note);
      if (n?.unread) {
        n.unread = false;
        void m.api()?.markRead(n.id).catch(() => {});
        setTimeout(() => m.emit(), 0);
      }
      return; // the link opens in a new tab
    }
    const act = t.closest<HTMLElement>('[data-gh-act]')?.dataset.ghAct;
    if (act && extra(act, t)) return;
    if (act === 'refresh') void m.refresh();
    if (act === 'clone-url') openCloneSheet(hooks.ctx);
    if (act === 'new') openNewRepoSheet(hooks.ctx, m, (p) => hooks.cloned(p));
  });
}

function noticeHTML(m: GitHubHomeModel): string {
  if (!m.notice || m.phase !== 'signed-in') return '';
  const what = m.notice.kind === 'offline' ? `${m.notice.text}${m.data?.at ? ` Showing what was loaded ${new Date(m.data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}` : m.notice.text;
  return `<div class="sd-gh-notice sd-gh-${m.notice.kind}" role="status">${esc(what)} <button class="sd-link" data-gh-act="refresh" type="button">Try again</button></div>`;
}

// ── The Git app's home ──

export function mountGitHome(host: HTMLElement, hooks: HomeHooks): () => void {
  const m = model(hooks.ctx);
  host.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sd-scroll sd-gh-home';
  host.appendChild(root);
  const picker = createPicker(m, hooks);
  let locals: LocalRepo[] | null = null;
  let layout = '';
  let alive = true;

  const localsHTML = () => locals === null ? skeletonRows(2)
    : locals.length ? locals.slice(0, 12).map(l => localRowHTML(l, changedCache.get(l.path)?.n, hooks.altLabel)).join('')
    : '<div class="sd-gh-empty sd-small sd-muted">No repositories on this computer yet. Clone one, or make a new one.</div>';
  const section = (id: string, title: string, body: string, count = '') =>
    `<section class="sd-gh-sec" data-sec="${id}"><h3>${title}${count ? ` <span class="sd-muted">${count}</span>` : ''}</h3><div class="sd-gh-card">${body}</div></section>`;

  const render = () => {
    if (!alive) return;
    const signedIn = m.phase === 'signed-in';
    const want = signedIn ? 'in' : 'out';
    if (layout !== want) {
      layout = want;
      root.innerHTML = `<div class="sd-gh-wrap">
        <header class="sd-gh-head"></header>
        <div class="sd-gh-notice-slot"></div>
        <div class="sd-gh-grid${signedIn ? '' : ' sd-gh-one'}">
          <div class="sd-gh-col">${signedIn ? `<section class="sd-gh-sec" data-sec="repos"><h3>Your repositories <span class="sd-muted sd-gh-count"></span></h3></section>` : '<div class="sd-gh-signin-slot"></div>'}
            ${signedIn ? '' : '<div class="sd-gh-local-slot"></div>'}</div>
          ${signedIn ? '<div class="sd-gh-col sd-gh-side"></div>' : ''}
        </div></div>`;
      if (signedIn) root.querySelector('[data-sec=repos]')!.appendChild(picker.el);
    }
    const user = m.data?.user;
    setHTML(root.querySelector('.sd-gh-head')!, `
      ${signedIn && user ? `<img class="sd-gh-avatar" src="${esc(user.avatar_url + (user.avatar_url.includes("?") ? "&" : "?") + "s=80")}" alt="" width="40" height="40" referrerpolicy="no-referrer">` : `<span class="sd-gh-avatar sd-gh-avatar-ph">${GIT_ICON}</span>`}
      <div class="sd-gh-who"><h2>${signedIn ? (user ? esc(user.name || user.login) : 'GitHub') : 'Git'}</h2>
        <div class="sd-small sd-muted">${signedIn ? (user ? `<a class="sd-link" href="${esc(user.html_url)}" target="_blank" rel="noopener">@${esc(user.login)}</a>` : 'Loading your account…') : 'Repositories on this computer and on GitHub'}</div></div>
      <span class="sd-grow"></span>
      <div class="sd-gh-head-actions">
        <button class="sd-btn" data-gh-act="new" type="button">New Repository…</button>
        <button class="sd-btn" data-gh-act="clone-url" type="button" title="Clone a repository by its URL">Clone from URL…</button>
        ${signedIn ? `<button class="sd-btn sd-icon-btn${m.loading ? ' sd-gh-spin' : ''}" data-gh-act="refresh" type="button" title="Refresh" aria-label="Refresh">${REFRESH}</button>` : ''}
      </div>`);
    setHTML(root.querySelector('.sd-gh-notice-slot')!, noticeHTML(m));
    if (signedIn) {
      root.querySelector('.sd-gh-count')!.textContent = m.data?.repos.length ? `${m.data.repos.length}${m.data.reposNext ? '+' : ''}` : '';
      picker.render();
      const d = m.data;
      const now = Date.now();
      const notes = d?.notifications ?? [];
      const unread = notes.filter(n => n.unread).length;
      const list = <T>(items: T[] | undefined, row: (x: T) => string, empty: string, n = 6) =>
        !d ? skeletonRows(3) : items!.length ? items!.slice(0, n).map(row).join('') : `<div class="sd-gh-empty sd-small sd-muted">${empty}</div>`;
      setHTML(root.querySelector('.sd-gh-side')!,
        section('notes', 'Notifications', list(notes, n => notificationRowHTML(n, now), 'No notifications.', 8), unread ? `${unread} unread` : '') +
        section('prs', 'Your pull requests', list(d?.prs, i => issueRowHTML(i, now), 'No open pull requests.')) +
        section('issues', 'Assigned to you', list(d?.issues, i => issueRowHTML(i, now), 'No open issues assigned to you.')) +
        section('local', 'On this computer', localsHTML()));
    } else {
      setHTML(root.querySelector('.sd-gh-signin-slot')!, signInHTML(m));
      setHTML(root.querySelector('.sd-gh-local-slot')!, section('local', 'On this computer', localsHTML()));
    }
  };

  const scan = async () => {
    const found = await discoverLocalRepos(hooks.ctx.fs);
    if (!alive) return;
    locals = found;
    picker.setLocals(found);
    render();
    for (const l of found.slice(0, 12)) {
      const n = await changedCount(hooks.ctx, l);
      if (!alive) return;
      const cell = root.querySelector<HTMLElement>(`[data-changed="${CSS.escape(l.path)}"]`);
      if (cell) cell.textContent = n == null ? '' : n ? `· ${n} changed` : '· clean';
    }
  };

  wireActions(root, m, hooks);
  let clonesBefore = m.clones.size;
  const off = m.subscribe(() => {
    render();
    if (m.clones.size < clonesBefore) void scan();
    clonesBefore = m.clones.size;
  });
  // The lists follow ~/src: a clone from the Terminal, a folder removed
  let timer: ReturnType<typeof setTimeout> | null = null;
  const offFs = hooks.ctx.fs.onChange((_ev, path) => {
    // Repositories appearing or going away, not work inside them (reading status rewrites .git/index)
    if (!path.startsWith(SRC + '/') || path.includes('/.git/') || path.split('/').length > 7) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void scan(); }, 800);
  });
  render();
  void scan();
  if (m.phase === 'signed-in') void m.refresh(); else m.sync();
  return () => { alive = false; off(); offFs(); if (timer) clearTimeout(timer); };
}

// ── Files' Repositories panel (~/src) ──

export function mountRepoPanel(host: HTMLElement, hooks: HomeHooks): () => void {
  const m = model(hooks.ctx);
  host.innerHTML = `
    <div class="sd-gh-panel-actions">
      <button class="sd-btn sd-primary" data-gh-act="new" type="button">${GLYPHS.plus}New Repository…</button>
      <button class="sd-btn" data-gh-act="clone-url" type="button">Clone from URL…</button>
      <span class="sd-grow"></span>
      <button class="sd-link sd-small" data-gh-act="toggle" type="button" aria-expanded="true">Hide GitHub</button>
    </div>
    <div class="sd-gh-panel-body">
      <h3 class="sd-gh-panel-h">Your GitHub repositories</h3>
      <div class="sd-gh-panel-notice"></div>
      <div class="sd-gh-panel-signin"></div>
    </div>`;
  const body = host.querySelector<HTMLElement>('.sd-gh-panel-body')!;
  const picker = createPicker(m, hooks, { pageSize: 8 });
  body.appendChild(picker.el);
  let alive = true;
  const COLLAPSE_KEY = 'tabcomputer_files_repos_collapsed';
  let collapsed = false;
  try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch {}
  const render = () => {
    if (!alive) return;
    const signedIn = m.phase === 'signed-in';
    body.hidden = collapsed;
    const tog = host.querySelector<HTMLElement>('[data-gh-act=toggle]')!;
    tog.textContent = collapsed ? 'Show GitHub' : 'Hide GitHub';
    tog.setAttribute('aria-expanded', String(!collapsed));
    setHTML(host.querySelector('.sd-gh-panel-notice')!, noticeHTML(m));
    setHTML(host.querySelector('.sd-gh-panel-signin')!, signedIn ? '' : signInHTML(m, true));
    picker.el.hidden = !signedIn;
    if (signedIn) picker.render();
  };
  wireActions(host, m, hooks, (act) => {
    if (act !== 'toggle') return false;
    collapsed = !collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
    render();
    return true;
  });
  const scan = async () => { const l = await discoverLocalRepos(hooks.ctx.fs); if (alive) picker.setLocals(l); };
  let clonesBefore = m.clones.size;
  const off = m.subscribe(() => { render(); if (m.clones.size < clonesBefore) void scan(); clonesBefore = m.clones.size; });
  render();
  void scan();
  if (m.phase === 'signed-in') { if (!m.data || Date.now() - m.data.at > 60_000) void m.refresh(); } else m.sync();
  return () => { alive = false; off(); };
}
