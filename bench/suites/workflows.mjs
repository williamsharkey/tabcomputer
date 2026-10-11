// User workflows (in --quick and full runs, isolated only), each from a fresh
// profile, with time and renderer RSS peaks:
// - Vite's React template typed into the real terminal, as
//   tests/browser/vite-react.mjs does: `npm create vite`, `npm i`, `npm run
//   dev` until ready, the preview renders, an edit reaches it by HMR (no
//   reload). npm and the template come from bench/.cache/net (no network).
// - `go run hello.go` on the go toolchain layer (debian install + toolchain
//   install go), served from TABCOMPUTER_DEBIAN_LAYERS (default
//   .toolchain-build/layers; `sudo bash scripts/debian/build-layers.sh go`
//   builds it in about a minute). Skipped without it.
// - apt: `apt-get update` and `apt-get install -y hello` from server.mjs's
//   mirror disk cache (.debian-build/mirror-cache), i.e. a warm cache after
//   the first run on a machine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MB } from '../lib/harness.mjs';
import { FAKE_KEY, startMockModel } from '../lib/mockmodel.mjs';

export const name = 'workflows';
export const ownPages = true;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function timed(h, cmd, limitS, check) {
  const r = await h.withPeakRss(() => h.withHostCpu(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/wf.out 2>&1`, limitS * 1000])), { buffer: true });
  const { result: res, user, sys } = r.result;
  const out = (await h.sh('cat /tmp/wf.out')).out;
  if (res.code !== 0 || (check && !check.test(out))) {
    throw new Error(`${cmd.slice(0, 70)}: ${res.code === 124 ? `timed out after ${limitS} s` : `exit ${res.code}`}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  }
  return { ms: res.ms, user, sys, peak: r.peakDelta / MB, net: r.peakDeltaNet != null ? r.peakDeltaNet / MB : null };
}

/** Terminal text from line `from` on, and helpers to type and wait (the terminal runs vite). */
const termText = (h) => h.eval(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
async function typeAndWait(h, line, re, limitMs, what) {
  const from = (await termText(h)).length;
  const t0 = Date.now();
  await h.eval((l) => window.__tabcomputer.terminal.term.input(l, true), line);
  for (;;) {
    const s = (await termText(h)).slice(from);
    const m = re.exec(s);
    if (m) return { ms: Date.now() - t0, m };
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}: ${s.split('\n').slice(-6).join(' | ').slice(0, 400)}`);
    await h.page.waitForTimeout(50);
  }
}
let marks = 0;
async function termStep(h, cmd, limitMs) {
  const mark = `@@wf${++marks}`;
  const r = await h.withPeakRss(() => h.withHostCpu(() => typeAndWait(h, `${cmd}; echo "${mark} $?"\r`, new RegExp(`^${mark} (\\d+)$`, 'm'), limitMs, cmd)), { buffer: true });
  const { result: res, user, sys } = r.result;
  if (res.m[1] !== '0') throw new Error(`exit ${res.m[1]}: ${cmd}: ${(await termText(h)).split('\n').slice(-6).join(' | ').slice(0, 300)}`);
  return { ms: res.ms, user, sys, peak: r.peakDelta / MB, net: r.peakDeltaNet != null ? r.peakDeltaNet / MB : null };
}
async function preview(h) {
  for (let i = 0; i < 600; i++) {
    for (const el of await h.page.$$('iframe[data-virtual-port="5173"]')) {
      const f = await el.contentFrame();
      if (f && f.url() !== 'about:blank' && f.url() !== '') return f;
    }
    await h.page.waitForTimeout(100);
  }
  throw new Error('no preview of :5173');
}
const side = (h, cmd) => h.eval(async (c) => {
  const sh = window.__tabcomputer.shell.fork(); sh.terminal = null;
  let out = '';
  const code = await sh.execute(c, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);

// ── an interactive `claude --npm` session, page responsiveness while it runs ──
// The model is mocked (lib/mockmodel.mjs: a local Messages API with streamed replies),
// so the session needs no credentials and no network.
const CLAUDE = ['workflow.claude_session_lag', 'workflow.claude_session_lag.p50', 'workflow.claude_session_lag.p99', 'workflow.claude_session_lag.max', 'workflow.claude_session_lag.longtasks_per_min', 'workflow.claude_session_lag.longtask_ms_per_min', 'workflow.claude_session_lag.stalls', 'workflow.claude_session.start', 'workflow.claude_session.turn'];
const TURNS = 3;

/** Tick lateness of a 500 ms heartbeat (the watchdog's own measure), sampled in the page. */
const startLagSampler = (h) => h.eval(() => {
  const S = window.__benchLag = { lags: [], stop: null };
  let expected = performance.now() + 500;
  const id = setInterval(() => { const now = performance.now(); S.lags.push(Math.max(0, now - expected)); expected = now + 500; }, 500);
  S.stop = () => clearInterval(id);
});
const stopLagSampler = (h) => h.eval(() => { const S = window.__benchLag; S.stop(); return S.lags; });
const watchdogJson = async (h) => { const r = await side(h, 'watchdog --json -n 1500'); try { return JSON.parse(r.out); } catch { return null; } };
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : NaN; };

async function claudeSession(h, add) {
  await h.page?.context().close().catch(() => {});
  await h.boot({ path: '/?ui=terminal' });
  if (!h.hostAddr) throw new Error('no non-loopback address on this machine for the mock model server');
  const mock = await startMockModel(h.hostAddr);
  try {
  // past the net cache's route, which fails every non-GET request off this origin
  await h.page.context().route((u) => u.href.startsWith(mock.url), (r) => r.continue());
  // installed first (what workload.claude_npm.first measures), so the session is the warm case
  const inst = await side(h, 'claude --npm --version');
  if (inst.code !== 0) throw new Error(`claude --npm --version: ${inst.out.slice(-200)}`);
  await h.eval((k) => window.__bench.writeFile('/home/user/.claude.json', JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [k.slice(-20)], rejected: [] } })), FAKE_KEY);
  await side(h, 'mkdir -p ~/w');
  const wd0 = await watchdogJson(h);
  const t0 = Date.now();
  await startLagSampler(h);
  const env = `ANTHROPIC_BASE_URL=${mock.url} ANTHROPIC_API_KEY=${FAKE_KEY} DISABLE_TELEMETRY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1`;
  // Startup dialogs a user answers with Enter (the external CLAUDE.md import tabcomputer's ~/CLAUDE.md
  // makes, ...): accept each, until the prompt shows
  // (Ink redraws in place: look at the screen's last lines, not at what was appended)
  const screen = async () => (await termText(h)).replace(/\s+$/, '').split('\n').slice(-15).join('\n');
  const ts = Date.now();
  await h.eval((l) => window.__tabcomputer.terminal.term.input(l, true), `cd ~/w && ${env} claude --npm\r`);
  let answered = 0;
  for (;;) {
    const tail = await screen();
    if (/for shortcuts|shift\+tab to cycle|\? for|Try "/.test(tail) && /^❯/m.test(tail)) break;
    if (/Enter to confirm/.test(tail) && answered < 5) { answered++; await h.eval(() => window.__tabcomputer.terminal.term.input('\r', true)); await h.page.waitForTimeout(1000); continue; }
    if (Date.now() - ts > 300000) throw new Error(`timed out waiting for the claude prompt: ${tail.slice(-400)}`);
    await h.page.waitForTimeout(100);
  }
  add('cl_start', Date.now() - ts);
  await h.page.waitForTimeout(1500);
  for (let i = 1; i <= TURNS; i++) {
    const t1 = Date.now();
    // the Enter on its own: text and CR in one input arrive as a paste, which doesn't submit
    await h.eval((l) => window.__tabcomputer.terminal.term.input(l, true), `bench turn ${i}: say something`);
    await h.page.waitForTimeout(500);
    await h.eval(() => window.__tabcomputer.terminal.term.input('\r', true));
    while (!new RegExp(`BENCH-REPLY-${i}`).test(await termText(h))) {
      if (Date.now() - t1 > 120000) throw new Error(`timed out waiting for reply ${i} (${mock.calls()} model calls): ${(await screen()).slice(-400)}`);
      await h.page.waitForTimeout(50);
    }
    add('cl_turn', Date.now() - t1);
    await h.page.waitForTimeout(3000); // reading the answer
  }
  await h.page.waitForTimeout(10000); // idle at the prompt
  await h.eval(() => window.__tabcomputer.terminal.term.input('\x03', true));
  await h.page.waitForTimeout(300);
  await h.eval(() => window.__tabcomputer.terminal.term.input('\x03', true));
  await typeAndWait(h, 'echo "@@cl-exit"\r', /^@@cl-exit$/m, 60000, 'claude exit').catch(() => {});
  const lags = await stopLagSampler(h);
  const minutes = (Date.now() - t0) / 60000;
  const wd1 = await watchdogJson(h);
  add('cl_p50', pct(lags, 0.5)); add('cl_p99', pct(lags, 0.99)); add('cl_max', Math.max(...lags));
  if (wd0 && wd1) {
    add('cl_lt_min', (wd1.longTasks.count - wd0.longTasks.count) / minutes);
    add('cl_lt_ms_min', (wd1.longTasks.ms - wd0.longTasks.ms) / minutes);
    add('cl_stalls', wd1.events.filter((e) => e.kind === 'stall' && e.t >= t0).length);
  }
  } finally { await mock.close(); }
}

/** A step's wall time and host user/sys (Chromium tree), as `key`, `key_user`, `key_sys`. */
function addCpu(add, key, r) { add(key, r.ms); add(`${key}_user`, r.user); add(`${key}_sys`, r.sys); }

/**
 * A build natively on this machine (the reference row): wall, user and sys
 * of `cmd` in `cwd` from bash's `time`, children included. { ms, user, sys }.
 */
function nativeTime(cmd, cwd, env = {}) {
  const script = `TIMEFORMAT='@@time %R %U %S'; time { ${cmd} ; } > /dev/null 2>&1`;
  const r = execFileSync('bash', ['-c', `{ ${script} ; } 2>&1`], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 1_800_000 });
  const m = /@@time ([\d.]+) ([\d.]+) ([\d.]+)/.exec(r);
  if (!m) throw new Error(`native \`${cmd}\`: no timing in ${r.slice(-200)}`);
  return { ms: Number(m[1]) * 1000, user: Number(m[2]), sys: Number(m[3]) };
}

async function vite(h, add) {
  await h.page?.context().close().catch(() => {});
  await h.boot({ path: '/?ui=terminal' });
  const create = await termStep(h, 'cd ~ && npm create vite@7 app -- --template react --no-interactive', 300000);
  add('create', create.ms); add('create_peak', create.peak);
  const inst = await termStep(h, 'cd ~/app && npm i', 600000);
  add('npm_i', inst.ms); add('npm_i_peak', inst.peak); if (inst.net != null) add('npm_i_net', inst.net);
  const dev = await h.withPeakRss(() => typeAndWait(h, 'npm run dev\r', /ready in \d+ ms|Local:\s+http/, 300000, 'vite ready'), { buffer: true });
  add('dev_ready', dev.result.ms); add('dev_peak', dev.peakDelta / MB); if (dev.peakDeltaNet != null) add('dev_net', dev.peakDeltaNet / MB);
  let t0 = Date.now();
  const opened = await side(h, 'serve open 5173');
  if (opened.code !== 0) throw new Error(`serve open 5173: ${opened.out.slice(0, 200)}`);
  let frame = await preview(h);
  try {
    await frame.waitForFunction(() => /count is \d/i.test(document.body?.innerText ?? ''), null, { timeout: 300000 });
  } catch (e) {
    // what the preview shows instead: its URL, text, and the head of its HTML
    const f = await preview(h).catch(() => frame);
    const seen = await f.evaluate(() => ({ url: location.href, text: (document.body?.innerText ?? '').slice(0, 300), html: document.documentElement.outerHTML.slice(0, 600) })).catch((x) => ({ error: String(x.message) }));
    throw new Error(`the preview never rendered the app: ${JSON.stringify(seen).slice(0, 900)}`);
  }
  frame = await preview(h);
  add('preview', Date.now() - t0);
  await frame.evaluate(() => { window.__notReloaded = true; });
  t0 = Date.now();
  // the button's "count is" label is in every create-vite 7 React template (its other text changes)
  await side(h, "sed -i 's|[Cc]ount is|Edited by HMR, count is|' ~/app/src/App.jsx");
  await frame.waitForFunction(() => /Edited by HMR/.test(document.body?.innerText ?? ''), null, { timeout: 60000 });
  add('hmr', Date.now() - t0);
  if (!await frame.evaluate(() => window.__notReloaded === true)) throw new Error('the preview reloaded instead of hot-updating');
  // vite build from a second shell while the dev server runs (the sequence above stays as before)
  const build = await h.withHostCpu(async () => { const t = Date.now(); const r = await side(h, 'cd ~/app && npm run build'); return { ...r, ms: Date.now() - t }; });
  if (build.result.code !== 0) throw new Error(`npm run build: exit ${build.result.code}: ${build.result.out.slice(-200)}`);
  addCpu(add, 'vite_build', { ms: build.result.ms, user: build.user, sys: build.sys });
}

const VITE = ['workflow.vite', 'workflow.vite.create', 'workflow.vite.build', 'workflow.vite.npm_i', 'workflow.vite.dev_ready', 'workflow.vite.preview', 'workflow.vite.hmr', 'workflow.peak_rss.vite_npm_i', 'workflow.peak_rss.vite_dev', 'workflow.peak_rss.vite_npm_i_net', 'workflow.peak_rss.vite_dev_net'];
const GO = ['workflow.go', 'workflow.go.toolchain_install', 'workflow.go.build_a', 'workflow.go.run_first', 'workflow.go.run_warm', 'workflow.peak_rss.go_run_first', 'workflow.peak_rss.go_run_warm', 'workflow.peak_rss.go_run_first_net'];
const APT = ['workflow.apt', 'workflow.apt.update', 'workflow.apt.install_hello', 'workflow.apt.hello_run', 'workflow.peak_rss.apt_update', 'workflow.peak_rss.apt_install_hello', 'workflow.peak_rss.apt_update_net', 'workflow.peak_rss.apt_install_hello_net'];

/** The builds natively on this machine, `rounds` times each: the reference rows next to the workflow.* ones. */
function nativeBuilds(h, rounds) {
  const rows = (metric, rs, what) => {
    if (!rs.length) return;
    h.sample(metric, rs.map((r) => r.ms), 'ms', { notes: `native reference: ${what} on this machine's Linux` });
    h.sample(`${metric}.user`, rs.map((r) => r.user), 's', { notes: `native: user CPU of ${what} (bash \`time\`, children included)` });
    h.sample(`${metric}.sys`, rs.map((r) => r.sys), 's', { notes: `native: sys CPU of ${what}` });
  };
  const tmp = mkdtempSync(join(tmpdir(), 'wf-native-'));
  try {
    if (h.wantsAny('workflow.native.go', 'workflow.native.go_build_first', 'workflow.native.go_build_a')) {
      let go = null;
      try { go = execFileSync('go', ['version'], { encoding: 'utf8' }).trim(); } catch {}
      if (!go) h.skip('workflow.native.go_build_a', 'ms', 'no go on this machine');
      else {
        writeFileSync(join(tmp, 'hello.go'), 'package main\nimport "fmt"\nfunc main() { fmt.Println("hello") }\n');
        const first = [], all = [];
        try {
          for (let i = 0; i < rounds; i++) {
            const env = { GOCACHE: join(tmp, `cache${i}`), GO111MODULE: 'off', GOFLAGS: '', CGO_ENABLED: '0' };
            first.push(nativeTime('go build -o h1 hello.go', tmp, env));
            all.push(nativeTime('go build -a -o h2 hello.go && ./h2', tmp, env));
          }
          rows('workflow.native.go_build_first', first, `\`go build hello.go\` with an empty build cache (${go}; what the first \`go run\` compiles)`);
          rows('workflow.native.go_build_a', all, `\`go build -a hello.go\` + run (${go})`);
        } catch (e) { h.skip('workflow.native.go_build_a', 'ms', String(e.message).slice(0, 200)); }
      }
    }
    if (h.wantsAny('workflow.native.vite_build')) {
      try {
        // the app natively (registry over the network, not the bench cache): only `vite build` is timed
        const env = { npm_config_cache: join(tmp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
        execFileSync('bash', ['-c', 'npm create vite@7 app -- --template react --no-interactive && cd app && npm i'], { cwd: tmp, env: { ...process.env, ...env }, stdio: 'ignore', timeout: 600_000 });
        const rs = [];
        for (let i = 0; i < rounds; i++) rs.push(nativeTime('npx vite build', join(tmp, 'app'), env));
        rows('workflow.native.vite_build', rs, `\`npm run build\` (vite build) of the same React template, Node ${process.version}`);
      } catch (e) { h.skip('workflow.native.vite_build', 'ms', `native app setup or build failed: ${String(e.message).split('\n')[0].slice(0, 200)}`); }
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function run(h) {
  if (!h.isolated) { h.skip('workflow.suite', '', 'measured in the isolated (production) configuration only'); return; }
  const rounds0 = h.quick ? 1 : Math.min(h.runs, 3);

  if (h.wantsAny(...CLAUDE)) {
    const R = {};
    const add = (k, v) => (R[k] ??= []).push(v);
    for (let i = 0; i < rounds0; i++) {
      try { await claudeSession(h, add); } catch (e) { h.skip('workflow.claude_session.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`); }
    }
    const S = (key, name, unit, notes) => { if (R[key]?.length) h.sample(name, R[key], unit, { notes }); };
    const what = `an interactive \`claude --npm\` session typed at the terminal (start, ${TURNS} turns with streamed mock replies, 10 s idle, Ctrl-C twice)`;
    S('cl_p50', 'workflow.claude_session_lag.p50', 'ms', `event-loop lag p50: lateness of a 500 ms heartbeat (the watchdog's measure) during ${what}`);
    S('cl_p99', 'workflow.claude_session_lag.p99', 'ms', 'event-loop lag p99, same session');
    S('cl_max', 'workflow.claude_session_lag.max', 'ms', 'longest heartbeat delay, same session');
    S('cl_lt_min', 'workflow.claude_session_lag.longtasks_per_min', '/min', "long tasks (≥ 50 ms) per minute, from the watchdog's counters (longTasks.count)");
    S('cl_lt_ms_min', 'workflow.claude_session_lag.longtask_ms_per_min', 'ms/min', 'time in long tasks per minute (watchdog longTasks.ms)');
    S('cl_stalls', 'workflow.claude_session_lag.stalls', 'count', 'watchdog `stall` events (heartbeat ≥ 2 s late) during the session');
    S('cl_start', 'workflow.claude_session.start', 'ms', '`claude --npm` typed → its prompt (installed, warm)');
    S('cl_turn', 'workflow.claude_session.turn', 'ms', 'Enter on a prompt → the mocked reply shows in the terminal');
  }
  const rounds = h.quick ? 1 : Math.min(h.runs, 3);
  const S = (R, name, key, unit, notes) => { if (R[key]?.length) h.sample(name, R[key], unit, { notes }); };

  if (h.wantsAny(...VITE)) {
    const R = {};
    const add = (k, v) => (R[k] ??= []).push(v);
    for (let i = 0; i < rounds; i++) {
      try { await vite(h, add); } catch (e) { h.skip('workflow.vite.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`); }
    }
    S(R, 'workflow.vite.create', 'create', 'ms', '`npm create vite@7 app -- --template react --no-interactive` typed at the terminal, fresh profile (pinned: @latest moves to new majors)');
    S(R, 'workflow.vite.npm_i', 'npm_i', 'ms', '`npm i` in the new app (react, vite, plugins; registry from the bench cache)');
    S(R, 'workflow.vite.build', 'vite_build', 'ms', '`npm run build` (vite build of the React template) from a second shell, after the HMR check');
    S(R, 'workflow.vite.build.user', 'vite_build_user', 's', 'host user CPU of the Chromium tree (renderer, Workers, GPU, browser) during `npm run build`');
    S(R, 'workflow.vite.build.sys', 'vite_build_sys', 's', 'host sys CPU of the Chromium tree during `npm run build`');
    S(R, 'workflow.vite.dev_ready', 'dev_ready', 'ms', '`npm run dev` until vite prints ready');
    S(R, 'workflow.vite.preview', 'preview', 'ms', '`serve open 5173` until the preview renders the app');
    S(R, 'workflow.vite.hmr', 'hmr', 'ms', 'edit src/App.jsx → the change shows in the preview by HMR (no reload)');
    S(R, 'workflow.peak_rss.vite_npm_i', 'npm_i_peak', 'MiB', 'renderer RSS peak above the pre-run level, npm i');
    S(R, 'workflow.peak_rss.vite_npm_i_net', 'npm_i_net', 'MiB', 'renderer RSS peak above the pre-run level, minus the growth of the renderer\'s buffer partition (DevTools copies of response bodies)');
    S(R, 'workflow.peak_rss.vite_dev_net', 'dev_net', 'MiB', 'renderer RSS peak above the pre-run level, minus the growth of the renderer\'s buffer partition (DevTools copies of response bodies)');
    S(R, 'workflow.peak_rss.vite_dev', 'dev_peak', 'MiB', 'renderer RSS peak above the pre-run level, npm run dev → ready');
  }

  const layers = process.env.TABCOMPUTER_DEBIAN_LAYERS || join(ROOT, '.toolchain-build', 'layers');
  const haveGo = existsSync(join(layers, 'go', 'layer.json'));
  if (!haveGo && h.wantsAny(...GO)) h.skip('workflow.go.run', 'ms', `no go layer in ${layers} (sudo bash scripts/debian/build-layers.sh go builds it locally)`);
  if (h.wantsAny(...GO) || h.wantsAny(...APT)) {
    const R = {};
    const add = (k, v) => (R[k] ??= []).push(v);
    const apt = 'sudo DEBIAN_FRONTEND=noninteractive apt-get';
    for (let i = 0; i < rounds; i++) {
      if (haveGo && h.wantsAny(...GO)) {
        await h.page?.context().close().catch(() => {});
        await h.boot({ path: '/?ui=terminal' });
        try {
          await timed(h, 'debian install', 300);
          const inst = await timed(h, 'toolchain install go', 600);
          await h.eval(() => window.__bench.writeFile('/tmp/hello.go', 'package main\nimport "fmt"\nfunc main() { fmt.Println("hello") }\n'));
          const first = await timed(h, 'cd /tmp && go run hello.go', 1200, /^hello$/m);
          const warm = await timed(h, 'cd /tmp && go run hello.go', 1200, /^hello$/m);
          add('go_install', inst.ms); add('go_first', first.ms); add('go_first_peak', first.peak); if (first.net != null) add('go_first_net', first.net); add('go_warm', warm.ms); add('go_warm_peak', warm.peak);
          addCpu(add, 'go_first_cpu', first); addCpu(add, 'go_warm_cpu', warm);
          // `go build -a`: every package hello.go needs (runtime, fmt, ...) compiled again.
          // Full runs only: ~20 min in Blink (the quick run's go build user/sys is run_first's)
          if (!h.quick && h.wants('workflow.go.build_a')) {
            const all = await timed(h, `cd /tmp && go build -a -o /tmp/hello-a hello.go && /tmp/hello-a`, 1800, /^hello$/m);
            addCpu(add, 'go_build_a', all);
          }
        } catch (e) {
          h.skip('workflow.go.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
      // apt in a profile of its own (no go layer, no Go processes before it)
      if (h.wantsAny(...APT)) {
        await h.page?.context().close().catch(() => {});
        await h.boot({ path: '/?ui=terminal' });
        try {
          await timed(h, 'debian install', 300);
          const up = await timed(h, `${apt} update`, 1800);
          const hello = await timed(h, `${apt} install -y hello`, 1800);
          const runIt = await timed(h, 'hello', 120, /Hello, world!/);
          addCpu(add, 'apt_hello_cpu', hello); addCpu(add, 'apt_update_cpu', up);
          add('apt_update', up.ms); add('apt_update_peak', up.peak); if (up.net != null) add('apt_update_net', up.net); add('apt_hello', hello.ms); add('apt_hello_peak', hello.peak); if (hello.net != null) add('apt_hello_net', hello.net); add('apt_hello_run', runIt.ms);
        } catch (e) {
          h.skip('workflow.apt.round', '', `round ${i + 1} failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    }
    S(R, 'workflow.go.toolchain_install', 'go_install', 'ms', '`toolchain install go` (layer: placeholders + dpkg database) after `debian install`');
    S(R, 'workflow.go.run_first', 'go_first', 'ms', 'first `go run hello.go` (Go 1.24 in Blink: compile + link + run; fetches the toolchain\'s chunks)');
    S(R, 'workflow.go.run_warm', 'go_warm', 'ms', 'second `go run hello.go` (build cache warm)');
    S(R, 'workflow.peak_rss.go_run_first', 'go_first_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S(R, 'workflow.peak_rss.go_run_first_net', 'go_first_net', 'MiB', 'renderer RSS peak above the pre-run level, minus the growth of the renderer\'s buffer partition (DevTools copies of response bodies)');
    S(R, 'workflow.peak_rss.go_run_warm', 'go_warm_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    const cpuRows = (R, metric, key, what) => {
      S(R, `${metric}.user`, `${key}_user`, 's', `host user CPU of the Chromium tree (renderer, Workers, GPU, browser) during ${what}`);
      S(R, `${metric}.sys`, `${key}_sys`, 's', `host sys CPU of the Chromium tree during ${what}`);
    };
    cpuRows(R, 'workflow.go.run_first', 'go_first_cpu', 'the first `go run hello.go`');
    cpuRows(R, 'workflow.go.run_warm', 'go_warm_cpu', 'the second `go run hello.go`');
    S(R, 'workflow.go.build_a', 'go_build_a', 'ms', '`go build -a hello.go` (runtime, fmt and their dependencies recompiled) + run, after the two `go run`s');
    cpuRows(R, 'workflow.go.build_a', 'go_build_a', '`go build -a`');
    cpuRows(R, 'workflow.apt.update', 'apt_update_cpu', '`apt-get update`');
    cpuRows(R, 'workflow.apt.install_hello', 'apt_hello_cpu', '`apt-get install -y hello`');
    S(R, 'workflow.apt.update', 'apt_update', 'ms', '`apt-get update` from the mirror disk cache (needed before any install on a fresh profile)');
    S(R, 'workflow.apt.install_hello', 'apt_hello', 'ms', '`apt-get install -y hello` (one small package, no new dependencies) from the warm mirror cache');
    S(R, 'workflow.apt.hello_run', 'apt_hello_run', 'ms', 'then `hello`');
    S(R, 'workflow.peak_rss.apt_update', 'apt_update_peak', 'MiB', 'renderer RSS peak above the pre-run level');
    S(R, 'workflow.peak_rss.apt_update_net', 'apt_update_net', 'MiB', 'renderer RSS peak above the pre-run level, minus the growth of the renderer\'s buffer partition (DevTools copies of response bodies)');
    S(R, 'workflow.peak_rss.apt_install_hello_net', 'apt_hello_net', 'MiB', 'renderer RSS peak above the pre-run level, minus the growth of the renderer\'s buffer partition (DevTools copies of response bodies)');
    S(R, 'workflow.peak_rss.apt_install_hello', 'apt_hello_peak', 'MiB', 'renderer RSS peak above the pre-run level');
  }
  nativeBuilds(h, rounds);
}
