/**
 * tabcomputer#92: in the page, the shell of a node child (`sh -c`, exec(),
 * spawnSync) is a process of its own: its `$$` isn't the shell that runs node,
 * so `spawnSync('sh', ['-c', 'kill -9 $$'])` ends the child, not the caller.
 * And from #106: a multi-line `sh -c` run as a kernel process has the
 * process's pid as `$$` (it was an in-page number, 40000 and up).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { Process } from '@shiro/kernel/process';
import { BufferFile } from '@shiro/kernel/fd';
import { O_RDONLY } from '@shiro/kernel/abi';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

const NODE = 'TABCOMPUTER_NODE_WORKER=0 node';
// (printf, not echo: a plain `echo …` is answered without a shell, child-process.ts getSyncResponse)

async function run(script: string, line: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/p92', { recursive: true });
  await fs.writeFile('/tmp/p92/a.js', script);
  let out = '';
  const code = await shell.execute(line, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe("a node child's shell in the page (#92)", () => {
  it("its $$ is its own, not the caller's", async () => {
    const { out } = await run(`
const cp = require('child_process');
const a = cp.spawnSync('sh', ['-c', 'printf "%s\\n" $$']).stdout.toString().trim();
const b = cp.execSync('printf "%s\\n" $$').toString().trim();
console.log('child', a, b);
`, `sh -c 'echo caller $$; ${NODE} /tmp/p92/a.js'`);
    const caller = out.match(/caller (\d+)/)![1];
    const [, a, b] = out.match(/child (\d+) (\d+)/)!;
    expect(a).not.toBe(caller);
    expect(b).not.toBe(caller);
    expect(a).not.toBe(b);
  });

  it("spawnSync('sh', ['-c', 'kill -9 $$']) ends the child; node and the command around it go on", async () => {
    const { out } = await run(`
const cp = require('child_process');
const r = cp.spawnSync('sh', ['-c', 'kill -9 $$; echo not reached']);
console.log('child', r.status, r.signal, JSON.stringify(String(r.stdout)));
console.log('node alive');
`, `sh -c '${NODE} /tmp/p92/a.js; echo "after $?"'; echo "outer $?"`);
    expect(out).toBe('child null SIGKILL ""\nnode alive\nafter 0\nouter 0\n');
  });

  it('only exported variables reach it', async () => {
    const { out } = await run(`console.log(JSON.stringify(require('child_process').execSync('printf "[%s] [%s]\\n" "$LOCAL_ONLY" "$EXPORTED"').toString()));`,
      `LOCAL_ONLY=l; export EXPORTED=e; ${NODE} /tmp/p92/a.js`);
    expect(out).toBe('"[] [e]\\n"\n');
  });
});

describe('$$ of sh -c as a kernel process (#106)', () => {
  async function shC(script: string) {
    const { shell, fs } = await createTestShell();
    const kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
    const argv = ['sh', '-c', script];
    const env = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin' };
    const run = await kernel.findProgram('sh', new Process({ pid: -1, ppid: 1, path: 'sh', argv, env, cwd: '/tmp' }));
    let out = '';
    const p = kernel.spawn({ path: 'sh', argv, env, cwd: '/tmp', run: run!, fds: {
      0: new BufferFile('', O_RDONLY), 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { out += t; }),
    } });
    const status = await p.wait();
    return { out, pid: p.pid, status };
  }

  it('one line and several lines: the kernel pid, in subshells too', async () => {
    const one = await shC('echo "$$ $BASHPID"');
    expect(one.out).toBe(`${one.pid} ${one.pid}\n`);
    const many = await shC('a=$$\necho "$a $$ $BASHPID"\n(echo "sub $$")\necho "$(echo cs $$)"');
    expect(many.out).toBe(`${many.pid} ${many.pid} ${many.pid}\nsub ${many.pid}\ncs ${many.pid}\n`);
  });

  it('kill $$ in a multi-line script ends it', async () => {
    const r = await shC('echo before\nkill -TERM $$\necho not reached');
    expect(r.out).toBe('before\n');
  });
});
