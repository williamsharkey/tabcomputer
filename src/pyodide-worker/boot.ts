/**
 * What the page needs to know about Pyodide as a kernel guest before it
 * loads any of it: whether it can run here (a blocking channel and a way to
 * make the Worker). host.ts and the guest's Worker load on first use.
 */
import { canBlock } from '../kernel/channel';
import type { GuestWorker } from '../kernel/worker-host';

let factory: (() => GuestWorker) | null = null;

/** Tests set how a guest worker is made; null restores the default */
export function setPyodideWorkerFactory(f: (() => GuestWorker) | null): void { factory = f; }
export function pyodideWorkerFactory(): (() => GuestWorker) | null { return factory; }

/** Whether Pyodide can run as a kernel process on this page */
export function pyodideWorkerMode(): boolean {
  if (canBlock() !== 'sab') return false;
  return !!factory || (typeof Worker !== 'undefined' && typeof window !== 'undefined');
}
