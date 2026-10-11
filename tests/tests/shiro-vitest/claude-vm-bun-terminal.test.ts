/**
 * Bun.Terminal and Bun.spawn's `terminal` option for claude --vm
 * (src/claude-vm/bun/terminal.ts), as Claude Code's pty host
 * (`claude --bg-pty-host`) uses them: a terminal with a data callback, a
 * program spawned on it in a session of its own, keys written, a resize,
 * the program's exit, then close() and the exit callback. Through node as a
 * kernel guest (node-worker/pty.ts) and node in the page (pty-page.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import { kernelForContext } from '@shiro/wasi/run-command';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function node(script: string, worker = true) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/bt', { recursive: true });
  await fs.writeFile('/tmp/bt/t.js', script);
  // (in the page, node finds the page's kernel as main.ts publishes it)
  const g = globalThis as { __tabcomputerKernel?: unknown };
  const saved = g.__tabcomputerKernel;
  if (!worker) g.__tabcomputerKernel = kernelForContext({ fs, shell } as any);
  let out = '';
  try {
    await shell.execute(`export TABCOMPUTER_NODE_WORKER=${worker ? 1 : 0}; node /tmp/bt/t.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
  } finally { g.__tabcomputerKernel = saved; }
  return out.replace(/\r\n/g, '\n');
}

const prelude = `const { createBun } = await require('tabcomputer:claude-vm').load();
const Bun = createBun({ fs: require('fs'), process, childProcess: require('child_process'), Buffer });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

describe('Bun.Terminal (node as a kernel guest)', () => {
  it('runs a program on a pty: a tty for stdio, keys in, output out, its size, exit code, then close', async () => {
    const out = await node(prelude + `
let seen = '';
let exits = [];
const t = new Bun.Terminal({ cols: 100, rows: 30, data(term, d) { seen += Buffer.from(d).toString(); }, exit(term, code, sig) { exits.push([code, sig, term === t]); } });
const p = Bun.spawn(['sh', '-c', 'test -t 0 && echo tty0; test -t 1 && echo tty1; read x; echo "got $x"; exit 3'], { terminal: t, env: { ...process.env } });
await sleep(200);
const n = t.write('hello\\n');
const code = await p.exited;
await sleep(50);
const closedBefore = t.closed;
t.close();
await sleep(10);
console.log(JSON.stringify({ n, code, exitCode: p.exitCode, signalCode: p.signalCode, stdio: [p.stdin, p.stdout, p.stderr], same: p.terminal === t, closedBefore, closed: t.closed, exits, seen }));
`);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ n: 6, code: 3, exitCode: 3, signalCode: null, stdio: [null, null, null], same: true, closedBefore: false, closed: true, exits: [[0, null, true]] });
    // (the pty echoes the line, and turns the program's \\n into \\r\\n)
    expect(r.seen).toContain('tty0\r\ntty1\r\n');
    expect(r.seen).toContain('hello\r\n');
    expect(r.seen).toContain('got hello\r\n');
  }, 60_000);

  it('resize: the program sees the new size; kill ends it with the signal', async () => {
    const out = await node(prelude + `
let seen = '';
const t = new Bun.Terminal({ cols: 90, rows: 20, data(term, d) { seen += Buffer.from(d).toString(); } });
const p = Bun.spawn(['sh', '-c', 'stty size; read x; stty size; read y'], { terminal: t });
await sleep(200);
t.resize(120, 40);
t.write('a\\n');
await sleep(200);
p.kill('SIGTERM');
const code = await p.exited;
t.close();
console.log(JSON.stringify({ code, signalCode: p.signalCode, killed: p.killed, seen }));
`);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ code: 143, signalCode: 'SIGTERM', killed: true });
    expect(r.seen).toContain('20 90');
    expect(r.seen).toContain('40 120');
  }, 60_000);

  it('the options form makes a terminal; raw mode stops the echo; flags read back', async () => {
    const out = await node(prelude + `
let seen = '';
const p = Bun.spawn(['sh', '-c', 'read x; echo "<$x>"'], { terminal: { cols: 80, rows: 24, data(term, d) { seen += Buffer.from(d).toString(); } } });
const t = p.terminal;
const before = (t.localFlags & 0o10) !== 0; // ECHO
t.setRawMode(true);
const after = (t.localFlags & 0o10) !== 0;
t.setRawMode(false);
await sleep(100);
t.write('abc\\n');
await p.exited;
await sleep(30);
t.close();
console.log(JSON.stringify({ isTerminal: t instanceof Bun.Terminal, before, after, seen }));
`);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ isTerminal: true, before: true, after: false });
    expect(r.seen).toContain('<abc>');
  }, 60_000);

  it('the pty is the controlling terminal of a session of its own: ^C is SIGINT to the program', async () => {
    const out = await node(prelude + `
let seen = '';
const t = new Bun.Terminal({ data(term, d) { seen += Buffer.from(d).toString(); } });
const p = Bun.spawn(['sh', '-c', 'tty; sleep 20'], { terminal: t });
await sleep(300);
t.write('\\x03');
const code = await p.exited;
t.close();
console.log(JSON.stringify({ code, signalCode: p.signalCode, seen, ownSession: p.pid !== process.pid }));
`);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ code: 130, signalCode: 'SIGINT', ownSession: true });
    expect(r.seen).toMatch(/\/dev\/pts\/\d+/);
  }, 60_000);

  it('a missing program throws ENOENT at once; the terminal still works', async () => {
    const out = await node(prelude + `
const t = new Bun.Terminal({});
let err;
try { Bun.spawn(['/nonexistent/prog'], { terminal: t }); } catch (e) { err = e.code; }
t.close();
console.log(JSON.stringify({ err, closed: t.closed }));
`);
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ err: 'ENOENT', closed: true });
  }, 60_000);
});

describe('Bun.Terminal (node in the page)', () => {
  it('runs a program on a kernel pty too', async () => {
    const out = await node(prelude + `
let seen = '';
const t = new Bun.Terminal({ cols: 70, rows: 10, data(term, d) { seen += Buffer.from(d).toString(); } });
const p = Bun.spawn(['sh', '-c', 'stty size; read x; echo "got $x"'], { terminal: t });
await sleep(200);
t.write('page\\n');
const code = await p.exited;
await sleep(30);
t.close();
console.log(JSON.stringify({ code, seen }));
`, false);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r.code).toBe(0);
    expect(r.seen).toContain('10 70');
    expect(r.seen).toContain('got page');
  }, 60_000);
});

describe("Claude Code's pty host, in miniature", () => {
  // (runPtyHost: a terminal, the program on it, its output to clients of a Unix socket, their keys to it)
  const host = prelude + `
const net = require('net');
const sock = '/tmp/bt/pty.sock';
try { require('fs').unlinkSync(sock); } catch {} // (as runPtyHost: a socket file left by an earlier host)
let clients = [];
const t = new Bun.Terminal({ cols: 80, rows: 24, data(term, d) { for (const c of clients) c.write(Buffer.from(d)); } });
const p = Bun.spawn(['sh', '-c', 'read x; echo "host got $x"'], { terminal: t });
const server = net.createServer((c) => { clients.push(c); c.on('data', (d) => t.write(d)); });
let addr;
server.listen(sock, () => { addr = server.address(); });
await sleep(100);
let seen = '';
const client = net.connect(sock);
client.on('data', (d) => { seen += String(d); });
await new Promise((r) => client.once('connect', r));
await sleep(50);
client.write('over the socket\\n');
const code = await p.exited;
await sleep(100);
t.close(); client.end(); server.close();
let refused;
await new Promise((r) => net.connect('/tmp/bt/none.sock').on('error', (e) => { refused = e.code; r(); }));
console.log(JSON.stringify({ code, addr, seen, refused }));
`;
  it.each([['a kernel guest', true], ['the page', false]])('node as %s: a client attached over a Unix socket types into the program and sees its output', async (_n, worker) => {
    const out = await node(host, worker as boolean);
    const r = JSON.parse(out.trim().split('\n').pop()!);
    expect(r).toMatchObject({ code: 0, addr: '/tmp/bt/pty.sock', refused: 'ENOENT' });
    expect(r.seen).toContain('host got over the socket');
  }, 60_000);
});

describe('process.execPath under claude --vm (self-exec.ts)', () => {
  it('is a launcher beside vm-main.mjs that Claude Code can run itself again through, on a terminal too', async () => {
    const { shell, fs } = await createTestShell();
    const dir = '/tmp/vmx/nc-test';
    await fs.mkdir(dir, { recursive: true });
    // (a stand-in for the real launcher: what it was started with)
    await fs.writeFile(`${dir}/vm-main.mjs`, "const v = await Promise.resolve('vm');\nconsole.log(v, JSON.stringify(process.argv.slice(2)), process.stdout.isTTY === true ? 'tty' : 'pipe');\n");
    await fs.writeFile('/tmp/vmx/t.js', `const { createBun } = await require('tabcomputer:claude-vm').load();
const Bun = createBun({ fs: require('fs'), process, childProcess: require('child_process'), Buffer: Buffer, main: '${dir}/cli.js' });
const nfs = require('fs');
const st = nfs.statSync(process.execPath);
let x = 'xok';
try { nfs.accessSync(process.execPath, nfs.constants.X_OK); } catch (e) { x = e.code; }
// as the daemon of Claude Code starts a pty host: execPath with its own arguments
const piped = Bun.spawn([process.execPath, '--bg-pty-host', 'sock', '200', '50'], { stdout: 'pipe' });
const out1 = await new Response(piped.stdout).text();
let seen = '';
const t = new Bun.Terminal({ data(term, d) { seen += Buffer.from(d).toString(); } });
const onTty = Bun.spawn([process.execPath, '--bg-spare', 'x'], { terminal: t, argv0: 'claude bg-spare' });
await onTty.exited;
await new Promise((r) => setTimeout(r, 30));
t.close();
console.log(JSON.stringify({ execPath: process.execPath, big: st.size > 65536, x, out1, seen }));
`);
    let out = '';
    await shell.execute('export TABCOMPUTER_NODE_WORKER=1; node /tmp/vmx/t.js < /dev/null', (s) => { out += s; }, (s) => { out += s; });
    const r = JSON.parse(out.replace(/\r\n/g, '\n').trim().split('\n').pop()!);
    expect(r).toMatchObject({ execPath: `${dir}/claude`, big: true, x: 'xok', out1: 'vm ["--bg-pty-host","sock","200","50"] pipe\n' });
    expect(r.seen).toContain('vm ["--bg-spare","x"] tty');
  }, 60_000);
});
