
import type { Command } from './index';
import { parseArgs, readInput } from './flags';
import { decodeBytes, encodeText } from '../utils/byte-text';
export const base64: Command = {
  name: "base64",
  description: "Base64 encode or decode",
  async exec(ctx) {
    // (-w N, -wN, --wrap N, --wrap=N)
    const args = ctx.args.flatMap((a) => (/^--wrap=/.test(a) ? ['--wrap', a.slice(7)] : [a]));
    const { flags, values, positional } = parseArgs(args, ['w', 'wrap']);

    const decode = flags.d || flags.decode;
    const wrapArg = values.w ?? values.wrap;
    const wrap = wrapArg === undefined ? 76 : Number(wrapArg);
    if (!Number.isInteger(wrap) || wrap < 0) {
      ctx.stderr += `base64: invalid wrap size: '${wrapArg}'\n`;
      return 1;
    }
    const ignoreGarbage = flags.i || flags["ignore-garbage"];

    try {
      const { content } = await readInput(positional, () => ctx.stdin,
        ctx.fs,
        ctx.cwd,
        ctx.fs.resolvePath
      );

      let result: string;

      if (decode) {
        // Decode base64
        const cleaned = ignoreGarbage
          ? content.replace(/[^A-Za-z0-9+/=]/g, "")
          : content.replace(/\s/g, "");

        try {
          // Browser-compatible base64 decode
          const decoded: string = (globalThis as any).atob(cleaned);
          // atob gives one char per byte: as byte-exact text, written back as those bytes
          result = decodeBytes(Uint8Array.from(decoded, (c) => c.charCodeAt(0)));
        } catch (e) {
          ctx.stderr += `base64: invalid input\n`;
          return 1;
        }
      } else {
        // Encode base64
        // The input's bytes (byte-exact text: a binary file's included), not its UTF-16
        const bytes = encodeText(content);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const encoded = (globalThis as any).btoa(bin);

        // Wrap lines
        if (wrap > 0) {
          const lines: string[] = [];
          for (let i = 0; i < encoded.length; i += wrap) {
            lines.push(encoded.substring(i, i + wrap));
          }
          result = lines.join("\n");
        } else {
          result = encoded;
        }
      }

      // Decoded data is written as it is, and -w 0 output has no newline of its own (as GNU)
      ctx.stdout += decode || wrap === 0 ? result : result + (result ? "\n" : "");
      return 0;
    } catch (e: unknown) {
      ctx.stderr += `base64: ${e instanceof Error ? e.message : e}\n`;
      return 1;
    }
  },
};
