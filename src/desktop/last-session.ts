/**
 * Last session (docs/DESKTOP.md "Session restore on reload"): one window
 * after a reload, a card for each thing that was open. Nothing else opens,
 * and nothing is typed, until a card's button is used. Closing the window
 * does not forget the saved session.
 */

import type { DesktopWindow, WindowManager } from './wm';
import type { SavedWindow } from './session';
import type { TabState, TerminalView } from './terminal-app';
import type { ResumeCommand } from '../agent-resume';
import { dedupe } from '../agent-resume';
import { isPlaceholder, rememberGeometry } from './launch-state';

/** What `followUp` says to do with a tab. Passed in so this file does not import session.ts at runtime. */
export interface FollowUp {
  note: string;
  run?: string;
  offer?: string;
  history?: string;
  file?: { path: string; text: string };
}

export interface LastAction {
  act: 'view' | 'resume' | 'run' | 'open';
  ti?: number;
  /** Typed and run. An agent resume opens a new terminal (`fresh`) instead of the saved one. */
  line?: string;
  fresh?: boolean;
  cwd?: string;
  title?: string;
  file?: { path: string; text: string };
}

export interface LastCard {
  kind: 'terminal' | 'agent' | 'app' | 'place';
  title: string;
  detail: string;
  status: string;
  /** Index into the saved session. */
  wi: number;
  /** App id for Files, Settings, Activity, About. */
  app?: string;
  /** The command Open runs. */
  cmd?: string;
  actions: LastAction[];
  /** One history line per saved tab, remembered when the terminal is viewed. */
  recall?: string[];
}

export interface LastActions {
  openTerminal: (o: { cwd?: string; title?: string; command?: string }) => DesktopWindow | null;
  run?: (cmd: string, cwd: string) => void;
  writeFile?: (path: string, text: string) => Promise<void>;
  place: (w: DesktopWindow, s: SavedWindow) => void;
  screen: (wi: number, ti: number) => Promise<string>;
  /** The one line under a viewed terminal's saved screen. */
  note: string;
}

const PLACE_NAMES: Record<string, string> = { files: 'Files', settings: 'Settings', activity: 'Activity', about: 'About' };

function shortDir(p?: string): string {
  if (!p) return '';
  if (p === '/home/user') return '~';
  if (p.startsWith('/home/user/')) return '~' + p.slice('/home/user'.length);
  return p;
}

function oneLine(s: string, n = 48): string {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

function appTitle(s: SavedWindow): string {
  const cmd = s.restore?.cmd ?? '';
  if (/^jupyter(\s|$)/.test(cmd)) return 'Notebook';
  if (/\bstudio\b/.test(cmd)) return 'Studio';
  if (/^serve open\b/.test(cmd)) return 'Preview';
  if (/^code\b/.test(cmd) || /^desktop open code\b/.test(cmd)) return 'Code';
  const named = cmd.match(/^(?:gui|app open|mdview|html|img)\s+(\S+)/);
  if (named) return named[1].replace(/^.*\//, '');
  const file = cmd.match(/\s(\S+\.\w+)\s*$/);
  if (file) return file[1].replace(/^.*\//, '');
  return s.app || 'Window';
}

function terminalTitle(s: SavedWindow): string {
  const tabs = s.tabs ?? [];
  const active = tabs.find((t) => t.active) ?? tabs[0];
  const running = active?.running && !active.agent ? oneLine(active.running) : '';
  let title = s.title || active?.osc || running || 'Terminal';
  if (tabs.length > 1) title = `${title} · ${tabs.length} tabs`;
  return title;
}

/**
 * One card per saved window, plus a card for each Claude Code or Codex session
 * (a session id only once). A terminal that was only running that agent is idle;
 * Resume is on the agent's card.
 */
export function lastSessionCards(saved: SavedWindow[], follow: (st: TabState, agent: ResumeCommand | null, n?: number) => FollowUp): LastCard[] {
  const agents = dedupe(saved.flatMap((s) => (s.tabs ?? []).map((t) => t.agent ?? null)));
  let k = 0;
  let n = 0;
  const followOf = new Map<string, FollowUp>();
  saved.forEach((s, wi) => {
    (s.tabs ?? []).forEach((t, ti) => {
      const f = follow(t, null, n + 1);
      if (f.file) n++;
      followOf.set(`${wi}:${ti}`, f);
    });
  });
  const cards: LastCard[] = [];
  saved.forEach((s, wi) => {
    const tabAgents = (s.tabs ?? []).map(() => agents[k++] ?? null);
    if (s.app === 'terminal') {
      const tabs = s.tabs ?? [];
      const active = tabs.find((t) => t.active) ?? tabs[0];
      const wasRunning = tabs.some((t) => t.running && !t.agent);
      const actions: LastAction[] = [{ act: 'view' }];
      const order = tabs.map((_, i) => i).sort((a, b) => Number(!!tabs[b].active) - Number(!!tabs[a].active));
      let resume: LastAction | null = null;
      let run: LastAction | null = null;
      for (const ti of order) {
        const t = tabs[ti];
        if (t.agent || !t.running) continue;
        const f = followOf.get(`${wi}:${ti}`);
        if (!f) continue;
        if (!resume && f.run) resume = { act: 'resume', ti, line: f.run };
        else if (!resume && f.offer === 'claude --continue') resume = { act: 'resume', ti, line: f.offer };
        else if (!run && f.offer) run = { act: 'run', ti, line: f.offer, file: f.file };
      }
      if (resume) actions.push(resume);
      if (run) actions.push(run);
      cards.push({
        kind: 'terminal', wi, title: terminalTitle(s), detail: shortDir(active?.cwd ?? s.cwd),
        status: wasRunning ? 'was running' : 'idle', actions,
        recall: tabs.map((t, ti) => (t.agent ? '' : followOf.get(`${wi}:${ti}`)?.history ?? '')),
      });
      tabAgents.forEach((agent, ti) => {
        const t = tabs[ti];
        if (!agent || !t) return;
        cards.push({
          kind: 'agent', wi, title: agent.agent === 'claude' ? 'Claude Code' : 'Codex',
          detail: shortDir(agent.cwd || t.cwd), status: 'can resume',
          actions: [
            { act: 'view', ti },
            { act: 'resume', ti, line: agent.line, fresh: true, cwd: agent.cwd || t.cwd, title: agent.agent === 'claude' ? 'Claude Code' : 'Codex' },
          ],
        });
      });
      return;
    }
    if (s.restore?.cmd) {
      cards.push({
        kind: 'app', wi, title: appTitle(s), detail: shortDir(s.restore.cwd || s.cwd || s.path),
        status: 'was open', cmd: s.restore.cmd, actions: [{ act: 'open' }],
      });
      return;
    }
    if (PLACE_NAMES[s.app]) {
      cards.push({
        kind: 'place', wi, app: s.app, title: PLACE_NAMES[s.app],
        detail: s.pane || shortDir(s.path || s.cwd), status: 'was open', actions: [{ act: 'open' }],
      });
    }
  });
  return cards;
}

const LABELS: Record<LastAction['act'], string> = { view: 'View', resume: 'Resume', run: 'Run', open: 'Open' };

function el(tag: string, className: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/**
 * The Last session window. Returns it, or null when there is nothing to list.
 * View draws a terminal's saved screen. Resume and Run start something.
 * Open runs the command, or opens Files, Settings, Activity or About.
 */
export function openLastSession(wm: WindowManager, saved: SavedWindow[], cards: LastCard[], act: LastActions): DesktopWindow | null {
  if (!cards.length) return null;
  const root = el('div', 'sd-app sd-last');
  root.append(el('p', 'sd-last-lead', 'What was open. Nothing else was reopened.'));
  const list = el('div', 'sd-last-list');
  root.append(list);

  const viewed = new Map<string, DesktopWindow>();
  const terms = new Map<string, { injectInput: (s: string) => void; rememberCommand?: (s: string) => void }>();
  const opened = new Map<string, DesktopWindow>();
  const opening = new Set<string>();
  let job: Promise<void> = Promise.resolve();

  const viewTerminal = async (wi: number): Promise<DesktopWindow | null> => {
    const s = saved[wi];
    if (!s) return null;
    const prev = viewed.get(s.id);
    if (prev && prev.state !== 'closed') { prev.focus(); return prev; }
    const card = cards.find((c) => c.kind === 'terminal' && c.wi === wi);
    let w: DesktopWindow | null = s.id === 'terminal' ? wm.get('terminal') ?? null : act.openTerminal({ cwd: s.tabs?.[0]?.cwd ?? s.cwd ?? '/home/user', title: s.title });
    const view = (w as { content?: TerminalView } | null)?.content;
    if (w && view && typeof view.restoreTabs === 'function') {
      const tabs = await Promise.all((s.tabs ?? []).map(async (t, ti) => ({ ...t, screen: await act.screen(wi, ti) })));
      view.restoreTabs(tabs, () => act.note, (ti, term) => {
        terms.set(`${wi}:${ti}`, term);
        const line = card?.recall?.[ti];
        if (line) term.rememberCommand?.(line);
      }, s.id !== 'terminal');
      if (s.id !== 'terminal') act.place(w, s);
    }
    if (w) { viewed.set(s.id, w); w.focus(); }
    return w;
  };

  const openSaved = async (wi: number): Promise<void> => {
    const s = saved[wi];
    if (!s) return;
    const key = s.restore?.cmd ?? s.app;
    const prev = opened.get(key);
    if (prev && prev.state !== 'closed') { prev.focus(); return; }
    if (opening.has(key)) return;
    opening.add(key);
    try {
      if (s.restore?.cmd && act.run) {
        const before = new Set(wm.windows());
        rememberGeometry(s.app, s.g);
        act.run(s.restore.cmd, s.restore.cwd);
        let w = wm.windows().find((x) => !before.has(x) && x.appId === s.app && !isPlaceholder(x)) ?? null;
        if (w) { act.place(w, s); opened.set(key, w); }
        else {
          const off = wm.on('window-created', (nw) => {
            if (!nw || nw.appId !== s.app || isPlaceholder(nw) || nw.options.splash || nw.options.override) return;
            off(); clearTimeout(t);
            act.place(nw, s);
            opened.set(key, nw);
          });
          const t = setTimeout(off, 600_000);
        }
      } else {
        const w = await wm.openApp(s.app, { newWindow: true, ...(s.path ? { path: s.path } : {}), ...(s.pane ? { pane: s.pane } : {}) });
        if (w) { act.place(w, s); opened.set(key, w); }
      }
    } finally { opening.delete(key); }
  };

  const go = (card: LastCard, a: LastAction): Promise<void> => {
    if (a.act === 'open') return openSaved(card.wi);
    if (a.act === 'resume' && a.fresh && a.line) {
      act.openTerminal({ cwd: a.cwd, title: a.title, command: a.line });
      return Promise.resolve();
    }
    return (async () => {
      await viewTerminal(card.wi);
      if ((a.act === 'resume' || a.act === 'run') && a.line) {
        if (a.file && act.writeFile) await act.writeFile(a.file.path, a.file.text).catch(() => {});
        const term = terms.get(`${card.wi}:${a.ti ?? 0}`) ?? [...terms.entries()].find(([k]) => k.startsWith(`${card.wi}:`))?.[1];
        term?.injectInput(a.line.endsWith('\r') ? a.line : a.line + '\r');
      }
    })();
  };

  for (const card of cards) {
    const row = el('div', 'sd-last-card');
    row.dataset.kind = card.kind;
    row.dataset.title = card.title;
    row.dataset.status = card.status;
    if (card.detail) row.dataset.detail = card.detail;
    if (card.cmd) row.dataset.cmd = card.cmd;
    if (card.app) row.dataset.app = card.app;
    const main = el('div', 'sd-last-main');
    main.append(el('div', 'sd-last-title', card.title));
    const meta = [card.detail, card.status].filter(Boolean).join(' · ');
    if (meta) main.append(el('div', 'sd-last-meta', meta));
    const actions = el('div', 'sd-last-actions');
    for (const a of card.actions) {
      const b = el('button', 'sd-btn', LABELS[a.act]) as HTMLButtonElement;
      b.type = 'button';
      b.dataset.act = a.act;
      b.addEventListener('click', () => { job = go(card, a); (root as { __job?: Promise<void> }).__job = job; });
      actions.append(b);
    }
    row.append(main, actions);
    list.append(row);
  }

  const wa = wm.workArea();
  const width = Math.min(560, Math.max(320, wa.width - 48));
  const height = Math.min(52 + 46 * cards.length + 28, Math.max(160, wa.height - 80));
  return wm.createWindow({
    appId: 'last-session', title: 'Last session', width, height,
    x: Math.max(12, wa.width - width - 28), y: 24,
    content: { kind: 'dom', element: root },
  });
}
