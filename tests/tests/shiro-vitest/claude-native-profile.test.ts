/**
 * Opt-in profiling harness: Anthropic's native Claude Code (linux-x64-musl)
 * in Blink under Node, with SHIRO_BLINK_PROFILE (tabcomputer#52).
 *
 *   CLAUDE_NATIVE_BIN=/path/claude MUSL_LIBC=/path/libc.so \
 *   CLAUDE_PROFILE_OUT=/tmp/p.txt CLAUDE_PROFILE_CMD='--version' CLAUDE_PROFILE_ENV='BLINK_WJIT_DEBUG=1' \
 *   npx vitest run --config vitest.config.ts tests/shiro-vitest/claude-native-profile.test.ts
 *
 * Skipped unless CLAUDE_NATIVE_BIN and MUSL_LIBC are set (the binary is 250 MB
 * and never committed). Prints the wall time and copies the profile out.
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { createTestShell, run } from './helpers';

const BIN = process.env.CLAUDE_NATIVE_BIN;
const LIBC = process.env.MUSL_LIBC;
const OUT = process.env.CLAUDE_PROFILE_OUT;
const ARGS = process.env.CLAUDE_PROFILE_CMD ?? "-p 'reply with the single word ok'";
const ENV = process.env.CLAUDE_PROFILE_ENV ?? '';
const LOG = process.env.CLAUDE_PROFILE_LOG;  // the whole output, to this file  // more guest variables (BLINK_WJIT_DUMP=0x..., ...)

describe.skipIf(!BIN || !LIBC)('native Claude Code under Blink (profile)', () => {
  it('runs', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/.local/bin', { recursive: true });
    await fs.writeFile('/home/user/.local/bin/claude', readFileSync(BIN!), { mode: 0o755 });
    await fs.mkdir('/lib', { recursive: true });
    await fs.writeFile('/lib/ld-musl-x86_64.so.1', readFileSync(LIBC!), { mode: 0o755 });
    await run(shell, 'cd /home/user');
    const prof = OUT ? 'SHIRO_BLINK_PROFILE=/tmp/blink-profile.txt ' : '';
    const t0 = performance.now();
    const r = await run(shell, `${prof}${ENV ? ENV + ' ' : ''}BUN_JSC_useJIT=0 DISABLE_AUTOUPDATER=1 DISABLE_INSTALLATION_CHECKS=1 /home/user/.local/bin/claude ${ARGS} </dev/null; echo "status=$?"`);
    const ms = performance.now() - t0;
    console.log(`claude ${ARGS}: ${ms.toFixed(0)} ms\n${r.output.slice(-2000)}`);
    if (LOG) writeFileSync(LOG, r.output);
    if (OUT) writeFileSync(OUT, await fs.readFile('/tmp/blink-profile.txt', 'utf8') as string);
  }, 1_800_000);
});
