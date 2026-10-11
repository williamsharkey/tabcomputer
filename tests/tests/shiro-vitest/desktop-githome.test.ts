/**
 * The Git app's home and Files' Repositories panel (src/desktop/github-home.ts;
 * docs/DESKTOP.md "Git"): repositories found on this computer, the rows
 * rendered from GitHub's API JSON, the API client's errors (401, rate limit,
 * offline, the proxy fallback), and the sign-in states with a mocked fetch.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubError, GitHubHomeModel, cloneTarget, createLocalRepo, discoverLocalRepos, filterRepos, gitHubApi, hasNextPage,
  issueRowHTML, localIndex, localRowHTML, notificationLink, notificationRowHTML, parseOrigin, relTime, repoRowHTML,
  sortNotifications, tokenTag, validRepoName, type GhIssue, type GhNotification, type GhRepo,
} from '@shiro/desktop/github-home';
import { cloneScript } from '@shiro/desktop/gitsheets';
import { GITHUB_TOKEN_KEY } from '@shiro/github-auth';
import { createTestShell, run } from './helpers';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}

const NOW = Date.parse('2026-10-11T12:00:00Z');
const repo = (o: Partial<GhRepo> & { full_name: string }): GhRepo => ({
  id: Math.floor(Math.random() * 1e9), name: o.full_name.split('/')[1], owner: { login: o.full_name.split('/')[0] }, private: false,
  description: null, language: null, pushed_at: '2026-10-10T12:00:00Z', updated_at: '2026-10-10T12:00:00Z', stargazers_count: 0,
  html_url: `https://github.com/${o.full_name}`, ...o,
});
const REPOS: GhRepo[] = [
  repo({ full_name: 'ada/engine', private: true, description: 'The <analytical> engine', language: 'Rust', pushed_at: '2026-10-11T11:00:00Z', stargazers_count: 3 }),
  repo({ full_name: 'ada/notes', language: 'Markdown', pushed_at: '2026-09-01T00:00:00Z', stargazers_count: 40 }),
  repo({ full_name: 'babbage/Difference', description: 'gears', pushed_at: '2026-10-09T00:00:00Z' }),
];
const NOTES: GhNotification[] = [
  { id: '1', unread: false, reason: 'mention', updated_at: '2026-10-11T10:00:00Z', subject: { title: 'Old one', url: 'https://api.github.com/repos/ada/engine/issues/7', type: 'Issue' }, repository: { full_name: 'ada/engine', html_url: 'https://github.com/ada/engine' } },
  { id: '2', unread: true, reason: 'review_requested', updated_at: '2026-10-10T10:00:00Z', subject: { title: 'Faster gears', url: 'https://api.github.com/repos/ada/engine/pulls/12', type: 'PullRequest' }, repository: { full_name: 'ada/engine', html_url: 'https://github.com/ada/engine' } },
  { id: '3', unread: true, reason: 'subscribed', updated_at: '2026-10-11T09:00:00Z', subject: { title: 'v1.0', url: null, type: 'Release' }, repository: { full_name: 'ada/notes', html_url: 'https://github.com/ada/notes' } },
];
const PR: GhIssue = { id: 9, number: 12, title: 'Faster gears', html_url: 'https://github.com/ada/engine/pull/12', repository_url: 'https://api.github.com/repos/ada/engine', updated_at: '2026-10-11T08:00:00Z', pull_request: {} };

describe('lists from the API', () => {
  it('filters by text and visibility, and sorts by push, name or stars', () => {
    expect(filterRepos(REPOS).map(r => r.name)).toEqual(['engine', 'Difference', 'notes']);
    expect(filterRepos(REPOS, { sort: 'name' }).map(r => r.name)).toEqual(['engine', 'notes', 'Difference']);
    expect(filterRepos(REPOS, { sort: 'stars' }).map(r => r.name)).toEqual(['notes', 'engine', 'Difference']);
    expect(filterRepos(REPOS, { visibility: 'private' }).map(r => r.name)).toEqual(['engine']);
    expect(filterRepos(REPOS, { visibility: 'public' }).map(r => r.name)).toEqual(['Difference', 'notes']);
    expect(filterRepos(REPOS, { query: 'GEARS' }).map(r => r.name)).toEqual(['Difference']);
    expect(filterRepos(REPOS, { query: 'rust' }).map(r => r.name)).toEqual(['engine']);
  });

  it('notifications: unread first, then newest; links go to the web page', () => {
    expect(sortNotifications(NOTES).map(n => n.id)).toEqual(['3', '2', '1']);
    expect(notificationLink(NOTES[1])).toBe('https://github.com/ada/engine/pull/12');
    expect(notificationLink(NOTES[0])).toBe('https://github.com/ada/engine/issues/7');
    expect(notificationLink(NOTES[2])).toBe('https://github.com/ada/notes');
  });

  it('times are short and relative', () => {
    expect(relTime('2026-10-11T11:59:30Z', NOW)).toBe('just now');
    expect(relTime('2026-10-11T11:00:00Z', NOW)).toBe('1h ago');
    expect(relTime('2026-10-08T12:00:00Z', NOW)).toBe('3d ago');
    expect(relTime('2026-09-20T12:00:00Z', NOW)).toBe('3w ago');
    expect(relTime('2025-01-15T12:00:00Z', NOW)).toBe('Jan 2025');
    expect(relTime(null, NOW)).toBe('');
  });

  it('renders a repository row: Clone, or Open when it is here; escaped; badges', () => {
    const row = repoRowHTML(REPOS[0], { now: NOW });
    expect(row).toContain('data-gh-clone="ada/engine"');
    expect(row).toContain('Private');
    expect(row).toContain('The &#60;analytical&#62; engine');
    expect(row).toContain('Rust');
    expect(row).toContain('★ 3');
    expect(row).toContain('Updated 1h ago');
    const here = repoRowHTML(REPOS[0], { now: NOW, local: '/home/user/src/engine', altLabel: 'Files' });
    expect(here).toContain('data-gh-open="/home/user/src/engine"');
    expect(here).toContain('data-gh-alt="/home/user/src/engine"');
    expect(here).not.toContain('data-gh-clone=');
    const cloning = repoRowHTML(REPOS[0], { clone: { dest: '/home/user/src/engine', progress: 'Receiving objects:  45% (450/1000)' } });
    expect(cloning).toContain('Receiving objects:  45%');
    expect(cloning).not.toContain('data-gh-clone=');
    const failed = repoRowHTML(REPOS[0], { clone: { dest: '/home/user/src/engine', progress: '', error: 'fatal: no' } });
    expect(failed).toContain('Clone failed: fatal: no');
    expect(failed).toContain('data-gh-clone-term="ada/engine"');
  });

  it('renders notifications, pull requests and local repositories', () => {
    const n = notificationRowHTML(NOTES[1], NOW);
    expect(n).toContain('sd-gh-unread');
    expect(n).toContain('href="https://github.com/ada/engine/pull/12"');
    expect(n).toContain('target="_blank"');
    expect(n).toContain('Pull request');
    const p = issueRowHTML(PR, NOW);
    expect(p).toContain('ada/engine#12');
    expect(p).toContain('sd-gh-pr');
    const l = localRowHTML({ path: '/home/user/src/engine', name: 'engine', branch: 'main', origin: 'ada/engine', worktree: false, mtime: 0 }, 2, 'Files');
    expect(l).toContain('~/src/engine');
    expect(l).toContain('· 2 changed');
    expect(l).toContain('data-gh-open="/home/user/src/engine"');
  });
});

describe('repositories on this computer', () => {
  it('finds ~/src/NAME, ~/src/OWNER/NAME and ~/NAME with branch and GitHub origin, recent first', async () => {
    const { fs, shell } = await createTestShell();
    const mk = (dir: string, origin?: string) => `mkdir -p ${dir} && cd ${dir} && git init -q && echo x > f && git add f && git commit -q -m one${origin ? ` && git remote add origin ${origin}` : ''}`;
    for (const cmd of [
      mk('/home/user/src/engine', 'https://github.com/Ada/Engine.git'),
      mk('/home/user/src/babbage/difference', 'git@github.com:babbage/difference.git'),
      mk('/home/user/proj'),
      'mkdir -p /home/user/src/empty /home/user/notes',
    ]) expect((await run(shell, cmd)).exitCode, cmd).toBe(0);
    await run(shell, 'cd /home/user/proj && git checkout -q -b feature');
    const found = await discoverLocalRepos(fs, ['/home/user/proj', '/home/user/gone']);
    expect(found.map(r => r.path)[0]).toBe('/home/user/proj');
    expect(found.map(r => r.path).sort()).toEqual(['/home/user/proj', '/home/user/src/babbage/difference', '/home/user/src/engine']);
    const byPath = Object.fromEntries(found.map(r => [r.path, r]));
    expect(byPath['/home/user/proj'].branch).toBe('feature');
    expect(byPath['/home/user/proj'].origin).toBeNull();
    expect(byPath['/home/user/src/engine'].origin).toBe('ada/engine');
    expect(byPath['/home/user/src/babbage/difference'].origin).toBe('babbage/difference');
    const idx = localIndex(found);
    expect(idx.get('ada/engine')).toBe('/home/user/src/engine');
  });

  it('reads origin from a git config, without credentials in the URL', () => {
    expect(parseOrigin('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://x-access-token:abc@github.com/o/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe('o/r');
    expect(parseOrigin('[remote "upstream"]\n\turl = https://github.com/o/r\n')).toBeNull();
    expect(parseOrigin('[remote "origin"]\n\turl = https://gitlab.com/o/r\n')).toBeNull();
  });

  it('one-click clones go to ~/src/NAME, else ~/src/OWNER/NAME', async () => {
    const taken = new Set(['/home/user/src/engine']);
    expect(await cloneTarget('ada', 'notes', async p => taken.has(p))).toBe('/home/user/src/notes');
    expect(await cloneTarget('ada', 'engine', async p => taken.has(p))).toBe('/home/user/src/ada/engine');
    taken.add('/home/user/src/ada/engine');
    expect(await cloneTarget('ada', 'engine', async p => taken.has(p))).toBe('/home/user/src/engine-2');
    const s = cloneScript({ owner: 'ada', repo: 'engine', url: 'https://github.com/ada/engine' }, true, '/home/user/src/engine-2');
    expect(s).toMatch(/^mkdir -p '\/home\/user\/src' && cd '\/home\/user\/src' && /);
    expect(s).toContain("git clone --filter=blob:none --progress 'https://github.com/ada/engine' 'engine-2' && cd 'engine-2'");
  });

  it('New Repository: init, README, first commit and origin', async () => {
    const { fs, shell } = await createTestShell();
    expect(validRepoName('my-repo.1')).toBe(true);
    expect(validRepoName('bad name')).toBe(false);
    expect(validRepoName('x.git')).toBe(false);
    const oid = await createLocalRepo(fs, '/home/user/src/fresh', { readme: true, author: { name: 'Ada', email: 'ada@example.com' }, origin: 'https://github.com/ada/fresh.git' });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    const r = await run(shell, 'cd /home/user/src/fresh && git log --format="%an %s" && git remote -v && git branch');
    expect(r.output).toContain('Ada Initial commit');
    expect(r.output).toContain('https://github.com/ada/fresh.git');
    expect(r.output).toContain('main');
    expect(await fs.readFile('/home/user/src/fresh/README.md', 'utf8')).toBe('# fresh\n');
  });
});

// ── A fake GitHub ──

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>, log: string[] = []) {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    log.push(`${init.method ?? 'GET'} ${url}`);
    for (const [prefix, fn] of Object.entries(routes)) if (url.includes(prefix)) return fn(url, init);
    return new Response('{"message":"Not Found"}', { status: 404 });
  }) as typeof fetch;
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> ?? {}) }, ...init });
const USER = { login: 'ada', name: 'Ada Lovelace', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', html_url: 'https://github.com/ada' };
const api200: Record<string, Route> = {
  'api.github.com/user/repos': () => json(REPOS, { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } }),
  'api.github.com/user': () => json(USER),
  'api.github.com/notifications': () => json(NOTES),
  'api.github.com/search/issues': (u) => json({ items: u.includes('author') ? [PR] : [] }),
};

describe('the API client', () => {
  it('sends the token, follows Link pages, and names its errors', async () => {
    const log: string[] = [];
    let seen: Headers | null = null;
    const api = gitHubApi('tok', { proxyBase: null, fetchImpl: fakeFetch({ ...api200, 'api.github.com/user/repos': (_u, i) => { seen = new Headers(i.headers); return json(REPOS, { headers: { link: '<x>; rel="next", <y>; rel="last"' } }); } }, log) });
    const r = await api.repos(1);
    expect(r.next).toBe(true);
    expect(seen!.get('authorization')).toBe('Bearer tok');
    expect(log[0]).toContain('https://api.github.com/user/repos?sort=pushed');
    expect(hasNextPage('<x>; rel="prev"')).toBe(false);

    const err = async (route: Route, proxy: string | null = null) => {
      const a = gitHubApi('tok', { proxyBase: proxy, fetchImpl: fakeFetch({ 'api.github.com': route }) });
      return a.user().then(() => null, e => e as GitHubError);
    };
    expect((await err(() => new Response('{}', { status: 401 })))!.kind).toBe('auth');
    const rate = (await err(() => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } })))!;
    expect(rate.kind).toBe('rate');
    expect(rate.resetAt).toBe(1800000000 * 1000);
    expect((await err(() => new Response('{"message":"Server Error"}', { status: 500 })))!.message).toContain('500: Server Error');
    expect((await err(() => { throw new TypeError('Failed to fetch'); }))!.kind).toBe('offline');
  });

  it('falls back to /api/github when the direct request fails', async () => {
    const log: string[] = [];
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      log.push(url);
      if (url.startsWith('https://api.github.com')) throw new TypeError('blocked');
      return json(USER);
    }) as typeof fetch;
    const u = await gitHubApi('tok', { fetchImpl: f, proxyBase: '/api/github' }).user();
    expect(u.login).toBe('ada');
    expect(log).toEqual(['https://api.github.com/user', '/api/github/user']);
  });
});

describe('sign-in and the lists (the model)', () => {
  beforeEach(() => localStorage.clear());

  it('signed out → code → signed in, then the lists, without a reload', async () => {
    const phases: string[] = [];
    let polls = 0;
    const fetchImpl = fakeFetch({
      '/api/github-login/login/device/code': () => json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
      '/api/github-login/login/oauth/access_token': () => json(++polls < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_new' }),
      ...api200,
    });
    let signedInWith = '';
    const m = new GitHubHomeModel({ fetchImpl, proxyBase: null, sleep: async () => {}, onSignedIn: (t) => { signedInWith = t; } });
    m.subscribe(() => { if (phases[phases.length - 1] !== m.phase) phases.push(m.phase); });
    expect(m.phase).toBe('signed-out');
    let codeShown = '';
    m.subscribe(() => { if (m.code) codeShown = m.code.userCode; });
    expect(await m.signIn()).toBe(true);
    expect(phases).toEqual(['requesting', 'code', 'signed-in']);
    expect(codeShown).toBe('ABCD-1234');
    expect(localStorage.getItem(GITHUB_TOKEN_KEY)).toBe('gho_new');
    expect(signedInWith).toBe('gho_new');
    expect(m.data?.user?.login).toBe('ada');
    expect(m.data?.repos.length).toBe(3);
    expect(m.data?.reposNext).toBe(2);
    expect(m.data?.notifications.map(n => n.id)).toEqual(['3', '2', '1']);
    expect(m.data?.prs.map(p => p.number)).toEqual([12]);
    expect(m.notice).toBeNull();
    // The next window paints from the cache at once
    const again = new GitHubHomeModel({ fetchImpl: fakeFetch({}), proxyBase: null });
    expect(again.phase).toBe('signed-in');
    expect(again.data?.repos.map(r => r.name)).toEqual(['engine', 'notes', 'Difference']);
    expect(localStorage.getItem('tabcomputer_git_home')).not.toContain('gho_new');
    expect(localStorage.getItem('tabcomputer_git_home')).toContain(tokenTag('gho_new'));
  });

  it('a denied or cancelled sign-in goes back to signed out with the reason', async () => {
    const fetchImpl = fakeFetch({
      '/login/device/code': () => json({ device_code: 'dc', user_code: 'X', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
      '/login/oauth/access_token': () => json({ error: 'access_denied' }),
    });
    const m = new GitHubHomeModel({ fetchImpl, proxyBase: null, sleep: async () => {} });
    expect(await m.signIn()).toBe(false);
    expect(m.phase).toBe('signed-out');
    expect(m.notice?.text).toContain('access was denied');
    expect(localStorage.getItem(GITHUB_TOKEN_KEY)).toBeNull();

    let release!: () => void;
    const slow = new GitHubHomeModel({ fetchImpl, proxyBase: null, sleep: () => new Promise<void>(r => { release = r; }) });
    const p = slow.signIn();
    await new Promise(r => setTimeout(r, 0));
    expect(slow.phase).toBe('code');
    slow.cancelSignIn();
    expect(slow.phase).toBe('signed-out');
    release();
    expect(await p).toBe(false);
    expect(slow.phase).toBe('signed-out');
  });

  it('an expired token signs out with a message; a rate limit or no connection keeps the lists', async () => {
    localStorage.setItem(GITHUB_TOKEN_KEY, 'gho_old');
    const ok = new GitHubHomeModel({ fetchImpl: fakeFetch(api200), proxyBase: null });
    await ok.refresh();
    expect(ok.data?.repos.length).toBe(3);

    const limited = new GitHubHomeModel({ proxyBase: null, fetchImpl: fakeFetch({ 'api.github.com': () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } }) }) });
    expect(limited.data?.repos.length).toBe(3); // from the cache
    await limited.refresh();
    expect(limited.phase).toBe('signed-in');
    expect(limited.notice?.kind).toBe('rate');
    expect(limited.data?.repos.length).toBe(3);

    const offline = new GitHubHomeModel({ proxyBase: null, fetchImpl: fakeFetch({ 'api.github.com': () => { throw new TypeError('offline'); } }) });
    await offline.refresh();
    expect(offline.notice?.kind).toBe('offline');
    expect(offline.data?.repos.length).toBe(3);

    const expired = new GitHubHomeModel({ proxyBase: null, fetchImpl: fakeFetch({ 'api.github.com': () => new Response('{"message":"Bad credentials"}', { status: 401 }) }) });
    await expired.refresh();
    expect(expired.phase).toBe('signed-out');
    expect(expired.data).toBeNull();
    expect(expired.notice?.text).toMatch(/expired or was revoked/);
    expect(localStorage.getItem(GITHUB_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem('tabcomputer_git_home')).toBeNull();
  });

  it('more repositories: the next page, without duplicates', async () => {
    localStorage.setItem(GITHUB_TOKEN_KEY, 'gho_x');
    const page2 = [repo({ full_name: 'ada/zeta', pushed_at: '2020-01-01T00:00:00Z' }), REPOS[0]];
    const m = new GitHubHomeModel({ proxyBase: null, fetchImpl: fakeFetch({ ...api200, 'api.github.com/user/repos': (u) => u.includes('page=2') ? json(page2) : json(REPOS, { headers: { link: '<p2>; rel="next"' } }) }) });
    await m.refresh();
    await m.moreRepos();
    expect(m.data?.repos.map(r => r.name)).toEqual(['engine', 'notes', 'Difference', 'zeta']);
    expect(m.data?.reposNext).toBe(0);
  });
});
