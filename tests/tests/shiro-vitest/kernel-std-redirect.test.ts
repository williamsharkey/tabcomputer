/**
 * `>&2`, `> /dev/stderr`, `2> /dev/stdout`, `> /dev/fd/2` on a kernel program:
 * the job's own stdout/stderr, not a path for the kernel to open (it failed
 * with "sh: /dev/stderr: No such file or directory" when stdin was the
 * terminal). Left to right: `> f 2> /dev/stdout` is `2>&1`, `2> f > /dev/stderr`
 * puts both in f.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { createTestOS } from './helpers';
import type { FileSystem } from '@shiro/filesystem';

// hello-musl: prints "hello from c", "env=…", reads a line ("stdin=…"), then "to stderr" on fd 2
const HELLO = readFileSync(__dirname + '/fixtures/x86/hello-musl');
let fs: FileSystem;
let t: any;
let screen = '';

beforeAll(async () => {
  const os = await createTestOS();
  fs = os.fs;
  t = os.terminal;
  const orig = t.term.write.bind(t.term);
  t.term.write = (s: any, cb?: any) => { screen += typeof s === 'string' ? s : new TextDecoder().decode(s); return orig(s, cb); };
  await fs.writeFile('/tmp/hello', HELLO, { mode: 0o755 } as any);
  await t.handleInput('cd /tmp\r');
}, 60000);

/** Run `cmd` at the prompt with the terminal as stdin, typing one line for the program to read */
async function atPrompt(cmd: string): Promise<string> {
  screen = '';
  const done = t.handleInput(cmd + '\r');
  await new Promise((r) => setTimeout(r, 1500));
  await t.handleInput('typed\r');
  await done;
  return screen.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
}

describe('a kernel program redirected to its own stdout/stderr, stdin the terminal', () => {
  it('>&2 and > /dev/stderr run it, output on the terminal', async () => {
    for (const r of ['>&2', '> /dev/stderr', '> /dev/fd/2']) {
      const out = await atPrompt(`./hello ${r}; echo "rc $?"`);
      expect(out).not.toMatch(/No such file/);
      expect(out).toMatch(/hello from c[\s\S]*stdin=typed[\s\S]*to stderr[\s\S]*rc 0/);
    }
  }, 60000);

  it('left to right with files', async () => {
    await atPrompt('./hello >o.txt 2>/dev/stdout; echo "rc $?"');
    expect(await fs.readFile('/tmp/o.txt', 'utf8')).toMatch(/hello from c[\s\S]*to stderr/);
    const shown = await atPrompt('./hello > /dev/fd/2 2>e.txt; echo "rc $?"');
    expect(shown).toMatch(/hello from c/);
    expect(await fs.readFile('/tmp/e.txt', 'utf8')).toBe('to stderr\n');
    await atPrompt('./hello 2>e2.txt >/dev/stderr; echo "rc $?"');
    const both = await fs.readFile('/tmp/e2.txt', 'utf8') as string;
    for (const l of ['hello from c', 'env=(unset)', 'stdin=typed', 'to stderr']) expect(both).toContain(l + '\n');
  }, 60000);

  it('without a terminal too', async () => {
    let out = '', err = '';
    const code = await t.shell.execute('/tmp/hello >&2 < /dev/null', (s: string) => { out += s; }, (s: string) => { err += s; });
    expect(code).toBe(0);
    expect(out).toBe('');
    expect(err.replace(/\r\n/g, '\n')).toMatch(/hello from c[\s\S]*to stderr/);
  }, 60000);
});
