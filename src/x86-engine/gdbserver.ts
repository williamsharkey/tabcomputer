/**
 * `tabcomputer-gdbserver`: gdb's remote protocol for x86-64 programs in Blink
 * (docs/research/GDB.md, issue #108).
 *
 * gdb runs it with `target extended-remote | tabcomputer-gdbserver` (the
 * gdbinit in GDBINIT does, from `run`). GdbServer speaks the protocol on a
 * byte stream. On `vRun` it starts the program in Blink with the engine's
 * debug agent on (Blink patch 0550, `blink/shirogdb.inc`): the program's
 * main thread then stops by making kernel call SYS_shiro_debug, which stays
 * pending here until gdb asks for something. Each gdb request (registers,
 * memory, a breakpoint, continue, step) becomes that call's reply, a command
 * the stopped thread carries out before it calls again with the result.
 *
 * So the thread that owns the CPU state answers for it, and this file only
 * holds the protocol: packet framing, the register layout and target
 * description gdb is given, the auxv (read from the initial stack, for PIE
 * and the dynamic linker), and stop replies.
 */

import type { Kernel, Runner } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { SIGINT, SIGKILL, SIGTRAP, ENOSYS, EINTR } from '../kernel/abi';

/** The debug agent's kernel call (Blink's ShiroGdbStop). */
export const SYS_shiro_debug = 1050;

// What the stopped thread sends (args[0]) …
const OP_STOP = 1, OP_RESULT = 2;
// … and the commands it is answered with
const CMD_CONT = 1, CMD_STEP = 2, CMD_READ = 3, CMD_WRITE = 4, CMD_GETREGS = 5, CMD_SETREGS = 6, CMD_SETBP = 7, CMD_CLRBP = 8, CMD_DETACH = 9;
/** Bytes of memory one command moves (the agent's buffer is 8192). */
const MEM_CHUNK = 4096;
/** The agent's register block (ShiroGdbGetRegs). */
export const AGENT_REGS = 512;
const R_IP = 128, R_FLAGS = 136, R_FS = 144, R_GS = 152, R_XMM = 160, R_MXCSR = 416, R_FCW = 420, R_FSW = 424, R_FTW = 428, R_ST = 432;
/** gdb's order of the general registers (rax rbx rcx rdx rsi rdi rbp rsp r8..r15) as indexes of Blink's (x86 encoding order). */
const GPR = [0, 3, 1, 2, 6, 7, 5, 4, 8, 9, 10, 11, 12, 13, 14, 15];

/** Why the thread stopped (ShiroGdbStop's kind). */
export const enum StopKind { Start = 0, Signal = 1, Breakpoint = 2, Step = 3 }

export interface StopEvent { type: 'stop'; sig: number; kind: StopKind; regs: Uint8Array }
export interface ExitEvent { type: 'exit'; status: number }
export type TraceeEvent = StopEvent | ExitEvent;

/** What GdbServer needs of a debugged program; BlinkTracee is the real one. */
export interface Tracee {
  /** The next stop, or the exit. */
  wait(): Promise<TraceeEvent>;
  /** While stopped: one command; resolves with the thread's answer. */
  command(cmd: number, payload?: Uint8Array): Promise<{ status: number; data: Uint8Array }>;
  /** While stopped: let it run (`step`: one instruction), delivering `sig` if not 0. */
  resume(step: boolean, sig: number): void;
  /** Ask a running program to stop (it reports SIGINT). */
  interrupt(): void;
  kill(): Promise<void>;
  /** Stop debugging; the program runs on. */
  detach(): void;
}

/** Starts `file` with `args` for the debugger, or says why not. */
export type Launcher = (file: string, args: string[]) => Promise<Tracee | string>;

// ── The kernel side of the agent's call ─────────────────────────────────

const tracees = new WeakMap<Process, BlinkTracee>();
const wired = new WeakSet<Kernel>();

/** Answer the debug agent's kernel call on `kernel` (once). */
export function wireKernel(kernel: Kernel): void {
  if (wired.has(kernel)) return;
  wired.add(kernel);
  kernel.registerSyscalls([SYS_shiro_debug], (proc, _nr, args, data) => {
    const t = tracees.get(proc);
    // nobody debugs this process: the agent turns itself off and the program runs
    return t ? t.report(args, data) : -ENOSYS;
  });
}

/** A program in Blink whose main thread the debug agent holds. */
export class BlinkTracee implements Tracee {
  private events: TraceeEvent[] = [];
  private waiter: ((e: TraceeEvent) => void) | null = null;
  /** The stopped thread's pending call: its data area and the reply. */
  private call: { data: Uint8Array; reply: (r: number) => void } | null = null;
  private result: ((r: { status: number; data: Uint8Array }) => void) | null = null;
  private lastSeq = -1;
  private exited = false;

  constructor(readonly proc: Process, private kernel: Kernel, private reaper: Process | undefined) {
    tracees.set(proc, this);
    void proc.wait().then((status) => {
      this.exited = true;
      tracees.delete(proc);
      this.call = null;
      this.result?.({ status: -1, data: new Uint8Array(0) });
      this.result = null;
      // the program is the debugger's child: nobody else waits for it
      void this.kernel.waitpid(proc.pid, 0, this.reaper).catch(() => undefined);
      this.push({ type: 'exit', status });
    });
  }

  /** SYS_shiro_debug from the thread: a stop, or a command's result. Resolves with the next command. */
  report(args: ArrayLike<number>, data: Uint8Array): Promise<number> {
    const op = args[0], seq = args[1];
    const pending = new Promise<number>((reply) => { this.call = { data, reply }; });
    if (seq === this.lastSeq) return pending; // the same report again (its call was interrupted)
    this.lastSeq = seq;
    const len = Math.max(0, Math.min(args[4], data.length));
    if (op === OP_STOP) {
      this.push({ type: 'stop', sig: args[2], kind: args[3] as StopKind, regs: data.slice(0, AGENT_REGS) });
    } else if (op === OP_RESULT) {
      const r = this.result;
      this.result = null;
      r?.({ status: args[2], data: data.slice(0, len) });
    }
    return pending;
  }

  private push(e: TraceeEvent): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w(e); else this.events.push(e);
  }

  wait(): Promise<TraceeEvent> {
    const e = this.events.shift();
    if (e) return Promise.resolve(e);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  private send(cmd: number, payload?: Uint8Array): boolean {
    const c = this.call;
    if (!c) return false;
    this.call = null;
    if (payload) c.data.set(payload);
    c.reply(cmd);
    return true;
  }

  command(cmd: number, payload?: Uint8Array): Promise<{ status: number; data: Uint8Array }> {
    return new Promise((resolve) => {
      this.result = resolve;
      if (!this.send(cmd, payload)) { this.result = null; resolve({ status: -1, data: new Uint8Array(0) }); }
    });
  }

  resume(step: boolean, sig: number): void {
    const p = new Uint8Array(12);
    const dv = new DataView(p.buffer);
    dv.setInt32(0, sig, true);
    // A Ctrl-C typed while the program was stopped went to gdb, which shares
    // the program's terminal and process group: the program doesn't get it too
    if (this.proc.ctty && sig !== SIGINT) dv.setUint32(4, 1 << (SIGINT - 1), true);
    this.send(step ? CMD_STEP : CMD_CONT, p);
  }

  interrupt(): void {
    if (!this.exited) this.kernel.kill(this.proc.pid, SIGINT);
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    this.kernel.kill(this.proc.pid, SIGKILL);
    await this.proc.wait();
  }

  detach(): void {
    tracees.delete(this.proc);
    this.send(CMD_DETACH);
  }
}

// ── Protocol helpers ─────────────────────────────────────────────────────

const HEX = '0123456789abcdef';
export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
}
export function fromHex(s: string): Uint8Array {
  const b = new Uint8Array(s.length >> 1);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16);
  return b;
}
const latin1 = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const bytesOf = (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
/** Binary data in a reply: `}` escapes `# $ } *`. */
function escapeBinary(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += c === 0x23 || c === 0x24 || c === 0x7d || c === 0x2a ? '}' + String.fromCharCode(c ^ 0x20) : String.fromCharCode(c);
  return s;
}
function unescapeBinary(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c === 0x7d ? s.charCodeAt(++i) ^ 0x20 : c);
  }
  return Uint8Array.from(out);
}
const utf8 = new TextDecoder();

/** gdb's `g` packet for the target description below, from the agent's register block. */
export const G_SIZE = 560;
const G_RIP = 128, G_EFLAGS = 136, G_SEGS = 140, G_ST = 164, G_FCTRL = 244, G_XMM = 276, G_MXCSR = 532, G_ORIG_RAX = 536, G_FS_BASE = 544;
export function agentToG(a: Uint8Array): Uint8Array {
  const g = new Uint8Array(G_SIZE);
  const gv = new DataView(g.buffer), av = new DataView(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < 16; i++) g.set(a.subarray(GPR[i] * 8, GPR[i] * 8 + 8), i * 8);
  g.set(a.subarray(R_IP, R_IP + 8), G_RIP);
  gv.setUint32(G_EFLAGS, av.getUint32(R_FLAGS, true), true);
  gv.setUint32(G_SEGS, 0x33, true);      // cs: 64-bit user code
  gv.setUint32(G_SEGS + 4, 0x2b, true);  // ss
  const sw = av.getUint32(R_FSW, true), top = (sw >> 11) & 7;
  for (let i = 0; i < 8; i++) g.set(a.subarray(R_ST + ((top + i) & 7) * 10, R_ST + ((top + i) & 7) * 10 + 10), G_ST + i * 10);
  gv.setUint32(G_FCTRL, av.getUint32(R_FCW, true), true);
  gv.setUint32(G_FCTRL + 4, sw, true);
  gv.setUint32(G_FCTRL + 8, av.getUint32(R_FTW, true), true);
  g.set(a.subarray(R_XMM, R_XMM + 256), G_XMM);
  gv.setUint32(G_MXCSR, av.getUint32(R_MXCSR, true), true);
  g.fill(0xff, G_ORIG_RAX, G_ORIG_RAX + 8); // not in a system call
  g.set(a.subarray(R_FS, R_FS + 16), G_FS_BASE);
  return g;
}
/** The agent's register block for a (changed) `g` image; `a` is the block read last. */
export function gToAgent(g: Uint8Array, a: Uint8Array): Uint8Array {
  const out = a.slice();
  const gv = new DataView(g.buffer, g.byteOffset, g.byteLength), ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) out.set(g.subarray(i * 8, i * 8 + 8), GPR[i] * 8);
  out.set(g.subarray(G_RIP, G_RIP + 8), R_IP);
  ov.setUint32(R_FLAGS, gv.getUint32(G_EFLAGS, true), true);
  const sw = gv.getUint32(G_FCTRL + 4, true), top = (sw >> 11) & 7;
  for (let i = 0; i < 8; i++) out.set(g.subarray(G_ST + i * 10, G_ST + i * 10 + 10), R_ST + ((top + i) & 7) * 10);
  ov.setUint32(R_FCW, gv.getUint32(G_FCTRL, true), true);
  ov.setUint32(R_FSW, sw, true);
  ov.setUint32(R_FTW, gv.getUint32(G_FCTRL + 8, true), true);
  out.set(g.subarray(G_XMM, G_XMM + 256), R_XMM);
  ov.setUint32(R_MXCSR, gv.getUint32(G_MXCSR, true), true);
  out.set(g.subarray(G_FS_BASE, G_FS_BASE + 16), R_FS);
  return out;
}
/** Offset and size of register `n` (the description's numbering) in the `g` image. */
function regSlot(n: number): [number, number] | null {
  if (n < 0) return null;
  if (n < 17) return [n * 8, 8];                    // rax..r15, rip
  if (n < 24) return [G_EFLAGS + (n - 17) * 4, 4];  // eflags, cs ss ds es fs gs
  if (n < 32) return [G_ST + (n - 24) * 10, 10];    // st0-7
  if (n < 40) return [G_FCTRL + (n - 32) * 4, 4];   // fctrl..fop
  if (n < 56) return [G_XMM + (n - 40) * 16, 16];   // xmm0-15
  if (n === 56) return [G_MXCSR, 4];
  if (n === 57) return [G_ORIG_RAX, 8];
  if (n === 58 || n === 59) return [G_FS_BASE + (n - 58) * 8, 8];
  return null;
}

const reg = (name: string, bits: number, type: string, extra = '') => `<reg name="${name}" bitsize="${bits}" type="${type}"${extra}/>`;
/** The target description: the registers of the `g` packet, in order. */
export const TARGET_XML = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE target SYSTEM "gdb-target.dtd">',
  '<target>',
  '<architecture>i386:x86-64</architecture>',
  '<osabi>GNU/Linux</osabi>',
  '<feature name="org.gnu.gdb.i386.core">',
  '<flags id="i386_eflags" size="4">',
  ...[['', 1], ['CF', 0], ['PF', 2], ['AF', 4], ['ZF', 6], ['SF', 7], ['TF', 8], ['IF', 9], ['DF', 10], ['OF', 11], ['NT', 14], ['RF', 16], ['VM', 17], ['AC', 18], ['VIF', 19], ['VIP', 20], ['ID', 21]]
    .map(([n, b]) => `<field name="${n}" start="${b}" end="${b}"/>`),
  '</flags>',
  ...['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi'].map((n) => reg(n, 64, 'int64')),
  reg('rbp', 64, 'data_ptr'), reg('rsp', 64, 'data_ptr'),
  ...[8, 9, 10, 11, 12, 13, 14, 15].map((n) => reg('r' + n, 64, 'int64')),
  reg('rip', 64, 'code_ptr'), reg('eflags', 32, 'i386_eflags'),
  ...['cs', 'ss', 'ds', 'es', 'fs', 'gs'].map((n) => reg(n, 32, 'int32')),
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => reg('st' + n, 80, 'i387_ext')),
  ...['fctrl', 'fstat', 'ftag', 'fiseg', 'fioff', 'foseg', 'fooff', 'fop'].map((n) => reg(n, 32, 'int', ' group="float"')),
  '</feature>',
  '<feature name="org.gnu.gdb.i386.sse">',
  '<vector id="v4f" type="ieee_single" count="4"/>',
  '<vector id="v2d" type="ieee_double" count="2"/>',
  '<vector id="v16i8" type="int8" count="16"/>',
  '<vector id="v8i16" type="int16" count="8"/>',
  '<vector id="v4i32" type="int32" count="4"/>',
  '<vector id="v2i64" type="int64" count="2"/>',
  '<union id="vec128">',
  '<field name="v4_float" type="v4f"/><field name="v2_double" type="v2d"/><field name="v16_int8" type="v16i8"/>',
  '<field name="v8_int16" type="v8i16"/><field name="v4_int32" type="v4i32"/><field name="v2_int64" type="v2i64"/>',
  '<field name="uint128" type="uint128"/>',
  '</union>',
  '<flags id="i386_mxcsr" size="4">',
  ...[['IE', 0], ['DE', 1], ['ZE', 2], ['OE', 3], ['UE', 4], ['PE', 5], ['DAZ', 6], ['IM', 7], ['DM', 8], ['ZM', 9], ['OM', 10], ['UM', 11], ['PM', 12], ['FZ', 15]]
    .map(([n, b]) => `<field name="${n}" start="${b}" end="${b}"/>`),
  '</flags>',
  ...Array.from({ length: 16 }, (_, n) => reg('xmm' + n, 128, 'vec128')),
  reg('mxcsr', 32, 'i386_mxcsr', ' group="vector"'),
  '</feature>',
  '<feature name="org.gnu.gdb.i386.linux">', reg('orig_rax', 64, 'int', ' group="system"'), '</feature>',
  '<feature name="org.gnu.gdb.i386.segments">', reg('fs_base', 64, 'int'), reg('gs_base', 64, 'int'), '</feature>',
  '</target>',
  '',
].join('\n');

/** How long after gdb's interrupt request the program has to report the terminal's own SIGINT before it is sent one. */
const INTERRUPT_GRACE_MS = 150;
const PACKET_SIZE = 0x4000;

/**
 * One gdb connection. `send` writes bytes to gdb; feed what gdb writes to
 * `input`, and call `close` when it hangs up.
 */
export class GdbServer {
  private buf = '';
  private noAck = false;
  private queue: string[] = [];
  private busy = false;
  private tracee: Tracee | null = null;
  private running = false;
  private lastStop = 'W00';
  private regs: Uint8Array | null = null; // the agent's block, while stopped
  private auxv: Uint8Array | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private send: (bytes: Uint8Array) => void, private launch: Launcher) {}

  /** Bytes from gdb. */
  input(bytes: Uint8Array): void {
    this.buf += latin1(bytes);
    for (;;) {
      const c = this.buf[0];
      if (c === undefined) break;
      if (c === '+' || c === '-') { this.buf = this.buf.slice(1); continue; }
      if (c === '\x03') { this.buf = this.buf.slice(1); this.interrupt(); continue; }
      if (c !== '$') { this.buf = this.buf.slice(1); continue; }
      const end = this.buf.indexOf('#');
      if (end < 0 || this.buf.length < end + 3) break;
      const body = this.buf.slice(1, end);
      this.buf = this.buf.slice(end + 3);
      if (!this.noAck) this.send(bytesOf('+'));
      this.queue.push(body);
    }
    void this.pump();
  }

  /** gdb hung up: the program it was debugging goes with it. */
  async close(): Promise<void> {
    this.closed = true;
    const t = this.tracee;
    this.tracee = null;
    if (t) await t.kill();
  }

  private reply(body: string): void {
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum = (sum + body.charCodeAt(i)) & 255;
    this.send(bytesOf(`$${body}#${HEX[sum >> 4]}${HEX[sum & 15]}`));
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.closed) {
        const p = this.queue.shift()!;
        let r: string | null;
        try { r = await this.handle(p); } catch (e) { console.warn('[gdbserver]', e); r = 'E01'; }
        if (r !== null && !this.closed) this.reply(r);
      }
    } finally {
      this.busy = false;
    }
  }

  /** gdb's Ctrl-C (a 0x03 byte) while the program runs. */
  private interrupt(): void {
    if (!this.running || !this.tracee || this.interruptTimer) return;
    // The terminal's Ctrl-C reaches the program too when it shares gdb's
    // process group, and it is then already stopping: only a program that
    // hasn't reported by then is sent a SIGINT
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.running) this.tracee?.interrupt();
    }, INTERRUPT_GRACE_MS);
  }

  /** Wait for the running program's next stop (or its exit): the stop reply. */
  private async stopReply(): Promise<string> {
    const t = this.tracee!;
    this.running = true;
    const e = await t.wait();
    this.running = false;
    if (this.interruptTimer) { clearTimeout(this.interruptTimer); this.interruptTimer = null; }
    if (e.type === 'exit') {
      this.tracee = null;
      this.regs = null;
      const sig = e.status & 0x7f;
      return (this.lastStop = sig ? `X${toHex(Uint8Array.of(sig))}` : `W${toHex(Uint8Array.of((e.status >> 8) & 255))}`);
    }
    this.regs = e.regs;
    const g = agentToG(e.regs);
    const sig = e.kind === StopKind.Signal ? e.sig : SIGTRAP;
    // rbp, rsp and rip go with the reply: gdb needs them at every stop
    const expedite = [6, 7, 16].map((n) => `${n.toString(16).padStart(2, '0')}:${toHex(g.subarray(n * 8, n * 8 + 8))};`).join('');
    return (this.lastStop = `T${toHex(Uint8Array.of(sig))}${e.kind === StopKind.Breakpoint ? 'swbreak:;' : ''}thread:1;${expedite}`);
  }

  private async readMem(addr: bigint, len: number): Promise<Uint8Array> {
    const out = new Uint8Array(len);
    let got = 0;
    while (got < len && this.tracee) {
      const want = Math.min(len - got, MEM_CHUNK);
      const p = new Uint8Array(12);
      const dv = new DataView(p.buffer);
      dv.setBigUint64(0, BigInt.asUintN(64, addr + BigInt(got)), true);
      dv.setUint32(8, want, true);
      const r = await this.tracee.command(CMD_READ, p);
      if (r.status !== 0 || r.data.length === 0) break;
      out.set(r.data.subarray(0, want), got);
      got += Math.min(want, r.data.length);
      if (r.data.length < want) break;
    }
    return out.subarray(0, got);
  }

  private async writeMem(addr: bigint, bytes: Uint8Array): Promise<boolean> {
    for (let off = 0; off < bytes.length; off += MEM_CHUNK) {
      if (!this.tracee) return false;
      const part = bytes.subarray(off, off + MEM_CHUNK);
      const p = new Uint8Array(12 + part.length);
      const dv = new DataView(p.buffer);
      dv.setBigUint64(0, BigInt.asUintN(64, addr + BigInt(off)), true);
      dv.setUint32(8, part.length, true);
      p.set(part, 12);
      if ((await this.tracee.command(CMD_WRITE, p)).status !== 0) return false;
    }
    return true;
  }

  private async setRegs(g: Uint8Array): Promise<boolean> {
    if (!this.tracee || !this.regs) return false;
    const next = gToAgent(g, this.regs);
    if ((await this.tracee.command(CMD_SETREGS, next)).status !== 0) return false;
    this.regs = next;
    return true;
  }

  /** The auxiliary vector, from the stack the program starts with: argc, argv, envp, then the auxv. */
  private async readAuxv(): Promise<Uint8Array> {
    if (!this.regs) return new Uint8Array(0);
    const sp = new DataView(this.regs.buffer, this.regs.byteOffset).getBigUint64(4 * 8, true);
    const stack = await this.readMem(sp, 65536);
    const dv = new DataView(stack.buffer, stack.byteOffset, stack.byteLength & ~7);
    const q = (i: number) => (i * 8 + 8 <= dv.byteLength ? dv.getBigUint64(i * 8, true) : 0n);
    let i = 1 + Number(q(0)) + 1;           // argc, argv[], NULL
    while (i * 8 < dv.byteLength && q(i) !== 0n) i++; // envp[]
    const start = ++i;
    while (i * 8 + 16 <= dv.byteLength && q(i) !== 0n) i += 2;
    return stack.slice(start * 8, Math.min((i + 2) * 8, dv.byteLength));
  }

  private xfer(data: Uint8Array | string, annex: string): string {
    const m = /^([0-9a-f]+),([0-9a-f]+)$/.exec(annex);
    if (!m) return 'E00';
    const off = parseInt(m[1], 16), len = Math.min(parseInt(m[2], 16), PACKET_SIZE - 16);
    const bytes = typeof data === 'string' ? bytesOf(data) : data;
    const part = bytes.subarray(off, off + len);
    return (off + part.length >= bytes.length ? 'l' : 'm') + escapeBinary(part);
  }

  private async resume(action: string): Promise<string> {
    if (!this.tracee) return 'E01';
    // c, s, Csig, Ssig (vCont's first action; a `:thread` suffix means the one thread)
    const m = /^([cCsS])([0-9a-f]{2})?/.exec(action);
    if (!m) return 'E01';
    this.regs = null;
    this.tracee.resume(m[1] === 's' || m[1] === 'S', m[2] ? parseInt(m[2], 16) : 0);
    return this.stopReply();
  }

  private async handle(p: string): Promise<string | null> {
    const t = this.tracee;
    switch (p[0]) {
      case '?': return this.lastStop;
      case '!': return 'OK';
      case 'H': return 'OK';
      case 'T': return t ? 'OK' : 'E01';
      case 'g': return this.regs ? toHex(agentToG(this.regs)) : 'E01';
      case 'G': return (await this.setRegs(fromHex(p.slice(1)))) ? 'OK' : 'E01';
      case 'p': {
        const slot = regSlot(parseInt(p.slice(1), 16));
        if (!this.regs || !slot) return 'E01';
        return toHex(agentToG(this.regs).subarray(slot[0], slot[0] + slot[1]));
      }
      case 'P': {
        const eq = p.indexOf('=');
        const slot = regSlot(parseInt(p.slice(1, eq), 16));
        if (!this.regs || !slot || eq < 0) return 'E01';
        const g = agentToG(this.regs);
        g.set(fromHex(p.slice(eq + 1)).subarray(0, slot[1]), slot[0]);
        return (await this.setRegs(g)) ? 'OK' : 'E01';
      }
      case 'm': {
        const m = /^m([0-9a-f]+),([0-9a-f]+)$/.exec(p);
        if (!m || !t) return 'E01';
        const bytes = await this.readMem(BigInt('0x' + m[1]), Math.min(parseInt(m[2], 16), PACKET_SIZE / 2 - 8));
        return bytes.length ? toHex(bytes) : 'E0e';
      }
      case 'M': {
        const m = /^M([0-9a-f]+),([0-9a-f]+):([0-9a-f]*)$/.exec(p);
        if (!m || !t) return 'E01';
        return (await this.writeMem(BigInt('0x' + m[1]), fromHex(m[3]))) ? 'OK' : 'E0e';
      }
      case 'X': {
        const m = /^X([0-9a-f]+),([0-9a-f]+):/.exec(p);
        if (!m || !t) return 'E01';
        return (await this.writeMem(BigInt('0x' + m[1]), unescapeBinary(p.slice(m[0].length)))) ? 'OK' : 'E0e';
      }
      case 'Z':
      case 'z': {
        const m = /^[Zz]([0-9]),([0-9a-f]+),/.exec(p);
        if (!m || !t) return 'E01';
        if (m[1] !== '0') return ''; // no hardware breakpoints or watchpoints
        const a = new Uint8Array(8);
        new DataView(a.buffer).setBigUint64(0, BigInt('0x' + m[2]), true);
        return (await t.command(p[0] === 'Z' ? CMD_SETBP : CMD_CLRBP, a)).status === 0 ? 'OK' : 'E01';
      }
      case 'c': case 's': case 'C': case 'S':
        return this.resume(p);
      case 'k':
        this.tracee = null;
        this.regs = null;
        this.lastStop = 'W00';
        await t?.kill();
        return null;
      case 'D':
        this.tracee = null;
        this.regs = null;
        this.lastStop = 'W00';
        t?.detach();
        return 'OK';
      case 'v': return this.handleV(p);
      case 'q': return this.handleQ(p);
      case 'Q':
        if (p === 'QStartNoAckMode') { this.noAck = true; return 'OK'; }
        return '';
      default: return '';
    }
  }

  private async handleV(p: string): Promise<string | null> {
    if (p === 'vCont?') return 'vCont;c;C;s;S';
    if (p.startsWith('vCont;')) return this.resume(p.slice(6));
    if (p.startsWith('vKill')) {
      const t = this.tracee;
      this.tracee = null;
      this.regs = null;
      this.lastStop = 'W00';
      await t?.kill();
      return 'OK';
    }
    if (p.startsWith('vRun;')) {
      const [file, ...args] = p.slice(5).split(';').map((h) => utf8.decode(fromHex(h)));
      if (!file) return 'E01';
      await this.tracee?.kill();
      this.tracee = null;
      this.auxv = null;
      const t = await this.launch(file, args);
      if (typeof t === 'string') { console.warn('[gdbserver]', t); return 'E01'; }
      this.tracee = t;
      const r = await this.stopReply();
      if (this.tracee) this.auxv = await this.readAuxv();
      return r;
    }
    return ''; // vMustReplyEmpty and everything else
  }

  private async handleQ(p: string): Promise<string> {
    if (p.startsWith('qSupported')) return `PacketSize=${PACKET_SIZE.toString(16)};QStartNoAckMode+;swbreak+;vContSupported+;qXfer:features:read+;qXfer:auxv:read+`;
    if (p === 'qC') return 'QC1';
    if (p === 'qfThreadInfo') return this.tracee ? 'm1' : 'l';
    if (p === 'qsThreadInfo') return 'l';
    if (p.startsWith('qAttached')) return '0'; // started here: gdb kills it on quit
    if (p === 'qSymbol::') return 'OK';
    if (p.startsWith('qXfer:features:read:target.xml:')) return this.xfer(TARGET_XML, p.slice(31));
    if (p.startsWith('qXfer:auxv:read::')) return this.auxv ? this.xfer(this.auxv, p.slice(17)) : 'E01';
    return '';
  }
}

// ── The program ──────────────────────────────────────────────────────────

/**
 * gdb's own process: it started us through `sh -c`, in a session of our
 * own (ser-pipe.c), so it is the nearest ancestor outside that session.
 */
function debuggerOf(proc: Process, kernel: Kernel): Process | undefined {
  let p: Process | undefined = proc;
  while (p && p.sid === proc.sid) p = p.ppid > 1 ? kernel.procs.get(p.ppid) : undefined;
  return p;
}

/** The launcher for a gdbserver that is kernel process `proc`: programs start as gdb's children, on gdb's terminal. */
export function blinkLauncher(proc: Process, kernel: Kernel, runnerFor: (path: string) => Runner): Launcher {
  wireKernel(kernel);
  return async (file, args) => {
    const fs = kernel.fs;
    if (!fs) return 'no filesystem';
    const gdb = debuggerOf(proc, kernel) ?? proc;
    const path = file.startsWith('/') ? file : fs.resolvePath(file, gdb.cwd);
    let head: Uint8Array | string;
    try { head = await fs.readFile(path); } catch { return `${path}: no such file`; }
    if (typeof head === 'string' || head.length < 20 || head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46 || head[4] !== 2 || head[18] !== 62) {
      return `${path}: not an x86-64 ELF program`;
    }
    const fds: Record<number, import('../kernel/fd').OpenFile> = {};
    for (const fd of [0, 1, 2]) {
      const f = gdb.fds.get(fd);
      if (f) fds[fd] = f;
    }
    const child = kernel.spawn({ path, argv: [file, ...args], env: proc.env, cwd: gdb.cwd, parent: gdb, fds, run: runnerFor(path) });
    return new BlinkTracee(child, kernel, gdb);
  };
}

/** `tabcomputer-gdbserver` as a kernel program: the protocol on fds 0 and 1. */
export async function gdbServerProgram(proc: Process, kernel: Kernel): Promise<number> {
  const { blinkRunner, blinkSupported } = await import('./blink');
  if (!blinkSupported()) {
    await kernel.writeAll(proc, 2, bytesOf('tabcomputer-gdbserver: the x86-64 engine needs a cross-origin isolated page\n'));
    return 1;
  }
  let writes = Promise.resolve<unknown>(0);
  const server = new GdbServer(
    (bytes) => { writes = writes.then(() => kernel.writeAll(proc, 1, bytes)).catch(() => undefined); },
    blinkLauncher(proc, kernel, (path) => blinkRunner(path, undefined, { gdb: true })),
  );
  const chunk = new Uint8Array(16384);
  for (;;) {
    const f = proc.fds.get(0);
    if (!f) break;
    let n: number;
    try { n = await f.read(chunk, proc.syscallSignal); } catch { break; }
    if (n === -EINTR) continue;
    if (n <= 0) break;
    server.input(chunk.slice(0, n));
  }
  await server.close();
  await writes;
  return 0;
}
