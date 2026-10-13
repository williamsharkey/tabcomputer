/**
 * Session restore's model (src/desktop/session.ts, terminal-app.ts): what a
 * reload saves (terminal tabs' directory, variables, title, what was running,
 * an agent's resume command; windows a command opened; the preference) and
 * what a restore does with it (the follow-up rules, dedupe, relaunching
 * commands and placing their windows). The browser half: tests/browser/session-restore.mjs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { WindowManager } from '@shiro/desktop/wm';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}

let wm: WindowManager;
beforeEach(() => {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 30, width: 1000, height: 600 }) });
  localStorage.clear();
});

/** A terminal window's content as session.ts sees it (TerminalView's session methods) */
function fakeView(tabs: any[], fixedTitle = '') {
  const restored: { tabs: any[]; notes: string[]; typed: string[]; history: string[] } = { tabs: [], notes: [], typed: [], history: [] };
  return {
    restored,
    view: {
      fixedTitle,
      cwd: () => tabs[0]?.cwd,
      takeDirty: () => false,
      tabStates: () => tabs.map((t) => ({ ...t })),
      restoreTabs(saved: any[], noteFor: (i: number) => string, onReady: (i: number, term: any) => void) {
        saved.forEach((st, i) => {
          restored.tabs.push(st);
          restored.notes.push(noteFor(i));
          onReady(i, { injectInput: (s: string) => restored.typed.push(s), rememberCommand: (s: string) => restored.history.push(s) });
        });
      },
    },
  };
}

describe('session restore: the pieces', () => {
  it('saves only the variables a terminal changed, never secrets or the shell\'s own', async () => {
    const { envDiff } = await import('@shiro/desktop/terminal-app');
    const base = { HOME: '/home/user', PATH: '/usr/bin', LANG: 'C.UTF-8', GITHUB_TOKEN: 'x' };
    const env = { HOME: '/home/user', PATH: '/opt/bin:/usr/bin', FOO: 'bar', PWD: '/tmp', MY_API_KEY: 'secret', ANTHROPIC_API_KEY: 's', GITHUB_TOKEN: 'y' };
    expect(envDiff(env, base)).toEqual({ PATH: '/opt/bin:/usr/bin', FOO: 'bar', LANG: null });
    expect(envDiff(base, base)).toBeUndefined();
  });

  it('keeps the last lines of the screen, without the prompt at the bottom when nothing runs', async () => {
    const { screenText } = await import('@shiro/desktop/terminal-app');
    const text = 'user@tab:~$ ls\na.txt  b.txt\nuser@tab:~$ cd src\nuser@tab:~/src$ \n\n';
    expect(screenText(text, true)).toBe('user@tab:~$ ls\na.txt  b.txt\nuser@tab:~$ cd src');
    expect(screenText('$ npm run dev\nready on :5173\n', false)).toBe('$ npm run dev\nready on :5173');
    const many = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
    const kept = screenText(many, false).split('\n');
    expect([kept.length, kept[0], kept.at(-1)]).toEqual([2000, 'line 500', 'line 2499']);
  });

  it('a terminal reloaded again keeps one restore note, not one per reload (#128)', async () => {
    const { screenText } = await import('@shiro/desktop/terminal-app');
    const { RESTORED_NOTE } = await import('@shiro/desktop/session');
    const note = `# ${RESTORED_NOTE}`;
    // at the prompt under the note: the note goes, the next restore prints it again
    expect(screenText(`$ ls\na.txt\n${note}\nuser@tab:~$ `, true)).toBe('$ ls\na.txt');
    // notes stacked by earlier builds, and a note of two lines
    expect(screenText(`$ ls\na.txt\n${note}\n${note}\n${note}\n# resuming Claude Code\nuser@tab:~$ `, true)).toBe('$ ls\na.txt');
    // something ran since: the earlier note goes too, since the next restore prints one under everything
    expect(screenText(`$ ls\n${note}\nuser@tab:~$ pwd\n/home/user\nuser@tab:~$ `, true)).toBe('$ ls\nuser@tab:~$ pwd\n/home/user');
    expect(screenText(`$ ls\n${note}\n# started again: serve .\nuser@tab:~$ serve .\nserving\n${note}\nrun link: no such recipe\nuser@tab:~$ `, true)).toBe('$ ls\nuser@tab:~$ serve .\nserving\nrun link: no such recipe');
    // a comment the user's own output ends with is not a note
    expect(screenText('$ cat a.sh\n# the end\nuser@tab:~$ ', true)).toBe('$ cat a.sh\n# the end');
    // across reloads on a real terminal where each load prints a line (a refused link): still one note
    {
      const { createTestOS } = await import('./helpers');
      const { bufferToString } = await import('@shiro/utils/copy-utils');
      const t: any = (await createTestOS()).terminal;
      let saved = 'user@tab:~$ ls\na.txt';
      for (let i = 0; i < 4; i++) {
        t.restoreScreen(saved, RESTORED_NOTE);
        // (what a refused link does: a line of the page's own, with the prompt drawn again under it)
        t.notice(`run link: no such recipe ${i}`);
        await new Promise<void>((r) => t.term.write('', r));
        saved = screenText(bufferToString(t.term), true);
      }
      t.restoreScreen(saved, RESTORED_NOTE);
      await new Promise<void>((r) => t.term.write('', r));
      const lines = bufferToString(t.term).split('\n').filter((l: string) => l.trim());
      expect(lines.filter((l: string) => l.includes(RESTORED_NOTE))).toHaveLength(1);
      expect(lines.filter((l: string) => /run link: no such recipe/.test(l))).toHaveLength(4);
    }
    // across reloads on a real terminal: one note, one prompt
    const { createTestOS } = await import('./helpers');
    const { bufferToString } = await import('@shiro/utils/copy-utils');
    const { terminal } = await createTestOS();
    const t: any = terminal;
    let saved = 'user@tab:~$ ls\na.txt  b.txt';
    for (let i = 0; i < 4; i++) {
      t.restoreScreen(saved, RESTORED_NOTE);
      await new Promise<void>((r) => t.term.write('', r));
      saved = screenText(bufferToString(t.term), true);
    }
    expect(saved).toBe('user@tab:~$ ls\na.txt  b.txt');
    const lines = bufferToString(t.term).split('\n').filter((l: string) => l.trim());
    expect(lines.filter((l: string) => l.includes(RESTORED_NOTE))).toHaveLength(1);
  });

  it('start() adds no second prompt to a terminal whose screen was restored meanwhile (#128)', async () => {
    const { createTestOS } = await import('./helpers');
    const { bufferToString } = await import('@shiro/utils/copy-utils');
    const { RESTORED_NOTE } = await import('@shiro/desktop/session');
    const { terminal } = await createTestOS();
    const t: any = terminal;
    const starting = t.start();
    t.restoreScreen('old output', RESTORED_NOTE);
    await starting;
    await new Promise<void>((r) => t.term.write('', r));
    const last = bufferToString(t.term).split('\n').filter((l: string) => l.trim()).at(-1)!;
    expect(last.match(/\$/g)).toHaveLength(1);
  });

  it('a running line is offered, not run; servers start again; an agent resumes', async () => {
    const { followUp, RESTORED_NOTE } = await import('@shiro/desktop/session');
    expect(followUp({ cwd: '/' }, null)).toEqual({ note: RESTORED_NOTE });
    const offered = followUp({ cwd: '/', running: 'rm -rf build && make' }, null);
    expect(offered.offer).toBe('rm -rf build && make');
    expect(offered.run).toBeUndefined();
    expect(offered.note).toBe(RESTORED_NOTE);
    // a long line isn't echoed: it is offered from a script holding it
    const long = 'clear; ' + 'x'.repeat(200);
    const filed = followUp({ cwd: '/', running: long }, null, 3);
    expect(filed.offer).toBe('source /tmp/restore-3.sh');
    expect(filed.file!.path).toBe('/tmp/restore-3.sh');
    expect(filed.file!.text).toContain(long + '\n');
    expect(filed.note).toBe(RESTORED_NOTE);
    // claude whose session wasn't captured: --continue, not its first prompt again
    expect(followUp({ cwd: '/', running: 'clear; claude "a long first prompt"' }, null).offer).toBe('claude --continue');
    expect(followUp({ cwd: '/', running: 'npm run dev' }, null).run).toBe('npm run dev');
    expect(followUp({ cwd: '/', running: 'serve ./site 8080' }, null).run).toBe('serve ./site 8080');
    const agent = { agent: 'claude' as const, sessionId: 'abc', argv: ['claude', '--resume', 'abc'], line: 'claude --resume abc', cwd: '/home/user/p' };
    const resumed = followUp({ cwd: '/home/user/p', running: 'claude' }, agent);
    expect(resumed.run).toBe('claude --resume abc');
    expect(resumed.note).toContain('resuming Claude Code');
    // each also goes on the shell's history: Up brings it back after an exit
    expect([offered.history, resumed.history, followUp({ cwd: '/' }, null).history]).toEqual(['rm -rf build && make', 'claude --resume abc', undefined]);
  });

  it('the preference turns restoring off (saving goes on)', async () => {
    const s = await import('@shiro/desktop/session');
    localStorage.setItem(s.SESSION_KEY, JSON.stringify({ v: 2, windows: [{ id: 'w1', app: 'files', g: { x: 0, y: 0, width: 300, height: 200 }, state: 'normal' }] }));
    expect(s.restoreEnabled()).toBe(true);
    expect(s.loadSession().length).toBe(1);
    s.setRestoreEnabled(false);
    expect(localStorage.getItem(s.RESTORE_KEY)).toBe('0');
    expect(s.loadSession()).toEqual([]);
    s.setRestoreEnabled(true);
    expect(s.loadSession().length).toBe(1);
  });
});

describe('session restore: save and restore', () => {
  it('saves terminal tabs (screens apart), windows a command opened (once per command), and skips programs\' child windows', async () => {
    const s = await import('@shiro/desktop/session');
    const t = wm.createWindow({ id: 'terminal', appId: 'terminal', title: 'Terminal' });
    (t as any).content = fakeView([{ main: true, active: true, cwd: '/home/user/src', env: { FOO: 'bar' }, screen: 'hello\nworld' }, { cwd: '/tmp', running: 'npm run dev', screen: 'ready' }]).view;
    const md = wm.createWindow({ appId: 'mdview', title: 'n.md' });
    (md as any).restoreCommand = { cmd: 'mdview n.md', cwd: '/home/user' };
    const g1 = wm.createWindow({ appId: 'gimp', title: 'GIMP' });
    (g1 as any).restoreCommand = { cmd: 'gui gimp', cwd: '/home/user' };
    const g2 = wm.createWindow({ appId: 'gimp', title: 'Layers' });
    (g2 as any).restoreCommand = { cmd: 'gui gimp', cwd: '/home/user' };
    wm.createWindow({ appId: 'gimp', title: 'Open Image', transientFor: g1.id });
    wm.createWindow({ appId: 'vim', title: 'Vim' }); // no way to reopen it: left out
    const { windows, screens } = s.snapshotSession(wm, {});
    expect(windows.map((w) => w.app)).toEqual(['terminal', 'mdview', 'gimp']);
    expect(windows[0].tabs).toEqual([{ main: true, active: true, cwd: '/home/user/src', env: { FOO: 'bar' } }, { cwd: '/tmp', running: 'npm run dev' }]);
    expect([...screens]).toEqual([['screen:0:0', 'hello\nworld'], ['screen:0:1', 'ready']]);
    expect(windows[1].restore).toEqual({ cmd: 'mdview n.md', cwd: '/home/user' });
  });

  it('restores: terminals get their tabs and follow-ups, commands run again and their windows go where they were', async () => {
    const s = await import('@shiro/desktop/session');
    const agent = { agent: 'claude' as const, sessionId: 'S1', argv: [], line: 'claude --resume S1', cwd: '/home/user/p' };
    const saved: any[] = [
      { id: 'terminal', app: 'terminal', g: { x: 0, y: 0, width: 500, height: 300 }, state: 'normal', tabs: [{ main: true, cwd: '/home/user', running: 'make test' }] },
      { id: 'w2', app: 'terminal', g: { x: 40, y: 40, width: 500, height: 300 }, state: 'normal', title: 'Claude', tabs: [{ cwd: '/home/user/p', running: 'claude', agent }, { cwd: '/home/user/p', running: 'claude', agent }] },
      { id: 'w3', app: 'mdview', g: { x: 120, y: 80, width: 400, height: 300 }, state: 'normal', restore: { cmd: 'mdview n.md', cwd: '/home/user' }, focused: true },
      { id: 'w4', app: 'gimp', g: { x: 200, y: 100, width: 600, height: 400 }, state: 'normal', restore: { cmd: 'gui gimp', cwd: '/home/user' } },
    ];
    const main = wm.createWindow({ id: 'terminal', appId: 'terminal', title: 'Terminal' });
    const mainView = fakeView([]);
    (main as any).content = mainView.view;
    const opened: any[] = [];
    let claudeView: ReturnType<typeof fakeView> | null = null;
    const ran: string[] = [];
    const focused = await s.restoreSession(wm, saved, {
      openTerminal: (o) => { opened.push(o); const w = wm.createWindow({ appId: 'terminal', title: o.title ?? 'Terminal' }); claudeView = fakeView([]); (w as any).content = claudeView.view; return w; },
      // mdview opens its window at once; GUI apps later
      run: (cmd) => { ran.push(cmd); if (cmd.startsWith('mdview')) wm.createWindow({ appId: 'mdview', title: 'n.md' }); },
    });
    expect(opened).toEqual([{ cwd: '/home/user/p', title: 'Claude' }]);
    // the main terminal: its command offered, typed but not run
    expect(mainView.restored.typed).toEqual(['make test']);
    expect(mainView.restored.notes[0]).toBe(s.RESTORED_NOTE);
    // the agent's session resumes once; the second tab had the same session (dedupe): its line is only offered
    expect(claudeView!.restored.typed).toEqual(['claude --resume S1\r', 'claude']);
    expect([mainView.restored.history, claudeView!.restored.history]).toEqual([['make test'], ['claude --resume S1', 'claude']]);
    expect(ran).toEqual(['mdview n.md', 'gui gimp']);
    const mdWin = wm.windows().find((w) => w.appId === 'mdview')!;
    expect(mdWin.geometry()).toMatchObject({ x: 120, y: 80, width: 400, height: 300 });
    expect(focused).toBe(mdWin);
    // GIMP's window comes later: it goes where it was
    const gimp = wm.createWindow({ appId: 'gimp', title: 'GIMP' });
    expect(gimp.geometry()).toMatchObject({ x: 200, y: 100, width: 600, height: 400 });
  });
});
