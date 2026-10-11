/**
 * Bun.Image for claude --vm (src/claude-vm/bun/image.ts): Claude Code's image
 * pipeline chains metadata/resize/rotate/jpeg/png/webp/toBuffer on it. Over
 * node-compat's browser sharp; here the browser's decoder and canvas are
 * stand-ins that record what was asked of them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { createBun } from '@shiro/claude-vm/bun/index';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const g = globalThis as any;
const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };

beforeAll(() => {
  g.createImageBitmap = async (blob: Blob) => ({ width: 400, height: 300, type: blob.type, close() {} });
  g.OffscreenCanvas = class {
    ops: string[] = [];
    constructor(public width: number, public height: number) {}
    getContext() {
      const ops = this.ops;
      return { fillRect() { ops.push('fill'); }, translate() {}, rotate(r: number) { ops.push(`rotate ${Math.round(r * 180 / Math.PI)}`); }, drawImage(_b: unknown, _x: number, _y: number, w: number, h: number) { ops.push(`draw ${w}x${h}`); }, set fillStyle(_v: string) {} };
    }
    async convertToBlob(o: { type: string; quality?: number }) {
      return new Blob([JSON.stringify({ canvas: `${this.width}x${this.height}`, type: o.type, quality: o.quality, ops: this.ops })]);
    }
  };
});
afterAll(() => { g.createImageBitmap = saved.createImageBitmap; g.OffscreenCanvas = saved.OffscreenCanvas; });

const Bun: any = createBun({ fs, process, childProcess, Buffer });
const decoded = (b: Buffer) => JSON.parse(b.toString('utf8'));

describe('Bun.Image', () => {
  it('metadata: the format from the bytes, the size from the decoder', async () => {
    const m = await new Bun.Image(PNG).metadata();
    expect([m.format, m.width, m.height]).toEqual(['png', 400, 300]);
    expect((await new Bun.Image(JPEG).metadata()).format).toBe('jpeg');
  });

  it("resize inside a box without enlarging, to JPEG at a quality; toBuffer is a Buffer (callers base64 it)", async () => {
    const out = await new Bun.Image(Buffer.from(PNG)).resize(200, 200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 50 }).toBuffer();
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(decoded(out)).toEqual({ canvas: '200x150', type: 'image/jpeg', quality: 0.5, ops: ['fill', 'rotate 0', 'draw 200x150'] });
    const same = decoded(await new Bun.Image(PNG).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());
    expect(same.canvas).toBe('400x300');
  });

  it('rotate by quarter turns turns the canvas; an unchanged image is its own bytes', async () => {
    const r = decoded(await new Bun.Image(PNG).rotate(90).png().toBuffer());
    expect([r.canvas, r.ops]).toEqual(['300x400', ['rotate 90', 'draw 400x300']]);
    expect([...await new Bun.Image(PNG).png().toBuffer()]).toEqual([...PNG]);
    expect(decoded(await new Bun.Image(PNG).webp({ quality: 90 }).toBuffer()).type).toBe('image/webp');
  });

  it('maxPixels: a larger image fails to decode', async () => {
    await expect(new Bun.Image(PNG, { maxPixels: 1000 }).metadata()).rejects.toMatchObject({ code: 'ERR_IMAGE_DECODE_FAILED' });
    await expect(new Bun.Image(PNG, { maxPixels: 1000 }).resize(10, 10).toBuffer()).rejects.toMatchObject({ code: 'ERR_IMAGE_DECODE_FAILED' });
    expect((await new Bun.Image(PNG, { maxPixels: 120_000 }).metadata()).width).toBe(400);
  });
});
