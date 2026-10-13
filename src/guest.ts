/**
 * Guests (docs/research/GUEST_PROFILE.md, tabcomputer#113): a clean place for
 * untrusted work. A guest is the app on an origin of its own,
 * `guest--<name>[--<flags>].<base>`, so the browser keeps its storage apart
 * from the main profile's: node scripts are JavaScript in the page's origin,
 * and no namespace inside one origin holds against them.
 *
 * The mode is in the hostname (flags `t`: thrown away, `x`: no network)
 * because the server enforces it from the Host header and script in the guest
 * cannot change its own origin. server.mjs parses the same label
 * (`parseGuestLabel` there; guest.test.ts checks the two agree).
 *
 * No imports: main() asks before anything else is set up, and Workers ask too.
 */

export interface GuestInfo {
  /** The DNS label: guest--NAME or guest--NAME--FLAGS */
  label: string;
  name: string;
  /** Thrown away: not kept under its name */
  ephemeral: boolean;
  noNetwork: boolean;
}

export interface GuestRequest { name?: string; noNetwork?: boolean }

const LABEL = /^guest--([a-z0-9]{1,32})(?:--(t|x|tx))?$/;

export function parseGuestLabel(label: string): GuestInfo | null {
  const m = LABEL.exec(String(label || '').toLowerCase());
  if (!m) return null;
  const flags = m[2] ?? '';
  return { label: m[0], name: m[1], ephemeral: flags.includes('t'), noNetwork: flags.includes('x') };
}

/** The guest a hostname names (its first label; a guest host always has a parent). */
export function parseGuestHost(hostname: string): GuestInfo | null {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const dot = h.indexOf('.');
  return dot > 0 && dot < h.length - 1 ? parseGuestLabel(h.slice(0, dot)) : null;
}

/** The guest an origin (scheme://host[:port]) is, or null. */
export function parseGuestOrigin(origin: string): GuestInfo | null {
  try { return parseGuestHost(new URL(origin).hostname); } catch { return null; }
}

export function guestLabel(g: { name: string; ephemeral?: boolean; noNetwork?: boolean }): string {
  const flags = (g.ephemeral ? 't' : '') + (g.noNetwork ? 'x' : '');
  return `guest--${g.name}${flags ? `--${flags}` : ''}`;
}

/** A name someone typed, as a label allows it ('' when nothing is left). */
export function cleanGuestName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 32);
}

export function randomGuestName(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

let cached: GuestInfo | null | undefined;
/** The guest this page (or Worker) is, or null in a main profile. */
export function guestInfo(): GuestInfo | null {
  if (cached === undefined) cached = typeof location !== 'undefined' ? parseGuestHost(location.hostname) : null;
  return cached;
}
export const isGuest = (): boolean => guestInfo() !== null;
/** Tests: act as this host's page (undefined: ask the location again). */
export function setGuestHostForTests(hostname: string | undefined): void {
  cached = hostname === undefined ? undefined : parseGuestHost(hostname);
}

// ── Asking for one ──

/** `?guest`, `?guest=NAME`, `&nonet` in a page address: the guest it asks for, or null. */
export function guestRequest(search: string): GuestRequest | null {
  const q = new URLSearchParams(search);
  if (!q.has('guest') || q.get('guest') === '0') return null;
  const name = cleanGuestName(q.get('guest') === '1' ? '' : q.get('guest') ?? '');
  return { ...(name ? { name } : {}), noNetwork: q.has('nonet') && q.get('nonet') !== '0' };
}

/** Paths main.ts never reads as /<user>/<repo> */
export const RESERVED_PATHS = ['api', 'oauth', 'offer', 'answer', 'git-proxy', 'channel', 'assets', 'guest', 'browse', 'tcp', 'relay', 'debian', 'claude-releases', 'apps', 'apphost'];

/**
 * A page address that makes boot import or run someone else's code: a shared
 * seed (/s/ID) or a repository (/USER/REPO). In a main profile these open in a
 * guest when the server has guests.
 */
export function inboundCodeLink(pathname: string): { kind: 'seed'; id: string } | { kind: 'repo'; user: string; repo: string } | null {
  const seed = /^\/s\/([a-z0-9]{4,16})$/.exec(pathname);
  if (seed) return { kind: 'seed', id: seed[1] };
  const gh = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/.exec(pathname);
  if (gh && !RESERVED_PATHS.includes(gh[1].toLowerCase())) return { kind: 'repo', user: gh[1], repo: gh[2] };
  return null;
}

/**
 * The address of a guest: `template` is the server's (`https://{guest}.example.com`),
 * `at` the page address whose path, other parameters and hash go along.
 * A request without a name is a thrown-away guest under a random one.
 */
export function guestUrl(template: string, req: GuestRequest = {}, at?: string): string {
  const name = cleanGuestName(req.name ?? '');
  const label = guestLabel({ name: name || randomGuestName(), ephemeral: !name, noNetwork: !!req.noNetwork });
  const origin = template.replace('{guest}', label);
  if (!at) return origin + '/';
  const u = new URL(at);
  u.searchParams.delete('guest');
  u.searchParams.delete('nonet');
  return origin + u.pathname + u.search + u.hash;
}

export interface GuestConfig {
  /** `scheme://{guest}.host[:port]`, or null when this server has no guests */
  origin: string | null;
  /** On a guest's own host: what the server took the host for */
  guest?: { name: string; ephemeral: boolean; noNetwork: boolean };
  /** The server refuses its network routes and sends the CSP for this host's mode */
  enforced?: boolean;
}

let configP: Promise<GuestConfig> | null = null;
/** The server's guest settings (/guest/config.json); `{ origin: null }` from a server without guests. */
export function guestConfig(fetchImpl: typeof fetch = fetch): Promise<GuestConfig> {
  return configP ??= (async () => {
    try {
      const r = await fetchImpl('/guest/config.json', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j && (typeof j.origin === 'string' || j.origin === null)) return j as GuestConfig;
    } catch { /* an older server answers with the app shell */ }
    return { origin: null };
  })();
}
export function resetGuestConfigForTests(): void { configP = null; unavailable = false; }

let unavailable = false;
/** This address asked for a guest and the server has none: nothing it carries may run here. */
export const guestUnavailable = (): boolean => unavailable;

/** Open a guest in a new tab. Resolves to its address, or null when the server has none. */
export async function openGuest(req: GuestRequest = {}, opts: { open?: boolean; search?: string } = {}): Promise<string | null> {
  const cfg = await guestConfig();
  if (!cfg.origin) return null;
  const url = guestUrl(cfg.origin, req) + (opts.search ?? '');
  if (req.name) rememberGuest(cleanGuestName(req.name), !!req.noNetwork);
  if (opts.open !== false) window.open(url, '_blank', 'noopener');
  return url;
}

// ── Kept guests this profile opened (names only; their storage is their origin's) ──

export const KEPT_GUESTS_KEY = 'tabcomputer-guests';
export interface KeptGuest { name: string; noNetwork: boolean; opened: number }

export function keptGuests(): KeptGuest[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEPT_GUESTS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((g) => g && typeof g.name === 'string') : [];
  } catch { return []; }
}

function rememberGuest(name: string, noNetwork: boolean): void {
  if (!name) return;
  try {
    const list = keptGuests().filter((g) => !(g.name === name && g.noNetwork === noNetwork));
    list.unshift({ name, noNetwork, opened: Date.now() });
    localStorage.setItem(KEPT_GUESTS_KEY, JSON.stringify(list.slice(0, 50)));
  } catch { /* no storage */ }
}

// ── The statement of the boundary ──

/**
 * What this guest's boundary is, in sentences that are true. `enforced`: the
 * server confirmed it treats this host as that guest (its routes refuse a
 * no-network guest and its CSP stops requests to other sites). Without that
 * the page has only switched its own relay off, and the text says so.
 */
export function boundaryStatement(g: GuestInfo, opts: { host: string; enforced: boolean }): { title: string; lines: string[] } {
  const lines = [
    `This window is a separate site in your browser (${opts.host}). What runs here cannot read your main tabcomputer: its files, ~/.claude, git settings or GitHub sign-in.`,
    'It starts with no sign-ins. Anything you sign in to, paste or upload here can be read by everything that runs here.',
  ];
  if (!g.noNetwork) {
    lines.push('It has internet access, from your connection.');
  } else if (opts.enforced) {
    lines.push('No network: programs here have no connection, and the browser blocks requests to other sites. Scripts can still load tabcomputer\'s own files, and can still send the tab to another address, so keep out what must not leave.');
  } else {
    lines.push('No network, in this page only: the connection programs use is switched off, but this server does not enforce it, so a script here can still make web requests.');
  }
  lines.push(g.ephemeral
    ? 'Thrown away: Discard deletes everything stored here. If you only close the tab, what is left is deleted the next time this address opens.'
    : `Kept in this browser under the name "${g.name}" until you discard it.`);
  return { title: g.noNetwork ? 'Guest, no network' : 'Guest', lines };
}

/** The statement for this page, asking the server whether it enforces the mode. */
export async function currentBoundaryStatement(): Promise<{ title: string; lines: string[] } | null> {
  const g = guestInfo();
  if (!g) return null;
  const cfg = await guestConfig();
  const same = !!cfg.guest && cfg.guest.name === g.name && cfg.guest.noNetwork === g.noNetwork && cfg.guest.ephemeral === g.ephemeral;
  return boundaryStatement(g, { host: location.host, enforced: !!cfg.enforced && same });
}

// ── Storage: throwing a guest away ──

const SESSION_KEY = 'tabcomputer-guest-session';
const DISCARD_KEY = 'tabcomputer-guest-discard';
const LOCK = 'tabcomputer-guest';

/** Once a discard starts, nothing may write storage again (console-log.ts, watchdog.ts ask). */
let discarding = false;
export const guestDiscarding = (): boolean => discarding;

/**
 * Delete everything this origin stores. Only ever in a guest: it throws in a
 * main profile. Resolves to what could not be removed.
 */
export async function wipeGuestStorage(): Promise<string[]> {
  if (!guestInfo()) throw new Error('not a guest: refusing to delete this origin\'s storage');
  const left: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { left.push(`${what}: ${(e as Error)?.message ?? e}`); } };
  await attempt('service workers', async () => {
    for (const r of await navigator.serviceWorker?.getRegistrations?.() ?? []) await r.unregister();
  });
  await attempt('IndexedDB', async () => {
    const dbs = await indexedDB.databases?.() ?? [];
    await Promise.all(dbs.map((d) => new Promise<void>((resolve) => {
      if (!d.name) return resolve();
      const name = d.name;
      const t = setTimeout(() => { left.push(`IndexedDB ${name}: still open elsewhere`); resolve(); }, 4000);
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => { clearTimeout(t); resolve(); };
      req.onerror = () => { clearTimeout(t); left.push(`IndexedDB ${name}: ${req.error?.message ?? 'error'}`); resolve(); };
    })));
  });
  await attempt('caches', async () => {
    if (typeof caches === 'undefined') return;
    for (const k of await caches.keys()) await caches.delete(k);
  });
  await attempt('OPFS', async () => {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true });
  });
  try { localStorage.clear(); } catch { left.push('localStorage'); }
  try { sessionStorage.clear(); } catch { left.push('sessionStorage'); }
  return left;
}

/** Discard this guest: reload into a document that opens nothing, and delete there. */
export function discardGuest(): void {
  if (!guestInfo()) return;
  discarding = true;
  try { sessionStorage.setItem(DISCARD_KEY, '1'); } catch { /* no storage */ }
  location.replace('/');
}

async function otherTabRuns(): Promise<boolean> {
  try {
    const q = await navigator.locks.query();
    return (q.held ?? []).some((l) => l.name === LOCK);
  } catch { return false; }
}

function farewell(left: string[]): void {
  document.title = 'Guest discarded';
  const body = document.body;
  body.textContent = '';
  body.style.cssText = 'font: 15px system-ui, sans-serif; margin: 15vh auto; max-width: 34em; padding: 0 20px; color: #888; background: #111';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size: 20px; color: #ddd';
  h.textContent = left.length ? 'This guest was only partly discarded' : 'This guest has been discarded';
  const p = document.createElement('p');
  p.id = 'guest-discarded';
  p.textContent = left.length
    ? `Could not delete: ${left.join('; ')}. Close its other tabs and reload this page, or clear this site's data in the browser.`
    : 'Everything it stored in this browser is deleted. You can close this tab.';
  body.append(h, p);
}

function stop(message: string): 'stop' {
  document.title = 'tabcomputer';
  document.body.textContent = message;
  document.body.style.cssText = 'font: 15px system-ui, sans-serif; margin: 15vh auto; max-width: 34em; padding: 0 20px';
  return 'stop';
}

/** True when a guest's page frames this (main) page. */
export function framedByGuest(loc: { ancestorOrigins?: ArrayLike<string> } | null = typeof location !== 'undefined' ? location as never : null): boolean {
  const anc = loc?.ancestorOrigins;
  if (!anc) return false;
  for (let i = 0; i < anc.length; i++) if (parseGuestOrigin(anc[i])) return true;
  return false;
}

/**
 * First thing in main(): 'stop' when this load must not boot (it is being
 * redirected to a guest, it was a guest's discard, or a guest frames a main
 * profile), else the guest this page is, or null.
 */
export async function bootGuest(): Promise<'stop' | GuestInfo | null> {
  const guest = guestInfo();
  if (!guest) {
    // A guest is same-site with this profile when both are under one domain, so a
    // frame of it would see this profile's own storage
    if (window.parent !== window && framedByGuest()) return stop('tabcomputer does not run inside a guest\'s frame.');
    const asked = guestRequest(location.search);
    const link = asked ? null : inboundCodeLink(location.pathname);
    if (!asked && !link) return null;
    const cfg = await guestConfig();
    if (!cfg.origin) {
      if (asked) { unavailable = true; console.warn('[tabcomputer] this address asked for a guest, but this server has none'); }
      return null;
    }
    // A seed is kept under its own name (the link opens the same machine again); a repository is thrown away
    const req: GuestRequest = asked ?? (link!.kind === 'seed' ? { name: `seed${link!.id}` } : {});
    location.replace(guestUrl(cfg.origin, req, location.href));
    return 'stop';
  }

  let discard = false;
  try { discard = sessionStorage.getItem(DISCARD_KEY) === '1'; } catch { /* no storage */ }
  if (discard) {
    discarding = true;
    farewell(await wipeGuestStorage());
    return 'stop';
  }
  if (guest.ephemeral) {
    // A reload keeps its sessionStorage; a new tab on a thrown-away guest's
    // address finds what an earlier tab left, and deletes it first
    let mine: string | null = null, stored: string | null = null;
    try { mine = sessionStorage.getItem(SESSION_KEY); stored = localStorage.getItem(SESSION_KEY); } catch { /* no storage */ }
    if (!mine || mine !== stored) {
      if (!(await otherTabRuns())) {
        const left = await wipeGuestStorage();
        if (left.length) console.warn(`[guest] left from an earlier tab: ${left.join('; ')}`);
        stored = null;
      }
      const id = stored ?? randomGuestName();
      try { sessionStorage.setItem(SESSION_KEY, id); localStorage.setItem(SESSION_KEY, id); } catch { /* no storage */ }
    }
  }
  // Held for the life of the page: says a tab runs this guest
  try { void navigator.locks.request(LOCK, { mode: 'shared' }, () => new Promise(() => {})); } catch { /* no Web Locks */ }
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('guest') || u.searchParams.has('nonet')) {
      u.searchParams.delete('guest'); u.searchParams.delete('nonet');
      history.replaceState(history.state, '', u.toString());
    }
  } catch { /* not a page */ }
  document.documentElement.dataset.guest = guest.noNetwork ? 'no-network' : 'network';
  return guest;
}
