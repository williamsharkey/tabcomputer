/**
 * Persisted hot-swaps (docs/HOTSWAP.md): `hotswap confirm --persist` saves
 * the swap's bundle in IndexedDB, and boot re-applies it, but only on the
 * build it was made for: a new deploy (a different __BUILD_SHA__ or build
 * number) discards it. Safe mode and ?hotswap=0 skip it.
 */
import buildNumber from '../../build-number.txt?raw';
import { evaluateBundle, hotswap, type SwapRecord } from './swap';
import { sha256Hex } from './build';

export interface PersistedSwap {
  files: string[];
  label: string;
  code: string;
  hash: string;
  build: string;
  savedAt: number;
}

const DB = 'tabcomputer-hotswap';
const STORE = 'swaps';
const KEY = 'stack';
/** localStorage: there are persisted swaps (boot skips opening IndexedDB without it) */
export const FLAG = 'tabcomputer-hotswap-persisted';

export function buildId(): string {
  let sha = '';
  try { sha = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : ''; } catch { /* vitest */ }
  return `${sha}#${String(buildNumber).trim()}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

function setFlag(on: boolean): void {
  try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch { /* no storage */ }
}

export async function loadPersisted(): Promise<PersistedSwap[]> {
  return ((await tx<PersistedSwap[]>('readonly', (s) => s.get(KEY))) ?? []) as PersistedSwap[];
}

async function savePersisted(list: PersistedSwap[]): Promise<void> {
  await tx('readwrite', (s) => { if (list.length) s.put(list, KEY); else s.delete(KEY); });
  setFlag(list.length > 0);
}

/** Persist confirmed swaps (in stack order), replacing what was saved */
export async function persistSwaps(records: SwapRecord[], build = buildId()): Promise<PersistedSwap[]> {
  const list = records.filter((r) => r.confirmed && r.code).map((r) => ({
    files: r.files, label: r.label, code: r.code, hash: r.hash, build, savedAt: Date.now(),
  }));
  await savePersisted(list);
  return list;
}

export async function clearPersisted(): Promise<void> {
  await savePersisted([]);
}

/**
 * Boot: re-apply persisted swaps made for this build; drop them if the build
 * changed. Returns lines for the console.
 */
export async function restorePersisted(build = buildId()): Promise<string[]> {
  let flag: string | null = null;
  try { flag = localStorage.getItem(FLAG); } catch { /* no storage */ }
  if (!flag) return [];
  const list = await loadPersisted();
  if (list.some((p) => p.build !== build)) {
    await clearPersisted();
    return [`hotswap: discarded ${list.length} persisted swap(s) made for another build`];
  }
  const out: string[] = [];
  for (const p of list) {
    if (await sha256Hex(p.code) !== p.hash) { out.push(`hotswap: skipped ${p.label}: its bundle doesn't match its hash`); continue; }
    const modules = await evaluateBundle(p.code);
    const rec = hotswap.apply(modules, { label: p.label, files: p.files, code: p.code, hash: p.hash, confirmed: true });
    rec.persisted = true;
    out.push(`hotswap: re-applied #${rec.id} ${p.label} (persisted ${new Date(p.savedAt).toISOString()})`);
  }
  return out;
}
