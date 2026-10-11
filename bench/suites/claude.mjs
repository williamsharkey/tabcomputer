// Native Claude Code, interactive (opt-in: --suites claude; isolated only).
// Anthropic's linux-x64-musl build in Blink, typed at the real terminal of a
// fresh profile, against the local mock Messages API (lib/mockmodel.mjs,
// reached through server.mjs's TCP relay). Every time is taken in the page
// with performance.now(), from the term.input() that types the key to:
// - `parsed`: the xterm buffer showing the effect (onWriteParsed);
// - `frame`: the end of the next animation frame after that, i.e. the
//   frame that paints it (rAF, then a task after the frame).
// Metrics (cold = first launch in a fresh profile; warm = the next launch in
// the same page, Blink's and the kernel's caches warm):
//   claude_native.start.{cold,warm}.first_screen   Enter on `claude` → first output from Claude
//   claude_native.start.{cold,warm}.prompt         Enter → the input prompt, idle (❯ and the shortcuts hint)
//   claude_native.echo.first                       first key at the prompt → its echo (the first input Claude handles)
//   claude_native.echo.{p50,p90,p99,max}           keys typed one at a time, ECHO_GAP_MS apart, each → its echo
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
const PROMPT_RE = /for shortcuts|shift\+tab to cycle|\? for|Try "/;
const ENV = (url) => `ANTHROPIC_BASE_URL=${url} ANTHROPIC_API_KEY=${FAKE_KEY} DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_ERROR_REPORTING=1`;

/** Claude's config: onboarding done, the key approved, ~/w trusted (no dialogs at start). */
const claudeJson = (home, cwd) => JSON.stringify({
  hasCompletedOnboarding: true, theme: 'dark', lastOnboardingVersion: '9.9.9',
  customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
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
  window.__cn = { screen, until, T };
});

/** Starts `claude` in ~/w and waits for the first output and the idle prompt. */
const startClaude = (h, cmd, limitMs) => h.eval(async ([cmd, limitMs, promptSrc]) => {
  const { until, screen, T } = window.__cn;
  const PROMPT = new RegExp(promptSrc);
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
}, [cmd, limitMs, PROMPT_RE.source]);

/** Types `keys` one at a time, waiting for each echo; [{ parsed, frame }]. */
const echoKeys = (h, keys, gapMs, limitMs) => h.eval(async ([keys, gapMs, limitMs]) => {
  const { until, screen } = window.__cn;
  const out = [];
  let typed = '';
  for (const k of keys) {
    typed += k;
    const want = typed;
    const r = await until(k, (s) => s.includes(want), limitMs);
    if (!r) return { out, error: `no echo of ${JSON.stringify(want)} in ${limitMs} ms: ${screen().slice(-600)}` };
    out.push(r);
    await new Promise((res) => setTimeout(res, gapMs));
  }
  return { out };
}, [keys, gapMs, limitMs]);

/** Clears Claude's input line: Ctrl-U until the prompt holds no typed text. */
const clearInput = (h, typed) => h.eval(async (typed) => {
  const { until } = window.__cn;
  await until('\x15', (s) => !s.includes(typed.slice(0, 6)), 10000);
}, typed);

async function exitClaude(h) {
  // Ctrl-C twice exits from an empty prompt; then wait for the shell
  await h.eval(async () => {
    const { until, T } = window.__cn;
    T.input('\x03', true);
    await new Promise((r) => setTimeout(r, 400));
    T.input('\x03', true);
    await until('', () => T.buffer.active.type === 'normal', 30000);
    await new Promise((r) => setTimeout(r, 500));
    await until('echo @@cn-exit\r', (s) => /^@@cn-exit$/m.test(s), 30000);
  });
}

async function round(h, add, mock, { cold }) {
  const cmd = `cd ~/w && ${ENV(mock.url)} claude --native`;
  const tag = cold ? 'cold' : 'warm';
  const s = await startClaude(h, cmd, 600000);
  if (!s.prompt) throw new Error(`${tag} start: no prompt in 600 s (mock saw ${mock.calls()} calls: ${mock.paths.slice(-5).join(', ')}): ${s.screen.slice(-800)}`);
  if (s.firstScreen) add(`start.${tag}.first_screen`, s.firstScreen.parsed);
  add(`start.${tag}.prompt`, s.prompt.parsed); add(`start.${tag}.prompt.frame`, s.prompt.frame);
  await h.page.waitForTimeout(1500); // let startup work (MCP, hooks) settle
  if (cold) {
    const e = await echoKeys(h, ECHO_KEYS, ECHO_GAP_MS, 30000);
    if (e.error) throw new Error(e.error);
    add('echo.first', e.out[0].parsed); add('echo.first.frame', e.out[0].frame);
    for (const r of e.out.slice(1)) { add('echo', r.parsed); add('echo.frame', r.frame); }
    await clearInput(h, ECHO_KEYS);
    await h.page.waitForTimeout(500);
    // a burst: every key in one go (fast typing / a paste of single keys)
    const b = await h.eval(async (keys) => {
      const { until, T } = window.__cn;
      const t0 = performance.now();
      for (const k of keys.slice(0, -1)) T.input(k, true);
      const r = await until(keys.slice(-1), (s) => s.includes(keys), 30000);
      return r && { parsed: r.parsed + 0, frame: r.frame, total: performance.now() - t0 };
    }, ECHO_BURST);
    if (b) { add('echo_burst.total', b.parsed); add('echo_burst.total.frame', b.frame); }
    await clearInput(h, ECHO_BURST);
    await h.page.waitForTimeout(500);
    // one turn against the mock
    await h.eval((l) => window.__cn.T.input(l, true), 'bench turn 1: say something');
    await h.page.waitForTimeout(500);
    const t = await h.eval(() => window.__cn.until('\r', (s) => /BENCH-REPLY-1/.test(s), 600000));
    if (t) { add('turn', t.parsed); add('turn.frame', t.frame); }
    await h.page.waitForTimeout(1000);
  }
  await exitClaude(h);
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

export async function run(h) {
  if (!h.isolated) { h.skip('claude_native.suite', '', 'native Claude Code runs in Blink: cross-origin isolated only'); return; }
  if (!h.fixtures['claude-native'] || !h.fixtures['ld-musl-x86_64.so.1']) {
    h.skip('claude_native.start.cold.prompt', 'ms', 'native Claude Code not cached: put the linux-x64-musl binary at bench/.cache/fixtures/claude-native and musl\'s loader at bench/.cache/fixtures/ld-musl-x86_64.so.1 (bench/README.md); never downloaded by the bench');
    return;
  }
  if (!h.mockModel) { h.skip('claude_native.start.cold.prompt', 'ms', 'no mock model server (needs a non-loopback address on this machine)'); return; }
  const mock = h.mockModel;
  const rounds = h.quick ? 1 : Math.min(h.runs, 3);
  const R = {};
  const add = (k, v) => (R[k] ??= []).push(v);
  for (let i = 0; i < rounds; i++) {
    await h.try(`claude_native.round${i + 1}`, '', async () => {
      await h.page?.context().close().catch(() => {});
      await h.boot({ path: '/?ui=terminal' });
      await h.page.context().route((u) => u.href.startsWith(mock.url), (r) => r.continue());
      await h.eval(async (json) => {
        await window.__bench.fetchInto('/__bench/claude-native', '/home/user/.local/bin/claude');
        await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
        await window.__bench.writeFile('/home/user/.claude.json', json);
      }, claudeJson('/home/user', '/home/user/w'));
      await h.sh('mkdir -p ~/w && chmod +x ~/.local/bin/claude /lib/ld-musl-x86_64.so.1');
      await install(h);
      await round(h, add, mock, { cold: true });
      await round(h, add, mock, { cold: false });
    });
  }
  const S = (key, unit, notes) => { if (R[key]?.length) h.sample(`claude_native.${key}`, R[key], unit, { notes }); };
  const P = (key, notes) => {
    const xs = R[key];
    if (!xs?.length) return;
    const q = (p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };
    h.sample(`claude_native.${key}.p50`, [q(0.5)], 'ms', { notes: `${notes}: median over ${xs.length} keys` });
    h.sample(`claude_native.${key}.p90`, [q(0.9)], 'ms', { notes: 'p90, same keys' });
    h.sample(`claude_native.${key}.p99`, [q(0.99)], 'ms', { notes: 'p99, same keys' });
    h.sample(`claude_native.${key}.max`, [Math.max(...xs)], 'ms', { notes: 'slowest key' });
  };
  const B = '`claude --native` (linux-x64-musl in Blink) in a fresh profile, mock model';
  S('start.cold.first_screen', 'ms', `${B}: Enter → Claude's first output in the terminal buffer`);
  S('start.cold.prompt', 'ms', `${B}: Enter → the idle input prompt in the buffer`);
  S('start.cold.prompt.frame', 'ms', 'same, to the end of the frame that paints it');
  S('start.warm.first_screen', 'ms', 'second launch in the same page: Enter → first output');
  S('start.warm.prompt', 'ms', 'second launch: Enter → idle prompt');
  S('start.warm.prompt.frame', 'ms', 'same, painted');
  S('echo.first', 'ms', 'first key typed at the prompt → its echo in the buffer');
  S('echo.first.frame', 'ms', 'same, painted');
  P('echo', `key → its echo in the buffer, keys ${ECHO_GAP_MS} ms apart after each echo`);
  P('echo.frame', 'key → the painted frame showing it');
  S('echo_burst.total', 'ms', `${ECHO_BURST.length} keys typed at once → the last echoed`);
  S('echo_burst.total.frame', 'ms', 'same, painted');
  S('turn', 'ms', 'Enter on a prompt → the mocked reply in the buffer');

  if (h.wantsAny('claude_native.native', 'claude_native.native.start.prompt', 'claude_native.native.echo.p50')) {
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
      if (N.echo) {
        R['native.echo'] = N.echo;
        P('native.echo', `native: key written to the pty → the key in Claude's output`);
      }
    }
  }
}
