/**
 * Worker side of the postgres service: Engine (engine.ts) behind messages,
 * so a query never holds the page. Requests are answered in the order they
 * arrive; byte arrays are transferred, not copied.
 */
import { Engine, type Changes } from './engine';
import pgliteWasm from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm?url';
import initdbWasm from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm?url';
import pgliteData from '../../node_modules/@electric-sql/pglite/dist/pglite.data?url';

const at = (u: string) => new URL(u, self.location.href).href;
const engine = new Engine({ pglite: at(pgliteWasm), initdb: at(initdbWasm), data: at(pgliteData) });

interface Request { id: number; op: 'open' | 'raw' | 'copyIn' | 'dump' | 'changes' | 'use' | 'close'; args: unknown[] }

function buffersOf(value: unknown): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (b: Uint8Array | null) => { if (b && b.byteLength && b.buffer instanceof ArrayBuffer) out.add(b.buffer); };
  if (value instanceof Uint8Array) add(value);
  else if (value && Array.isArray((value as Changes).files)) for (const [, bytes] of (value as Changes).files) add(bytes);
  return [...out];
}

let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<Request>) => {
  const { id, op, args } = ev.data;
  chain = chain.then(async () => {
    try {
      const value = await (engine[op] as (...a: unknown[]) => Promise<unknown>)(...args);
      (self as unknown as Worker).postMessage({ id, value }, buffersOf(value));
    } catch (e) {
      (self as unknown as Worker).postMessage({ id, error: (e as Error)?.message ?? String(e) });
    }
  });
};
