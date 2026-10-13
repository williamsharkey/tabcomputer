/**
 * The frame an app's page is shown in (docs/APPS.md "The page's origin"),
 * for any container: a desktop window, the tab in app mode, a pane.
 *
 * Confined (the server has app origins, /apps/config.json): the frame is
 * `<app origin>/__tabcomputer/frame.html`, a page of a host that serves
 * nothing of tabcomputer. The tab hands it one MessagePort; the app's page,
 * inside that frame, reaches the tab only through it: its requests (answered
 * from the app's files and backend, AppInstance.fetch) and its tab.js calls
 * (AppHost). The page cannot read this origin's storage or script.
 *
 * Not confined (no app origins: `vite dev`, a server with TABCOMPUTER_BROWSE=0,
 * a guest without network): the page is a `/__preview/` document of the tab's
 * own origin, as a Preview window's is. tab.js works the same, but the page
 * could reach around it, and `confined` is false so callers can say so.
 */
import { PAGE_BG, appTheme, type AppInstance } from './runtime';
import { iframeServer, type VirtualRequest, type VirtualResponse } from '../iframe-server';
import { previewUrl } from '../preview-sw-host';

export interface AppsConfig { origin: string | null }
let configP: Promise<AppsConfig> | null = null;

/** Where app pages live on this server: `scheme://{app}.host`, or null */
export function appsConfig(fetchImpl: typeof fetch = fetch): Promise<AppsConfig> {
  return configP ??= (async () => {
    try {
      const r = await fetchImpl('/apps/config.json', { cache: 'no-store' });
      const j = r.ok && /json/i.test(r.headers.get('content-type') ?? '') ? await r.json() : null;
      if (j && typeof j.origin === 'string' && /^https?:\/\/\{app\}\.[a-z0-9.-]+(:\d+)?$/.test(j.origin)) return { origin: j.origin };
    } catch { /* an older server, or vite dev: the app shell answers */ }
    return { origin: null };
  })();
}
export function setAppsConfigForTests(c: AppsConfig | null): void { configP = c ? Promise.resolve(c) : null; }

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The host label of an app's origin: `app--<id without dashes>--<16 hex>`.
 * The hex is a hash of the app's id, where it came from, and the tab's own
 * host, so two apps with one id from different places, and one app in a guest
 * and in the main profile, never share an origin (their page storage would
 * otherwise be one another's to write).
 */
export async function appOriginLabel(id: string, source: string, host: string): Promise<string> {
  const hex = (await sha256Hex(`${id}\n${source}\n${host}`)).slice(0, 16);
  return `app--${id.replace(/-/g, '').slice(0, 24)}--${hex}`;
}

export interface AppFrame {
  element: HTMLIFrameElement;
  /** The page is on an origin of its own */
  confined: boolean;
  /** Load the page again */
  reload(): void;
  dispose(): void;
}

export interface FrameOptions {
  /** The page finished loading (its path inside the app) */
  onLoad?(path: string): void;
  onError?(message: string): void;
}

/** In the sandbox of every app frame: its own origin kept, no way to move the tab */
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads';
/** …and for an app with network access, links that open in a new browser tab */
const SANDBOX_NETWORK = ' allow-popups allow-popups-to-escape-sandbox';

function toBytes(body: VirtualResponse['body']): ArrayBuffer | ReadableStream<Uint8Array> | null {
  if (body == null) return null;
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  if (body instanceof Uint8Array) return body.slice().buffer;
  if (typeof body === 'string') return new TextEncoder().encode(body).buffer;
  return new TextEncoder().encode(JSON.stringify(body)).buffer;
}

/** Answer one request of the page over the frame's port */
async function answer(inst: AppInstance, port: MessagePort, m: { id: number; method: string; path: string; headers?: Record<string, string>; body?: ArrayBuffer | null }): Promise<void> {
  let msg: { t: 'res'; id: number; status: number; statusText: string; headers: Record<string, string>; body: ArrayBuffer | ReadableStream<Uint8Array> | null };
  try {
    const r = await inst.fetch({ method: m.method, path: m.path, headers: m.headers, body: m.body ? new Uint8Array(m.body) : null });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) headers[k.toLowerCase()] = String(v);
    if (r.contentType && !headers['content-type']) headers['content-type'] = r.contentType;
    if (r.body != null && typeof r.body === 'object' && !(r.body instanceof Uint8Array) && !(r.body instanceof ReadableStream)) headers['content-type'] ??= 'application/json';
    delete headers['content-length'];
    const status = r.status ?? 200;
    msg = { t: 'res', id: m.id, status: status < 200 ? 200 : status, statusText: r.statusText ?? '', headers, body: toBytes(r.body) };
  } catch (e) {
    msg = { t: 'res', id: m.id, status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode(String(e)).buffer };
  }
  if (msg.body instanceof ReadableStream) {
    // Streamed (a log, server-sent events) where streams transfer; else whole
    try { port.postMessage(msg, [msg.body as unknown as Transferable]); return; } catch { /* not transferable here */ }
    msg.body = await new Response(msg.body).arrayBuffer();
  }
  port.postMessage(msg, msg.body instanceof ArrayBuffer ? [msg.body] : []);
}

let fronts = 15800;

/** Make the frame for `inst`. The caller puts `element` somewhere and calls `dispose` when done. */
export async function createAppFrame(inst: AppInstance, opts: FrameOptions = {}): Promise<AppFrame> {
  const cfg = await appsConfig();
  const el = document.createElement('iframe');
  el.className = 'tc-app-frame';
  el.title = inst.manifest.name;
  el.setAttribute('data-app', inst.id);
  el.style.cssText = 'display:block;width:100%;height:100%;border:0';
  const drops: (() => void)[] = [];
  // What shows before the page paints, and at a window's rounded corners: the supplied page's
  // own background in the desktop's appearance; white for a page of the app's own, as on the web
  const paintBack = () => { el.style.background = inst.manifest.kind === 'page' ? '#fff' : PAGE_BG[appTheme.get()]; };
  paintBack();
  drops.push(appTheme.on(paintBack));
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const d of drops.splice(0)) { try { d(); } catch { /* gone */ } } el.remove(); };

  if (cfg.origin) {
    // ── confined: the app's own origin ──
    const origin = cfg.origin.replace('{app}', await appOriginLabel(inst.id, inst.source, location.host));
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    let port: MessagePort | null = null;
    inst.confined = true;
    el.setAttribute('sandbox', SANDBOX + (inst.manifest.access.network ? SANDBOX_NETWORK : ''));
    el.setAttribute('allow', 'clipboard-write; fullscreen');
    const onMessage = (e: MessageEvent) => {
      // Only this frame, on the origin it was made for; what it says is otherwise not trusted
      if (e.source !== el.contentWindow || e.origin !== origin) return;
      const d = e.data as { type?: string; nonce?: string; error?: string } | null;
      if (d?.type === 'tc-app-failed' && d.nonce === nonce) { opts.onError?.(String(d.error ?? 'the frame failed').slice(0, 300)); return; }
      if (d?.type !== 'tc-app-ready' || d.nonce !== nonce) return;
      port?.close();
      const ch = new MessageChannel();
      port = ch.port1;
      const mine = port;
      const hostDrops: (() => void)[] = [];
      drops.push(() => { for (const h of hostDrops.splice(0)) h(); mine.close(); });
      mine.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { t?: string; id?: number; method?: string; path?: string; headers?: Record<string, string>; body?: ArrayBuffer | null; title?: string } | null;
        if (!m || typeof m !== 'object') return;
        if (m.t === 'fetch' && typeof m.id === 'number' && typeof m.path === 'string' && m.path.startsWith('/')) {
          void answer(inst, mine, { id: m.id, method: String(m.method ?? 'GET'), path: m.path, headers: m.headers, body: m.body });
        } else if (m.t === 'connect' && ev.ports[0]) {
          // A page's tab.js: its port is served with this app's manifest, whatever the page claims
          hostDrops.push(inst.host.connect(ev.ports[0] as unknown as Parameters<typeof inst.host.connect>[0]));
        } else if (m.t === 'loaded' && typeof m.path === 'string') opts.onLoad?.(m.path);
      };
      el.contentWindow?.postMessage({ type: 'tc-app-init', path: inst.entryPath() }, origin, [ch.port2]);
    };
    window.addEventListener('message', onMessage);
    drops.push(() => window.removeEventListener('message', onMessage));
    el.src = `${origin}/__tabcomputer/frame.html?n=${nonce}`;
    return { element: el, confined: true, reload: () => port?.postMessage({ t: 'reload' }), dispose };
  }

  // ── not confined: a document of this origin, served through the preview service worker ──
  inst.confined = false;
  let front = 0;
  for (let p = fronts; p < fronts + 500; p++) if (!iframeServer.isPortInUse(p)) { front = p; break; }
  fronts = front + 1;
  const close = iframeServer.serve(front, (req: VirtualRequest) => {
    const q = new URLSearchParams(req.query ?? {}).toString();
    const body = typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body ?? null;
    return inst.fetch({ method: req.method, path: req.path + (q ? `?${q}` : ''), headers: req.headers, body });
  }, `app ${inst.id}`);
  drops.push(close);
  const hostDrops: (() => void)[] = [];
  const onMessage = (e: MessageEvent) => {
    if (e.source !== el.contentWindow || (e.data as { type?: string } | null)?.type !== 'tc-tab-connect' || !e.ports[0]) return;
    hostDrops.push(inst.host.connect(e.ports[0] as unknown as Parameters<typeof inst.host.connect>[0]));
  };
  window.addEventListener('message', onMessage);
  drops.push(() => { window.removeEventListener('message', onMessage); for (const h of hostDrops.splice(0)) h(); });
  const url = await previewUrl(front, inst.entryPath());
  if (!url) { dispose(); throw new Error('this browser has no service workers here, which an app\'s page needs'); }
  el.setAttribute('data-preview-sw', '');
  el.setAttribute('data-virtual-port', String(front));
  el.addEventListener('load', () => opts.onLoad?.(inst.entryPath()));
  el.src = url;
  return { element: el, confined: false, reload: () => { el.src = url; }, dispose };
}
