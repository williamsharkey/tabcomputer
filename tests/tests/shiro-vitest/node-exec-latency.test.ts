/**
 * What child_process.exec() costs on top of the command it runs. In the page
 * nothing; as a kernel guest the child is polled from timers (node-worker/child.ts),
 * so its end is noticed up to one wait late. The wait grew a millisecond each
 * empty round (12 ms between rounds by the time a 70 ms command ended); now it is
 * a sixteenth of the time since the child last moved anything (pollDelay).
 * docs/research/APP_MAKER.md measured exec 37 ms slower than a page shell for a
 * 71 ms command in a browser, where a Worker's nested timers also wait 4 ms or more.
 *
 * The second test is the benchmark: it prints the medians (LATENCY …) and only
 * fails when a guest's exec is far off the page's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import * as child from '@shiro/node-worker/child';

let cleanup: (() => void) | undefined;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

const N = 25;
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
/** exec(CMD) N times, one after the other: the median time to its callback */
const SCRIPT = (cmd: string) => `
const cp = require('child_process');
const N = ${N}, CMD = ${JSON.stringify(cmd)};
const ts = [];
const one = (i) => {
  if (i === N) { ts.sort((a, b) => a - b); console.log(ts[N >> 1].toFixed(2)); return; }
  const t = performance.now();
  cp.exec(CMD, () => { ts.push(performance.now() - t); one(i + 1); });
};
one(0);
`;

describe('exec latency', () => {
  it("a guest's child is polled again within a sixteenth of the time it has been quiet, 20 ms at most", () => {
    const pollDelay = (child as { pollDelay?: (quietMs: number) => number }).pollDelay!;
    expect(typeof pollDelay).toBe('function');
    for (const quiet of [0, 1, 5, 15, 30, 70, 150, 319, 320, 1000, 60_000]) {
      const d = pollDelay(quiet);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(20, quiet / 16));
    }
    expect(pollDelay(70)).toBe(4);
    expect(pollDelay(60_000)).toBe(20); // (a long-running child isn't polled more often than it was)
  });

  it.each([['true'], ['sleep 0.03'], ['sleep 0.07'], ['sleep 0.15']])('exec(%s): the page shell, node in the page, node as a guest', async (cmd) => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/el', { recursive: true });
    await fs.writeFile('/tmp/el/a.js', SCRIPT(cmd));
    const direct: number[] = [];
    for (let i = 0; i < N; i++) { const t = performance.now(); await shell.fork().execute(cmd, () => {}, () => {}); direct.push(performance.now() - t); }
    const ms: number[] = [];
    for (const pre of ['export TABCOMPUTER_NODE_WORKER=0; ', 'export TABCOMPUTER_NODE_WORKER=1; ']) {
      let out = '';
      await shell.execute(`${pre}node /tmp/el/a.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
      ms.push(Number(out.trim()));
    }
    console.log(`LATENCY exec(${cmd}) median ms: shell ${med(direct).toFixed(2)} | page ${ms[0].toFixed(2)} | guest ${ms[1].toFixed(2)}`);
    expect(ms[1] - ms[0]).toBeLessThan(60); // (loose: other suites run beside this one)
  }, 120_000);
});
