// Java in the real app (docs/research/JAVA_SPEED.md): the JVM flags of
// tabcomputer#122 run, and `javac` is the warm compiler: the first compile
// starts it, later ones take seconds, its messages and class files are
// javac's, and what it doesn't take goes to the real javac.
//
// Needs the java toolchain layer on the server (TABCOMPUTER_DEBIAN_LAYERS):
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist TABCOMPUTER_DEBIAN_LAYERS=DIR node server.mjs &
//   node tests/browser/java-fast.mjs [URL]
//
// Prints one line per step with its time; exits 1 if a step fails.
// WARM_LIMIT_MS (default 20000) is the most a warm compile may take.
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const url = process.argv[2] || 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const WARM_LIMIT = Number(process.env.WARM_LIMIT_MS || 20_000);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer && window.__tabcomputer.shell, null, { timeout: 90_000 });

/** One shell line in a terminal-less fork kept across steps; output and stderr together */
const sh = (cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const t0 = performance.now();
  const s = window.__javaShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
}, cmd);
const write = (path, text) => page.evaluate(([p, t]) => window.__tabcomputer.fs.writeFile(p, t), [path, text]);

let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`ok    ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s${note ? `  (${note})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s\n      ${String(e?.message ?? e).replace(/\n/g, '\n      ')}`);
  }
}
const expectOk = (r, what) => { if (r.code !== 0) throw new Error(`${what}: exit ${r.code}\n${r.out}`); return r; };

const HELLO = (msg) => `public class Hello {\n  public static void main(String[] a) {\n    System.out.println("${msg}");\n  }\n}\n`;
const BANK = `import java.util.ArrayList;\n\npublic class Bank {\n  private final ArrayList<Integer> accounts = new ArrayList<>();\n\n  void deposit(int amount) { accounts.add(amount); }\n\n  long total() {\n    long sum = 0;\n    for (int a : accounts) sum += a;\n    return sum;\n  }\n\n  public static void main(String[] args) {\n    Bank b = new Bank();\n    for (int i = 0; i < 1000; i++) b.deposit(i);\n    System.out.println("accounts " + b.accounts.size() + " total " + b.total());\n  }\n}\n`;

await step('toolchain install java', async () => {
  const r = expectOk(await sh('toolchain install java'), 'toolchain install java');
  if (!/Java: \d+ packages installed/.test(r.out)) throw new Error(`no prebuilt java layer on this server:\n${r.out}`);
  if (!/compiler is starting in the background/.test(r.out)) throw new Error(`the compiler was not started:\n${r.out}`);
  await sh('mkdir -p /tmp/javafast && cd /tmp/javafast');
  await write('/tmp/javafast/Hello.java', HELLO('Hello, world'));
  await write('/tmp/javafast/Bank.java', BANK);
});

// tabcomputer#122: each of these exited 139 (Blink patch 0552)
await step('JVM flags: -Xint, -XX:TieredStopAtLevel=1, -Xshare:auto', async () => {
  for (const flags of ['-Xint', '-XX:TieredStopAtLevel=1', '-Xshare:auto -XX:TieredStopAtLevel=1']) {
    const r = await sh(`java ${flags} -version`);
    if (r.code !== 0 || !/OpenJDK/.test(r.out)) throw new Error(`java ${flags} -version: exit ${r.code}\n${r.out}`);
  }
  const d = await sh('dmesg | grep -c segfault');
  if (d.out.trim() !== '0') throw new Error(`dmesg shows ${d.out.trim()} segfaults`);
});

// src/java-defaults.ts: at the prompt (the shell starts it) and from another program (the kernel does)
await step("the JVM starts with the emulator's options, unless told otherwise", async () => {
  const level = async (cmd) => {
    const r = await sh(cmd);
    const m = /TieredStopAtLevel\s*=\s*(\d)/.exec(r.out);
    if (!m) throw new Error(`${cmd}: exit ${r.code}\n${r.out.slice(-400)}`);
    return m[1];
  };
  const flags = 'java -XX:+PrintFlagsFinal -version 2>&1 | grep -E " (TieredStopAtLevel|UseSerialGC) "';
  if (await level(flags) !== '1') throw new Error('at the prompt: not -XX:TieredStopAtLevel=1');
  if (await level(`sh -c 'java -XX:+PrintFlagsFinal -version' 2>&1 | grep " TieredStopAtLevel "`) !== '1') throw new Error('from sh -c: not -XX:TieredStopAtLevel=1');
  if (await level(`TABCOMPUTER_JVM_DEFAULTS=0 ${flags}`) !== '4') throw new Error('TABCOMPUTER_JVM_DEFAULTS=0 still set it');
  if (await level('java -XX:TieredStopAtLevel=3 -XX:+PrintFlagsFinal -version 2>&1 | grep " TieredStopAtLevel "') !== '3') throw new Error("the user's own level did not win");
  const gc = await sh('java -XX:+UseParallelGC -version');
  if (gc.code !== 0) throw new Error(`java -XX:+UseParallelGC -version: exit ${gc.code}\n${gc.out}`);
});

await step('first javac (waits for the compiler to start)', async () => {
  const r = expectOk(await sh('javac Hello.java'), 'javac Hello.java');
  if (r.out.trim()) throw new Error(`javac printed: ${r.out}`);
  const st = await sh('javac --tabcomputer-status');
  if (!/is running/.test(st.out)) throw new Error(`not compiled by the warm compiler: ${st.out}`);
  const run = expectOk(await sh('java Hello'), 'java Hello');
  if (run.out !== 'Hello, world\n') throw new Error(`java Hello printed: ${run.out}`);
});

const warm = [];
await step('warm javac: an edited Hello, then Bank', async () => {
  for (let i = 1; i <= 3; i++) {
    await write('/tmp/javafast/Hello.java', HELLO(`edit ${i}`));
    const r = expectOk(await sh('javac Hello.java'), 'javac Hello.java');
    warm.push(r.ms);
    const run = expectOk(await sh('java Hello'), 'java Hello');
    if (run.out !== `edit ${i}\n`) throw new Error(`java Hello printed ${JSON.stringify(run.out)} after edit ${i}`);
    warm.push(run.ms);
  }
  const b = expectOk(await sh('javac Bank.java && java Bank'), 'javac Bank.java && java Bank');
  if (b.out !== 'accounts 1000 total 499500\n') throw new Error(`java Bank printed: ${b.out}`);
  const compiles = warm.filter((_, i) => i % 2 === 0), runs = warm.filter((_, i) => i % 2 === 1);
  if (Math.min(...compiles) > WARM_LIMIT) throw new Error(`warm compiles took ${compiles.join(', ')} ms (limit ${WARM_LIMIT})`);
  return `javac ${compiles.join(', ')} ms; java ${runs.join(', ')} ms; javac Bank && java Bank ${b.ms} ms`;
});

await step("errors are javac's, with the name as typed", async () => {
  await write('/tmp/javafast/Bad.java', 'public class Bad {\n  int x = ;\n  String s = 1;\n}\n');
  const r = await sh('javac Bad.java');
  if (r.code !== 1) throw new Error(`exit ${r.code}\n${r.out}`);
  if (r.out !== 'Bad.java:2: error: illegal start of expression\n  int x = ;\n          ^\n1 error\n') throw new Error(`printed:\n${r.out}`);
  const cls = await sh('ls Bad.class');
  if (cls.code === 0) throw new Error('Bad.class was written');
});

await step('a class used by another: rebuilt, then deleted', async () => {
  await write('/tmp/javafast/Helper.java', 'public class Helper { static int n() { return 1; } }\n');
  await write('/tmp/javafast/Main.java', 'public class Main { public static void main(String[] a) { System.out.println(Helper.n()); } }\n');
  expectOk(await sh('javac Main.java'), 'javac Main.java');
  const one = expectOk(await sh('java Main'), 'java Main');
  if (one.out !== '1\n') throw new Error(`java Main printed ${one.out}`);
  await sh('rm -f Helper.java Helper.class');
  const gone = await sh('javac Main.java');
  if (gone.code !== 1 || !/cannot find symbol/.test(gone.out) || !/variable Helper/.test(gone.out)) throw new Error(`with Helper gone: exit ${gone.code}\n${gone.out}`);
});

await step('what the warm compiler does not take goes to the real javac', async () => {
  const v = expectOk(await sh('javac -version'), 'javac -version');
  if (!/^javac 21/.test(v.out)) throw new Error(`javac -version printed: ${v.out}`);
  const none = await sh('javac Missing.java');
  if (none.code === 0 || !/file not found: Missing.java/.test(none.out)) throw new Error(`javac Missing.java: exit ${none.code}\n${none.out}`);
  const real = expectOk(await sh('rm -f Hello.class; TABCOMPUTER_JAVAC=jvm javac Hello.java && ls Hello.class'), 'TABCOMPUTER_JAVAC=jvm javac');
  return `the real javac: ${real.ms} ms`;
});

await step('stopped, the next compile starts it again', async () => {
  await sh('javac --tabcomputer-stop');
  const st = await sh('javac --tabcomputer-status');
  if (!/not running/.test(st.out)) throw new Error(st.out);
  expectOk(await sh('rm -f Bank.class; javac Bank.java && ls Bank.class'), 'javac Bank.java');
});

await browser.close();
process.exit(failed ? 1 : 0);
