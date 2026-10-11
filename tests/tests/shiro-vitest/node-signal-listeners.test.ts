/**
 * tabcomputer#91: process.on('SIGTERM') (SIGINT, SIGHUP, SIGUSR1/2...) listeners run when
 * the signal comes, as node's: with a listener for a catchable signal the default action
 * (ending the process) doesn't apply; with none (or once it is removed) it does; SIGKILL
 * and SIGSTOP can't be caught. A signal from the kernel (`kill PID`, a parent's
 * child.kill()) ended the process with 143 whatever it listened for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

/** CMD in a shell, with /tmp/s/child.js holding CHILD (and parent.js PARENT) */
async function sh(worker: boolean, cmd: string, child: string, parent = '') {
  const { shell, fs } = await createTestShell();
  await shell.execute('rm -rf /tmp/s', () => {});
  await fs.mkdir('/tmp/s', { recursive: true });
  await fs.writeFile('/tmp/s/child.js', child);
  if (parent) await fs.writeFile('/tmp/s/parent.js', parent);
  let out = '';
  await shell.execute(`export TABCOMPUTER_NODE_WORKER=${worker ? 1 : 0}; ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
  // (a shell with job control says `[1] PID` for `&`)
  return out.replace(/\r\n/g, '\n').replace(/^\[\d+\] \d+\n/gm, '');
}

// Each child says 'ready' once its listeners are on, then waits
const CHILDREN = {
  server: `const s = require('http').createServer((q, r) => r.end('hi')).listen(0, () => console.log('ready'));
process.on('SIGTERM', (name) => { console.log('closing on ' + name); s.close(() => process.exit(0)); });`,
  logOnly: `process.on('SIGTERM', (name) => console.log('got ' + name + ', running on'));
setTimeout(() => console.log('natural end'), 1500);
console.log('ready');`,
  removed: `const h = () => console.log('should not run');
process.on('SIGTERM', h);
process.removeListener('SIGTERM', h);
setTimeout(() => console.log('should not end naturally'), 5000);
console.log('ready');`,
  usr1: `process.on('SIGUSR1', () => console.log('usr1'));
setTimeout(() => console.log('natural end'), 1500);
console.log('ready');`,
  killNine: `process.on('SIGTERM', () => console.log('should not run'));
setTimeout(() => console.log('should not end naturally'), 5000);
console.log('ready');`,
};

/** A parent that spawns the child, sends SIG once it is ready, and prints what it saw */
const parentKilling = (sig: string) => `const c = require('child_process').spawn('node', [__dirname + '/child.js']);
c.stdout.on('data', (d) => { for (const l of String(d).trim().split('\\n')) { if (l === 'ready') c.kill(${JSON.stringify(sig)}); else console.log('child: ' + l); } });
c.on('exit', (code, signal) => console.log('exit', code, signal));
`;

describe.each([['page', false], ['worker', true]])('process.on(signal) (%s mode)', (_mode, worker) => {
  it.each([
    ['a server that closes and exits 0 on SIGTERM', 'server', 'SIGTERM', 'child: closing on SIGTERM\nexit 0 null\n'],
    ['a listener that only logs: it runs on to its natural end', 'logOnly', 'SIGTERM', 'child: got SIGTERM, running on\nchild: natural end\nexit 0 null\n'],
    ['a listener removed: the default again', 'removed', 'SIGTERM', 'exit null SIGTERM\n'],
    ['SIGUSR1 with a listener', 'usr1', 'SIGUSR1', 'child: usr1\nchild: natural end\nexit 0 null\n'],
    ['SIGKILL can\'t be caught', 'killNine', 'SIGKILL', 'exit null SIGKILL\n'],
  ])("a parent's child.kill(): %s", async (_name, child, sig, want) => {
    const out = await sh(worker, 'node /tmp/s/parent.js < /dev/null', CHILDREN[child as keyof typeof CHILDREN], parentKilling(sig));
    expect(out).toBe(want);
  }, 60_000);

  // (in page mode a server's script returns once it is idle, and its servers serve on from
  // the page: there is no process left for `kill PID`, node-compat/execution.ts)
  it.each([
    ...(worker ? [['server', 'TERM', 'closing on SIGTERM\nstatus 0\n']] : []),
    ['logOnly', 'TERM', 'got SIGTERM, running on\nnatural end\nstatus 0\n'],
    ['removed', 'TERM', 'status 143\n'],
    ['killNine', 'KILL', 'status 137\n'],
  ])('`node %s &`, then `kill -%s $!`: the status wait sees', async (child, sig, want) => {
    const out = await sh(worker, `node /tmp/s/child.js > /tmp/s/out 2>&1 < /dev/null & p=$!
for i in $(seq 1 100); do grep -q ready /tmp/s/out 2>/dev/null && break; sleep 0.1; done
kill -${sig} $p; wait $p; st=$?; grep -v '^ready$' /tmp/s/out; echo "status $st"`, CHILDREN[child as keyof typeof CHILDREN]);
    expect(out).toBe(want);
  }, 60_000);
});
