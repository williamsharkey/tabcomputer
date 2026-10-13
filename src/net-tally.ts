/**
 * What this page downloaded, by the path it took (docs/RUN_LINKS.md "link",
 * tabcomputer#147): straight from the browser (npm, PyPI, GitHub), from this
 * site's own files and caches (Debian packages, Pyodide), or through this
 * site's relay and proxies. `link` says it for the commands it keeps: relay
 * bytes are what a link costs this site when many people open it.
 *
 * Nothing is intercepted. The browser's own record of the page's requests
 * (Resource Timing) is read, and the TCP relay's transport adds the bytes it
 * delivers (src/kernel/net.ts). A site that does not allow its sizes to be
 * read (no Timing-Allow-Origin) is counted in files only. A Worker's own
 * requests (Pyodide loading a package) are not in the page's record.
 */

export type NetPath = 'direct' | 'site' | 'relay';
export interface TallyRow { path: NetPath; label: string; files: number; bytes: number }

const rows = new Map<string, TallyRow>();

function add(path: NetPath, label: string, files: number, bytes: number): void {
  const key = `${path} ${label}`;
  let r = rows.get(key);
  if (!r) {
    // (a page cannot be made to grow this without end: the many hosts of a crawl share one row)
    if (rows.size >= 200) { label = 'other hosts'; r = rows.get(`${path} ${label}`); }
    if (!r) rows.set(`${path} ${label}`, r = { path, label, files: 0, bytes: 0 });
  }
  r.files += files;
  r.bytes += bytes;
}

const DIRECT: [RegExp, string][] = [
  [/(^|\.)npmjs\.(org|com)$/, 'npm'],
  [/(^|\.)(pypi\.org|pythonhosted\.org)$/, 'PyPI'],
  [/(^|\.)(github\.com|githubusercontent\.com|githubassets\.com)$/, 'GitHub'],
  [/(^|\.)jsdelivr\.net$/, 'jsDelivr'],
  [/(^|\.)unpkg\.com$/, 'unpkg'],
  [/(^|\.)crates\.io$/, 'crates.io'],
];
/** Paths of this site that hold what a setup installs, and the proxies that carry a request on */
const SITE: [RegExp, NetPath, string][] = [
  [/^\/debian\//, 'site', 'Debian packages'],
  [/^\/pyodide\//, 'site', 'Pyodide'],
  [/^\/pkg\//, 'site', 'tabcomputer packages'],
  [/^\/claude-releases\//, 'site', 'Claude Code'],
  [/^\/gui\//, 'site', 'GUI apps'],
  [/^\/git-proxy\//, 'relay', 'git'],
  [/^\/api\/github/, 'relay', 'the GitHub proxy'],
];

/** Where a request went, as `link` names it; null for what is the page itself (its script, its images, its APIs for Claude) */
export function classifyUrl(url: string, origin: string): { path: NetPath; label: string } | null {
  let u: URL;
  try { u = new URL(url, origin); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  // (a build served from another host takes its packages from the site: src/pkg-manager.ts's mirror)
  if (u.origin === origin || u.hostname === 'tabcomputer.com' || u.hostname === 'shiro.computer') {
    for (const [re, path, label] of SITE) if (re.test(u.pathname)) return { path, label };
    return null;
  }
  // A guest's or an app's own origin is this site too
  if (u.hostname.endsWith('.localhost') || u.hostname.endsWith('.tabcomputer.com')) return null;
  for (const [re, label] of DIRECT) if (re.test(u.hostname)) return { path: 'direct', label };
  return { path: 'direct', label: u.hostname };
}

/** Bytes the TCP relay delivered for a connection to `host` (src/kernel/net.ts) */
export function tallyRelay(host: string, bytes: number): void {
  add('relay', host || 'a host', 0, bytes);
}

/**
 * Whether the page got what it asked for. A fetch the browser refused (the site
 * sends no CORS headers) is in the browser's record too, with status 0: nothing
 * came from it, and the same file then comes through the relay. Counted, it made
 * `link` say "Straight from the browser: HOST 1 file" for a file the browser never
 * gave (seen in Chrome, tests/browser/link-is-computer.mjs `relay`). A browser
 * that records no status counts as before.
 */
export function received(e: { initiatorType?: string; responseStatus?: number }): boolean {
  return !(e.responseStatus === 0 && (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'));
}

let observer: PerformanceObserver | null = null;
function take(list: PerformanceEntry[], origin: string): void {
  for (const e of list) {
    const r = e as PerformanceResourceTiming;
    const c = classifyUrl(r.name, origin);
    if (c && received(r)) add(c.path, c.label, 1, r.transferSize || r.encodedBodySize || 0);
  }
}

/** Start reading the page's own record of its requests. Once; a page without the API counts nothing. */
export function startNetTally(origin: string = typeof location !== 'undefined' ? location.origin : ''): void {
  if (observer || typeof PerformanceObserver === 'undefined') return;
  try {
    observer = new PerformanceObserver((list) => take(list.getEntries(), origin));
    observer.observe({ type: 'resource', buffered: true });
    tallyOrigin = origin;
  } catch { observer = null; }
}
let tallyOrigin = '';

/** The counts so far (requests the browser has finished but not yet reported are taken first) */
export function netTally(): TallyRow[] {
  if (observer) { try { take(observer.takeRecords(), tallyOrigin); } catch { /* not supported */ } }
  return [...rows.values()].map((r) => ({ ...r }));
}

/** What was added between two readings of netTally() */
export function tallySince(before: TallyRow[], after: TallyRow[]): TallyRow[] {
  const was = new Map(before.map((r) => [`${r.path} ${r.label}`, r]));
  const out: TallyRow[] = [];
  for (const r of after) {
    const b = was.get(`${r.path} ${r.label}`);
    const files = r.files - (b?.files ?? 0), bytes = r.bytes - (b?.bytes ?? 0);
    if (files > 0 || bytes > 0) out.push({ path: r.path, label: r.label, files, bytes });
  }
  return out;
}

/** Several readings' rows as one list */
export function sumTally(lists: TallyRow[][]): TallyRow[] {
  const sum = new Map<string, TallyRow>();
  for (const list of lists) for (const r of list) {
    const key = `${r.path} ${r.label}`;
    const s = sum.get(key);
    if (s) { s.files += r.files; s.bytes += r.bytes; } else sum.set(key, { ...r });
  }
  return [...sum.values()];
}

export const sizeText = (n: number): string => (n < 1000 ? `${n} bytes` : n < 1e6 ? `${Math.ceil(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);

/** More than this through the relay gets a warning */
export const RELAY_WARN_BYTES = 5_000_000;

/**
 * The downloads as sentences, one per path, and a warning when the relay
 * carried more than a few megabytes.
 */
export function downloadSentences(list: TallyRow[]): { lines: string[]; relayBytes: number; warning: string } {
  const part = (r: TallyRow): string => {
    const files = r.files ? `${r.files} ${r.files === 1 ? 'file' : 'files'}` : '';
    const bytes = r.bytes ? sizeText(r.bytes) : '';
    return `${r.label} ${files && bytes ? `${files}, ${bytes}` : files || bytes}`;
  };
  const group = (path: NetPath): string => list.filter((r) => r.path === path).sort((a, b) => b.bytes - a.bytes || b.files - a.files).map(part).join('; ');
  const lines: string[] = [];
  const direct = group('direct'), site = group('site'), relay = group('relay');
  if (direct) lines.push(`Straight from the browser: ${direct}.`);
  if (site) lines.push(`From this site's own files: ${site}.`);
  if (relay) lines.push(`Through this site's relay: ${relay}.`);
  if (!lines.length) lines.push('The commands in the link downloaded nothing here.');
  const relayBytes = list.filter((r) => r.path === 'relay').reduce((n, r) => n + r.bytes, 0);
  const warning = relayBytes > RELAY_WARN_BYTES
    ? `${sizeText(relayBytes)} went through this site's relay. The relay is the part that costs this site each time someone opens the link. Where you can, fetch a large file from a site that browsers may read directly (GitHub, npm, PyPI).`
    : '';
  return { lines, relayBytes, warning };
}
