/**
 * Bun.Image for claude --vm (src/claude-vm/bun/image.ts), the calls Claude
 * Code makes to shrink an image before sending it: metadata() from the
 * file's header, resize/rotate/jpeg/png/webp chains turned into one encode,
 * toBuffer(), and the error codes it reads. The pixels are the browser's
 * (OffscreenCanvas); here a stand-in codec reports the encode it was asked for.
 */
import { describe, it, expect } from 'vitest';
import { imageClass, sniffFormat, headerSize, type ImageCodec, type EncodePlan } from '@shiro/claude-vm/bun/image';
import { createBun } from '@shiro/claude-vm/bun/index';

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => Uint8Array.from([0x89, ...ascii('PNG\r\n\x1a\n'), ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const jpeg = (w: number, h: number) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xdb, 0, 4, 0, 0, // (a table first: skipped)
  0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = (w: number, h: number) => Uint8Array.from([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0]);
const webpX = (w: number, h: number) => Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w: number, h: number) => {
  const v = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBPVP8L'), 5, 0, 0, 0, 0x2f, v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
};
const bmp = (w: number, h: number) => Uint8Array.from([...ascii('BM'), 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, ...le16(w), 0, 0, ...le16(h), 0, 0, 1, 0, 24, 0]);

/** Decodes to the header's size; encodes to the plan, as JSON */
const fake: ImageCodec = {
  async decode(b) {
    const f = sniffFormat(b);
    const s = f && headerSize(b, f);
    if (!s) throw new Error('bad pixels');
    return { ...s, source: 'pixels' };
  },
  async encode(_src, plan) { return new TextEncoder().encode(JSON.stringify(plan)); },
};
const Image = imageClass((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength), () => fake);
const plan = async (img: any): Promise<EncodePlan> => JSON.parse(Buffer.from(await img.toBuffer()).toString());

describe('Bun.Image: metadata', () => {
  it('size and format from the header of each format Claude Code sends', async () => {
    const got = await Promise.all([png(4000, 3000), jpeg(640, 480), gif(32, 16), webpX(3000, 2000), webpL(800, 600), bmp(10, 20)]
      .map((b) => new Image(b).metadata()));
    expect(got).toEqual([
      { width: 4000, height: 3000, format: 'png' }, { width: 640, height: 480, format: 'jpeg' },
      { width: 32, height: 16, format: 'gif' }, { width: 3000, height: 2000, format: 'webp' },
      { width: 800, height: 600, format: 'webp' }, { width: 10, height: 20, format: 'bmp' },
    ]);
  });
  it('the error codes Claude Code tells apart', async () => {
    await expect(new Image(Buffer.from('not an image at all')).metadata()).rejects.toMatchObject({ code: 'ERR_IMAGE_UNKNOWN_FORMAT' });
    await expect(new Image(png(5000, 5000), { maxPixels: 8000 * 1000 }).metadata()).rejects.toMatchObject({ code: 'ERR_IMAGE_TOO_MANY_PIXELS' });
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // (a JPEG with no frame: the decoder's turn)
    await expect(new Image(broken).toBuffer()).resolves.toBeDefined(); // nothing to do: the bytes back
    await expect(new Image(broken).jpeg({ quality: 50 }).toBuffer()).rejects.toMatchObject({ code: 'ERR_IMAGE_DECODE_FAILED' });
  });
});

describe('Bun.Image: operations', () => {
  it('resize inside without enlargement, as the Read tool asks for big images', async () => {
    expect(await plan(new Image(png(4000, 3000)).resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 })))
      .toEqual({ width: 1568, height: 1176, rotate: 0, format: 'jpeg', quality: 0.8 });
    // (smaller than the box: left as it is)
    expect(await plan(new Image(png(400, 300)).resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).png()))
      .toEqual({ width: 400, height: 300, rotate: 0, format: 'png' });
  });
  it('fill, cover (the middle, cropped), one side only', async () => {
    expect(await plan(new Image(png(1000, 500)).resize(300, 300, { fit: 'fill' }))).toMatchObject({ width: 300, height: 300 });
    expect(await plan(new Image(png(1000, 500)).resize(300, 300))).toMatchObject({ width: 300, height: 300, crop: [250, 0, 500, 500] });
    expect(await plan(new Image(png(1000, 500)).resize(200))).toMatchObject({ width: 200, height: 100 });
  });
  it('rotate: a quarter turn swaps the sides a later resize sees', async () => {
    expect(await plan(new Image(jpeg(400, 200)).rotate(90).resize(100, 1000, { fit: 'inside' })))
      // (200x400 once turned, 100x200 in the box; the plan's sides are the source's, before the turn)
      .toEqual({ width: 200, height: 100, rotate: 90, format: 'jpeg', quality: 0.8 });
  });
  it('the output format: the last one asked for, else the source (png for gif and bmp); lossless webp', async () => {
    expect((await plan(new Image(bmp(10, 20)).png())).format).toBe('png');
    expect((await plan(new Image(gif(10, 20)).rotate(180))).format).toBe('png');
    expect(await plan(new Image(png(10, 20)).webp({ lossless: true }))).toMatchObject({ format: 'webp', quality: 1, lossless: true });
    expect(await plan(new Image(png(10, 20)).jpeg({ quality: 20 }).webp({ quality: 90 }))).toMatchObject({ format: 'webp', quality: 0.9 });
  });
  it('each operation is a new image; toBuffer of an unchanged one is its bytes, as a Buffer', async () => {
    const a = new Image(png(10, 10));
    const b = a.resize(5, 5, { fit: 'fill' });
    expect(b).not.toBe(a);
    const out = await a.toBuffer();
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([...png(10, 10)]);
  });
});

describe('Bun.Image without a browser codec (node)', () => {
  it('metadata still answers; an encode says why it cannot', async () => {
    const B: any = createBun({ fs: {}, process: { env: {}, cwd: () => '/' }, childProcess: {}, Buffer });
    const img = new B.Image(png(3000, 2000), { maxPixels: 1568 * 1568 * 4 });
    expect(await img.metadata()).toEqual({ width: 3000, height: 2000, format: 'png' });
    await expect(img.resize(100, 100, { fit: 'inside' }).toBuffer()).rejects.toMatchObject({ code: 'ERR_IMAGE_FORMAT_UNSUPPORTED' });
  });
});
