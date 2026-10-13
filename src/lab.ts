/**
 * The classroom workspace (docs/CLASSROOM.md, tabcomputer#130): a class
 * repository opened from a lab link (`?run=lab:owner/repo`, src/run-url.ts),
 * its config file, Submit, and the "not saved to GitHub yet" state.
 *
 *   .tabcomputer/lab.json   { "lab": 1, "toolchains": ["python"], "run": "…", "test": "…" }
 *
 * No DOM here except the tab's title: the Code app (src/commands/code-editor.ts)
 * and the `lab` command (src/commands/lab.ts) are the two callers. Git state is
 * read with isomorphic-git (src/desktop/gitstatus.ts); Submit runs the builtin
 * git, so what it says does not depend on which git is installed.
 */
import type { FileSystem } from './filesystem';
import { findRepo, upstreamOf } from './desktop/gitstatus';
import { DECEPTIVE, originRepo, shq } from './run-url';

/** The config file, in the repository (beside `.tabcomputer/run.sh`, a run link's script) */
export const LAB_CONFIG_PATH = '.tabcomputer/lab.json';
export const LAB_FORMAT = 1;
const KNOWN_KEYS = ['lab', 'name', 'toolchains', 'run', 'test'];
const TOOLCHAIN_ID = /^[a-z][a-z0-9-]{0,31}$/;
const COMMAND_MAX = 500;

export interface LabConfig {
  /** Shown beside the buttons */
  name: string;
  /** Sets `toolchain install` applies when the lab opens */
  toolchains: string[];
  /** Shell lines, run in the lab's folder in a Terminal: '' when the file names none */
  run: string;
  test: string;
}

/** A lab.json's text as a config, or every problem with it (each names its key, like app.json's) */
export function parseLabConfig(text: string): { config: LabConfig | null; problems: string[] } {
  const problems: string[] = [];
  const bad = (msg: string) => { problems.push(`lab.json: ${msg}`); };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { config: null, problems: ['lab.json: it is not JSON'] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: null, problems: ['lab.json: it must be an object, like { "lab": 1, "run": "python3 main.py" }'] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KNOWN_KEYS.includes(k)) bad(`unknown key ${k} (known: ${KNOWN_KEYS.join(', ')})`);
  if (o.lab !== LAB_FORMAT) bad(typeof o.lab === 'number' && o.lab > LAB_FORMAT ? `lab is ${o.lab}: this build reads format ${LAB_FORMAT}` : `lab must be ${LAB_FORMAT} (the format's version)`);
  const line = (key: 'run' | 'test' | 'name', max: number): string => {
    const v = o[key];
    if (v === undefined) return '';
    if (typeof v !== 'string' || !v.trim()) { bad(`${key} must be text`); return ''; }
    if (v.length > max) { bad(`${key} is longer than ${max} characters`); return ''; }
    if (DECEPTIVE.test(v) || /[\n\t]/.test(v)) { bad(`${key} must be one line, without control or invisible characters`); return ''; }
    return v.trim();
  };
  const toolchains: string[] = [];
  if (o.toolchains !== undefined) {
    if (!Array.isArray(o.toolchains) || o.toolchains.length > 8) bad('toolchains must be a list of at most 8 names, like ["python"]');
    else for (const t of o.toolchains) {
      if (typeof t !== 'string' || !TOOLCHAIN_ID.test(t)) bad(`toolchains has a name that is not a toolchain id (got ${JSON.stringify(t)}; toolchain list shows them)`);
      else if (!toolchains.includes(t)) toolchains.push(t);
    }
  }
  const config: LabConfig = { name: line('name', 60), toolchains, run: line('run', COMMAND_MAX), test: line('test', COMMAND_MAX) };
  return problems.length ? { config: null, problems } : { config, problems };
}

type ReadFs = Pick<FileSystem, 'readFile' | 'exists'>;

export interface FoundLab {
  /** The folder the config is in: where Run and Test run */
  dir: string;
  config: LabConfig | null;
  problems: string[];
}

/** The lab config of `dir`: its own, else the one at the top of its repository. Null when neither has one. */
export async function readLabConfig(fs: FileSystem, dir: string): Promise<FoundLab | null> {
  const dirs = [dir];
  const repo = await findRepo(fs, dir).catch(() => null);
  if (repo && repo.root !== dir) dirs.push(repo.root);
  for (const d of dirs) {
    const path = `${d}/${LAB_CONFIG_PATH}`;
    if (!(await (fs as ReadFs).exists(path).catch(() => false))) continue;
    let text: string;
    try { text = await fs.readFile(path, 'utf8') as string; } catch { return { dir: d, config: null, problems: ['lab.json: it could not be read'] }; }
    return { dir: d, ...parseLabConfig(text) };
  }
  return null;
}

// ── Git state ──

export interface LabState {
  /** The repository's top folder */
  root: string;
  branch: string | null;
  /** `owner/repo` on github.com that origin names; '' when origin is elsewhere or missing */
  remote: string;
  /** Files changed, added or deleted and not committed */
  changed: number;
  /** Commits GitHub does not have */
  ahead: number;
  /** The branch has commits and was never pushed */
  neverPushed: boolean;
  /** Newest commit, short; '' in a repository without one */
  head: string;
  /** There is work GitHub does not have (false when origin is not a GitHub repository: nowhere to save it to) */
  unsaved: boolean;
}

let lib: Promise<typeof import('isomorphic-git')> | null = null;
const git = () => (lib ??= import('isomorphic-git'));

/** The git state of the repository `dir` is in, or null when it is in none (or in a linked worktree, which this cannot read) */
export async function labState(fs: FileSystem, dir: string): Promise<LabState | null> {
  const repo = await findRepo(fs, dir).catch(() => null);
  if (!repo || repo.worktree) return null;
  const remote = originRepo(await fs.readFile(`${repo.gitdir}/config`, 'utf8').catch(() => '') as string);
  const g = await git();
  const gfs = fs.toIsomorphicGitFS();
  let head = '';
  try { head = (await g.resolveRef({ fs: gfs, dir: repo.root, ref: 'HEAD' })).slice(0, 7); } catch { /* no commit yet */ }
  let changed = 0;
  try {
    for (const [, h, w, s] of await g.statusMatrix({ fs: gfs, dir: repo.root })) if (!(h === 1 && w === 1 && s === 1)) changed++;
  } catch { /* an unreadable index: counted as no change */ }
  const up = await upstreamOf(fs, repo);
  const neverPushed = !!head && !up.upstream;
  return {
    root: repo.root, branch: up.branch, remote, changed, ahead: up.ahead, neverPushed, head,
    unsaved: !!remote && (changed > 0 || up.ahead > 0 || neverPushed),
  };
}

const count = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Why the work is not on GitHub, in a few words ('' when it is) */
export function unsavedReason(s: LabState | null, buffers = 0): string {
  const parts: string[] = [];
  if (buffers > 0) parts.push(`${count(buffers, 'file')} with edits not saved`);
  if (s?.unsaved) {
    if (s.changed > 0) parts.push(`${count(s.changed, 'changed file')}`);
    if (s.ahead > 0) parts.push(`${count(s.ahead, 'commit')} not pushed`);
    else if (s.neverPushed) parts.push(`branch ${s.branch ?? ''} was never pushed`.replace('  ', ' '));
  }
  return parts.join(', ');
}

/** The mark the Code app shows */
export const UNSAVED_TEXT = 'Not saved to GitHub yet';
export const SAVED_TEXT = 'Saved to GitHub';

// ── Submit ──

export interface SubmitResult { ok: boolean; text: string }

export interface SubmitDeps {
  /** Run a shell line in the repository's top folder; its status and everything it printed */
  run(line: string): Promise<{ code: number; out: string }>;
  now?(): Date;
}

const lastLine = (out: string) => out.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).pop()?.replace(/^(error|fatal):\s*/i, '') ?? '';

/** Why GitHub did not take a push, as a sentence that ends the "Not submitted" message */
function pushFailure(out: string, where: string): string {
  if (/not signed in/i.test(out)) return 'This tab is not signed in to GitHub. Sign in (Settings, Accounts), then press Submit again.';
  if (/authentication failed|HTTP 40[13]|\b40[13]\b|permission|denied/i.test(out)) return `GitHub refused this account for ${where}. Sign in again, or ask the teacher whether this account may push there.`;
  if (/new commits|non-fast-forward|not a fast.forward|pull first|rejected/i.test(out)) return 'GitHub has commits this computer does not have. Run "git pull" in the Terminal, then press Submit again.';
  if (/failed to fetch|network|could not connect|offline|timed? ?out/i.test(out)) return 'GitHub could not be reached. Check the connection, then press Submit again.';
  const why = lastLine(out);
  return why ? `git said: ${why}` : 'git push failed without saying why. Run "git push" in the Terminal to see more.';
}

/**
 * Submit: `git add -A && git commit && git push`, and the result in plain
 * words: what went where, or why it did not. Never throws.
 */
export async function submitLab(fs: FileSystem, dir: string, deps: SubmitDeps): Promise<SubmitResult> {
  try {
    const before = await labState(fs, dir);
    if (!before) return { ok: false, text: 'Not submitted. This folder is not a git repository, so there is nowhere to send it.' };
    if (!before.remote) return { ok: false, text: 'Not submitted. This repository has no GitHub address (its origin remote is missing or is not on github.com).' };
    const where = `github.com/${before.remote}`;
    const branch = before.branch ?? '';
    if (!branch || !/^[A-Za-z0-9._/-]+$/.test(branch)) return { ok: false, text: 'Not submitted. This repository is not on a branch. Run "git status" in the Terminal to see where it is.' };
    let committed = 0;
    if (before.changed > 0) {
      const add = await deps.run('builtin git add -A');
      if (add.code !== 0) return { ok: false, text: `Not submitted. git add failed: ${lastLine(add.out) || `status ${add.code}`}` };
      const stamp = (deps.now?.() ?? new Date()).toISOString().slice(0, 16).replace('T', ' ');
      const commit = await deps.run(`builtin git commit -m ${shq(`Submit ${stamp} UTC`)}`);
      if (commit.code !== 0) return { ok: false, text: `Not submitted. The files are still only on this computer, because git commit failed: ${lastLine(commit.out) || `status ${commit.code}`}` };
      committed = before.changed;
    }
    const mid = await labState(fs, dir);
    if (mid && !mid.unsaved) return { ok: true, text: `Nothing to submit. GitHub already has this work (${where}, branch ${branch}).` };
    const push = await deps.run(`builtin git push origin ${shq(branch)}`);
    const after = await labState(fs, dir);
    if (push.code !== 0 || after?.unsaved) {
      const kept = committed ? `${count(committed, 'changed file')} ${committed === 1 ? 'is' : 'are'} committed on this computer only. ` : 'The work is on this computer only. ';
      return { ok: false, text: `Not submitted. ${kept}${pushFailure(push.out, where)}` };
    }
    const what = committed ? count(committed, 'changed file') : count(mid?.ahead || 1, 'commit');
    return { ok: true, text: `Submitted. ${what} went to ${where}, branch ${branch}. The newest commit there is ${after?.head ?? ''}.` };
  } catch (e) {
    return { ok: false, text: `Not submitted. ${(e as Error)?.message ?? e}` };
  }
}

// ── Open folders: the mark, the tab's title, the warning before the tab closes ──

interface OpenLab { dir: string; state: LabState | null; buffers: number }
const openLabs = new Set<OpenLab>();
let leaving = false;

/** Folders open in the Code app with work GitHub does not have */
export function unsavedWork(): string[] {
  if (leaving) return [];
  return [...openLabs].filter((l) => l.state?.unsaved || (l.buffers > 0 && !!l.state?.remote)).map((l) => l.state?.root ?? l.dir);
}

/** The page is being left on purpose (the shared-computer sign-out): no warning */
export function leavingOnPurpose(): void { leaving = true; }

const TITLE_MARK = '● ';
function markTabTitle(): void {
  if (typeof document === 'undefined') return;
  const base = document.title.startsWith(TITLE_MARK) ? document.title.slice(TITLE_MARK.length) : document.title;
  const want = unsavedWork().length ? TITLE_MARK + base : base;
  if (document.title !== want) document.title = want;
}

/** What the Code window's host gives the lab (src/commands/code-editor.ts) */
export interface LabEditorHost {
  fs: FileSystem;
  /** The folder the window shows */
  dir: string;
  /** A message to the editor's frame */
  post(msg: Record<string, unknown>): void;
  /** The window's title mark: '' clears it */
  setMark(text: string): void;
  /** Resolves when the editor's saves have reached the filesystem */
  flush(): Promise<void>;
  /** Type `command` in a Terminal in `cwd`. Null when it started, else why it did not. */
  runInTerminal(cwd: string, command: string, title: string): string | null;
  /** Run a line in `cwd` without a terminal */
  exec(cwd: string, line: string): Promise<{ code: number; out: string }>;
}

export interface LabEditor {
  /** A message from the editor's frame */
  message(data: { type?: string; action?: string; count?: number }): void;
  dispose(): void;
}

/**
 * The lab side of one Code window: the Run / Test / Submit bar when the folder
 * has a config, the saved mark when it is a clone of a GitHub repository, kept
 * current from filesystem events (nothing polls).
 */
export function attachLab(host: LabEditorHost): LabEditor {
  const me: OpenLab = { dir: host.dir, state: null, buffers: 0 };
  openLabs.add(me);
  (globalThis as { __tabcomputerUnsavedWork?: () => boolean }).__tabcomputerUnsavedWork = () => unsavedWork().length > 0;
  let lab: FoundLab | null = null;
  let disposed = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false, again = false;

  const sendState = () => {
    const tracked = !!me.state?.remote;
    const unsaved = tracked && (!!me.state?.unsaved || me.buffers > 0);
    host.post({ type: 'shiro-editor-git', tracked, unsaved, text: tracked ? (unsaved ? UNSAVED_TEXT : SAVED_TEXT) : '', detail: unsavedReason(me.state, me.buffers) });
    host.setMark(unsaved ? UNSAVED_TEXT.toLowerCase() : '');
    markTabTitle();
  };
  const sendBar = () => {
    host.post({
      type: 'shiro-editor-lab', show: !!lab,
      name: lab?.config?.name ?? '', run: !!lab?.config?.run, test: !!lab?.config?.test, submit: !!lab?.config,
      problem: lab && !lab.config ? lab.problems.join(' · ') : '',
    });
  };
  const refresh = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const [found, state] = await Promise.all([readLabConfig(host.fs, host.dir).catch(() => null), labState(host.fs, host.dir).catch(() => null)]);
        if (disposed) return;
        lab = found;
        me.state = state;
        sendBar();
        sendState();
      } while (again);
    } finally { running = false; }
  };
  const top = () => me.state?.root ?? host.dir;
  const off = host.fs.onChange((_ev, path) => {
    if (disposed || typeof path !== 'string') return;
    const root = top();
    if (path !== root && !path.startsWith(root + '/')) return;
    // (loose objects arrive in bursts and change nothing by themselves: the refs and the index follow)
    if (path.includes('/.git/objects/')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refresh(); }, 400);
  });
  void refresh();

  const say = (ok: boolean | null, text: string) => host.post({ type: 'shiro-editor-result', ok, text, busy });
  const act = async (action: string) => {
    if (busy) return;
    await host.flush();
    lab = await readLabConfig(host.fs, host.dir).catch(() => null);
    sendBar();
    if (!lab?.config) { say(false, lab ? lab.problems.join(' · ') : `This folder has no ${LAB_CONFIG_PATH}.`); return; }
    if (action === 'run' || action === 'test') {
      const command = action === 'run' ? lab.config.run : lab.config.test;
      if (!command) { say(false, `${LAB_CONFIG_PATH} names no ${action} command.`); return; }
      const why = host.runInTerminal(lab.dir, command, action === 'run' ? 'Run' : 'Test');
      say(why ? false : null, why ?? `${action === 'run' ? 'Run' : 'Test'} started in the Terminal: ${command}`);
      return;
    }
    if (action !== 'submit') return;
    busy = true;
    say(null, 'Submitting to GitHub…');
    const result = await submitLab(host.fs, top(), { run: (line) => host.exec(top(), line) });
    busy = false;
    if (disposed) return;
    say(result.ok, result.text);
    void refresh();
  };

  return {
    message(data) {
      if (disposed) return;
      if (data.type === 'shiro-editor-ready') { sendBar(); sendState(); }
      else if (data.type === 'shiro-editor-dirty') { me.buffers = Math.max(0, Number(data.count) || 0); sendState(); }
      else if (data.type === 'shiro-editor-action' && typeof data.action === 'string') void act(data.action);
    },
    dispose() {
      disposed = true;
      off();
      if (timer) clearTimeout(timer);
      openLabs.delete(me);
      markTabTitle();
    },
  };
}
