/**
 * The Remote window: one tab per `remote start`, named with the code's id
 * (`pro-slug-sunedayo`). The page is what the outside agent does. The line
 * at the bottom is a message back to that agent.
 *
 * The desktop app mounts this into a window. With no desktop (the terminal
 * UI) the same view sits in a small frame. State lives here, so closing the
 * window does not drop the transcript.
 */

export type LogType = 'exec' | 'read' | 'write' | 'eval' | 'info' | 'error' | 'user' | 'out' | 'agent';
export type RemoteStatus = 'connected' | 'disconnected' | 'connecting' | 'waiting';

export interface RemotePanel {
  element: HTMLDivElement;
  log(type: LogType, message: string): void;
  setTitle(title: string): void;
  close(): void;
  minimize(): void;
  deactivate(): void;
  setStatus(status: RemoteStatus): void;
  /** A line under the tab: "WebRTC", "HTTPS relay". */
  setDetail?(text: string): void;
  /** Copies the connection code. The secret is not drawn. */
  setCopy?(fn: () => string): void;
  focus?(): void;
  onUserMessage?: (message: string) => void;
  /** The tab's ×. The panel does not remove itself until `close`. */
  onClose?: () => void;
}

const KIND: Record<LogType, string> = {
  exec: 'run',
  read: 'read',
  write: 'write',
  eval: 'eval',
  info: 'note',
  error: 'err',
  user: 'you',
  out: 'out',
  agent: 'agent',
};

/** 12×12 line icons, one stroke. */
const GLYPH: Record<LogType, string> = {
  exec: 'M3 3.5l5 4.5-5 4.5',
  read: 'M3 2.5h4l2 2V11.5H3zM7 2.5v2h2',
  write: 'M2.5 9.5l6.5-6.5 1.5 1.5-6.5 6.5H2.5z',
  eval: 'M4 3.5L1.5 6 4 8.5M8 3.5L10.5 6 8 8.5',
  info: 'M6 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM6 5.2v2.6M6 4h.01',
  error: 'M3 3l6 6M9 3L3 9',
  user: 'M8 3H3.5v6H8M6 6h4.5',
  out: 'M3 8.5V4.5h5M5 6.5l3-2',
  agent: 'M4 3H8.5v6H4M6 6H1.5',
};

interface Tab {
  id: string;
  title: string;
  status: RemoteStatus;
  peer: string;
  detail: string;
  dead: boolean;
  copy: (() => string) | null;
  rows: { type: LogType; message: string; time: string }[];
  draft: string;
  panel: RemotePanel;
}

const tabs: Tab[] = [];
let selected = '';
let host: HTMLElement | null = null;
let floatEl: HTMLElement | null = null;
let onNew: (() => void) | null = null;
const MAX_ROWS = 400;

export function setRemoteDeskActions(actions: { onNew?: () => void }): void {
  if (actions.onNew) onNew = actions.onNew;
}

export function mountRemoteDesk(el: HTMLElement): void {
  ensureStyle();
  if (floatEl && el !== floatEl.querySelector('.rd')) {
    floatEl.remove();
    floatEl = null;
  }
  host = el;
  el.classList.add('rd');
  render();
}

/** Open the desktop window when the desktop is up, otherwise the frame. */
export function presentRemoteDesk(): void {
  ensureStyle();
  if (host?.isConnected) {
    render();
    return;
  }
  const desktop = (window as any).__tabcomputer?.desktop;
  if (desktop?.openApp) {
    void desktop.openApp('remote');
    return;
  }
  showFloat();
}

export function createRemotePanel(sessionId: string, sessionName: string): RemotePanel {
  ensureStyle();
  const existing = tabs.find((t) => t.id === sessionId);
  if (existing) {
    selected = existing.id;
    presentRemoteDesk();
    render();
    return existing.panel;
  }
  const tab = {} as Tab;
  const panel: RemotePanel = {
    element: document.createElement('div'),
    log(type, message) {
      if (tab.dead) return;
      const time = new Date();
      const hh = String(time.getHours()).padStart(2, '0');
      const mm = String(time.getMinutes()).padStart(2, '0');
      const ss = String(time.getSeconds()).padStart(2, '0');
      tab.rows.push({ type, message: message.length > 4000 ? message.slice(0, 4000) + '…' : message, time: `${hh}:${mm}:${ss}` });
      if (tab.rows.length > MAX_ROWS) tab.rows.splice(0, tab.rows.length - MAX_ROWS);
      if (selected === tab.id) appendRow(tab.rows[tab.rows.length - 1]);
      else renderTabs();
    },
    setTitle(title) {
      const parts = title.split('\u2194');
      tab.peer = (parts.length > 1 ? parts[0] : title).trim();
      if (selected === tab.id) renderStatus();
    },
    setDetail(text) {
      tab.detail = text;
      if (selected === tab.id) renderStatus();
    },
    setCopy(fn) { tab.copy = fn; if (selected === tab.id) renderStatus(); },
    setStatus(status) {
      tab.status = status;
      renderTabs();
      if (selected === tab.id) renderStatus();
    },
    focus() { selected = tab.id; render(); },
    close() { dropTab(tab.id); },
    minimize() { floatEl?.classList.toggle('rd-float-min'); },
    deactivate() {
      tab.dead = true;
      tab.status = 'disconnected';
      panel.onUserMessage = undefined;
      render();
    },
  };
  Object.assign(tab, {
    id: sessionId,
    title: sessionName,
    status: 'connecting' as RemoteStatus,
    peer: '',
    detail: '',
    dead: false,
    copy: null,
    rows: [],
    draft: '',
    panel,
  });
  tabs.push(tab);
  selected = tab.id;
  presentRemoteDesk();
  render();
  return panel;
}

export function findRemotePanel(sessionId: string): RemotePanel | null {
  return tabs.find((t) => t.id === sessionId)?.panel ?? null;
}

export function closeRemotePanel(sessionId: string): void {
  tabs.find((t) => t.id === sessionId)?.panel.close();
}

function dropTab(id: string): void {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (selected === id) selected = tabs[Math.min(i, tabs.length - 1)]?.id ?? '';
  render();
}

function current(): Tab | undefined {
  return tabs.find((t) => t.id === selected) ?? tabs[tabs.length - 1];
}

function showFloat(): void {
  if (floatEl?.isConnected) {
    host = floatEl.querySelector('.rd');
    render();
    return;
  }
  floatEl = document.createElement('div');
  floatEl.className = 'rd-float';
  floatEl.innerHTML = `<div class="rd-float-bar"><span>Remote</span><button type="button" class="rd-x" data-act="hide" aria-label="Hide">×</button></div><div class="rd"></div>`;
  document.body.appendChild(floatEl);
  floatEl.querySelector('[data-act="hide"]')!.addEventListener('click', () => { floatEl?.remove(); floatEl = null; host = null; });
  let drag = false, ox = 0, oy = 0, sl = 0, st = 0;
  const bar = floatEl.querySelector('.rd-float-bar') as HTMLElement;
  bar.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag = true;
    ox = e.clientX; oy = e.clientY;
    const r = floatEl!.getBoundingClientRect();
    sl = r.left; st = r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag || !floatEl) return;
    floatEl.style.left = sl + e.clientX - ox + 'px';
    floatEl.style.top = st + e.clientY - oy + 'px';
    floatEl.style.right = 'auto';
    floatEl.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', () => { drag = false; });
  host = floatEl.querySelector('.rd');
  render();
}

function render(): void {
  if (!host) return;
  const tab = current();
  host.innerHTML = `
    <div class="rd-tabs" role="tablist">
      ${tabs.map((t) => tabButton(t, t === tab)).join('')}
      <button type="button" class="rd-new" data-act="new">New</button>
    </div>
    ${tab ? statusHTML(tab) : ''}
    <div class="rd-log" role="log">${tab ? (tab.rows.length ? '' : emptySession()) : emptyDesk()}</div>
    <form class="rd-compose">
      <span class="rd-prompt" aria-hidden="true">›</span>
      <input class="rd-input" placeholder="${tab && !tab.dead ? 'Message the agent' : tab ? 'This connection is closed' : 'No remote yet'}" ${tab && !tab.dead ? '' : 'disabled'} />
      <button type="submit" class="rd-send" ${tab && !tab.dead ? '' : 'disabled'}>Send</button>
    </form>`;
  const log = host.querySelector('.rd-log') as HTMLElement;
  if (tab) for (const row of tab.rows) log.appendChild(rowEl(row));
  stick(log);
  const input = host.querySelector('.rd-input') as HTMLInputElement;
  if (tab) input.value = tab.draft;
  host.querySelector('[data-act="new"]')!.addEventListener('click', () => onNew?.());
  host.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-act="x"]')) return;
      selected = el.dataset.tab!;
      render();
    });
  });
  host.querySelectorAll<HTMLElement>('[data-act="x"]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id!;
      const t = tabs.find((x) => x.id === id);
      t?.panel.onClose?.();
      dropTab(id);
    });
  });
  host.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
    const text = tab?.copy?.();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); } catch { /* the button stays */ }
    const b = host!.querySelector('[data-act="copy"]');
    if (b) b.textContent = 'Copied';
  });
  input.addEventListener('input', () => { if (tab) tab.draft = input.value; });
  host.querySelector('.rd-compose')!.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!tab || tab.dead) return;
    const text = input.value.trim();
    if (!text || !tab.panel.onUserMessage) return;
    tab.panel.onUserMessage(text);
    tab.draft = '';
    input.value = '';
  });
}

function renderTabs(): void {
  /* A full render keeps the one structure. Cheap at this size. */
  const input = host?.querySelector('.rd-input') as HTMLInputElement | null;
  const tab = current();
  if (tab && input) tab.draft = input.value;
  render();
}

function renderStatus(): void {
  renderTabs();
}

function tabButton(t: Tab, on: boolean): string {
  return `<div class="rd-tab${on ? ' is-on' : ''}${t.dead ? ' is-off' : ''}" data-tab="${esc(t.id)}" role="tab" aria-selected="${on}">
    <i class="rd-mark" data-s="${t.status}"></i>
    <span class="rd-name">${esc(t.title)}</span>
    <button type="button" class="rd-x" data-act="x" data-id="${esc(t.id)}" aria-label="Close ${esc(t.title)}">×</button>
  </div>`;
}

function statusHTML(t: Tab): string {
  const word = t.status === 'connected' ? 'connected' : t.status === 'waiting' ? 'waiting' : t.status === 'connecting' ? 'starting' : 'closed';
  const bits = [chip(word, t.status), t.detail ? chip(t.detail, '') : '', t.peer ? chip(t.peer, '') : ''].filter(Boolean).join('');
  const copy = t.copy ? `<button type="button" class="rd-chip rd-copy" data-act="copy">Copy code</button>` : '';
  return `<div class="rd-status">${bits}<span class="rd-grow"></span>${copy}</div>`;
}

function chip(text: string, status: string): string {
  return `<span class="rd-chip"${status ? ` data-s="${status}"` : ''}>${esc(text)}</span>`;
}

function emptyDesk(): string {
  return `<div class="rd-empty">${art()}<p>No agent is connected.</p><p class="rd-dim">New remote starts a named line. An outside agent joins with the code, and everything it runs shows up here.</p></div>`;
}

function emptySession(): string {
  return `<div class="rd-empty">${art()}<p>Waiting for the agent.</p><p class="rd-dim">Commands, reads, writes and evals land in this page. The line below sends a message back.</p></div>`;
}

function art(): string {
  return `<svg class="rd-art" viewBox="0 0 120 64" aria-hidden="true">
    <defs>
      <pattern id="rd-dither" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="1" height="1" fill="currentColor"/></pattern>
    </defs>
    <rect x="6" y="10" width="40" height="44" fill="url(#rd-dither)" opacity="0.35"/>
    <rect x="6" y="10" width="40" height="44"/>
    <path d="M6 18h40M12 26h16M12 32h12"/>
    <rect x="74" y="10" width="40" height="44" fill="url(#rd-dither)" opacity="0.18"/>
    <rect x="74" y="10" width="40" height="44"/>
    <circle cx="94" cy="30" r="6"/>
    <path d="M91 30h6M94 27v6"/>
    <path d="M46 32h28" stroke-dasharray="2 2"/>
  </svg>`;
}

function appendRow(row: { type: LogType; message: string; time: string }): void {
  const log = host?.querySelector('.rd-log');
  if (!log) return;
  log.querySelector('.rd-empty')?.remove();
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.appendChild(rowEl(row));
  if (near) stick(log);
}

function rowEl(row: { type: LogType; message: string; time: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rd-row';
  el.dataset.kind = row.type;
  el.innerHTML = `<span class="rd-time">${esc(row.time)}</span><span class="rd-kind" title="${esc(KIND[row.type])}">${glyph(row.type)}<span>${KIND[row.type]}</span></span><pre class="rd-msg"></pre>`;
  el.querySelector('.rd-msg')!.textContent = row.message;
  return el;
}

function glyph(type: LogType): string {
  return `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${GLYPH[type]}"/></svg>`;
}

function stick(log: Element): void {
  log.scrollTop = log.scrollHeight;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let styled = false;
function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.textContent = RD_CSS;
  document.head.appendChild(s);
}

const RD_CSS = `
.rd, .rd-float {
  --rd-bg: var(--sd-window, #1b1d29);
  --rd-bar: var(--sd-window-bar, #232636);
  --rd-text: var(--sd-text, #ecedf3);
  --rd-dim: var(--sd-text-2, #a4a8b8);
  --rd-faint: var(--sd-text-3, #737789);
  --rd-line: var(--sd-sep, rgba(255,255,255,.08));
  --rd-field: var(--sd-field, rgba(255,255,255,.06));
  --rd-hover: var(--sd-hover, rgba(255,255,255,.08));
  --rd-accent: var(--sd-accent, #6e6aff);
  --rd-green: var(--sd-green, #28c840);
  --rd-yellow: var(--sd-yellow, #febc2e);
  --rd-red: var(--sd-red, #ff5f57);
  color: var(--rd-text);
  font-family: var(--sd-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  letter-spacing: 0;
}
.rd { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; background: var(--rd-bg); }
.rd-float { position: fixed; right: 24px; bottom: 24px; width: min(640px, calc(100vw - 32px)); height: min(460px, calc(100vh - 80px)); z-index: 80; display: flex; flex-direction: column; background: var(--rd-bg); border: 1px solid var(--rd-line); box-shadow: var(--sd-shadow, 0 18px 50px rgba(0,0,0,.35)); }
.rd-float .rd { position: relative; flex: 1; }
.rd-float-min { height: 32px; }
.rd-float-min .rd { display: none; }
.rd-float-bar { height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 10px; border-bottom: 1px solid var(--rd-line); cursor: grab; color: var(--rd-dim); font-family: var(--sd-font, 'Inter', sans-serif); font-size: 12px; }
.rd-float-bar span { flex: 1; }
.rd-tabs { flex: 0 0 auto; display: flex; align-items: stretch; gap: 0; overflow-x: auto; border-bottom: 1px solid var(--rd-line); background: var(--rd-bar); }
.rd-tab { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; max-width: 240px; height: 32px; padding: 0 8px 0 10px; border: 0; border-right: 1px solid var(--rd-line); background: transparent; color: var(--rd-dim); font: inherit; cursor: default; }
.rd-tab.is-on { color: var(--rd-text); background: var(--rd-bg); box-shadow: inset 0 -1px 0 var(--rd-accent); }
.rd-tab.is-off { color: var(--rd-faint); }
.rd-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rd-mark { width: 6px; height: 6px; border-radius: 50%; border: 1px solid var(--rd-faint); flex: 0 0 auto; }
.rd-mark[data-s="connected"] { background: var(--rd-green); border-color: var(--rd-green); }
.rd-mark[data-s="waiting"], .rd-mark[data-s="connecting"] { background: var(--rd-yellow); border-color: var(--rd-yellow); }
.rd-mark[data-s="disconnected"] { background: transparent; }
.rd-x { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--rd-faint); font: inherit; font-size: 13px; line-height: 1; cursor: default; }
.rd-tab .rd-x:hover, .rd-float-bar .rd-x:hover { background: var(--rd-hover); color: var(--rd-text); }
.rd-new { flex: 0 0 auto; margin: 4px; padding: 0 10px; height: 24px; border: 1px solid var(--rd-line); background: transparent; color: var(--rd-text); font: inherit; cursor: default; }
.rd-new:hover { background: var(--rd-hover); }
.rd-status { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 10px; border-bottom: 1px solid var(--rd-line); }
.rd-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border: 1px solid var(--rd-line); color: var(--rd-dim); }
.rd-chip[data-s="connected"] { color: var(--rd-text); }
.rd-copy { background: transparent; font: inherit; cursor: default; color: var(--rd-text); }
.rd-copy:hover { background: var(--rd-hover); }
.rd-grow { flex: 1; }
.rd-log { flex: 1; min-height: 0; overflow: auto; background-image: repeating-linear-gradient(180deg, transparent 0 3px, color-mix(in srgb, var(--rd-text) 5%, transparent) 3px 4px); }
.rd-log:has(.rd-empty) { display: flex; align-items: center; justify-content: center; }
.rd-row { display: grid; grid-template-columns: 64px 64px minmax(0, 1fr); gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--rd-line); }
.rd-row[data-kind="error"] { box-shadow: inset 2px 0 0 var(--rd-red); }
.rd-row[data-kind="user"], .rd-row[data-kind="agent"] { box-shadow: inset 2px 0 0 var(--rd-accent); }
.rd-row[data-kind="exec"] { box-shadow: inset 2px 0 0 var(--rd-green); }
.rd-time { color: var(--rd-faint); font-variant-numeric: tabular-nums; }
.rd-kind { display: inline-flex; align-items: center; gap: 4px; color: var(--rd-dim); }
.rd-kind svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 1; }
.rd-msg { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
.rd-compose { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--rd-line); background: var(--rd-bar); }
.rd-prompt { color: var(--rd-accent); }
.rd-input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--rd-line); background: var(--rd-bg); color: var(--rd-text); font: inherit; }
.rd-input:focus { outline: 1px solid var(--rd-accent); outline-offset: 0; }
.rd-input:disabled { color: var(--rd-faint); }
.rd-send { height: 28px; padding: 0 12px; border: 1px solid var(--rd-line); background: transparent; color: var(--rd-text); font: inherit; cursor: default; }
.rd-send:hover:not(:disabled) { background: var(--rd-hover); }
.rd-send:disabled { color: var(--rd-faint); }
.rd-empty { max-width: 360px; margin: 0; padding: 16px; text-align: center; }
.rd-empty p { margin: 8px 0; }
.rd-dim { color: var(--rd-dim); }
.rd-art { width: 120px; height: 64px; margin-bottom: 8px; stroke: currentColor; fill: none; stroke-width: 1; color: var(--rd-dim); }
`;
