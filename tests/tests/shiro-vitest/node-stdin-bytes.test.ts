/**
 * process.stdin's chunks are byte-exact Buffers unless setEncoding() was
 * called, as in node: 'data', read() and for await. Both configs: the page's
 * node here, a guest's under test:worker.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

async function run(cmd: string, code: string) {
  await fs.writeFile('/tmp/stdin-bytes.js', code);
  let out = '', err = '';
  const status = await shell.execute(cmd.replace('SCRIPT', 'node /tmp/stdin-bytes.js'), (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status };
}

describe('process.stdin chunks', () => {
  it("'data' gives Buffers of the bytes as piped, non-UTF-8 included", async () => {
    const r = await run("printf '\\x80\\xffh\\xc3\\xa9' | SCRIPT", `const parts = [];
process.stdin.on('data', (d) => parts.push(d));
process.stdin.on('end', () => { const b = Buffer.concat(parts); console.log(parts.every((p) => Buffer.isBuffer(p)), b.toString('hex')); });`);
    expect(r, JSON.stringify(r)).toMatchObject({ out: 'true 80ff68c3a9\n', status: 0 });
  });
  it('setEncoding gives strings', async () => {
    const r = await run("printf 'h\\xc3\\xa9' | SCRIPT", `process.stdin.setEncoding('utf8');
let s = ''; process.stdin.on('data', (d) => { s += typeof d + ':' + d; });
process.stdin.on('end', () => console.log(s));`);
    expect(r, JSON.stringify(r)).toMatchObject({ out: 'string:hé\n', status: 0 });
  });
  it('for await and read() give Buffers', async () => {
    const a = await run("printf '\\x01\\xfe' | SCRIPT", `(async () => {
  const parts = []; for await (const c of process.stdin) parts.push(c);
  console.log(parts.every(Buffer.isBuffer), Buffer.concat(parts).toString('hex'));
})();`);
    expect(a, JSON.stringify(a)).toMatchObject({ out: 'true 01fe\n', status: 0 });
    const b = await run("printf 'ab' | SCRIPT", `process.stdin.on('readable', () => { const c = process.stdin.read(); if (c !== null) console.log(Buffer.isBuffer(c), String(c)); });`);
    expect(b, JSON.stringify(b)).toMatchObject({ out: 'true ab\n', status: 0 });
  });
});
