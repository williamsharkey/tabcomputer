/**
 * The part of the address after `#`, when it may be a link (commands, a
 * one-file app, a gist: src/link-fragment.ts, docs/RUN_LINKS.md "After the
 * #"). main() takes it out of the address before anything else happens, so
 * it is in no reload, no history entry and no later copy of the address.
 * What it means, and the prompt, come after boot.
 *
 * `?app=` and `?run=` links own their `#` (`?app=link#app=…`): with either in
 * the query this module leaves the address alone. `#safe` is safe mode's.
 */

function linkHash(hash: string, search: string): string {
  if (hash.length < 2 || /^#safe\b/.test(hash)) return '';
  const q = new URLSearchParams(search);
  return q.has('app') || q.has('run') ? '' : hash;
}

const AT_LOAD = typeof location !== 'undefined' ? linkHash(location.hash, location.search) : '';

/** Was this page opened with something after the `#`? (Read when this module loaded, before it was taken.) */
export function fragmentAtLoad(): boolean {
  return !!AT_LOAD;
}

/** Take the part after `#` out of the address and return it; '' when there is none that may be a link */
export function takeFragment(): string {
  if (typeof location === 'undefined') return '';
  const hash = linkHash(location.hash, location.search);
  if (!hash) return '';
  try {
    const u = new URL(location.href);
    u.hash = '';
    history.replaceState(history.state, '', u.toString());
  } catch { /* not a page with a history */ }
  return hash;
}
