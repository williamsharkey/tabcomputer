import { describe, expect, it } from 'vitest';
import { loginArgs, searchToolArgs } from '@shiro/commands/claude';

// #42: without an allow rule naming Grep/Glob, native Claude Code replaces grep
// and find with functions that re-exec its whole binary as ugrep/bfs.
describe('native claude search tools', () => {
  const allow = '--allowedTools=Grep,Glob';

  it('turns them on for a session and for -p', () => {
    expect(searchToolArgs([], {})).toEqual([allow]);
    expect(searchToolArgs(['-p', 'fix the bug'], {})).toEqual([allow, '-p', 'fix the bug']);
    expect(searchToolArgs(['--resume'], {})).toEqual([allow, '--resume']);
    expect(searchToolArgs(['fix the bug'], {})).toEqual([allow, 'fix the bug']);
  });

  it('leaves subcommands alone', () => {
    expect(searchToolArgs(['mcp', 'list'], {})).toEqual(['mcp', 'list']);
    expect(searchToolArgs(['doctor'], {})).toEqual(['doctor']);
    expect(searchToolArgs(loginArgs(['login']), {})).toEqual(['auth', 'login']);
  });

  it('keeps Claude\'s wrappers with TABCOMPUTER_CLAUDE_GREP_WRAPPERS=1', () => {
    expect(searchToolArgs(['-p', 'x'], { TABCOMPUTER_CLAUDE_GREP_WRAPPERS: '1' })).toEqual(['-p', 'x']);
  });
});
