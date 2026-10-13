// Shared by the tests/browser scripts and scripts/browser-*.mjs: which playwright
// and which Chromium to drive.
//
//   PLAYWRIGHT=/path/to/playwright-core   the module to load first
//   CHROMIUM=/path/to/chrome              the browser
//
// Without them: `playwright`, then the cloud containers' copy, then
// `playwright-core`; and the system Chrome on a Mac, else the pre-installed
// Chromium the script names (never `playwright install`).
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const PLAYWRIGHT_MODULES = ['playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright-core'];

/** The playwright module (`{ chromium, ... }`): $PLAYWRIGHT, playwright, the containers' copy, playwright-core. */
export function loadPlaywright(env = process.env, load = require) {
  const names = [env.PLAYWRIGHT, ...PLAYWRIGHT_MODULES].filter(Boolean);
  for (const name of names) {
    try { return load(name); } catch { /* the next one */ }
  }
  throw new Error(`playwright not found (tried ${names.join(', ')}); set PLAYWRIGHT=/path/to/playwright-core`);
}

/** The browser to launch: $CHROMIUM, the system Chrome on a Mac, else `linuxDefault`. */
export function chromiumPath(linuxDefault = '/opt/pw-browsers/chromium', env = process.env, platform = process.platform, exists = existsSync) {
  if (env.CHROMIUM) return env.CHROMIUM;
  if (platform === 'darwin' && exists(MAC_CHROME)) return MAC_CHROME;
  return linuxDefault;
}

/**
 * Terminal rows as text, a row that xterm wrapped joined to the one before it,
 * so a long line reads the same at any terminal width. `rows` is
 * `[{ text, wrapped }]` with `text` untrimmed; trailing blanks of each whole
 * line are dropped.
 */
export function joinWrappedRows(rows) {
  const lines = [];
  for (const row of rows) {
    if (row.wrapped && lines.length) lines[lines.length - 1] += row.text;
    else lines.push(row.text);
  }
  return lines.map((l) => l.replace(/\s+$/, '')).join('\n');
}
