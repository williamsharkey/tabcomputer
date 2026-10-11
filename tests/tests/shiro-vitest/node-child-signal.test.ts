/**
 * tabcomputer#89: a child a signal ended reports it as node does: 'exit' and then
 * 'close' with (null, 'SIGTERM'), child.exitCode null, child.signalCode set.
 * In the page a killed child reported 130 (a shell's interruption), and a node
 * child's kill() only ended its stdin, so it exited 0. In a Worker, kill() of a
 * child whose stdin wasn't piped never reached it, and a spawn() without a shell
 * ran in an `sh -c` that kill() signalled instead of the program.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function node(worker: boolean, script: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/sig', { recursive: true });
  await fs.writeFile('/tmp/sig/parent.js', script);
  let out = '';
  await shell.execute(`export TABCOMPUTER_NODE_WORKER=${worker ? 1 : 0}; node /tmp/sig/parent.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

/** spawn ARGS, kill it after `after` ms with SIG, print the events in order and the child's fields */
const killScript = (spawnArgs: string, sig: string, after = 500) => `const c = require('child_process').spawn(${spawnArgs});
const seen = [];
c.on('exit', (code, signal) => seen.push('exit ' + code + ' ' + signal));
c.on('close', (code, signal) => {
  seen.push('close ' + code + ' ' + signal);
  console.log(seen.join(', ') + ' | exitCode ' + c.exitCode + ' signalCode ' + c.signalCode + ' killed ' + c.killed);
});
setTimeout(() => c.kill(${JSON.stringify(sig)}), ${after});
`;

const expectSignalled = (out: string, sig: string) =>
  expect(out).toBe(`exit null ${sig}, close null ${sig} | exitCode null signalCode ${sig} killed true\n`);

describe.each([['page', false], ['worker', true]])('a child killed by a signal (%s mode)', (_mode, worker) => {
  it.each(['SIGTERM', 'SIGKILL'])("spawn('sleep') with stdio 'ignore', kill('%s')", async (sig) => {
    expectSignalled(await node(worker, killScript(`'sleep', ['30'], { stdio: 'ignore' }`, sig)), sig);
  }, 60_000);

  it.each(['SIGTERM', 'SIGKILL'])("spawn('sleep') with piped stdio, kill('%s')", async (sig) => {
    expectSignalled(await node(worker, killScript(`'sleep', ['30']`, sig)), sig);
  }, 60_000);

  it.each(['SIGTERM', 'SIGKILL'])("a node child waiting on its stdin, kill('%s') (#89's)", async (sig) => {
    expectSignalled(await node(worker, killScript(`'node', ['-e', 'process.stdin.on("data", () => {})']`, sig, 1500)), sig);
  }, 60_000);

  it('kill() with a signal node doesn\'t know throws ERR_UNKNOWN_SIGNAL', async () => {
    const out = await node(worker, `const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' });
try { c.kill('SIGBOGUS'); console.log('no throw'); } catch (e) { console.log(e.code); }
c.kill('SIGKILL');
`);
    expect(out).toBe('ERR_UNKNOWN_SIGNAL\n');
  }, 60_000);
});

describe('a page child that handles the signal', () => {
  it("its listener takes it: it exits as it says (5, null), killed still true", async () => {
    const out = await node(false, killScript(`'node', ['-e', 'process.on("SIGTERM", () => process.exit(5)); setTimeout(() => {}, 30000)']`, 'SIGTERM', 1500));
    expect(out).toBe('exit 5 null, close 5 null | exitCode 5 signalCode null killed true\n');
  }, 60_000);
});

describe('spawnSync and execSync (worker mode: the shell the command runs in can kill itself)', () => {
  it('spawnSync: status null, signal named', async () => {
    const out = await node(true, `const cp = require('child_process');
for (const s of ['KILL', 'TERM']) { const r = cp.spawnSync('sh', ['-c', 'kill -' + s + ' $$']); console.log(r.status, r.signal); }
const r = cp.spawnSync('sh', ['-c', 'exit 3']); console.log(r.status, r.signal);
`);
    expect(out).toBe('null SIGKILL\nnull SIGTERM\n3 null\n');
  }, 60_000);

  it("execSync's error: status null, signal named", async () => {
    const out = await node(true, `const cp = require('child_process');
try { cp.execSync('kill -TERM $$', { stdio: 'pipe' }); } catch (e) { console.log(e.status, e.signal); }
try { cp.execSync('exit 4', { stdio: 'pipe' }); } catch (e) { console.log(e.status, e.signal); }
`);
    expect(out).toBe('null SIGTERM\n4 null\n');
  }, 60_000);
});
