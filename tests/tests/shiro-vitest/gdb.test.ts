/**
 * gdb through the x86 engine's debug agent (issue #108, docs/research/GDB.md).
 *
 * 1. The protocol half alone (src/x86-engine/gdbserver.ts) against a fake
 *    program: framing, the register layout, the target description.
 * 2. A scripted remote-protocol client against fixtures/x86/gdbdemo.c running
 *    in Blink with the agent (Blink patch 0550): the first stop, breakpoints,
 *    registers and memory, single steps, a fault, an interrupt during a
 *    loop and during a blocking read, kill.
 * 3. Debian's own gdb doing the same from its command line, when the `c`
 *    toolchain layer is available (TABCOMPUTER_TEST_LAYERS=DIR, as
 *    toolchain-layers.test.ts).
 *
 * The fixture is built with the host's gcc, or with `zig cc` for
 * x86_64-linux-musl where there is no Linux gcc (macOS: put zig on PATH or
 * set ZIG); without either, parts 2 and 3 are skipped.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run as runRaw } from './helpers';
import { GdbServer, BlinkTracee, wireKernel, agentToG, gToAgent, toHex, fromHex, TARGET_XML, AGENT_REGS, G_SIZE, type Tracee, type TraceeEvent } from '@shiro/x86-engine/gdbserver';
import { GDBINIT, GDBINIT_PATH } from '@shiro/x86-engine/gdbinit';
import { installAlwaysShims } from '@shiro/path-shims';

const ROOT = resolve(__dirname, '../../..');
const FIX = resolve(__dirname, 'fixtures/x86');
const dir = mkdtempSync(join(tmpdir(), 'shiro-gdb-'));
const bin = join(dir, 'gdbdemo');
const build = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, '-static', '-g', '-O0', '-fno-sanitize=undefined', '-o', bin, 'gdbdemo.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
    const h = readFileSync(bin);
    return h.readUInt32BE(0) === 0x7f454c46 && h.readUInt16LE(18) === 62;
  } catch { return false; }
};
const haveBin = build('gcc', []) || build(process.env.ZIG || 'zig', ['cc', '-target', 'x86_64-linux-musl']);
// the built engine has the debug agent (it exports blink_shiro_gdb)
const blinkHasGdb = readFileSync(join(ROOT, 'public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_gdb');

/** Addresses of the ELF's symbols (.symtab). */
function symbols(elf: Buffer): Map<string, bigint> {
  const shoff = Number(elf.readBigUInt64LE(0x28)), shentsize = elf.readUInt16LE(0x3a), shnum = elf.readUInt16LE(0x3c);
  const out = new Map<string, bigint>();
  for (let i = 0; i < shnum; i++) {
    const sh = shoff + i * shentsize;
    if (elf.readUInt32LE(sh + 4) !== 2) continue; // SHT_SYMTAB
    const off = Number(elf.readBigUInt64LE(sh + 0x18)), size = Number(elf.readBigUInt64LE(sh + 0x20));
    const str = shoff + elf.readUInt32LE(sh + 0x28) * shentsize;
    const stroff = Number(elf.readBigUInt64LE(str + 0x18));
    for (let s = off; s < off + size; s += 24) {
      const name = elf.readUInt32LE(s);
      let end = stroff + name;
      while (elf[end]) end++;
      out.set(elf.toString('latin1', stroff + name, end), elf.readBigUInt64LE(s + 8));
    }
  }
  return out;
}

/** A remote-protocol client: sends a packet, resolves with the reply's body. */
class Client {
  server!: GdbServer;
  private buf = '';
  private waiting: ((body: string) => void) | null = null;
  receive = (bytes: Uint8Array) => {
    this.buf += Buffer.from(bytes).toString('latin1');
    this.drain();
  };
  private drain(): void {
    for (;;) {
      const start = this.buf.indexOf('$'), end = this.buf.indexOf('#', start);
      if (start < 0 || end < 0 || this.buf.length < end + 3 || !this.waiting) return;
      const body = this.buf.slice(start + 1, end);
      this.buf = this.buf.slice(end + 3);
      const w = this.waiting;
      this.waiting = null;
      w(body);
    }
  }
  /** Send without waiting (a resume whose stop comes later). */
  post(body: string): void {
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum = (sum + body.charCodeAt(i)) & 255;
    this.server.input(Buffer.from(`$${body}#${sum.toString(16).padStart(2, '0')}`, 'latin1'));
  }
  reply(): Promise<string> {
    return new Promise((res) => { this.waiting = res; this.drain(); });
  }
  cmd(body: string): Promise<string> {
    this.post(body);
    return this.reply();
  }
  interrupt(): void { this.server.input(Uint8Array.of(3)); }
}

const le64 = (hex: string) => fromHex(hex).reduceRight((v, b) => (v << 8n) | BigInt(b), 0n);
const hex64 = (v: bigint) => v.toString(16);
/** Register `n` (rax rbx rcx rdx rsi rdi rbp rsp r8-r15 rip) of a `g` reply. */
const gReg = (g: string, n: number) => le64(g.slice(n * 16, n * 16 + 16));
const RDI = 5, RSI = 4, RSP = 7, RIP = 16;

describe('gdbserver: the protocol', () => {
  /** A program that is only a register block and 64 bytes of memory at 0x1000. */
  function fake() {
    const regs = new Uint8Array(AGENT_REGS);
    const dv = new DataView(regs.buffer);
    for (let i = 0; i < 16; i++) dv.setBigUint64(i * 8, BigInt(0x100 + i), true); // Blink's order: ax cx dx bx sp bp si di r8..
    dv.setBigUint64(128, 0x401000n, true);
    dv.setUint32(136, 0x246, true);
    dv.setBigUint64(144, 0x7000n, true);
    const mem = new Uint8Array(64).map((_, i) => i);
    const bps = new Set<bigint>();
    const log: string[] = [];
    let waiter: ((e: TraceeEvent) => void) | null = null;
    const events: TraceeEvent[] = [];
    const push = (e: TraceeEvent) => { if (waiter) { const w = waiter; waiter = null; w(e); } else events.push(e); };
    const tracee: Tracee = {
      wait: () => (events.length ? Promise.resolve(events.shift()!) : new Promise((r) => { waiter = r; })),
      async command(cmd, p = new Uint8Array(0)) {
        const pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        if (cmd === 3) { // read
          const a = Number(pv.getBigUint64(0, true)) - 0x1000, n = pv.getUint32(8, true);
          return a < 0 || a >= 64 ? { status: 14, data: new Uint8Array(0) } : { status: 0, data: mem.slice(a, a + n) };
        }
        if (cmd === 4) { mem.set(p.subarray(12, 12 + pv.getUint32(8, true)), Number(pv.getBigUint64(0, true)) - 0x1000); return { status: 0, data: new Uint8Array(0) }; }
        if (cmd === 6) { regs.set(p.subarray(0, AGENT_REGS)); return { status: 0, data: new Uint8Array(0) }; }
        if (cmd === 7) bps.add(pv.getBigUint64(0, true));
        if (cmd === 8) bps.delete(pv.getBigUint64(0, true));
        return { status: 0, data: new Uint8Array(0) };
      },
      resume(step, sig) {
        log.push(`${step ? 'step' : 'cont'} ${sig}`);
        if (step) push({ type: 'stop', sig: 5, kind: 3, regs });
      },
      interrupt() { log.push('interrupt'); push({ type: 'stop', sig: 2, kind: 1, regs }); },
      async kill() { log.push('kill'); },
      detach() { log.push('detach'); },
    };
    const c = new Client();
    const launched: string[][] = [];
    c.server = new GdbServer(c.receive, async (file, args) => {
      launched.push([file, ...args]);
      if (file === '/bin/missing') return 'no such file';
      events.length = 0;
      events.push({ type: 'stop', sig: 5, kind: 0, regs });
      return tracee;
    });
    return { c, regs, mem, bps, log, launched, push };
  }

  it('answers the packets gdb sends before and at `run`', async () => {
    const { c, launched } = fake();
    expect(await c.cmd('qSupported:multiprocess+;swbreak+;xmlRegisters=i386')).toMatch(/PacketSize=4000;.*swbreak\+.*qXfer:features:read\+.*qXfer:auxv:read\+/);
    expect(await c.cmd('vMustReplyEmpty')).toBe('');
    expect(await c.cmd('QStartNoAckMode')).toBe('OK');
    expect(await c.cmd('!')).toBe('OK');
    expect(await c.cmd('?')).toBe('W00');              // nothing runs yet
    expect(await c.cmd('qfThreadInfo')).toBe('l');
    expect(await c.cmd('vRun;' + toHex(Buffer.from('/bin/missing')))).toBe('E01');
    const stop = await c.cmd(`vRun;${toHex(Buffer.from('/home/user/a b'))};${toHex(Buffer.from('x'))};${toHex(Buffer.from('y z'))}`);
    expect(launched[1]).toEqual(['/home/user/a b', 'x', 'y z']);
    // SIGTRAP, the one thread, and rbp, rsp, rip (Blink's bp is index 5, sp 4)
    expect(stop).toBe(`T05thread:1;06:${toHex(fromHex('0501000000000000'))};07:0401000000000000;10:0010400000000000;`);
    expect(await c.cmd('?')).toBe(stop);
    expect(await c.cmd('qfThreadInfo')).toBe('m1');
    expect(await c.cmd('qsThreadInfo')).toBe('l');
    expect(await c.cmd('qC')).toBe('QC1');
    expect(await c.cmd('qAttached')).toBe('0');
    expect(await c.cmd('vCont?')).toBe('vCont;c;C;s;S');
    expect(await c.cmd('Z1,401000,1')).toBe('');       // no hardware breakpoints
    expect(await c.cmd('qTStatus')).toBe('');
  });

  it('lays the registers out as the target description says', async () => {
    const { c, regs } = fake();
    await c.cmd('vRun;' + toHex(Buffer.from('/p')));
    const g = await c.cmd('g');
    expect(g.length).toBe(G_SIZE * 2);
    // rax rbx rcx rdx rsi rdi rbp rsp from Blink's ax cx dx bx sp bp si di
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => Number(gReg(g, n)) - 0x100)).toEqual([0, 3, 1, 2, 6, 7, 5, 4]);
    expect(Number(gReg(g, 8)) - 0x100).toBe(8);
    expect(gReg(g, RIP)).toBe(0x401000n);
    expect(g.slice(136 * 2, 140 * 2)).toBe('46020000');           // eflags
    expect(g.slice(140 * 2, 148 * 2)).toBe('330000002b000000');   // cs, ss
    expect(le64(g.slice(544 * 2, 552 * 2))).toBe(0x7000n);        // fs_base
    expect(await c.cmd('p10')).toBe('0010400000000000');          // rip is register 16
    expect(await c.cmd('p11')).toBe('46020000');
    // one register, then all of them, written back
    expect(await c.cmd('P0=efbeadde00000000')).toBe('OK');
    expect(new DataView(regs.buffer).getBigUint64(0, true)).toBe(0xdeadbeefn);
    expect(await c.cmd('P10=0020400000000000')).toBe('OK');
    expect(new DataView(regs.buffer).getBigUint64(128, true)).toBe(0x402000n);
    const g2 = fromHex(await c.cmd('g'));
    g2[8] = 0x77; // rbx's low byte
    expect(await c.cmd('G' + toHex(g2))).toBe('OK');
    expect(regs[3 * 8]).toBe(0x77);
    // the two layouts are each other's inverse
    expect(toHex(gToAgent(agentToG(regs), regs))).toBe(toHex(regs));
    // the description names every register of the packet, in order
    const names = [...TARGET_XML.matchAll(/<reg name="([a-z0-9_]+)" bitsize="(\d+)"/g)];
    expect(names.length).toBe(60);
    expect(names.reduce((n, m) => n + Number(m[2]) / 8, 0)).toBe(G_SIZE);
    expect(names[16][1]).toBe('rip');
    expect(names[40][1]).toBe('xmm0');
    const xml = await c.cmd('qXfer:features:read:target.xml:0,3fff');
    expect(xml[0]).toBe('l');
    expect(xml).toContain('<architecture>i386:x86-64</architecture>');
    const first = await c.cmd('qXfer:features:read:target.xml:0,40');
    expect(first[0]).toBe('m');
    expect(first.length).toBe(0x41);
  });

  it('reads and writes memory, sets breakpoints, resumes, interrupts and reports the exit', async () => {
    const { c, mem, bps, log, push } = fake();
    await c.cmd('vRun;' + toHex(Buffer.from('/p')));
    expect(await c.cmd('m1004,4')).toBe('04050607');
    expect(await c.cmd('m103e,8')).toBe('3e3f');        // as much as is mapped
    expect(await c.cmd('m2000,4')).toBe('E0e');
    expect(await c.cmd('M1000,2:aabb')).toBe('OK');
    expect(await c.cmd('X1002,3:\x01}\x03\x02')).toBe('OK'); // binary, 0x23 escaped
    expect([...mem.subarray(0, 5)]).toEqual([0xaa, 0xbb, 1, 0x23, 2]);
    expect(await c.cmd('Z0,401020,1')).toBe('OK');
    expect(bps.has(0x401020n)).toBe(true);
    expect(await c.cmd('z0,401020,1')).toBe('OK');
    expect(bps.size).toBe(0);
    expect(await c.cmd('vCont;s:1')).toMatch(/^T05thread:1;/);
    expect(await c.cmd('s')).toMatch(/^T05thread:1;/);
    // continue; an interrupt request is acted on only if the program hasn't stopped by itself
    c.post('vCont;C0e:1;c');
    await new Promise((r) => setTimeout(r, 20));
    c.interrupt();
    expect(await c.reply()).toMatch(/^T02thread:1;/);
    expect(log).toEqual(['step 0', 'step 0', 'cont 14', 'interrupt']);
    c.post('c');
    await new Promise((r) => setTimeout(r, 20));
    push({ type: 'stop', sig: 5, kind: 2, regs: new Uint8Array(AGENT_REGS) });
    expect(await c.reply()).toMatch(/^T05swbreak:;thread:1;/);
    c.post('c');
    push({ type: 'exit', status: 7 << 8 });
    expect(await c.reply()).toBe('W07');
    expect(await c.cmd('?')).toBe('W07');
    expect(await c.cmd('g')).toBe('E01');
    // killed by a signal; then a new run
    await c.cmd('vRun;' + toHex(Buffer.from('/p')));
    c.post('c');
    push({ type: 'exit', status: 11 });
    expect(await c.reply()).toBe('X0b');
    await c.cmd('vRun;' + toHex(Buffer.from('/p')));
    expect(await c.cmd('vKill;1')).toBe('OK');
    expect(log.at(-1)).toBe('kill');
  });

  it('the gdbinit connects at run and reads libraries from the filesystem', async () => {
    const { fs } = await createTestShell();
    await installAlwaysShims(fs);
    expect(await fs.readFile(GDBINIT_PATH, 'utf8')).toBe(GDBINIT);
    expect(GDBINIT).toContain('target extended-remote | exec tabcomputer-gdbserver');
    expect(GDBINIT).toContain('set sysroot /');
    for (const hook of ['hook-run', 'hook-start', 'hook-starti']) expect(GDBINIT).toContain(`define ${hook}\n`);
    expect((await fs.stat('/usr/local/bin/tabcomputer-gdbserver')).mode & 0o111).toBeTruthy();
  });
});

describe.skipIf(!haveBin || !blinkHasGdb)('gdbserver: a program in Blink under the debug agent', () => {
  const elf = haveBin ? readFileSync(bin) : Buffer.alloc(0);
  const sym = haveBin ? symbols(elf) : new Map<string, bigint>();
  const entry = haveBin ? elf.readBigUInt64LE(0x18) : 0n;

  async function debug(...args: string[]) {
    const { fs } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', elf, { mode: 0o755 });
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { createPipe } = await import('@shiro/kernel/pipe');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    wireKernel(kernel);
    const out = new BufferFile(null);
    const [stdin, feed] = createPipe();
    const c = new Client();
    let proc: import('@shiro/kernel/process').Process | undefined;
    c.server = new GdbServer(c.receive, async (file, argv) => {
      proc = kernel.spawn({ path: file, argv: [file, ...argv], cwd: '/home/user/work', fds: { 0: stdin, 1: out, 2: out }, run: blinkRunner(file, undefined, { gdb: true }) });
      return new BlinkTracee(proc, kernel, undefined);
    });
    await c.cmd('QStartNoAckMode');
    const stop = await c.cmd(['vRun', '/home/user/work/prog', ...args].map((s, i) => (i ? toHex(Buffer.from(s)) : s)).join(';'));
    return { c, out, feed, stop, kernel, pid: () => proc!.pid };
  }

  it('stops before the first instruction, at a breakpoint with its arguments, steps, and runs to the exit', async () => {
    const { c, out, stop } = await debug();
    expect(stop).toMatch(/^T05thread:1;/);
    let g = await c.cmd('g');
    expect(gReg(g, RIP)).toBe(entry);
    // the auxv, from the initial stack: AT_ENTRY (9) is the entry point
    const auxv = Buffer.from(await c.cmd('qXfer:auxv:read::0,1000'), 'latin1');
    expect(auxv[0]).toBe(0x6c); // 'l'
    const pairs = new Map<bigint, bigint>();
    for (let o = 1; o + 16 <= auxv.length; o += 16) pairs.set(auxv.readBigUInt64LE(o), auxv.readBigUInt64LE(o + 8));
    expect(pairs.get(9n)).toBe(entry);
    expect(pairs.get(6n)).toBe(4096n); // AT_PAGESZ
    // the program's code is readable where the file says
    const mainAddr = sym.get('main')!, addAddr = sym.get('add')!, counter = sym.get('counter')!;
    expect((await c.cmd(`m${hex64(counter)},4`))).toBe('29000000'); // 41
    expect(await c.cmd(`Z0,${hex64(mainAddr)},1`)).toBe('OK');
    expect(await c.cmd(`Z0,${hex64(addAddr)},1`)).toBe('OK');
    expect(await c.cmd('vCont;c')).toMatch(/^T05swbreak:;thread:1;/);
    g = await c.cmd('g');
    expect(gReg(g, RIP)).toBe(mainAddr);
    // single steps move on, one instruction each
    const seen = new Set<bigint>([mainAddr]);
    for (let i = 0; i < 3; i++) {
      expect(await c.cmd('vCont;s:1')).toMatch(/^T05thread:1;/);
      seen.add(gReg(await c.cmd('g'), RIP));
    }
    expect(seen.size).toBe(4);
    // on to add(3, 4)
    expect(await c.cmd('vCont;c')).toMatch(/^T05swbreak:;thread:1;/);
    g = await c.cmd('g');
    expect(gReg(g, RIP)).toBe(addAddr);
    expect(gReg(g, RDI) & 0xffffffffn).toBe(3n);
    expect(gReg(g, RSI) & 0xffffffffn).toBe(4n);
    // the return address on the stack is in main
    const ret = le64(await c.cmd(`m${hex64(gReg(g, RSP))},8`));
    expect(ret > mainAddr && ret < mainAddr + 0x200n).toBe(true);
    // change a variable and an argument, remove the breakpoints, run on
    expect(await c.cmd(`M${hex64(counter)},4:64000000`)).toBe('OK'); // counter = 100
    expect(await c.cmd(`P5=${'0a00000000000000'}`)).toBe('OK');      // rdi = 10
    expect(await c.cmd(`z0,${hex64(addAddr)},1`)).toBe('OK');
    expect(await c.cmd(`z0,${hex64(mainAddr)},1`)).toBe('OK');
    expect(await c.cmd('vCont;c')).toBe('W0e');                      // exit status 14
    expect(out.text()).toBe('x=14 counter=114\n');
    expect(await c.cmd('?')).toBe('W0e');
  }, 120_000);

  it('a fault stops in the debugger where it happened; passed on, it ends the program', async () => {
    const { c, stop } = await debug('segv');
    expect(stop).toMatch(/^T05/);
    expect(await c.cmd('vCont;c')).toMatch(/^T0bthread:1;/); // SIGSEGV
    const rip = gReg(await c.cmd('g'), RIP), crash = sym.get('crash')!;
    expect(`${hex64(rip)} in crash ${hex64(crash)}`).toBe(rip >= crash && rip < crash + 0x40n ? `${hex64(rip)} in crash ${hex64(crash)}` : 'in crash');
    // not delivered: the instruction faults again
    expect(await c.cmd('vCont;c')).toMatch(/^T0bthread:1;/);
    expect(gReg(await c.cmd('g'), RIP)).toBe(rip);
    expect(await c.cmd('vCont;C0b:1')).toBe('X0b');
  }, 120_000);

  it('an interrupt stops a loop and a blocking read; the read goes on afterwards', async () => {
    const spin = await debug('spin');
    spin.c.post('vCont;c');
    await expect.poll(() => spin.out.text(), { timeout: 30_000 }).toBe('spinning\n');
    spin.c.interrupt();
    expect(await spin.c.reply()).toMatch(/^T02thread:1;/);
    const main = sym.get('main')!;
    const rip = gReg(await spin.c.cmd('g'), RIP);
    expect(rip > main && rip < main + 0x400n).toBe(true);
    // not passed on: it keeps spinning; a second interrupt, then kill
    spin.c.post('vCont;c');
    await new Promise((r) => setTimeout(r, 100));
    spin.c.interrupt();
    expect(await spin.c.reply()).toMatch(/^T02thread:1;/);
    expect(await spin.c.cmd('vKill;1')).toBe('OK');
    expect(spin.kernel.procs.has(spin.pid())).toBe(false);

    const wait = await debug('wait');
    wait.c.post('vCont;c');
    await expect.poll(() => wait.out.text(), { timeout: 30_000 }).toBe('waiting\n');
    await new Promise((r) => setTimeout(r, 200)); // in read(0)
    wait.c.interrupt();
    expect(await wait.c.reply()).toMatch(/^T02thread:1;/);
    // continued without the signal, the read is still a read: it takes the input
    wait.c.post('vCont;c');
    await new Promise((r) => setTimeout(r, 100));
    await wait.feed.write(new TextEncoder().encode('abq'));
    expect(await wait.c.reply()).toBe('W07');
    expect(wait.out.text()).toBe('waiting\nwoke\nx=7 counter=48\n');
  }, 120_000);

  it('a program started with the agent and no debugger runs normally', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', elf, { mode: 0o755 });
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { BufferFile } = await import('@shiro/kernel/fd');
    const { blinkRunner } = await import('@shiro/x86-engine/blink');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const out = new BufferFile(null);
    const p = kernel.spawn({ path: '/home/user/work/prog', argv: ['prog'], cwd: '/home/user/work', fds: { 0: new BufferFile(''), 1: out, 2: out }, run: blinkRunner('/home/user/work/prog', undefined, { gdb: true }) });
    expect(await p.wait()).toBe(7 << 8);
    expect(out.text()).toBe('x=7 counter=48\n');
  }, 60_000);
});

// Kernel programs' output comes through a pty (\r\n)
const run = async (...a: Parameters<typeof runRaw>) => {
  const r = await runRaw(...a);
  return { ...r, output: r.output.replace(/\r\n/g, '\n') };
};
const haveRootfs = existsSync(join(ROOT, 'public/debian/rootfs.json'));
const realLayers = process.env.TABCOMPUTER_TEST_LAYERS;

describe.skipIf(!haveRootfs || !realLayers || !blinkHasGdb)("Debian's gdb (TABCOMPUTER_TEST_LAYERS)", () => {
  it('break, run, bt, print, next, step, finish, a segfault with a backtrace, on a PIE built by gcc', async () => {
    process.env.TABCOMPUTER_DEBIAN_LAYERS_URL = 'file://' + resolve(realLayers!) + '/';
    try {
      const { fs, shell } = await createTestShell();
      expect((await run(shell, 'toolchain install c')).exitCode).toBe(0);
      await installAlwaysShims(fs);
      await fs.mkdir('/home/user/dbg', { recursive: true });
      await fs.writeFile('/home/user/dbg/demo.c', readFileSync(join(FIX, 'gdbdemo.c')));
      const cc = await run(shell, 'cd /home/user/dbg && gcc -g -O0 -o demo demo.c && file demo 2>/dev/null; echo built=$?');
      expect(cc.output).toContain('built=0');
      const gdb = async (cmds: string[], args = '') => {
        await fs.writeFile('/home/user/dbg/g.cmd', cmds.join('\n') + '\n');
        return run(shell, `cd /home/user/dbg && gdb -q -batch -x g.cmd --args ./demo ${args} 2>&1`);
      };
      const a = await gdb(['break add', 'run', 'bt', 'print a', 'print b', 'print counter', 'next', 'next', 'print sum', 'print counter', 'finish', 'step', 'info registers rip', 'continue']);
      expect(a.output).toMatch(/Breakpoint 1 at 0x[0-9a-f]+: file demo\.c, line 11\./);
      expect(a.output).toMatch(/Breakpoint 1, add \(a=3, b=4\) at demo\.c:11/);
      expect(a.output).toMatch(/#0 +add \(a=3, b=4\) at demo\.c:11\n#1 +0x[0-9a-f]+ in main \(argc=1, argv=0x[0-9a-f]+\) at demo\.c:21/);
      expect(a.output).toContain('$1 = 3\n');
      expect(a.output).toContain('$2 = 4\n');
      expect(a.output).toContain('$3 = 41\n');
      expect(a.output).toContain('$4 = 7\n');   // sum, after two `next`
      expect(a.output).toContain('$5 = 48\n');  // counter
      expect(a.output).toMatch(/Run till exit from #0 +add/);
      expect(a.output).toContain('Value returned is $6 = 7');
      expect(a.output).toContain('x=7 counter=48\n');
      expect(a.output).toMatch(/\[Inferior 1 \(process \d+\) exited with code 07\]/);
      expect(a.output).not.toMatch(/ptrace|Could not trace|warning: Error/);

      const b = await gdb(['run', 'bt', 'print p', 'continue'], 'segv');
      expect(b.output).toMatch(/Program received signal SIGSEGV, Segmentation fault\.\n(0x[0-9a-f]+ in )?crash \(p=0x0\) at demo\.c:17/);
      expect(b.output).toMatch(/#0 +(0x[0-9a-f]+ in )?crash \(p=0x0\) at demo\.c:17\n#1 +0x[0-9a-f]+ in main \(argc=2, argv=0x[0-9a-f]+\) at demo\.c:22/);
      expect(b.output).toContain('$1 = (int *) 0x0');
      expect(b.output).toContain('Program terminated with signal SIGSEGV, Segmentation fault.');
    } finally { delete process.env.TABCOMPUTER_DEBIAN_LAYERS_URL; }
  }, 1_800_000);
});
