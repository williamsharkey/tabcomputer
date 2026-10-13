/**
 * The window a run link opens for a script that isn't curated (src/run-url.ts,
 * docs/RUN_LINKS.md): the whole script, where it came from, what the link
 * sets, and Run / Cancel. Nothing runs unless the person chooses Run.
 * A shared seed (/s/ID) and a repository link (/USER/REPO) ask in the same
 * window, with their own words (src/inbound-link.ts).
 *
 * Everything from the link or the script is put in with textContent, so a
 * script can't add markup to its own prompt. Cancel has the focus, and Run is
 * off for a moment after the window appears, so a click or Enter already on
 * its way doesn't start anything.
 *
 * The window shows everything that runs. It says how many lines the box
 * holds, and Run stays off until the end of the box has been on screen: a
 * text that fits needs nothing, a longer one is scrolled to its end. A
 * script's `# on-open:` line is a command, so it has a row of its own.
 */
import type { RunPromptInfo } from './run-url';
import type { DesktopAPI, DesktopWindow } from './desktop/wm';
import { overlay, phoneScreen } from './apps/surface';

const STYLE_ID = 'tc-run-prompt-style';
const RUN_ARMS_AFTER_MS = 700;

const CSS = `
.tc-run-prompt { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 16px;
  font: 13px/1.45 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-run-prompt * { box-sizing: border-box; }
.tc-run-prompt h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tc-run-prompt p { margin: 0; color: var(--sd-text-2, #a4a8b8); overflow-wrap: anywhere; }
.tc-run-prompt .tc-run-warn { color: var(--sd-text, #e6e6f0); }
.tc-run-prompt pre { flex: 1 1 120px; min-height: 80px; margin: 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12px/1.5 var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; user-select: text; -webkit-user-select: text; }
.tc-run-prompt dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; font: 12px/1.5 var(--sd-mono, ui-monospace, monospace); max-height: 96px; overflow: auto; }
.tc-run-prompt dt { color: var(--sd-text-2, #a4a8b8); }
.tc-run-prompt dd { margin: 0; overflow-wrap: anywhere; }
.tc-run-prompt .tc-run-after code { display: block; margin-top: 2px; padding: 4px 8px; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12px/1.5 var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 6px; user-select: text; -webkit-user-select: text; }
.tc-run-actions { display: flex; gap: 8px; justify-content: flex-end; flex: none; }
.tc-run-actions button { font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-run-actions button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-run-actions button[data-act=run] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
.tc-run-actions button:disabled { opacity: .5; cursor: default; }
.tc-full .tc-run-prompt pre { flex: 0 1 auto; min-height: 60px; }
.tc-full .tc-run-actions { margin-top: auto; }
.tc-full .tc-run-actions button { flex: 1; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** How many lines a text has (a last line without its line end counts) */
export function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Whether the end of a scrolling box is on screen: everything fits, or it was
 * scrolled to its last line. False while the box has no size yet (not in the
 * page, hidden), so nothing counts as read before it could be.
 */
export function endInView(box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  if (!(box.clientHeight > 0) || !(box.scrollHeight > 0)) return false;
  return box.scrollHeight - box.clientHeight - box.scrollTop <= 2;
}

/** The prompt's content. `done(true)` only from the Run button. */
export function buildRunPrompt(info: RunPromptInfo, done: (run: boolean) => void): HTMLElement {
  const root = el('div', '', 'tc-run-prompt');
  root.setAttribute('role', 'dialog');
  // (a seed or a repository link brings its own words: src/inbound-link.ts)
  const w = info.wording;
  root.setAttribute('aria-label', w ? w.window : 'Run a script from a link');
  // The question, where it is from, the whole text, and one sentence on what it can touch
  root.append(el('h3', w ? w.title : 'Run this script?'));
  root.append(el('p', `From ${info.from}. Not reviewed by tabcomputer.`));
  const pre = el('pre', info.script);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', w ? w.box : 'The script');
  root.append(pre);
  // How much there is to read, and what is still asked of the reader while Run is off
  const n = lineCount(info.script);
  const lines = `${n} ${n === 1 ? 'line' : 'lines'}`;
  const count = el('p', w ? `${w.box}: ${lines}.` : `The script has ${lines}.`, 'tc-run-count');
  const hint = el('span', ` Scroll to the end to turn ${w ? w.action : 'Run'} on.`);
  hint.hidden = true;
  count.append(hint);
  root.append(count);
  // (the on-open line runs as a command; in the box it reads as a comment)
  if (info.after) {
    const after = el('p', w ? 'After the commands, this runs:' : 'After the script, this runs:', 'tc-run-after');
    after.append(el('code', info.after));
    root.append(after);
  }
  const vars = Object.entries(info.env);
  if (vars.length || info.ignored.length) {
    const dl = el('dl');
    for (const [k, v] of vars) dl.append(el('dt', k), el('dd', v));
    if (info.ignored.length) dl.append(el('dt', 'ignored'), el('dd', `${info.ignored.join(', ')} (not in its "# args:" header)`));
    root.append(dl);
  }
  root.append(el('p', w ? w.warn : 'It runs as you: it can read and change every file in this tab and use its sign-ins (Claude, GitHub).', 'tc-run-warn'));
  // (said only when Run does something other than run it all: it ran here before)
  const where = w ? w.where : info.onOpenOnly === undefined ? ''
    : info.onOpenOnly ? `It already ran here. Run only does its on-open line: ${info.onOpenOnly}` : 'It already ran here. Run only opens a Terminal in its directory.';
  if (where) root.append(el('p', where));
  const actions = el('div', '', 'tc-run-actions');
  const cancel = el('button', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.act = 'cancel';
  const run = el('button', w ? w.action : 'Run');
  run.type = 'button';
  run.dataset.act = 'run';
  // Run is on once the moment has passed and the end of the box has been on screen
  run.disabled = true;
  let timeUp = false;
  let seenEnd = false;
  const arm = () => {
    if (!seenEnd && endInView(pre)) seenEnd = true;
    run.disabled = !(timeUp && seenEnd);
    hint.hidden = seenEnd || !timeUp;
  };
  pre.addEventListener('scroll', arm);
  // (the window is laid out after this returns, and its size can change)
  if (typeof ResizeObserver === 'function') new ResizeObserver(arm).observe(pre);
  setTimeout(() => { timeUp = true; arm(); }, RUN_ARMS_AFTER_MS);
  cancel.addEventListener('click', () => done(false));
  run.addEventListener('click', (e) => { if (e.isTrusted !== false && !run.disabled) done(true); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
  actions.append(cancel, run);
  root.append(actions);
  return root;
}

/** Ask before running a script that isn't curated. Resolves true only for Run; closing the window is Cancel. */
export function showRunPrompt(info: RunPromptInfo, wm: DesktopAPI | null): Promise<boolean> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let close = () => {};
    const done = (run: boolean) => {
      if (settled) return;
      settled = true;
      close();
      resolve(run);
    };
    const content = buildRunPrompt(info, done);
    let win: DesktopWindow | null = null;
    // A phone has no room for a desktop around a question: the prompt is the screen
    const full = phoneScreen();
    if (wm && !full) {
      const wa = wm.workArea();
      const w = win = wm.createWindow({
        // Above windows the session restores after it (they take the focus when they come back)
        appId: 'run-link', title: info.wording?.window ?? 'Run link', alwaysOnTop: true, content: { kind: 'dom', element: content },
        width: Math.min(600, Math.max(280, wa.width - 40)), height: Math.min(460, Math.max(260, wa.height - 80)), minWidth: 280, minHeight: 240,
      });
      close = () => { w.close(true); };
      w.on('close', () => done(false));
    } else close = overlay(content, { full });
    // Cancel has the focus, also after the desktop has finished its own boot-time focusing
    const cancel = content.querySelector<HTMLButtonElement>('[data-act=cancel]');
    const focus = () => { if (!settled) { win?.focus(); cancel?.focus(); } };
    focus();
    setTimeout(focus, RUN_ARMS_AFTER_MS);
  });
}
