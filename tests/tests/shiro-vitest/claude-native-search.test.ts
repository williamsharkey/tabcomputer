import { describe, it, expect } from 'vitest';
import { nativeSearchSetup } from '@shiro/commands/claude';

// tabcomputer#42: native Claude Code's Bash tool replaced grep and find with
// functions that re-run the 240 MB binary as ugrep/bfs in Blink (300-1400 ms
// each). In 2.1.296 they're written unless an --allowedTools rule names Grep
// or Glob (its "search tools opt-in"); USE_BUILTIN_RIPGREP=0 makes its rg the
// one on PATH (tabcomputer's builtin) instead of itself.
describe('native claude search setup', () => {
  it('opts in to Grep and Glob (as one --flag=value word) and uses the rg on PATH', () => {
    expect(nativeSearchSetup([], {})).toEqual({ args: ['--allowedTools=Grep,Glob'], env: 'USE_BUILTIN_RIPGREP=0 ' });
    // the prompt stays a prompt, after the flag
    expect(nativeSearchSetup(['-p', 'fix the tests'], {}).args).toEqual(['--allowedTools=Grep,Glob', '-p', 'fix the tests']);
    expect(nativeSearchSetup(['--resume', 'abc'], {}).args[0]).toBe('--allowedTools=Grep,Glob');
  });

  it("leaves the user's own tool lists, an exported USE_BUILTIN_RIPGREP and subcommands alone", () => {
    expect(nativeSearchSetup(['--allowedTools', 'Bash(git *)'], {}).args).toEqual(['--allowedTools', 'Bash(git *)']);
    expect(nativeSearchSetup(['--tools=Bash,Read'], {}).args).toEqual(['--tools=Bash,Read']);
    expect(nativeSearchSetup([], { USE_BUILTIN_RIPGREP: '1' }).env).toBe('');
    for (const sub of [['auth', 'login'], ['mcp', 'list'], ['--version'], ['doctor']]) {
      expect(nativeSearchSetup(sub, {}), sub.join(' ')).toEqual({ args: sub, env: '' });
    }
  });
});
