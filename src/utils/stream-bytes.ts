/**
 * Bytes through a TransformStream ((De)CompressionStream), fed a MiB at a time.
 * Chromium runs the zlib work on the calling thread inside each write: one
 * write of a 45 MB archive was a 0.8 s task for the page (#19). Between writes
 * the page runs. A corrupt stream rejects the reads, and that error is thrown.
 */
const FEED = 1 << 20;

export async function pipeBytes(data: Uint8Array, stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const fed = (async () => {
    for (let off = 0; off < data.byteLength; off += FEED) {
      await writer.write(data.subarray(off, off + FEED) as BufferSource);
      if (off + FEED < data.byteLength) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await writer.close();
  })();
  fed.catch(() => {}); // (the reader below reports a corrupt stream)
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await fed;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
