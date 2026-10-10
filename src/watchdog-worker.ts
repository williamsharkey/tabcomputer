/**
 * The watchdog's worker (started by src/watchdog.ts): runs WatchdogHost off the
 * page's main thread. Saves the wedge record to IndexedDB and hosts the remote
 * relay; see src/watchdog-host.ts.
 */
import { WatchdogHost, type ToWorker, type WedgeRecordOut } from './watchdog-host';

export const WATCHDOG_IDB = 'tabcomputer-watchdog';

let db: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(WATCHDOG_IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function saveWedge(v: WedgeRecordOut | null): Promise<void> {
  try {
    const tx = (await open()).transaction('kv', 'readwrite');
    if (v === null) tx.objectStore('kv').delete('wedge');
    else tx.objectStore('kv').put(v, 'wedge');
  } catch { /* storage unavailable */ }
}

// (no `webworker` lib reference: it would change the DOM types of the whole program)
const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null };
const host = new WatchdogHost({ post: (m) => scope.postMessage(m), saveWedge: (v) => { void saveWedge(v); } });
scope.onmessage = (e: MessageEvent<ToWorker>) => host.onMain(e.data);
setInterval(() => host.tick(), 500);
