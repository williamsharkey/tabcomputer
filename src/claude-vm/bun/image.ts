/**
 * Bun.Image for claude --vm: what Claude Code does to images before it sends
 * them (the Read tool on a big screenshot, a pasted image, a BMP from the
 * clipboard, an upload's preview copy). It uses Bun.Image like sharp:
 *
 *   new Bun.Image(bytes, { maxPixels })
 *     .metadata()                          → { width, height, format }
 *     .resize(w, h, { fit: 'inside' | 'fill', withoutEnlargement })
 *     .rotate(90 | 180 | 270)
 *     .jpeg({ quality }) / .png({ ... }) / .webp({ quality, lossless })
 *     .toBuffer()                          → Buffer
 *
 * and reads failures by code (ERR_IMAGE_UNKNOWN_FORMAT, ERR_IMAGE_DECODE_FAILED,
 * ERR_IMAGE_TOO_MANY_PIXELS, ERR_IMAGE_FORMAT_UNSUPPORTED). Without it every
 * resize failed and Claude Code sent images unscaled (or not at all).
 *
 * The size comes from the file's header (PNG, JPEG, GIF, WebP, BMP); pixels
 * are decoded and encoded by the browser (createImageBitmap, OffscreenCanvas,
 * in the page and in the node worker alike). Each operation returns a new
 * image; PNG's palette and compression options are the browser's to choose.
 */

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'tiff';
type OutFormat = 'png' | 'jpeg' | 'webp';

export interface EncodePlan {
  /** Size after resizing, before rotation */
  width: number;
  height: number;
  /** cover: the part of the source to draw (x, y, w, h), else all of it */
  crop?: [number, number, number, number];
  /** Clockwise degrees: 0, 90, 180, 270 */
  rotate: number;
  format: OutFormat;
  /** 0..1 (jpeg, lossy webp); lossless webp asks for 1 */
  quality?: number;
  lossless?: boolean;
}

/** Decoding and encoding pixels: the browser's, or a test's */
export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<{ width: number; height: number; source: unknown }>;
  encode(source: unknown, plan: EncodePlan): Promise<Uint8Array>;
}

const imageError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The format by its magic bytes */
export function sniffFormat(b: Uint8Array): ImageFormat | null {
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'BM') && b.length >= 26) return 'bmp';
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^avi[fs]$/.test(brand)) return 'avif';
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return 'heic';
  }
  if ((at(0, 'II') && b[2] === 42 && b[3] === 0) || (at(0, 'MM') && b[2] === 0 && b[3] === 42)) return 'tiff';
  return null;
}

/** Width and height from the header, without decoding (null when the header doesn't say) */
export function headerSize(b: Uint8Array, format: ImageFormat): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    switch (format) {
      case 'png': return { width: dv.getUint32(16), height: dv.getUint32(20) };
      case 'gif': return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
      case 'bmp': return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) };
      case 'webp': {
        const kind = String.fromCharCode(...b.subarray(12, 16));
        if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (kind === 'VP8L') {
          const v = dv.getUint32(21, true);
          return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) };
        }
        if (kind === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
        return null;
      }
      case 'jpeg': {
        // the first start-of-frame marker (SOF0..SOF15, not DHT/JPG/DAC)
        let o = 2;
        while (o + 9 < b.length) {
          if (b[o] !== 0xff) return null;
          const m = b[o + 1];
          if (m === 0xff) { o++; continue; }
          if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
          const len = dv.getUint16(o + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
          o += 2 + len;
        }
        return null;
      }
      default: return null;
    }
  } catch {
    return null;
  }
}

/** The browser's codec, where there is one (OffscreenCanvas and createImageBitmap) */
export function browserCodec(): ImageCodec | null {
  const g = globalThis as any;
  if (typeof g.OffscreenCanvas !== 'function' || typeof g.createImageBitmap !== 'function') return null;
  return {
    async decode(bytes) {
      const bmp = await g.createImageBitmap(new Blob([bytes as BlobPart]));
      return { width: bmp.width, height: bmp.height, source: bmp };
    },
    async encode(source: any, p) {
      const turned = p.rotate === 90 || p.rotate === 270;
      const canvas = new g.OffscreenCanvas(turned ? p.height : p.width, turned ? p.width : p.height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      if (p.format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((p.rotate * Math.PI) / 180);
      const [sx, sy, sw, sh] = p.crop ?? [0, 0, source.width, source.height];
      ctx.drawImage(source, sx, sy, sw, sh, -p.width / 2, -p.height / 2, p.width, p.height);
      const type = `image/${p.format}`;
      const blob = await canvas.convertToBlob({ type, ...(p.quality !== undefined ? { quality: p.quality } : {}) });
      // (a browser that can't write the format writes PNG instead)
      if (blob.type !== type) throw imageError('ERR_IMAGE_FORMAT_UNSUPPORTED', `this browser cannot encode ${p.format}`);
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

interface Op { kind: 'resize' | 'rotate' | 'format'; w?: number; h?: number; fit?: string; noEnlarge?: boolean; deg?: number; format?: OutFormat; quality?: number; lossless?: boolean }

export function imageClass(toBuffer: (b: Uint8Array) => Uint8Array, codec: () => ImageCodec | null = browserCodec) {
  class Image {
    readonly #bytes: Uint8Array;
    readonly #maxPixels: number;
    readonly #ops: Op[];

    constructor(input: ArrayBufferView | ArrayBuffer, opts?: { maxPixels?: number }, ops: Op[] = []) {
      if (input instanceof ArrayBuffer) this.#bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) this.#bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else throw new TypeError('Bun.Image: expected bytes (a Buffer, a TypedArray or an ArrayBuffer)');
      this.#maxPixels = opts?.maxPixels ?? 268402689; // (sharp's default limit, 0x3FFF * 0x3FFF)
      this.#ops = ops;
    }

    #with(op: Op): Image { return new Image(this.#bytes, { maxPixels: this.#maxPixels }, [...this.#ops, op]); }

    resize(width?: number | null, height?: number | null, opts: { fit?: string; withoutEnlargement?: boolean } = {}): Image {
      return this.#with({ kind: 'resize', w: width ?? undefined, h: height ?? undefined, fit: opts.fit ?? 'cover', noEnlarge: !!opts.withoutEnlargement });
    }
    rotate(deg = 0): Image {
      const d = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
      return this.#with({ kind: 'rotate', deg: d });
    }
    jpeg(o: { quality?: number } = {}): Image { return this.#with({ kind: 'format', format: 'jpeg', quality: o.quality }); }
    png(_o: object = {}): Image { return this.#with({ kind: 'format', format: 'png' }); }
    webp(o: { quality?: number; lossless?: boolean } = {}): Image { return this.#with({ kind: 'format', format: 'webp', quality: o.quality, lossless: !!o.lossless }); }

    #source(): { format: ImageFormat; size: { width: number; height: number } | null } {
      const format = sniffFormat(this.#bytes);
      if (!format) throw imageError('ERR_IMAGE_UNKNOWN_FORMAT', 'Bun.Image: not an image format it knows');
      const size = headerSize(this.#bytes, format);
      if (size && size.width * size.height > this.#maxPixels) throw imageError('ERR_IMAGE_TOO_MANY_PIXELS', `Bun.Image: ${size.width}x${size.height} is over ${this.#maxPixels} pixels`);
      return { format, size };
    }

    async #decode(): Promise<{ width: number; height: number; source: unknown }> {
      const c = codec();
      if (!c) throw imageError('ERR_IMAGE_FORMAT_UNSUPPORTED', 'Bun.Image: no image decoder here (needs OffscreenCanvas)');
      let d;
      try { d = await c.decode(this.#bytes); } catch (e: any) { throw e?.code ? e : imageError('ERR_IMAGE_DECODE_FAILED', `Bun.Image: could not decode the image (${e?.message ?? e})`); }
      if (d.width * d.height > this.#maxPixels) throw imageError('ERR_IMAGE_TOO_MANY_PIXELS', `Bun.Image: ${d.width}x${d.height} is over ${this.#maxPixels} pixels`);
      return d;
    }

    /** The source's size and format (as sharp's, not changed by the operations) */
    async metadata(): Promise<{ width: number; height: number; format: ImageFormat }> {
      const { format, size } = this.#source();
      const { width, height } = size ?? await this.#decode();
      return { width, height, format };
    }

    async toBuffer(): Promise<Uint8Array> {
      const { format, size } = this.#source();
      // nothing to change: the bytes as they are
      const out = [...this.#ops].reverse().find((o) => o.kind === 'format');
      const target: OutFormat = out?.format ?? (format === 'png' || format === 'jpeg' || format === 'webp' ? format : 'png');
      if (!this.#ops.some((o) => o.kind !== 'format') && target === format && !out?.quality && !out?.lossless) return toBuffer(this.#bytes.slice());
      const d = await this.#decode();
      const plan = planOf(size ?? d, this.#ops, target, out);
      let bytes: Uint8Array;
      try { bytes = await codec()!.encode(d.source, plan); } catch (e: any) { throw e?.code ? e : imageError('ERR_IMAGE_DECODE_FAILED', `Bun.Image: could not encode the image (${e?.message ?? e})`); }
      return toBuffer(bytes);
    }
  }
  return Image;
}

/** The encode for a chain of operations on a source of this size */
export function planOf(src: { width: number; height: number }, ops: Op[], format: OutFormat, out?: Op): EncodePlan {
  let w = src.width, h = src.height, rotate = 0;
  let crop: [number, number, number, number] | undefined;
  for (const o of ops) {
    if (o.kind === 'rotate') { rotate = (rotate + (o.deg ?? 0)) % 360; continue; }
    if (o.kind !== 'resize') continue;
    // (sizes are of the image as it is now: a quarter turn swaps them)
    const turned = rotate === 90 || rotate === 270;
    const [cw, ch] = turned ? [h, w] : [w, h];
    let tw = o.w, th = o.h;
    if (tw === undefined && th === undefined) continue;
    if (tw === undefined) tw = Math.max(1, Math.round((cw * th!) / ch));
    if (th === undefined) th = Math.max(1, Math.round((ch * tw) / cw));
    let nw: number, nh: number;
    crop = undefined;
    if (o.fit === 'fill') {
      [nw, nh] = [tw, th];
      if (o.noEnlarge) { nw = Math.min(nw, cw); nh = Math.min(nh, ch); }
    } else if (o.fit === 'cover' || o.fit === 'outside') {
      const s0 = Math.max(tw / cw, th / ch);
      const s = o.noEnlarge ? Math.min(1, s0) : s0;
      if (o.fit === 'cover' && s === s0) {
        // the middle of the source, scaled to cover tw x th
        const sw = tw / s, sh = th / s;
        crop = turned ? [(ch - sh) / 2, (cw - sw) / 2, sh, sw] : [(cw - sw) / 2, (ch - sh) / 2, sw, sh];
        [nw, nh] = [tw, th];
      } else [nw, nh] = [Math.max(1, Math.round(cw * s)), Math.max(1, Math.round(ch * s))];
    } else {
      // inside / contain: the whole image within tw x th
      const s0 = Math.min(tw / cw, th / ch);
      const s = o.noEnlarge ? Math.min(1, s0) : s0;
      [nw, nh] = [Math.max(1, Math.round(cw * s)), Math.max(1, Math.round(ch * s))];
    }
    [w, h] = turned ? [nh, nw] : [nw, nh];
  }
  const quality = out?.lossless ? 1 : out?.quality !== undefined ? Math.min(1, Math.max(0, out.quality / 100)) : format === 'png' ? undefined : 0.8;
  return { width: w, height: h, ...(crop ? { crop } : {}), rotate, format, ...(quality !== undefined ? { quality } : {}), ...(out?.lossless ? { lossless: true } : {}) };
}
