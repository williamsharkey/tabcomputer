/**
 * tabcomputer#132: an open MessagePort that is ref'd keeps node running, and
 * unref() releases it. emnapi holds node open so while an async napi task is
 * pending: ref() on a port of the global MessageChannel that nothing listens
 * to. The expected output is node 26's for the same scripts.
 *
 * Runs under both configs (node in the page, and as a kernel guest).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

/** Something that answers later without a timer or anything else the runner counts, as a napi task does */
const LATER = 'const later = (ms) => Atomics.waitAsync(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms).value;\n';

async function node(files: Record<string, string>, args: string) {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/tmp/pr', { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(`/tmp/pr/${name}`, text);
  let out = '', err = '';
  const code = await shell.execute(`node /tmp/pr/${args} < /dev/null`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

const HELD = `${LATER}const port = new MessageChannel().port1;
if (process.argv[2] !== 'no') port.ref();
console.log('pending', port.hasRef());
later(300).then(() => { console.log('answer'); port.unref(); console.log('released', port.hasRef()); });
`;

const LISTEN = `${LATER}const { port1, port2 } = new MessageChannel();
const how = process.argv[2];
const got = (m) => { console.log('got', m); if (how === 'close') port2.close(); if (how === 'off') port1.off('message', got); console.log('ref', port1.hasRef()); };
port1.on('message', got);
port1.on('close', () => console.log('closed'));
if (how === 'unref') port1.unref();
later(200).then(() => { console.log('post'); port2.postMessage(1); });
`;

describe("a ref'd MessagePort is an open handle (#132)", () => {
  it('ref() on a port nothing listens to holds node open until unref()', async () => {
    const r = await node({ 'held.js': HELD }, 'held.js');
    expect(r.err).toBe('');
    expect([r.code, r.out]).toEqual([0, 'pending true\nanswer\nreleased false\n']);
  }, 60_000);

  it('a port that was never ref\'d holds nothing: node ends before the answer', async () => {
    const r = await node({ 'held.js': HELD }, 'held.js no');
    expect([r.code, r.out]).toEqual([0, 'pending false\n']);
  }, 60_000);

  it('the global MessageChannel is worker_threads\', in a module too; listeners ref and unref as in node', async () => {
    const r = await node({
      'lib.js': "exports.same = MessageChannel === require('worker_threads').MessageChannel && typeof new MessageChannel().port1.unref === 'function';\n",
      'refs.js': `const wt = require('worker_threads');
const lib = require('./lib.js');
console.log(MessageChannel === wt.MessageChannel, globalThis.MessagePort === wt.MessagePort, lib.same);
const { port1, port2 } = new MessageChannel();
const seen = [port1.hasRef()];
port1.on('message', () => {}); seen.push(port1.hasRef());
port1.unref(); seen.push(port1.hasRef());
port1.on('message', () => {}); seen.push(port1.hasRef());
port1.removeAllListeners('message'); seen.push(port1.hasRef());
port1.onmessage = () => {}; seen.push(port1.hasRef());
port1.onmessage = null; seen.push(port1.hasRef());
port1.once('message', (m) => { seen.push(m, port1.hasRef()); setImmediate(() => { seen.push(port1.hasRef()); console.log(seen.join(' ')); }); });
seen.push(port1.hasRef());
port2.postMessage('hi');
`,
    }, 'refs.js');
    expect(r.err).toBe('');
    expect([r.code, r.out]).toEqual([0, 'true true true\nfalse true false false false true false true hi false false\n']);
  }, 60_000);

  it('a listened port holds node open until it is closed, its listener removed, or unref()', async () => {
    const files = { 'listen.js': LISTEN };
    expect((await node(files, 'listen.js close')).out).toBe('post\ngot 1\nref true\nclosed\n');
    expect((await node(files, 'listen.js off')).out).toBe('post\ngot 1\nref false\n');
    expect((await node(files, 'listen.js unref')).out).toBe('');
  }, 60_000);
});
