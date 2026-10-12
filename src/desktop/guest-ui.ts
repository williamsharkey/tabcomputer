/**
 * The desktop's part of a guest (src/guest.ts, docs/research/GUEST_PROFILE.md):
 * a "Guest" button in the menu bar that states the boundary and discards the
 * guest. The statement comes from boundaryStatement, which only says what the
 * server confirmed.
 */
import { currentBoundaryStatement, discardGuest, type GuestInfo } from '../guest';

let popover: HTMLElement | null = null;

function close(): void {
  popover?.remove();
  popover = null;
  document.removeEventListener('pointerdown', outside, true);
}

function outside(e: Event): void {
  if (popover && !popover.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.sd-mb-guest')) close();
}

async function open(root: HTMLElement, anchor: HTMLElement, guest: GuestInfo): Promise<void> {
  const st = await currentBoundaryStatement();
  if (!st || popover) return;
  const p = document.createElement('div');
  p.className = 'sd-popover sd-guest-pop';
  p.setAttribute('role', 'dialog');
  p.setAttribute('aria-label', 'About this guest');
  const r = anchor.getBoundingClientRect();
  p.style.top = `${r.bottom + 6}px`;
  p.style.right = `${Math.max(8, window.innerWidth - r.right - 8)}px`;
  const h = document.createElement('b');
  h.textContent = st.title;
  p.append(h);
  for (const line of st.lines) {
    const d = document.createElement('p');
    d.className = 'sd-small';
    d.textContent = line;
    p.append(d);
  }
  const row = document.createElement('div');
  row.className = 'sd-row';
  row.style.cssText = 'padding-top:6px;border:0';
  const grow = document.createElement('span');
  grow.className = 'sd-grow';
  const discard = document.createElement('button');
  discard.className = 'sd-btn sd-danger';
  discard.type = 'button';
  discard.dataset.act = 'discard';
  discard.textContent = 'Discard This Guest…';
  // A second click confirms: everything stored here goes
  let armed = false;
  discard.addEventListener('click', () => {
    if (!armed) { armed = true; discard.textContent = guest.ephemeral ? 'Delete everything here' : `Delete "${guest.name}" and everything in it`; return; }
    discardGuest();
  });
  row.append(grow, discard);
  p.append(row);
  p.addEventListener('click', (e) => e.stopPropagation());
  root.appendChild(p);
  popover = p;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

/** Add the Guest button before `before` in the menu bar; the statement shows once by itself. */
export function initGuestUI(root: HTMLElement, menubar: HTMLElement, before: HTMLElement, guest: GuestInfo): void {
  const b = document.createElement('button');
  b.className = 'sd-mb-item sd-mb-status sd-mb-guest';
  b.type = 'button';
  b.textContent = guest.noNetwork ? 'Guest · no network' : 'Guest';
  b.title = 'This window is a guest: what it can and cannot reach';
  b.setAttribute('aria-label', b.title);
  menubar.insertBefore(b, before);
  const toggle = () => { if (popover) close(); else void open(root, b, guest); };
  b.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  // Once per tab: a reload doesn't bring it back
  let shown = false;
  try { shown = sessionStorage.getItem('tabcomputer-guest-stated') === '1'; sessionStorage.setItem('tabcomputer-guest-stated', '1'); } catch { /* no storage */ }
  if (!shown) setTimeout(() => { if (!popover) void open(root, b, guest); }, 1200);
}
