/**
 * Bun's hash.crc32 for claude --vm (src/claude-vm/bun/): the expected values are what
 * Bun 1.4.2 returned for the same calls.
 */
import { describe, it, expect } from 'vitest';
import { crc32, xxHash64 } from '@shiro/claude-vm/bun/hash';
import { createBun } from '@shiro/claude-vm/bun/index';

describe('Bun.hash.crc32', () => {
  it('strings (UTF-8), bytes, ArrayBuffers, and a running seed', () => {
    expect([crc32(''), crc32('hello'), crc32(new Uint8Array([1, 2, 3])), crc32('world', crc32('hello ')), crc32('hello world'), crc32('日本'), crc32(new Uint8Array(1000).fill(7).buffer)])
      .toEqual([0, 907060870, 1438416925, 222957957, 222957957, 3350711756, 1167601884]);
  });
});

describe('Bun.hash.xxHash64 (new in 2.1.316: a cache key)', () => {
  it('XXH64 as a bigint: the reference values, every tail length, a seed', () => {
    expect(xxHash64('')).toBe(0xef46db3751d8e999n);
    expect(xxHash64('abc')).toBe(0x44bc2cf5ad770999n);
    expect(xxHash64('Nobody inspects the spammish repetition')).toBe(0xfbcea83c8a378bf1n);
    expect(xxHash64(new TextEncoder().encode('abc'))).toBe(0x44bc2cf5ad770999n);
    expect(xxHash64('abc', 1)).not.toBe(xxHash64('abc'));
    expect(typeof xxHash64('x'.repeat(77))).toBe('bigint');
  });
});

describe('Bun.SHA256.hash (new in 2.1.316: block digests)', () => {
  it('the digest as bytes, or in an encoding', () => {
    const Bun: any = createBun({ fs: {} as any, process: { env: {}, cwd: () => '/', on() {} } as any, childProcess: {} as any, Buffer });
    expect(Bun.SHA256.hash('abc', 'hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(Bun.SHA256.hash(new Uint8Array(0), 'base64')).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    expect(Buffer.from(Bun.SHA256.hash('abc')).toString('hex')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(typeof Bun.hash.xxHash64).toBe('function');
  });
});
