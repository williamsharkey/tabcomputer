import { describe, expect, it } from 'vitest';
import { githubCloneSize, githubRepo, pageCloneLimit, PAGE_CLONE_MAX_MB } from '@shiro/commands/git-clone-size';

// #43: a clone too big for the page goes to the full git (or stops) instead of freezing the tab
const api = (routes: Record<string, any>) => {
  const calls: string[] = [];
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url + (init?.headers?.Authorization ? ' (auth)' : ''));
    const path = url.replace('https://api.github.com/repos/', '');
    const body = routes[path];
    return { ok: body !== undefined, json: async () => body };
  };
  return { fetch, calls };
};

describe('built-in clone size check', () => {
  it('knows GitHub repositories', () => {
    expect(githubRepo('https://github.com/williamsharkey/tabcomputer')).toBe('williamsharkey/tabcomputer');
    expect(githubRepo('https://github.com/o/r.git')).toBe('o/r');
    expect(githubRepo('https://github.com/o/r/')).toBe('o/r');
    expect(githubRepo('https://gitlab.com/o/r')).toBeNull();
    expect(githubRepo('https://github.com/o')).toBeNull();
  });

  it('sums a shallow clone\'s branch files', async () => {
    const { fetch, calls } = api({
      'o/r': { size: 300_000, default_branch: 'main' },
      'o/r/git/trees/unix/x?recursive=1': { truncated: false, tree: [
        { type: 'blob', size: 200e6 }, { type: 'blob', size: 50e6 }, { type: 'tree' },
      ] },
    });
    expect(await githubCloneSize('https://github.com/o/r', { shallow: true, ref: 'unix/x', token: 't', fetch, below: 100e6 }))
      .toEqual({ bytes: 250e6, what: "in unix/x's files" });
    expect(calls).toEqual(['https://api.github.com/repos/o/r (auth)', 'https://api.github.com/repos/o/r/git/trees/unix/x?recursive=1 (auth)']);
  });

  it('takes the repository size for a full clone, or when it already fits', async () => {
    const { fetch, calls } = api({ 'o/r': { size: 2000, default_branch: 'main' } });
    expect(await githubCloneSize('https://github.com/o/r', { shallow: false, fetch })).toEqual({ bytes: 2000 * 1024, what: 'with its history' });
    expect(await githubCloneSize('https://github.com/o/r', { shallow: true, fetch, below: 100e6 })).toEqual({ bytes: 2000 * 1024, what: 'with its history' });
    expect(calls).toHaveLength(2);
  });

  it('says nothing when it can\'t tell, so the clone goes ahead', async () => {
    expect(await githubCloneSize('https://gitlab.com/o/r', { shallow: true, fetch: api({}).fetch })).toBeNull();
    expect(await githubCloneSize('https://github.com/o/private', { shallow: true, fetch: api({}).fetch })).toBeNull();
    const offline = async () => { throw new TypeError('Failed to fetch'); };
    expect(await githubCloneSize('https://github.com/o/r', { shallow: true, fetch: offline })).toBeNull();
  });

  it('falls back to the repository size for a tree too big to list', async () => {
    const { fetch } = api({ 'o/r': { size: 500_000, default_branch: 'main' }, 'o/r/git/trees/main?recursive=1': { truncated: true, tree: [] } });
    expect((await githubCloneSize('https://github.com/o/r', { shallow: true, fetch, below: 100e6 }))?.what).toBe('with its history');
  });

  it('takes its limit from TABCOMPUTER_GIT_CLONE_MAX_MB', () => {
    expect(pageCloneLimit({})).toBe(PAGE_CLONE_MAX_MB * 1e6);
    expect(pageCloneLimit({ TABCOMPUTER_GIT_CLONE_MAX_MB: '500' })).toBe(500e6);
    expect(pageCloneLimit({ TABCOMPUTER_GIT_CLONE_MAX_MB: '0' })).toBe(0);
    expect(pageCloneLimit({ TABCOMPUTER_GIT_CLONE_MAX_MB: 'x' })).toBe(PAGE_CLONE_MAX_MB * 1e6);
  });
});
