/**
 * Bun's hash.crc32 for claude --vm (src/claude-vm/bun/): the expected values are what
 * Bun 1.4.2 returned for the same calls.
 */
import { describe, it, expect } from 'vitest';
import { crc32 } from '@shiro/claude-vm/bun/hash';

describe('Bun.hash.crc32', () => {
  it('strings (UTF-8), bytes, ArrayBuffers, and a running seed', () => {
    expect([crc32(''), crc32('hello'), crc32(new Uint8Array([1, 2, 3])), crc32('world', crc32('hello ')), crc32('hello world'), crc32('日本'), crc32(new Uint8Array(1000).fill(7).buffer)])
      .toEqual([0, 907060870, 1438416925, 222957957, 222957957, 3350711756, 1167601884]);
  });
});
