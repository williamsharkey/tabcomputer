/**
 * fetch() for an address that is, or stands for, a host this site's server
 * would otherwise reach for the page (net-mode.ts). In proxy mode it is the
 * plain fetch of the proxy route. In private mode the request goes to the
 * real host: straight from the browser where the host allows it
 * (api.github.com), else with TLS in this page over the TCP relay.
 */
import { GITHUB_API, PROXIED_HOSTS, networkMode, unproxiedUrl } from './net-mode';
import type { GuestNet } from './commands/relay-fetch';

/** The real address when `url` is a proxied host or one of this site's routes for one, else null */
export function realTarget(url: string, siteOrigin: string): string | null {
  if (PROXIED_HOSTS.some(([prefix]) => url.startsWith(prefix))) return url;
  return unproxiedUrl(url, siteOrigin);
}

export interface PrivateFetchOptions {
  env?: Record<string, string | undefined>;
  /** This site's origin (the proxy routes are under it) */
  siteOrigin: string;
  /** A kernel guest's sockets (node in a Worker) */
  guest?: GuestNet | null;
  fetchImpl?: typeof fetch;
}

/** Whether private mode takes this request away from the page's fetch */
export function goesPrivate(url: string, o: Pick<PrivateFetchOptions, 'env' | 'siteOrigin'>): string | null {
  return networkMode(o.env) === 'private' ? realTarget(url, o.siteOrigin) : null;
}

export async function privateFetch(url: string, init: RequestInit | undefined, o: PrivateFetchOptions): Promise<Response> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const real = goesPrivate(url, o);
  if (!real) return fetchImpl(url, init);
  if (real.startsWith(GITHUB_API + '/')) return fetchImpl(real, init);
  const { relayAvailable, relayFetch } = await import('./commands/relay-fetch');
  if (!o.guest && !relayAvailable()) {
    throw new TypeError(`private network mode: ${new URL(real).host} needs the TCP relay and this page has none (netmode proxy uses this site's server instead)`);
  }
  return relayFetch(real, init ?? {}, o.guest ?? null);
}
