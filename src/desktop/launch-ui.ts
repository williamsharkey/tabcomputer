/**
 * Placeholder windows for apps that are starting (docs/DESKTOP.md "Launch
 * feedback"; the states are launch-state.ts). A launch that asks for one
 * (Debian GUI apps) gets a window reserved where its first window is likely
 * to go: the app's last geometry, else a guess. It opens behind the other
 * windows without taking focus (in front on a phone, where every window
 * fills the screen), is partly transparent, and shows the app's icon and
 * name, the stage in words, a progress bar (a real fraction or an
 * indeterminate one, never a made-up number) and the newest output line with
 * the rest under "Show details". Its title bar repeats the stage, with a thin
 * progress line under it: behind a window that covers its middle, that strip
 * is what still shows.
 *
 * When the app's first window is created it takes the placeholder's place in
 * the same task (no frame shows both or neither): its position always, its
 * size when that was the app's own last size or the person resized the
 * placeholder. A splash screen leaves the placeholder where it is. A failed
 * launch keeps the placeholder, with the error selectable and Close / Retry.
 * Closing the placeholder cancels the launch.
 *
 * Loaded on the first launch that wants a placeholder.
 */
import type { DesktopWindow, WindowManager } from './wm';
import { elapsedText, placeholderId, rememberGeometry, reservedGeometry, type Launch, type LaunchTracker } from './launch-state';

/** A launch quicker than this never shows a placeholder */
const SHOW_AFTER_MS = 250;
/** From here on the stage line carries the time it has taken */
const ELAPSED_AFTER_MS = 10_000;

const CSS = `
.sd-win.sd-launch-win {
  background: color-mix(in srgb, var(--sd-window) 62%, transparent);
  -webkit-backdrop-filter: saturate(160%) blur(22px); backdrop-filter: saturate(160%) blur(22px);
  box-shadow: var(--sd-shadow-blur), 0 0 0 .5px var(--sd-window-border);
}
.sd-launch-win > .sd-titlebar, .sd-launch-win.sd-focused > .sd-titlebar { background: transparent; border-bottom-color: transparent; }
/* The title bar says the stage too, with a thin progress line under it: when another window
   covers the middle of the placeholder, this strip is usually what still shows */
.sd-launch-win > .sd-titlebar .sd-title, .sd-launch-win.sd-focused > .sd-titlebar .sd-title { font-weight: 400; color: var(--sd-text-2); }
.sd-launch-line { position: absolute; left: 0; right: 0; top: 36px; height: 2px; overflow: hidden; pointer-events: none; background: var(--sd-sep); }
.sd-launch-line > i { display: block; height: 100%; background: linear-gradient(90deg, var(--sd-accent-2), var(--sd-accent)); transition: width .3s var(--sd-ease); }
.sd-launch-line.sd-indeterminate > i { width: 30%; animation: sd-launch-slide 1.5s ease-in-out infinite; }
/* in front, the body says it all: no second stage line, one bar */
.sd-launch-win.sd-focused > .sd-titlebar .sd-title { opacity: 0; }
.sd-launch-win.sd-focused > .sd-launch-line, .sd-launch-win.sd-launch-failed > .sd-launch-line { display: none; }
.sd-launch-win.sd-launch-failed { background: color-mix(in srgb, var(--sd-window) 88%, transparent); }
.sd-launch-win.sd-launch-flash { animation: sd-launch-flash .5s var(--sd-ease) 2; }
@keyframes sd-launch-flash { 50% { box-shadow: var(--sd-shadow-blur), 0 0 0 3px var(--sd-accent); } }
/* The app's window takes this one's place at once: no fade under it */
.sd-win.sd-launch-win.sd-launch-gone { display: none; }
.sd-launch {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  padding: 4px 20px 18px; overflow: auto; text-align: center; color: var(--sd-text); container-type: size;
}
.sd-launch-icon { width: 64px; height: 64px; flex: none; margin-bottom: 6px; display: grid; place-items: center; opacity: .92; }
.sd-launch-icon img, .sd-launch-icon > svg, .sd-launch-icon .sd-tile { width: 100%; height: 100%; margin: 0; display: block; object-fit: contain; }
.sd-launch-name { font-size: 24px; font-weight: 300; letter-spacing: -.01em; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
.sd-launch-stage { font-size: 13px; font-weight: 400; color: var(--sd-text-2); max-width: 100%; flex: none; }
.sd-launch-bar { width: min(280px, 78%); height: 4px; flex: none; margin: 8px 0 2px; border-radius: 2px; background: var(--sd-active); overflow: hidden; position: relative; }
.sd-launch-bar > i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--sd-accent-2), var(--sd-accent)); transition: width .3s var(--sd-ease); }
.sd-launch-bar.sd-indeterminate > i { width: 34%; animation: sd-launch-slide 1.5s ease-in-out infinite; }
@keyframes sd-launch-slide { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
.sd-launch-amount { font-size: 11.5px; color: var(--sd-text-3); font-variant-numeric: tabular-nums; min-height: 16px; flex: none; }
.sd-launch-note { font-size: 11.5px; color: var(--sd-text-3); flex: none; }
.sd-launch-last { font: 11px/1.4 var(--sd-mono); color: var(--sd-text-3); max-width: min(520px, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; min-height: 15px; }
.sd-launch-error { font-size: 13px; color: var(--sd-text); max-width: min(520px, 100%); user-select: text; -webkit-user-select: text; cursor: text; overflow-wrap: anywhere; flex: none; }
.sd-launch-log {
  width: min(560px, 100%); max-height: 38%; min-height: 48px; flex: 0 1 auto; overflow: auto; margin: 4px 0 0; padding: 8px 10px; text-align: left;
  font: 11px/1.45 var(--sd-mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--sd-text-2);
  background: var(--sd-field); border: 1px solid var(--sd-sep); border-radius: 8px; user-select: text; -webkit-user-select: text; cursor: text;
}
.sd-launch-actions { display: flex; gap: 8px; align-items: center; justify-content: center; flex-wrap: wrap; margin-top: 10px; flex: none; }
.sd-launch [hidden] { display: none; }
.sd-launch-more { font-size: 11.5px; }
@container (max-height: 300px) {
  .sd-launch-icon { width: 40px; height: 40px; margin-bottom: 2px; }
  .sd-launch-name { font-size: 18px; }
  .sd-launch-note { display: none; }
  .sd-launch-actions { margin-top: 4px; }
}
@container (max-height: 190px) { .sd-launch-icon, .sd-launch-last { display: none; } }
/* No motion: the bar of an unknown amount is a still, striped track */
@media (prefers-reduced-motion: reduce) {
  .sd-launch-bar.sd-indeterminate > i, .sd-launch-line.sd-indeterminate > i {
    width: 100%; opacity: .55; transform: none;
    background: repeating-linear-gradient(115deg, var(--sd-accent) 0 6px, transparent 6px 12px);
  }
}
`;

interface Placeholder {
  launch: Launch;
  win: DesktopWindow;
  /** The geometry it opened with was the app's own last one */
  remembered: boolean;
  /** The person moved or resized it */
  touched: boolean;
  /** Its details are open */
  details: boolean;
  /** The stage last announced (the live region changes only with it) */
  said: string;
  paint(): void;
}

export interface LaunchUIDeps {
  /** One sentence to the person (what cancelling did) */
  toast(text: string): void;
}

/** True when no part of the window's title bar can be seen (other windows are over all of it) */
function titleHidden(win: DesktopWindow): boolean {
  if (typeof document.elementFromPoint !== 'function') return false;
  const r = win.element.getBoundingClientRect();
  if (!r.width) return false;
  for (const f of [0.08, 0.3, 0.5, 0.7, 0.92]) {
    const hit = document.elementFromPoint(r.left + r.width * f, r.top + 19);
    if (hit && win.element.contains(hit)) return false;
  }
  return true;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** Show placeholders for the tracker's launches from now on (and those already in flight). Returns stop. */
export function initLaunchUI(wm: WindowManager, tracker: LaunchTracker, deps: LaunchUIDeps): () => void {
  if (!document.getElementById('sd-launch-style')) {
    const style = document.createElement('style');
    style.id = 'sd-launch-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const shown = new Map<Launch, Placeholder>();
  const pending = new Map<Launch, ReturnType<typeof setTimeout>>();
  const dirty = new Set<Placeholder>();
  let clock: ReturnType<typeof setInterval> | null = null;

  const tick = () => {
    for (const p of shown.values()) if (p.launch.active) p.paint();
    if (![...shown.values()].some((p) => p.launch.active) && clock) { clearInterval(clock); clock = null; }
  };

  const open = (l: Launch): Placeholder | null => {
    const had = shown.get(l);
    if (had) return had;
    if (!l.info.placeholder || l.stage === 'running' || l.stage === 'cancelled') return null;
    const t = pending.get(l);
    if (t) { clearTimeout(t); pending.delete(l); }
    const wa = wm.workArea();
    const g = reservedGeometry(l.id, l.info.size, wa);
    const body = document.createElement('div');
    body.className = 'sd-launch';
    const icon = l.info.icon ?? '';
    body.innerHTML = `
      <div class="sd-launch-icon" aria-hidden="true">${icon.trim().startsWith('<') ? icon : icon ? `<img src="${esc(icon)}" alt="">` : ''}</div>
      <div class="sd-launch-name"></div>
      <div class="sd-launch-stage" role="status" aria-live="polite"></div>
      <div class="sd-launch-error" role="alert" hidden></div>
      <div class="sd-launch-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
      <div class="sd-launch-amount"></div>
      <div class="sd-launch-note" hidden></div>
      <div class="sd-launch-last" hidden></div>
      <button type="button" class="sd-link sd-launch-more" aria-expanded="false" hidden>Show details</button>
      <pre class="sd-launch-log" tabindex="0" hidden></pre>
      <div class="sd-launch-actions">
        <button type="button" class="sd-btn" data-act="cancel">Cancel</button>
        <button type="button" class="sd-btn" data-act="close" hidden>Close</button>
        <button type="button" class="sd-btn sd-primary" data-act="retry" hidden>Retry</button>
      </div>`;
    const q = <T extends HTMLElement>(sel: string) => body.querySelector<T>(sel)!;
    q('.sd-launch-name').textContent = l.info.name;
    const front = wm.compact;
    let p: Placeholder;
    const win = wm.createWindow({
      id: placeholderId(l.id), appId: l.id, title: `${l.info.name} is starting`,
      width: g.width, height: g.height, x: g.x, y: g.y, minWidth: 220, minHeight: 150,
      // behind everything, the keyboard stays where it was; a phone shows one window at a time
      behind: !front, focus: front, skipTaskbar: true,
      content: { kind: 'dom', element: body },
      onClose: () => { closed(p); },
    });
    win.element.classList.add('sd-launch-win');
    win.element.dataset.launch = l.id;
    const line = document.createElement('div');
    line.className = 'sd-launch-line';
    line.setAttribute('aria-hidden', 'true');
    line.appendChild(document.createElement('i'));
    win.element.appendChild(line);
    p = { launch: l, win, remembered: g.remembered, touched: false, details: false, said: '', paint: () => paint(p, body) };
    // A guessed spot whose title bar would be hidden under another window: the top of the work
    // area instead, if the title bar shows there (a remembered spot is the app's own: it stays)
    if (!g.remembered && !front && win.state === 'normal' && titleHidden(win)) {
      const at = win.geometry();
      win.move(at.x, 0);
      if (titleHidden(win)) win.move(at.x, at.y);
    }
    win.on('move', () => { p.touched = true; });
    win.on('resize', () => { p.touched = true; });
    body.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel' || act === 'close') win.close();
      else if (act === 'retry') {
        const retry = l.info.retry;
        win.close();
        retry?.();
      } else if ((e.target as HTMLElement).closest('.sd-launch-more')) { p.details = !p.details; p.paint(); }
    });
    shown.set(l, p);
    p.paint();
    clock ??= setInterval(tick, 1000);
    return p;
  };

  /** The placeholder is closing: an active launch is cancelled, a failed one forgotten */
  const closed = (p: Placeholder | undefined) => {
    if (!p || !shown.has(p.launch)) return;
    shown.delete(p.launch);
    const l = p.launch;
    if (l.active) {
      const note = l.cancel();
      if (note) deps.toast(note);
    } else tracker.dismiss(l);
  };

  const paint = (p: Placeholder, body: HTMLElement) => {
    const l = p.launch;
    const q = <T extends HTMLElement>(sel: string) => body.querySelector<T>(sel)!;
    const failed = l.stage === 'failed';
    p.win.element.classList.toggle('sd-launch-failed', failed);
    const stage = q('.sd-launch-stage'), error = q('.sd-launch-error');
    const words = l.text();
    // the live region speaks when the stage changes, not every second
    if (p.said !== words) { p.said = words; if (failed) error.textContent = words; else stage.textContent = words; }
    stage.hidden = failed;
    error.hidden = !failed;
    const took = Date.now() - l.stageAt;
    const timed = !failed && (l.stage === 'starting' || l.stage === 'window') && took >= ELAPSED_AFTER_MS;
    const bar = q('.sd-launch-bar');
    bar.hidden = failed;
    const f = l.fraction();
    bar.classList.toggle('sd-indeterminate', f === null);
    const fill = bar.firstElementChild as HTMLElement;
    if (f === null) { fill.style.width = ''; bar.removeAttribute('aria-valuenow'); } else { fill.style.width = `${(f * 100).toFixed(1)}%`; bar.setAttribute('aria-valuenow', String(Math.round(f * 100))); }
    const line = p.win.element.querySelector<HTMLElement>(':scope > .sd-launch-line');
    if (line) {
      line.classList.toggle('sd-indeterminate', f === null);
      (line.firstElementChild as HTMLElement).style.width = f === null ? '' : `${(f * 100).toFixed(1)}%`;
    }
    bar.setAttribute('aria-label', `${l.info.name}: ${words}`);
    const amount = q('.sd-launch-amount');
    amount.textContent = failed ? '' : l.amountText() || (timed ? elapsedText(took) : '');
    amount.hidden = failed;
    const note = q('.sd-launch-note');
    note.textContent = l.info.note ?? '';
    note.hidden = failed || !l.info.note || l.stage === 'installing' || l.stage === 'requested';
    const last = q('.sd-launch-last'), more = q('.sd-launch-more'), log = q('.sd-launch-log');
    const has = l.lines.length > 0 || !!l.lastLine();
    const details = p.details || (failed && has);
    last.textContent = l.lastLine();
    last.hidden = !has || details;
    more.hidden = !has || failed;
    more.textContent = p.details ? 'Hide details' : 'Show details';
    more.setAttribute('aria-expanded', String(p.details));
    log.hidden = !details;
    if (details) {
      const text = l.lines.slice(-80).join('\n');
      if (log.textContent !== text) {
        const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
        log.textContent = text;
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
    }
    q('[data-act=cancel]').hidden = failed;
    q('[data-act=close]').hidden = !failed;
    q('[data-act=retry]').hidden = !failed || !l.info.retry;
    p.win.setTitle(failed ? `${l.info.name} did not start` : `${l.info.name} — ${words}`);
  };

  /** The app's first window takes the placeholder's place, in this task */
  const handOver = (p: Placeholder | undefined, l: Launch) => {
    const real = l.firstWindow as DesktopWindow | null;
    if (real && typeof real.geometry === 'function' && real.state !== 'closed') {
      if (p && p.win.state !== 'closed' && !wm.compact && real.state === 'normal' && (p.win.state === 'normal' || p.win.state === 'minimized')) {
        const g = p.win.geometry();
        real.move(g.x, g.y);
        // its own last size, or the size the person gave the placeholder; never a guess forced on the app
        if ((p.remembered || p.touched) && real.options.resizable !== false) real.resize(g.width, g.height);
        // in place at once: no opening animation (it would start from the styles computed so far)
        const el = real.element;
        el.style.transition = 'none';
        el.classList.remove('sd-opening');
        void el.offsetWidth;
        el.style.transition = '';
      }
      follow(l.id, real);
    }
    if (!p) return;
    shown.delete(l);
    p.win.element.classList.add('sd-launch-gone');
    p.win.close(true);
  };

  /** Remember where the app's window is, for the next placeholder */
  const follow = (id: string, w: DesktopWindow) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const save = () => { t = null; if (w.state === 'normal') rememberGeometry(id, w.geometry()); };
    const soon = () => { if (!t) t = setTimeout(save, 400); };
    w.on('move', soon);
    w.on('resize', soon);
    w.on('close', () => { if (t) clearTimeout(t); });
    soon();
  };

  const off = tracker.on((ev, l) => {
    const p = shown.get(l);
    if (ev === 'request') {
      if (l.info.placeholder) pending.set(l, setTimeout(() => { pending.delete(l); if (l.active) open(l); }, SHOW_AFTER_MS));
      return;
    }
    if (ev === 'again') {
      // asked for again: here it is
      const ph = p ?? open(l);
      if (!ph) return;
      ph.win.focus();
      ph.win.element.classList.remove('sd-launch-flash');
      void ph.win.element.offsetWidth;
      ph.win.element.classList.add('sd-launch-flash');
      return;
    }
    if (ev === 'stage') {
      if (l.stage === 'running') { handOver(p, l); return; }
      if (l.stage === 'cancelled') { if (p) { shown.delete(l); p.win.close(true); } return; }
      if (l.stage === 'failed') {
        // the failure is the placeholder's to show: in front (without taking the keyboard), even for a quick one
        const ph = p ?? open(l);
        if (ph) { ph.paint(); wm.raise(ph.win as never); }
        return;
      }
      // an install is never instant: no need to wait before showing it
      if (!p && l.stage === 'installing') { open(l); return; }
    }
    if (ev === 'end') {
      const t = pending.get(l);
      if (t) { clearTimeout(t); pending.delete(l); }
      if (p && shown.get(l) === p) { shown.delete(l); p.win.close(true); }
      return;
    }
    // output and amounts can come many times a frame: one paint per frame
    if (p && !dirty.has(p)) {
      dirty.add(p);
      requestAnimationFrame(() => { dirty.delete(p); if (shown.get(l) === p) p.paint(); });
    }
  });
  // launches that began (or failed) while this module loaded
  for (const l of tracker.list()) if (l.info.placeholder) open(l);
  return () => { off(); if (clock) clearInterval(clock); for (const t of pending.values()) clearTimeout(t); };
}
