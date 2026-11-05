/**
 * Prepare Claude Code's modules offline, so a page downloads them instead of
 * transforming them. The binary is Anthropic's linux-x64-musl build (the same
 * file /claude-releases/ keeps). Output is TABCOMPUTER_CLAUDE_VM_LAYOUT's
 * shape: OUT/<sha256>/<VM_LAYOUT>/pack.gz
 *
 *   node scripts/claude-vm/pack-layout.mjs BINARY OUT_DIR [VERSION] [SHA256]
 *
 * Run it again when the pin moves or VM_LAYOUT changes. `claude update` still
 * installs a different binary, which the page lays out itself.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = join(root, 'src/claude-vm/pack-entry.ts');
const out = join(root, 'node_modules/.cache/claude-vm-pack.mjs');
const esbuild = join(root, 'node_modules/esbuild/bin/esbuild');
const built = spawnSync(esbuild, [
  entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`,
  '--log-level=warning',
], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const run = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(run.status ?? 1);
