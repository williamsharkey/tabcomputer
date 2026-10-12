/**
 * tabcomputer#106: child_process exec() and execFile() honor `env`, `timeout`
 * (killSignal to the child, the error says killed and the signal) and
 * `maxBuffer` (ERR_CHILD_PROCESS_STDIO_MAXBUFFER, the output cut there);
 * their promisified forms too. They were ignored.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

async function node(script: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/xo', { recursive: true });
  await fs.writeFile('/tmp/xo/a.js', script);
  let out = '';
  await shell.execute('node /tmp/xo/a.js < /dev/null', (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

describe('exec and execFile options (#106)', () => {
  it('env: the child sees that environment', async () => {
    const out = await node(`
const cp = require('child_process');
const env = { PATH: process.env.PATH, XO_VAR: 'from-env' };
cp.exec('printenv XO_VAR', { env }, (e, so) => {
  console.log('exec', e && e.message, so.trim());
  cp.execFile('printenv', ['XO_VAR'], { env }, (e2, so2) => console.log('execFile', e2 && e2.message, so2.trim()));
});
`);
    expect(out).toBe('exec null from-env\nexecFile null from-env\n');
  }, 30_000);

  it('timeout: the child gets the signal and the error says so', async () => {
    const out = await node(`
const cp = require('child_process');
const t0 = Date.now();
const report = (name, next) => (e) => { console.log(name, e && e.killed, e && e.signal, e && e.code, Date.now() - t0 < 5000); next && next(); };
cp.exec('sleep 20', { timeout: 300 }, report('exec', () =>
  cp.execFile('sleep', ['20'], { timeout: 300, killSignal: 'SIGKILL' }, report('execFile', () =>
    cp.execFile('sleep', ['0.1'], { timeout: 5000 }, (e) => console.log('in time', e))))));
`);
    expect(out).toBe('exec true SIGTERM null true\nexecFile true SIGKILL null true\nin time null\n');
  }, 60_000);

  it('maxBuffer: output past it is an error, cut at the limit', async () => {
    const out = await node(`
const cp = require('child_process');
cp.exec('printf 0123456789', { maxBuffer: 4 }, (e, so) => {
  console.log('exec', e && e.code, e && e.message, so);
  cp.execFile('printf', ['0123456789'], { maxBuffer: 10 }, (e2, so2) => console.log('execFile', e2, so2));
});
`);
    expect(out).toBe('exec ERR_CHILD_PROCESS_STDIO_MAXBUFFER stdout maxBuffer length exceeded 0123\nexecFile null 0123456789\n');
  }, 30_000);

  it('the promisified forms take the options; execFile(file, options, callback)', async () => {
    const out = await node(`
const cp = require('child_process');
const { promisify } = require('util');
(async () => {
  const env = { PATH: process.env.PATH, XO_VAR: 'p' };
  console.log((await promisify(cp.exec)('printenv XO_VAR', { env })).stdout.trim());
  console.log((await promisify(cp.execFile)('printenv', ['XO_VAR'], { env })).stdout.trim());
  await promisify(cp.exec)('sleep 20', { timeout: 300 }).catch((e) => console.log('timeout', e.killed, e.signal));
  await promisify(cp.exec)('exit 3').catch((e) => console.log(e.message, e.code));
  cp.execFile('printenv', { env }, (e, so) => console.log('no args', e && e.message, so.includes('XO_VAR=p')));
})();
`);
    expect(out).toBe('p\np\ntimeout true SIGTERM\nCommand failed: exit 3 3\nno args null true\n');
  }, 60_000);
});
