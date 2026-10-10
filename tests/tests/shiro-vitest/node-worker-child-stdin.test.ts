/**
 * The shell's piped input (__PIPE_STDIN, what `read` takes in a piped loop) is
 * the shell's: not in node's environment, nor its children's. vite's esbuild
 * started its service with `sh -c` (a guest's spawn) with vite's process.env,
 * and that shell took it for its stdin: the service read an empty stdin and
 * stopped (`npx vite dev > log`; tests/browser/vite-react.mjs REDIRECT=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: (() => void) | undefined;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

describe("the shell's piped input isn't a program's environment", () => {
  it.each([['in the page', ''], ['as a guest', 'export TABCOMPUTER_NODE_WORKER=1; ']])("isn't in node's process.env, %s", async (_, pre) => {
    const { shell, fs } = await createTestShell();
    (shell as any).env.__PIPE_STDIN = 'piped';
    await shell.execute(`${pre}node -e "console.log('__PIPE_STDIN' in process.env)" > /tmp/probe.out`, () => {}, () => {});
    expect(await fs.readFile('/tmp/probe.out', 'utf8')).toBe('false\n');
  }, 60_000);

  it("a guest's `sh -c` reads its own stdin, whatever its environment says", async () => {
    const { shell } = await createTestShell();
    let out = '';
    // (spawn hands the kernel's sh an environment with it, as vite's process.env had)
    await shell.execute(`export TABCOMPUTER_NODE_WORKER=1; node -e "const c = require('child_process').spawn('read l; echo got \\$l', { shell: true, env: { ...process.env, __PIPE_STDIN: 'stale' }, stdio: ['pipe', 'pipe', 'inherit'] }); c.stdout.on('data', (d) => process.stdout.write(d)); c.stdin.end('real\\n')"`, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('got real\n');
  }, 60_000);
});
