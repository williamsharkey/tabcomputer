/**
 * How requests that the browser itself cannot make reach the internet
 * (docs/NETWORKING.md, "Private mode").
 *
 *   proxy    (the default) this site's server makes them: /api/github,
 *            /git-proxy, /api/anthropic and the rest. Fast and it always
 *            works, and the server reads what passes: tokens, code, prompts.
 *   private  the server reads none of it. GitHub's API is called straight
 *            from the browser (it allows cross-origin requests), git on
 *            github.com goes through that API, and everything else is
 *            encrypted in the tab and sent over the TCP relay, which sees a
 *            host name and byte counts.
 *
 * The choice is saved in this browser (Settings -> Network, `netmode`). One
 * command can go the other way: TABCOMPUTER_NETWORK_MODE=proxy git push.
 */

export type NetworkMode = 'proxy' | 'private';

export const NETWORK_MODE_KEY = 'tabcomputer_network_mode';
export const NETWORK_MODE_ENV = 'TABCOMPUTER_NETWORK_MODE';
export const GITHUB_API = 'https://api.github.com';

/** A Worker has no localStorage: the page's choice, sent with the guest's start data */
let inherited: NetworkMode | null = null;
const listeners = new Set<(m: NetworkMode) => void>();

const valid = (v: unknown): v is NetworkMode => v === 'proxy' || v === 'private';

/** The environment of the command now running, for code below it that has no ctx (gh's API client) */
let commandEnv: Record<string, string | undefined> | null = null;

/** Run a command's body so that `${NETWORK_MODE_ENV}=proxy gh ...` reaches every request it makes */
export async function withCommandEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const before = commandEnv;
  commandEnv = env;
  try { return await body(); } finally { commandEnv = before; }
}

/** The mode for a command with this environment (the variable wins), else the saved choice */
export function networkMode(env?: Record<string, string | undefined>): NetworkMode {
  const e = (env ?? commandEnv)?.[NETWORK_MODE_ENV];
  if (valid(e)) return e;
  if (inherited) return inherited;
  try { const v = localStorage.getItem(NETWORK_MODE_KEY); if (valid(v)) return v; } catch { /* no storage here */ }
  return 'proxy';
}

export function setNetworkMode(mode: NetworkMode): void {
  try {
    if (mode === 'proxy') localStorage.removeItem(NETWORK_MODE_KEY);
    else localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch { /* no storage here */ }
  for (const l of listeners) { try { l(mode); } catch { /* a listener's own problem */ } }
}

/** For a guest's Worker: the page's mode (null: read it here) */
export function inheritNetworkMode(mode: unknown): void {
  inherited = valid(mode) ? mode : null;
}

export function onNetworkMode(cb: (m: NetworkMode) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Where GitHub's REST API is: GitHub itself in private mode, this site's proxy otherwise */
export function githubApiBase(siteOrigin: string, env?: Record<string, string | undefined>): string {
  return networkMode(env) === 'private' ? GITHUB_API : `${siteOrigin}/api/github`;
}

/** The hosts whose requests this site's server would otherwise make, and its route for each */
export const PROXIED_HOSTS: [prefix: string, route: string][] = [
  ['https://api.anthropic.com/', '/api/anthropic/'],
  ['https://platform.claude.com/', '/api/platform/'],
  ['https://mcp-proxy.anthropic.com/', '/api/mcp-proxy/'],
  ['https://generativelanguage.googleapis.com/', '/api/gemini/'],
  ['https://api.github.com/', '/api/github/'],
];

/** The real address behind one of this site's proxy routes (`${siteOrigin}/api/anthropic/v1/messages`), or null */
export function unproxiedUrl(url: string, siteOrigin: string): string | null {
  if (!siteOrigin || !url.startsWith(siteOrigin + '/')) return null;
  const path = url.slice(siteOrigin.length);
  for (const [prefix, route] of PROXIED_HOSTS) {
    if (path.startsWith(route)) return prefix + path.slice(route.length);
  }
  return null;
}
