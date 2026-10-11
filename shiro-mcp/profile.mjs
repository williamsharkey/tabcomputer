// Live profile of a tab (`remote start` code) over the HTTPS relay: start a
// capture (src/live-profile.ts), optionally run a command in the tab, wait,
// then read it back and write <out> (JSON) and <out>.trace.json (open in
// https://ui.perfetto.dev or chrome://tracing). Prints the summary.
//   cd shiro-mcp && npm ci && npm run build
//   NODE_USE_ENV_PROXY=1 node profile.mjs <code> <out.json> [--seconds 60] [--sample 100]
//       [--proc claude] [--label TEXT] [--run 'shell command'] [--collect]
// --run runs the command in the tab's headless shell during the capture and
// stops the capture when it ends (else after --seconds, or Ctrl-C).
// --collect only reads the tab's current or last capture (none started).
// Stop monitor.mjs first: one peer per mailbox.
import fs from 'node:fs';
const { RelayChannel } = await import(new URL('./dist/relay.js', import.meta.url).href);
const { collectProfile, profileToTrace } = await import(new URL('./dist/trace.js', import.meta.url).href);

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv.splice(i, 2)[1] : dflt; };
const flag = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const seconds = Number(opt('--seconds', 60));
const sampleMs = Number(opt('--sample', 100));
const procGrep = opt('--proc', undefined);
const label = opt('--label', undefined);
const run = opt('--run', undefined);
const collectOnly = flag('--collect');
const [code, out] = argv;
if (!code || !out) { console.error('usage: node profile.mjs <code> <out.json> [--seconds S] [--sample MS] [--proc RE] [--label TEXT] [--run CMD] [--collect]'); process.exit(64); }
const BASE = process.env.TABCOMPUTER_SIGNALING_URL || 'https://tabcomputer.com';
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const offer = await (await fetch(`${BASE}/offer/${code}`)).json();
if (!offer.relay) { say(`no relay in offer: ${JSON.stringify(offer).slice(0, 200)}`); process.exit(1); }
const ans = await fetch(`${BASE}/answer/${code}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: { type: 'relay', v: offer.relay.v === 2 ? 2 : 1 }, candidates: [] }) });
if (!ans.ok) { say(`answer refused ${ans.status}`); process.exit(1); }
const ch = new RelayChannel({ base: BASE, info: offer.relay, code, as: 'peer', log: (m) => say(`[relay] ${m}`) });
const pending = new Map(); let n = 0;
ch.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } const p = m.requestId && pending.get(m.requestId); if (p) { pending.delete(m.requestId); p(m); } };
ch.onclose = () => { say('CONNECTION CLOSED'); process.exit(2); };
await new Promise((r) => { ch.onopen = r; });
const req = (o, ms = 60000) => new Promise((resolve, reject) => {
  const id = `p${++n}`; const t = setTimeout(() => { pending.delete(id); reject(new Error(`no answer to ${o.type}/${o.action ?? ''} in ${ms / 1000} s`)); }, ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  ch.send(JSON.stringify({ ...o, requestId: id }));
});
ch.send(JSON.stringify({ type: 'hello', name: 'remote-debug profiler' }));

if (!collectOnly) {
  const st = await req({ type: 'profile', action: 'start', durationMs: seconds * 1000 + (run ? 0 : 2000), sampleMs, procGrep, label });
  if (!st.meta) { say(`start failed: ${JSON.stringify(st).slice(0, 300)}`); process.exit(1); }
  say(`capture ${st.meta.id} started (build ${st.meta.build}, ${st.meta.durationMs / 1000} s, sample ${st.meta.sampleMs} ms)`);
  let stop;
  const stopped = new Promise((r) => { stop = r; });
  process.once('SIGINT', () => stop('interrupted'));
  const timer = setTimeout(() => stop('time'), seconds * 1000);
  if (run) {
    await req({ type: 'profile', action: 'mark', text: `run: ${run}` });
    req({ type: 'exec', command: run }, seconds * 1000 + 30000).then(
      (r) => { say(`run exited ${r.exitCode}: ${(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`); stop('command ended'); },
      (e) => { say(`run: ${e.message}`); stop('command timed out'); });
  }
  say(`stopping: ${await stopped}`);
  clearTimeout(timer);
  await req({ type: 'profile', action: 'stop' });
}
const p = await collectProfile((o) => req(o));
if (!p.meta) { say('the tab has no capture'); process.exit(1); }
fs.writeFileSync(out, JSON.stringify(p));
fs.writeFileSync(`${out}.trace.json`, JSON.stringify(profileToTrace(p)));
const st = await req({ type: 'profile', action: 'status' });
for (const l of st.summary ?? []) say(l);
say(`wrote ${out} and ${out}.trace.json (${Object.entries(p.meta.counts).map(([k, v]) => `${k} ${v}`).join(', ')}${Object.keys(p.meta.dropped).length ? `; dropped ${JSON.stringify(p.meta.dropped)}` : ''})`);
ch.onclose = null;
ch.close?.();
process.exit(0);
