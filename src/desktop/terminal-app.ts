/**
 * Terminal windows: the real Shiro terminal (ShiroTerminal + Shell, each with
 * its own pty) in desktop windows, with tabs. The page's main terminal
 * (`window.__tabcomputer.terminal`) lives in the first window; closing it parks the
 * terminal instead of destroying it, and the next Terminal window adopts it.
 */

import type { Shell } from '../shell';
import { ShiroTerminal } from '../terminal';
import { setActiveTerminal } from '../active-terminal';
import type { DesktopWindow, WindowManager } from './wm';
import { GLYPHS } from './icons';
import { activeProfile } from '../profile';
import * as agentResume from '../agent-resume';
import type { ResumeCommand } from '../agent-resume';
import { bufferToString } from '../utils/copy-utils';
import { dropNotes } from './restore-note';

export interface TerminalDeps {
  makeShell: () => Shell;
  /** Shell of the main terminal (its tab title follows this shell's cwd) */
  mainShell: Shell;
}

/** A terminal tab as session restore saves it (session.ts) */
export interface TabState {
  /** The page's main terminal */
  main?: boolean;
  active?: boolean;
  cwd: string;
  /** Exported variables that differ from a fresh shell's (null: unset) */
  env?: Record<string, string | null>;
  /** A program's OSC title */
  osc?: string;
  /** The line still running at the reload */
  running?: string;
  /** Claude Code or Codex running in it: how to resume that session (agent-resume.ts) */
  agent?: ResumeCommand | null;
  /** Its scrollback (stored apart, session-store.ts) */
  screen?: string;
}

/** Lines of scrollback a tab keeps across a reload */
export const SCROLLBACK_LINES = 2000;
/** Variables never written to storage */
const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY$|CREDENTIAL|COOKIE/i;
/** Variables the shell keeps itself */
const VOLATILE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'COLUMNS', 'LINES', 'RANDOM', 'SECONDS', 'LINENO']);

export function envDiff(env: Record<string, string>, base: Record<string, string>): Record<string, string | null> | undefined {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(env)) if (!VOLATILE.has(k) && !SECRET.test(k) && base[k] !== v) out[k] = v;
  for (const k of Object.keys(base)) if (!(k in env) && !VOLATILE.has(k) && !SECRET.test(k)) out[k] = null;
  return Object.keys(out).length ? out : undefined;
}

/** The text a tab shows, its last `n` lines, without the prompt line at the bottom when nothing runs */
export function screenText(text: string, atPrompt: boolean, n = SCROLLBACK_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  if (atPrompt) lines.pop();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  // (the notes of earlier reloads go: the next restore prints one anew, under everything)
  return dropNotes(lines).slice(-n).join('\n');
}

interface Tab {
  pane: HTMLElement;
  tabEl: HTMLButtonElement;
  term: ShiroTerminal | null;
  shell: Shell | null;
  main: boolean;
  /** Title a program set with OSC 0/2, if any */
  osc: string;
  /** Output since the last save (session restore) */
  dirty?: boolean;
}

const DARK = {
  background: '#14151d', foreground: '#e3e5ee', cursor: '#7ef0c1', cursorAccent: '#14151d',
  selectionBackground: 'rgba(126, 140, 255, .35)',
  black: '#1c1d27', red: '#ff6b7a', green: '#5ee08f', yellow: '#ffd76a', blue: '#7aa7ff', magenta: '#d38bff', cyan: '#5fe0e6', white: '#d8dae4',
  brightBlack: '#5b5f75', brightRed: '#ff8e9a', brightGreen: '#83f0ab', brightYellow: '#ffe594', brightBlue: '#9fc0ff', brightMagenta: '#e3adff', brightCyan: '#8cecf0', brightWhite: '#ffffff',
};
const LIGHT = {
  background: '#fbfbfd', foreground: '#1e1f2a', cursor: '#5b57f0', cursorAccent: '#fbfbfd',
  selectionBackground: 'rgba(91, 87, 240, .22)',
  black: '#1e1f2a', red: '#d0283f', green: '#14853b', yellow: '#9a6700', blue: '#2f5fe0', magenta: '#9a3bc7', cyan: '#0c7f8f', white: '#6c7083',
  brightBlack: '#8a8ea0', brightRed: '#e5485d', brightGreen: '#1f9d4b', brightYellow: '#b57d00', brightBlue: '#4a7af5', brightMagenta: '#b158dd', brightCyan: '#1593a6', brightWhite: '#2b2c38',
};

export function terminalTheme(theme: 'light' | 'dark') {
  return theme === 'light' ? LIGHT : DARK;
}

// Web font + generic only: each missing family costs a blocking font lookup in xterm's first measure
const MONO = '"JetBrains Mono", monospace';

/** Live views, for theming and for adopting the parked main terminal */
const views = new Set<TerminalView>();
let parking: HTMLElement | null = null;
/** The main terminal's pane while no window shows it */
let parkedMain: { pane: HTMLElement; term: ShiroTerminal | null } | null = null;

export class TerminalView {
  readonly root: HTMLElement;
  private tabsEl: HTMLElement;
  private stack: HTMLElement;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  /** Title to show instead of user@host: cwd (a program's window: "Vim") */
  fixedTitle = '';

  constructor(private win: DesktopWindow, private wm: WindowManager, private deps: TerminalDeps, body: HTMLElement) {
    views.add(this);
    this.root = document.createElement('div');
    this.root.className = 'sd-term';
    this.tabsEl = document.createElement('div');
    this.tabsEl.className = 'sd-tabs';
    this.stack = document.createElement('div');
    this.stack.className = 'sd-term-stack';
    this.root.append(this.tabsEl, this.stack);
    body.appendChild(this.root);
    if (win.titlebarExtra) {
      const plus = document.createElement('button');
      plus.className = 'sd-tb-btn';
      plus.title = 'New Tab (Alt+Shift+T)';
      plus.setAttribute('aria-label', 'New tab');
      plus.innerHTML = GLYPHS.plus;
      plus.addEventListener('click', () => this.newTab());
      win.titlebarExtra.appendChild(plus);
    }
    win.on('focus', () => this.active?.term?.term.focus());
    win.on('close', () => this.dispose());
  }

  /** Put the page's main terminal element in this view (before or after its ShiroTerminal exists). */
  adoptMain(pane: HTMLElement, term: ShiroTerminal | null): Tab {
    pane.classList.add('sd-term-pane');
    const tab = this.addTab(pane, term, term ? null : this.deps.mainShell, true);
    if (term) this.wireTerm(tab, term);
    return tab;
  }

  /** The main tab's terminal was created after adoptMain */
  attachMain(term: ShiroTerminal): void {
    const tab = this.tabs.find(t => t.main);
    if (!tab) return;
    tab.term = term;
    this.wireTerm(tab, term);
  }

  /** `env`: variables for this tab's shell (a run link's RUN_*: set here, never typed) */
  newTab(opts: { command?: string; cwd?: string; env?: Record<string, string> } = {}): void {
    const pane = document.createElement('div');
    pane.className = 'sd-term-pane';
    const shell = this.deps.makeShell();
    if (opts.cwd) shell.cwd = opts.cwd;
    if (opts.env) Object.assign(shell.env, opts.env);
    const tab = this.addTab(pane, null, shell, false);
    this.select(tab);
    const term = new ShiroTerminal(pane, shell);
    shell.setTerminal(term);
    tab.term = term;
    this.wireTerm(tab, term);
    term.startPane();
    if (opts.command) term.injectInput(opts.command + '\r');
    term.term.focus();
  }

  private addTab(pane: HTMLElement, term: ShiroTerminal | null, shell: Shell | null, main: boolean): Tab {
    const tabEl = document.createElement('button');
    tabEl.className = 'sd-tab';
    tabEl.type = 'button';
    tabEl.innerHTML = `<span class="sd-tab-title"></span><span class="sd-tab-x" role="button" aria-label="Close tab">${GLYPHS.x}</span>`;
    const tab: Tab = { pane, tabEl, term, shell: shell ?? this.deps.mainShell, main, osc: '' };
    tabEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sd-tab-x')) { this.closeTab(tab); return; }
      this.select(tab);
    });
    this.tabsEl.appendChild(tabEl);
    this.stack.appendChild(pane);
    this.tabs.push(tab);
    this.root.classList.toggle('sd-has-tabs', this.tabs.length > 1);
    if (!this.active) this.select(tab); else pane.hidden = true;
    this.updateTitle(tab);
    return tab;
  }

  private wireTerm(tab: Tab, term: ShiroTerminal): void {
    term.onExit = () => this.closeTab(tab);
    term.term.onTitleChange((t: string) => { tab.osc = t; this.updateTitle(tab); });
    term.term.onWriteParsed(() => { tab.dirty = true; });
    // The prompt's cwd: refresh after each line the shell prints
    term.term.onLineFeed(() => this.updateTitle(tab));
    term.term.textarea?.addEventListener('focus', () => { if (this.active === tab) setActiveTerminal(term); });
  }

  select(tab: Tab): void {
    if (this.active === tab) return;
    this.active = tab;
    for (const t of this.tabs) {
      t.pane.hidden = t !== tab;
      t.tabEl.classList.toggle('sd-active', t === tab);
    }
    this.updateTitle(tab);
    if (tab.term) {
      setActiveTerminal(tab.term);
      requestAnimationFrame(() => { try { tab.term?.fitAddon.fit(); } catch {} tab.term?.term.focus(); });
    }
  }

  closeTab(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.tabEl.remove();
    if (tab.main) park(tab);
    else {
      try { tab.shell?.abortController?.abort(); } catch {}
      tab.pane.remove();
      tab.term?.dispose();
    }
    this.root.classList.toggle('sd-has-tabs', this.tabs.length > 1);
    if (!this.tabs.length) { this.active = null; this.win.close(true); return; }
    if (this.active === tab) { this.active = null; this.select(this.tabs[Math.min(i, this.tabs.length - 1)]); }
  }

  /** Window title: a program's OSC title, else user@host: cwd */
  private updateTitle(tab: Tab): void {
    const shell = tab.shell;
    let title = tab.osc || this.fixedTitle;
    if (!title && shell) {
      const home = shell.env['HOME'] || '/home/user';
      const cwd = shell.cwd;
      const shown = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
      title = `${shell.env['USER'] || 'user'}@${activeProfile().hostname}: ${shown}`;
    }
    const label = tab.tabEl.querySelector('.sd-tab-title');
    if (label && label.textContent !== title) label.textContent = title;
    if (this.active === tab) this.win.setTitle(title);
  }

  terminals(): ShiroTerminal[] {
    return this.tabs.map(t => t.term).filter((t): t is ShiroTerminal => !!t);
  }

  /** Any tab printed something since the last call (session restore saves then) */
  takeDirty(): boolean {
    let d = false;
    for (const t of this.tabs) if (t.dirty) { d = true; t.dirty = false; }
    return d;
  }

  /** The tabs as session restore saves them (`base`: a fresh shell's environment) */
  tabStates(base: Record<string, string>, withScreen: boolean): TabState[] {
    return this.tabs.map((t) => {
      const term = t.term;
      const running = term?.foregroundLine ?? undefined;
      const st: TabState = { cwd: t.shell?.cwd ?? '/home/user' };
      if (t.main) st.main = true;
      if (t === this.active) st.active = true;
      const env = t.shell ? envDiff(t.shell.env, base) : undefined;
      if (env) st.env = env;
      if (t.osc) st.osc = t.osc;
      if (running) st.running = running;
      const agent = term ? agentResume.forTerminal(term) : null;
      if (agent) st.agent = agent;
      if (withScreen && term) st.screen = screenText(bufferToString(term.term), !running);
      return st;
    });
  }

  /**
   * Bring saved tabs back into this view (session.ts): the main tab (already
   * here) or new tabs, each with its directory, environment and screen.
   * `reuseFirst`: a new window already made its first tab (in the first saved
   * tab's directory); the first saved tab goes there. `onReady(i, terminal)`
   * runs once tab i is back (the caller resumes an agent or offers a command).
   */
  restoreTabs(saved: TabState[], noteFor: (i: number) => string, onReady: (i: number, term: ShiroTerminal) => void, reuseFirst = false): void {
    let activeTab: Tab | null = null;
    saved.forEach((st, i) => {
      let tab: Tab | undefined;
      if (st.main) tab = this.tabs.find((t) => t.main);
      else if (i === 0 && reuseFirst && this.tabs.length === 1 && !this.tabs[0].main) tab = this.tabs[0];
      else {
        this.newTab({ cwd: st.cwd });
        tab = this.tabs[this.tabs.length - 1];
      }
      if (!tab) return;
      const shell = tab.shell;
      if (shell) {
        if (st.cwd) shell.cwd = st.cwd;
        for (const [k, v] of Object.entries(st.env ?? {})) { if (v === null) delete shell.env[k]; else shell.env[k] = v; }
      }
      if (st.osc) tab.osc = st.osc;
      const term = tab.term;
      if (term) {
        term.restoreScreen(st.screen ?? '', noteFor(i));
        onReady(i, term);
      }
      this.updateTitle(tab);
      if (st.active) activeTab = tab;
    });
    if (activeTab) this.select(activeTab);
  }

  /** Working directory of the active tab's shell (session restore) */
  cwd(): string | undefined {
    return this.active?.shell?.cwd;
  }

  activeTerminal(): ShiroTerminal | null {
    return this.active?.term ?? null;
  }

  private dispose(): void {
    views.delete(this);
    for (const tab of [...this.tabs]) {
      if (tab.main) park(tab);
      else { try { tab.shell?.abortController?.abort(); } catch {} tab.term?.dispose(); }
    }
    this.tabs = [];
  }
}

function park(tab: Tab): void {
  if (!parking) {
    parking = document.createElement('div');
    parking.id = 'sd-parking';
    document.body.appendChild(parking);
  }
  parking.appendChild(tab.pane);
  tab.pane.hidden = false;
  parkedMain = { pane: tab.pane, term: tab.term };
}

export function hasParkedMain(): boolean {
  return !!parkedMain;
}

/** Take the parked main terminal, if it's waiting for a window. */
export function takeParkedMain(): { pane: HTMLElement; term: ShiroTerminal | null } | null {
  const p = parkedMain;
  parkedMain = null;
  return p;
}

export function allTerminalViews(): TerminalView[] {
  return [...views];
}

/** Restyle every desktop terminal for the theme. */
export function applyTerminalTheme(theme: 'light' | 'dark', extra: ShiroTerminal[] = []): void {
  const t = terminalTheme(theme);
  const seen = new Set<ShiroTerminal>();
  for (const v of views) for (const term of v.terminals()) seen.add(term);
  for (const term of extra) seen.add(term);
  for (const term of seen) term.term.options.theme = t;
}

/** Use the bundled mono font once it has loaded (xterm measures glyphs when the family changes). */
export function useMonoFont(terms: () => ShiroTerminal[]): Promise<void> {
  const apply = () => {
    for (const t of terms()) {
      // xterm re-measures only when the family string changes
      t.term.options.fontFamily = t.term.options.fontFamily === MONO ? MONO + ', monospace' : MONO;
      try { t.fitAddon.fit(); } catch {}
    }
  };
  if (!document.fonts?.load) { apply(); return Promise.resolve(); }
  return document.fonts.load('14px "JetBrains Mono"').then(apply, apply);
}

export { MONO as TERMINAL_FONT };
