/**
 * What was typed at this tab's terminals since the tab was new, with what
 * `link` needs to turn it into a script (src/link-trim.ts, docs/RUN_LINKS.md
 * "link"): for each line its directory before and after, its exit status,
 * when it ran, the files that changed while it ran, and what it downloaded.
 *
 * The files come from the filesystem's own change events (FileSystem.onChange):
 * nothing is scanned and no copy of any file is kept. An editor's files are
 * read once, when `link` is asked. The Code app says which files it saved
 * (noteEdited), since no command is running when it saves.
 *
 * The log is this tab's: it is kept in sessionStorage, so a reload keeps it
 * and closing the tab ends it. It holds command lines, so it is never sent
 * anywhere; `link` shows the script before anything is shared.
 *
 * No DOM. The terminal calls sessionStart / sessionEnd around each line a
 * person (or a remote peer) entered (src/terminal.ts).
 */
import { netTally, tallySince, type TallyRow } from './net-tally';

export interface SessionEntry {
  /** The line, as entered */
  line: string;
  /** The shell's directory when the line started, and when it ended */
  cwd: string;
  cwdAfter: string;
  /** Its exit status; null while it runs */
  status: number | null;
  /** When it started and ended (ms since the epoch) */
  at: number;
  end: number;
  /** Paths written, made, renamed or removed while it ran (the first CHANGED_MAX; noise left out) */
  changed: string[];
  /** How many more there were */
  more: number;
  /** What the page downloaded while it ran */
  net: TallyRow[];
}

export interface SessionEdit { path: string; at: number }

const KEY = 'tabcomputer-session-log';
const ENTRIES_MAX = 400;
const CHANGED_MAX = 200;
const SAVED_CHANGED_MAX = 40;
const LINE_MAX = 20_000;

/**
 * Changes that say nothing about what a command did: the shell's own history
 * file, scratch and caches, an editor's swap and backup files, the desktop's
 * own state.
 */
export const NOISE = /^\/(tmp|proc|dev|run|sys)(\/|$)|\/\.bash_history$|\/__pycache__(\/|$)|\.pyc$|\/\.cache(\/|$)|\/\.npm\/_(logs|cacache)(\/|$)|\/\.[^/]*\.sw[a-p]$|\.sw[a-p]$|~$|\/\.viminfo$|\/4913$|^\/var\/lib\/tabcomputer(\/|$)|\/\.local\/state(\/|$)|\/\.nano\/|\/\.lesshst$/;

let entries: SessionEntry[] = [];
let edits: SessionEdit[] = [];
const running = new Map<SessionEntry, TallyRow[]>();
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function storage(): Storage | null {
  try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const saved = JSON.parse(storage()?.getItem(KEY) ?? 'null') as { entries?: SessionEntry[]; edits?: SessionEdit[] } | null;
    if (Array.isArray(saved?.entries)) {
      // (a line that was running when the page went away did not finish)
      entries = saved!.entries.filter((e) => e && typeof e.line === 'string').map((e) => ({ ...e, status: e.status ?? -1, changed: Array.isArray(e.changed) ? e.changed : [], net: Array.isArray(e.net) ? e.net : [] }));
    }
    if (Array.isArray(saved?.edits)) edits = saved!.edits.filter((e) => e && typeof e.path === 'string');
  } catch { /* nothing saved, or not ours */ }
}

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      storage()?.setItem(KEY, JSON.stringify({
        entries: entries.map((e) => ({ ...e, changed: e.changed.slice(0, SAVED_CHANGED_MAX), more: e.more + Math.max(0, e.changed.length - SAVED_CHANGED_MAX) })),
        edits,
      }));
    } catch { /* full, or no storage: the log is then this page's only */ }
  }, 800);
}

/** A line was entered at a terminal. Returns its record, to hand to sessionEnd. */
export function sessionStart(line: string, cwd: string): SessionEntry {
  load();
  const e: SessionEntry = { line: line.length > LINE_MAX ? line.slice(0, LINE_MAX) : line, cwd, cwdAfter: cwd, status: null, at: Date.now(), end: 0, changed: [], more: 0, net: [] };
  entries.push(e);
  if (entries.length > ENTRIES_MAX) entries.splice(0, entries.length - ENTRIES_MAX);
  let before: TallyRow[] = [];
  try { before = netTally(); } catch { /* no record of requests here */ }
  running.set(e, before);
  return e;
}

/** The line ended with `status`, leaving the shell in `cwd` */
export function sessionEnd(e: SessionEntry, status: number, cwd: string): void {
  e.status = status;
  e.cwdAfter = cwd;
  e.end = Date.now();
  const before = running.get(e);
  running.delete(e);
  if (before) { try { e.net = tallySince(before, netTally()); } catch { /* as above */ } }
  save();
}

let background = 0;
/**
 * Work the page does by itself while `work` is pending (boot's preinstalls):
 * what it writes is outside home, so until it ends a change outside home
 * belongs to no line. Without this, the package list a preinstall writes
 * while `vi notes.txt` is open would read as a file that vi wrote.
 */
export function sessionBackground<T>(work: Promise<T>): Promise<T> {
  background++;
  const over = () => { background--; };
  work.then(over, over);
  return work;
}

/** A filesystem change: it belongs to the lines running now */
export function sessionChange(path: string): void {
  if (!running.size || NOISE.test(path)) return;
  if (background > 0 && !path.startsWith('/home/')) return;
  for (const e of running.keys()) {
    if (e.changed.length >= CHANGED_MAX) e.more++;
    else if (!e.changed.includes(path)) e.changed.push(path);
  }
}

/** Watch a filesystem's change events (once per filesystem) */
export function watchSessionFs(fs: { onChange(listener: (event: string, path: string, newPath?: string) => void): () => void }): () => void {
  return fs.onChange((event, path, newPath) => {
    if (event === 'attrib') return;
    sessionChange(path);
    if (newPath) sessionChange(newPath);
  });
}

/** An editor that is not a command (the Code app) saved `path` */
export function noteEdited(path: string): void {
  load();
  if (NOISE.test(path)) return;
  const last = edits[edits.length - 1];
  if (last?.path === path) { last.at = Date.now(); return; }
  edits.push({ path, at: Date.now() });
  if (edits.length > 2000) edits.splice(0, edits.length - 2000);
  save();
}

/** The lines entered since the tab was new, oldest first, and the files an editor saved */
export function sessionLog(): { entries: SessionEntry[]; edits: SessionEdit[] } {
  load();
  return { entries: entries.map((e) => ({ ...e, changed: [...e.changed] })), edits: edits.map((e) => ({ ...e })) };
}

/** Tests: start over */
export function resetSessionLog(): void {
  entries = [];
  edits = [];
  running.clear();
  loaded = true;
  try { storage()?.removeItem(KEY); } catch { /* no storage */ }
}
