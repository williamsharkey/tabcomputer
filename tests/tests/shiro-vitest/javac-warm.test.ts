/**
 * The warm javac's client (src/commands/java.ts): the request it sends to
 * Javad and the reply it reads (scripts/java/Javad.java's protocol), and which
 * command lines go to the real javac. The JVM side is compared with the real
 * javac by scripts/java/test.sh, and the whole path in a tab by
 * tests/browser/java-fast.mjs.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { encodeRequest, ReplyParser, mayUseJavad, javacCmd, prestartJavad } from '@shiro/commands/java';
import {
  jdkLauncher, jvmDefaultArgs, mayBeJdkLauncher,
  JAVAC_PRESTART_DELAY_MS, JAVAC_USED_KEY, javacPrestartWanted, noteJavacUsed, scheduleJavacPrestart, type JavacPrestartState,
} from '@shiro/java-defaults';

const frame = (kind: number, bytes: Uint8Array | number): Uint8Array => {
  const n = typeof bytes === 'number' ? bytes : bytes.length;
  const head = Uint8Array.of(kind, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  if (typeof bytes === 'number') return head;
  const out = new Uint8Array(5 + n);
  out.set(head); out.set(bytes, 5);
  return out;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};
const enc = new TextEncoder();

describe('warm javac: the request', () => {
  it('is op, cwd, class path, count and arguments as DataInput reads them', () => {
    const b = encodeRequest('c', '/home/user', '', ['-d', 'out', 'Héllo.java'])!;
    expect(b[0]).toBe('c'.charCodeAt(0));
    const view = new DataView(b.buffer);
    let off = 1;
    const utf = () => { const n = view.getUint16(off); off += 2; const s = new TextDecoder().decode(b.subarray(off, off + n)); off += n; return s; };
    expect(utf()).toBe('/home/user');
    expect(utf()).toBe('');
    expect(view.getInt32(off)).toBe(3); off += 4;
    expect([utf(), utf(), utf()]).toEqual(['-d', 'out', 'Héllo.java']);
    expect(off).toBe(b.length);
  });

  it('is refused for strings Java reads differently (the real javac takes those)', () => {
    expect(encodeRequest('c', '/', '', ['a\0b.java'])).toBeNull();
    expect(encodeRequest('c', '/', '', ['\u{1F600}.java'])).toBeNull();
    expect(encodeRequest('c', '/', '', ['x'.repeat(70000) + '.java'])).toBeNull();
  });
});

describe('warm javac: the reply', () => {
  it('gives the frames in order and the status, however the bytes are split', () => {
    const reply = cat(frame(2, enc.encode('Bad.java:1: error: é\n')), frame(1, enc.encode('out')), frame(2, enc.encode('1 error\n')), frame(0, 1));
    for (const step of [1, 2, 3, 7, reply.length]) {
      const got: string[] = [];
      const p = new ReplyParser((kind, bytes) => got.push(`${kind}:${new TextDecoder().decode(bytes)}`));
      for (let i = 0; i < reply.length; i += step) expect(p.push(reply.subarray(i, i + step))).toBe(true);
      expect(got).toEqual(['2:Bad.java:1: error: é\n', '1:out', '2:1 error\n']);
      expect(p.status).toBe(1);
    }
  });

  it('says so when the bytes are not a reply (another server on the port)', () => {
    const p = new ReplyParser(() => {});
    expect(p.push(enc.encode('HTTP/1.1 400 Bad Request\r\n\r\n'))).toBe(false);
    expect(p.status).toBeNull();
  });

  it('carries a status of 127 (Javad passes) and a negative one', () => {
    const p = new ReplyParser(() => {});
    p.push(frame(0, 127));
    expect(p.status).toBe(127);
    const q = new ReplyParser(() => {});
    q.push(Uint8Array.of(0, 255, 255, 255, 255));
    expect(q.status).toBe(-1);
  });
});

describe('warm javac: which command lines it takes', () => {
  it('takes compiles of .java files', () => {
    expect(mayUseJavad(['Hello.java'])).toBe(true);
    expect(mayUseJavad(['-d', 'out', '-cp', 'lib', 'src/A.java', 'src/B.java'])).toBe(true);
  });
  it('leaves the rest to the real javac', () => {
    for (const args of [[], ['-version'], ['--version'], ['--help'], ['@files'], ['-J-Xmx1g', 'A.java'], ['--release', '17', 'A.java'], ['A.class']]) {
      expect(mayUseJavad(args), args.join(' ')).toBe(false);
    }
  });
});

describe('JVM options under the emulator', () => {
  const JDK = '/usr/lib/jvm/java-21-openjdk-amd64';
  it('knows a JDK launcher by its resolved path', () => {
    expect(jdkLauncher(`${JDK}/bin/java`)).toBe('java');
    expect(jdkLauncher(`${JDK}/bin/javac`)).toBe('javac');
    expect(jdkLauncher('/usr/bin/java')).toBeNull();
    expect(jdkLauncher(`${JDK}/lib/jspawnhelper`)).toBeNull();
    expect(mayBeJdkLauncher('/usr/bin/java')).toBe(true);
    expect(mayBeJdkLauncher('/usr/bin/keytool')).toBe(true);
    expect(mayBeJdkLauncher('/usr/bin/gcc')).toBe(false);
  });
  it('puts the quick compiler and the serial collector first: plain for java, -J for the tools', () => {
    expect(jvmDefaultArgs('java', ['java', '-cp', 'x', 'Hello', '-Xint'], {})).toEqual(['java', '-XX:+UseSerialGC', '-cp', 'x', 'Hello', '-Xint']);
    expect(jvmDefaultArgs('java', ['java', 'Hello'], {})).toEqual(['java', '-XX:TieredStopAtLevel=1', '-XX:+UseSerialGC', 'Hello']);
    expect(jvmDefaultArgs('javac', ['javac', 'Hello.java'], {})).toEqual(['javac', '-J-XX:TieredStopAtLevel=1', '-J-XX:+UseSerialGC', '-XDstringConcat=inline', 'Hello.java']);
    expect(jvmDefaultArgs('javac', ['javac', '-XDstringConcat=indy', 'Hello.java'], {})).toEqual(['javac', '-J-XX:TieredStopAtLevel=1', '-J-XX:+UseSerialGC', '-XDstringConcat=indy', 'Hello.java']);
    expect(jvmDefaultArgs('jshell', ['jshell'], {})).toEqual(['jshell', '-J-XX:TieredStopAtLevel=1', '-J-XX:+UseSerialGC']);
  });
  it('leaves a choice the user made (two collectors are an error to the JVM)', () => {
    expect(jvmDefaultArgs('java', ['java', '-XX:+UseG1GC', 'Hello'], {})).toEqual(['java', '-XX:TieredStopAtLevel=1', '-XX:+UseG1GC', 'Hello']);
    expect(jvmDefaultArgs('javac', ['javac', '-J-XX:TieredStopAtLevel=4', '-J-XX:+UseParallelGC', '-XDstringConcat=indy', 'A.java'], {})).toBeUndefined();
    expect(jvmDefaultArgs('jar', ['jar', '-J-Xint', '-J-XX:+UseParallelGC', 'tf', 'a.jar'], {})).toBeUndefined();
    expect(jvmDefaultArgs('java', ['java', 'Hello'], { JAVA_TOOL_OPTIONS: '-XX:+UseZGC' })).toEqual(['java', '-XX:TieredStopAtLevel=1', 'Hello']);
    expect(jvmDefaultArgs('java', ['java', 'Hello'], { TABCOMPUTER_JVM_DEFAULTS: '0' })).toBeUndefined();
  });
});

describe('warm javac: started at page load', () => {
  const DAY = 24 * 3600_000;
  const now = 1_800_000_000_000;
  const state = (over: Partial<JavacPrestartState> = {}): JavacPrestartState =>
    ({ usedAt: String(now - DAY), now, env: {}, safe: false, guestNoNetwork: false, hidden: false, ...over });

  it('for a tab that compiled Java in the last 7 days', () => {
    expect(javacPrestartWanted(state())).toBe('start');
    expect(javacPrestartWanted(state({ usedAt: String(now - 7 * DAY + 1000) }))).toBe('start');
    expect(javacPrestartWanted(state({ usedAt: String(now - 7 * DAY) }))).toBe('no');
    expect(javacPrestartWanted(state({ usedAt: null }))).toBe('no');
    expect(javacPrestartWanted(state({ usedAt: 'soon' }))).toBe('no');
    expect(javacPrestartWanted(state({ usedAt: String(now + DAY) }))).toBe('no'); // the clock changed
  });

  it('never in safe mode, in a guest with no network, or when turned off; a hidden page waits', () => {
    expect(javacPrestartWanted(state({ safe: true }))).toBe('no');
    expect(javacPrestartWanted(state({ guestNoNetwork: true }))).toBe('no');
    expect(javacPrestartWanted(state({ env: { TABCOMPUTER_JAVAC_PRESTART: '0' } }))).toBe('no');
    expect(javacPrestartWanted(state({ env: { TABCOMPUTER_JAVAC: 'jvm' } }))).toBe('no');
    expect(javacPrestartWanted(state({ env: { TABCOMPUTER_JAVAC_PRESTART: '1' } }))).toBe('start');
    expect(javacPrestartWanted(state({ hidden: true }))).toBe('later');
    expect(javacPrestartWanted(state({ hidden: true, safe: true }))).toBe('no');
  });

  /** The scheduler with its clock, idle queue and visibility in the test's hands */
  function scheduled(answers: ('start' | 'later' | 'no')[]) {
    const timers: { cb: () => void; ms: number }[] = [];
    const idle: (() => void)[] = [];
    const visible: (() => void)[] = [];
    let started = 0, checks = 0;
    scheduleJavacPrestart({
      check: () => answers[Math.min(checks++, answers.length - 1)],
      start: () => { started++; },
      idle: (cb) => { idle.push(cb); }, onVisible: (cb) => { visible.push(cb); }, timer: (cb, ms) => { timers.push({ cb, ms }); },
    });
    return { timers, idle, visible, started: () => started };
  }

  it('waits a few seconds, then for an idle page, and checks again before it starts', () => {
    const s = scheduled(['start']);
    expect(s.timers.map((t) => t.ms)).toEqual([JAVAC_PRESTART_DELAY_MS]);
    expect(JAVAC_PRESTART_DELAY_MS).toBeGreaterThanOrEqual(3000);
    expect(s.started()).toBe(0);
    s.timers[0].cb();
    expect(s.started()).toBe(0); // not before the page is idle
    s.idle[0]();
    expect(s.started()).toBe(1);

    const off = scheduled(['no']);
    off.timers[0].cb();
    expect(off.idle).toEqual([]);
    expect(off.visible).toEqual([]);
  });

  it('a hidden page starts nothing until it is shown; one hidden again by the idle moment waits again', () => {
    const s = scheduled(['later', 'start', 'later', 'start', 'start']);
    s.timers[0].cb();
    expect(s.idle).toHaveLength(0);
    expect(s.visible).toHaveLength(1);
    s.visible[0]();        // shown: 'start', queued for an idle moment
    expect(s.started()).toBe(0);
    s.idle[0]();           // hidden again by then: 'later'
    expect(s.started()).toBe(0);
    expect(s.visible).toHaveLength(2);
    s.visible[1]();
    s.idle[1]();
    expect(s.started()).toBe(1);
  });

  it('javac records that this tab compiles Java, and prestart does nothing without Java', async () => {
    const store = new Map<string, string>();
    const real = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
    try {
      noteJavacUsed(now);
      expect(store.get(JAVAC_USED_KEY)).toBe(String(now));
      expect(javacPrestartWanted(state({ usedAt: store.get(JAVAC_USED_KEY)!, now: now + DAY }))).toBe('start');
      const { shell } = await createTestShell();
      shell.commands.register(javacCmd);
      store.clear();
      await run(shell, 'javac Hello.java'); // no Java here: nothing to keep warm
      expect(store.has(JAVAC_USED_KEY)).toBe(false);
      expect(await prestartJavad(shell)).toBe(false);
    } finally { (globalThis as any).localStorage = real; }
  });
});

describe('javac without Java', () => {
  it('says how to install it', async () => {
    const { shell } = await createTestShell();
    shell.commands.register(javacCmd);
    const r = await run(shell, 'javac Hello.java');
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('toolchain install java');
  });
});
