// Claude Code, interactive (opt-in: --suites claude; isolated only). Both
// builds, typed at the real terminal of a fresh profile, against the local
// mock Messages API (lib/mockmodel.mjs): claude_native.* is Anthropic's
// linux-x64-musl build in Blink (reaching the mock through server.mjs's TCP
// relay), claude_npm.* the pinned JS build on tabcomputer's node (installed
// before the round; its fetch goes straight to the mock). Same definitions
// for both; the list below names the native ones. Every time is taken in the page
// with performance.now(), from the term.input() that types the key to:
// - `parsed`: the xterm buffer showing the effect (onWriteParsed);
// - `frame`: the end of the next animation frame after that, i.e. the
//   frame that paints it (rAF, then a task after the frame).
// Metrics (cold = first launch in a fresh profile; warm = the next launch in
// the same page, Blink's and the kernel's caches warm):
//   claude_native.start.{cold,warm}.first_screen   Enter on `claude` → first output from Claude
//   claude_native.start.{cold,warm}.prompt         Enter → the input prompt, idle (❯ and the shortcuts hint)
//   claude_native.rss_at_prompt                    renderer RSS at the cold prompt
//   claude_native.echo.first                       first key, 1.5 s after the prompt → its echo (the first input Claude handles)
//   claude_native.echo.{p50,p90,p99,max}           after SETTLE_MS, keys typed one at a time, ECHO_GAP_MS after
//                                                  the previous echo, each → the input line starting with all keys so far
//   claude_native.echo_burst.total                 ECHO_BURST keys typed at once → the last one echoed
//   claude_native.turn                             Enter on a prompt → the mocked reply shows
// Each has a `.frame` twin for the painted frame. `claude_native.native.*` is
// the same binary on this machine's Linux in a pty (needs musl's loader at
// /lib/ld-musl-x86_64.so.1, e.g. `apt-get install musl`): bench/lib/native-pty.py.
// Fixtures as in workloads-slow: bench/.cache/fixtures/claude-native and
// ld-musl-x86_64.so.1 (bench/README.md); the bench never downloads them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_KEY } from '../lib/mockmodel.mjs';

export const name = 'claude';
export const ownPages = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO_KEYS = 'benchechoqwertyuiopasdfghjklzxcvbnm'; // no spaces: trailing blanks are trimmed from rows
const ECHO_GAP_MS = 150;
const ECHO_BURST = 'zyxwvutsrq';
const SETTLE_MS = 20000; // before the steady-state echo series
const TURN_LIMIT_MS = 180000;
const EXIT_LIMIT_MS = 120000;
const PROMPT_RE = /for shortcuts|shift\+tab to cycle|\? for|Try "/;
const ENV = (url) => `ANTHROPIC_BASE_URL=${url} ANTHROPIC_API_KEY=${FAKE_KEY} DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_ERROR_REPORTING=1`;

/** Claude's config: onboarding done, the key approved, ~/w trusted and its CLAUDE.md imports allowed (no dialogs at start). */
const claudeJson = (home, cwd) => JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', lastOnboardingVersion: '9.9.9',
  customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true, allowedTools: [] } },
});

// In-page helpers, installed once per page: window.__cn
const install = (h) => h.eval(() => {
  const T = window.__tabcomputer.terminal.term;
  const screen = () => {
    const b = T.buffer.active;
    const rows = [];
    for (let y = b.viewportY; y < b.viewportY + T.rows; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
    return rows.join('\n');
  };
  const afterFrame = () => new Promise((r) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => r(performance.now()); c.port2.postMessage(0); }));
  /** Types `data`, resolves with { parsed, frame } (ms) once test(screen) holds, or null after limitMs. */
  const until = (data, test, limitMs) => new Promise((resolve) => {
    let done = false, timer;
    const t0 = performance.now();
    const check = () => {
      if (done || !test(screen())) return;
      done = true; sub.dispose(); clearTimeout(timer);
      const parsed = performance.now() - t0;
      afterFrame().then((f) => resolve({ parsed, frame: f - t0 }));
    };
    const sub = T.onWriteParsed(check);
    timer = setTimeout(() => { if (!done) { done = true; sub.dispose(); resolve(null); } }, limitMs);
    if (data) T.input(data, true);
    check();
  });
  /** The text after Claude's input mark (❯ or >, also inside a │ box) on each line that has one. */
  const inputs = (s) => s.split('\n').map((l) => /^\s*(?:│\s*)?[❯>]\s?(.*)$/.exec(l)?.[1]).filter((x) => x != null);
  /** True when an input line starts with `typed`: the echo, not the same letters elsewhere on screen. */
  const echoed = (s, typed) => inputs(s).some((x) => x.startsWith(typed));
  window.__cn = { screen, until, inputs, echoed, T };
});

/**
 * Runs `fn` (a page.evaluate) while checking every 15 s that the page still
 * answers. After 60 s without an answer the main thread is frozen: pause it
 * through CDP, log its stack (and the watchdog's), and fail instead of hanging.
 */
async function guarded(h, label, fn) {
  let frozen = null;
  let stop = false;
  const t0 = Date.now();
  const watch = (async () => {
    let missed = 0;
    while (!stop) {
      await new Promise((r) => setTimeout(r, 15000));
      if (stop) return;
      const t = Date.now();
      const tail = await Promise.race([h.page.evaluate(() => window.__cn?.screen().split('\n').filter((l) => l.trim()).slice(-6).join(' | ').slice(-300) ?? '').catch(() => ''), new Promise((r) => setTimeout(() => r(null), 5000))]);
      missed = tail !== null ? 0 : missed + 1;
      if (process.env.BENCH_VERBOSE) h.log(`    [${label} +${Math.round((t - t0) / 1000)} s, ${tail === null ? 'no answer in 5 s' : `answered in ${Date.now() - t} ms`}] ${tail ?? ''}`);
      if (missed >= 4) {
        let stack = '(no stack)';
        try {
          const within = (p, ms, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`${what}: no reply in ${ms} ms`)), ms))]);
          const cdp = await within(h.page.context().newCDPSession(h.page), 10000, 'CDP session');
          await within(cdp.send('Debugger.enable'), 10000, 'Debugger.enable');
          const paused = new Promise((r) => cdp.once('Debugger.paused', r));
          await within(cdp.send('Debugger.pause'), 10000, 'Debugger.pause');
          const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 10000))]);
          stack = ev ? ev.callFrames.slice(0, 25).map((f) => `  ${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber + 1}`).join('\n') : '(pause did not take: blocked outside JS?)';
          await cdp.send('Debugger.resume').catch(() => {});
        } catch (e) { stack = `(pause failed: ${e.message})`; }
        h.log(`    ${label}: page frozen for 60 s; main thread:\n${stack}`);
        frozen = new Error(`${label}: the page froze (main thread stack logged)`);
        return;
      }
    }
  })();
  try {
    return await Promise.race([fn(), watch.then(() => { if (frozen) throw frozen; return new Promise(() => {}); })]);
  } finally { stop = true; }
}

/** Starts `claude` in ~/w and waits for the first output and the idle prompt. */
const startClaude = (h, cmd, limitMs) => guarded(h, 'claude start', () => h.eval(async ([cmd, limitMs, promptSrc]) => {
  const { until, screen, T } = window.__cn;
  const PROMPT = new RegExp(promptSrc);
  // the previous launch's last frame can still be on screen (the npm build exits on the normal
  // screen): keep only the shell's prompt line, so the prompt test sees this launch's output
  T.clear();
  T.input(cmd, true); // the command line without its Enter: the shell echoes it
  await new Promise((r) => setTimeout(r, 300));
  // the whole normal buffer, trailing blank rows dropped: the shell's newline changes nothing
  const all = () => {
    const b = T.buffer.normal;
    const rows = [];
    for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
    return rows.join('\n').trimEnd();
  };
  const before = all();
  const t0 = performance.now();
  const ready = (s) => PROMPT.test(s) && /^\s*[❯>]/m.test(s);
  let firstScreen = null;
  const p = until('\r', (s) => {
    if (!firstScreen && (T.buffer.active.type === 'alternate' ? s.trim() : all() !== before)) firstScreen = { parsed: performance.now() - t0 };
    return ready(s);
  }, limitMs);
  const r = await p;
  return { firstScreen, prompt: r, screen: screen() };
}, [cmd, limitMs, PROMPT_RE.source]));

/** Types `keys` one at a time, waiting for each echo; [{ parsed, frame }]. */
const echoKeys = (h, keys, gapMs, limitMs, profile = false) => h.eval(async ([keys, gapMs, limitMs, profile]) => {
  const { until, screen, echoed } = window.__cn;
  // the kernel's pty trace (Build 975+) times each key's stages: pty input → the guest's read
  // (readMs) → its first write back (firstWriteMs); feature-detected
  const kernel = window.__tabcomputer.kernel;
  const prof = profile && typeof kernel?.startProfile === 'function';
  if (prof) kernel.startProfile();
  const stages = () => {
    if (!prof) return null;
    const keys = (kernel.stopProfile()?.keys ?? []).filter((k) => k.readMs >= 0);
    // echoMs (newer builds): the read → the first write holding the key's bytes, i.e. the echo
    // itself; firstWriteMs: → the first write of any kind
    return keys.map((k) => ({ read: k.readMs, compute: k.echoMs >= 0 ? k.echoMs : k.firstWriteMs, exact: k.echoMs >= 0 }));
  };
  const out = [];
  let typed = '';
  for (const k of keys) {
    typed += k;
    const want = typed;
    const r = await until(k, (s) => echoed(s, want), limitMs);
    if (!r) { stages(); return { out, error: `no echo of ${JSON.stringify(want)} in ${limitMs} ms: ${screen().slice(-600)}` }; }
    out.push(r);
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return { out, stages: stages() };
}, [keys, gapMs, limitMs, profile]);

/** Clears Claude's input line: Ctrl-U until the input line no longer starts with `typed`. */
const clearInput = (h, typed) => h.eval(async (typed) => {
  const { until, echoed } = window.__cn;
  await until('\x15', (s) => !echoed(s, typed.slice(0, 1)), 10000);
}, typed);

const sideSh = (h, cmd) => h.eval(async (c) => { const sh = window.__tabcomputer.shell.fork(); sh.terminal = null; let o = ''; const code = await sh.execute(c, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o }; }, cmd);

/** The shell's prompt (`user@tabcomputer:~/w$`) on the screen's last non-empty line. */
const SHELL_PROMPT = /^[\w.-]+@[\w.-]+:[^\n]*[$#] ?$/;

/**
 * /exit (its Enter on its own: text and CR in one input are a paste), then the shell's prompt
 * on the last line; a marker the shell prints confirms it reads input again (typed only then:
 * typed earlier, Claude would take it). { ms } from the Enter to the prompt, or { hung,
 * recovered } when Claude didn't exit within EXIT_LIMIT_MS: then its process is killed from a
 * side shell, and `recovered` says whether the shell came back.
 */
async function exitClaude(h) {
  const shellBack = (limit, key = '') => h.eval(async ([limit, re, key]) => {
    const { until, T } = window.__cn;
    const P = new RegExp(re);
    const last = (s) => s.split('\n').filter((l) => l.trim()).pop() ?? '';
    const p = await until(key, (s) => T.buffer.active.type === 'normal' && P.test(last(s)), limit);
    if (!p) return null;
    return await until('echo @@cn-$((6*7))\r', (s) => /^@@cn-42$/m.test(s), 30000) ? p.parsed : null;
  }, [limit, SHELL_PROMPT.source, key]);
  await h.eval(async () => {
    const { T } = window.__cn;
    T.input('\x15', true);
    await new Promise((r) => setTimeout(r, 300));
    T.input('/exit', true);
    await new Promise((r) => setTimeout(r, 500));
  });
  const ms = await shellBack(EXIT_LIMIT_MS, '\r');
  if (ms != null) return { ms };
  const ps = (await sideSh(h, 'ps -ef')).out;
  const pids = ps.split('\n').filter((l) => /claude-code\/cli\.js|claude|ld-musl/.test(l)).map((l) => l.trim().split(/\s+/)[0]).filter((x) => /^\d+$/.test(x));
  h.log(`    claude did not exit within ${EXIT_LIMIT_MS / 1000} s of /exit; processes:\n${ps.trimEnd()}\n    screen: ${(await h.eval(() => window.__cn.screen())).split('\n').filter((l) => l.trim()).slice(-4).join(' | ').slice(-300)}`);
  if (pids.length) await sideSh(h, `kill -9 ${pids.join(' ')}`);
  return { hung: true, recovered: (await shellBack(30000)) != null };
}

async function round(h, add, mock, { cold, build }) {
  const cmd = `cd ~/w && ${ENV(mock.url)} claude --${build}`;
  const tag = cold ? 'cold' : 'warm';
  const s = await startClaude(h, cmd, 600000);
  if (!s.prompt) h.log(`    ${tag} start screen:\n${s.screen.trimEnd()}`);
  if (!s.prompt) throw new Error(`${tag} start: no prompt in 600 s (mock saw ${mock.calls()} calls: ${mock.paths.slice(-5).join(', ')}): ${s.screen.trimEnd().split('\n').slice(-12).join(' | ').slice(-1200)}`);
  if (s.firstScreen) add(`start.${tag}.first_screen`, s.firstScreen.parsed);
  add(`start.${tag}.prompt`, s.prompt.parsed); add(`start.${tag}.prompt.frame`, s.prompt.frame);
  if (cold) {
    add('rss_at_prompt', (await h.rendererRss()) / 2 ** 20);
    await h.page.waitForTimeout(1500);
    // the first key Claude handles, right after its prompt
    const f = await echoKeys(h, ECHO_KEYS[0], 0, 60000);
    if (f.error) throw new Error(f.error);
    add('echo.first', f.out[0].parsed); add('echo.first.frame', f.out[0].frame);
    await clearInput(h, ECHO_KEYS[0]);
    // steady state: after the startup work (MCP, hooks, the first render passes) is done
    await h.page.waitForTimeout(SETTLE_MS);
    const e = await guarded(h, 'echo', () => echoKeys(h, ECHO_KEYS, ECHO_GAP_MS, 30000, true));
    if (e.error) throw new Error(e.error);
    for (const r of e.out) { add('echo', r.parsed); add('echo.frame', r.frame); }
    // one trace entry per key typed: the rest of each echo is the write → xterm → the match
    if (e.stages?.length === e.out.length) {
      e.stages.forEach((st, i) => {
        add('echo.stage.read', st.read); add('echo.stage.compute', st.compute); add('echo.stage.exact', st.exact ? 1 : 0);
        add('echo.stage.render', e.out[i].parsed - st.read - st.compute);
      });
    } else if (e.stages) h.log(`    echo stages: ${e.stages.length} traced keys for ${e.out.length} typed; not recorded`);
    await clearInput(h, ECHO_KEYS);
    await h.page.waitForTimeout(500);
    // a burst: every key in one go (fast typing), first key → the last one echoed
    const b = await h.eval(async (keys) => {
      const { until, echoed, T } = window.__cn;
      const t0 = performance.now();
      for (const k of keys.slice(0, -1)) T.input(k, true);
      const off = performance.now() - t0; // until() times from its own start
      const r = await until(keys.slice(-1), (s) => echoed(s, keys), 30000);
      return r && { parsed: r.parsed + off, frame: r.frame + off };
    }, ECHO_BURST);
    if (b) { add('echo_burst.total', b.parsed); add('echo_burst.total.frame', b.frame); }
    await clearInput(h, ECHO_BURST);
    await h.page.waitForTimeout(500);
    // one turn against the mock
    await h.eval((l) => window.__cn.T.input(l, true), 'bench turn 1: say something');
    await h.page.waitForTimeout(500);
    const calls = mock.calls();
    const t = await guarded(h, 'turn', () => h.eval((ms) => window.__cn.until('\r', (s) => /BENCH-REPLY-1/.test(s), ms), TURN_LIMIT_MS));
    if (t) { add('turn', t.parsed); add('turn.frame', t.frame); }
    else h.log(`    turn: no reply in ${TURN_LIMIT_MS / 1000} s; the mock saw ${mock.calls() - calls} model calls (${mock.paths.slice(-6).join(', ') || 'no requests'}): ${(await h.eval(() => window.__cn.screen())).split('\n').filter((l) => l.trim()).slice(-8).join(' | ').slice(-600)}`);
    await h.eval(() => window.__cn.T.input('\x1b', true)); // Esc: stop a turn still running
    await h.page.waitForTimeout(1000);
  }
  const ex = await exitClaude(h);
  if (!ex.hung) add(`exit.${tag}`, ex.ms);
  else {
    add(`exit_hung.${tag}`, 1);
    if (!ex.recovered) throw new Error(`claude --${build} was still running ${EXIT_LIMIT_MS / 1000} s after /exit, and kill -9 did not give the shell back: the rest of the round is skipped`);
  }
}

/** The same binary natively in a pty on this machine: { start: {first, prompt}, echo: [ms] } per round. */
function nativeRounds(h, binary, rounds, mockUrl) {
  if (!existsSync('/lib/ld-musl-x86_64.so.1')) return { skip: 'no musl loader at /lib/ld-musl-x86_64.so.1 on this machine (apt-get install musl)' };
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const home = mkdtempSync(join(tmpdir(), 'cn-native-'));
    try {
      const cwd = join(home, 'w');
      mkdirSync(cwd);
      writeFileSync(join(home, '.claude.json'), claudeJson(home, cwd));
      const env = { PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', LANG: 'C.UTF-8', ANTHROPIC_BASE_URL: mockUrl, ANTHROPIC_API_KEY: FAKE_KEY, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1' };
      const r = execFileSync('python3', ['-I', join(HERE, '..', 'lib', 'native-pty.py'), binary, cwd, PROMPT_RE.source, ECHO_KEYS, String(ECHO_GAP_MS)], { env, encoding: 'utf8', timeout: 300000 });
      out.push(JSON.parse(r.trim().split('\n').pop()));
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  return { out };
}

/** Percentile rows (p50/p90/p99/max) of `xs` as `${name}.pNN`. */
function percentiles(h, name, xs, notes) {
  if (!xs?.length) return;
  const q = (p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
  h.sample(`${name}.p50`, [q(0.5)], 'ms', { notes: `${notes}: median over ${xs.length} keys` });
  h.sample(`${name}.p90`, [q(0.9)], 'ms', { notes: 'p90, same keys' });
  h.sample(`${name}.p99`, [q(0.99)], 'ms', { notes: 'p99, same keys' });
  h.sample(`${name}.max`, [Math.max(...xs)], 'ms', { notes: 'slowest key' });
}

const BUILDS = {
  native: { what: '`claude --native` (linux-x64-musl in Blink)', needs: ['claude-native', 'ld-musl-x86_64.so.1'] },
  npm: { what: '`claude --npm` (the pinned JS build on tabcomputer\'s node; installed before the round)', needs: [] },
};

/** `rounds` fresh profiles of one build: a cold and a warm launch each; samples as claude_<build>.*. */
async function measureBuild(h, build, mock, rounds) {
  const pre = `claude_${build}`;
  const R = {};
  const add = (k, v) => (R[k] ??= []).push(v);
  for (let i = 0; i < rounds; i++) {
    await h.try(`${pre}.round${i + 1}`, '', async () => {
      await h.page?.context().close().catch(() => {});
      await h.boot({ path: '/?ui=terminal' });
      await h.page.context().route((u) => u.href.startsWith(mock.url), (r) => r.continue());
      for (const ev of ['crash', 'close', 'popup', 'dialog']) h.page.on(ev, (x) => h.log(`    page ${ev}${x?.url ? `: ${x.url()}` : ''}${x?.message ? `: ${x.message()}` : ''}`));
      h.page.on('framenavigated', (f) => { if (f === h.page.mainFrame()) h.log(`    page navigated: ${f.url()}`); });
      if (build === 'native') {
        await h.eval(async () => {
          await window.__bench.fetchInto('/__bench/claude-native', '/home/user/.local/bin/claude');
          await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
        });
        await h.sh('chmod +x ~/.local/bin/claude /lib/ld-musl-x86_64.so.1');
      } else {
        // installed first (workload.claude_npm.first measures that), so cold is the first launch, not the install
        const r = await h.eval(() => window.__bench.shLimit('claude --npm --version > /tmp/cn.out 2>&1', 300000));
        if (r.code !== 0) throw new Error(`claude --npm --version: exit ${r.code}: ${(await h.sh('cat /tmp/cn.out')).out.slice(-200)}`);
      }
      await h.eval((json) => window.__bench.writeFile('/home/user/.claude.json', json), claudeJson('/home/user', '/home/user/w'));
      await h.sh('mkdir -p ~/w');
      await install(h);
      await round(h, add, mock, { cold: true, build });
      await round(h, add, mock, { cold: false, build });
    }, { force: true });
  }
  const S = (key, unit, notes) => { if (R[key]?.length) h.sample(`${pre}.${key}`, R[key], unit, { notes }); };
  const B = `${BUILDS[build].what} in a fresh profile, mock model`;
  S('start.cold.first_screen', 'ms', `${B}: Enter → Claude's first output in the terminal buffer`);
  S('start.cold.prompt', 'ms', `${B}: Enter → the idle input prompt in the buffer`);
  S('start.cold.prompt.frame', 'ms', 'same, to the end of the frame that paints it');
  S('start.warm.first_screen', 'ms', 'second launch in the same page: Enter → first output');
  S('start.warm.prompt', 'ms', 'second launch: Enter → idle prompt');
  S('start.warm.prompt.frame', 'ms', 'same, painted');
  S('rss_at_prompt', 'MiB', 'renderer RSS (workers included) at the cold prompt');
  S('echo.first', 'ms', 'first key typed at the prompt (1.5 s after it shows) → its echo on the input line');
  S('echo.first.frame', 'ms', 'same, painted');
  percentiles(h, `${pre}.echo`, R.echo, `key → its echo on the input line, ${ECHO_KEYS.length} keys ${ECHO_GAP_MS} ms apart after each echo, from ${SETTLE_MS / 1000} s after the prompt`);
  percentiles(h, `${pre}.echo.frame`, R['echo.frame'], 'key → the painted frame showing it');
  percentiles(h, `${pre}.echo.stage.read`, R['echo.stage.read'], "stage 1 of the same keys (kernel pty trace, Build 975+): pty input → Claude's read of it");
  const exact = R['echo.stage.exact']?.every((x) => x === 1);
  percentiles(h, `${pre}.echo.stage.compute`, R['echo.stage.compute'], exact
    ? "stage 2: that read → the pty write holding the key (the echo; the trace's echoMs)"
    : "stage 2: that read → Claude's first write to the pty (the trace's firstWriteMs; builds before echoMs)");
  percentiles(h, `${pre}.echo.stage.render`, R['echo.stage.render'], 'stage 3: the rest of the echo, from that first write to the input line matched (xterm parse, and any later writes when the first one was not the echo)');
  S('echo_burst.total', 'ms', `${ECHO_BURST.length} keys typed at once → the last echoed`);
  S('echo_burst.total.frame', 'ms', 'same, painted');
  S('turn', 'ms', 'Enter on a prompt → the mocked reply in the buffer');
  S('exit.cold', 'ms', '`/exit` Enter → the shell runs the next command (after the turn)');
  S('exit.warm', 'ms', 'same, second launch (no turn)');
  for (const t of ['cold', 'warm']) {
    if (R[`exit_hung.${t}`]) h.sample(`${pre}.exit_hung.${t}`, R[`exit_hung.${t}`], 'count', { notes: `rounds where claude was still running ${EXIT_LIMIT_MS / 1000} s after /exit (killed to go on)` });
  }
}

export async function run(h) {
  if (!h.isolated) { h.skip('claude.suite', '', 'measured in the isolated (production) configuration only; native Claude Code needs Blink'); return; }
  if (!h.mockModel) { h.skip('claude.suite', '', 'no mock model server (needs a non-loopback address on this machine)'); return; }
  const mock = h.mockModel;
  const rounds = h.quick ? 1 : Math.min(h.runs, 3);
  for (const build of Object.keys(BUILDS)) {
    const pre = `claude_${build}`;
    if (!h.wantsAny(pre, `${pre}.start.cold.prompt`, `${pre}.echo.p50`)) continue;
    const missing = BUILDS[build].needs.filter((f) => !h.fixtures[f]);
    if (missing.length) {
      h.skip(`${pre}.start.cold.prompt`, 'ms', 'native Claude Code not cached: put the linux-x64-musl binary at bench/.cache/fixtures/claude-native and musl\'s loader at bench/.cache/fixtures/ld-musl-x86_64.so.1 (bench/README.md); never downloaded by the bench');
      continue;
    }
    await measureBuild(h, build, mock, rounds);
  }

  if (h.fixtures['claude-native'] && h.wantsAny('claude_native.native', 'claude_native.native.start.prompt', 'claude_native.native.echo.p50')) {
    const nat = nativeRounds(h, h.fixtures['claude-native'], rounds, mock.url);
    if (nat.skip) h.skip('claude_native.native.start.prompt', 'ms', nat.skip);
    else {
      const N = {};
      const nadd = (k, v) => (N[k] ??= []).push(v);
      for (const r of nat.out) {
        if (r.error) { h.skip('claude_native.native.round', '', r.error.slice(0, 300)); continue; }
        nadd('first', r.first_output); nadd('prompt', r.prompt);
        for (const e of r.echo) nadd('echo', e);
      }
      const what = "the same binary natively on this machine's Linux in a pty (bench/lib/native-pty.py)";
      if (N.first) h.sample('claude_native.native.start.first_screen', N.first, 'ms', { notes: `native reference: ${what}: exec → first output` });
      if (N.prompt) h.sample('claude_native.native.start.prompt', N.prompt, 'ms', { notes: 'native: exec → the prompt text in the output' });
      percentiles(h, 'claude_native.native.echo', N.echo, "native: key written to the pty → the key in Claude's output");
    }
  }
}
