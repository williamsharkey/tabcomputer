/**
 * Every example app (apps/examples/<id>/app.json) is one valid file, says what
 * it does, and the packages it needs have a layer built ahead
 * (src/debian/package-sets.json), so its first start takes seconds.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseManifest, manifestSentences } from '@shiro/apps/manifest';

const ROOT = resolve(__dirname, '../../../apps/examples');
const SETS = (JSON.parse(readFileSync(resolve(__dirname, '../../../src/debian/package-sets.json'), 'utf8')) as { sets: string[][] }).sets.map((s) => [...s].sort().join(' '));
const ids = readdirSync(ROOT).filter((d) => existsSync(resolve(ROOT, d, 'app.json')));

describe('example apps', () => {
  it('there are at least ten, each a folder holding only app.json', () => {
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) expect(readdirSync(resolve(ROOT, id)), id).toEqual(['app.json']);
  });
  for (const id of ids) {
    it(`${id}: valid, described, and its packages are built ahead`, () => {
      const text = readFileSync(resolve(ROOT, id, 'app.json'), 'utf8');
      const m = parseManifest(text, { id });
      expect(m.id).toBe(id);
      expect(m.name.length).toBeGreaterThan(3);
      expect(m.description, 'about').toMatch(/\.$/);
      expect(m.description.length).toBeLessThanOrEqual(140);
      expect(manifestSentences(m).length).toBeGreaterThan(1);
      if (m.needs.length) expect(SETS, `package-sets.json has no set ${JSON.stringify(m.needs)}`).toContain([...m.needs].sort().join(' '));
      // one file a person can read: short, and no key they would not understand
      expect(text.length).toBeLessThan(900);
    });
  }
});
