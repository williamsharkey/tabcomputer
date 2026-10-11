import { describe, it, expect } from 'vitest';
import { fillRandom, RANDOM_CHUNK } from '@shiro/utils/random-fill';
import { createCryptoModule } from '@shiro/node-compat/modules/crypto';

// #46: crypto.getRandomValues stops at 64 KiB per call; Node's randomBytes and
// randomFillSync, WASI random_get and getrandom(2) take any size
const nodeCrypto = () => createCryptoModule({
  sha256sync: () => new Uint8Array(32), sha1sync: () => new Uint8Array(20), fnvHash: () => new Uint8Array(0),
  FakeBuffer: class FakeBuffer extends Uint8Array {},
});

/** Every 64 KiB chunk got random bytes (all zeros in 64 KiB of random: never) */
const everyChunkFilled = (b: Uint8Array) => {
  for (let i = 0; i < b.length; i += RANDOM_CHUNK) {
    if (b.subarray(i, i + RANDOM_CHUNK).every((x) => x === 0)) return false;
  }
  return true;
};

describe('random bytes of any size (#46)', () => {
  it('fillRandom fills past 64 KiB, and shared memory too', () => {
    const big = fillRandom(new Uint8Array(3 * RANDOM_CHUNK + 5));
    expect(everyChunkFilled(big)).toBe(true);
    expect(big.subarray(-5).some((x) => x !== 0)).toBe(true);
    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(2 * RANDOM_CHUNK + 100));
      fillRandom(shared.subarray(50, 2 * RANDOM_CHUNK + 50));
      expect(shared.subarray(0, 50).every((x) => x === 0)).toBe(true);
      expect(shared.subarray(-50).every((x) => x === 0)).toBe(true);
      expect(everyChunkFilled(shared.subarray(50, 2 * RANDOM_CHUNK + 50))).toBe(true);
    }
    const words = fillRandom(new Uint32Array(40000)); // 160,000 bytes
    expect(words.some((x) => x !== 0)).toBe(true);
  });

  it('randomBytes takes sizes over 64 KiB, as Node', async () => {
    const c = nodeCrypto();
    const b = c.randomBytes(1 << 20);
    expect(b.length).toBe(1 << 20);
    expect(everyChunkFilled(b)).toBe(true);
    expect(c.randomBytes(0).length).toBe(0);
    expect(() => c.randomBytes(-1)).toThrow(RangeError);
    expect(() => c.randomBytes(2 ** 31)).toThrow(RangeError);
    const viaCb = await new Promise<Uint8Array>((res, rej) => c.randomBytes(70000, (e: any, x: Uint8Array) => (e ? rej(e) : res(x))));
    expect(viaCb.length).toBe(70000);
  });

  it('randomFillSync and randomFill fill all of it, or just offset/size', async () => {
    const c = nodeCrypto();
    const all = new Uint8Array(200_000);
    expect(c.randomFillSync(all)).toBe(all);
    expect(everyChunkFilled(all)).toBe(true);

    const part = new Uint8Array(150_000);
    c.randomFillSync(part, 1000, 140_000);
    expect(part.subarray(0, 1000).every((x) => x === 0)).toBe(true);
    expect(part.subarray(141_000).every((x) => x === 0)).toBe(true);
    expect(everyChunkFilled(part.subarray(1000, 141_000))).toBe(true);
    expect(() => c.randomFillSync(part, 149_999, 2)).toThrow(RangeError);

    const ab = new ArrayBuffer(100_000);
    c.randomFillSync(ab, 99_000);
    expect(new Uint8Array(ab, 0, 99_000).every((x) => x === 0)).toBe(true);

    const later = new Uint8Array(100_000);
    const got = await new Promise((res, rej) => c.randomFill(later, 10, (e: any, x: any) => (e ? rej(e) : res(x))));
    expect(got).toBe(later);
    expect(later.subarray(0, 10).every((x) => x === 0)).toBe(true);
    expect(everyChunkFilled(later.subarray(10))).toBe(true);
  });

  it('getRandomValues keeps the Web Crypto limit, as Node\'s does', () => {
    expect(() => nodeCrypto().getRandomValues(new Uint8Array(RANDOM_CHUNK + 1))).toThrow();
    expect(nodeCrypto().getRandomValues(new Uint8Array(RANDOM_CHUNK)).length).toBe(RANDOM_CHUNK);
  });
});
