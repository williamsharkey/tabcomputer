/**
 * Pasting several lines at the prompt runs each in turn, and keys typed while
 * a command runs are type-ahead for the next prompt (bash/readline), not
 * dropped. An open if/quote/here-doc reads more lines with a "> " prompt;
 * Ctrl-C drops what was queued.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestOS } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { ShiroTerminal } from '@shiro/terminal';

let fs: FileSystem;
let terminal: ShiroTerminal;
/** Keys as xterm hands them over (a paste is one chunk, lines ending in \r) */
const keys = (data: string): Promise<void> => (terminal as any).handleInput(data);
const read = async (p: string) => (await fs.readFile(p, 'utf8').catch(() => '')) as string;

beforeEach(async () => {
  ({ fs, terminal } = await createTestOS());
  await keys('cd /tmp && rm -f out out2\r');
});

describe('a multi-line paste', () => {
  it('runs every line', async () => {
    await keys('echo hi1 >> out\recho hi2 >> out\recho hi3 >> out\r');
    expect(await read('/tmp/out')).toBe('hi1\nhi2\nhi3\n');
  });

  it('\\r\\n line ends too', async () => {
    await keys('echo a >> out\r\necho b >> out\r\n');
    expect(await read('/tmp/out')).toBe('a\nb\n');
  });

  it('an if and a here-document over several lines', async () => {
    await keys('if true; then\recho yes >> out\rfi\r');
    await keys("cat > out2 <<'EOF'\rl1 $HOME\rl2\rEOF\r");
    await keys('for i in 1 2; do\r  echo $i >> out\rdone\r');
    expect(await read('/tmp/out')).toBe('yes\n1\n2\n');
    expect(await read('/tmp/out2')).toBe('l1 $HOME\nl2\n');
  });

  it('a quote and a trailing backslash continue the line', async () => {
    await keys('echo "a\rb" >> out\recho c \\\rd >> out\r');
    expect(await read('/tmp/out')).toBe('a\nb\nc d\n');
  });

  it('bracketed paste markers are ignored', async () => {
    await keys('\x1b[200~echo bp1 >> out\recho bp2 >> out\r\x1b[201~');
    expect(await read('/tmp/out')).toBe('bp1\nbp2\n');
  });

  it('Ctrl-C at a "> " prompt drops the open command', async () => {
    await keys('if true; then\recho no >> out\r\x03');
    await keys('echo after >> out\r');
    expect(await read('/tmp/out')).toBe('after\n');
  });
});

describe('type-ahead while a command runs', () => {
  it('runs after it', async () => {
    const first = keys('sleep 0.2; echo first >> out\r');
    await new Promise((r) => setTimeout(r, 50));
    await keys('echo second >> out\r');
    await first;
    expect(await read('/tmp/out')).toBe('first\nsecond\n');
  });

  it('Ctrl-C drops it', async () => {
    const first = keys('sleep 0.3\r');
    await new Promise((r) => setTimeout(r, 50));
    await keys('echo queued >> out\r');
    await keys('\x03');
    await first;
    await keys('echo after >> out\r');
    expect(await read('/tmp/out')).toBe('after\n');
  });
});
