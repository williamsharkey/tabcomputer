/**
 * Session restore across reloads (docs/DESKTOP.md "Layout after a reload"):
 * the windows that were open, where, in what state, in their stacking order
 * with the focused one marked, and what each showed:
 *
 * - Terminal windows: every tab with its working directory, the exported
 *   variables it changed, a program's title and its last 2000 lines of
 *   scrollback (restored as text, then a dim "— restored after reload —").
 *   A line still running at the reload is printed ("was running: …") and
 *   offered on the prompt, typed but not run, except known-safe long-runners
 *   (RESTARTABLE: servers) and Claude Code / Codex, which resume their own
 *   session (agent-resume.ts: `claude --resume ID`) by themselves.
 * - Files, Settings, Activity, About: their folder or pane.
 * - Windows a command opened (mdview, html, img, finder, Code, serve; GUI
 *   apps through `gui APP`): the command runs again in its directory.
 *
 * The description is small and goes to localStorage `tabcomputer-desktop-session`
 * (on window changes, every few seconds while terminals print, at pagehide);
 * scrollback goes to IndexedDB (session-store.ts), never blocking the page.
 * Restore runs after the first prompt (the main terminal's geometry at boot).
 * Off with Settings → Desktop "Restore session on reload" (`tabcomputer-restore-session`
 * = '0'), skipped (and said) after a load that froze, never in safe mode;
 * `safe-mode reset-layout` forgets it all.
 */

import type { DesktopWindow, Geometry, WindowManager, WindowState } from './wm';
import type { TabState, TerminalView } from './terminal-app';
import * as store from './session-store';
import * as agentResume from '../agent-resume';
import type { ResumeCommand } from '../agent-resume';

export const SESSION_KEY = 'tabcomputer-desktop-session';
/** '0': don't restore the session on reload (Settings → Desktop) */
export const RESTORE_KEY = 'tabcomputer-restore-session';
const RESTORABLE = new Set(['terminal', 'files', 'settings', 'activity', 'about']);
/** The line printed under a restored terminal's scrollback (as a dim shell comment, terminal.ts restoreScreen) */
export const RESTORED_NOTE = '── the output above is from before the page reloaded ──';
/**
 * Long-running commands that run again by themselves after a reload (servers
 * that only serve files): anything else that was running is only offered.
 */
export const RESTARTABLE: RegExp[] = [/^serve(\s|$)/, /^(npm|pnpm|yarn) run (dev|start|serve)(\s|$)/, /^npx vite(\s|$)/, /^vite(\s|$)/, /^python3? -m http\.server(\s|$)/];
/** Save at most this often while terminals print */
const SAVE_EVERY_MS = 3000;

export interface SavedWindow {
  id: string;
  app: string;
  g: Geometry;
  state: WindowState;
  cwd?: string;
  path?: string;
  pane?: string;
  /** It had the keyboard focus. */
  focused?: boolean;
  /** A terminal window: its title when fixed (a program's window), and its tabs (screens apart) */
  title?: string;
  tabs?: TabState[];
  /** A window a command opened: the command that opens it again, and where */
  restore?: { cmd: string; cwd: string };
}

export function restoreEnabled(): boolean {
  try { return localStorage.getItem(RESTORE_KEY) !== '0'; } catch { return true; }
}
export function setRestoreEnabled(on: boolean): void {
  try { if (on) localStorage.removeItem(RESTORE_KEY); else localStorage.setItem(RESTORE_KEY, '0'); } catch { /* no storage */ }
}

export function loadSession(): SavedWindow[] {
  if (!restoreEnabled()) return [];
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return Array.isArray(s?.windows) ? s.windows.filter((w: SavedWindow) => w && w.g && (RESTORABLE.has(w.app) || w.restore?.cmd)) : [];
  } catch { return []; }
}

/** Where a window a command opened says how to open it again (server-window.ts, code-editor.ts, the X11 host) */
export interface Reopenable { restoreCommand?: { cmd: string; cwd: string } }

const screenKey = (w: number, t: number) => `screen:${w}:${t}`;

function describe(w: DesktopWindow, base: Record<string, string>, withScreens: boolean): SavedWindow | null {
  if (!w.appId || w.state === 'closed' || w.options.override || w.options.transientFor) return null;
  const c = (w as { content?: any }).content;
  const out: SavedWindow = { id: w.id, app: w.appId, g: w.geometry(), state: w.state };
  if (w.focused) out.focused = true;
  const reopen = (w as Reopenable).restoreCommand;
  if (typeof c?.tabStates === 'function') {
    const view = c as TerminalView;
    out.app = 'terminal';
    out.tabs = view.tabStates(base, withScreens);
    out.cwd = view.cwd();
    if (view.fixedTitle) out.title = view.fixedTitle;
    return out;
  }
  if (reopen) { out.restore = reopen; return out; }
  if (!RESTORABLE.has(w.appId)) return null;
  if (typeof c?.cwd === 'function') out.cwd = c.cwd();
  if (typeof c?.path === 'function') out.path = c.path();
  if (typeof c?.pane === 'function') out.pane = c.pane();
  return out;
}

/** The session as saved now, and the terminal screens that go to IndexedDB (exported for tests) */
export function snapshotSession(wm: WindowManager, base: Record<string, string>, withScreens = true): { windows: SavedWindow[]; screens: Map<string, string> } {
  const windows: SavedWindow[] = [];
  const screens = new Map<string, string>();
  const seen = new Set<string>();
  for (const w of wm.windows()) {
    const s = describe(w, base, withScreens);
    if (!s) continue;
    // one relaunch per command (an app's several windows)
    if (s.restore) { if (seen.has(s.restore.cmd)) continue; seen.add(s.restore.cmd); }
    s.tabs?.forEach((t, j) => { if (t.screen !== undefined) { screens.set(screenKey(windows.length, j), t.screen); delete t.screen; } });
    windows.push(s);
  }
  return { windows, screens };
}

/** Keep the session saved as windows open, move and close, and as terminals print. Returns stop. */
export function trackSession(wm: WindowManager, base: Record<string, string> = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let screensDirty = true;
  const save = (force = false) => {
    timer = null;
    const views = wm.windows().map((w) => (w as { content?: any }).content).filter((c) => typeof c?.takeDirty === 'function') as TerminalView[];
    // (every view's flag is taken, so one print doesn't keep saving)
    for (const v of views) if (v.takeDirty()) screensDirty = true;
    const withScreens = screensDirty || force;
    const { windows, screens } = snapshotSession(wm, base, withScreens);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 2, windows })); } catch { /* full or blocked */ }
    if (withScreens) { screensDirty = false; void store.putAll(screens); }
  };
  const idle = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 1000 }) : setTimeout(f, 0));
  const queue = (ms = 400) => { if (!timer) timer = setTimeout(() => idle(() => save()), ms); };
  const offs = (['window-created', 'window-closed', 'window-changed', 'focus-changed'] as const).map(ev => wm.on(ev, () => queue()));
  offs.push(agentResume.onChange(() => queue()));
  // terminals print without window events: look every few seconds
  const tick = setInterval(() => {
    const views = wm.windows().map((w) => (w as { content?: any }).content).filter((c) => typeof c?.takeDirty === 'function') as TerminalView[];
    if (views.some((v) => v.takeDirty())) { screensDirty = true; queue(0); }
  }, SAVE_EVERY_MS);
  const now = () => save(true);
  const hidden = () => { if (document.visibilityState === 'hidden') now(); };
  window.addEventListener('pagehide', now);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    offs.forEach(o => o()); clearInterval(tick);
    window.removeEventListener('pagehide', now); document.removeEventListener('visibilitychange', hidden);
    if (timer) clearTimeout(timer);
  };
}

/** Put a window where it was: geometry, then a maximized/snapped/minimized state. */
export function place(w: DesktopWindow, s: SavedWindow, wa: Geometry): void {
  // Only geometry that still fits on this screen
  if (s.g.width <= wa.width && s.g.x < wa.width - 40 && s.g.y < wa.height - 40) w.setGeometry(s.g);
  if (s.state === 'maximized') w.maximize();
  else if (s.state.startsWith('snapped-')) w.snap(s.state.slice('snapped-'.length) as Parameters<DesktopWindow['snap']>[0]);
  else if (s.state === 'minimized') w.minimize();
}

/** What to do with a restored tab's command: resume the agent, run a known-safe server again, or offer the line */
export function followUp(st: TabState, agent: ResumeCommand | null): { note: string; run?: string; offer?: string; history?: string } {
  // (history: the line also goes on the shell's history, so Up brings it back after an exit)
  if (agent) return { note: `${RESTORED_NOTE}\r\nresuming ${agent.agent === 'claude' ? 'Claude Code' : 'Codex'}: ${agent.line}`, run: agent.line, history: agent.line };
  if (!st.running) return { note: RESTORED_NOTE };
  const line = st.running.trim();
  if (RESTARTABLE.some((r) => r.test(line))) return { note: `${RESTORED_NOTE}\r\nwas running, started again: ${line}`, run: line, history: line };
  return { note: `${RESTORED_NOTE}\r\nwas running: ${line}  (Enter runs it again)`, offer: line, history: line };
}

export interface RestoreDeps {
  openTerminal: (o: { cwd?: string; title?: string }) => DesktopWindow | null;
  /** Run a command line in a shell of its own (windows a command opens) */
  run?: (cmd: string, cwd: string) => void;
}

/**
 * Reopen the saved windows (the main terminal is already there), then stack
 * them all as they were. Returns the window that had the focus, for the
 * caller to focus once the desktop shows (null: none saved).
 */
export async function restoreSession(wm: WindowManager, saved: SavedWindow[], deps: RestoreDeps | RestoreDeps['openTerminal']): Promise<DesktopWindow | null> {
  const d: RestoreDeps = typeof deps === 'function' ? { openTerminal: deps } : deps;
  const placed: [SavedWindow, DesktopWindow][] = [];
  // what each tab does after its screen is back; no agent session resumed twice
  const agents = agentResume.dedupe(saved.flatMap((s) => (s.tabs ?? []).map((t) => t.agent ?? null)));
  let k = 0;
  const follow = saved.map((s) => (s.tabs ?? []).map((t) => followUp(t, agents[k++] ?? null)));
  for (const [wi, s] of saved.entries()) {
    let w: DesktopWindow | null = null;
    try {
      if (s.app === 'terminal') {
        w = s.id === 'terminal' ? wm.get('terminal') ?? null : d.openTerminal({ cwd: s.tabs?.[0]?.cwd ?? s.cwd ?? '/home/user', title: s.title });
        const view = (w as { content?: any } | null)?.content as TerminalView | undefined;
        if (view && typeof view.restoreTabs === 'function') {
          const tabs = await Promise.all((s.tabs ?? []).map(async (t, j) => ({ ...t, screen: (await store.get(screenKey(wi, j))) ?? '' })));
          const f = follow[wi];
          view.restoreTabs(tabs, (j) => f[j]?.note ?? RESTORED_NOTE, (j, term) => {
            if (f[j]?.history) term.rememberCommand?.(f[j].history!);
            if (f[j]?.run) term.injectInput(f[j].run + '\r');
            else if (f[j]?.offer) term.injectInput(f[j].offer!);
          }, s.id !== 'terminal');
        }
      } else if (s.restore) {
        if (d.run) {
          const before = new Set(wm.windows());
          d.run(s.restore.cmd, s.restore.cwd);
          // a command's window may come later (GUI apps): place it when it does, for a while
          w = wm.windows().find((x) => !before.has(x) && x.appId === s.app) ?? null;
          if (!w) {
            const off = wm.on('window-created', (nw) => {
              if (!nw || nw.appId !== s.app) return;
              off(); clearTimeout(t);
              place(nw, s, wm.workArea());
            });
            const t = setTimeout(off, 600_000);
          }
        }
      } else {
        w = await wm.openApp(s.app, { newWindow: true, ...(s.path ? { path: s.path } : {}), ...(s.pane ? { pane: s.pane } : {}) });
      }
    } catch (e) { console.warn('[desktop] restore', s.app, e); }
    if (w) { if (s.id !== 'terminal') place(w, s, wm.workArea()); placed.push([s, w]); }
  }
  // Opening focused (raised) each window in turn, after the main terminal: restack bottom to top
  for (const [s, w] of placed) if (s.state !== 'minimized' && w.state !== 'closed') w.focus();
  return placed.find(([s, w]) => s.focused && w.state !== 'closed' && w.state !== 'minimized')?.[1] ?? null;
}
