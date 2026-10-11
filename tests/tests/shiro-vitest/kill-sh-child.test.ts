/**
 * tabcomputer#90: killing a node's `sh -c` child (spawn('sh', ['-c', …]), exec(),
 * spawn({ shell: true })) killed that node too, and the command around it. The
 * shell's end aborted its job, and the job's processes, still in the host's
 * process group, were signalled as a group: kill(-pgid, SIGINT) reached the
 * node that spawned the shell (shell-kernel.ts signalJob). And exec()'s kill()
 * did nothing: its child ran on (at full CPU, for a busy one).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

/** `node parent.js; echo after $?` (worker mode): the parent's lines, then whether the command went on */
async function run(script: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/k90', { recursive: true });
  await fs.writeFile('/tmp/k90/parent.js', script);
  let out = '';
  await shell.execute('export TABCOMPUTER_NODE_WORKER=1; node /tmp/k90/parent.js < /dev/null; echo "after $?"', (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

// The grandchild prints its pid, then spins; the parent kills the shell around it,
// then checks the grandchild is gone (not orphaned) and that it is itself alive
const grandchild = `node -e "console.log(process.pid); setInterval(() => {}, 1000)"`;
const afterKill = `
let gpid = 0;
const gone = () => { try { process.kill(gpid, 0); return 'grandchild alive'; } catch (e) { return 'grandchild ' + e.code; } };
`;

describe("killing a node's sh -c child", () => {
  it.each(['SIGTERM', 'SIGKILL'])("spawn('sh', ['-c', …]).kill('%s'): the child ends by it; the parent and the command go on", async (sig) => {
    const out = await run(`${afterKill}
const c = require('child_process').spawn('sh', ['-c', ${JSON.stringify(grandchild)}]);
c.stdout.on('data', (d) => { if (!gpid) { gpid = Number(String(d).trim()); c.kill(${JSON.stringify(sig)}); } });
c.on('exit', (code, signal) => setTimeout(() => { console.log('exit', code, signal, gone()); console.log('parent alive'); }, 1000));
`);
    expect(out).toBe(`exit null ${sig} grandchild ESRCH\nparent alive\nafter 0\n`);
  }, 60_000);

  it("spawn(cmd, { shell: true }).kill()", async () => {
    const out = await run(`${afterKill}
const c = require('child_process').spawn(${JSON.stringify(grandchild)}, { shell: true });
c.stdout.on('data', (d) => { if (!gpid) { gpid = Number(String(d).trim()); c.kill(); } });
c.on('exit', (code, signal) => setTimeout(() => { console.log('exit', code, signal, gone()); console.log('parent alive'); }, 1000));
`);
    expect(out).toBe('exit null SIGTERM grandchild ESRCH\nparent alive\nafter 0\n');
  }, 60_000);

  it("exec(…).kill(): it reaches the child (it was a no-op), the callback says so, the parent goes on", async () => {
    const out = await run(`
const c = require('child_process').exec('sleep 30', (err) => console.log('callback', err && err.code, err && err.killed, err && err.signal));
c.on('exit', (code, signal) => console.log('exit', code, signal, c.exitCode, c.signalCode, c.killed));
// (its real pid, which the kernel knows, once it runs)
setTimeout(() => { let real; try { process.kill(c.pid, 0); real = true; } catch { real = false; } console.log('pid is real', real); c.kill(); }, 500);
setTimeout(() => console.log('parent alive'), 2000);
`);
    expect(out).toBe('pid is real true\nexit null SIGTERM null SIGTERM true\ncallback null true SIGTERM\nparent alive\nafter 0\n');
  }, 60_000);

  it('a child that exits by itself still reports its code', async () => {
    const out = await run(`require('child_process').exec('exit 3', (err) => console.log('callback', err.code, err.killed, err.signal)).on('exit', (code, signal) => console.log('exit', code, signal));
`);
    expect(out).toBe('exit 3 null\ncallback 3 false null\nafter 0\n');
  }, 60_000);
});
