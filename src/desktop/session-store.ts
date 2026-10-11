/**
 * Session restore's larger state (terminal scrollback) in IndexedDB, keyed by
 * a string: written asynchronously, so saving never blocks the page the way a
 * big localStorage write would. The small description of the windows stays in
 * localStorage (session.ts). `safe-mode reset-layout` deletes the database.
 */

export const SESSION_IDB = 'tabcomputer-session';

let db: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  return db ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(SESSION_IDB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Replace the whole set of entries (the saved session's): others are deleted. */
export async function putAll(entries: Map<string, string>): Promise<void> {
  const d = await open();
  if (!d) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = d.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const keys = store.getAllKeys();
      keys.onsuccess = () => { for (const k of keys.result) if (!entries.has(String(k))) store.delete(k); };
      for (const [k, v] of entries) store.put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch { resolve(); }
  });
}

export async function get(key: string): Promise<string | null> {
  const d = await open();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Forget everything (safe-mode reset-layout). */
export function clearAll(): Promise<void> {
  const close = db;
  db = null;
  return new Promise((resolve) => {
    void close?.then((d) => d?.close());
    try {
      const r = indexedDB.deleteDatabase(SESSION_IDB);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
