/**
 * child_process.spawn() gives a child a pipe for stdin that stays open until the
 * parent ends it, and most parents never do. A child that doesn't read it ends
 * all the same, as node's does. As a kernel guest `sudo` (and `sh -c 'sudo …'`)
 * never did: it read its stdin to the end to hand it to its command, so an
 * app's `sudo apt-get install` under spawn() hung (docs/research/APP_MAKER.md,
 * gap 5); `timeout` and `setsid` the same. The commands that run another now
 * leave fd 0 to it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: (() => void) | undefined;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function node(script: string, pre: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/ss', { recursive: true });
  await fs.writeFile('/tmp/ss/a.js', script);
  let out = '';
  await shell.execute(`${pre}node /tmp/ss/a.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}
/** The child `spawnExpr` starts: its exit, then its close with what it wrote; HUNG if neither came in 15 s */
const run = (spawnExpr: string) => `
const cp = require('child_process');
const c = ${spawnExpr};
let so = '';
c.stdout.on('data', (d) => { so += d; });
c.on('exit', (code) => console.log('exit', code));
c.on('close', (code) => { clearTimeout(guard); console.log('close', code, JSON.stringify(so)); });
const guard = setTimeout(() => { console.log('HUNG'); process.exit(9); }, 15000);
`;

const MODES = [['in the page', 'export TABCOMPUTER_NODE_WORKER=0; '], ['as a guest', 'export TABCOMPUTER_NODE_WORKER=1; ']];

describe.each(MODES)('spawn with a piped stdin the parent never ends, %s', (mode, pre) => {
  it.each([
    ['sudo', `cp.spawn('sudo', ['echo', 'hi'], { stdio: ['pipe', 'pipe', 'pipe'] })`, 'hi\n'],
    ['sh -c sudo', `cp.spawn('sh', ['-c', 'sudo echo hi'])`, 'hi\n'],
    ['sh -c', `cp.spawn('sh', ['-c', 'echo one; sleep 0.2; echo two'])`, 'one\ntwo\n'],
    ['echo', `cp.spawn('echo', ['hi'])`, 'hi\n'],
    ['timeout', `cp.spawn('timeout', ['10', 'echo', 'hi'])`, 'hi\n'],
    ['env', `cp.spawn('env', ['A=1', 'printenv', 'A'])`, '1\n'],
    ['setsid', `cp.spawn('setsid', ['echo', 'hi'])`, 'hi\n'],
    ['sh -c setsid, timeout', `cp.spawn('sh', ['-c', 'setsid echo b; timeout 10 echo c'])`, 'b\nc\n'],
  ])('%s ends', async (_, expr, want) => {
    expect(await node(run(expr), pre)).toBe(`exit 0\nclose 0 ${JSON.stringify(want)}\n`);
  }, 60_000);

  // (in the page a child that isn't node has no stdin of its parent's: what it writes goes nowhere)
  it.skipIf(mode === 'in the page').each([
    ['sudo cat', `cp.spawn('sudo', ['cat']); c.stdin.end('typed\\n')`],
    ['sh -c sudo cat', `cp.spawn('sh', ['-c', 'sudo cat']); c.stdin.end('typed\\n')`],
    ['sh -c nohup cat', `cp.spawn('sh', ['-c', 'nohup cat 2>/dev/null']); c.stdin.end('typed\\n')`],
    ['setsid cat', `cp.spawn('setsid', ['cat']); c.stdin.end('typed\\n')`],
  ])('%s: what the parent does write reaches the command', async (_, expr) => {
    expect(await node(run(expr), pre)).toBe('exit 0\nclose 0 "typed\\n"\n');
  }, 60_000);
});
