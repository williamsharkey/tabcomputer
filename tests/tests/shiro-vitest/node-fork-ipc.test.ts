/**
 * fork() with its default stdio (stdout and stderr inherited): the IPC
 * channel works both ways. runChild treated a child whose outputs weren't
 * its own as done at once and closed the channel, so the child started
 * disconnected and send() failed with "Channel closed" (vitest 3's forks
 * pool, through tinypool, ran no tests and exited 0). And process.exit() in a
 * listener of the channel's events ended the child with status 1: its unwinding
 * ProcessExitError escaped the Worker timer that delivers them ("Uncaught Error:
 * process.exit(0)" in dmesg; under worker_threads every time).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function sh(cmd: string, prep: (fs: any) => Promise<void>) {
  const { shell, fs } = await createTestShell();
  await prep(fs);
  let out = '';
  await shell.execute(`export TABCOMPUTER_NODE_WORKER=1; ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

const child = `process.on('message', (m) => { if (m === 'bye') process.exit(0); process.send({ echo: m }); });
process.send({ ready: true, connected: process.connected });
`;
const parent = (opts: string) => `const { fork } = require('child_process');
const c = fork(__dirname + '/child.js', [], ${opts});
c.on('message', (m) => { console.log('got', JSON.stringify(m)); if (m.ready) c.send('hi'); else if (m.echo === 'hi') c.send('bye'); });
c.on('exit', (code) => console.log('exit', code));
`;

describe('fork() IPC', () => {
  it.each([
    ['default stdio (inherited output)', '{}'],
    ["serialization: 'advanced'", "{ serialization: 'advanced' }"],
    ['silent (piped output)', '{ silent: true }'],
  ])('%s: messages both ways, then the child exits', async (_name, opts) => {
    const out = await sh('node /tmp/fk/parent.js < /dev/null', async (fs) => {
      await fs.mkdir('/tmp/fk', { recursive: true });
      await fs.writeFile('/tmp/fk/child.js', child);
      await fs.writeFile('/tmp/fk/parent.js', parent(opts));
    });
    expect(out).toBe('got {"ready":true,"connected":true}\ngot {"echo":"hi"}\nexit 0\n');
  }, 60_000);

  it.each([
    ["exit(0) in a 'disconnect' listener", "process.on('disconnect', () => process.exit(0)); process.send('up');", 'c.disconnect()', 'exit 0'],
    ["exit(3) in a 'message' listener", "process.on('message', () => process.exit(3)); process.send('up');", "c.send('go')", 'exit 3'],
  ])('%s: that status, not a crash', async (_name, childSrc, act, want) => {
    const out = await sh('node /tmp/fk2/parent.js < /dev/null', async (fs) => {
      await fs.mkdir('/tmp/fk2', { recursive: true });
      await fs.writeFile('/tmp/fk2/child.js', childSrc + '\n');
      await fs.writeFile('/tmp/fk2/parent.js', `const c = require('child_process').fork(__dirname + '/child.js', [], { silent: true });
c.stderr.on('data', (d) => console.log('stderr', String(d).trim()));
c.on('message', () => ${act});
c.on('exit', (code) => console.log('exit', code));
`);
    });
    expect(out).toBe(want + '\n');
  }, 60_000);
});
