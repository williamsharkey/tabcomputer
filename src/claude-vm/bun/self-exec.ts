/**
 * process.execPath for claude --vm. Claude Code runs itself again through its
 * execPath (Bun.isStandaloneExecutable: no script argument): the pty host and
 * the daemon of background sessions (`--bg-pty-host`, `--daemon-worker`),
 * /restart, `claude plugin test`, the Chrome native host. Under --vm that was
 * node's path, so `node --bg-pty-host ...` failed. It is this file instead,
 * `claude` beside vm-main.mjs: a `#!/usr/bin/env node` script (the kernel's
 * node loader runs it) that starts the launcher with the same arguments.
 */

/** Claude Code takes a file under 64 KiB at its execPath for an npm stub and won't spawn it (the daemon's `rejectNpmStub`) */
export const NPM_STUB_LIMIT = 65536;

export function selfExecSource(): string {
  const head = [
    // (the import right after the #! line: node-compat's transform took one after a
    // comment ending in "." for a method call, and left it to the host's own import())
    '#!/usr/bin/env node',
    "import(__dirname + '/vm-main.mjs');",
    '// tabcomputer: Claude Code under claude --vm runs itself again through this file',
    '// (process.execPath: src/claude-vm/bun/self-exec.ts), which starts vm-main.mjs beside it.',
    '// The rest is padding: Claude Code refuses an execPath under 64 KiB, taking it for an npm stub.',
    '',
  ].join('\n');
  const line = '//' + ' '.repeat(1021) + '\n';
  return head + line.repeat(Math.ceil((NPM_STUB_LIMIT + 1024 - head.length) / line.length));
}

/** Make <dir of main>/claude (once) and return its path; null where there is no launcher beside main */
export function ensureSelfExec(fs: any, main: string): string | null {
  const dir = main.slice(0, main.lastIndexOf('/'));
  if (!dir) return null;
  const path = `${dir}/claude`;
  try {
    fs.statSync(`${dir}/vm-main.mjs`);
    const src = selfExecSource();
    let size = -1;
    try { size = fs.statSync(path).size; } catch { /* not yet */ }
    if (size !== src.length) {
      fs.writeFileSync(path, src);
      fs.chmodSync(path, 0o755);
    }
    return path;
  } catch {
    return null;
  }
}
