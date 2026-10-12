/**
 * Browser: a browser shell on the host browser's own engine (docs/BROWSER.md).
 * Tabs are iframes on per-site browse origins; the broker (src/browser/broker.ts)
 * does their networking with TLS in the page over the TCP relay.
 */
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { OriginMap } from '../../browser/origin-map';
import { CookieJar, type Cookie } from '../../browser/cookies';
import { Broker, type BrokerTab } from '../../browser/broker';
import { setTrustRoots } from '../../browser/tls';
import { kvGet, kvSet } from '../../browser/kv';
import { Vault, renderPasswords } from './browser-passwords';
import type { ByteStream } from '../../browser/http1';
import type { Dialer } from '../../browser/netfetch';
import { AF_INET, SOCK_STREAM, errnoName, netStack, netStackOf, type KSocket } from '../../kernel/net';
import type { Kernel } from '../../kernel/kernel';

interface HistoryEntry { url: string; title: string; t: number }

const STYLE = `
.sd-app.sd-br { flex-direction: row; }
.sd-br-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sd-br-win > .sd-titlebar { border-bottom: 0; padding-right: 6px; }
.sd-br-win > .sd-titlebar > .sd-title { display: none; }
.sd-br-win > .sd-titlebar > .sd-titlebar-extra { margin-left: 0; flex: 1; min-width: 0; align-self: stretch; align-items: stretch; }
.sd-br-head { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
.sd-br-head[data-tabs=horizontal] { align-items: flex-end; }
.sd-br-head[data-tabs=horizontal] > .sd-br-ibtn { align-self: center; }
.sd-br-ibtn { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; background: transparent; color: var(--sd-text-2); cursor: default; }
.sd-br-ibtn:hover:not(:disabled) { background: var(--sd-hover); color: var(--sd-text); }
.sd-br-ibtn:active:not(:disabled) { background: var(--sd-active); }
.sd-br-ibtn:disabled { opacity: .35; }
.sd-br-ibtn svg { width: 18px; height: 18px; fill: currentColor; }
.sd-br-ibtn.sd-on { color: var(--sd-accent); }
.sd-br-head .sd-br-ibtn.sd-sq { border-radius: 8px; }

/* The tab strip */
.sd-br-strip { display: flex; min-width: 0; }
.sd-br-tab { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--sd-text-2); font-size: 12px; cursor: default; container-type: inline-size; }
.sd-br-tab > * { position: relative; z-index: 1; }
.sd-br-tab > .sd-br-tab-bg { position: absolute; z-index: 0; inset: 0; border-radius: 8px; }
.sd-br-tab:hover > .sd-br-tab-bg { background: var(--sd-hover); }
.sd-br-tab.sd-active { color: var(--sd-text); }
.sd-br-fav { flex: 0 0 16px; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; color: var(--sd-text-2); }
.sd-br-fav svg { width: 16px; height: 16px; fill: currentColor; }
.sd-br-tab.sd-loading .sd-br-fav svg { display: none; }
.sd-br-tab.sd-loading .sd-br-fav::before { content: ''; width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--sd-accent); border-right-color: transparent; animation: sd-br-spin .8s linear infinite; }
@keyframes sd-br-spin { to { transform: rotate(360deg); } }
.sd-br-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent); }
.sd-br-x { flex: 0 0 16px; width: 16px; height: 16px; padding: 0; display: flex; align-items: center; justify-content: center; border: 0; border-radius: 50%; background: transparent; color: var(--sd-text-2); cursor: default; }
.sd-br-x svg { width: 12px; height: 12px; fill: currentColor; }
.sd-br-x:hover { background: var(--sd-active); color: var(--sd-text); }
.sd-br-strip > .sd-br-new { flex: 0 0 auto; }
.sd-br-tab.sd-dragging { z-index: 3; }
.sd-br-tab.sd-settling { transition: transform .15s ease; }

/* Horizontal: tabs in the title bar, beside the traffic lights */
/* flex: 1, since the tabs' container-type gives the strip no intrinsic width */
.sd-br-strip[data-tabs=horizontal] { flex: 1 1 0; align-self: flex-end; height: 32px; align-items: stretch; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; padding: 0 8px; }
.sd-br-strip[data-tabs=horizontal]::-webkit-scrollbar { display: none; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab { flex: 0 1 240px; min-width: 36px; padding: 0 8px 0 12px; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab::before { content: ''; position: absolute; left: 0; top: 9px; bottom: 7px; width: 1px; background: var(--sd-text-3); opacity: .5; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab:first-child::before,
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active::before, .sd-br-strip[data-tabs=horizontal] > .sd-active + .sd-br-tab::before,
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab:hover::before, .sd-br-strip[data-tabs=horizontal] > .sd-br-tab:hover + .sd-br-tab::before,
.sd-br-strip[data-tabs=horizontal] > .sd-dragging::before, .sd-br-strip[data-tabs=horizontal] > .sd-dragging + .sd-br-tab::before { opacity: 0; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab > .sd-br-tab-bg { inset: 4px 1px 4px; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active > .sd-br-tab-bg { inset: 0; border-radius: 10px 10px 0 0; background: var(--sd-window); }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active > .sd-br-tab-bg::before, .sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active > .sd-br-tab-bg::after { content: ''; position: absolute; bottom: 0; width: 10px; height: 10px; }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active > .sd-br-tab-bg::before { left: -10px; background: radial-gradient(circle at 0 0, transparent 9.5px, var(--sd-window) 10px); }
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab.sd-active > .sd-br-tab-bg::after { right: -10px; background: radial-gradient(circle at 100% 0, transparent 9.5px, var(--sd-window) 10px); }
.sd-br-strip[data-tabs=horizontal] > .sd-br-new { align-self: center; margin: 0 0 0 6px; }
@container (max-width: 72px) {
  .sd-br-title { display: none; }
  .sd-br-tab:not(.sd-active) .sd-br-x { display: none; }
  .sd-br-tab.sd-active .sd-br-fav { display: none; }
}
.sd-br-strip[data-tabs=horizontal] > .sd-br-tab { justify-content: center; }

/* Vertical: a tab sidebar; the toolbar moves up beside the traffic lights */
.sd-br-side { flex: 0 0 auto; width: var(--sd-br-side, 220px); position: relative; display: flex; flex-direction: column; overflow: hidden auto; padding: 2px 8px 8px; background: var(--sd-window-bar-blur); }
.sd-focused .sd-br-side { background: var(--sd-window-bar); }
.sd-br[data-tabs=horizontal] > .sd-br-side { display: none; }
.sd-br-strip[data-tabs=vertical] { flex-direction: column; gap: 2px; }
.sd-br-strip[data-tabs=vertical] > .sd-br-tab { flex: 0 0 30px; padding: 0 7px 0 9px; }
.sd-br-strip[data-tabs=vertical] > .sd-br-tab .sd-br-x { visibility: hidden; }
.sd-br-strip[data-tabs=vertical] > .sd-br-tab:hover .sd-br-x, .sd-br-strip[data-tabs=vertical] > .sd-br-tab.sd-active .sd-br-x { visibility: visible; }
.sd-br-strip[data-tabs=vertical] > .sd-br-tab.sd-active > .sd-br-tab-bg { background: var(--sd-active); }
.sd-desktop[data-theme='light'] .sd-br-strip[data-tabs=vertical] > .sd-br-tab.sd-active > .sd-br-tab-bg { background: var(--sd-window); box-shadow: 0 0 0 .5px var(--sd-window-border), 0 1px 2px rgba(0, 0, 0, .06); }
.sd-br-strip[data-tabs=vertical] > .sd-br-new { width: auto; height: 28px; margin-top: 6px; border-radius: 8px; background: var(--sd-field); }
.sd-br-strip[data-tabs=vertical] > .sd-br-new:hover { background: var(--sd-hover); }
.sd-br-side.sd-collapsed { width: 48px; padding-left: 6px; padding-right: 6px; }
.sd-br-side.sd-collapsed .sd-br-tab { justify-content: center; padding: 0; }
.sd-br-side.sd-collapsed .sd-br-title, .sd-br-side.sd-collapsed .sd-br-x { display: none; }
.sd-br-grip { position: absolute; top: 0; right: 0; bottom: 0; width: 5px; cursor: ew-resize; }
.sd-br-side.sd-collapsed .sd-br-grip { display: none; }
.sd-br-headside { flex: 0 0 auto; display: flex; gap: 2px; align-items: center; justify-content: flex-end; width: calc(var(--sd-br-side, 220px) - 82px); min-width: 0; }
.sd-br-headside.sd-collapsed { width: auto; }

/* The toolbar */
.sd-br-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; min-width: 0; }
.sd-br-head .sd-br-toolbar { flex: 1; padding: 0 0 0 8px; }
.sd-br-col > .sd-br-toolbar { height: 40px; padding: 0 8px; background: var(--sd-window); border-bottom: 1px solid var(--sd-sep); }
.sd-br-addr { flex: 1; min-width: 0; height: 30px; margin: 0 4px; padding: 0 14px; border-radius: 15px; border: 0; background: var(--sd-field); color: var(--sd-text); font: 13px var(--sd-font); outline: none; user-select: text; -webkit-user-select: text; }
.sd-br-col > .sd-br-toolbar .sd-br-addr { background: var(--sd-window-bar); }
.sd-br-addr:hover { background: var(--sd-hover); }
.sd-br-addr:focus { background: var(--sd-window); box-shadow: 0 0 0 2px var(--sd-accent); }
.sd-br-addr::placeholder { color: var(--sd-text-3); }

.sd-br-banner { display: none; align-items: center; gap: 10px; padding: 8px 12px; background: color-mix(in srgb, #f5b400 22%, var(--sd-window)); border-bottom: 1px solid var(--sd-sep); font-size: 13px; }
.sd-br-banner.sd-on { display: flex; }
.sd-br-banner span { flex: 1; }
.sd-br-view { position: relative; flex: 1; min-height: 0; background: var(--sd-window); }
.sd-br-view iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; background: #fff; }
.sd-br-view iframe.sd-active { display: block; }
.sd-br-panel { position: absolute; inset: 0; overflow: auto; background: var(--sd-window); color: var(--sd-text); z-index: 2; display: none; }
.sd-br-panel.sd-on { display: block; }
.sd-br-panel a { color: var(--sd-accent); }
.sd-br-status { flex: 0 0 auto; font-size: 11px; color: var(--sd-text-3); padding: 2px 10px; border-top: 1px solid var(--sd-sep); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--sd-window); }
`;

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  back: svg('M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z'),
  fwd: svg('M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z'),
  reload: svg('M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z'),
  star: svg('M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z'),
  starred: svg('M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z'),
  more: svg('M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z'),
  key: svg('M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z'),
  plus: svg('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'),
  close: svg('M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'),
  chevron: svg('M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z'),
  search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
  sidebar: svg('M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h4V5H5zm6 0v14h8V5h-8z'),
  globe: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'),
};

/** Tab layout, shared by every browser window: vertical tabs by default, as asked for */
interface TabPrefs { vertical: boolean; width: number; collapsed: boolean }
const PREFS_KEY = 'tabcomputer.browser.tabs';
function loadPrefs(): TabPrefs {
  const d: TabPrefs = { vertical: true, width: 220, collapsed: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return d; }
}
function savePrefs(p: TabPrefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

const FALLBACK_TEXT: Record<string, string> = {
  webauthn: 'This site asked for a passkey. Passkeys belong to the site\'s real address, so they only work in the host browser.',
  'google-signin': 'Google sign-in refuses browsers it can\'t verify. Sign in from the host browser.',
  tls: 'This site only speaks TLS 1.2; this browser does TLS 1.3 only for now.',
  unproxyable: 'This address can\'t be shown here.',
  'no-service-worker': 'The host browser blocked this site\'s service worker (third-party storage blocked?).',
};

let shared: Promise<Engine> | null = null;

/** One broker, cookie jar and history for every Browser window. */
class Engine {
  broker!: Broker;
  map!: OriginMap;
  app = '';
  jar = new CookieJar();
  history: HistoryEntry[] = [];
  bookmarks: { url: string; title: string }[] = [];
  tabs = new Set<Tab>();
  error = '';
  vault = new Vault();
  transport: 'relay' | 'server' = 'relay';
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  static async create(kernel: Kernel): Promise<Engine> {
    const e = new Engine();
    let cfg: { origin: string | null; app?: string; serverFetch?: boolean } = { origin: null };
    try { cfg = await (await fetch('browse/config.json', { cache: 'no-store' })).json(); } catch { /* old server */ }
    if (!cfg.origin) { e.error = 'This server has no browse origins (TABCOMPUTER_BROWSE_ORIGIN), so pages can only open in real tabs.'; return e; }
    e.map = new OriginMap(cfg.origin);
    e.app = cfg.app || location.origin;
    e.jar = CookieJar.fromJSON(await kvGet<Record<string, Cookie[]>>('cookies').catch(() => undefined));
    e.jar.onChange = () => e.saveSoon();
    e.history = (await kvGet<HistoryEntry[]>('history').catch(() => undefined)) ?? [];
    e.bookmarks = (await kvGet<{ url: string; title: string }[]>('bookmarks').catch(() => undefined)) ?? [];
    await e.loadRoots();
    await e.vault.load();
    const stack = netStackOf(kernel) ?? netStack;
    // Local measurement only: the server offers its decrypting fetch only with TABCOMPUTER_BROWSE_SERVER_FETCH=1
    const serverFetch = cfg.serverFetch && (await kvGet<string>('transport').catch(() => undefined)) === 'server';
    const fetcher = serverFetch ? new (await import('../../browser/server-fetch')).ServerFetcher() : undefined;
    e.transport = serverFetch ? 'server' : 'relay';
    e.broker = new Broker({ map: e.map, app: e.app, dial: kernelDialer(stack), jar: e.jar, tabs: () => [...e.tabs], fetcher });
    e.broker.start();
    return e;
  }

  async loadRoots() {
    const extra = (await kvGet<string>('extraRoots').catch(() => undefined)) ?? '';
    setTrustRoots(async () => (await fetch('browse/cacert.pem')).text(), extra);
  }

  async setExtraRoots(pem: string) { await kvSet('extraRoots', pem); await this.loadRoots(); }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void kvSet('cookies', this.jar.toJSON()).catch(() => {});
      void kvSet('history', this.history.slice(-5000)).catch(() => {});
      void kvSet('bookmarks', this.bookmarks).catch(() => {});
    }, 1000);
  }

  visit(url: string, title: string) {
    const last = this.history[this.history.length - 1];
    if (last && last.url === url) { if (title) last.title = title; }
    else this.history.push({ url, title, t: Date.now() });
    this.saveSoon();
  }
}

function kernelDialer(stack: typeof netStack): Dialer {
  return async (host, port) => {
    const s = stack.socket(AF_INET, SOCK_STREAM) as KSocket;
    if (typeof s === 'number') throw new Error(`socket: ${errnoName(-s)}`);
    const r = await s.connectHost(host, port);
    if (r < 0) { void s.close(); throw new Error(`connect ${host}:${port}: ${errnoName(-r)}`); }
    const stream: ByteStream = {
      async read() {
        const buf = new Uint8Array(64 * 1024);
        const n = await s.read(buf);
        return n > 0 ? buf.subarray(0, n) : undefined;
      },
      async write(d) {
        for (let off = 0; off < d.length;) {
          const n = await s.write(d.subarray(off));
          if (n < 0) throw new Error(`write: ${errnoName(-n)}`);
          off += n;
        }
      },
      close() { void s.close(); },
    };
    return stream;
  };
}

let nextTab = 1;

class Tab implements BrokerTab {
  readonly id = nextTab++;
  partition: string | null = null;
  bytes = 0;
  requests = 0;
  url = '';
  title = 'New Tab';
  stack: string[] = [];
  index = -1;
  traversing: string | null = null;
  fallback: { reason: string; url: string } | null = null;
  login: { origin: string; fill: (u: string, p: string) => void } | null = null;
  savePrompt: { origin: string; url: string; username: string; password: string } | null = null;
  iframe: HTMLIFrameElement | null = null;
  loading = false;
  button: HTMLElement;
  constructor(private ui: BrowserWindow) {
    this.button = document.createElement('div');
    this.button.className = 'sd-br-tab sd-no-drag';
    this.button.setAttribute('role', 'tab');
    this.button.innerHTML = `<span class="sd-br-tab-bg"></span><span class="sd-br-fav">${ICON.globe}</span><span class="sd-br-title"></span><button class="sd-br-x" type="button" title="Close tab" aria-label="Close tab">${ICON.close}</button>`;
    ui.wireTab(this);
    this.render();
  }
  frame() { return this.iframe; }
  render() {
    const label = this.title || this.url || 'New Tab';
    this.button.querySelector('.sd-br-title')!.textContent = label;
    this.button.title = this.url ? `${label}\n${this.url}` : label;
    this.button.classList.toggle('sd-loading', this.loading);
  }
  load(realUrl: string) {
    const target = this.ui.engine.map.toBrowse(realUrl);
    this.fallback = null;
    if (!target) { this.onFallback('unproxyable', realUrl); return; }
    if (!this.iframe) {
      const f = document.createElement('iframe');
      // allow-same-origin keeps the frame on its browse origin (so its service worker runs); the
      // origin is never the desktop's, so this does not give it the desktop. No allow-top-navigation.
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock allow-presentation');
      f.setAttribute('allow', 'fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture');
      // No referrerpolicy=no-referrer here: it would mask the desktop in the frame's location.ancestorOrigins,
      // which browse documents use to find the app (browse hosts send Referrer-Policy: no-referrer themselves)
      this.iframe = f;
      f.addEventListener('load', () => { this.loading = false; this.render(); });
      f.classList.toggle('sd-active', this.ui.active === this);
      this.ui.view.append(f);
    }
    this.url = realUrl;
    this.login = null;
    this.loading = true;
    this.render();
    this.iframe.src = target;
    this.ui.refresh();
  }
  onUrl(url: string) {
    this.url = url;
    if (this.traversing === url) this.traversing = null;
    else if (this.stack[this.index] !== url) { this.stack.splice(this.index + 1); this.stack.push(url); this.index = this.stack.length - 1; }
    this.ui.engine.visit(url, '');
    this.ui.refresh();
  }
  onTitle(title: string) {
    this.title = title;
    this.ui.engine.visit(this.url, title);
    this.render();
    this.ui.refresh();
  }
  onFallback(reason: string, url: string) {
    this.fallback = { reason, url };
    this.ui.refresh();
  }
  openTab(url: string) { this.ui.newTab(url); }
  onLoginForm(origin: string, fill: (u: string, p: string) => void) {
    this.login = { origin, fill };
    this.ui.refresh();
  }
  onLoginSubmitted(origin: string, url: string, username: string, password: string) {
    const v = this.ui.engine.vault;
    if (v.unlocked && v.forOrigin(origin).some((e) => e.username === username && e.password === password)) return;
    this.savePrompt = { origin, url, username, password };
    this.ui.refresh();
  }
  go(delta: number) {
    const i = this.index + delta;
    if (i < 0 || i >= this.stack.length) return;
    this.index = i;
    this.traversing = this.stack[i];
    this.load(this.stack[i]);
  }
}

class BrowserWindow {
  root = document.createElement('div');
  view!: HTMLElement;
  tabs: Tab[] = [];
  active: Tab | null = null;
  win!: DesktopWindow;
  private ctx!: AppContext;
  private addr!: HTMLInputElement;
  private banner!: HTMLElement;
  private saveBanner!: HTMLElement;
  private chooser = false;
  private panel!: HTMLElement;
  private status!: HTMLElement;
  private tabStrip!: HTMLElement;
  private toolbar!: HTMLElement;
  private side!: HTMLElement;
  private col!: HTMLElement;
  private head = document.createElement('div');
  private headSide = document.createElement('div');
  private searchBtn = document.createElement('button');
  private prefs = loadPrefs();
  private timer: ReturnType<typeof setInterval> | null = null;

  engine!: Engine;
  constructor(private ready: Promise<Engine>) { void ready.then((e) => { this.engine = e; }); }

  build(ctx: AppContext): DesktopWindow {
    this.ctx = ctx;
    // Replaced on every build, so a hotswapped STYLE reaches new windows
    let st = document.getElementById('sd-br-style');
    if (!st) { st = document.createElement('style'); st.id = 'sd-br-style'; document.head.append(st); }
    st.textContent = STYLE;
    const r = this.root;
    r.className = 'sd-app sd-br';
    r.innerHTML = `
      <div class="sd-br-side"><div class="sd-br-strip"><button class="sd-br-ibtn sd-br-new" type="button" data-act="new" title="New tab" aria-label="New tab">${ICON.plus}</button></div><div class="sd-br-grip"></div></div>
      <div class="sd-br-col">
        <div class="sd-br-toolbar">
          <button class="sd-br-ibtn" type="button" data-act="back" title="Back" aria-label="Back">${ICON.back}</button>
          <button class="sd-br-ibtn" type="button" data-act="fwd" title="Forward" aria-label="Forward">${ICON.fwd}</button>
          <button class="sd-br-ibtn" type="button" data-act="reload" title="Reload" aria-label="Reload">${ICON.reload}</button>
          <input class="sd-br-addr" spellcheck="false" placeholder="Search or enter address" list="sd-br-hist">
          <datalist id="sd-br-hist"></datalist>
          <button class="sd-br-ibtn" type="button" data-act="key" title="Fill a saved login" aria-label="Fill a saved login" style="display:none">${ICON.key}</button>
          <button class="sd-br-ibtn" type="button" data-act="star" title="Bookmark this tab" aria-label="Bookmark this tab">${ICON.star}</button>
          <button class="sd-br-ibtn" type="button" data-act="menu" title="History, bookmarks, settings" aria-label="History, bookmarks, settings">${ICON.more}</button>
        </div>
        <div class="sd-br-banner"><span></span><button class="sd-btn sd-primary" data-act="real">Open in Host Browser</button><button class="sd-btn" data-act="dismiss">Dismiss</button></div>
        <div class="sd-br-banner sd-br-save"><span></span><button class="sd-btn sd-primary" data-act="save-login">Save</button><button class="sd-btn" data-act="no-save">Not now</button></div>
        <div class="sd-br-view"><div class="sd-br-panel"></div></div>
        <div class="sd-br-status"></div>
      </div>`;
    this.side = r.querySelector('.sd-br-side')!;
    this.col = r.querySelector('.sd-br-col')!;
    this.tabStrip = r.querySelector('.sd-br-strip')!;
    this.toolbar = r.querySelector('.sd-br-toolbar')!;
    this.view = r.querySelector('.sd-br-view')!;
    this.addr = r.querySelector('.sd-br-addr')!;
    this.banner = r.querySelector('.sd-br-banner')!;
    this.saveBanner = r.querySelector('.sd-br-save')!;
    this.panel = r.querySelector('.sd-br-panel')!;
    this.status = r.querySelector('.sd-br-status')!;

    // The title bar row: tabs (horizontal) or the sidebar's buttons and the toolbar (vertical)
    this.head.className = 'sd-br-head';
    this.headSide.className = 'sd-br-headside';
    this.headSide.innerHTML = `<button class="sd-br-ibtn sd-sq" type="button" data-act="collapse" title="Collapse tabs" aria-label="Collapse tabs">${ICON.sidebar}</button>`;
    this.searchBtn.className = 'sd-br-ibtn sd-sq';
    this.searchBtn.type = 'button';
    this.searchBtn.dataset.act = 'search';
    this.searchBtn.title = 'Search tabs';
    this.searchBtn.setAttribute('aria-label', 'Search tabs');

    const onClick = (e: MouseEvent) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      const t = this.active;
      switch (act) {
        case 'new': this.newTab(''); break;
        case 'back': t?.go(-1); break;
        case 'fwd': t?.go(1); break;
        case 'reload': if (t?.url) t.load(t.url); break;
        case 'real': { const u = t?.fallback?.url || t?.url; if (u) window.open(u, '_blank', 'noopener'); break; }
        case 'dismiss': if (t) { t.fallback = null; this.refresh(); } break;
        case 'star': if (this.engine) this.toggleBookmark(); break;
        case 'menu': if (this.engine) this.togglePanel(); break;
        case 'key': if (this.engine) this.fillLogin(); break;
        case 'save-login': if (this.engine) void this.saveLogin(); break;
        case 'no-save': if (t) { t.savePrompt = null; this.chooser = false; this.refresh(); } break;
        case 'collapse': this.prefs.collapsed = !this.prefs.collapsed; savePrefs(this.prefs); this.layout(); break;
        case 'search': this.tabSearch(e.target as HTMLElement); break;
        case 'fill-entry': {
          const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
          const entry = this.engine?.vault.entries.find((x) => x.id === id);
          if (entry && t?.login) { t.login.fill(entry.username, entry.password); this.chooser = false; this.refresh(); }
          break;
        }
      }
    };
    r.addEventListener('click', onClick);
    this.head.addEventListener('click', onClick);
    // Right-click on the strip's empty space: the layout switch
    const stripMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.sd-br-tab, input')) return;
      if (!(e.target as HTMLElement).closest('.sd-br-strip, .sd-br-side, .sd-br-head')) return;
      e.preventDefault();
      this.ctx.openMenu?.({ title: 'Tabs', items: [
        { label: 'New Tab', action: () => this.newTab('') },
        'separator',
        this.layoutItem(),
      ] }, e.clientX, e.clientY);
    };
    r.addEventListener('contextmenu', stripMenu);
    this.head.addEventListener('contextmenu', stripMenu);
    this.wireGrip(r.querySelector('.sd-br-grip')!);

    this.addr.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !this.engine) return;
      const url = normalizeInput(this.addr.value);
      if (!url) return;
      this.panel.classList.remove('sd-on');
      (this.active ?? this.newTab('')).load(url);
      this.addr.blur();
    });
    this.addr.addEventListener('focus', () => this.addr.select());
    this.win = ctx.wm.createWindow({
      appId: 'browser', title: 'Browser', width: 1000, height: 680, minWidth: 360, content: { kind: 'dom', element: r },
    });
    this.win.element.classList.add('sd-br-win');
    this.win.titlebarExtra?.append(this.head);
    this.win.element.addEventListener('keydown', (e) => this.onKey(e));
    (this.win as { content?: unknown }).content = this;
    this.win.on('close', () => {
      for (const t of this.tabs) this.engine?.tabs.delete(t);
      if (this.timer) clearInterval(this.timer);
    });
    this.layout();
    this.timer = setInterval(() => this.renderStatus(), 1000);
    void this.ready.then((e) => { if (engineError(e)) this.showMessage(e.error); });
    return this.win;
  }

  /** Puts the strip and the toolbar where the current layout has them */
  layout() {
    const v = this.prefs.vertical;
    const mode = v ? 'vertical' : 'horizontal';
    this.root.dataset.tabs = this.head.dataset.tabs = this.tabStrip.dataset.tabs = mode;
    this.root.style.setProperty('--sd-br-side', `${this.prefs.width}px`);
    this.head.style.setProperty('--sd-br-side', `${this.prefs.width}px`);
    this.side.classList.toggle('sd-collapsed', v && this.prefs.collapsed);
    this.headSide.classList.toggle('sd-collapsed', v && this.prefs.collapsed);
    const c = this.headSide.querySelector<HTMLElement>('[data-act=collapse]')!;
    c.title = this.prefs.collapsed ? 'Expand tabs' : 'Collapse tabs';
    c.setAttribute('aria-label', c.title);
    if (v) {
      this.searchBtn.innerHTML = ICON.search;
      this.headSide.append(this.searchBtn);
      this.side.prepend(this.tabStrip);
      this.head.replaceChildren(this.headSide, this.toolbar);
    } else {
      this.searchBtn.innerHTML = ICON.chevron;
      this.col.prepend(this.toolbar);
      this.head.replaceChildren(this.tabStrip, this.searchBtn);
    }
    this.active?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private layoutItem() {
    return this.prefs.vertical
      ? { label: 'Show Tabs Horizontally', action: () => this.setVertical(false) }
      : { label: 'Show Tabs Vertically', action: () => this.setVertical(true) };
  }

  setVertical(on: boolean) {
    this.prefs.vertical = on;
    savePrefs(this.prefs);
    // Every open browser window follows, as Chrome's windows do
    for (const w of this.ctx.wm.visibleOrder()) {
      const bw = w.content;
      if (bw instanceof BrowserWindow) { bw.prefs.vertical = on; bw.layout(); }
    }
    this.layout();
  }

  private wireGrip(grip: HTMLElement) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
      const x0 = e.clientX, w0 = this.prefs.width;
      const move = (ev: PointerEvent) => {
        this.prefs.width = Math.round(Math.min(480, Math.max(160, w0 + ev.clientX - x0)));
        this.layout();
      };
      const up = () => { grip.removeEventListener('pointermove', move); savePrefs(this.prefs); };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
      grip.addEventListener('pointercancel', up, { once: true });
    });
  }

  /** Mouse handling for a tab: select on press, drag to reorder, middle-click and × close, right-click menu */
  wireTab(t: Tab) {
    const b = t.button;
    const x = b.querySelector<HTMLElement>('.sd-br-x')!;
    x.addEventListener('pointerdown', (e) => e.stopPropagation());
    x.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(t); });
    b.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); this.closeTab(t); } });
    b.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.tabMenu(t, e.clientX, e.clientY); });
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.select(t);
      const vertical = this.prefs.vertical;
      const pos = (ev: PointerEvent) => vertical ? ev.clientY : ev.clientX;
      const start = (r: DOMRect) => vertical ? r.top : r.left;
      const size = (r: DOMRect) => vertical ? r.height : r.width;
      const p0 = pos(e);
      const grab = p0 - start(b.getBoundingClientRect());
      let dragging = false;
      try { b.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.abs(pos(ev) - p0) < 4) return;
          dragging = true;
          b.classList.add('sd-dragging');
        }
        b.style.transform = '';
        const p = pos(ev) - grab;
        const prev = b.previousElementSibling as HTMLElement | null;
        const next = b.nextElementSibling as HTMLElement | null;
        if (prev?.classList.contains('sd-br-tab')) {
          const pr = prev.getBoundingClientRect();
          if (p < start(pr) + size(pr) / 2) this.tabStrip.insertBefore(b, prev);
        }
        if (next?.classList.contains('sd-br-tab')) {
          const nr = next.getBoundingClientRect();
          if (p + size(b.getBoundingClientRect()) > start(nr) + size(nr) / 2) this.tabStrip.insertBefore(next, b);
        }
        const d = p - start(b.getBoundingClientRect());
        b.style.transform = vertical ? `translateY(${d}px)` : `translateX(${d}px)`;
      };
      const up = () => {
        b.removeEventListener('pointermove', move);
        if (!dragging) return;
        b.classList.remove('sd-dragging');
        b.classList.add('sd-settling');
        b.style.transform = '';
        setTimeout(() => b.classList.remove('sd-settling'), 160);
        this.tabs = [...this.tabStrip.querySelectorAll('.sd-br-tab')].map((el) => this.tabs.find((x) => x.button === el)!).filter(Boolean);
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up, { once: true });
      b.addEventListener('pointercancel', up, { once: true });
    });
  }

  private tabMenu(t: Tab, x: number, y: number) {
    const i = this.tabs.indexOf(t);
    const after = this.tabs.slice(i + 1);
    const real = t.fallback?.url || t.url;
    this.ctx.openMenu?.({ title: t.title, items: [
      { label: this.prefs.vertical ? 'New Tab Below' : 'New Tab to the Right', action: () => this.newTab('', i + 1) },
      'separator',
      { label: 'Reload', disabled: !t.url, action: () => t.load(t.url) },
      { label: 'Duplicate', disabled: !t.url, action: () => this.newTab(t.url, i + 1) },
      { label: 'Open in Host Browser', disabled: !real, action: () => window.open(real, '_blank', 'noopener') },
      'separator',
      { label: 'Close Tab', action: () => this.closeTab(t) },
      { label: 'Close Other Tabs', disabled: this.tabs.length < 2, action: () => { for (const o of [...this.tabs]) if (o !== t) this.closeTab(o); } },
      { label: this.prefs.vertical ? 'Close Tabs Below' : 'Close Tabs to the Right', disabled: !after.length, action: () => { for (const o of after) this.closeTab(o); } },
      'separator',
      this.layoutItem(),
    ] }, x, y);
  }

  private tabSearch(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    this.ctx.openMenu?.({ title: 'Tabs', items: this.tabs.map((t) => ({
      label: t.title || t.url || 'New Tab', checked: t === this.active, action: () => this.select(t),
    })) }, this.prefs.vertical ? r.left : r.right - 240, r.bottom + 4);
  }

  /** Chrome's tab keys, while focus is in the browser's own controls (a page's frame keeps its keys) */
  private onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const i = this.active ? this.tabs.indexOf(this.active) : -1;
    let done = true;
    if (e.code === 'KeyT' && !e.shiftKey) this.newTab('');
    else if (e.code === 'KeyW' && e.ctrlKey && !e.metaKey) { if (this.active) this.closeTab(this.active); }
    else if (e.code === 'KeyL') { this.addr.focus(); this.addr.select(); }
    else if (e.code === 'KeyR') { if (this.active?.url) this.active.load(this.active.url); }
    else if (e.code === 'Tab' && e.ctrlKey && this.tabs.length) this.select(this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length]);
    else if (/^Digit[1-9]$/.test(e.code) && this.tabs.length) {
      const n = Number(e.code.slice(5));
      this.select(n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[Math.min(n, this.tabs.length) - 1]);
    } else done = false;
    if (done) { e.preventDefault(); e.stopPropagation(); }
  }

  /** desktop.openApp('browser', { url }) on an open window */
  navigate(args: Record<string, unknown>) {
    if (typeof args.url === 'string') this.newTab(args.url);
  }

  newTab(url: string, at = this.tabs.length): Tab {
    const t = new Tab(this);
    this.tabs.splice(at, 0, t);
    this.tabStrip.insertBefore(t.button, this.tabs[at + 1]?.button ?? this.tabStrip.lastElementChild);
    this.select(t);
    const real = normalizeInput(url);
    void this.ready.then((e) => {
      e.tabs.add(t);
      if (real && !engineError(e)) t.load(real);
      else this.addr.focus();
    });
    return t;
  }

  closeTab(t: Tab) {
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    this.engine?.tabs.delete(t);
    t.iframe?.remove();
    t.button.remove();
    // Chrome activates the tab to the right, else the one to the left
    if (this.active === t) this.select(this.tabs[Math.min(i, this.tabs.length - 1)] ?? null);
    if (!this.tabs.length) this.win.close();
  }

  select(t: Tab | null) {
    this.active = t;
    for (const x of this.tabs) {
      x.button.classList.toggle('sd-active', x === t);
      x.button.setAttribute('aria-selected', String(x === t));
      x.iframe?.classList.toggle('sd-active', x === t);
    }
    t?.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.refresh();
  }

  refresh() {
    const t = this.active;
    if (document.activeElement !== this.addr) this.addr.value = t?.url ?? '';
    this.toolbar.querySelector<HTMLButtonElement>('[data-act=back]')!.disabled = !t || t.index <= 0;
    this.toolbar.querySelector<HTMLButtonElement>('[data-act=fwd]')!.disabled = !t || t.index >= t.stack.length - 1;
    this.win?.setTitle(t?.title ? `${t.title}` : 'Browser');
    const fb = t?.fallback;
    this.banner.classList.toggle('sd-on', !!fb);
    if (fb) this.banner.querySelector('span')!.textContent = FALLBACK_TEXT[fb.reason] ?? `This page needs the host browser (${fb.reason}).`;
    if (!this.engine) return;
    const key = this.toolbar.querySelector<HTMLElement>('[data-act=key]')!;
    key.style.display = t?.login ? '' : 'none';
    const sp = t?.savePrompt;
    const v = this.engine.vault;
    if (this.chooser && t?.login) {
      this.saveBanner.classList.add('sd-on');
      const list = v.forOrigin(t.login.origin);
      this.saveBanner.innerHTML = `<span>Fill a login for ${escHtml(new URL(t.login.origin).host)}:</span>` + list.map((x) =>
        `<button class="sd-btn" data-act="fill-entry" data-id="${escHtml(x.id)}">${escHtml(x.username || '(no username)')}</button>`).join('') + '<button class="sd-btn" data-act="no-save">Close</button>';
    } else {
      this.saveBanner.classList.toggle('sd-on', !!sp);
      this.saveBanner.innerHTML = '<span></span><button class="sd-btn sd-primary" data-act="save-login">Save</button><button class="sd-btn" data-act="no-save">Not now</button>';
      if (sp) this.saveBanner.querySelector('span')!.textContent = !v.exists ? `Save this password for ${new URL(sp.origin).host}? (Creates a password vault first.)`
        : !v.unlocked ? `Save this password for ${new URL(sp.origin).host}? (Unlock your passwords first.)` : `Save the password for ${sp.username || 'this login'} on ${new URL(sp.origin).host}?`;
    }
    const starred = !!t?.url && this.engine.bookmarks.some((b) => b.url === t.url);
    const star = this.toolbar.querySelector<HTMLElement>('[data-act=star]')!;
    star.innerHTML = starred ? ICON.starred : ICON.star;
    star.classList.toggle('sd-on', starred);
    star.title = starred ? 'Edit bookmark for this tab' : 'Bookmark this tab';
    const dl = this.toolbar.querySelector('datalist')!;
    const seen = new Set<string>();
    const opts: string[] = [];
    for (let i = this.engine.history.length - 1; i >= 0 && opts.length < 50; i--) {
      const u = this.engine.history[i].url;
      if (seen.has(u)) continue;
      seen.add(u);
      opts.push(`<option value="${escHtml(u)}"></option>`);
    }
    dl.innerHTML = opts.join('');
    this.renderStatus();
  }

  renderStatus() {
    const t = this.active;
    if (!t) { this.status.textContent = ''; return; }
    const s = this.engine.broker?.fetcher.stats;
    this.status.textContent = `${t.requests} requests · ${(t.bytes / 1048576).toFixed(2)} MB` + (s ? ` · ${s.connects} connections (${s.reused} reused)` : '');
  }

  showMessage(text: string) {
    this.panel.classList.add('sd-on');
    this.panel.innerHTML = `<div class="sd-panel"><h2>Browser</h2><p class="sd-muted">${escHtml(text)}</p></div>`;
  }

  fillLogin() {
    const t = this.active;
    if (!t?.login) return;
    const v = this.engine.vault;
    if (!v.unlocked) { this.panel.classList.add('sd-on'); this.renderPanel(); return; }
    const list = v.forOrigin(t.login.origin);
    if (list.length === 1) t.login.fill(list[0].username, list[0].password);
    else if (list.length > 1) { this.chooser = true; this.refresh(); }
    else { this.saveBanner.classList.add('sd-on'); this.saveBanner.querySelector('span')!.textContent = `No saved login for ${new URL(t.login.origin).host}.`; }
  }

  async saveLogin() {
    const t = this.active;
    const sp = t?.savePrompt;
    if (!t || !sp) return;
    const v = this.engine.vault;
    if (!v.unlocked) { this.panel.classList.add('sd-on'); this.renderPanel(); return; }
    v.session!.remember(sp.origin, sp.url, sp.username, sp.password);
    await v.save();
    t.savePrompt = null;
    this.refresh();
  }

  toggleBookmark() {
    const t = this.active;
    if (!t?.url) return;
    const i = this.engine.bookmarks.findIndex((b) => b.url === t.url);
    if (i >= 0) this.engine.bookmarks.splice(i, 1); else this.engine.bookmarks.push({ url: t.url, title: t.title });
    this.engine.saveSoon();
    this.refresh();
  }

  togglePanel() {
    if (this.panel.classList.toggle('sd-on')) this.renderPanel();
  }

  renderPanel() {
    const e = this.engine;
    const link = (u: string, title: string) => `<div class="sd-row"><a href="#" data-open="${escHtml(u)}">${escHtml(title || u)}</a><span class="sd-muted sd-small sd-grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(u)}</span></div>`;
    const hist = e.history.slice(-100).reverse();
    this.panel.innerHTML = `<div class="sd-panel" style="max-width:820px">
      <h2>Bookmarks</h2><div class="sd-card">${e.bookmarks.map((b) => link(b.url, b.title)).join('') || '<span class="sd-muted">None yet: ☆ adds the page you are on.</span>'}</div>
      <h3>History</h3><div class="sd-card">${hist.map((h) => link(h.url, h.title)).join('') || '<span class="sd-muted">Nothing yet.</span>'}</div>
      <div data-p="passwords"></div>
      <h3>Privacy</h3><div class="sd-card"><div class="sd-row"><span class="sd-grow">${e.jar.all().length} cookies in ${e.jar.partitions().length} sites</span><button class="sd-btn" data-p="clear-cookies">Clear cookies</button><button class="sd-btn" data-p="clear-history">Clear history</button></div></div>
      <h3>Certificates</h3><div class="sd-card"><p class="sd-small sd-muted">Extra trusted root certificates (PEM), for example a company proxy's. Pages are otherwise checked against Mozilla's roots.</p>
        <textarea class="sd-input" style="width:100%;height:90px;font-size:11px" data-p="roots"></textarea>
        <div class="sd-row"><button class="sd-btn" data-p="save-roots">Save</button></div></div>
    </div>`;
    renderPasswords(this.panel.querySelector('[data-p=passwords]')!, e.vault, () => { this.renderPanel(); this.refresh(); });
    void kvGet<string>('extraRoots').then((v) => { (this.panel.querySelector('[data-p=roots]') as HTMLTextAreaElement).value = v ?? ''; });
    this.panel.onclick = (ev) => {
      const el = ev.target as HTMLElement;
      const open = el.closest<HTMLElement>('[data-open]')?.dataset.open;
      if (open) { ev.preventDefault(); this.panel.classList.remove('sd-on'); (this.active ?? this.newTab('')).load(open); return; }
      const p = el.dataset.p;
      if (p === 'clear-cookies') { e.jar.clear(); this.renderPanel(); }
      if (p === 'clear-history') { e.history = []; e.saveSoon(); this.renderPanel(); }
      if (p === 'save-roots') void e.setExtraRoots((this.panel.querySelector('[data-p=roots]') as HTMLTextAreaElement).value);
    };
  }
}

function engineError(e: Engine): boolean { return !!e.error; }

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Address-bar text → URL: URLs as they are, host-like text with https://, anything else a search. */
export function normalizeInput(text: string): string {
  const s = text.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) { try { return new URL(s).href; } catch { /* search */ } }
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) { try { return new URL('https://' + s).href; } catch { /* search */ } }
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(s)}`;
}

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  shared ??= Engine.create(ctx.kernel);
  const bw = new BrowserWindow(shared);
  const win = bw.build(ctx);
  void shared.then((engine) => { (window as any).__tabcomputerBrowser = { engine, window: bw, broker: engine.broker }; });
  bw.newTab(typeof args?.url === 'string' ? args.url : '');
  return win;
}
