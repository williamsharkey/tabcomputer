/**
 * The prebuilt CPython package (`pkg install python3`, WASI, built by
 * scripts/pkgbuild/python3.sh) as a kernel process: tabcomputer issues #5
 * (cwd, `python3 -` on a pipe, subprocess, ssl/https) and #3 (CPython is the
 * default `python3`, installed on first use; Pyodide stays as `pyodide`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { GuestWorker } from '@shiro/kernel/worker-host';
import { setGuestWorkerFactory, forceWasmProcessMode } from '@shiro/wasi/host';
import { TtySession } from '@shiro/kernel/pty';
import { NetStack, installNet } from '@shiro/kernel/net';
import { kernelForContext } from '@shiro/wasi/run-command';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { cpython3Cmd, cpythonCmd, cpipCmd } from '@shiro/commands/python-default';
import { pipMain, systemTarget } from '@shiro/commands/pip';
import { OPTIONAL_EXTENSIONS } from '@shiro/commands/pip-sdist';
import { fakeSdistIndex, SAFEMARK } from './pip-sdist-helpers';

/** A terminal stand-in with a pty session (as in pkg.test.ts). */
function fakeTerminal() {
  const tty = new TtySession();
  let screen = '';
  tty.pty.onOutput((b) => { screen += new TextDecoder().decode(b); });
  return {
    tty,
    screen: () => screen,
    writeOutput: (t: string) => { screen += t; },
    enterStdinPassthrough() {}, exitStdinPassthrough() {}, enterRawMode() {}, exitRawMode() {},
    isRawMode: () => false, onResize: () => () => {},
    getSize: () => ({ rows: tty.pty.winsize.rows, cols: tty.pty.winsize.cols }),
    term: null,
  };
}

/** Run `cmd` at a terminal's prompt; what the terminal shows. */
async function onTerminal(shell: Shell, cmd: string): Promise<{ screen: string; exitCode: number }> {
  const term = fakeTerminal();
  const exitCode = await shell.execute(cmd, (s) => term.writeOutput(s), (s) => term.writeOutput(s), false, term as any);
  return { screen: term.screen().replace(/\r\n/g, '\n'), exitCode };
}

const here = __dirname;
const REPO = path.resolve(here, '../../..');
const srcWasi = path.join(REPO, 'src/wasi');
let tmp: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'shiro-cpython-'));
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import { parentPort } from 'node:worker_threads';
    import { guestMain } from ${JSON.stringify(path.join(srcWasi, 'guest-worker.ts'))};
    const port: any = { postMessage: (m: unknown) => parentPort!.postMessage(m), onmessage: null };
    parentPort!.on('message', (data) => port.onmessage && port.onmessage({ data }));
    guestMain(port);
  `);
  const workerFile = path.join(tmp, 'guest-worker.mjs');
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: workerFile, logLevel: 'error' });
  setGuestWorkerFactory((): GuestWorker => {
    const w = new Worker(workerFile);
    return {
      postMessage: (m) => w.postMessage(m),
      terminate: () => w.terminate(),
      onMessage: (cb) => { w.on('message', cb); },
      onError: (cb) => { w.on('error', cb); },
    };
  });
  forceWasmProcessMode('sab');
  // "/pkg/..." (the mirror) comes from public/pkg
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const m = url.match(/^https?:\/\/[^/]+(\/pkg\/.*)$/);
    if (m) {
      const file = `${REPO}/public${m[1]}`;
      return existsSync(file) ? new Response(readFileSync(file)) : new Response('not found', { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
  setGuestWorkerFactory(null);
  forceWasmProcessMode(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function sh(shell: Shell, cmd: string) {
  let out = '', err = '';
  const exitCode = await shell.execute(cmd, s => { out += s; }, s => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), exitCode };
}

/** The relay harness of kernel-wasix.test.ts: HTTP/HTTPS servers and a TCP relay reaching them. */
type Harness = { httpPort: number; httpsPort: number; relayPort: number; origin: string; certFile: string };
let harness: ChildProcess | undefined;
async function startHarness(): Promise<Harness> {
  const file = path.join(here, 'fixtures/wasix-net-harness.mjs');
  harness = spawnChild('node', [file], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    harness!.stdout!.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    harness!.once('exit', (c) => reject(new Error(`harness exited ${c}`)));
  });
}

/** Route the test shell's kernel sockets through the harness relay, like a page on its origin. */
function netThroughRelay(fs: FileSystem, shell: Shell, P: Harness) {
  const stack = new NetStack();
  const origin = P.origin;
  class OriginWebSocket extends WebSocket {
    constructor(url: string | URL) { super(url, { headers: { origin } } as any); }
  }
  stack.configure({
    relayUrl: `ws://127.0.0.1:${P.relayPort}/tcp`,
    tokenUrl: `http://127.0.0.1:${P.relayPort}/tcp/token`,
    fetch: ((u: any, init: any = {}) => realFetch(u, { ...init, headers: { ...(init.headers || {}), origin } })) as typeof fetch,
    WebSocket: OriginWebSocket as unknown as typeof WebSocket,
    relayLoopback: true, portHost: null, dohUrl: null,
  });
  installNet(kernelForContext({ fs, shell } as any), stack);
}

describe('python3 (CPython WASI package)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    const r = await sh(shell, 'pkg install python3');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('os.getcwd() is the shell\'s directory, and relative paths resolve there', async () => {
    const r = await sh(shell, `mkdir -p /tmp/pyc && cd /tmp/pyc && python3 -c 'import os; print(os.getcwd()); open("f", "w").write("x")' && cat /tmp/pyc/f`);
    expect(r.err).toBe('');
    expect(r.out).toBe('/tmp/pyc\nx');
  }, 60_000);

  it('`python3 -` reads the program from a pipe without the REPL; /dev/null is no tty', async () => {
    const r = await sh(shell, `printf 'import sys\\nprint("hi", sys.argv[1:])\\n' | python3 - arg`);
    expect(r.err).toBe('');
    expect(r.out).toBe("hi ['arg']\n");
    const n = await sh(shell, `python3 -c 'import sys; print(sys.stdin.isatty(), sys.stdout.isatty())' < /dev/null | cat`);
    expect(n.out).toBe('False False\n');
    // `python3 < /dev/null`: no banner, no prompt
    const e = await sh(shell, 'python3 < /dev/null');
    expect(e).toEqual({ out: '', err: '', exitCode: 0 });
  }, 60_000);

  it('runs by its path too: the stdlib under /usr is preopened (#70)', async () => {
    // (it imports the socket shim's WASIX calls, which made it look like a WASIX-libc program)
    const r = await sh(shell, `cd /tmp && /usr/lib/pkg/python3/bin/python3.wasm -c 'import encodings, json; print(json.dumps([1]))'`);
    expect(r.err).toBe('');
    expect(r.out).toBe('[1]\n');
  }, 60_000);

  it('python3 -m http.server binds IPv4 and serves request after request without threads (#64)', async () => {
    // a net stack with loopback only (no relay)
    const stack = new NetStack();
    stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
    const off = installNet(kernelForContext({ fs, shell } as any), stack);
    await sh(shell, 'mkdir -p /tmp/www && echo hello-www > /tmp/www/index.txt');
    await sh(shell, 'cd /tmp/www && python3 -m http.server 8764 > /tmp/www.log 2>&1 &');
    const get = `python3 -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:8764/index.txt", timeout=10).read().decode(), end="")'`;
    let first = { out: '', err: '', exitCode: 1 };
    for (let i = 0; i < 100 && first.exitCode !== 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      first = await sh(shell, get);
    }
    expect(first.out, first.err + (await sh(shell, 'cat /tmp/www.log')).out).toBe('hello-www\n');
    expect((await sh(shell, get)).out).toBe('hello-www\n');
    // (the server logs a request after answering it)
    let log = await sh(shell, 'cat /tmp/www.log');
    for (let i = 0; i < 50 && (log.out.match(/" 200/g)?.length ?? 0) < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      log = await sh(shell, 'cat /tmp/www.log');
    }
    // (its stdout, "Serving HTTP on 0.0.0.0", is still in Python's buffer; the request log is stderr)
    expect(log.out.match(/"GET \/index\.txt HTTP\/1\.1" 200/g)?.length).toBeGreaterThanOrEqual(2);
    expect(log.out).not.toMatch(/bad family|can't start new thread/);
    await sh(shell, 'pkill -f http.server');
    off?.();
  }, 120_000);

  it('subprocess runs programs (os.posix_spawn over WASIX)', async () => {
    const r = await sh(shell, `cd /tmp && python3 -c '
import subprocess, os
print(subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout, end="")
print(subprocess.check_output("printf a; echo b | tr b c", shell=True, text=True))
os.makedirs("/tmp/sp", exist_ok=True)
print(subprocess.run(["pwd"], cwd="/tmp/sp", stdout=subprocess.PIPE).stdout.decode(), end="")
p = subprocess.Popen(["cat"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
print(p.communicate(b"via stdin")[0].decode(), p.returncode)
print(subprocess.call(["sh", "-c", "exit 3"]), os.getcwd())
try:
    subprocess.run(["no-such-program"])
except FileNotFoundError as e:
    print("FileNotFoundError")
'`);
    expect(r.err).toBe('');
    expect(r.out).toBe('hi\nac\n\n/tmp/sp\nvia stdin 0\n3 /tmp\nFileNotFoundError\n');
  }, 60_000);

  it('imports ssl (OpenSSL 3) and hashlib', async () => {
    const r = await sh(shell, `python3 -c 'import ssl, hashlib, socket; print(ssl.OPENSSL_VERSION.split()[:2], hashlib.sha256(b"x").hexdigest()[:8], hasattr(socket, "create_connection"))'`);
    expect(r.err).toBe('');
    expect(r.out).toBe("['OpenSSL', '3.5.4'] 2d711642 True\n");
  }, 60_000);

  /** pip into the package's site-packages, as `pip install` at the prompt does. */
  async function pip(args: string[], fetchFn: typeof fetch) {
    const ctx = { fs, cwd: '/tmp', env: {}, stdout: '', stderr: '', args } as any;
    const code = await pipMain(ctx, args, systemTarget(), fetchFn);
    return { code, out: ctx.stdout as string, err: ctx.stderr as string };
  }

  it('cannot load extension modules: dlopen is the stub wasi-libc has for a static executable (#125)', async () => {
    // configure found dlopen, so the import machinery looks for .so files; loading one fails
    await fs.mkdir('/tmp/ext', { recursive: true });
    await fs.writeFile('/tmp/ext/spam.cpython-313-wasm32-wasi.so', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const r = await sh(shell, `cd /tmp/ext && python3 -c '
import _imp, importlib.machinery as m
print(m.EXTENSION_SUFFIXES, hasattr(_imp, "create_dynamic"))
try:
    import spam
except ImportError as e:
    print("ImportError:", e)
'`);
    expect(r.err).toBe('');
    expect(r.out).toBe("['.cpython-313-wasm32-wasi.so', '.abi3.so', '.so'] True\nImportError: dlopen not implemented\n");
    // and the module itself: one static executable, nothing a side module could link against
    const mod = new WebAssembly.Module(readFileSync(`${REPO}/public/pkg/python3/3.13.7-2/python3.wasm`));
    expect(WebAssembly.Module.exports(mod).map((e) => e.name).sort()).toEqual(['_start', 'memory']);
    expect(WebAssembly.Module.customSections(mod, 'dylink.0')).toEqual([]);
    expect(WebAssembly.Module.imports(mod).some((i) => i.module === 'env' || i.kind === 'table')).toBe(false);
  }, 60_000);

  it('a package built from its sdist without the extension runs its Python fallback (#125)', async () => {
    OPTIONAL_EXTENSIONS.add('safemark');
    const r = await pip(['install', 'safemark'], fakeSdistIndex([SAFEMARK]).fetch);
    OPTIONAL_EXTENSIONS.delete('safemark');
    expect(r.err).toBe('');
    const py = await sh(shell, `python3 -c 'import safemark; print(safemark.FAST, safemark.escape("a<b"))'`);
    expect(py.err).toBe('');
    expect(py.out).toBe('False a&lt;b\n');
    await pip(['uninstall', '-y', 'safemark'], fakeSdistIndex([]).fetch);
  }, 60_000);

  describe.skipIf(!process.env.TABCOMPUTER_PIP_NET)('packages from pypi.org (TABCOMPUTER_PIP_NET=1, #125)', () => {
    it('pip install flask: a hello-world app answers requests', async () => {
      const t = Date.now();
      const r = await pip(['install', 'flask'], realFetch);
      console.log(`pip install flask: ${Date.now() - t} ms`);
      expect(r.err).toBe('');
      const stack = new NetStack();
      stack.configure({ relayUrl: null, tokenUrl: null, dohUrl: null, portHost: null });
      const off = installNet(kernelForContext({ fs, shell } as any), stack);
      await fs.mkdir('/tmp/flaskapp', { recursive: true });
      await fs.writeFile('/tmp/flaskapp/app.py', [
        'from flask import Flask, render_template_string',
        'app = Flask(__name__)',
        '@app.route("/")',
        'def hello():',
        '    return render_template_string("<p>Hello, {{ who }}!</p>", who="<class>")',
        'if __name__ == "__main__":',
        '    app.run(host="127.0.0.1", port=8765)',
        '',
      ].join('\n'));
      await sh(shell, 'cd /tmp/flaskapp && python3 app.py > /tmp/flask.log 2>&1 &');
      const get = `python3 -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:8765/", timeout=10).read().decode(), end="")'`;
      let first = { out: '', err: '', exitCode: 1 };
      const t0 = Date.now();
      for (let i = 0; i < 150 && first.exitCode !== 0; i++) {
        await new Promise((res) => setTimeout(res, 100));
        first = await sh(shell, get);
      }
      console.log(`flask answered after ${Date.now() - t0} ms`);
      expect(first.out, first.err + (await sh(shell, 'cat /tmp/flask.log')).out).toBe('<p>Hello, &lt;class&gt;!</p>');
      expect((await sh(shell, get)).out).toBe('<p>Hello, &lt;class&gt;!</p>');
      await sh(shell, 'pkill -f app.py');
      off?.();
    }, 180_000);

    it('pip install pyyaml tornado msgpack: they import and work without their extensions', async () => {
      const r = await pip(['install', 'pyyaml', 'tornado', 'msgpack'], realFetch);
      expect(r.err).toBe('');
      const py = await sh(shell, `python3 -c '
import yaml, msgpack, tornado, tornado.web, tornado.util
print(yaml.__with_libyaml__, yaml.safe_load("a: [1, 2]"), yaml.safe_dump({"b": 1}).strip())
print(msgpack.unpackb(msgpack.packb({"k": [1, 2]})), msgpack.Packer.__module__)
print(tornado.version_info[0] >= 6, tornado.util._websocket_mask.__name__)
'`);
      expect(py.err).toBe('');
      expect(py.out).toBe("False {'a': [1, 2]} b: 1\n{'k': [1, 2]} msgpack.fallback\nTrue _websocket_mask_python\n");
    }, 180_000);
  });

  describe('through the TCP relay', () => {
    let P: Harness;
    beforeAll(async () => {
      P = await startHarness();
      netThroughRelay(fs, shell, P);
      if (P.certFile) await fs.writeFile('/tmp/test-ca.pem', readFileSync(P.certFile));
    }, 30_000);
    afterAll(() => { harness?.kill(); });

    it('urllib fetches over HTTP, resolving the name through the relay', async () => {
      const r = await sh(shell, `python3 -c 'import urllib.request as u; print(u.urlopen("http://web.test:${P.httpPort}/py?q=1").read().decode(), end="")'`);
      expect(r.err).toBe('');
      expect(r.out).toBe('hello over http: GET /py?q=1\n');
    }, 60_000);

    it('urllib fetches over HTTPS, verifying the certificate', async (t) => {
      if (!P.httpsPort) return t.skip();
      const r = await sh(shell, `SSL_CERT_FILE=/tmp/test-ca.pem python3 -c 'import urllib.request as u; print(u.urlopen("https://web.test:${P.httpsPort}/secure").read().decode(), end="")'`);
      expect(r.err).toBe('');
      expect(r.out).toBe('hello over https: GET /secure\n');
      // Without the CA the self-signed certificate is refused
      const bad = await sh(shell, `python3 -c 'import urllib.request as u; u.urlopen("https://web.test:${P.httpsPort}/")'`);
      expect(bad.exitCode).toBe(1);
      expect(bad.err).toContain('CERTIFICATE_VERIFY_FAILED');
    }, 60_000);
  });
});

describe('CPython as the default python3 (profile shims.python = "cpython")', () => {
  it('installs the python3 package on first use, saying so on the terminal only', async () => {
    const { fs, shell } = await createTestShell();
    for (const c of [cpythonCmd, cpython3Cmd, cpipCmd]) shell.commands.register(c);
    // Test shells share storage: start without the package
    expect((await sh(shell, 'pkg remove python3')).exitCode).toBe(0);
    expect(await fs.exists('/usr/lib/pkg/python3/bin/python3.wasm')).toBe(false);
    const first = await onTerminal(shell, `python3 -c 'import sys; print(sys.implementation.name, sys.platform)'`);
    expect(first.exitCode).toBe(0);
    expect(first.screen).toContain('installing CPython');
    expect(first.screen).toContain('cpython wasi\n');
    expect(await fs.exists('/usr/lib/pkg/python3/bin/python3.wasm')).toBe(true);
    // Installed: no notice, and scripts' output is clean
    const again = await sh(shell, `python -c 'print(6 * 7)'`);
    expect(again).toEqual({ out: '42\n', err: '', exitCode: 0 });
  }, 120_000);
});
