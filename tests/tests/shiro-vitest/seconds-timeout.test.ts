/**
 * $SECONDS counts from this shell's start (not the page's), `SECONDS=n` counts
 * on from n, and arithmetic sees it. `timeout N cmd < fifo` reads the FIFO
 * inside its time limit: a writer that never comes ends it with 124.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('$SECONDS', () => {
  it('starts near 0 and can be set', async () => {
    expect(Number((await sh('echo $SECONDS')).out)).toBeLessThan(3);
    expect((await sh('SECONDS=100; echo $SECONDS ${SECONDS}')).out).toBe('100 100\n');
    expect((await sh('a=${RANDOM}; [ -n "$a" ] && echo ok')).out).toBe('ok\n');
  });

  it('arithmetic sees it', async () => {
    const r = await sh('SECONDS=50; t0=$SECONDS; sleep 1; echo $((SECONDS - t0)) $(( SECONDS >= 51 ))');
    expect(r.out).toBe('1 1\n');
  });
});

describe('timeout with a FIFO on stdin', () => {
  it('ends with 124 when no writer comes', async () => {
    const t = Date.now();
    const r = await sh('rm -f /tmp/tf1; mkfifo /tmp/tf1; timeout 1 cat < /tmp/tf1; echo rc=$?');
    expect(r.out).toBe('rc=124\n');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('reads what a writer sends in time', async () => {
    const r = await sh('rm -f /tmp/tf2; mkfifo /tmp/tf2; (echo hello > /tmp/tf2) & timeout 5 cat < /tmp/tf2; echo rc=$?; wait');
    expect(r.out.replace(/^\[1\] \d+\n/, '')).toBe('hello\nrc=0\n');
  });
});
