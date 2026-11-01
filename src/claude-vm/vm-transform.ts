/**
 * Each JS module of Claude Code's bundle as `claude --vm` runs it
 * (docs/CLAUDE_VM.md, extract.ts): Bun's names made node's, imports as live
 * bindings, node-compat's transforms. Pure string work, done once per layout,
 * in a worker of its own (layout-worker.ts) so the page keeps drawing: 2.1.316's
 * largest module alone is 5 MB, a task far longer than a frame.
 */
const BUNFS = '/$bunfs/root/';

/**
 * One extracted JS module's text with Bun's names made node's, before it
 * becomes CommonJS (liveModule, transformESModules): the bundle's paths, Bun's require (an
 * embedded asset gives its text or its path, by its loader: bun/index.ts),
 * and import.meta, which CommonJS doesn't have.
 */
export function adaptModule(source: string, dir: string): string {
  // (an import's specifier keeps Bun's name, which the loader maps to `dir` (module-store.ts):
  // 2.1.316 has ~540k of them, ~67 MB as full paths; every other mention becomes the path)
  const KEEP = '\u0000bunfs\u0000';
  let s = source.replace(/(\b(?:from|import)\s*\(?\s*)(["'])\/\$bunfs\/root\//g, (_, pre, q) => pre + q + KEEP);
  s = s.split(BUNFS).join(dir + '/').split(KEEP).join(BUNFS);
  s = s.replace(/\bimport\.meta\.require\b/g, 'Bun.__require(require)');
  s = s.replace(/\bimport\.meta\.(?:dirname|dir)\b/g, '__dirname');
  s = s.replace(/\bimport\.meta\.filename\b/g, '__filename');
  s = s.replace(/\bimport\.meta\.url\b/g, 'require("url").pathToFileURL(__filename).href');
  // (the first line stays first: `// @bun @bytecode` is a pragma comment)
  return 'var Bun = globalThis.Bun;\n' + s;
}

/**
 * One JS module of the bundle as it runs here (module-store.ts compiles it as a function
 * body): Bun's names node's (adaptModule), imports as live bindings (exact for Bun's
 * output: `unshadowed`; never settled, which is quadratic in a module's exports), then
 * node-compat's ES module and async-context transforms.
 */
export async function vmModuleTransform(): Promise<(source: string, dir: string) => string> {
  const [{ transformESModules }, { liveModule }, { carryAsyncContext, carriesAsyncContext }] = await Promise.all([
    import('../commands/jseval/module-transform'), import('../commands/jseval/esm-live'), import('../node-compat/async-context'),
  ]);
  return (source, dir) => {
    const code = liveModule(adaptModule(source, dir), { unshadowed: true, settle: false });
    return transformESModules(code, carriesAsyncContext(code) ? carryAsyncContext : undefined);
  };
}

/** What layout-worker.ts is sent: a batch of modules (their UTF-8 source), and what it answers (their code, UTF-8) */
export interface LayoutBatch { id: number; dir: string; sources: Uint8Array[] }
export interface LayoutDone { id: number; code?: Uint8Array[]; error?: string }

/** Sources per batch, about: progress shows, and no one message copies much */
const BATCH = 4 << 20;

/**
 * The modules' code, UTF-8, in their order: in a worker where the page has one, else here
 * a module at a time with the page's event loop turning every 50 ms. `progress` gets the
 * count done so far.
 */
export async function transformModules(dir: string, sources: Uint8Array[], progress: (done: number) => void = () => {}): Promise<Uint8Array[]> {
  const viaWorker = typeof Worker !== 'undefined' && typeof window !== 'undefined' ? await inWorker(dir, sources, progress).catch(() => null) : null;
  if (viaWorker) return viaWorker;
  const toRun = await vmModuleTransform();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  let slice = performance.now();
  for (const s of sources) {
    out.push(enc.encode(toRun(dec.decode(s), dir)));
    progress(out.length);
    if (performance.now() - slice > 50) { await new Promise((r) => setTimeout(r, 0)); slice = performance.now(); }
  }
  return out;
}

async function inWorker(dir: string, sources: Uint8Array[], progress: (done: number) => void): Promise<Uint8Array[]> {
  const worker = new Worker(new URL('./layout-worker.ts', import.meta.url), { type: 'module', name: 'claude-vm-layout' });
  try {
    const batches: Uint8Array[][] = [];
    let cur: Uint8Array[] = [];
    let size = 0;
    for (const s of sources) {
      cur.push(s);
      size += s.length;
      if (size >= BATCH) { batches.push(cur); cur = []; size = 0; }
    }
    if (cur.length) batches.push(cur);
    const results: Uint8Array[][] = new Array(batches.length);
    let done = 0;
    await new Promise<void>((resolve, reject) => {
      let left = batches.length;
      if (!left) resolve();
      worker.onerror = (e) => reject(new Error(e.message || 'the layout worker failed'));
      worker.onmessage = (e: MessageEvent<LayoutDone>) => {
        if (e.data.error || !e.data.code) { reject(new Error(e.data.error ?? 'the layout worker answered nothing')); return; }
        results[e.data.id] = e.data.code;
        done += e.data.code.length;
        progress(done);
        if (--left === 0) resolve();
      };
      // (copies: the sources are views of the downloaded or read binary)
      batches.forEach((b, id) => worker.postMessage({ id, dir, sources: b } satisfies LayoutBatch));
    });
    return results.flat();
  } finally {
    worker.terminate();
  }
}
