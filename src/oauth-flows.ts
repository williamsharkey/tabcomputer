/**
 * OAuth flows that come back through the site's `/oauth/callback` page.
 *
 * A program in the tab that signs in with OAuth listens on a port of the tab
 * and opens the provider's page (`open URL`, `xdg-open`, src/open-url.ts) with
 * `redirect_uri=<this site>/oauth/callback` and a `state` of its own. The
 * provider sends the browser to that page (server.mjs `handleOAuthCallback`),
 * which hands the answer to the tabs of this site, and the tab passes it on to
 * the program's port.
 *
 * Anyone can make a link to `/oauth/callback?state=…`, so a tab acts only on
 * an answer to a flow it started: the `state` is recorded here when the
 * provider's page is opened, with the port named then, and a callback is
 * passed on only when its `state` is one of those, once, to that port. The
 * port never comes from the callback. No DOM: main.ts and open-url.ts call
 * this, and the tests drive it.
 */

export const OAUTH_CALLBACK_PATH = '/oauth/callback';
/** What a callback carries on to the program that waits for it (server.mjs's page sends the same names and no others) */
export const OAUTH_CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss', 'scope'] as const;
/** A flow is waited for this long */
const FLOW_MS = 15 * 60_000;
const FLOWS_MAX = 32;
const VALUE_MAX = 4096;

const flows = new Map<string, { port: number; at: number }>();

/** Forget every flow (tests) */
export function resetOAuthFlows(): void {
  flows.clear();
}

/**
 * A page is being opened for a program. When it is a provider's page that
 * will come back to this site's callback, remember its `state` and the port
 * the answer goes to (`port=` of the redirect address, or a state that starts
 * `port_<n>_`). True when a flow was recorded.
 */
export function noteOAuthFlow(url: string, origin: string, now = Date.now()): boolean {
  let state: string | null, redirect: URL;
  try {
    const u = new URL(url);
    state = u.searchParams.get('state');
    redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
  } catch { return false; }
  if (redirect.origin !== origin || redirect.pathname !== OAUTH_CALLBACK_PATH) return false;
  // (a state is what tells this flow's answer from one somebody made up: too short a one tells nothing)
  if (!state || state.length < 8 || state.length > 512) return false;
  const named = redirect.searchParams.get('port') ?? /^port_(\d+)_/.exec(state)?.[1] ?? '';
  const port = /^\d{1,5}$/.test(named) ? Number(named) : 0;
  if (port < 1 || port > 65535) return false;
  for (const [s, f] of flows) if (now - f.at >= FLOW_MS) flows.delete(s);
  while (flows.size >= FLOWS_MAX) flows.delete(flows.keys().next().value as string);
  flows.set(state, { port, at: now });
  return true;
}

/**
 * What to ask of the program that waits, for a message from the callback
 * page: its port and the callback's path. Null when the message's `state` is
 * not one this tab issued (or was used already, or is too old): then nothing
 * is done.
 */
export function oauthCallbackRequest(data: unknown, now = Date.now()): { port: number; path: string } | null {
  const d = data as { type?: unknown; state?: unknown; code?: unknown; params?: unknown } | null;
  if (!d || d.type !== 'shiro-oauth-callback' || typeof d.state !== 'string') return null;
  const flow = flows.get(d.state);
  if (!flow) return null;
  // An answer is taken once
  flows.delete(d.state);
  if (now - flow.at >= FLOW_MS) return null;
  const given = d.params && typeof d.params === 'object' ? d.params as Record<string, unknown> : {};
  const out = new URLSearchParams();
  for (const k of OAUTH_CALLBACK_PARAMS) {
    const v = k === 'state' ? d.state : k === 'code' && typeof d.code === 'string' && d.code ? d.code : given[k];
    if (typeof v === 'string' && v && v.length <= VALUE_MAX) out.set(k, v);
  }
  return { port: flow.port, path: `${OAUTH_CALLBACK_PATH}?${out.toString()}` };
}
