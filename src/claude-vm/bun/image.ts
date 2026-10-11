/**
 * Bun.Image for claude --vm: Claude Code's image pipeline (the Read tool on
 * images, pasted images, compression to the API's limits, attachment previews)
 * makes `new Bun.Image(bytes)` and chains metadata(), resize(w, h, { fit,
 * withoutEnlargement }), rotate(deg), jpeg/png/webp({ quality }) and
 * toBuffer(), as sharp does. Without it every image that needed resizing
 * failed ("Unable to resize image"). It is node-compat's browser sharp
 * (createImageBitmap and a canvas, in the page or a Worker).
 */
import { createBrowserSharp } from '../../node-compat/shims/browser-sharp';

export function createImageClass(toBuffer: (b: Uint8Array) => unknown): new (input: unknown, opts?: { maxPixels?: number }) => any {
  const sharp = createBrowserSharp(
    toBuffer,
    async () => { throw new Error('Bun.Image: a path is not an image here'); },
    async () => { throw new Error('Bun.Image: write() is not available here'); },
  );
  return class Image {
    constructor(input: unknown, opts?: { maxPixels?: number }) {
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input)
        : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
      if (!bytes) throw new TypeError('Bun.Image: expected the image\'s bytes');
      const img = sharp(bytes);
      const max = opts?.maxPixels;
      if (!max) return img;
      // Decoding more pixels than the caller allows fails, as Bun's does
      const { metadata, toBuffer: out } = img;
      const tooLarge = async () => {
        const m = await metadata();
        if (m.width * m.height > max) throw Object.assign(new Error(`Image is ${m.width}x${m.height}, over ${max} pixels`), { code: 'ERR_IMAGE_DECODE_FAILED' });
      };
      img.metadata = async () => { await tooLarge(); return metadata(); };
      img.toBuffer = async (o?: unknown) => { await tooLarge(); return out(o); };
      return img;
    }
  } as any;
}
