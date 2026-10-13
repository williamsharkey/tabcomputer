/**
 * The phone layout's rules, without a DOM (docs/DESKTOP.md "Phone layout"):
 * what is on which page of Home, what a touch on the pill means, and what the
 * app's menus become in the pill's sheet. `phone.ts` draws them.
 */

import type { MenuItem, MenuSpec } from './wm';

// ── Home ──

export interface HomeApp {
  id: string;
  name: string;
  /** Its dock stack, when that stack is a folder on Home */
  group?: string;
  /** An installed app (the app toolkit): it goes on page one */
  installed?: boolean;
}
export interface HomeFolder { id: string; name: string }
export type HomeEntry = { kind: 'app'; id: string } | { kind: 'folder'; id: string; name: string; apps: string[] };

/** Page one, in this order; installed apps follow */
export const PAGE_ONE = ['terminal', 'files', 'code', 'notebook', 'browser', 'python3', 'claude', 'settings', 'converter'];

/** Icons across and down for a page of this size (CSS px): four across upright */
export function homeGrid(width: number, height: number): { cols: number; rows: number } {
  const cols = width < 500 ? 4 : Math.max(4, Math.min(8, Math.floor(width / 104)));
  const rows = Math.max(1, Math.floor(height / (height < 300 ? 84 : 96)));
  return { cols, rows };
}

/**
 * The pages of Home. Page one: `PAGE_ONE` and the installed apps (it runs on
 * to a second page only when they do not fit). Then the rest in the order
 * given, an app with a folder's `group` inside that folder, which stands
 * where its first member would. A folder of one is the app itself.
 */
export function homePages(apps: HomeApp[], folders: HomeFolder[], perPage: number): HomeEntry[][] {
  const per = Math.max(1, Math.floor(perPage));
  const byId = new Map(apps.map((a) => [a.id, a]));
  const first: HomeEntry[] = [
    ...PAGE_ONE.filter((id) => byId.has(id)).map((id) => ({ kind: 'app' as const, id })),
    ...apps.filter((a) => a.installed && !PAGE_ONE.includes(a.id)).map((a) => ({ kind: 'app' as const, id: a.id })),
  ];
  const taken = new Set(first.map((e) => e.id));
  const names = new Map(folders.map((f) => [f.id, f.name]));
  const rest: HomeEntry[] = [];
  const made = new Map<string, { kind: 'folder'; id: string; name: string; apps: string[] }>();
  for (const a of apps) {
    if (taken.has(a.id)) continue;
    const name = a.group ? names.get(a.group) : undefined;
    if (name === undefined) { rest.push({ kind: 'app', id: a.id }); continue; }
    let f = made.get(a.group!);
    if (!f) { f = { kind: 'folder', id: a.group!, name, apps: [] }; made.set(a.group!, f); rest.push(f); }
    f.apps.push(a.id);
  }
  const flat = rest.map((e): HomeEntry => (e.kind === 'folder' && e.apps.length === 1 ? { kind: 'app', id: e.apps[0] } : e));
  const pages: HomeEntry[][] = [];
  for (const list of [first, flat]) for (let i = 0; i < list.length; i += per) pages.push(list.slice(i, i + per));
  return pages.length ? pages : [[]];
}

// ── The pill ──

/** The strip the pill sits in, under the app: thinner on a phone on its side; taller over a home indicator */
export function pillStrip(viewportHeight: number, insetBottom = 0): number {
  return (viewportHeight < 500 ? 18 : 22) + Math.max(0, Math.round(insetBottom) - 12);
}

export type PillAction = 'home' | 'switcher' | 'menu' | 'previous' | 'next';

/** Finger travel that makes a touch a swipe, px */
export const PILL_SWIPE = 24;
/** Travel a tap may have */
export const PILL_SLOP = 10;
/** A touch held this long without moving opens the switcher, ms */
export const PILL_HOLD = 450;
/** A second tap within this of the first is a double tap, ms */
export const PILL_DOUBLE = 280;

interface Timers { set(fn: () => void, ms: number): unknown; clear(id: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };

/**
 * What a touch on the pill means. Tap: home (said after the double-tap wait).
 * Two taps: the app's menu. Up, or held: the switcher. Sideways: the next
 * open app (to the left) or the previous one (to the right), as pages turn.
 */
export class PillGesture {
  private start: { x: number; y: number } | null = null;
  private moved = false;
  private done = false;
  private hold: unknown = null;
  private tap: unknown = null;

  constructor(private act: (a: PillAction) => void, private timers: Timers = realTimers) {}

  down(x: number, y: number): void {
    this.start = { x, y };
    this.moved = false;
    this.done = false;
    this.clearHold();
    this.hold = this.timers.set(() => {
      this.hold = null;
      if (!this.start || this.moved || this.done) return;
      this.finish('switcher');
    }, PILL_HOLD);
  }

  move(x: number, y: number): void {
    if (!this.start || this.done) return;
    const dx = x - this.start.x, dy = y - this.start.y;
    if (Math.abs(dx) > PILL_SLOP || Math.abs(dy) > PILL_SLOP) { this.moved = true; this.clearHold(); }
    // Up is said while the finger still moves, as the home indicator answers
    if (-dy >= PILL_SWIPE && -dy > Math.abs(dx)) this.finish('switcher');
  }

  up(x: number, y: number): void {
    const s = this.start;
    this.start = null;
    this.clearHold();
    if (!s || this.done) return;
    const dx = x - s.x, dy = y - s.y;
    if (Math.abs(dx) >= PILL_SWIPE && Math.abs(dx) > Math.abs(dy)) { this.finish(dx < 0 ? 'next' : 'previous'); return; }
    if (this.moved || Math.abs(dx) > PILL_SLOP || Math.abs(dy) > PILL_SLOP) return;
    if (this.tap !== null) { this.finish('menu'); return; }
    this.tap = this.timers.set(() => { this.tap = null; this.act('home'); }, PILL_DOUBLE);
  }

  cancel(): void {
    this.start = null;
    this.clearHold();
  }

  private finish(a: PillAction): void {
    this.done = true;
    this.clearHold();
    if (this.tap !== null) { this.timers.clear(this.tap); this.tap = null; }
    this.act(a);
  }

  private clearHold(): void {
    if (this.hold !== null) { this.timers.clear(this.hold); this.hold = null; }
  }
}

/**
 * The open app one place after (`delta` 1) or before (-1) `current` in
 * `order`, wrapping. From Home (`current` null): the first or the last. null:
 * nothing else is open.
 */
export function neighbour<T>(order: T[], current: T | null, delta: 1 | -1): T | null {
  if (!order.length) return null;
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return delta < 0 ? order[order.length - 1] : order[0];
  if (order.length < 2) return null;
  return order[(i + delta + order.length) % order.length];
}

// ── The app's menu as a sheet ──

export interface SheetItem { label: string; checked?: boolean; disabled?: boolean; /** It removes something */ danger?: boolean; action?: () => void }
export interface SheetSection { title: string; items: SheetItem[] }

/**
 * The menu bar's menus as the sections of a sheet: each menu in turn, with
 * its commands. Left out: separators, keyboard shortcuts, and commands marked
 * `phone: false` (moving and tiling windows), then a menu with nothing left.
 */
export function menuSheet(menus: MenuSpec[]): SheetSection[] {
  const out: SheetSection[] = [];
  for (const m of menus) {
    const items = m.items
      .filter((it): it is MenuItem => it !== 'separator' && it.phone !== false)
      .map((it): SheetItem => ({ label: it.label, checked: it.checked, disabled: it.disabled, action: it.action }));
    if (items.length) out.push({ title: m.title, items });
  }
  return out;
}

// ── The terminal ──

/** Terminal text size in the phone layout, px: 49 columns on a 393 px screen, 47 on 375 */
export const PHONE_FONT = 13;
export const PHONE_FONT_MIN = 8;
export const PHONE_FONT_MAX = 28;
export const PHONE_FONT_KEY = 'tabcomputer-phone-font';

/** The size a pinch that began at `from` px and spread to `scale` times asks for */
export function pinchFont(from: number, scale: number): number {
  return Math.max(PHONE_FONT_MIN, Math.min(PHONE_FONT_MAX, Math.round(from * scale)));
}

/** The saved size (a pinch saves it), else the default */
export function phoneFont(): number {
  try {
    const n = Number(localStorage.getItem(PHONE_FONT_KEY));
    if (n >= PHONE_FONT_MIN && n <= PHONE_FONT_MAX) return Math.round(n);
  } catch { /* no storage */ }
  return PHONE_FONT;
}
