// tests/browser/_browser.mjs: which playwright and which Chromium the browser
// scripts drive, and terminal rows read as whole lines.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore a plain .mjs helper shared with the node scripts
import { chromiumPath, joinWrappedRows, loadPlaywright, MAC_CHROME } from '../../browser/_browser.mjs';

const BROWSER_DIR = join(__dirname, '../../browser');
const SCRIPTS_DIR = join(__dirname, '../../../scripts');

describe('browser scripts: the shared helper', () => {
  it('CHROMIUM wins; a Mac without it gets the system Chrome; Linux keeps the script\'s default', () => {
    const yes = () => true, no = () => false;
    expect(chromiumPath('/opt/pw-browsers/chromium', { CHROMIUM: '/x/chrome' }, 'darwin', yes)).toBe('/x/chrome');
    expect(chromiumPath('/opt/pw-browsers/chromium', {}, 'darwin', yes)).toBe(MAC_CHROME);
    expect(chromiumPath('/opt/pw-browsers/chromium', {}, 'darwin', no)).toBe('/opt/pw-browsers/chromium');
    expect(chromiumPath('/opt/pw-browsers/chromium', {}, 'linux', yes)).toBe('/opt/pw-browsers/chromium');
    expect(MAC_CHROME).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('falls back to playwright-core when playwright is not installed', () => {
    const tried: string[] = [];
    const load = (name: string) => { tried.push(name); if (name !== 'playwright-core') throw new Error('MODULE_NOT_FOUND'); return { chromium: 'core' }; };
    expect(loadPlaywright({}, load)).toEqual({ chromium: 'core' });
    expect(tried[0]).toBe('playwright');
    expect(tried).toContain('playwright-core');
    // PLAYWRIGHT= is tried first
    const first: string[] = [];
    loadPlaywright({ PLAYWRIGHT: '/p/pw' }, (name: string) => { first.push(name); return {}; });
    expect(first).toEqual(['/p/pw']);
    expect(() => loadPlaywright({}, () => { throw new Error('no'); })).toThrow(/playwright not found/);
  });

  it('joins rows the terminal wrapped, so a long line matches at any width', () => {
    const line = 'Successfully installed blinker-1.9.0 click-8.3.0 Flask-3.1.2 itsdangerous-2.2.0 Jinja2-3.1.6 MarkupSafe-3.0.3 Werkzeug-3.1.3';
    const expectRe = /Successfully installed .*Flask-.*MarkupSafe-/;
    for (const cols of [20, 47, 80, 200]) {
      const rows = [{ text: '$ pip install flask'.padEnd(cols), wrapped: false }];
      for (let i = 0; i < line.length; i += cols) rows.push({ text: line.slice(i, i + cols).padEnd(cols), wrapped: i > 0 });
      rows.push({ text: '$ '.padEnd(cols), wrapped: false });
      const text = joinWrappedRows(rows);
      expect(text.split('\n')).toEqual(['$ pip install flask', line, '$']);
      expect(expectRe.test(text)).toBe(true);
    }
    // 47 columns cut "Flask-" in two: the rows as they are do not match
    expect(expectRe.test([line.slice(0, 47), line.slice(47)].join('\n'))).toBe(false);
  });

  it('every script takes its browser and its playwright from the helper', () => {
    const files = [
      ...readdirSync(BROWSER_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => join(BROWSER_DIR, f)),
      join(SCRIPTS_DIR, 'browser-check.mjs'), join(SCRIPTS_DIR, 'browser-tui.mjs'),
    ];
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (!/\.launch\(/.test(src)) continue;
      // no launch with a hard-coded Linux path, and none that needs `playwright` itself
      expect(/process\.env\.CHROMIUM \|\| '\/opt/.test(src), file).toBe(false);
      expect(/executablePath: '\/opt/.test(src), file).toBe(false);
      expect(src.includes('chromiumPath('), file).toBe(true);
      expect(/loadPlaywright\(|playwright-core/.test(src), file).toBe(true);
    }
  });
});
