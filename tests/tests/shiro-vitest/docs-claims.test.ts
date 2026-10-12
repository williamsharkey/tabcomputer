/**
 * Claims in the instructions that the code can check (issue #117, item 6):
 * the name of the GitHub token key, and what the server holds of a user's
 * secrets (nothing at rest; in transit for the proxies that end TLS there).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GITHUB_TOKEN_KEY } from '@shiro/github-auth';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('docs say what the code does', () => {
  it('AGENTS.md names the GitHub token key the code uses', () => {
    const agents = read('AGENTS.md');
    expect(GITHUB_TOKEN_KEY).toBe('tabcomputer_github_token');
    expect(agents).toContain(`localStorage.${GITHUB_TOKEN_KEY}`);
    expect(agents).not.toContain('shiro_github_token');
  });

  it('no instruction says the server holds no user secret without saying "in transit"', () => {
    for (const p of ['AGENTS.md', 'docs/research/GUEST_PROFILE.md', 'docs/DATA_FLOW.md']) {
      const text = read(p);
      expect(text, p).not.toMatch(/server holds no user secret/i);
    }
    for (const p of ['AGENTS.md', 'docs/research/GUEST_PROFILE.md']) {
      const text = read(p).replace(/\s+/g, ' ');
      const at = text.indexOf('stores no user secret');
      expect(at, p).toBeGreaterThan(-1);
      expect(text.slice(at, at + 500), p).toContain('in transit');
    }
  });
});
