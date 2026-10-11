/**
 * node's command line (src/commands/jseval/node-args.ts): options before the
 * script are node's, not the script (williamsharkey/tabcomputer#33), and
 * NODE_OPTIONS's too; child streams pipe. Both configs: the page's node here,
 * a guest's under `npm run test:worker`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { parseNodeArgs, splitNodeOptions, parseEnvFile } from '@shiro/commands/jseval/node-args';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/nopt', { recursive: true });
  await fs.writeFile('/tmp/nopt/p.js', 'console.log("ran", JSON.stringify(process.execArgv), JSON.stringify(process.argv.slice(2)));\n');
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  return { out: lf(out), err: lf(err), code };
}

describe('tabcomputer#33: options before the script', () => {
  it.each([
    ['--no-warnings', '["--no-warnings"]'],
    ['--enable-source-maps', '["--enable-source-maps"]'],
    ['--conditions node', '["--conditions","node"]'],
    ['-C node', '["-C","node"]'],
    ['--max-old-space-size=100', '["--max-old-space-size=100"]'],
    ['--experimental-vm-modules --no-deprecation', '["--experimental-vm-modules","--no-deprecation"]'],
    ['--stack-size 2000 --trace-warnings', '["--stack-size","2000","--trace-warnings"]'],
  ])('node %s p.js runs p.js, with process.execArgv', async (opts, execArgv) => {
    expect(await sh(`cd /tmp/nopt && node ${opts} p.js a -x`)).toEqual({ out: `ran ${execArgv} ["a","-x"]\n`, err: '', code: 0 });
  });

  it('options the work of which is not done here: a warning, then the script runs', async () => {
    const r = await sh('cd /tmp/nopt && node --inspect --watch --frobnicate p.js');
    expect(r.out).toBe('ran ["--inspect","--watch","--frobnicate"] []\n');
    expect(r.err).toBe([
      'node: warning: --inspect is not supported here; ignored',
      'node: warning: --watch is not supported here; ignored',
      'node: warning: --frobnicate is not supported here; ignored', ''].join('\n'));
    expect(r.code).toBe(0);
  });

  it('NODE_OPTIONS: its options apply, and stay out of execArgv (as node)', async () => {
    expect((await sh(`cd /tmp/nopt && NODE_OPTIONS='--no-warnings --max-old-space-size=4096' node p.js`)).out).toBe('ran [] []\n');
    await fs.writeFile('/tmp/nopt/warn.js', 'process.emitWarning("careful"); console.log("after");\n');
    expect(await sh('cd /tmp/nopt && NODE_OPTIONS=--no-warnings node warn.js')).toEqual({ out: 'after\n', err: '', code: 0 });
    expect((await sh('cd /tmp/nopt && node warn.js')).err).toMatch(/Warning: careful/);
    const bad = await sh(`NODE_OPTIONS='-e 1' node -p 2`);
    expect([bad.code, bad.err]).toEqual([9, 'node: -e is not allowed in NODE_OPTIONS\n']);
  });

  it('-r / --require and --import load modules first, from the working directory', async () => {
    await fs.writeFile('/tmp/nopt/pre.cjs', 'globalThis.__pre = (globalThis.__pre || "") + "r"; process.env.FROM_PRELOAD = "yes";\n');
    await fs.writeFile('/tmp/nopt/pre.mjs', 'globalThis.__pre = (globalThis.__pre || "") + "i";\n');
    await fs.writeFile('/tmp/nopt/use.js', 'console.log(globalThis.__pre, process.env.FROM_PRELOAD); delete globalThis.__pre;\n');
    expect((await sh('cd /tmp/nopt && node -r ./pre.cjs --import ./pre.mjs use.js')).out).toBe('ri yes\n');
    expect((await sh('cd /tmp/nopt && node --require=./pre.cjs use.js')).out).toBe('r yes\n');
  });

  it('--env-file sets variables under the environment\'s own', async () => {
    await fs.writeFile('/tmp/nopt/.env', '# config\nA=1\nexport B="two words"\nC=from-file\n');
    await fs.writeFile('/tmp/nopt/env.js', 'console.log(process.env.A, process.env.B, process.env.C);\n');
    expect((await sh('cd /tmp/nopt && C=from-env node --env-file=.env env.js')).out).toBe('1 two words from-env\n');
    expect((await sh('cd /tmp/nopt && node --env-file-if-exists=nope.env env.js')).out).toBe('undefined undefined undefined\n');
    expect((await sh('cd /tmp/nopt && node --env-file nope.env env.js')).code).toBe(9);
  });

  it('-e/-p with options and arguments, -pe, -, --', async () => {
    expect((await sh(`node --no-warnings -e 'console.log(process.argv.slice(1))' a b`)).out).toBe("[ 'a', 'b' ]\n");
    expect((await sh(`node -pe '6*7'`)).out).toBe('42\n');
    expect((await sh(`echo 'console.log("from stdin", process.argv.slice(2))' | node --no-warnings - x`)).out).toBe("from stdin [ 'x' ]\n");
    expect((await sh('cd /tmp/nopt && node --no-warnings -- p.js --not-an-option')).out).toBe('ran ["--no-warnings"] ["--not-an-option"]\n');
  });

  it('a #! line with node\'s options: `env -S node --no-warnings`, `node --no-deprecation`', async () => {
    await fs.writeFile('/tmp/nopt/s1.js', '#!/usr/bin/env -S node --no-warnings\nconsole.log("s1", JSON.stringify(process.execArgv), JSON.stringify(process.argv.slice(2)));\n');
    await fs.writeFile('/tmp/nopt/s2.js', '#!/usr/local/bin/node --no-deprecation\nconsole.log("s2", JSON.stringify(process.execArgv));\n');
    expect((await sh('cd /tmp/nopt && chmod +x s1.js s2.js && ./s1.js q && ./s2.js')).out).toBe('s1 ["--no-warnings"] ["q"]\ns2 ["--no-deprecation"]\n');
  });

  it('--check: the syntax only', async () => {
    await fs.writeFile('/tmp/nopt/bad.js', 'let x = ;\n');
    expect(await sh('cd /tmp/nopt && node --check p.js')).toEqual({ out: '', err: '', code: 0 });
    const r = await sh('cd /tmp/nopt && node -c bad.js');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^\/tmp\/nopt\/bad\.js\nSyntaxError: /);
  });

  it('an option missing its value: node\'s exit 9', async () => {
    expect(await sh('node --require')).toEqual({ out: '', err: 'node: --require requires an argument\n', code: 9 });
  });

  it('fork(…, { execArgv }) runs node with those options', async () => {
    await fs.writeFile('/tmp/nopt/fork.js', `const { fork } = require('child_process');
const c = fork('/tmp/nopt/p.js', ['k'], { execArgv: ['--no-warnings', '--conditions', 'node'] });
c.on('exit', (code) => console.log('child exit', code));
`);
    expect((await sh('node /tmp/nopt/fork.js')).out).toBe('ran ["--no-warnings","--conditions","node"] ["k"]\nchild exit 0\n');
  });
});

describe('a child\'s stdout and stderr pipe', () => {
  it('pipe() writes the child\'s output to the destination; unpipe() stops it', async () => {
    await fs.writeFile('/tmp/nopt/pipe.js', `const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const sink = new PassThrough();
let got = '';
sink.on('data', (d) => { got += d; });
const c = spawn('sh', ['-c', 'echo one; echo two >&2']);
c.stdout.pipe(sink, { end: false });
c.stderr.pipe(process.stdout);
// (the sink's data events come a tick after the child closes)
c.on('close', () => setTimeout(() => console.log('piped:', JSON.stringify(got)), 20));
`);
    expect((await sh('node /tmp/nopt/pipe.js')).out).toBe('two\npiped: "one\\n"\n');
    await fs.writeFile('/tmp/nopt/unpipe.js', `const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const sink = new PassThrough();
let got = '';
sink.on('data', (d) => { got += d; });
const c = spawn('sh', ['-c', 'echo one']);
c.stdout.pipe(sink);
c.stdout.unpipe(sink);
c.on('close', () => console.log('after unpipe:', JSON.stringify(got)));
`);
    expect((await sh('node /tmp/nopt/unpipe.js')).out).toBe('after unpipe: ""\n');
  });
});

describe('the parser', () => {
  it('splits NODE_OPTIONS as a shell would', () => {
    expect(splitNodeOptions(`--title "a b" --x='c d' e\\ f`)).toEqual(['--title', 'a b', '--x=c d', 'e f']);
  });
  it('script, its arguments, -e arguments, stdin', () => {
    expect(parseNodeArgs(['--no-warnings', 's.js', '--x'])).toMatchObject({ script: 's.js', scriptArgs: ['--x'], execArgv: ['--no-warnings'] });
    expect(parseNodeArgs(['-e', 'x', 'a'])).toMatchObject({ eval: 'x', scriptArgs: ['a'] });
    expect(parseNodeArgs(['-e', 'x', 'a']).script).toBeUndefined();
    expect(parseNodeArgs(['--conditions', 'node'])).toMatchObject({ execArgv: ['--conditions', 'node'] });
    expect(parseNodeArgs(['--conditions', 'node']).script).toBeUndefined();
  });
  it('reads dotenv files', () => {
    expect(parseEnvFile('A=1\n# c\nexport B="x\\ny"\nC=\'q\' # note\nD=plain value\n')).toEqual({ A: '1', B: 'x\ny', C: 'q', D: 'plain value' });
  });
});
