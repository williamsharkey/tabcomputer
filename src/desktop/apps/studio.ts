/**
 * Studio (docs/APPS.md "Studio"): make a one-file app without writing code.
 *
 * Pick a kind, fill in a short form, and the app runs beside the form (below
 * it on a narrow screen) and follows each change. Problems are shown beside
 * the part of the form they belong to, in `app check`'s words. Try it runs the
 * app on a sample; Share gives the link, a QR code and Copy (and Save to a
 * gist for a person signed in to GitHub); Install puts it in the dock.
 *
 * Everything here sits on the toolkit's core: the form and its rules are
 * src/apps/studio.ts, the check is `validateManifest`, the copy that runs is
 * an `AppInstance` (`instanceFor`) in an app frame (`createAppFrame`), the
 * link is `shareFiles`, the install is the registry's. Nothing of an app is
 * drawn here: the page beside the form is the one every such app gets.
 */
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import type { AppInstance, AppView } from '../../apps/runtime';
import type { AppFrame } from '../../apps/frame';
import type { AppManifest } from '../../apps/manifest';
import {
  KINDS, PREVIEW_ID, PICTURE_TYPES, TEXT_SAMPLES, StudioState, choiceLines, draftText, sampleCsv, samplePdf, sampleKind,
  type DraftInput, type StudioKind,
} from '../../apps/studio';

const STYLE_ID = 'tc-studio-style';
const STYLE = `
.st { font: 13px/1.45 var(--sd-font); }
.st * { box-sizing: border-box; }
.st button { cursor: pointer; }
.st .sd-input { width: 100%; font-family: var(--sd-font); font-size: 13px; }
.st .sd-input.st-code { font-family: var(--sd-mono); font-size: 12.5px; }
.st textarea.sd-input { height: auto; min-height: 64px; padding: 6px 10px; resize: vertical; line-height: 1.45; }
.st select.sd-input { padding: 0 6px; }
.st-start { padding: 26px 30px 30px; max-width: 760px; }
.st-start h2 { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
.st-start h3 { font-size: 13px; font-weight: 600; color: var(--sd-text-2); margin: 24px 0 8px; }
.st-start p { margin: 0; }
.st-kinds { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }
.st-kind { display: flex; flex-direction: column; gap: 4px; padding: 14px; text-align: left; font: inherit; color: var(--sd-text); background: var(--sd-field); border: 1px solid var(--sd-sep); border-radius: 10px; }
.st-kind:hover { background: var(--sd-hover); border-color: var(--sd-window-border); }
.st-kind:focus-visible, .st-pick:focus-visible { outline: 2px solid var(--sd-accent); outline-offset: 1px; }
.st-kind b { font-size: 15px; }
.st-kind span { color: var(--sd-text-2); }
.st-picks { display: flex; flex-wrap: wrap; gap: 6px; }
.st-pick { font: inherit; padding: 5px 11px; color: var(--sd-text); background: var(--sd-field); border: 1px solid var(--sd-sep); border-radius: 999px; }
.st-pick:hover { background: var(--sd-hover); }
.st-edit { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.st-bar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--sd-sep); }
.st-bar .st-acts { margin-left: auto; display: flex; gap: 6px; }
.st-body { flex: 1; min-height: 0; display: flex; }
.st-form { flex: 0 0 400px; min-width: 0; overflow: auto; padding: 14px 16px 24px; border-right: 1px solid var(--sd-sep); }
.st-run { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.st-frame { flex: 1; min-height: 0; position: relative; }
.st-frame iframe { position: absolute; inset: 0; }
.st-say { flex: none; margin: 0; padding: 6px 12px; color: var(--sd-text-2); border-top: 1px solid var(--sd-sep); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.st-say:empty { display: none; }
.st-field { margin: 0 0 12px; }
.st-field > label, .st-label { display: block; font-weight: 600; margin: 0 0 4px; }
.st-hint { margin: 4px 0 0; color: var(--sd-text-2); font-size: 12px; }
.st-problem { margin: 4px 0 0; color: #e5484d; font-size: 12px; overflow-wrap: anywhere; }
.sd-desktop[data-theme='dark'] .st-problem { color: #ff8a80; }
.st-problem[hidden] { display: none; }
.st [aria-invalid=true] { border-color: #e5484d; }
.st-check { display: flex; align-items: center; gap: 8px; min-height: 30px; margin: 0 0 8px; }
.st-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--sd-accent); }
.st-group { margin: 16px 0 12px; }
.st-group > .st-label { margin-bottom: 8px; }
.st-card { padding: 10px 12px; margin: 0 0 8px; border: 1px solid var(--sd-sep); border-radius: 10px; background: var(--sd-field); }
.st-card .st-field { margin-bottom: 8px; }
.st-card .st-field:last-child { margin-bottom: 0; }
.st-card-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font-family: var(--sd-mono); font-size: 12px; color: var(--sd-text-2); }
.st-two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.st-col { display: grid; grid-template-columns: 1fr 120px auto; gap: 6px; align-items: start; margin: 0 0 6px; }
.st-col .st-col-choices { grid-column: 1 / 3; }
.st-col .st-problem { grid-column: 1 / -1; margin: 0; }
.st-col-btns { display: flex; gap: 2px; }
.st-col-btns button { width: 28px; padding: 0; }
.st details { margin: 16px 0 0; }
.st summary { cursor: pointer; color: var(--sd-text-2); font-weight: 600; margin: 0 0 10px; }
.st-sheet { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--sd-window) 70%, transparent); }
.st-sheet > .tc-app-share { width: min(520px, 100%); height: auto; max-height: 100%; border: 1px solid var(--sd-window-border); border-radius: 12px; box-shadow: var(--sd-shadow-blur); }
.st.st-narrow .st-kinds { grid-template-columns: 1fr; }
.st.st-narrow .st-start { padding: 18px 16px 24px; }
.st.st-narrow .st-body { flex-direction: column; overflow: auto; }
.st.st-narrow .st-form { flex: none; overflow: visible; border-right: 0; padding-bottom: 8px; }
.st.st-narrow .st-run { flex: none; height: 82%; min-height: 420px; border-top: 1px solid var(--sd-sep); }
.st.st-narrow .st-bar .sd-seg { flex: 1 1 100%; }
.st.st-narrow .st-bar .sd-seg button { flex: 1; }
.st.st-narrow .st-bar .st-acts { flex: 1 1 100%; margin: 0; }
.st.st-narrow .st-bar .st-acts .sd-btn { flex: 1; }
.st.st-narrow .st-sheet { padding: 0; }
.st.st-narrow .st-sheet > .tc-app-share { width: 100%; height: 100%; border-radius: 0; border: 0; }
.sd-phone .st .sd-input, .sd-phone .st select.sd-input { min-height: 44px; font-size: 16px; }
.sd-phone .st .st-pick { min-height: 44px; padding: 0 16px; }
.sd-phone .st-check input { width: 22px; height: 22px; }
.sd-phone .st-col-btns button { width: 44px; }
`;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const btn = (text: string, cls = 'sd-btn', act = ''): HTMLButtonElement => {
  const b = h('button', cls, text);
  b.type = 'button';
  if (act) b.dataset.act = act;
  return b;
};

/** Where the copy beside the form keeps nothing (an app that is its manifest has no files of its own) */
const previewDir = (home: string) => `${home}/.cache/studio`;

/** The copy of the draft that runs beside the form: one AppInstance under PREVIEW_ID, its frame, its data a try-out's */
class Preview {
  inst: AppInstance | null = null;
  private frame: AppFrame | null = null;
  private applied = '';
  private last: AppManifest | null = null;
  private chain: Promise<void> = Promise.resolve();
  private gone = false;
  private readonly view: AppView = { kind: 'pane', close: () => {}, reload: () => this.frame?.reload() };
  constructor(private host: HTMLElement, private ctx: AppContext, private say: (text: string) => void) {}

  get dataDir(): string { return `${this.home}/.local/share/apps/${PREVIEW_ID}`; }
  get home(): string { return this.ctx.shell.env['HOME'] || '/home/user'; }

  /** A try-out starts with nothing: the last one's rows and files go */
  async clear(): Promise<void> {
    await this.ctx.fs.rm(this.dataDir, { recursive: true }).catch(() => {});
    await this.ctx.fs.mkdir(this.dataDir, { recursive: true }).catch(() => {});
  }

  /** A new draft: the try-out's data goes, then `m` is shown */
  restart(m: AppManifest | null): Promise<void> {
    this.chain = this.chain.then(() => this.clear());
    return this.show(m, true);
  }

  /** Show `m`, once the changes before it are shown. Null: the draft has a problem; the last one that worked stays. */
  show(m: AppManifest | null, force = false): Promise<void> {
    if (!m) return this.chain;
    return this.chain = this.chain.then(() => this.apply(m, force)).catch((e) => { console.error('[studio]', e); });
  }

  private async apply(m: AppManifest, force: boolean): Promise<void> {
    if (this.gone) return;
    const key = JSON.stringify(m);
    if (key === this.applied && !force) return;
    this.applied = key;
    const prev = this.last;
    this.last = m;
    const runtime = await import('../../apps/runtime');
    try { runtime.appsDeps(); } catch { runtime.configureApps({ fs: this.ctx.fs, shell: this.ctx.shell }); }
    if (!this.inst) {
      await this.clear();
      this.inst = runtime.instanceFor({ manifest: m, dir: previewDir(this.home), source: 'studio', dev: true });
      this.inst.attach(this.view);
      const { createAppFrame } = await import('../../apps/frame');
      try {
        this.frame = await createAppFrame(this.inst, { onError: (msg) => this.say(`The app could not be shown: ${msg}`) });
      } catch (e) { this.say(`The app could not be shown: ${(e as Error).message}`); return; }
      if (this.gone) { this.frame.dispose(); return; }
      this.host.append(this.frame.element);
      return;
    }
    // Another table, or other columns: the try-out rows of the old one would show as columns of their own
    if (prev?.kind === 'table' && (prev.table !== m.table || JSON.stringify(prev.columns) !== JSON.stringify(m.columns))) {
      await this.ctx.fs.rm(`${this.dataDir}/${prev.table}`).catch(() => {});
    }
    this.inst.setManifest(m);
    this.inst.reload();
  }

  dispose(): void {
    this.gone = true;
    this.frame?.dispose();
    if (this.inst) this.inst.detach(this.view);
  }
}

/** A picture to try a picture app on: drawn here, written as the type the extension names */
async function samplePicture(ext: string): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = 1600; c.height = 1200;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 1200);
  sky.addColorStop(0, '#7fb2f0'); sky.addColorStop(1, '#f6d7a7');
  g.fillStyle = sky; g.fillRect(0, 0, 1600, 1200);
  g.fillStyle = '#f9c74f'; g.beginPath(); g.arc(1180, 330, 150, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4d7c5a'; g.beginPath(); g.moveTo(0, 1200); g.lineTo(0, 820); g.lineTo(520, 560); g.lineTo(980, 860); g.lineTo(1600, 640); g.lineTo(1600, 1200); g.fill();
  g.fillStyle = '#fff'; g.font = '600 72px system-ui, sans-serif'; g.fillText('A sample picture', 80, 150);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, PICTURE_TYPES[ext], 0.9));
  if (!blob) throw new Error(`this browser cannot write a ${ext} picture`);
  return new Uint8Array(await blob.arrayBuffer());
}

let current: { win: DesktopWindow; start(): void; edit(id: string): void } | null = null;

/** File ▸ New App (the menu bar while the Studio is in front; the pill's sheet on a phone): back to the start */
export function newApp(): void { current?.start(); }

export function open(ctx: AppContext, args?: Record<string, unknown>): DesktopWindow {
  const { wm, fs } = ctx;
  if (current && current.win.state !== 'closed') {
    current.win.focus();
    if (typeof args?.id === 'string') current.edit(args.id);
    return current.win;
  }
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  const root = h('div', 'sd-app st');
  const wa = wm.workArea();
  const win = wm.createWindow({
    appId: 'studio', title: 'Studio', content: { kind: 'dom', element: root },
    width: Math.min(1120, Math.max(320, wa.width - 60)), height: Math.min(720, Math.max(300, wa.height - 70)), minWidth: 320, minHeight: 300,
  });
  (win as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = { cmd: 'desktop open studio', cwd: '/home/user' };
  // A narrow window, or a phone: one column, the app below the form
  const narrow = new ResizeObserver(() => { root.classList.toggle('st-narrow', root.clientWidth < 760); });
  narrow.observe(root);

  const state = new StudioState();
  let preview: Preview | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shape = '';
  let gistLink = '';
  let moreOpen = false;
  /** The status line under the running app */
  const sayEl = h('p', 'st-say');
  sayEl.setAttribute('role', 'status');
  const say = (text: string, ...extra: HTMLElement[]) => { sayEl.replaceChildren(...(text ? [text] : []), ...extra); };

  // ── the start: a kind, or an app to start from ──
  async function start(): Promise<void> {
    root.replaceChildren();
    const page = h('div', 'sd-scroll');
    const s = h('div', 'st-start');
    page.append(s);
    root.append(page);
    s.append(h('h2', '', 'Make an app'), h('p', 'sd-muted', 'Pick the kind of app. You can change it later.'));
    const kinds = h('div', 'st-kinds');
    for (const k of KINDS) {
      const b = btn('', 'st-kind', `kind-${k.kind}`);
      b.append(h('b', '', k.title), h('span', '', k.text));
      b.addEventListener('click', () => { fresh(k.kind); });
      kinds.append(b);
    }
    s.append(kinds);
    if (state.kind && state.draft.name) {
      const go = btn(`Go on with ${state.draft.name}`, 'st-pick', 'resume');
      go.addEventListener('click', () => { edit(); });
      s.append(h('h3', '', 'Not finished'), go);
    }
    const from = h('div', 'st-picks');
    s.append(h('h3', '', 'Or start from one of these'), from);
    const mine = h('div', 'st-picks');
    const mineHead = h('h3', '', 'Your apps');
    mineHead.hidden = true;
    s.append(mineHead, mine);
    // The site's apps that are one app.json: the page's own list, the one /apps shows
    void fetch('/apps/index.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((list: { apps?: { id: string; name?: string; files: { path: string }[] }[] } | null) => {
      for (const a of list?.apps ?? []) {
        if (a.files.length !== 1 || a.files[0].path !== 'app.json') continue;
        const b = btn(a.name || a.id, 'st-pick', `from-${a.id}`);
        b.addEventListener('click', () => {
          void fetch(`/apps/${a.id}/app.json`, { cache: 'no-cache' }).then((r) => r.json()).then((raw) => { if (state.load(raw)) { gistLink = ''; edit(); } });
        });
        from.append(b);
      }
      if (!from.childElementCount) from.append(h('p', 'sd-muted', 'The list of apps could not be loaded.'));
    }, () => from.append(h('p', 'sd-muted', 'The list of apps could not be loaded.')));
    // Installed apps that are one app.json, to edit
    void import('../../apps/registry').then(async ({ listInstalled }) => {
      for (const a of await listInstalled(fs).catch(() => [])) {
        if (a.id === PREVIEW_ID) continue;
        const names = await fs.readdir(a.dir).catch(() => [] as string[]);
        if (names.length !== 1 || names[0] !== 'app.json') continue;
        const b = btn(a.name, 'st-pick', `mine-${a.id}`);
        b.addEventListener('click', () => { void editInstalled(a.id); });
        mine.append(b);
        mineHead.hidden = false;
      }
    });
  }

  /** A new draft of a kind (the start's tap) */
  function fresh(kind: StudioKind): void {
    state.load({ ...(kind === 'table' ? { table: '', columns: [] } : kind === 'form' ? { fields: {}, run: '' } : { run: '' }) });
    if (kind === 'table') state.addColumn();
    gistLink = '';
    edit();
  }

  /** An installed app, to edit: its app.json, under its own id */
  async function editInstalled(id: string): Promise<void> {
    const { findInstalled } = await import('../../apps/registry');
    const app = await findInstalled(fs, id);
    if (!app) { await start(); return; }
    const names = await fs.readdir(app.dir).catch(() => [] as string[]);
    let raw: Record<string, unknown> | null = null;
    try { raw = JSON.parse(String(await fs.readFile(`${app.dir}/app.json`, 'utf8'))); } catch { /* below */ }
    if (names.length === 1 && raw && state.load(raw, { edit: id })) { gistLink = ''; edit(); return; }
    // An app with a page of its own is code: the Code app opens its folder
    await start();
    const note = h('div', 'st-card');
    const open = btn('Open it in Code', 'sd-btn', 'code');
    open.addEventListener('click', () => { void ctx.shell.fork().execute(`code '${app.dir.replace(/'/g, `'\\''`)}'`, () => {}, () => {}); });
    note.append(h('p', '', `${app.name} has a page of its own, so it is edited as code.`), h('div', 'st-hint'), open);
    root.querySelector('.st-start')?.prepend(note);
  }

  // ── the form ──
  const form = h('div', 'st-form');
  const runBox = h('div', 'st-run');
  const frameBox = h('div', 'st-frame');
  runBox.append(frameBox, sayEl);
  const bar = h('div', 'st-bar');

  function edit(): void {
    root.replaceChildren();
    const ed = h('div', 'st-edit');
    const body = h('div', 'st-body');
    body.append(form, runBox);
    ed.append(bar, body);
    root.append(ed);
    drawBar();
    draw();
    say('');
    preview ??= new Preview(frameBox, ctx, (t) => say(t));
    // (a new draft's try-out starts with nothing)
    void preview.restart(state.preview());
  }

  function drawBar(): void {
    bar.replaceChildren();
    const seg = h('div', 'sd-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Kind of app');
    for (const k of KINDS) {
      const b = btn(k.title, state.kind === k.kind ? 'sd-active' : '', `kind-${k.kind}`);
      b.title = k.text;
      b.setAttribute('aria-pressed', String(state.kind === k.kind));
      b.addEventListener('click', () => {
        if (state.kind === k.kind) return;
        state.choose(k.kind);
        if (k.kind === 'table' && !state.draft.columns.length) state.addColumn();
        drawBar(); draw(); changed();
      });
      seg.append(b);
    }
    const acts = h('div', 'st-acts');
    const tryIt = btn('Try it', 'sd-btn', 'try');
    tryIt.title = 'Run the app on a sample';
    tryIt.addEventListener('click', () => { void tryOut(); });
    const share = btn('Share', 'sd-btn', 'share');
    share.addEventListener('click', () => { void shareDraft(); });
    const install = btn('Install', 'sd-btn sd-primary', 'install');
    install.addEventListener('click', () => { void installDraft(); });
    acts.append(tryIt, share, install);
    bar.append(seg, acts);
  }

  /** A part of the form: its label, the control, a hint, and the line its problems go in */
  function part(label: string, field: string, control: HTMLElement, hint = '', problem = true): HTMLElement {
    const id = `st-${field.replace(/[^a-z0-9]+/gi, '-')}`;
    const wrap = h('div', 'st-field');
    const l = h('label', '', label);
    l.htmlFor = id;
    control.id = id;
    wrap.append(l, control);
    if (hint) wrap.append(h('p', 'st-hint', hint));
    if (problem) {
      const p = h('p', 'st-problem');
      p.dataset.problem = field;
      p.id = `${id}-problem`;
      p.hidden = true;
      control.setAttribute('aria-describedby', p.id);
      wrap.append(p);
    }
    return wrap;
  }
  /** A part of a field's card: its problems are said once, under the card */
  const sub = (label: string, field: string, control: HTMLElement, hint = '') => part(label, field, control, hint, false);
  const text = (k: string, value: string, set: (v: string) => void, o: { code?: boolean; long?: boolean; placeholder?: string } = {}): HTMLInputElement | HTMLTextAreaElement => {
    const el = o.long ? h('textarea', `sd-input${o.code ? ' st-code' : ''}`) : h('input', `sd-input${o.code ? ' st-code' : ''}`);
    if (!o.long) (el as HTMLInputElement).type = 'text';
    el.value = value;
    el.dataset.k = k;
    el.spellcheck = false;
    el.setAttribute('autocapitalize', o.code ? 'off' : 'sentences');
    el.setAttribute('autocomplete', 'off');
    if (o.placeholder) el.placeholder = o.placeholder;
    el.addEventListener('input', () => { set(el.value); changed(); });
    return el;
  };
  const select = (k: string, value: string, options: [string, string][], set: (v: string) => void): HTMLSelectElement => {
    const el = h('select', 'sd-input');
    el.dataset.k = k;
    for (const [v, label] of options) { const o = h('option', '', label); o.value = v; o.selected = v === value; el.append(o); }
    el.addEventListener('change', () => { set(el.value); changed(); });
    return el;
  };
  const check = (k: string, label: string, value: boolean, set: (v: boolean) => void): HTMLElement => {
    const wrap = h('label', 'st-check');
    const box = h('input');
    box.type = 'checkbox';
    box.checked = value;
    box.dataset.k = k;
    box.addEventListener('change', () => { set(box.checked); changed(); });
    wrap.append(box, label);
    return wrap;
  };

  const INPUT_TYPES: [string, string][] = [['text', 'Text'], ['long text', 'Long text'], ['number', 'Number'], ['choice', 'Choice'], ['checkbox', 'Checkbox'], ['file', 'File']];
  const OPTION_TYPES: [string, string][] = [['choice', 'Choice'], ['checkbox', 'Checkbox']];
  const COLUMN_TYPES: [string, string][] = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['choice', 'Choice'], ['checkbox', 'Checkbox']];

  /** One field of a form, or one option of a files app: a card under its word in braces */
  function inputCard(i: DraftInput, kind: StudioKind): HTMLElement {
    const card = h('div', 'st-card');
    card.dataset.input = i.name;
    const k = (s: string) => `input:${i.name}:${s}`;
    const set = <K extends keyof DraftInput>(key: K) => (v: DraftInput[K]) => state.setInput(i.name, key, v);
    card.append(h('div', 'st-card-head', `{${i.name}}`));
    const row = h('div', 'st-two');
    row.append(
      sub('Label', `${k('label')}`, text(k('label'), i.label, set('label'))),
      sub('Kind', `${k('type')}`, select(k('type'), i.type, kind === 'files' ? OPTION_TYPES : INPUT_TYPES, (v) => state.setInput(i.name, 'type', v as DraftInput['type']))),
    );
    card.append(row);
    if (i.type === 'choice') {
      card.append(sub('Choices', `${k('choices')}`, text(k('choices'), i.choices, set('choices'), { long: true, code: true, placeholder: 'Small: 800x800>\nLarge: 1600x1600>' }), 'One per line. Before a colon, what is shown; after it, what goes in the command.'));
      const labels = choiceLines(i.choices).map((c) => c.label);
      if (labels.length > 1) card.append(sub('Starts as', `${k('value')}`, select(k('value'), i.value || labels[0], labels.map((l) => [l, l]), set('value'))));
    } else if (i.type === 'checkbox') {
      card.append(sub('When it is ticked, the command gets', `${k('on')}`, text(k('on'), i.on, set('on'), { code: true })));
      card.append(check(k('value'), 'Ticked at first', !!i.value, (v) => state.setInput(i.name, 'value', v ? 'yes' : '')));
    } else if (i.type === 'file') {
      card.append(sub('File types', `${k('accept')}`, text(k('accept'), i.accept, set('accept'), { code: true, placeholder: '.txt .md' })));
    } else {
      card.append(sub('Starts as', `${k('value')}`, text(k('value'), i.value, set('value'), { long: i.type === 'long text', code: true })));
    }
    const p = h('p', 'st-problem');
    p.dataset.problem = `input:${i.name}`;
    p.hidden = true;
    card.append(p);
    return card;
  }

  function draw(): void {
    const d = state.draft;
    const focus = document.activeElement as (HTMLInputElement | null);
    const fk = focus && form.contains(focus) ? focus.dataset.k : undefined;
    const sel = fk && 'selectionStart' in focus! ? [focus!.selectionStart, focus!.selectionEnd] : null;
    form.replaceChildren();
    const other = h('p', 'st-problem');
    other.dataset.problem = 'other';
    other.hidden = true;
    form.append(other);
    form.append(part('Name', 'name', text('name', d.name, (v) => state.set('name', v), { placeholder: 'Make pictures smaller' })));
    form.append(part('What it does', 'about', text('about', d.about, (v) => state.set('about', v), { placeholder: 'One sentence.' })));
    if (d.kind === 'files') {
      form.append(part('Command', 'run', text('run', d.run, (v) => state.set('run', v), { code: true, placeholder: 'convert {in} -resize 50% {out}' }),
        '{in} is the file and {out} the result. Without {out}, what the program prints is the result. Another word in braces is an option.'));
      form.append(part('File types', 'accept', text('accept', d.accept, (v) => state.set('accept', v), { code: true, placeholder: 'Every file' })));
      form.append(part('Result name', 'out', text('out', d.out, (v) => state.set('out', v), { code: true, placeholder: 'The file\'s own name' }), d.out ? '' : 'Such as {name}-small.{ext}.'));
    } else if (d.kind === 'form') {
      form.append(part('Command', 'run', text('run', d.run, (v) => state.set('run', v), { code: true, placeholder: 'jq {filter}' }), 'A word in braces, such as {filter}, is a field the person fills in.'));
      form.append(part('Text the program reads', 'stdin', text('stdin', d.stdin, (v) => state.set('stdin', v), { code: true, long: true, placeholder: 'Nothing' })));
    }
    if (d.kind !== 'table' && d.inputs.length) {
      const g = h('div', 'st-group');
      g.append(h('div', 'st-label', d.kind === 'files' ? 'Options' : 'Fields'));
      for (const i of d.inputs) g.append(inputCard(i, d.kind));
      form.append(g);
    }
    if (d.kind === 'form') form.append(check('live', 'Run as the person types', d.live, (v) => state.set('live', v)));
    if (d.kind === 'table') {
      const g = h('div', 'st-group');
      g.append(h('div', 'st-label', 'Columns'));
      d.columns.forEach((c, i) => {
        const row = h('div', 'st-col');
        row.dataset.column = String(i);
        const name = text(`column:${i}:name`, c.name, (v) => state.setColumn(i, 'name', v), { placeholder: i ? 'Column' : 'Date' });
        name.setAttribute('aria-label', `Column ${i + 1}`);
        const type = select(`column:${i}:type`, c.type, COLUMN_TYPES, (v) => state.setColumn(i, 'type', v as typeof c.type));
        type.setAttribute('aria-label', `Kind of column ${i + 1}`);
        const btns = h('div', 'st-col-btns');
        const up = btn('↑', 'sd-btn', `up-${i}`); up.title = 'Move up'; up.setAttribute('aria-label', `Move column ${i + 1} up`); up.disabled = i === 0;
        const rm = btn('×', 'sd-btn', `remove-${i}`); rm.title = 'Remove'; rm.setAttribute('aria-label', `Remove column ${i + 1}`);
        up.addEventListener('click', () => { state.moveColumn(i, -1); draw(); changed(); });
        rm.addEventListener('click', () => { state.removeColumn(i); draw(); changed(); });
        btns.append(up, rm);
        row.append(name, type, btns);
        if (c.type === 'choice') {
          const ch = text(`column:${i}:choices`, c.choices, (v) => state.setColumn(i, 'choices', v), { placeholder: 'Food, Travel, Home' });
          ch.classList.add('st-col-choices');
          ch.setAttribute('aria-label', `Choices of column ${i + 1}`);
          row.append(ch);
        }
        const p = h('p', 'st-problem');
        p.dataset.problem = `column:${i}`;
        p.hidden = true;
        row.append(p);
        g.append(row);
      });
      const add = btn('Add a column', 'sd-btn', 'add-column');
      add.addEventListener('click', () => { state.addColumn(); draw(); changed(); (form.querySelector(`[data-k="column:${state.draft.columns.length - 1}:name"]`) as HTMLElement | null)?.focus(); });
      const p = h('p', 'st-problem');
      p.dataset.problem = 'columns';
      p.hidden = true;
      g.append(add, p);
      form.append(g);
    }
    if (d.kind !== 'table') form.append(part('Programs to install first', 'needs', text('needs', d.needs, (v) => state.set('needs', v), { code: true, placeholder: 'None' }), 'Debian packages, such as imagemagick.'));
    const more = h('details');
    more.open = moreOpen;
    more.addEventListener('toggle', () => { moreOpen = more.open; });
    more.append(h('summary', '', 'More'));
    if (d.kind === 'files') {
      more.append(check('each', 'Give the program all the files at once, for one result', !d.each, (v) => state.set('each', !v)));
      more.append(check('shell', 'The command is a shell line (pipes, redirects)', d.shell, (v) => state.set('shell', v)));
    } else if (d.kind === 'form') {
      more.append(part('Show the result as', 'output', select('output', d.output, [['text', 'Text'], ['markdown', 'Markdown'], ['html', 'A web page'], ['file', 'A file to download']], (v) => state.set('output', v as typeof d.output))));
      if (d.output === 'file') more.append(part('Result name', 'out', text('out', d.out, (v) => state.set('out', v), { code: true, placeholder: 'result.txt' })));
      more.append(check('shell', 'The command is a shell line (pipes, redirects)', d.shell, (v) => state.set('shell', v)));
    } else {
      more.append(part('Keep the table as', 'table', select('table', d.store, [['csv', 'CSV (opens in any spreadsheet)'], ['sqlite', 'SQLite']], (v) => state.set('store', v as 'csv' | 'sqlite'))));
    }
    form.append(more);
    shape = shapeOf();
    if (fk) {
      const again = form.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(fk)}"]`);
      again?.focus();
      if (again && sel && 'setSelectionRange' in again) { try { again.setSelectionRange(sel[0], sel[1]); } catch { /* not a text control */ } }
    }
    problems();
  }

  /** What decides which parts the form has: when it changes, the form is drawn again */
  const shapeOf = (): string => {
    const d = state.draft;
    return JSON.stringify([d.kind, d.inputs.map((i) => [i.name, i.type, i.type === 'choice' ? choiceLines(i.choices).length > 1 : 0]), d.columns.map((c) => c.type), d.output, d.out ? 1 : 0]);
  };

  /** Each problem beside its part of the form; one whose part is not shown goes at the top */
  function problems(): void {
    const c = state.check();
    const by = new Map<string, string[]>();
    for (const p of c.shown) {
      const at = form.querySelector(`[data-problem="${CSS.escape(p.field)}"]`) ? p.field : 'other';
      by.set(at, [...(by.get(at) ?? []), p.text]);
    }
    for (const el of form.querySelectorAll<HTMLElement>('[data-problem]')) {
      const list = by.get(el.dataset.problem!) ?? [];
      el.textContent = list.join(' ');
      el.hidden = !list.length;
      const control = el.parentElement?.querySelector<HTMLElement>('.sd-input');
      if (control && el.parentElement?.classList.contains('st-field')) control.setAttribute('aria-invalid', String(!!list.length));
    }
  }

  /** After each change: the form's parts, its problems, and (a moment after the last key) the app beside it */
  function changed(): void {
    if (shapeOf() !== shape) draw(); else problems();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void preview?.show(state.preview()); }, 350);
    gistLink = '';
  }

  // ── Try it ──
  async function tryOut(): Promise<void> {
    const m = state.preview();
    if (!m || !preview) { state.tried = true; problems(); say('Try it runs the app once the problems above are fixed.'); return; }
    await preview.show(m);
    const inst = preview.inst;
    if (!inst) return;
    if (m.kind === 'table') {
      if (m.table.endsWith('.sqlite')) { say('Try it fills a CSV table. Add a row in the app to try this one.'); return; }
      await fs.writeFile(`${preview.dataDir}/${m.table}`, sampleCsv(m));
      say('Three rows were added to try it. The installed app starts empty.');
      return;
    }
    try {
      if (m.needs.length || m.toolchains.length) {
        say(`${m.needs.join(', ')} is being installed first. This happens once.`);
        await inst.prepare((stage) => say(stage));
      }
    } catch (e) { say((e as Error).message); return; }
    if (m.kind === 'form') {
      inst.samples = true;
      say('The app ran with the values its fields start with.');
      inst.reload();
      return;
    }
    const ext = sampleKind(m.accept);
    if (!ext) { say(`Try it has no sample ${m.accept[0]} file. Give the app one of your own.`); return; }
    const bytes = ext === '.pdf' ? samplePdf() : ext in TEXT_SAMPLES ? new TextEncoder().encode(TEXT_SAMPLES[ext]) : await samplePicture(ext).catch(() => null);
    if (!bytes) { say(`Try it cannot make a ${ext} file in this browser. Give the app one of your own.`); return; }
    const rel = `sample${ext}`;
    const path = `${preview.dataDir}/samples/${rel}`;
    await fs.mkdir(`${preview.dataDir}/samples`, { recursive: true });
    await fs.writeFile(path, bytes);
    inst.samples = [{ path, rel }];
    say(`The app was given ${rel}.`);
    inst.reload();
  }

  // ── Share, Save to a gist, Install ──
  const siteOrigin = async () => {
    const [{ siteOriginOf }, { guestInfo }] = await Promise.all([import('../../apps/share'), import('../../guest')]);
    return siteOriginOf(location, !!guestInfo());
  };
  /** The draft's app.json, once it has no problems; null after showing them */
  function ready(what: string): { text: string; manifest: AppManifest } | null {
    state.tried = true;
    const c = state.check();
    problems();
    if (!c.manifest) {
      say(`${what} works once the problems in the form are fixed.`);
      form.querySelector<HTMLElement>('.st-problem:not([hidden])')?.scrollIntoView?.({ block: 'nearest' });
      return null;
    }
    return { text: draftText(c.raw), manifest: c.manifest };
  }

  async function shareDraft(): Promise<void> {
    const r = ready('Share');
    if (!r) return;
    const [{ shareFiles }, { buildShareScreen, ensureShareStyle }, { writeClipboard }, { GITHUB_TOKEN_KEY }] = await Promise.all([
      import('../../apps/share'), import('../../apps/share-ui'), import('../../utils/clipboard'), import('../../github-auth'),
    ]);
    ensureShareStyle();
    const origin = await siteOrigin();
    let shown: import('../../apps/share-ui').ShareShown;
    try {
      shown = gistLink
        ? { id: r.manifest.id, name: r.manifest.name, kind: 'gist', url: gistLink, repo: `gist.github.com/${/gist:(?:[^/]+\/)?([0-9a-f]+)/.exec(gistLink)?.[1] ?? ''}`, asks: true }
        : await shareFiles(new Map([['app.json', new TextEncoder().encode(r.text)]]), { id: r.manifest.id, name: r.manifest.name }, origin);
    } catch (e) { shown = { name: r.manifest.name, problem: (e as Error).message }; }
    let signedIn = false;
    try { signedIn = !!localStorage.getItem(GITHUB_TOKEN_KEY); } catch { /* no storage */ }
    const sheet = h('div', 'st-sheet');
    const close = () => { sheet.remove(); };
    const content = buildShareScreen(shown, (t) => writeClipboard(t).catch(() => false), close, {
      qr: true,
      actions: (status) => {
        if (!signedIn || gistLink) return [];
        const gist = btn('Save to a gist', '', 'gist');
        gist.title = 'GitHub keeps the app as a secret gist of your account. The link then names the gist.';
        gist.addEventListener('click', () => {
          gist.disabled = true;
          status('The app is being sent to GitHub.');
          void import('../../commands/link').then(({ saveGist }) => saveGist({ 'app.json': r.text }, r.manifest.name, origin)).then((g) => {
            gistLink = `${origin}/?app=gist:${g.id}`;
            close();
            void shareDraft();
          }, (e: unknown) => { status((e as Error)?.message ?? 'No gist was made.'); gist.disabled = false; });
        });
        return [gist];
      },
    });
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    sheet.append(content);
    root.append(sheet);
    content.querySelector<HTMLButtonElement>('[data-act=copy], [data-act=close]')?.focus();
  }

  async function installDraft(): Promise<void> {
    const r = ready('Install');
    if (!r) return;
    const { findInstalled } = await import('../../apps/registry');
    const other = await findInstalled(fs, r.manifest.id);
    if (other && other.id !== state.draft.id) {
      const p = form.querySelector<HTMLElement>('[data-problem="name"]');
      if (p) { p.textContent = `An installed app has the id ${r.manifest.id} already. Give this one another name, or open that one from Your apps to change it.`; p.hidden = false; }
      say('Nothing was installed.');
      return;
    }
    try {
      const { installMade } = await import('../../apps/install');
      const res = await installMade(new Map([['app.json', new TextEncoder().encode(r.text)]]), 'studio');
      state.draft.id = res.app.id;
      const openBtn = btn('Open', 'sd-btn', 'open');
      openBtn.addEventListener('click', () => { void wm.openApp(res.app.id); });
      say(`${res.app.name} is ${wm.phone ? 'on Home' : 'in the dock'} now.`, openBtn);
    } catch (e) { say((e as Error).message); }
  }

  current = { win, start: () => { void start(); }, edit: (id) => { void editInstalled(id); } };  win.on('close', () => {
    narrow.disconnect();
    if (timer) clearTimeout(timer);
    preview?.dispose();
    if (current?.win === win) current = null;
  });
  if (typeof args?.id === 'string') void editInstalled(args.id); else void start();
  return win;
}
