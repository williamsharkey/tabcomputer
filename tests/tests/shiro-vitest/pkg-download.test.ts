/**
 * A package download that gets no data is given up and tried once more, and
 * then fails with a message: `pkg install` never waits for ever (a stalled CDN
 * connection hung the ripgrep test in CI, tabcomputer#157).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { download } from '@shiro/pkg-manager';

const bytes = new TextEncoder().encode('a package file\n');
const sha = createHash('sha256').update(bytes).digest('hex');
const never = () => new Promise<Response>(() => {});
/** An answer whose body sends a piece and then nothing */
const hangingBody = () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 4)); } }));

afterEach(() => { vi.unstubAllGlobals(); });

describe('package downloads that stall', () => {
  it('no answer: tried again, and the second one is used', async () => {
    const f = vi.fn().mockImplementationOnce(never).mockImplementationOnce(async () => new Response(bytes));
    vi.stubGlobal('fetch', f);
    const said: string[] = [];
    expect(await download('https://cdn.example/a.bin', sha, { stallMs: 100, log: (l) => said.push(l) })).toEqual(bytes);
    expect(f).toHaveBeenCalledTimes(2);
    expect(said.join()).toMatch(/no data for 0 s; trying again/);
  });
  it('a body that stops halfway: tried again', async () => {
    const f = vi.fn().mockImplementationOnce(async () => hangingBody()).mockImplementationOnce(async () => new Response(bytes));
    vi.stubGlobal('fetch', f);
    expect(await download('https://cdn.example/a.bin', sha, { stallMs: 100 })).toEqual(bytes);
  });
  it('stalled twice: an error that says so, not a wait for ever', async () => {
    vi.stubGlobal('fetch', vi.fn(never));
    await expect(download('https://cdn.example/a.bin', sha, { stallMs: 100 })).rejects.toThrow('download stalled: https://cdn.example/a.bin: no data for 0 s, twice');
  });
  it('a slow body that keeps sending is not cut off', async () => {
    const slow = () => new Response(new ReadableStream({
      async start(c) { for (const b of bytes) { await new Promise((r) => setTimeout(r, 20)); c.enqueue(new Uint8Array([b])); } c.close(); },
    }));
    const f = vi.fn(async () => slow());
    vi.stubGlobal('fetch', f);
    expect(await download('https://cdn.example/a.bin', sha, { stallMs: 100 })).toEqual(bytes);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
