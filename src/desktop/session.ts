/**
 * Session restore across reloads (docs/DESKTOP.md "Session restore on reload").
 * What was open is saved as before. A reload does not reopen it. It opens one
 * Last session window (last-session.ts): a card per window, and one more for
 * each Claude Code or Codex session. The main terminal stays at a fresh prompt.
 *
 * - View draws a terminal's saved screen and the one restore note.
 * - Resume starts Claude Code or Codex (`claude --resume` / `codex resume`)
 *   in a new terminal, or a known-safe server (RESTARTABLE) in the saved one.
 * - Run starts a command that was still going. A long one is written to
 *   `/tmp/restore-N.sh` only then.
 * - Open runs the command that opened a window (mdview, Code, `gui APP`,
 *   `app open`), or opens Files, Settings, Activity or About where it was.
 *
 * Closing Last session does not forget the record, and a quiet reload does
 * not replace it with the fresh terminal. The record is replaced once the
 * desktop actually changes (a window opens, a command runs).
 *
 * The description is small and goes to localStorage `tabcomputer-desktop-session`
 * (on window changes, every few seconds while terminals print, at pagehide);
 * scrollback goes to IndexedDB (session-store.ts), never blocking the page.
 * Off with Settings → Appearance "Restore session on reload"
 * (`tabcomputer-restore-session` = '0'), skipped (and said) after a load that
 * froze, never in safe mode; `safe-mode reset-layout` forgets it all.
 */

import type { DesktopWindow, Geometry, WindowManager, WindowState } from './wm';
import type { TabState, TerminalView } from './terminal-app';
import * as store from './session-store';
import * as agentResume from '../agent-resume';
import type { ResumeCommand } from '../agent-resume';
import { isPlaceholder } from './launch-state';
import { RESTORED_NOTE } from './restore-note';
import { lastSessionCards, openLastSession } from './last-session';

export const SESSION_KEY = 'tabcomputer-desktop-session';
/** '0': don't restore the session on reload (Settings → Desktop) */
export const RESTORE_KEY = 'tabcomputer-restore-session';
const RESTORABLE = new Set(['terminal', 'files', 'settings', 'activity', 'about']);
export { RESTORED_NOTE };
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
  if (!w.appId || w.state === 'closed' || w.options.override || w.options.transientFor || isPlaceholder(w)) return null;
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

/** What a saved window is, apart from where it sits. A quiet reload matches this and is not written over the record. */
function sessionFingerprint(windows: SavedWindow[]): string {
  return JSON.stringify(windows.map((w) => ({
    id: w.id, app: w.app, cwd: w.cwd, path: w.path, pane: w.pane, title: w.title,
    tabs: w.tabs?.map((t) => ({
      main: t.main, active: t.active, cwd: t.cwd, env: t.env, osc: t.osc, running: t.running,
      agent: t.agent?.sessionId ?? null,
    })),
    cmd: w.restore?.cmd,
  })));
}

/**
 * The prompt and ~/.profile are drawn after tracking starts (main.ts). Until
 * `armSessionTracking`, that output is not a new session and does not replace
 * the saved one. A command after the prompt does.
 */
let armSession: (() => void) | null = null;
let sessionArmed = false;
export function armSessionTracking(): void {
  sessionArmed = true;
  armSession?.();
}

/** Keep the session saved as windows open, move and close, and as terminals print. Returns stop. */
export function trackSession(wm: WindowManager, base: Record<string, string> = {}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let screensDirty = true;
  const viewsOf = () => wm.windows().map((w) => (w as { content?: any }).content).filter((c) => typeof c?.takeDirty === 'function') as TerminalView[];
  const clearDirt = () => { for (const v of viewsOf()) v.takeDirty(); };
  clearDirt();
  let baseline = sessionFingerprint(snapshotSession(wm, base, false).windows);
  let committed = false;
  let activity = false;
  let armed = sessionArmed;
  const rebaseline = () => {
    clearDirt();
    baseline = sessionFingerprint(snapshotSession(wm, base, false).windows);
    armed = true;
  };
  armSession = rebaseline;
  (globalThis as { __tabcomputerArmSession?: () => void }).__tabcomputerArmSession = rebaseline;
  if (sessionArmed) rebaseline();
  const save = (force = false) => {
    timer = null;
    const views = viewsOf();
    // (every view's flag is taken, so one print doesn't keep saving)
    for (const v of views) if (v.takeDirty()) { screensDirty = true; if (armed) activity = true; }
    const light = snapshotSession(wm, base, false);
    // A reload that only showed Last session must not replace the record with the fresh terminal.
    if (!committed && !activity && sessionFingerprint(light.windows) === baseline) return;
    committed = true;
    const withScreens = screensDirty || force;
    const { windows, screens } = withScreens ? snapshotSession(wm, base, true) : light;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 2, windows })); } catch { /* full or blocked */ }
    if (withScreens) { screensDirty = false; void store.putAll(screens); }
  };
  const idle = (f: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 1000 }) : setTimeout(f, 0));
  const queue = (ms = 400) => { if (!timer) timer = setTimeout(() => idle(() => save()), ms); };
  const offs = (['window-created', 'window-closed', 'window-changed', 'focus-changed'] as const).map(ev => wm.on(ev, () => queue()));
  offs.push(agentResume.onChange(() => queue()));
  // terminals print without window events: look every few seconds
  const tick = setInterval(() => {
    if (viewsOf().some((v) => v.takeDirty())) { screensDirty = true; if (armed) { activity = true; queue(0); } }
  }, SAVE_EVERY_MS);
  const now = () => save(true);
  const hidden = () => { if (document.visibilityState === 'hidden') now(); };
  window.addEventListener('pagehide', now);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    if (armSession === rebaseline) armSession = null;
    const g = globalThis as { __tabcomputerArmSession?: () => void };
    if (g.__tabcomputerArmSession === rebaseline) g.__tabcomputerArmSession = undefined;
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

/** The longest command offered on the prompt as it is; a longer one is offered from a file */
export const OFFER_MAX = 72;

/**
 * What to do with a restored tab's command: resume the agent, run a known-safe server again, or
 * offer a line on the prompt (typed, not run). The note under the scrollback is one short line;
 * a long command isn't echoed: it goes in a script (`file`, /tmp/restore-N.sh) and the offer is
 * `source` of it. Claude Code that couldn't be resumed by its session id is offered `claude --continue`.
 * `history`: the line also goes on the shell's history, so Up brings it back after an exit.
 */
export function followUp(st: TabState, agent: ResumeCommand | null, n = 1): { note: string; run?: string; offer?: string; history?: string; file?: { path: string; text: string } } {
  if (agent) return { note: `${RESTORED_NOTE}\r\nresuming ${agent.agent === 'claude' ? 'Claude Code' : 'Codex'}`, run: agent.line, history: agent.line };
  if (!st.running) return { note: RESTORED_NOTE };
  const line = st.running.trim();
  const short = line.length <= OFFER_MAX && !line.includes('\n');
  if (RESTARTABLE.some((r) => r.test(line))) return { note: short ? `${RESTORED_NOTE}\r\nstarted again: ${line}` : `${RESTORED_NOTE}\r\nstarted again`, run: line, history: line };
  // (one whose session another tab resumes (st.agent, deduped) is offered plainly, not that session again)
  if (!st.agent && /^(clear\s*(;|&&)\s*)?claude(\s|$)/.test(line)) return { note: RESTORED_NOTE, offer: 'claude --continue', history: line };
  if (short) return { note: RESTORED_NOTE, offer: line, history: line };
  const path = `/tmp/restore-${n}.sh`;
  return { note: RESTORED_NOTE, offer: `source ${path}`, history: line, file: { path, text: `# Running in this terminal at the reload (${new Date().toLocaleString()}):\n${line}\n` } };
}

export interface RestoreDeps {
  openTerminal: (o: { cwd?: string; title?: string }) => DesktopWindow | null;
  /** Run a command line in a shell of its own (windows a command opens) */
  run?: (cmd: string, cwd: string) => void;
  /** Write a file (a long command offered from /tmp/restore-N.sh) */
  writeFile?: (path: string, text: string) => Promise<void>;
}

/**
 * Open the Last session window for `saved`. The main terminal is already
 * there and stays as it is. Returns that window, or null when nothing was
 * saved. Nothing is reopened until a card is used.
 */
export async function restoreSession(wm: WindowManager, saved: SavedWindow[], deps: RestoreDeps | RestoreDeps['openTerminal']): Promise<DesktopWindow | null> {
  const d: RestoreDeps = typeof deps === 'function' ? { openTerminal: deps } : deps;
  const cards = lastSessionCards(saved, followUp);
  if (!cards.length) return null;
  return openLastSession(wm, saved, cards, {
    openTerminal: d.openTerminal,
    run: d.run,
    writeFile: d.writeFile,
    place: (w, s) => place(w, s, wm.workArea()),
    screen: async (wi, ti) => (await store.get(screenKey(wi, ti))) ?? '',
    note: RESTORED_NOTE,
  });
}
