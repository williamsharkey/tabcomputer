/**
 * A child's stdout and stderr 'data' events come as the child writes, as node's
 * do, for exec, execFile and spawn, in the page and as a kernel guest. exec and
 * execFile (and spawn in the page) delivered everything in one piece at the end,
 * so an app showing a long install's log showed nothing until it finished
 * (docs/research/APP_MAKER.md, gap 5). The callback's stdout and stderr are
 * still the whole output.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: (() => void) | undefined;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function node(script: string, pre: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/cs', { recursive: true });
  await fs.writeFile('/tmp/cs/a.js', script);
  let out = '';
  await shell.execute(`${pre}node /tmp/cs/a.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

const CMD = 'echo one; echo warn >&2; sleep 0.6; echo two';
/**
 * Start `expr` (with `cb` as its callback, if it takes one) and report each stream's chunks,
 * whether the first came well before the end, and what the callback got
 */
const watch = (expr: string) => `
const cp = require('child_process');
const CMD = ${JSON.stringify(CMD)};
const t0 = Date.now();
const out = [], err = [];
let first = null, got = null;
const cb = (e, so, se) => { got = [e && e.message, String(so), String(se)]; };
const c = ${expr};
c.stdout.on('data', (d) => { first ??= Date.now() - t0; out.push(String(d)); });
c.stderr.on('data', (d) => { err.push(String(d)); });
c.on('close', (code) => setTimeout(() => console.log(JSON.stringify({ code, out, err, early: Date.now() - t0 - first >= 300, got })), 0));
`;

const MODES = [['in the page', 'export TABCOMPUTER_NODE_WORKER=0; '], ['as a guest', 'export TABCOMPUTER_NODE_WORKER=1; ']];

describe.each(MODES)("a child's output arrives as it writes it, %s", (_mode, pre) => {
  const whole = [null, 'one\ntwo\n', 'warn\n'];
  it.each([
    ['exec', `cp.exec(CMD, cb)`, whole],
    ['exec with options', `cp.exec(CMD, { maxBuffer: 1 << 20, timeout: 20000 }, cb)`, whole],
    ['execFile', `cp.execFile('sh', ['-c', CMD], cb)`, whole],
    ['spawn', `cp.spawn('sh', ['-c', CMD])`, null],
    ['spawn, stdin ignored', `cp.spawn('sh', ['-c', CMD], { stdio: ['ignore', 'pipe', 'pipe'] })`, null],
    ['spawn with a shell', `cp.spawn(CMD, { shell: true })`, null],
    ['exec of sudo', `cp.exec('sudo sh -c ' + JSON.stringify(CMD), cb)`, whole],
  ])('%s', async (_, expr, got) => {
    expect(JSON.parse(await node(watch(expr), pre))).toEqual({ code: 0, out: ['one\n', 'two\n'], err: ['warn\n'], early: true, got });
  }, 60_000);

  it('a listener added while the child runs gets what was written before it', async () => {
    const out = await node(`
const cp = require('child_process');
let so = '';
const c = cp.exec('echo one; sleep 0.6; echo two', (e, all) => console.log(JSON.stringify([so, all])));
setTimeout(() => c.stdout.on('data', (d) => { so += d; }), 250);
`, pre);
    expect(out).toBe('["one\\ntwo\\n","one\\ntwo\\n"]\n');
  }, 60_000);

  it('maxBuffer still cuts the callback\'s output, whatever the listeners saw', async () => {
    const out = await node(`
const cp = require('child_process');
let so = '';
const c = cp.exec('printf 0123456789', { maxBuffer: 4 }, (e, all) => console.log(e && e.code, all, so));
c.stdout.on('data', (d) => { so += d; });
`, pre);
    expect(out).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER 0123 0123456789\n');
  }, 60_000);
});
