/**
 * tabcomputer#99: `hotswap test` deletes its run's databases when the run ends.
 * A suite's FileSystem still had its database open, saw it deleted, reopened
 * it and reported "[fs] browser storage was deleted under this page" (#71's
 * detector) on the console and in the kernel log, though the tab's storage
 * was untouched. The runner now closes the run's connections first, and a
 * finished run's IndexedDB opens nothing more.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildTest } from '@shiro/hotswap/build';
import { runTestBundle, TEST_DB_PREFIX } from '@shiro/hotswap/test-runner';

const g = globalThis as any;
const REPO = path.resolve(__dirname, '../../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// As a suite in the checkout: its own copy of src/filesystem.ts, on the run's IndexedDB
const SUITE = `
import { it, expect } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
it('writes a file and leaves the filesystem open', async () => {
  const fs = new FileSystem();
  await fs.init();
  await fs.writeFile('/tmp/hotswap-99.txt', 'kept open');
  await fs.sync();
  expect(await fs.readFile('/tmp/hotswap-99.txt', 'utf8')).toBe('kept open');
  globalThis.__tcSuiteFs = fs;
});
`;

describe('hotswap test: a suite that leaves a FileSystem open (#99)', () => {
  afterEach(() => { delete g.__tcSuiteFs; vi.restoreAllMocks(); });

  it("the run's databases are deleted without a lost-storage report", async () => {
    const out = await buildTest({
      async readFile(p) { return p === '/co/tests/open-fs.test.ts' ? SUITE : readFileSync(REPO + p.slice('/co'.length), 'utf8'); },
    }, { root: '/co', file: 'tests/open-fs.test.ts', build: esbuild.build as any });
    expect(out.code).toContain('globalThis.__tcTestEnv.indexedDB.open(');

    const said: string[] = [];
    for (const level of ['error', 'warn', 'log'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { said.push(a.join(' ')); });
    const sum = await runTestBundle(out.code);
    expect([sum.passed, sum.failed, sum.errors]).toEqual([1, 0, []]);
    // (a FileSystem reopens 100 ms after its connection is dropped, and logs to the kernel log, which prints)
    await sleep(400);
    const fs = g.__tcSuiteFs;
    expect(fs.storageLost).toBe(null);
    expect(said.filter((s) => s.includes('browser storage was deleted'))).toEqual([]);

    // The databases are gone, and what the suite left running can't make one again
    await expect(fs.readFile('/tmp/never-read.txt', 'utf8')).rejects.toThrow();
    await sleep(200);
    expect(fs.storageLost).toBe(null);
    expect(said.filter((s) => s.includes('browser storage was deleted'))).toEqual([]);
    expect((await indexedDB.databases()).filter((d) => d.name?.startsWith(TEST_DB_PREFIX))).toEqual([]);
  }, 60_000);
});
