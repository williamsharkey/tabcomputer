/**
 * tabcomputer#96: pgrep and pkill as procps-ng's. They matched the pattern as
 * a substring of the whole command line, so `pkill sleep` in a command line
 * that mentions sleep killed the shell running it; and they dropped every
 * option but -x and -l, so `pkill -9` sent SIGTERM.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import { Kernel } from '@shiro/kernel/kernel';
import { SinkFile } from '@shiro/wasi/stdio';
import { DevNull } from '@shiro/kernel/fd';
import * as A from '@shiro/kernel/abi';

describe('pgrep and pkill among kernel processes', () => {
  let shell: Shell;
  let kernel: Kernel;
  beforeAll(async () => { ({ shell } = await createTestShell()); });
  beforeEach(() => { kernel = new Kernel({ shell }); });
  afterEach(() => kernel.dispose());

  /** `sh -c SCRIPT` as a kernel process: what it printed and its wait status */
  const sh = async (script: string) => {
    let out = '';
    const sink = new SinkFile((t: string) => { out += t; });
    const p = kernel.spawn({ path: '/bin/sh', argv: ['sh', '-c', script], cwd: '/tmp', env: { ...shell.exportedEnv() }, fds: { 0: new DevNull(A.O_RDONLY), 1: sink, 2: sink } });
    return { status: await p.wait(), out: out.replace(/\r\n/g, '\n') };
  };

  it("the issue's command line: the shell running pkill survives it", async () => {
    // (the inner sleep is sh's builtin, not a process: nothing is named sleep)
    const r = await sh("sh -c 'echo inner; sleep 5' & sleep 0.3; pkill sleep; echo after $?; pkill -f 'echo inner'; echo full $?; wait $!; echo waited $?");
    expect(r).toEqual({ status: 0, out: 'inner\nafter 1\nfull 0\nwaited 143\n' });
  }, 30_000);

  it('the pattern is a regular expression on the name; -f on the command line, never its own shell', async () => {
    const r = await sh([
      'sleep 30 & sleep 0.2',
      '[ "$(pgrep sleep)" = "$!" ] && echo name',
      '[ "$(pgrep "^sle+p$")" = "$!" ] && echo regex',
      'pgrep slee -x; echo "exact $?"',
      'pgrep "sleep 30"; echo "name-only $?"',
      '[ "$(pgrep -f "sleep 30")" = "$!" ] && echo full',
      '[ "$(pgrep -fx "sleep 30")" = "$!" ] && echo full-exact',
      '[ "$(pgrep -i SLEEP)" = "$!" ] && echo ignore-case',
      '[ "$(pgrep -l sleep)" = "$! sleep" ] && echo list-name',
      '[ "$(pgrep -a sleep)" = "$! sleep 30" ] && echo list-full',
      '[ "$(pgrep -P $$ sleep)" = "$!" ] && echo parent',
      'pgrep -P 1 sleep; echo "other-parent $?"',
      '[ "$(pgrep -u user -c sleep)" = 1 ] && echo user-count',
      'pgrep -u root sleep; echo "root $?"',
      // this shell's command line is full of "sleep": -f still leaves it be
      'pkill -e -f sleep | sed "s/[0-9][0-9]*/N/"',
      'wait $!; echo "status $?"',
    ].join('\n'));
    expect(r).toEqual({
      status: 0,
      out: 'name\nregex\nexact 1\nname-only 1\nfull\nfull-exact\nignore-case\nlist-name\nlist-full\nparent\nother-parent 1\nuser-count\nroot 1\nsleep killed (pid N)\nstatus 143\n',
    });
  }, 30_000);

  it.each([['-9', 137], ['-KILL', 137], ['-SIGINT', 130], ['--signal HUP', 129], ['--signal=1', 129], ['', 143]])('pkill %s: the signal it names', async (flag, status) => {
    const r = await sh(`sleep 30 & sleep 0.2; pkill ${flag} sleep; echo "pkill $?"; wait $!; echo "status $?"`);
    expect(r).toEqual({ status: 0, out: `pkill 0\nstatus ${status}\n` });
  }, 30_000);

  it('-n and -o: the newest and the oldest; -d joins; -v inverts', async () => {
    const r = await sh([
      'sleep 31 & first=$!; sleep 0.2; sleep 32 & second=$!; sleep 0.2',
      '[ "$(pgrep -n sleep)" = "$second" ] && echo newest',
      '[ "$(pgrep -o sleep)" = "$first" ] && echo oldest',
      '[ "$(pgrep -d, sleep)" = "$first,$second" ] && echo delimiter',
      '[ "$(pgrep -v -P $$ -c)" -ge 1 ] && echo inverse',
      'pkill -o sleep; wait $first; echo "first $?"; pgrep -c sleep',
      'pkill sleep; wait; pgrep -c sleep; echo "none $?"',
    ].join('\n'));
    expect(r).toEqual({ status: 0, out: 'newest\noldest\ndelimiter\ninverse\nfirst 143\n1\n0\nnone 1\n' });
  }, 30_000);
});

describe('pgrep and pkill in the page shell', () => {
  let shell: Shell;
  beforeAll(async () => { ({ shell } = await createTestShell()); });

  it('a background job by its name; the signal as its status', async () => {
    const r = await run(shell, 'sleep 30 & sleep 0.2; [ "$(pgrep -x sleep)" = "$!" ] && echo found; pgrep -f "sleep 0.2|pgrep"; echo "self $?"; pkill -USR1 sleep; wait $!; echo "status $?"');
    expect(r.output.replace(/\r\n/g, '\n')).toContain('found\nself 1\nstatus 138\n');
  }, 30_000);

  it('usage errors are status 2, as procps', async () => {
    const usage = (msg: string, name = 'pgrep') => `${name}: ${msg}\nTry \`${name} --help' for more information.\n`;
    const err = async (cmd: string) => {
      let stderr = '';
      const code = await shell.execute(cmd, () => {}, (s) => { stderr += s; });
      return [code, stderr.replace(/\r\n/g, '\n')];
    };
    expect(await err('pgrep')).toEqual([2, usage('no matching criteria specified')]);
    expect(await err('pkill')).toEqual([2, usage('no matching criteria specified', 'pkill')]);
    expect(await err('pgrep a b')).toEqual([2, usage('only one pattern can be provided')]);
    expect(await err('pgrep -z x')).toEqual([2, usage("invalid option -- 'z'")]);
    expect(await err('pkill -l x')).toEqual([2, usage("invalid option -- 'l'", 'pkill')]);
    expect(await err('pkill --signal NOPE x')).toEqual([2, usage('Unknown signal "NOPE".', 'pkill')]);
    expect(await err('pgrep -u')).toEqual([2, usage("option requires an argument -- 'u'")]);
    expect((await err('pgrep "("'))[0]).toBe(2);
    expect((await err('pgrep a-name-longer-than-fifteen'))[0]).toBe(1);
  });
});
