/**
 * How Your Data Flows (docs/DATA_FLOW.md): a diagram of this tab, this site's
 * server and the internet, with one lane per kind of traffic: who sends it,
 * what the server can read of it, where it ends up. Drawn from the live state
 * of this tab (src/data-flow.ts): guest or main profile, which sign-ins are
 * present (presence only), which relay is in use, whether storage persists.
 *
 * Opened from the welcome card, System and Help menus, and Settings → Network.
 * Everything is DOM text built with textContent; a secret's value never
 * reaches this module (the state holds booleans).
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import {
  DATA_FLOW_DOCS_URL, READS_LABEL, currentDataFlowState, dataFlowActions, dataFlowModel,
  type DataFlowAction, type DataFlowState, type Flow, type Place,
} from '../../data-flow';
import { onNetworkStatus, onOwnRelayChange } from '../../net-signin';
import { openGuest } from '../../guest';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** An arrow between two places: a line that stretches, and a head. Decoration; the lane's text says the same. */
function arrow(dashed = false): HTMLElement {
  const a = h('span', `sd-df-arrow${dashed ? ' sd-df-dashed' : ''}`);
  a.setAttribute('aria-hidden', 'true');
  a.innerHTML = '<i></i><svg viewBox="0 0 10 10" width="10" height="10"><path d="M2 1.5 7.5 5 2 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return a;
}

const PLACE_LABEL = { tab: 'This tab', server: 'Server', internet: 'Internet' } as const;

/** One cell of a lane: which place it is in (read out, and shown when the lanes stack), and what is there */
function node(place: keyof typeof PLACE_LABEL, ...children: (HTMLElement | string)[]): HTMLElement {
  const n = h('span', 'sd-df-node');
  n.dataset.place = place;
  n.append(h('span', 'sd-df-where', PLACE_LABEL[place]));
  for (const c of children) n.append(typeof c === 'string' ? h('span', 'sd-df-what', c) : c);
  return n;
}

function badge(f: Flow): HTMLElement {
  const b = h('span', 'sd-df-badge', READS_LABEL[f.reads]);
  b.dataset.reads = f.reads;
  return b;
}

function lane(f: Flow): HTMLButtonElement {
  const b = h('button', 'sd-df-lane');
  b.type = 'button';
  b.dataset.flow = f.id;
  b.dataset.status = f.status;
  b.dataset.reads = f.reads;
  const title = h('b', 'sd-df-title', f.title);
  const first = node('tab', title, f.from);
  if (f.status === 'off') first.append(h('span', 'sd-df-chip sd-df-off', 'Off here'));
  for (const c of f.carries) first.append(h('span', 'sd-df-chip sd-df-carries', `Carries your ${c}`));
  b.append(first);
  if (!f.via && !f.to) {
    // Never leaves: no arrow, and the other two places stay empty
    const stay = h('span', 'sd-df-stays', 'Stays in the tab');
    stay.append(badge(f));
    b.append(stay);
    return b;
  }
  if (f.via) {
    b.append(arrow(), node('server', f.via, badge(f)));
    if (f.to) b.append(arrow(), node('internet', f.to));
    else b.append(h('span', 'sd-df-gap'), h('span', 'sd-df-gap'));
  } else {
    // Past the server, not through it
    const skip = h('span', 'sd-df-skip');
    skip.append(arrow(true), badge(f));
    b.append(skip, node('internet', f.to!));
  }
  return b;
}

function place(p: Place): HTMLButtonElement {
  const b = h('button', 'sd-df-place');
  b.type = 'button';
  b.dataset.place = p.id;
  b.append(h('b', 'sd-df-place-title', p.title));
  const ul = h('ul');
  for (const l of p.lines) {
    const li = h('li', undefined, l);
    // "GitHub token: present" and the like: the state, findable by tests and styled
    const m = /^(GitHub token|Claude credentials|API keys): (.+)$/.exec(l);
    if (m) { li.dataset.secret = m[1]; li.dataset.present = String(m[2] !== 'none'); }
    ul.append(li);
  }
  b.append(ul);
  return b;
}

export function open(ctx: AppContext): DesktopWindow {
  const { wm, fs } = ctx;
  const root = h('div', 'sd-app sd-df');
  root.tabIndex = -1;
  const wrap = h('div', 'sd-df-wrap');
  const scroll = h('div', 'sd-scroll');
  scroll.append(wrap);
  root.append(scroll);

  let state: DataFlowState | null = null;
  /** What the detail line explains: a flow or a place the person chose, else the first sentence */
  let chosen: string | null = null;
  let alive = true;

  const detailOf = (key: string | null): { title: string; text: string } | null => {
    if (!state || !key) return null;
    const m = dataFlowModel(state);
    const f = m.flows.find((x) => `flow:${x.id}` === key);
    if (f) return { title: f.title, text: [f.note, f.readsText, f.detail, f.carries.length ? `From this tab now: ${f.carries.join(', ')}.` : ''].filter(Boolean).join(' ') };
    const p = m.places.find((x) => `place:${x.id}` === key);
    return p ? { title: p.title, text: p.detail } : null;
  };

  const showDetail = (key: string | null) => {
    const box = wrap.querySelector<HTMLElement>('.sd-df-detail');
    if (!box) return;
    const d = detailOf(key);
    box.textContent = '';
    if (d) box.append(h('b', undefined, d.title), h('span', undefined, d.text));
    else box.append(h('span', 'sd-muted', 'Point at or tap a part of the diagram to see what it means for this tab.'));
  };

  const act = (a: DataFlowAction['id']) => {
    if (a === 'guest') void openGuest({});
    else if (a === 'guest-nonet') void openGuest({ noNetwork: true });
    else if (a === 'about-guest') wm.root.querySelector<HTMLElement>('.sd-mb-guest')?.click();
    else void wm.openApp('settings', { pane: a === 'network' ? 'network' : a === 'accounts' ? 'accounts' : 'storage' });
  };

  const render = () => {
    if (!state) return;
    const m = dataFlowModel(state);
    const focusKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key;
    wrap.textContent = '';
    wrap.append(h('h2', undefined, 'How your data flows'));
    const lede = h('p', 'sd-df-headline', m.headline);
    lede.dataset.profile = state.profile;
    wrap.append(lede);
    wrap.append(h('p', 'sd-muted sd-small', 'Three places, and one row for each kind of traffic. An arrow shows who connects to whom; replies come back the same way. Each row says what this site\'s server can read of it.'));

    const diagram = h('div', 'sd-df-diagram');
    diagram.setAttribute('role', 'group');
    diagram.setAttribute('aria-label', 'This tab, this site\'s server and the internet, with the flows between them');
    const bands = h('div', 'sd-df-bands');
    bands.setAttribute('aria-hidden', 'true');
    bands.append(h('i'), h('i'), h('i'));
    const heads = h('div', 'sd-df-heads');
    for (const p of m.places) { const b = place(p); b.dataset.key = `place:${p.id}`; heads.append(b); }
    const lanes = h('ol', 'sd-df-lanes');
    for (const f of m.flows) {
      const li = h('li');
      const b = lane(f);
      b.dataset.key = `flow:${f.id}`;
      li.append(b);
      lanes.append(li);
    }
    diagram.append(bands, heads, lanes);
    wrap.append(diagram);

    const detail = h('div', 'sd-df-detail');
    detail.setAttribute('role', 'status');
    detail.setAttribute('aria-live', 'polite');
    wrap.append(detail);

    const legend = h('ul', 'sd-df-legend sd-small');
    for (const r of ['contents', 'endpoints', 'requests', 'nothing'] as const) {
      const li = h('li');
      const b = h('span', 'sd-df-badge', READS_LABEL[r]);
      b.dataset.reads = r;
      li.append(b);
      legend.append(li);
    }
    wrap.append(legend);

    wrap.append(h('h3', undefined, 'What you can change'));
    const { actions, unavailable } = dataFlowActions(state);
    const list = h('div', 'sd-card sd-df-actions');
    for (const a of actions) {
      const row = h('div', 'sd-row');
      const text = h('span', 'sd-grow sd-small', a.why);
      const btn = h('button', 'sd-btn', a.label);
      btn.type = 'button';
      btn.dataset.act = a.id;
      row.append(text, btn);
      list.append(row);
    }
    for (const u of unavailable) {
      const row = h('div', 'sd-row');
      const text = h('span', 'sd-grow sd-small sd-muted', u);
      text.dataset.unavailable = 'guest';
      row.append(text);
      list.append(row);
    }
    wrap.append(list);

    const more = h('p', 'sd-small sd-muted sd-df-more');
    const link = h('a', 'sd-link', 'docs/DATA_FLOW.md');
    link.href = DATA_FLOW_DOCS_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    more.append('Each claim here, with the code behind it: ', link, '. In a terminal: ', h('code', undefined, 'dataflow'), '.');
    wrap.append(more);

    for (const b of wrap.querySelectorAll<HTMLElement>('[data-key]')) {
      b.setAttribute('aria-pressed', String(b.dataset.key === chosen));
      b.classList.toggle('sd-active', b.dataset.key === chosen);
    }
    showDetail(chosen);
    if (focusKey) wrap.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  };

  // Hover previews a part; a click, tap or Enter keeps it (and again lets go)
  wrap.addEventListener('pointerover', (e) => {
    if ((e as PointerEvent).pointerType === 'touch') return;
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key) showDetail(key);
  });
  wrap.addEventListener('pointerout', (e) => {
    const to = (e as PointerEvent).relatedTarget as HTMLElement | null;
    if (!to?.closest?.('[data-key]')) showDetail(chosen);
  });
  wrap.addEventListener('focusin', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key) showDetail(key);
  });
  wrap.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act as DataFlowAction['id'] | undefined;
    if (a) { act(a); return; }
    const part = t.closest<HTMLElement>('[data-key]');
    if (!part) return;
    chosen = chosen === part.dataset.key ? null : part.dataset.key!;
    for (const b of wrap.querySelectorAll<HTMLElement>('[data-key]')) {
      b.setAttribute('aria-pressed', String(b.dataset.key === chosen));
      b.classList.toggle('sd-active', b.dataset.key === chosen);
    }
    showDetail(chosen ?? part.dataset.key!);
  });

  let loading = false, again = false, drawn = '';
  const refresh = async () => {
    if (loading) { again = true; return; }
    loading = true;
    try {
      const s = await currentDataFlowState(fs, { ui: 'desktop' });
      if (!alive) return;
      // Redrawn only when something changed: a redraw under the pointer would swallow a click
      const key = JSON.stringify(s);
      if (key === drawn) return;
      drawn = key;
      state = s;
      root.dataset.ready = '1';
      render();
    } finally {
      loading = false;
      if (again && alive) { again = false; void refresh(); }
    }
  };
  wrap.append(h('p', 'sd-muted', 'Reading this tab\'s state…'));
  void refresh();

  // The state changes elsewhere: a sign-in or sign-out, a relay of the user's own, another tab
  const offNet = onNetworkStatus(() => void refresh());
  const offRelay = onOwnRelayChange(() => void refresh());
  const offFs = fs.onChange((_ev, path) => { if (path === '/home/user/.claude/.credentials.json') void refresh(); });
  const onStorage = () => void refresh();
  window.addEventListener('storage', onStorage);

  const win = wm.createWindow({ appId: 'dataflow', title: 'How Your Data Flows', width: 860, height: 640, minWidth: 320, content: { kind: 'dom', element: root } });
  win.on('close', () => { alive = false; offNet(); offRelay(); offFs(); window.removeEventListener('storage', onStorage); });
  win.on('focus', () => void refresh());
  return win;
}
