/**
 * A program that isn't there, run without a shell, is node's ENOENT: an
 * 'error' with code 'ENOENT' and then 'close' with -2, never an exit status
 * (tabcomputer#81: jest 30 asks `execFile('watchman', …)` and reads only that
 * code to tell "not installed" from "installed but broken"; with status 127 it
 * chose the Watchman crawler and ran no tests). Through a shell it is still
 * the shell's 127.
 *
 * Runs under both configs: node in the page, and as a kernel guest
 * (vitest.worker.config.ts).
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function node(script: string) {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/tmp/en', { recursive: true });
  await fs.writeFile('/tmp/en/t.js', script);
  let out = '', err = '';
  const code = await shell.execute('node /tmp/en/t.js < /dev/null', (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('child_process: a program that is not installed', () => {
  it('execFile: the callback and the promise get ENOENT, and nothing is written', async () => {
    const r = await node(`const cp = require('child_process');
const { promisify } = require('util');
const child = cp.execFile('watchman', ['--no-pretty', 'get-sockname'], (err, stdout, stderr) => {
  console.log('cb', err.code, err.errno, err.syscall, err.path, JSON.stringify(err.spawnargs), JSON.stringify([stdout, stderr]));
  promisify(cp.execFile)('watchman', ['--version']).then(() => console.log('resolved'), (e) => console.log('rejected', e.code, e.path));
});
child.stderr.on('data', (d) => console.log('stderr data', String(d)));
child.on('close', (code, signal) => console.log('close', code, signal));
`);
    expect(r.err).toBe('');
    expect(r.out).toBe('close -2 null\ncb ENOENT -2 spawn watchman watchman ["--no-pretty","get-sockname"] ["",""]\nrejected ENOENT watchman\n');
  }, 60_000);

  it("spawn: 'error' with ENOENT, then 'close' with -2, no 'exit' and no stderr", async () => {
    const r = await node(`const cp = require('child_process');
const seen = [];
const c = cp.spawn('watchman', ['--no-pretty', 'get-sockname'], { stdio: ['ignore', 'pipe', 'pipe'] });
c.stderr.on('data', (d) => seen.push('stderr ' + d));
c.on('error', (e) => seen.push(['error', e.code, e.syscall, e.path, e.spawnargs.join(' ')].join(' ')));
c.on('exit', (code) => seen.push('exit ' + code));
c.on('close', (code, signal) => {
  seen.push('close ' + code + ' ' + signal);
  // stdin a pipe, the default: the other way a child is started
  const d = cp.spawn('no-such-tool', ['x']);
  d.on('error', (e) => seen.push('error ' + e.code));
  d.on('close', (code) => { seen.push('close ' + code); console.log(seen.join('\\n')); });
});
`);
    expect(r.err).toBe('');
    expect(r.out).toBe('error ENOENT spawn watchman watchman --no-pretty get-sockname\nclose -2 null\nerror ENOENT\nclose -2\n');
  }, 60_000);

  it('a program that is there keeps its status and its stderr; through a shell a missing one is 127', async () => {
    const r = await node(`const cp = require('child_process');
cp.execFile('ls', ['/no/such/dir'], (err, stdout, stderr) => {
  console.log('ls', err.code, /no such file/i.test(stderr));
  cp.exec('no-such-tool --version', (err2, out2, stderr2) => {
    console.log('exec', err2.code, /not found/.test(stderr2));
    const c = cp.spawn('no-such-tool', [], { shell: true });
    let text = '';
    c.stderr.on('data', (d) => { text += d; });
    c.on('error', (e) => console.log('error', e.code));
    c.on('close', (code) => console.log('shell', code, /not found/.test(text)));
  });
});
`);
    expect(r.err).toBe('');
    expect(r.out).toBe('ls 2 true\nexec 127 true\nshell 127 true\n');
  }, 60_000);

  it('spawnSync gives `error` with ENOENT and no status; execFileSync throws it', async () => {
    const r = await node(`const cp = require('child_process');
(async () => {
  const s = await cp.spawnSync('no-such-tool', ['-v'], { encoding: 'utf8' });
  console.log('spawnSync', s.error && s.error.code, s.status, JSON.stringify(s.stderr));
  try { await cp.execFileSync('ls', ['/tmp/en'], { encoding: 'utf8' }); console.log('ls ran'); } catch (e) { console.log('ls threw', e.code); }
})();
`);
    expect(r.err).toBe('');
    expect(r.out).toBe('spawnSync ENOENT null ""\nls ran\n');
  }, 60_000);
});
