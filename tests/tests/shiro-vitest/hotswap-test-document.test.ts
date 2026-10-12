/**
 * tabcomputer#98: `hotswap test` ran suites against the page's own document,
 * so desktop-session's `document.body.innerHTML = ''` removed the desktop and
 * createTestOS() appended a terminal over it. A suite's `document` (its test
 * files' and its copies of src/) is now a document of the run's own.
 * Here the "page" is vitest's linkedom document, which can't make another
 * (no document.implementation), so the test gives it one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as esbuild from 'esbuild';
import { parseHTML } from 'linkedom';
import { buildTest } from '@shiro/hotswap/build';
import { runTestBundle } from '@shiro/hotswap/test-runner';

const page = document as any;

const FILES: Record<string, string> = {
  // a module of src/, as the suite's bundle copies it
  '/co/src/hs-fixture/mount.ts': `
export function mount(): void {
  const el = window.document.createElement('div');
  el.id = 'from-src';
  document.body.appendChild(el);
}
export const hasDocument = typeof document !== 'undefined';
`,
  '/co/tests/dom.test.ts': `
import { it, expect } from 'vitest';
import { mount, hasDocument } from '@shiro/hs-fixture/mount';
it('clears the body and appends a terminal, as desktop-session and createTestOS do', () => {
  document.body.innerHTML = '';
  const terminal = document.createElement('div');
  terminal.id = 'terminal';
  document.body.appendChild(terminal);
  mount();
  expect(hasDocument).toBe(true);
  expect([...document.body.children].map((e) => e.id)).toEqual(['terminal', 'from-src']);
  expect(document.getElementById('desktop')).toBeNull();
  expect(document.querySelector('base').getAttribute('href')).toBe('http://tab.test/app/');
});
`,
};

describe("hotswap test: a suite's document is its own (#98)", () => {
  afterEach(() => { delete page.implementation; delete page.baseURI; page.body.innerHTML = ''; });

  it("what a suite does to document.body doesn't reach the page", async () => {
    page.implementation = { createHTMLDocument: () => parseHTML('<!DOCTYPE html><html><head></head><body></body></html>').document };
    Object.defineProperty(page, 'baseURI', { value: 'http://tab.test/app/', configurable: true });
    page.body.innerHTML = '<div id="desktop"><div class="window"></div></div>';

    const out = await buildTest({ async readFile(p) { if (p in FILES) return FILES[p]; throw new Error('ENOENT ' + p); } },
      { root: '/co', file: 'tests/dom.test.ts', build: esbuild.build as any });
    expect(out.code).toContain('globalThis.__tcTestEnv.document.body');
    const sum = await runTestBundle(out.code);
    expect(sum.results.map((r) => `${r.status} ${r.error ?? ''}`)).toEqual(['pass ']);
    expect(sum.errors).toEqual([]);

    expect(page.body.innerHTML).toBe('<div id="desktop"><div class="window"></div></div>');
    expect(page.getElementById('terminal')).toBeNull();
    expect(page.getElementById('from-src')).toBeNull();
  });

  it("without a DOM implementation the suite gets the page's document", async () => {
    const suite = `const { it, expect } = globalThis.__tcTestApi;\nit('same', () => { expect(globalThis.__tcTestEnv.document === globalThis.document).toBe(true); });\n`;
    expect((await runTestBundle(suite)).passed).toBe(1);
  });
});
