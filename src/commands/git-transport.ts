/**
 * How the built-in git reaches a remote (net-mode.ts):
 *
 *   proxy  this site's /git-proxy makes the request (the default): the server
 *          reads the token and the repository.
 *   relay  the same git protocol with TLS done in this page, sent over the TCP
 *          relay: the server sees the host name and byte counts.
 *   api    github.com only: GitHub's REST API straight from the browser
 *          (git-github-api.ts): no server of ours at all.
 *
 * Private mode picks api for github.com and relay for every other host.
 * TABCOMPUTER_GIT_TRANSPORT=proxy|relay|api overrides it for one command, and
 * an explicit GIT_CORS_PROXY keeps meaning "this proxy".
 */
import type { HttpClient } from 'isomorphic-git';
import { getShiroOrigin } from '../utils/shiro-origin';
import { networkMode } from '../net-mode';

export type GitTransport = 'proxy' | 'relay' | 'api';

export const isGitHubUrl = (url: string | undefined): boolean => !!url && /^https?:\/\/([^/@]+@)?github\.com\//.test(url);

export function gitTransport(env: Record<string, string | undefined>, url: string | undefined): GitTransport {
  const asked = env['TABCOMPUTER_GIT_TRANSPORT'];
  if (asked === 'proxy' || asked === 'relay') return asked;
  if (asked === 'api') return isGitHubUrl(url) ? 'api' : 'relay';
  if (env['GIT_CORS_PROXY'] || networkMode(env) !== 'private') return 'proxy';
  return isGitHubUrl(url) ? 'api' : 'relay';
}

async function collect(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined): Promise<Uint8Array | undefined> {
  if (!body) return undefined;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const p of body as AsyncIterable<Uint8Array>) { parts.push(p); size += p.length; }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function* chunks(res: Response): AsyncGenerator<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** isomorphic-git's http client over the relay, TLS in the page (commands/relay-fetch.ts) */
export const relayHttp: HttpClient = {
  async request({ url, method = 'GET', headers = {}, body, signal }) {
    const { relayFetch } = await import('./relay-fetch');
    const res = await relayFetch(url, { method, headers: { 'user-agent': 'git/isomorphic-git', ...headers }, body: await collect(body) as BodyInit | undefined, signal: signal as AbortSignal | undefined });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    return { url: res.url || url, method, statusCode: res.status, statusMessage: res.statusText, headers: out, body: chunks(res) };
  },
};

/**
 * The `http` client and `corsProxy` to hand isomorphic-git for this remote.
 * (api falls back to these when the API can't do the job: still private.)
 */
export function gitHttpFor(env: Record<string, string | undefined>, url: string | undefined, pageHttp: HttpClient): { transport: GitTransport; http: HttpClient; corsProxy?: string } {
  const transport = gitTransport(env, url);
  if (transport === 'proxy') return { transport, http: pageHttp, corsProxy: env['GIT_CORS_PROXY'] || `${getShiroOrigin()}/git-proxy` };
  return { transport, http: relayHttp };
}
