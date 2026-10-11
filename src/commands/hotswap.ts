import type { Command, CommandContext } from './index';
import { buildSwap } from '../hotswap/build';
import { evaluateBundle, hotswap, type ModuleReport, type SwapRecord } from '../hotswap/swap';

/**
 * hotswap: swap core modules (src/shell.ts, src/terminal.ts, src/kernel/...)
 * built from a checkout of tabcomputer's source into this running tab, with
 * an auto-revert unless confirmed (docs/HOTSWAP.md).
 */

const USAGE = `Usage: hotswap checkout [DIR] [--force]          this build's source, in DIR (~/tabcomputer)
       hotswap apply [--root DIR] [--ttl 90s | --no-ttl] [--fresh-state] FILE...
       hotswap build [--root DIR] FILE...   build and report, swap nothing
       hotswap confirm [--persist] [ID]     keep pending swaps (stop their TTL)
       hotswap revert [--all]               undo the newest swap (or all)
       hotswap status                       applied swaps, TTLs, what changed
       hotswap persisted [clear]            swaps re-applied at boot
       hotswap watch [--root DIR] [--ttl 90s | --no-ttl] [--debounce 150ms] [-d] [PATH...]
                                            swap each module under src/ as it's saved (-d: in the background)
       hotswap watch --wait [--timeout 30s] | --stop
                                            the background watcher's new results | stop it
       hotswap test [--root DIR] [-t RE] [-v] [--changed [--max N]] [SUITE...]
                                            run vitest suites from the checkout in this tab
                                            (--changed: the suites that import a changed file)
       hotswap diff [--stat] [FILE...]       changes since the checkout
       hotswap push BRANCH -m MSG [--repo OWNER/NAME]
                                            commit them on the build's commit, as a new GitHub branch

FILEs are paths in a checkout of tabcomputer's source (default root: the
nearest directory above the cwd with src/shell.ts). Classes exported by a
swapped file replace the methods of the live classes of the same name.
Registry commands they export (src/commands/*) are patched in place.
A swap reverts by itself when its TTL (default 90s) runs out unconfirmed.
`;

export const DEFAULT_TTL_MS = 90_000;

export function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Math.round(n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[(m[2] ?? 's') as 'ms' | 's' | 'm' | 'h']);
}

async function findRoot(ctx: CommandContext, start: string): Promise<string | null> {
  let dir = ctx.fs.resolvePath(start, ctx.cwd);
  for (;;) {
    try {
      await ctx.fs.stat(`${dir === '/' ? '' : dir}/src/shell.ts`);
      return dir;
    } catch { /* up */ }
    if (dir === '/') return null;
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
  }
}

function describe(report: ModuleReport[]): string {
  let out = '';
  for (const m of report) {
    if (!m.live) { out += `  ${m.module}: not loaded in the page, nothing swapped\n`; continue; }
    for (const c of m.classes) {
      if (!c.swapped && !c.errors.length) continue;
      const parts = [`${c.swapped} method(s) swapped`];
      if (c.changed.length) parts.push(`changed since the last swap: ${c.changed.join(', ')}`);
      if (c.added.length) parts.push(`added ${c.added.join(', ')}`);
      if (c.migrated) parts.push(`migrateFrom on ${c.migrated} instance(s)`);
      out += `  ${m.module}: ${c.name}: ${parts.join('; ')}\n`;
      for (const e of c.errors) out += `    error: ${e}\n`;
    }
    for (const c of m.commands) out += `  ${m.module}: command ${c.command}: ${c.changed.length ? `replaced ${c.changed.join(', ')}` : 'unchanged'}\n`;
    if (m.state.length) out += `  ${m.module}: shares the page's module state: ${m.state.join(', ')}\n`;
    if (m.hook) out += `  ${m.module}: ran __hotswap\n`;
    if (m.fixed.length) out += `  ${m.module}: not swapped (other modules keep the old ones): ${m.fixed.join(', ')}\n`;
  }
  return out;
}

function line(r: SwapRecord): string {
  const state = r.confirmed
    ? (r.persisted ? 'confirmed, persisted' : 'confirmed')
    : r.deadline ? `reverts in ${Math.max(0, Math.ceil((r.deadline - Date.now()) / 1000))}s unless confirmed` : 'unconfirmed, no TTL';
  return `#${r.id} ${r.label} (${state}, applied ${Math.round((Date.now() - r.appliedAt) / 1000)}s ago)`;
}

let notifierSet = false;
function ensureNotifier(): void {
  if (notifierSet) return;
  notifierSet = true;
  hotswap.onAutoRevert = (records, reason) => {
    const why = reason === 'wedge' ? 'the page froze after it was applied' : `#${records[records.length - 1].id} wasn't confirmed in time`;
    const msg = `hotswap: reverted ${records.map((r) => `#${r.id} ${r.label}`).join(', ')}: ${why}`;
    console.warn(msg);
    void import('../hotswap/watch').then(({ current }) => {
      if (current && records.some((r) => r === current.record)) { current.record = null; current.note(`\u21ba ${msg.slice(9)}`, false); }
    });
    import('../kernel/klog').then(({ klog, LOG_WARNING }) => klog.log(LOG_WARNING, msg)).catch(() => {});
  };
}

export const hotswapCmd: Command = {
  name: 'hotswap',
  description: 'Swap core modules built from a source checkout into this tab',
  async exec(ctx: CommandContext): Promise<number> {
    const args = [...ctx.args];
    const sub = args.shift();
    if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { ctx.stdout += USAGE; return sub ? 0 : 1; }
    ensureNotifier();

    if (sub === 'status') {
      const { current } = await import('../hotswap/watch');
      if (current?.running) ctx.stdout += `watching ${current.paths.join(' ')}: ${current.results.length} result(s)${current.results.length ? `, last: ${current.results[current.results.length - 1].line}` : ''}\n`;
      if (!hotswap.stack.length) { ctx.stdout += 'No swaps applied.\n'; return 0; }
      for (const r of hotswap.stack) ctx.stdout += line(r) + '\n' + describe(r.report);
      return 0;
    }
    if (sub === 'watch') return watch(ctx, args);

    if (sub === 'confirm') {
      const persist = args.includes('--persist');
      const idArg = args.find((a) => !a.startsWith('-'));
      const done = hotswap.confirm(idArg ? parseInt(idArg.replace(/^#/, ''), 10) : undefined);
      for (const r of done) ctx.stdout += `confirmed #${r.id} ${r.label}\n`;
      if (!done.length && !persist) ctx.stdout += 'Nothing pending.\n';
      if (persist) {
        const { persistSwaps } = await import('../hotswap/persist');
        const saved = await persistSwaps(hotswap.stack);
        for (const r of hotswap.stack) if (r.confirmed && r.code) r.persisted = true;
        ctx.stdout += `persisted ${saved.length} swap(s); boot re-applies them on this build (safe mode and ?hotswap=0 skip them)\n`;
      }
      return 0;
    }

    if (sub === 'revert') {
      const undone = hotswap.revert(args.includes('--all'));
      if (!undone.length) { ctx.stdout += 'No swaps applied.\n'; return 0; }
      for (const r of undone) ctx.stdout += `reverted #${r.id} ${r.label}\n`;
      if (undone.some((r) => r.persisted)) {
        const { persistSwaps } = await import('../hotswap/persist');
        await persistSwaps(hotswap.stack.filter((r) => r.persisted));
        ctx.stdout += 'updated the persisted swaps\n';
      }
      return 0;
    }

    if (sub === 'persisted') {
      const { loadPersisted, clearPersisted, buildId } = await import('../hotswap/persist');
      if (args[0] === 'clear') { await clearPersisted(); ctx.stdout += 'cleared persisted swaps\n'; return 0; }
      const list = await loadPersisted();
      if (!list.length) { ctx.stdout += 'No persisted swaps.\n'; return 0; }
      const build = buildId();
      for (const p of list) ctx.stdout += `${p.label} (${p.code.length} bytes, saved ${new Date(p.savedAt).toISOString()}${p.build === build ? '' : ', another build: discarded at next boot'})\n`;
      return 0;
    }

    if (sub === 'test') return runTests(ctx, args);
    if (sub === 'checkout') return checkout(ctx, args);
    if (sub === 'diff') return diff(ctx, args);
    if (sub === 'push') return push(ctx, args);

    if (sub !== 'apply' && sub !== 'build') { ctx.stderr += `hotswap: unknown subcommand '${sub}'\n${USAGE}`; return 2; }

    let root: string | null = null;
    let ttl: number | null = DEFAULT_TTL_MS;
    let sourcemap = false;
    let freshState = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--root') root = ctx.fs.resolvePath(args[++i] ?? '.', ctx.cwd);
      else if (a.startsWith('--root=')) root = ctx.fs.resolvePath(a.slice(7), ctx.cwd);
      else if (a === '--no-ttl') ttl = null;
      else if (a === '--ttl' || a.startsWith('--ttl=')) {
        const v = a === '--ttl' ? args[++i] : a.slice(6);
        ttl = parseDuration(v ?? '');
        if (ttl === null) { ctx.stderr += `hotswap: bad --ttl '${v}' (90s, 5m, 500ms)\n`; return 2; }
      } else if (a === '--sourcemap') sourcemap = true;
      else if (a === '--fresh-state') freshState = true;
      else if (a.startsWith('-')) { ctx.stderr += `hotswap: unknown option ${a}\n`; return 2; }
      else files.push(a);
    }
    if (!files.length) { ctx.stderr += USAGE; return 2; }
    root ??= await findRoot(ctx, ctx.cwd);
    if (!root) { ctx.stderr += 'hotswap: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n'; return 1; }
    const abs = files.map((f) => ctx.fs.resolvePath(f, ctx.cwd));

    let built;
    try {
      built = await buildSwap({ readFile: async (p) => ctx.fs.readFile(p, 'utf8') as Promise<string> }, { root, files: abs, sourcemap, freshState });
    } catch (e: any) {
      const errs = e?.errors as { text: string; location?: { file: string; line: number; column: number } }[] | undefined;
      if (errs?.length) for (const x of errs) ctx.stderr += `hotswap: ${x.location ? `${x.location.file}:${x.location.line}:${x.location.column}: ` : ''}${x.text}\n`;
      else ctx.stderr += `hotswap: build failed: ${e?.message ?? e}\n`;
      return 1;
    }
    for (const w of built.warnings) ctx.stderr += `hotswap: warning: ${w}\n`;
    ctx.stdout += `built ${built.keys.join(' ')} (${built.code.length} bytes)\n`;
    if (sub === 'build') return 0;

    let rec: SwapRecord;
    try {
      const modules = await evaluateBundle(built.code);
      rec = hotswap.apply(modules, { files: built.keys, code: built.code, hash: built.hash, ttlMs: ttl });
    } catch (e: any) {
      ctx.stderr += `hotswap: swap failed, nothing changed: ${e?.stack ?? e}\n`;
      return 1;
    }
    ctx.stdout += `applied ${line(rec)}\n` + describe(rec.report);
    if (!rec.confirmed && rec.deadline) ctx.stdout += `run 'hotswap confirm' to keep it, 'hotswap revert' to undo it now\n`;
    return 0;
  },
};

let waitCursor = 0;

async function watch(ctx: CommandContext, args: string[]): Promise<number> {
  const W = await import('../hotswap/watch');
  if (args.includes('--stop')) {
    if (!W.current) { ctx.stdout += 'No watcher running.\n'; return 0; }
    W.current.stop();
    ctx.stdout += `stopped watching ${W.current.paths.join(' ')}\n`;
    W.setCurrent(null);
    return 0;
  }
  if (args.includes('--wait')) {
    const w = W.current;
    if (!w) { ctx.stderr += "hotswap watch --wait: no watcher running (start one with 'hotswap watch -d')\n"; return 1; }
    const ti = args.indexOf('--timeout');
    const timeout = ti >= 0 ? parseDuration(args[ti + 1] ?? '') ?? 30_000 : 30_000;
    // A save the shell made just now has already been noted (change events are synchronous)
    await Promise.race([w.idle(), new Promise((r) => setTimeout(r, timeout))]);
    const fresh = w.results.filter((r) => r.n > waitCursor);
    if (w.results.length) waitCursor = w.results[w.results.length - 1].n;
    if (!fresh.length) { ctx.stdout += `no swap since the last --wait (watching ${w.paths.join(' ')})\n`; return 0; }
    for (const r of fresh) ctx.stdout += r.line + '\n' + r.warnings.map((x) => `  warning: ${x}\n`).join('');
    return fresh[fresh.length - 1].ok ? 0 : 1;
  }

  let root: string | null = null;
  let ttl: number | null = DEFAULT_TTL_MS;
  let debounce: number | undefined;
  let detach = false;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = ctx.fs.resolvePath(args[++i] ?? '.', ctx.cwd);
    else if (a === '--no-ttl') ttl = null;
    else if (a === '--ttl' || a === '--debounce') {
      const v = parseDuration(args[++i] ?? '');
      if (v === null) { ctx.stderr += `hotswap watch: bad ${a} '${args[i]}'\n`; return 2; }
      if (a === '--ttl') ttl = v; else debounce = v;
    } else if (a === '-d' || a === '--detach') detach = true;
    else if (a.startsWith('-')) { ctx.stderr += `hotswap watch: unknown option ${a}\n`; return 2; }
    else paths.push(ctx.fs.resolvePath(a, ctx.cwd));
  }
  root ??= await findRoot(ctx, paths[0] ?? ctx.cwd);
  if (!root) { ctx.stderr += 'hotswap watch: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n'; return 1; }
  const checkout = root;
  if (W.current) {
    W.current.stop();
    ctx.stdout += `stopped the previous watcher (${W.current.paths.join(' ')})\n`;
  }
  const w = new W.HotswapWatcher({
    fs: ctx.fs,
    manager: hotswap,
    build: (files) => buildSwap({ readFile: async (p) => ctx.fs.readFile(p, 'utf8') as Promise<string> }, { root: checkout, files }),
    evaluate: evaluateBundle,
  }, { root: checkout, paths, ttlMs: ttl, debounceMs: debounce });
  w.start();
  W.setCurrent(w);
  waitCursor = 0;
  const what = `watching ${w.paths.join(' ')}: each save is swapped in${ttl ? ` and reverts ${Math.round(ttl / 1000)}s after the last save unless 'hotswap confirm'` : ''}`;
  if (detach) {
    ctx.stdout += `${what}\n'hotswap watch --wait' prints what each save did; 'hotswap watch --stop' stops it\n`;
    return 0;
  }
  // In the foreground until Ctrl-C (or kill)
  const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
  out(`${what}; Ctrl-C stops\n`);
  const print = (r: { line: string; warnings: string[] }) => out(r.line + '\n' + r.warnings.map((x) => `  warning: ${x}\n`).join(''));
  w.listeners.add(print);
  const signal: AbortSignal | undefined = ctx.shell?.abortController?.signal;
  await new Promise<void>((resolve) => {
    if (!signal || signal.aborted) { resolve(); return; }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  w.listeners.delete(print);
  w.stop();
  if (W.current === w) W.setCurrent(null);
  out('stopped watching\n');
  return 130;
}

/** The suite files: paths, or names under tests/tests/shiro-vitest ('shell-posix') */
async function suitePath(ctx: CommandContext, root: string, arg: string): Promise<string | null> {
  const tries = [ctx.fs.resolvePath(arg, ctx.cwd)];
  for (const name of [arg, `${arg}.test.ts`]) tries.push(`${root}/tests/tests/shiro-vitest/${name}`, `${root}/${name}`);
  for (const p of tries) {
    try { if ((await ctx.fs.stat(p)).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

const SUITE_DIR = 'tests/tests/shiro-vitest';
/** Imports the tab can't give a suite (test-runner.ts): such suites run last */
const NODE_ONLY = /^(node:)?(child_process|worker_threads|http|https|net|module|cluster|vm)$|^esbuild$|^playwright/;

/**
 * The suites to run for changed files (paths relative to the checkout): those
 * that are a changed file, import one directly (`@shiro/x` is src/x, or a
 * relative path), or are named like one or its directory (src/commands/awk.ts:
 * awk-conformance; src/hotswap/watch.ts: hotswap). With more than `max` (0: no
 * limit), suites that import what the tab can't give them (node:child_process,
 * worker_threads, esbuild) go last, then the named ones come first, then those
 * with the fewest imports, the most focused.
 */
export function suitesForChanges(files: string[], suites: { path: string; text: string }[], max = 20): { all: string[]; run: string[] } {
  const bare = (p: string) => p.replace(/\.(ts|tsx|js|mjs)$/, '').replace(/\/index$/, '');
  const changed = new Set(files.map(bare));
  // Names a suite may be called by: the file's (awk.ts: awk-conformance) and its directory's (hotswap/x.ts: hotswap)
  const GENERIC = new Set(['src', 'commands', 'tests', 'shiro-vitest', 'utils', 'index']);
  const stems = [...new Set(files.flatMap((f) => bare(f).toLowerCase().split('/').slice(-2)).filter((n) => !GENERIC.has(n)))];
  const hits: { path: string; named: boolean; nodeOnly: boolean; imports: number }[] = [];
  for (const s of suites) {
    const dir = s.path.slice(0, s.path.lastIndexOf('/'));
    const specs = [...s.text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm)].map((m) => m[2]);
    const targets = specs.map((sp) => {
      if (sp.startsWith('@shiro/')) return `src/${sp.slice(7)}`;
      if (!sp.startsWith('.')) return null;
      const out: string[] = [];
      for (const part of `${dir}/${sp}`.split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
      return out.join('/');
    }).filter((t): t is string => !!t).map((t) => bare(t.split('?')[0]));
    const name = s.path.split('/').pop()!.replace(/\.test\.ts$/, '').toLowerCase();
    const named = stems.some((st) => name === st || name.startsWith(st + '-') || name.endsWith('-' + st));
    if (!named && !changed.has(bare(s.path)) && !targets.some((t) => changed.has(t))) continue;
    const nodeOnly = specs.some((sp) => NODE_ONLY.test(sp));
    hits.push({ path: s.path, named, nodeOnly, imports: targets.length });
  }
  const ranked = [...hits].sort((a, b) => Number(a.nodeOnly) - Number(b.nodeOnly) || Number(b.named) - Number(a.named) || a.imports - b.imports || a.path.localeCompare(b.path));
  return { all: hits.map((h) => h.path), run: (max > 0 ? ranked.slice(0, max) : ranked).map((h) => h.path) };
}

async function runTests(ctx: CommandContext, args: string[]): Promise<number> {
  let root: string | null = null;
  let changed = false;
  let max = 20;
  let filter: RegExp | undefined;
  let verbose = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = ctx.fs.resolvePath(args[++i] ?? '.', ctx.cwd);
    else if (a === '-t' || a === '--testNamePattern') {
      try { filter = new RegExp(args[++i] ?? ''); } catch (e: any) { ctx.stderr += `hotswap test: bad -t: ${e.message}\n`; return 2; }
    } else if (a === '-v' || a === '--verbose') verbose = true;
    else if (a === '--changed') changed = true;
    else if (a === '--max') { max = parseInt(args[++i] ?? '', 10); if (!(max >= 0)) { ctx.stderr += 'hotswap test: bad --max\n'; return 2; } }
    else if (a.startsWith('-')) { ctx.stderr += `hotswap test: unknown option ${a}\n`; return 2; }
    else names.push(a);
  }
  if (!names.length && !changed) { ctx.stderr += 'Usage: hotswap test [--root DIR] [-t RE] [-v] [--changed [--max N]] [SUITE...]\n'; return 2; }
  root ??= await findRoot(ctx, ctx.cwd);
  if (!root) { ctx.stderr += 'hotswap test: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n'; return 1; }
  const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
  if (changed) {
    const { sourceChanges } = await import('../hotswap/source');
    let changes;
    try { changes = await sourceChanges(ctx.fs as any, root); } catch (e: any) { ctx.stderr += `hotswap test --changed: ${e?.message ?? e} (a checkout from 'hotswap checkout' has a manifest)\n`; return 1; }
    const files = changes.filter((c) => c.status !== 'D').map((c) => c.path);
    const suites: { path: string; text: string }[] = [];
    for (const n of (await ctx.fs.readdir(`${root}/${SUITE_DIR}`).catch(() => [] as string[])).sort()) {
      if (!n.endsWith('.test.ts')) continue;
      try { suites.push({ path: `${SUITE_DIR}/${n}`, text: await ctx.fs.readFile(`${root}/${SUITE_DIR}/${n}`, 'utf8') as string }); } catch { /* unreadable */ }
    }
    const pick = suitesForChanges(files, suites, max);
    if (!files.length) out('no changes since the checkout\n');
    else if (!pick.all.length) out(`no suite imports ${files.join(' ')}\n`);
    else out(`${pick.all.length} suite(s) import ${files.join(' ')}${pick.run.length < pick.all.length ? `; running ${pick.run.length} (--max ${max}; --max 0 runs all)` : ''}\n`);
    names.push(...pick.run);
    if (!names.length) return 0;
  }
  const { buildTest } = await import('../hotswap/build');
  const { runTestBundle } = await import('../hotswap/test-runner');
  // The suites' node:fs: the checkout as it is now, read once; their writes stay in memory
  const { snapshotTree } = await import('../hotswap/test-fs');
  const t0 = performance.now();
  const files = await snapshotTree(ctx.fs as any, root);
  if (verbose) out(` (read ${files.size} files of ${root} for node:fs in ${Math.round(performance.now() - t0)} ms)\n`);
  let failed = 0, passed = 0, skipped = 0;
  for (const name of names) {
    const file = await suitePath(ctx, root, name);
    if (!file) { ctx.stderr += `hotswap test: no suite ${name}\n`; failed++; continue; }
    const rel = file.startsWith(root + '/') ? file.slice(root.length + 1) : file;
    let code: string;
    try {
      code = (await buildTest({ readFile: async (p) => ctx.fs.readFile(p, 'utf8') as Promise<string> }, { root, file })).code;
    } catch (e: any) {
      const errs = e?.errors as { text: string; location?: { file: string; line: number } }[] | undefined;
      out(` FAIL ${rel}: build failed\n`);
      if (errs?.length) for (const x of errs.slice(0, 10)) out(`   ${x.location ? `${x.location.file}:${x.location.line}: ` : ''}${x.text}\n`);
      else out(`   ${e?.message ?? e}\n`);
      failed++;
      continue;
    }
    const sum = await runTestBundle(code, {
      filter,
      files,
      cwd: ctx.cwd,
      onResult: (r) => {
        if (r.status === 'fail') out(` \u00d7 ${r.name}\n${(r.error ?? '').split('\n').map((l) => `     ${l}`).join('\n')}\n`);
        else if (verbose) out(` ${r.status === 'pass' ? '\u2713' : '-'} ${r.name}${r.status === 'pass' ? ` (${r.ms}ms)` : ` (${r.status})`}\n`);
      },
    });
    for (const e of sum.errors) out(` \u00d7 ${e.split('\n').join('\n     ')}\n`);
    out(` ${sum.failed ? 'FAIL' : 'PASS'} ${rel}: ${sum.passed} passed${sum.failed ? `, ${sum.failed} failed` : ''}${sum.skipped ? `, ${sum.skipped} skipped` : ''} (${(sum.ms / 1000).toFixed(1)}s)\n`);
    failed += sum.failed; passed += sum.passed; skipped += sum.skipped;
  }
  if (names.length > 1) out(`Tests: ${passed} passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}\n`);
  return failed ? 1 : 0;
}

const home = (ctx: CommandContext) => ctx.env['HOME'] || '/home/user';

async function checkout(ctx: CommandContext, args: string[]): Promise<number> {
  const force = args.includes('--force');
  const dirArg = args.find((a) => !a.startsWith('-'));
  const dir = ctx.fs.resolvePath(dirArg ? dirArg.replace(/^~(?=\/|$)/, home(ctx)) : `${home(ctx)}/tabcomputer`, ctx.cwd);
  const { checkoutSource, readManifest } = await import('../hotswap/source');
  // Tabs from before the default was ~/tabcomputer have their checkout in ~/shiro: keep using it
  if (!dirArg && !force) {
    const old = `${home(ctx)}/shiro`;
    const exists = async (p: string) => { try { await ctx.fs.stat(p); return true; } catch { return false; } };
    if (!(await exists(dir)) && await exists(`${old}/.hotswap-source.json`)) {
      const m = await readManifest(ctx.fs as any, old).catch(() => null);
      ctx.stdout += `using the existing checkout in ${old}${m ? ` (build ${m.build})` : ''}; 'hotswap checkout ~/tabcomputer' makes a new one\n`;
      return 0;
    }
  }
  try {
    const m = await checkoutSource(ctx.fs as any, dir, { force });
    ctx.stdout += `checked out build ${m.build} (${m.sha ? m.sha.slice(0, 12) : 'no commit'}), ${Object.keys(m.files).length} files, in ${dir}\n`;
    ctx.stdout += `edit, then: cd ${dir} && hotswap apply src/shell.ts\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `hotswap checkout: ${e?.message ?? e}\n`;
    return 1;
  }
}

async function checkoutRoot(ctx: CommandContext, args: string[]): Promise<string | null> {
  const i = args.indexOf('--root');
  if (i >= 0) { const r = ctx.fs.resolvePath(args[i + 1] ?? '.', ctx.cwd); args.splice(i, 2); return r; }
  const root = await findRoot(ctx, ctx.cwd);
  if (!root) ctx.stderr += 'hotswap: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n';
  return root;
}

async function diff(ctx: CommandContext, args: string[]): Promise<number> {
  const root = await checkoutRoot(ctx, args);
  if (!root) return 1;
  const stat = args.includes('--stat');
  const only = args.filter((a) => !a.startsWith('-')).map((a) => {
    const abs = ctx.fs.resolvePath(a, ctx.cwd);
    return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : a;
  });
  const { sourceChanges, baseText } = await import('../hotswap/source');
  let changes;
  try { changes = await sourceChanges(ctx.fs as any, root); } catch (e: any) { ctx.stderr += `hotswap diff: ${e?.message ?? e}\n`; return 1; }
  if (only.length) changes = changes.filter((c) => only.includes(c.path));
  if (!changes.length) { ctx.stdout += 'No changes since the checkout.\n'; return 0; }
  if (stat) { for (const c of changes) ctx.stdout += `${c.status} ${c.path}\n`; return 0; }
  const tmp = `/tmp/hotswap-diff-${Date.now().toString(36)}`;
  await ctx.fs.mkdir(tmp, { recursive: true });
  for (const c of changes) {
    const a = c.status === 'A' ? '/dev/null' : `${tmp}/a`;
    const b = c.status === 'D' ? '/dev/null' : `${root}/${c.path}`;
    if (c.status !== 'A') await ctx.fs.writeFile(`${tmp}/a`, (await baseText(ctx.fs as any, root, c.path)) ?? '');
    let out = '';
    await ctx.shell.execute(`diff -u --label 'a/${c.path}' --label 'b/${c.path}' '${a}' '${b}'`, (x) => { out += x; }, (x) => { out += x; });
    ctx.stdout += out.replace(/\r\n/g, '\n');
  }
  await ctx.fs.rm(tmp, { recursive: true }).catch(() => {});
  return 0;
}

async function push(ctx: CommandContext, args: string[]): Promise<number> {
  const root = await checkoutRoot(ctx, args);
  if (!root) return 1;
  let message = '', repo = 'williamsharkey/tabcomputer', branch = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' || a === '--message') message = args[++i] ?? '';
    else if (a === '--repo' || a === '-R') repo = args[++i] ?? repo;
    else if (a.startsWith('-')) { ctx.stderr += `hotswap push: unknown option ${a}\n`; return 2; }
    else branch = a;
  }
  if (!branch || !message) { ctx.stderr += 'Usage: hotswap push BRANCH -m MSG [--repo OWNER/NAME]\n'; return 2; }
  const { getToken, ghApi } = await import('./gh');
  const token = getToken(ctx);
  if (!token) { ctx.stderr += 'hotswap push: not signed in to GitHub: run gh auth login\n'; return 1; }
  const { pushSource } = await import('../hotswap/source');
  let author: { name: string; email: string } | undefined;
  try {
    const cfg = await ctx.fs.readFile(`${home(ctx)}/.gitconfig`, 'utf8') as string;
    const name = /^\s*name\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim(), email = /^\s*email\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim();
    if (name && email) author = { name, email };
  } catch { /* GitHub uses the token's account */ }
  try {
    const r = await pushSource(ctx.fs as any, root, (method, path, body) => ghApi(token, method, path, body), { repo, branch, message, author });
    ctx.stdout += `${r.created ? 'created' : 'updated'} ${repo} branch ${r.branch}: ${r.commit.slice(0, 12)} (${r.files} file(s))\n${r.url}\n`;
    ctx.stdout += `open a pull request: gh pr create -R ${repo} --head ${r.branch} --base main\n`;
    return 0;
  } catch (e: any) {
    ctx.stderr += `hotswap push: ${e?.message ?? e}\n`;
    return 1;
  }
}
