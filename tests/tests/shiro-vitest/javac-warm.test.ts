/**
 * The warm javac's client (src/commands/java.ts): the request it sends to
 * Javad and the reply it reads (scripts/java/Javad.java's protocol), and which
 * command lines go to the real javac. The JVM side is compared with the real
 * javac by scripts/java/test.sh, and the whole path in a tab by
 * tests/browser/java-fast.mjs.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { encodeRequest, ReplyParser, mayUseJavad, javacCmd } from '@shiro/commands/java';
import { jdkLauncher, jvmDefaultArgs, mayBeJdkLauncher } from '@shiro/java-defaults';

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

describe('javac without Java', () => {
  it('says how to install it', async () => {
    const { shell } = await createTestShell();
    shell.commands.register(javacCmd);
    const r = await run(shell, 'javac Hello.java');
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('toolchain install java');
  });
});
