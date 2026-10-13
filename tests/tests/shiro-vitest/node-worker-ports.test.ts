/**
 * tabcomputer#82: worker_threads MessageChannel ports are joined, and a port
 * goes to a worker thread in a transfer list (tinypool's handshake; vitest's
 * threads pool then sends one more port per test file through that port).
 *
 * This file runs under both configs: node in the page (the worker shares the
 * thread, the port arrives as itself) and node as a kernel guest
 * (vitest.worker.config.ts: the worker is a thread of its own, and the port
 * crosses as an id over the Worker's own link).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function node(files: Record<string, string>, entry: string) {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/tmp/wp', { recursive: true });
  for (const [name, text] of Object.entries(files)) await fs.writeFile(`/tmp/wp/${name}`, text);
  let out = '', err = '';
  const code = await shell.execute(`node /tmp/wp/${entry} < /dev/null`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('worker_threads MessageChannel (#82)', () => {
  it('ports are joined: messages wait for a listener, come in order, and close reaches both ends', async () => {
    const r = await node({ 'ch.js': `const { MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { port1, port2 } = new MessageChannel();
port1.postMessage({ n: 1, nested: { list: [1, 2] } });
port1.postMessage('two');
// nothing listens yet: the first can be taken at once
console.log('sync', JSON.stringify(receiveMessageOnPort(port2)), receiveMessageOnPort(port1));
const got = [];
port2.on('message', (m) => {
  got.push(m);
  if (m === 'two') port2.postMessage('back');
});
port1.on('message', (m) => { got.push('1:' + m); port1.close(); });
port1.on('close', () => got.push('close1'));
port2.on('close', () => { console.log(JSON.stringify(got)); port2.postMessage('after close'); });
console.log('posted');
` }, 'ch.js');
    expect(r.err).toBe('');
    expect(r.out).toBe('sync {"message":{"n":1,"nested":{"list":[1,2]}}} undefined\nposted\n["two","1:back","close1"]\n');
    expect(r.code).toBe(0);
  }, 60_000);

  it("a port handed to a Worker in the transfer list carries messages both ways (tinypool's handshake)", async () => {
    const r = await node({
      'w.js': `const { parentPort } = require('worker_threads');
parentPort.on('message', (message) => {
  const { port, name } = message;
  port.on('message', (task) => { port.postMessage({ id: task.id, result: name + ':' + task.n * 2 }); });
  parentPort.postMessage({ ready: true });
});
`,
      'main.js': `const { Worker, MessageChannel, MessagePort } = require('worker_threads');
const worker = new Worker('/tmp/wp/w.js');
const { port1, port2 } = new MessageChannel();
const results = [];
worker.on('message', (m) => {
  if (!m.ready) return;
  port1.postMessage({ id: 1, n: 21 });
  port1.postMessage({ id: 2, n: 4 });
});
port1.on('message', (m) => {
  results.push(m);
  if (results.length === 2) { console.log(JSON.stringify(results)); worker.terminate(); }
});
worker.on('error', (e) => console.log('error', e.message));
worker.on('exit', () => console.log('exit'));
worker.postMessage({ name: 'double', port: port2 }, [port2]);
console.log(port2 instanceof MessagePort);
`,
    }, 'main.js');
    expect(r.err).toBe('');
    expect(r.out).toBe('true\n[{"id":1,"result":"double:42"},{"id":2,"result":"double:8"}]\nexit\n');
  }, 60_000);

  it("a port sent through a port, and one sent back by the worker (vitest's threads pool)", async () => {
    const r = await node({
      'w.js': `const { parentPort, MessageChannel } = require('worker_threads');
parentPort.once('message', ({ port }) => {
  // each task brings a port of its own to answer on
  port.on('message', ({ file, rpc }) => {
    rpc.on('message', (m) => { rpc.postMessage('ran ' + file + ' ' + m); });
    rpc.postMessage('online ' + file);
  });
  // and the worker makes one, keeps an end, and gives the parent the other
  const back = new MessageChannel();
  back.port1.on('message', (m) => { back.port1.postMessage(m.toUpperCase()); });
  parentPort.postMessage({ ready: true, back: back.port2 }, [back.port2]);
});
`,
      'main.js': `const { Worker, MessageChannel } = require('worker_threads');
const worker = new Worker('/tmp/wp/w.js');
const pool = new MessageChannel();
const out = [];
const done = () => { if (out.length === 5) { console.log(out.sort().join('|')); worker.terminate(); } };
worker.on('message', ({ ready, back }) => {
  if (!ready) return;
  back.on('message', (m) => { out.push('back ' + m); done(); });
  back.postMessage('shout');
  for (const file of ['a.test.js', 'b.test.js']) {
    const task = new MessageChannel();
    task.port2.on('message', (m) => {
      out.push(m);
      if (m.startsWith('online')) task.port2.postMessage('go'); else task.port2.close();
      done();
    });
    pool.port1.postMessage({ file, rpc: task.port1 }, [task.port1]);
  }
});
worker.on('exit', () => console.log('exit'));
worker.postMessage({ port: pool.port2 }, [pool.port2]);
`,
    }, 'main.js');
    expect(r.err).toBe('');
    expect(r.out).toBe('back SHOUT|online a.test.js|online b.test.js|ran a.test.js go|ran b.test.js go\nexit\n');
  }, 60_000);

  it('a worker that listens only on the port it was given stays up; a port it closes is closed at the other end', async () => {
    const r = await node({
      'w.js': `const { parentPort } = require('worker_threads');
parentPort.once('message', ({ port }) => {
  port.on('message', (m) => { if (m === 'stop') port.close(); else port.postMessage('got ' + m); });
});
`,
      'main.js': `const { Worker, MessageChannel } = require('worker_threads');
const worker = new Worker('/tmp/wp/w.js');
const { port1, port2 } = new MessageChannel();
worker.postMessage({ port: port2 }, [port2]);
port1.on('message', (m) => { console.log(m); if (m === 'got late') port1.postMessage('stop'); });
port1.on('close', () => { console.log('port closed'); worker.terminate(); });
worker.on('exit', (code) => console.log('exit', code));
port1.postMessage('early');
setTimeout(() => port1.postMessage('late'), 300);
`,
    }, 'main.js');
    expect(r.err).toBe('');
    expect(r.out).toBe('got early\ngot late\nport closed\nexit 0\n');
  }, 60_000);
});
