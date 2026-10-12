/**
 * tabcomputer#93: a ref'd setInterval keeps the page's node running, as in
 * node (it ended about 60 ms after its synchronous part). Clearing or
 * unref'ing the interval lets it end, and a timeout's signal ends it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });
const out = (s: string) => s.replace(/\r\n/g, '\n').trim();
// (the page's node; a Worker guest already did this)
const NODE = 'TABCOMPUTER_NODE_WORKER=0 node';

describe("the page's node and setInterval", () => {
  it('runs until the interval is cleared', async () => {
    const r = await run(shell, `${NODE} -e 'let n = 0; const t = setInterval(() => { if (++n === 5) { clearInterval(t); console.log("ticks", n); } }, 100)' < /dev/null; echo "rc=$?"`);
    expect(out(r.output)).toBe('ticks 5\nrc=0');
  });
  it('a child of node does too', async () => {
    const child = `let n = 0; const t = setInterval(() => { if (++n === 4) { clearInterval(t); console.log("child ticks", n); } }, 100)`;
    const r = await run(shell, `${NODE} -e 'require("child_process").execFile("node", ["-e", ${JSON.stringify(child)}], (e, so) => console.log(e ? "err " + e.message : so.trim()))' < /dev/null`);
    expect(out(r.output)).toBe('child ticks 4');
  });
  it("an unref'd interval doesn't hold it", async () => {
    const r = await run(shell, `${NODE} -e 'setInterval(() => console.log("tick"), 400).unref(); console.log("done")' < /dev/null; echo "rc=$?"`);
    expect(out(r.output)).toBe('done\nrc=0');
  });
  it("timeout's signal ends one that never clears it", async () => {
    const t0 = Date.now();
    const r = await run(shell, `timeout 0.5 ${NODE} -e 'setInterval(() => {}, 100)' < /dev/null; echo "rc=$?"`);
    expect(out(r.output)).toBe('rc=124');
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
