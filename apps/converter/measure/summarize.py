#!/usr/bin/env python3
"""Per-file numbers from results/measure-prod.json: the user-space app (warm batch),
the same command typed in a shell, and the hardwired window, for the files all three ran."""
import json, statistics as st, sys, os
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results/measure-prod.json')))
warm = {r['rel']: r for r in d['batchWarmRows']}
cold = {r['rel']: r for r in d['batchColdRows']}
direct = {r['rel']: r for r in d['direct']}
hw = {r['name']: r for r in d['hardwiredRows']}
rows = []
for n, h in hw.items():
    w, c, di = warm[n], cold[n], direct[n]
    rows.append(dict(name=n, status=h['status'], hw_write=h.get('writeMs'), hw_tool=h.get('toolMs'), hw_total=h.get('totalMs'),
                     us_upload=w.get('uploadMs'), us_tool=w.get('toolMs'), us_server=w.get('serverMs'), us_total=w.get('totalMs'),
                     direct=di['ms'], us_cold_total=c.get('totalMs')))
if '-v' in sys.argv:
    for r in rows: print(r)
ok = [r for r in rows if r['status'] == 'done' and r['us_tool'] is not None]
print(f"files in all three runs: {len(rows)}, converted: {len(ok)}")
for k in ['direct', 'hw_write', 'hw_tool', 'hw_total', 'us_upload', 'us_tool', 'us_server', 'us_total', 'us_cold_total']:
    v = [r[k] for r in ok]
    print(f"{k:14s} median {st.median(v):7.1f} ms   sum {sum(v):6d} ms   max {max(v):5d} ms")
print('every sample, typed in a shell, sum:', sum(r['ms'] for r in d['direct']), 'ms')
print('user-space warm batch: wall', d['batchWarm']['wallMs'], 'ms for', len(d['batchWarmRows']), 'files;',
      'sum of per-file round trips', sum(r.get('totalMs') or 0 for r in d['batchWarmRows']), 'ms (two at a time)')
print('slowest files (warm, user space):')
for b in sorted(d['batchWarmRows'], key=lambda r: -(r.get('totalMs') or 0))[:6]:
    print('  ', b['rel'], b['status'], 'upload', b.get('uploadMs'), 'tool', b.get('toolMs'), 'total', b.get('totalMs'), 'direct', direct[b['rel']]['ms'])
