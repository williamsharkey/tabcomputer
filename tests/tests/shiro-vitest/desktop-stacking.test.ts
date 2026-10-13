/**
 * What lies over what on the desktop (src/desktop/desktop.css): a sheet asks
 * a question, so it is above the welcome card and the toasts, and below the
 * menus and Spotlight a person opens over it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../../src/desktop/desktop.css', import.meta.url), 'utf8');

/** The z-index of the rule whose selector is exactly `selector` */
function z(selector: string): number {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(css);
  const m = rule && /z-index: (\d+)/.exec(rule[1]);
  if (!m) throw new Error(`${selector} has no z-index in desktop.css`);
  return Number(m[1]);
}

describe('desktop stacking', () => {
  it('a sheet is above the welcome card and the toasts', () => {
    expect(z('.sd-sheet')).toBeGreaterThan(z('.sd-welcome'));
    expect(z('.sd-sheet')).toBeGreaterThan(z('.sd-toast'));
  });

  it('and not above what a person opens over it', () => {
    expect(z('.sd-sheet')).toBeLessThanOrEqual(z('.sd-popover'));
    expect(z('.sd-sheet')).toBeLessThan(z('.sd-drag-shield'));
  });
});
