/**
 * Compile Claude Code's modules before anyone types `claude` (module-store.ts
 * precompile). This does not start Claude Code. Where node runs in a worker,
 * the compile happens there and that worker stays in the pool (host.ts), so
 * the command finds the functions already made. On the page it yields, so the
 * tab stays responsive.
 */
import type { CommandContext } from '../commands/index';
import type { Shell } from '../shell';
import { nodeWorkerMode } from '../node-worker/boot';

const WARM_SOURCE = [
  "const fs = require('fs');",
  "const dir = process.env.TABCOMPUTER_CLAUDE_VM_DIR || __dirname;",
  "const store = await require('tabcomputer:claude-vm').modules();",
  "const bytes = await store.loadModules(dir, () => fs.readFileSync(dir + '/modules.js'));",
  "const index = JSON.parse(fs.readFileSync(dir + '/modules.json', 'utf8'));",
  "await store.precompile(dir, bytes, index);",
  '',
].join('\n');

export interface WarmFs {
  readFile(path: string, enc?: string): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

export interface WarmOptions {
  /** The layout directory (extract.ts), which holds modules.js and modules.json */
  dir: string;
  fs: WarmFs;
  env: Record<string, string>;
  shell: Shell;
}

let inflight: Promise<void> | null = null;

/** The warm-up that is running now, if one is. `claude` waits for it instead of compiling a second time. */
export function claudeWarmup(): Promise<void> | null {
  return inflight;
}

function asBytes(v: string | Uint8Array): Uint8Array {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  return v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);
}

async function warm(opts: WarmOptions): Promise<void> {
  if (!nodeWorkerMode(opts.env)) {
    const { precompile } = await import('./module-store');
    const bytes = asBytes(await opts.fs.readFile(`${opts.dir}/modules.js`));
    const index = JSON.parse(String(await opts.fs.readFile(`${opts.dir}/modules.json`, 'utf8')));
    await precompile(opts.dir, bytes, index, 8);
    return;
  }
  await opts.fs.writeFile(`${opts.dir}/warm.mjs`, WARM_SOURCE);
  const { nodeCmd } = await import('../commands/jseval');
  const ctx = {
    args: [`${opts.dir}/warm.mjs`],
    fs: opts.fs as WarmOptions['fs'] & { [k: string]: unknown },
    cwd: opts.dir,
    env: { ...opts.env, TABCOMPUTER_CLAUDE_VM_DIR: opts.dir, TABCOMPUTER_CLAUDE_WARM: '1' },
    stdin: '',
    stdout: '',
    stderr: '',
    shell: opts.shell,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const code = await nodeCmd.exec(ctx as unknown as CommandContext);
  if (code !== 0) throw new Error((ctx.stderr || `Claude Code module warm-up exited ${code}`).slice(0, 500));
}

/** Compile `dir` once. A second call while it runs joins the first. */
export function warmClaudeVm(opts: WarmOptions): Promise<void> {
  if (inflight) return inflight;
  inflight = warm(opts).finally(() => { inflight = null; });
  return inflight;
}
