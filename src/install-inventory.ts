/**
 * What this machine has installed, noted outside the filesystem (tabcomputer#71).
 *
 * When the browser deletes the filesystem's IndexedDB (eviction, "Clear site
 * data"), the next load starts from an empty disk and nothing on it says what
 * was there. localStorage often survives (it is how FileSystem knows a volume
 * was lost: its `tabcomputer-fs-volume` hint), so a short list is kept there:
 * the pkg packages, Debian, the toolchain layers, native Claude Code, and
 * whether Claude was signed in. Names only, never a value.
 *
 * On the load after a loss the list is set aside (`LOST_KEY`) and the page
 * offers to install what is missing again (src/storage-lost.ts; `doctor`
 * prints the commands). It stays until everything is back, or the person
 * dismisses it. When localStorage was cleared too there is no list and no
 * offer: its absence proves nothing.
 */
import type { FileSystem } from './filesystem';

export const INVENTORY_KEY = 'tabcomputer-installed';
export const LOST_KEY = 'tabcomputer-installed-lost';

const PKG_STATUS = '/var/lib/pkg/status.json';
const ROOTFS_STATE = '/var/lib/shiro/rootfs.json';
const LAYERS_STATE = '/var/lib/shiro/layers.json';
const CLAUDE_NATIVE = '/var/lib/tabcomputer/claude-native.json';
const CLAUDE_CREDENTIALS = '/home/user/.claude/.credentials.json';
/** A change to one of these is a change to the list */
const WATCHED = [PKG_STATUS, ROOTFS_STATE, LAYERS_STATE, CLAUDE_NATIVE, CLAUDE_CREDENTIALS];

export interface Inventory {
  /** The filesystem volume it describes (FileSystem.volumeId) */
  volume: string;
  at: number;
  /** pkg packages (/var/lib/pkg/status.json) */
  pkg: string[];
  debian: boolean;
  /** Applied toolchain layers (toolchain install) */
  toolchains: string[];
  /** Native Claude Code (claude install) */
  claude: boolean;
  /** Sign-ins kept in files, by name: 'claude' */
  signins: string[];
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type InventoryFs = Pick<FileSystem, 'readFile' | 'exists' | 'volumeId' | 'storageLost' | 'previousVolumeLost' | 'onChange'>;

/** Names go into a command line: only what a package or a toolchain can be called */
const NAME = /^[a-z0-9][a-z0-9+._-]{0,63}$/;
const names = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((n): n is string => typeof n === 'string' && NAME.test(n)))].sort() : [];

function localStore(): Store | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

async function jsonKeys(fs: InventoryFs, path: string): Promise<string[]> {
  try {
    const o = JSON.parse(await fs.readFile(path, 'utf8') as string);
    return o && typeof o === 'object' ? Object.keys(o) : [];
  } catch { return []; }
}

/**
 * The toolchain layers among the applied layers. A package set's layer
 * (`kind: 'packages'`, src/debian/package-sets.ts) is not listed: the app
 * that needs it installs it again by itself, and `toolchain install` has no
 * name for it.
 */
async function toolchainLayers(fs: InventoryFs): Promise<string[]> {
  try {
    const o = JSON.parse(await fs.readFile(LAYERS_STATE, 'utf8') as string);
    return o && typeof o === 'object' ? Object.keys(o).filter((k) => o[k]?.kind !== 'packages') : [];
  } catch { return []; }
}

/** The list for this filesystem as it is now; null when its storage is lost (the files it would read are gone). */
export async function collectInventory(fs: InventoryFs): Promise<Inventory | null> {
  if (fs.storageLost || !fs.volumeId) return null;
  const [pkg, layers, native, debian, claudeSignin] = await Promise.all([
    jsonKeys(fs, PKG_STATUS), toolchainLayers(fs), jsonKeys(fs, CLAUDE_NATIVE),
    fs.exists(ROOTFS_STATE).catch(() => false), fs.exists(CLAUDE_CREDENTIALS).catch(() => false),
  ]);
  if (fs.storageLost) return null;
  return { volume: fs.volumeId, at: Date.now(), pkg: names(pkg), debian: !!debian, toolchains: names(layers), claude: native.length > 0, signins: claudeSignin ? ['claude'] : [] };
}

function read(store: Store | null, key: string): Inventory | null {
  try {
    const o = JSON.parse(store?.getItem(key) || 'null');
    if (!o || typeof o.volume !== 'string') return null;
    return { volume: o.volume, at: Number(o.at) || 0, pkg: names(o.pkg), debian: o.debian === true, toolchains: names(o.toolchains), claude: o.claude === true, signins: names(o.signins) };
  } catch { return null; }
}

/** The saved list for the current filesystem */
export const savedInventory = (store: Store | null = localStore()): Inventory | null => read(store, INVENTORY_KEY);
/** The list of a filesystem that was lost, while its offer stands */
export const lostInventory = (store: Store | null = localStore()): Inventory | null => read(store, LOST_KEY);
export function dismissLostInventory(store: Store | null = localStore()): void {
  try { store?.removeItem(LOST_KEY); } catch { /* no storage */ }
}

const has = (inv: Inventory): boolean => inv.pkg.length > 0 || inv.debian || inv.toolchains.length > 0 || inv.claude || inv.signins.length > 0;

/** What `lost` had that `now` does not. `skipPkg`: packages boot installs by itself (the profile's preinstall). */
export function missingFrom(lost: Inventory, now: Inventory | null, skipPkg: string[] = []): Inventory {
  const less = (a: string[], b: string[] = []) => a.filter((n) => !b.includes(n));
  return {
    volume: lost.volume, at: lost.at,
    pkg: less(less(lost.pkg, now?.pkg), skipPkg),
    debian: lost.debian && !now?.debian,
    toolchains: less(lost.toolchains, now?.toolchains),
    claude: lost.claude && !now?.claude,
    signins: less(lost.signins, now?.signins),
  };
}

/** The commands that install what is missing, in the order to run them */
export function reinstallCommands(missing: Inventory): string[] {
  const out: string[] = [];
  if (missing.pkg.length) out.push(`pkg install ${missing.pkg.join(' ')}`);
  // (toolchain install installs Debian first by itself)
  if (missing.debian && !missing.toolchains.length) out.push('debian install');
  if (missing.toolchains.length) out.push(`toolchain install ${missing.toolchains.join(' ')}`);
  if (missing.claude) out.push('claude install');
  return out;
}

/** The same, for a sentence */
export function describeMissing(missing: Inventory): string {
  const parts: string[] = [];
  if (missing.pkg.length) parts.push(`${missing.pkg.length === 1 ? 'the package' : 'the packages'} ${missing.pkg.join(', ')}`);
  if (missing.debian) parts.push('Debian');
  if (missing.toolchains.length) parts.push(`the ${missing.toolchains.join(', ')} ${missing.toolchains.length === 1 ? 'toolchain' : 'toolchains'}`);
  if (missing.claude) parts.push('Claude Code (claude install)');
  return parts.join('; ');
}

export interface ReinstallOffer {
  missing: Inventory;
  commands: string[];
  /** Sign-ins whose files were lost: nothing reinstalls those */
  signins: string[];
}

/**
 * What a lost filesystem had that this one lacks, or null when there is no
 * such list (or nothing is missing any more: the offer is then withdrawn).
 */
export async function reinstallOffer(fs: InventoryFs, opts: { store?: Store | null; skipPkg?: string[] } = {}): Promise<ReinstallOffer | null> {
  const store = opts.store === undefined ? localStore() : opts.store;
  const lost = lostInventory(store);
  if (!lost) return null;
  const now = await collectInventory(fs);
  // (storage lost again under this page: nothing can be installed until a reload)
  if (!now) return null;
  const missing = missingFrom(lost, now, opts.skipPkg);
  if (!has(missing)) { dismissLostInventory(store); return null; }
  return { missing, commands: reinstallCommands(missing), signins: missing.signins };
}

/**
 * Keep the list current: once soon after boot, then whenever one of the state
 * files changes. First, on the load after a loss, the lost filesystem's list
 * is set aside for the offer. Returns a function that stops it.
 */
export function trackInventory(fs: InventoryFs, opts: { store?: Store | null; firstAfterMs?: number; settleMs?: number } = {}): () => void {
  const store = opts.store === undefined ? localStore() : opts.store;
  if (!store) return () => {};
  const saved = savedInventory(store);
  if (saved && fs.previousVolumeLost && saved.volume === fs.previousVolumeLost && has(saved)) {
    // (lost again before the last offer was taken: both lists)
    const before = lostInventory(store);
    const both: Inventory = before ? {
      ...saved, pkg: names([...saved.pkg, ...before.pkg]), toolchains: names([...saved.toolchains, ...before.toolchains]),
      debian: saved.debian || before.debian, claude: saved.claude || before.claude, signins: names([...saved.signins, ...before.signins]),
    } : saved;
    try { store.setItem(LOST_KEY, JSON.stringify(both)); } catch { /* full */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    const inv = await collectInventory(fs).catch(() => null);
    // (null: storage is lost under this page; the last list is what the next load needs)
    if (!inv) return;
    try { store.setItem(INVENTORY_KEY, JSON.stringify(inv)); } catch { /* full */ }
  };
  const soon = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void save(), ms); };
  soon(opts.firstAfterMs ?? 5000);
  const off = fs.onChange((_event, path, newPath) => {
    if (WATCHED.includes(path) || (newPath !== undefined && WATCHED.includes(newPath))) soon(opts.settleMs ?? 2000);
  });
  return () => { clearTimeout(timer); off(); };
}
