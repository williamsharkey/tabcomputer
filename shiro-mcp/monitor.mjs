// Read-only freeze monitor for a live tab (`remote start` code), over the HTTPS relay.
// Samples diag every 30 s into a JSONL log; on a stall >= 2 s, a frozen or timed-out
// answer, or the #19 signature (a thread blocked >20 s with unread socket data) it
// captures a burst: two diags 10 s apart, `watchdog --json`, dmesg, /proc of the pids.
// Never runs anything else in the tab.
//   cd shiro-mcp && npm ci && npm run build
//   NODE_USE_ENV_PROXY=1 node monitor.mjs '<code>' diag.jsonl   (exits 2 when the relay closes)
import fs from 'node:fs';
const { RelayChannel, parseRemoteCode, fetchOffer, sendAnswer } = await import(new URL('./dist/relay.js', import.meta.url).href);
const [code, logPath] = process.argv.slice(2);
const BASE = process.env.TABCOMPUTER_SIGNALING_URL || 'https://tabcomputer.com';
const log = (o) => fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const say = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

// The code is <id>#<secret>: the server gets the id; the offer, the answer and every message are sealed with the secret
let parts, offer;
try { parts = parseRemoteCode(code); offer = await fetchOffer(BASE, parts); } catch (e) { say(e.message); process.exit(1); }
if (!offer) { say(`code not found: ${parts.id}`); process.exit(1); }
if (!offer.relay) { say('this tab does not offer the HTTPS relay (remote start --relay)'); process.exit(1); }
try { await sendAnswer(BASE, parts, { answer: { type: 'relay', v: offer.relay.v === 2 ? 2 : 1 }, candidates: [] }); } catch (e) { say(`answer refused: ${e.message}`); process.exit(1); }
const ch = new RelayChannel({ base: BASE, info: offer.relay, secret: parts.secret, as: 'peer', log: (m) => say(`[relay] ${m}`) });
const pending = new Map(); let n = 0;
ch.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } const p = m.requestId && pending.get(m.requestId); if (p) { pending.delete(m.requestId); p(m); } else if (m.type === 'user_message') say(`user: ${m.message}`); };
ch.onclose = () => { say('CONNECTION CLOSED'); log({ event: 'closed' }); process.exit(2); };
await new Promise((r) => { ch.onopen = r; });
const req = (o, ms = 30000) => new Promise((resolve) => {
  const id = `m${++n}`; const t = setTimeout(() => { pending.delete(id); resolve({ timeout: true }); }, ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  ch.send(JSON.stringify({ ...o, requestId: id }));
});
ch.send(JSON.stringify({ type: 'hello', name: 'remote-debug monitor (read-only)' }));
const ping = await req({ type: 'ping' }, 20000);
say(`connected over relay; ping ${JSON.stringify(ping).slice(0, 120)}`); log({ event: 'connected', ping });

const summarize = (d) => {
  if (d.timeout) return 'diag TIMEOUT (no answer in 30 s, worker included)';
  const procs = d.kernel?.procs ?? [];
  const k = procs.map((p) => `${p.pid}:${(p.cmd || '').split(' ')[0].split('/').pop()} ${p.state}${p.inSyscall ? ` sys${p.calls?.[0]?.[0]}@${Math.round(p.syscallAgeMs / 1000)}s` : ''}`).slice(0, 6).join(', ');
  const socks = procs.flatMap((p) => (p.fds || []).filter((f) => f.kind === 'socket' && f.peer?.kind === 'relay').map((f) => `fd${f.fd} rx${f.rxLen}${f.rxEof ? ' eof' : ''} unacked${f.peer.unacked} buf${f.peer.bufferedAmount} ws${f.peer.readyState}`)).slice(0, 4).join('; ');
  const th = procs.flatMap((p) => (p.threads || []).filter((t) => t.waitKind).map((t) => `t${t.tid}:${t.waitKind}${t.nr !== undefined ? '/' + t.nr : ''}@${Math.round((t.sinceMs || 0) / 1000)}s${(t.blockedOn || []).some((b) => b.rxLen > 0) ? ' RX-WAITING' : ''}`)).slice(0, 8).join(' ');
  const lk = procs.map((p) => p.engineLock).filter(Boolean).map((l) => `lock h${l.holder} w${l.waiters} ${l.heldMs}ms`).join(' ');
  const wf = procs.flatMap((p) => (p.fds || []).filter((f) => f.peer?.windowFull)).length;
  return `${d.frozen ? `FROZEN ${d.frozenMs}ms (worker) ` : ''}${th ? `[${th}] ` : ''}${lk ? `[${lk}] ` : ''}${wf ? `[WINDOW FULL x${wf}] ` : ''}lag ${d.lag?.lastMs}/${d.lag?.maxMs1m}ms lt ${d.longTasks?.count1m}/${d.longTasks?.ms1m}ms heap ${d.memory?.usedMB}/${d.memory?.limitMB}MB writes ${d.pendingWrites} | ${k} | ${socks}`;
};
let since = Date.now() - 120000; let bursts = 0;
async function burst(why) {
  bursts++; say(`BURST ${bursts}: ${why}`);
  const a = await req({ type: 'diag', procGrep: 'claude|node|bun', limit: 400, since: -600000 });
  log({ burst: bursts, why, sample: 1, diag: a }); say(`  #1 ${summarize(a)}`);
  await new Promise((r) => setTimeout(r, 10000));
  const b = await req({ type: 'diag', procGrep: 'claude|node|bun', limit: 400, since: -600000 });
  log({ burst: bursts, why, sample: 2, diag: b }); say(`  #2 ${summarize(b)}`);
  const w = await req({ type: 'exec', command: 'watchdog --json -n 400' }, 30000); log({ burst: bursts, watchdog: w });
  const dm = await req({ type: 'exec', command: 'dmesg | tail -n 80' }, 30000); log({ burst: bursts, dmesg: dm });
  // #27 (Blink GIL vs maps lock): per claude/node pid, the syscall in progress, its threads, and writable shared file mappings
  const pids = [...new Set((b.kernel?.procs || a.kernel?.procs || []).map((p) => p.pid))].slice(0, 6);
  if (pids.length) {
    const cmd = pids.map((p) => `echo "== pid ${p}"; cat /proc/${p}/syscall; ls /proc/${p}/task; for t in /proc/${p}/task/*; do echo "$t $(cat $t/syscall 2>/dev/null)"; done; grep -E ' rw.s ' /proc/${p}/maps | grep -v ' 0 *$' | head -20`).join('; ');
    const mp = await req({ type: 'exec', command: cmd }, 30000); log({ burst: bursts, procmaps: mp });
    say(`  procs ${pids.join(',')}: ${(mp.stdout || (mp.timeout ? 'TIMEOUT' : '')).replace(/\n/g, ' | ').slice(0, 400)}`);
  }
  say(`  watchdog ${w.timeout ? 'TIMEOUT' : (w.stdout || '').length + ' bytes'}, dmesg ${dm.timeout ? 'TIMEOUT' : (dm.stdout || '').split('\n').length + ' lines'}`);
}
for (;;) {
  const d = await req({ type: 'diag', procGrep: 'claude', limit: 200, since });
  log({ diag: d });
  const stalls = (d.events || []).filter((e) => e.kind === 'stall' || (e.kind === 'lag' && e.ms >= 2000) || e.kind === 'wedge');
  say(`${summarize(d)}${stalls.length ? ` | ${stalls.length} STALL(S): ${stalls.map((e) => `${e.ms}ms [${(e.active || [])[0] || ''}]`).join(' ; ').slice(0, 300)}` : ''}`);
  if (!d.timeout && d.now) since = d.now;
  // #19 signature: a thread blocked >20 s on fds where data sits unread
  const rxStuck = (d.kernel?.procs || []).flatMap((p) => (p.threads || []).filter((t) => t.waitKind && (t.sinceMs || 0) > 20000 && (t.blockedOn || []).some((b) => b.rxLen > 0)).map((t) => `${p.pid}/${t.tid}`));
  if (d.frozen || d.timeout || stalls.length || rxStuck.length) await burst(d.frozen ? 'frozen answer' : d.timeout ? 'diag timeout' : rxStuck.length ? `#19 signature: blocked with unread data ${rxStuck.join(',')}` : `stall ${stalls[0].ms}ms`);
  await new Promise((r) => setTimeout(r, 30000));
}
