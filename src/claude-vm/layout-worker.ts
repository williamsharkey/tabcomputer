/**
 * Claude Code's modules transformed off the page (vm-transform.ts
 * transformModules): each batch's sources in, their code out (transferred).
 */
import { vmModuleTransform, type LayoutBatch, type LayoutDone } from './vm-transform';

const ready = vmModuleTransform();
const dec = new TextDecoder();
const enc = new TextEncoder();

self.onmessage = async (e: MessageEvent<LayoutBatch>) => {
  const { id, dir, sources } = e.data;
  try {
    const toRun = await ready;
    const code = sources.map((s) => enc.encode(toRun(dec.decode(s), dir)));
    (self as unknown as Worker).postMessage({ id, code } satisfies LayoutDone, code.map((c) => c.buffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) } satisfies LayoutDone);
  }
};
