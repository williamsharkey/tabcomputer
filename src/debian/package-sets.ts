/**
 * Package layers (docs/DEBIAN.md "Package layers"): any set of Debian
 * packages installed the way a toolchain layer is.
 *
 * The tab asks the server for the layer of a set of names
 * (`/debian/layers/set`, server.mjs). A set someone asked for before is
 * there, and is applied like `toolchain install` applies one: paths in under
 * a second, file contents on first use. A set nobody asked for yet is built
 * on the server, and the tab waits while the server says how far it is. When
 * the server cannot build (no builder, a name it does not take, a failed
 * build, a build that stands still), the caller installs with apt, and
 * `fallbackSentence` says so in one sentence.
 *
 * `apt install` at the prompt (both before and in Debian mode), an app's
 * `needs` and `toolchain install NAME...` for names that are not toolchain
 * sets all come through `installPackageSet`.
 */
import type { FileSystem } from '../filesystem';
import { applyLayerInfo, type ApplyResult, type LayerInfo } from './layers';
import { defaultRootfsBase, installedRootfs, warmChunks } from './rootfs';
import { PAGE_SET_TIMEOUT } from '../node-compat/page-globals';

/** A Debian binary package name (Debian policy 5.6.1), as server.mjs takes it. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/;

/** What the server says about a set (server.mjs "Package layers"). */
export interface SetAnswer {
  state: 'ready' | 'queued' | 'building' | 'failed' | 'unavailable';
  key?: string;
  /** Where the layer's index and chunks are, relative to the page or absolute. */
  base?: string;
  layer?: LayerInfo;
  /** Builds before this one. */
  ahead?: number;
  phase?: string;
  done?: number;
  total?: number;
  reason?: string;
  message?: string;
  /** Names the archive does not have. */
  unknown?: string[];
}

export type AskSet = (names: string[], baseId: string, build: boolean) => Promise<SetAnswer>;

/** The server of this page. A server without the route, or one that is down, is `unavailable`. */
export const askServer: AskSet = async (names, baseId, build) => {
  const none: SetAnswer = { state: 'unavailable', reason: 'no-server', message: 'This server has no package layers.' };
  let url: URL;
  try { url = new URL('layers/set', defaultRootfsBase()); } catch { return none; }
  if (!/^https?:$/.test(url.protocol)) return none;
  url.searchParams.set('packages', names.join(','));
  if (baseId) url.searchParams.set('base', baseId);
  if (!build) url.searchParams.set('build', '0');
  try {
    const r = await fetch(url.href, { cache: 'no-store' });
    if (!r.ok) return none;
    const a = await r.json() as SetAnswer;
    return a && typeof a.state === 'string' ? a : none;
  } catch { return none; } // no network, or the app shell instead of JSON (an older server)
};

let askOverride: AskSet | null = null;
/** Tests: a stand-in for the server. */
export function setPackageSetServer(ask: AskSet | null): void { askOverride = ask; }
const ask = (): AskSet => askOverride ?? askServer;

/**
 * Ask about names without installing or building anything: which of them the
 * archive does not have (`unknown`), when the server can tell. No Debian is
 * needed on this machine for the question.
 */
export async function askAboutSet(names: string[]): Promise<SetAnswer> {
  const set = setNames(names);
  if (!set) return { state: 'unavailable', reason: 'bad-name' };
  return ask()(set, '', false);
}

/** The names of a set in their one order, or null when one is not a package name. */
export function setNames(names: string[]): string[] | null {
  const out = [...new Set(names)].sort();
  return out.length && out.every((n) => PACKAGE_NAME.test(n)) ? out : null;
}

const list = (names: string[]): string => (names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`);

/** What the server is doing for a set that is not built yet, as a sentence. */
export function setProgressLine(a: SetAnswer, names: string[]): string {
  if (a.state === 'queued') {
    const n = a.ahead ?? 1;
    return `The server is building other programs first: ${n} ${n === 1 ? 'build is' : 'builds are'} ahead of ${list(names)}.`;
  }
  const of = a.total ? ` ${Math.max(1, Math.min(a.done ?? 0, a.total))} of ${a.total}` : '';
  if (a.phase === 'downloading') return a.total ? `The server is downloading package${of} for ${list(names)}.` : `The server is downloading ${list(names)}.`;
  if (a.phase === 'installing') return a.total ? `The server is installing package${of} for ${list(names)}.` : `The server is installing ${list(names)}.`;
  if (a.phase === 'packing') return `The server is packing ${list(names)}.`;
  if (a.phase === 'waiting') return `The server is finishing another build before ${list(names)}.`;
  return `The server is preparing ${list(names)} for the first time.`;
}

export interface SetFailure { ok: false; reason: string; message: string; unknown?: string[] }
export interface SetInstalled { ok: true; key: string; result: ApplyResult; /** The tab waited for a build. */ built: boolean; waitedMs: number }

/** Why there is no layer, as the middle of `fallbackSentence`. */
function why(f: SetFailure): string {
  switch (f.reason) {
    case 'no-server': case 'no-builder': case 'not-built': return 'this server keeps none';
    case 'unknown-package': return f.unknown?.length ? `the server does not know ${f.unknown.join(', ')}` : 'the server does not know a name';
    case 'too-large': case 'too-many': return 'the set is larger than the server builds';
    case 'not-allowed': case 'bad-name': return 'the server does not build these';
    case 'busy': case 'rate': return "the server's builder is busy";
    case 'base': return 'the server builds for another Debian base than this tab has';
    case 'stalled': case 'timeout': return "the server's build is taking too long";
    case 'apply': return `the copy could not be applied: ${f.message}`;
    case 'stopped': return 'the wait was stopped';
    default: return 'the server could not build it';
  }
}

/** One sentence for the person when apt does the install after all. */
export function fallbackSentence(names: string[], f: SetFailure): string {
  return `No ready-made copy of ${list(names)} (${why(f)}): apt installs ${names.length > 1 ? 'them' : 'it'} here, which takes a few minutes.`;
}

export interface SetOptions {
  /** A line for the person: what the server is doing, then what was installed. */
  progress?: (line: string) => void;
  /** Stop waiting (Ctrl-C). */
  signal?: AbortSignal;
  /** Give up on a build that reports no change for this long (default 90 s). */
  patienceMs?: number;
  /** Ask the server only for a set it has; never start or wait for a build. */
  noBuild?: boolean;
  /** After the layer is in place: the overlay's defaults and the shell's view of /usr/bin (the caller has the shell). */
  afterApply?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Install `names` from the server's layer for exactly that set. Debian must
 * be installed. Resolves to what was applied, or to why there is no layer
 * (the caller then uses apt).
 */
export async function installPackageSet(fs: FileSystem, names: string[], opts: SetOptions = {}): Promise<SetInstalled | SetFailure> {
  const set = setNames(names);
  if (!set) return { ok: false, reason: 'bad-name', message: 'A name is not a Debian package name.' };
  const rootfs = await installedRootfs(fs);
  if (!rootfs) return { ok: false, reason: 'base', message: 'Debian is not installed.' };
  const now = opts.now ?? (() => Date.now());
  // (the page's own timer: a node script running in the page may have replaced the global one)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { PAGE_SET_TIMEOUT(r, ms); }));
  const patience = opts.patienceMs ?? 90_000;
  const t0 = now();
  let last = '', changedAt = t0, waited = false;
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, reason: 'stopped', message: 'Stopped.' };
    const a = await ask()(set, rootfs.id, !opts.noBuild);
    if (a.state === 'ready' && a.layer && a.key) {
      const base = new URL(a.base || 'layers/sets/', defaultRootfsBase()).href;
      try {
        const result = await applyLayerInfo(fs, { ...a.layer, title: a.layer.title || set.join(', ') }, base, { packages: true, progress: opts.progress });
        await opts.afterApply?.();
        const n = result.installed.length;
        opts.progress?.(`${set.join(', ')}: ${n} ${n === 1 ? 'package' : 'packages'} installed in ${((now() - t0) / 1000).toFixed(1)} s (${result.paths} paths; files load on first use).`);
        // What a first run needs is fetched now, several at a time, so it does not ask for it file by file
        void warmChunks(a.layer.id, result.chunks).catch(() => {});
        return { ok: true, key: a.key, result, built: waited, waitedMs: now() - t0 };
      } catch (e) {
        return { ok: false, reason: 'apply', message: (e as Error)?.message ?? String(e) };
      }
    }
    if (a.state !== 'queued' && a.state !== 'building') {
      return { ok: false, reason: a.reason || (a.state === 'failed' ? 'failed' : 'no-server'), message: a.message || 'The server has no layer for this set.', ...(a.unknown ? { unknown: a.unknown } : {}) };
    }
    waited = true;
    const line = setProgressLine(a, set);
    if (line !== last) { last = line; changedAt = now(); opts.progress?.(line); }
    else if (now() - changedAt > patience) return { ok: false, reason: 'stalled', message: 'The build reported no progress.' };
    await sleep(1000);
  }
}

/**
 * What `toolchain install` does after a layer: the overlay's defaults for the
 * new programs, and the shell's list of Debian programs that replace a
 * builtin of the same name. `isCommand` says whether a name is a builtin.
 */
export async function afterLayer(fs: FileSystem, isCommand: (name: string) => boolean): Promise<string[]> {
  const overlay = await import('./overlay');
  await overlay.enableDebianShadows(fs, isCommand);
  const changed = await overlay.applyDefaults(fs);
  await overlay.refreshShadows(fs);
  return changed;
}

/** The names of `names` that dpkg does not have installed. */
export async function missingPackages(fs: FileSystem, names: string[]): Promise<string[]> {
  const status = String(await fs.readFile('/var/lib/dpkg/status', 'utf8').catch(() => ''));
  const have = new Set<string>();
  for (const stanza of status.split(/\n\n+/)) {
    const name = /^Package: (\S+)$/m.exec(stanza)?.[1];
    if (name && /^Status: .* installed$/m.test(stanza)) have.add(name);
  }
  return names.filter((n) => !have.has(n));
}

const PLAIN_FLAGS = new Set(['-y', '--yes', '--assume-yes', '-q', '-qq', '--quiet', '--no-install-recommends', '-V', '--verbose-versions']);

/**
 * The package names of an `apt install` a layer can do, or null when the
 * command asks for something only apt does: a version (`pkg=1.2`), a release
 * (`pkg/stable`, `-t`), a file, a removal (`pkg-`), a simulation, an option
 * that changes what is installed.
 */
export function plainInstall(args: string[]): string[] | null {
  let seen = false;
  const names: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) { if (!PLAIN_FLAGS.has(a)) return null; continue; }
    if (!seen) { if (a !== 'install') return null; seen = true; continue; }
    if (!PACKAGE_NAME.test(a) || a.endsWith('-')) return null;
    names.push(a);
  }
  return seen && names.length ? names : null;
}
