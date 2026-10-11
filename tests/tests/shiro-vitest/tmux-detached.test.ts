/**
 * tmux without a terminal (williamsharkey/tabcomputer#14): what agents and
 * scripts run to keep a server going and read its output. A detached pane is
 * a kernel pty with a shell on it (#69): isatty, tty, stty size, REPLs.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { installNodeWorker } from './node-worker-setup';
import { ScreenBuffer } from '@shiro/tmux-layout';

let shell: Shell;

beforeAll(async () => {
  ({ shell } = await createTestShell());
  const { tmuxCmd } = await import('@shiro/commands/tmux');
  shell.commands.register(tmuxCmd);
});

afterEach(async () => { await sh('tmux kill-server'); });

async function sh(cmd: string) {
  let out = '';
  let err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

/** Poll until `check` holds (pane output arrives in the background) */
async function until(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const capture = async (t: string) => (await sh(`tmux capture-pane -p -t ${t}`)).out;

describe('tmux, detached', () => {
  it('new-session -d runs its command; the session ends with it', async () => {
    const r = await sh('tmux new-session -d -s srv "echo started; sleep 0.3; echo done"');
    expect(r.code).toBe(0);
    expect((await sh('tmux has-session -t srv')).code).toBe(0);
    expect((await sh('tmux ls')).out).toContain('srv: 1 windows');
    await until(async () => (await capture('srv')).includes('started'));
    await until(async () => (await sh('tmux has-session -t srv')).code === 1);
    expect((await sh('tmux has-session -t srv')).err).toContain("can't find session: srv");
  });

  it('send-keys types lines into a pane shell; capture-pane -p prints the screen', async () => {
    await sh('tmux new -d -s w');
    await sh('tmux send-keys -t w "echo hi $((1+2))" Enter');
    await until(async () => /^hi 3$/m.test(await capture('w')));
    // C-c ends what the pane runs; the shell goes on
    await sh('tmux send-keys -t w "sleep 30" C-m');
    await sh('tmux send-keys -t w C-c');
    await sh('tmux send-keys -t w "echo after" Enter');
    // (typed ahead, as on a terminal: the pty echoed it before the shell's next prompt, so the output follows that prompt)
    await until(async () => /(?:^|\$ )after$/m.test(await capture('w:0.0')));
  });

  it('a pane keeps its own cwd and says it is in tmux', async () => {
    await sh('mkdir -p /tmp/tmuxdir');
    await sh('tmux new -d -s c -c /tmp/tmuxdir');
    await sh("tmux send-keys -t c 'pwd; echo pane=$TMUX_PANE' Enter");
    await until(async () => /^\/tmp\/tmuxdir$/m.test(await capture('c')));
    expect(await capture('c')).toMatch(/^pane=%\d+$/m);
  });

  it('kill-session ends the pane and duplicates are refused', async () => {
    await sh('tmux new -d -s k "sleep 30"');
    expect((await sh('tmux new -d -s k')).err).toContain('duplicate session: k');
    expect((await sh('tmux kill-session -t k')).code).toBe(0);
    expect((await sh('tmux has -t k')).code).toBe(1);
  });

  it('display -p and list-panes -F expand formats', async () => {
    await sh('tmux new -d -s f');
    const r = await sh('tmux display -p -t f "#{session_name} #{pane_id}"');
    expect(r.out).toMatch(/^f %\d+\n$/);
    expect((await sh('tmux list-panes -t f -F "#{pane_dead} #{pane_width}x#{pane_height}"')).out).toBe('0 80x24\n');
  });

  it("a pane is a pty: tty, isatty, /proc/self/fd/0, stty size from -x/-y; list-panes names its tty and what runs; clear clears", async () => {
    await sh('tmux new-session -d -s t -x 80 -y 20');
    await sh("tmux send-keys -t t 'tty; test -t 1 && echo out-tty || echo out-notty; ls -l /proc/self/fd/0; stty size' Enter");
    await until(async () => /^20 80$/m.test(await capture('t')));
    const screen = await capture('t');
    expect(screen).toMatch(/^\/dev\/pts\/\d+$/m);
    expect(screen).toMatch(/^out-tty$/m);
    expect(screen).toMatch(/\/proc\/self\/fd\/0 -> \/dev\/pts\/\d+$/m);
    const lp = (await sh("tmux list-panes -t t -F '#{pane_tty} #{pane_pid} #{pane_current_command}'")).out;
    expect(lp).toMatch(/^\/dev\/pts\/\d+ \d+ sh\n$/);
    expect(screen.split('\n').length).toBe(21); // 20 rows
    await sh("tmux send-keys -t t 'clear; echo cleared' Enter");
    await until(async () => (await capture('t')).startsWith('cleared\n'));
    // the line discipline edits: BSpace, C-u; Up and C-a are passed through as their bytes
    await sh("tmux send-keys -t t 'echo abX' BSpace 'c' Enter");
    await until(async () => /^abc$/m.test(await capture('t')));
    await sh("tmux send-keys -t t 'echo junk' C-u 'echo kept' Enter");
    await until(async () => /^kept$/m.test(await capture('t')));
    expect(await capture('t')).not.toMatch(/^junk/m);
  });

  it("node's REPL runs in a pane (node as a kernel guest, tabcomputer's default)", async () => {
    const cleanup = await installNodeWorker();
    try {
      await sh('tmux new -d -s n -x 80 -y 20');
      await sh("tmux send-keys -t n 'node' Enter");
      await until(async () => /^> $/m.test(await capture('n')) || /^>$/m.test(await capture('n')), 20_000);
      expect((await sh("tmux display -p -t n '#{pane_current_command}'")).out).toBe('node\n');
      await sh("tmux send-keys -t n '6*7' Enter");
      await until(async () => /^42$/m.test(await capture('n')), 10_000);
      await sh("tmux send-keys -t n '.exit' Enter");
      await until(async () => (await sh("tmux display -p -t n '#{pane_current_command}'")).out === 'sh\n', 10_000);
    } finally { cleanup(); }
  }, 60_000);

  it('the pane screen follows cursor movement and erasing (a REPL redrawing its line, a TUI on the alternate screen)', () => {
    const b = new ScreenBuffer(20, 4);
    b.write('> 1+\x1b[2D\x1b[K2*3\r\n');
    expect(b.toLines()[0].trimEnd()).toBe('> 2*3');
    b.write('abc\x1b[1;1Hz\x1b[2;5H!');
    expect(b.toLines()[0].trimEnd()).toBe('z 2*3');
    expect(b.toLines()[1].trimEnd()).toBe('abc !');
    b.write('\x1b[?1049h\x1b[Hfull screen\x1b[');
    b.write('2;1Hrow2'); // (an escape cut between writes)
    expect(b.toLines().map((l) => l.trimEnd())).toEqual(['full screen', 'row2', '', '']);
    b.write('\x1b[?1049l');
    expect(b.toLines()[0].trimEnd()).toBe('z 2*3');
    b.write('\x1b[2J\x1b]0;title\x07x');
    expect(b.toLines().map((l) => l.trimEnd()).filter(Boolean)).toEqual(['     x']); // (where the main screen's cursor was)
  });

  it('attaching still needs a terminal', async () => {
    const r = await sh('tmux new -s x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('not a terminal');
  });
});
