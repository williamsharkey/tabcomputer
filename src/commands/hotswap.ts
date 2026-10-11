import type { Command, CommandContext } from './index';
import { buildSwap } from '../hotswap/build';
import { evaluateBundle, hotswap, type ModuleReport, type SwapRecord } from '../hotswap/swap';

/**
 * hotswap: swap core modules (src/shell.ts, src/terminal.ts, src/kernel/...)
 * built from a checkout of tabcomputer's source into this running tab, with
 * an auto-revert unless confirmed (docs/HOTSWAP.md).
 */

const USAGE = `Usage: hotswap apply [--root DIR] [--ttl 90s | --no-ttl] FILE...
       hotswap build [--root DIR] FILE...   build and report, swap nothing
       hotswap confirm [--persist] [ID]     keep pending swaps (stop their TTL)
       hotswap revert [--all]               undo the newest swap (or all)
       hotswap status                       applied swaps, TTLs, what changed
       hotswap persisted [clear]            swaps re-applied at boot
       hotswap test [--root DIR] [-t RE] [-v] SUITE...
                                            run vitest suites from the checkout in this tab

FILEs are paths in a checkout of tabcomputer's source (default root: the
nearest directory above the cwd with src/shell.ts). Classes exported by a
swapped file replace the methods of the live classes of the same name.
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
  hotswap.onAutoRevert = (records) => {
    const msg = `hotswap: reverted ${records.map((r) => `#${r.id} ${r.label}`).join(', ')}: #${records[records.length - 1].id} wasn't confirmed in time`;
    console.warn(msg);
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
      if (!hotswap.stack.length) { ctx.stdout += 'No swaps applied.\n'; return 0; }
      for (const r of hotswap.stack) ctx.stdout += line(r) + '\n' + describe(r.report);
      return 0;
    }

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

    if (sub !== 'apply' && sub !== 'build') { ctx.stderr += `hotswap: unknown subcommand '${sub}'\n${USAGE}`; return 2; }

    let root: string | null = null;
    let ttl: number | null = DEFAULT_TTL_MS;
    let sourcemap = false;
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
      else if (a.startsWith('-')) { ctx.stderr += `hotswap: unknown option ${a}\n`; return 2; }
      else files.push(a);
    }
    if (!files.length) { ctx.stderr += USAGE; return 2; }
    root ??= await findRoot(ctx, ctx.cwd);
    if (!root) { ctx.stderr += 'hotswap: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n'; return 1; }
    const abs = files.map((f) => ctx.fs.resolvePath(f, ctx.cwd));

    let built;
    try {
      built = await buildSwap({ readFile: async (p) => ctx.fs.readFile(p, 'utf8') as Promise<string> }, { root, files: abs, sourcemap });
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

/** The suite files: paths, or names under tests/tests/shiro-vitest ('shell-posix') */
async function suitePath(ctx: CommandContext, root: string, arg: string): Promise<string | null> {
  const tries = [ctx.fs.resolvePath(arg, ctx.cwd)];
  for (const name of [arg, `${arg}.test.ts`]) tries.push(`${root}/tests/tests/shiro-vitest/${name}`, `${root}/${name}`);
  for (const p of tries) {
    try { if ((await ctx.fs.stat(p)).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

async function runTests(ctx: CommandContext, args: string[]): Promise<number> {
  let root: string | null = null;
  let filter: RegExp | undefined;
  let verbose = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') root = ctx.fs.resolvePath(args[++i] ?? '.', ctx.cwd);
    else if (a === '-t' || a === '--testNamePattern') {
      try { filter = new RegExp(args[++i] ?? ''); } catch (e: any) { ctx.stderr += `hotswap test: bad -t: ${e.message}\n`; return 2; }
    } else if (a === '-v' || a === '--verbose') verbose = true;
    else if (a.startsWith('-')) { ctx.stderr += `hotswap test: unknown option ${a}\n`; return 2; }
    else names.push(a);
  }
  if (!names.length) { ctx.stderr += 'Usage: hotswap test [--root DIR] [-t RE] [-v] SUITE...\n'; return 2; }
  root ??= await findRoot(ctx, ctx.cwd);
  if (!root) { ctx.stderr += 'hotswap test: no checkout found above the cwd (a directory with src/shell.ts); pass --root DIR\n'; return 1; }
  const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
  const { buildTest } = await import('../hotswap/build');
  const { runTestBundle } = await import('../hotswap/test-runner');
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
