/**
 * `link`'s rules (docs/RUN_LINKS.md "link", tabcomputer#147): from what was
 * typed at this tab's terminals, the shortest script that gets another
 * person to the same place. Rules only; no model reads the session.
 *
 *   kept      a line that succeeded and changed something: it wrote, made or
 *             removed files (clones, builds, redirects), it installed
 *             something (pip, npm, apt, pkg, toolchain: by name), or it set
 *             the shell up (export, alias, source)
 *   dropped   a line that failed; looking around (ls, cat, pwd, git status,
 *             --help, man, history, clear); a line that changed nothing; a
 *             line that is entered again later, word for word, in the same
 *             folder; `link` itself; what was typed inside a program; a line
 *             that may hold a secret (`export API_KEY=…`, text shaped like a token)
 *   cd        never kept as typed: each kept line is given the folder it ran
 *             in, with one `cd` where the folder changes, and one at the end
 *             for where the shell is now. A cd that nets out leaves nothing
 *   editors   vim, nano and the Code app are not replayed. A file one of
 *             them wrote is recorded as a here-document with what it holds
 *             now, where it was first edited, if it is small text. Anything
 *             else is named under "not in the link"
 *   a program that is still running, or that the person stopped with Ctrl-C
 *             after a few seconds (a server): the last one is kept, at the end
 *
 * No DOM and no filesystem: the caller hands over the session (src/session-log.ts)
 * and what the edited files hold now.
 */

export interface TrimEntry {
  line: string;
  cwd: string;
  cwdAfter: string;
  /** null: still running */
  status: number | null;
  at: number;
  end: number;
  changed: string[];
  more?: number;
}

/** What an edited file holds now */
export type FileNow = { text: string } | { missing: true } | { skip: 'binary' | 'large' | 'folder'; size: number };

export interface TrimInput {
  entries: TrimEntry[];
  /** Files an editor that is not a command (the Code app) saved */
  edits?: { path: string; at: number }[];
  home: string;
  /** Where the shell is now */
  cwd: string;
  /** What each edited file holds now (editedPaths says which to look up) */
  files: Map<string, FileNow>;
  /** The commands of a link this tab was opened with, by their folder's name under ~/run */
  linked?: Map<string, string>;
}

export interface Trimmed {
  script: string;
  /** The lines of the session that are in the script, as typed */
  kept: { line: string; why: string }[];
  dropped: { line: string; why: string }[];
  /** Files in the script as here-documents */
  files: string[];
  /** What the script cannot carry, each as a sentence */
  notInLink: string[];
}

/** The largest file recorded as a here-document, in characters */
export const FILE_TEXT_MAX = 20_000;
/** A program stopped with Ctrl-C after at least this long was running, not failing */
const RAN_MS = 3000;

const LOOK = new Set([
  'ls', 'll', 'la', 'l', 'dir', 'tree', 'pwd', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'free', 'ps', 'top', 'htop',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'fd', 'locate', 'which', 'whereis', 'type', 'whoami', 'id', 'hostname', 'uname', 'date', 'cal', 'uptime',
  'env', 'printenv', 'echo', 'printf', 'man', 'help', 'info', 'history', 'clear', 'reset', 'jobs', 'fg', 'bg', 'true', ':', 'diff', 'cmp', 'md5sum', 'sha256sum',
  'doctor', 'dataflow', 'dmesg', 'lsof', 'nproc', 'tty', 'realpath', 'basename', 'dirname', 'test', '[', 'sleep', 'wait', 'open', 'xdg-open', 'watchdog', 'console',
]);
const GIT_LOOK = new Set(['status', 'log', 'diff', 'show', 'blame', 'reflog', 'shortlog', 'describe', 'ls-files', 'ls-remote', 'rev-parse', 'grep', 'help', 'version']);
const LOOK_SUB: Record<string, Set<string>> = {
  git: GIT_LOOK,
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'help', 'whoami', 'search', 'doctor']),
  pip: new Set(['list', 'show', 'freeze', 'help', 'check', 'search']),
  pip3: new Set(['list', 'show', 'freeze', 'help', 'check', 'search']),
  apt: new Set(['list', 'search', 'show', 'policy']),
  'apt-cache': new Set(['search', 'show', 'policy', 'depends']),
  pkg: new Set(['list', 'available', 'search', 'info', 'outdated']),
  toolchain: new Set(['list', 'status']),
  app: new Set(['list', 'check', 'templates', 'help']),
  gh: new Set(['status']),
  docker: new Set(['ps', 'images']),
  debian: new Set(['status']),
};
const EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'micro', 'ed', 'code', 'edit', 'notepad']);
/** Programs a person works inside: what was done there is not a line of the session */
const INSIDE = new Set(['claude', 'claude-window', 'sc', 'codex', 'gemini', 'aider', 'ssh', 'tmux', 'screen', 'ftp', 'sftp', 'telnet']);
const REPLS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'psql', 'sqlite3', 'irb', 'lua', 'ipython', 'bc', 'gdb']);
const STATE = new Set(['export', 'alias', 'unalias', 'unset', 'source', '.', 'set', 'shopt', 'umask', 'ulimit', 'declare', 'typeset', 'readonly', 'eval', 'hash']);
const CD = new Set(['cd', 'pushd', 'popd']);
const WRAPPERS = new Set(['sudo', 'time', 'command', 'builtin', 'nice', 'nohup', 'env', 'exec']);

interface Simple { words: string[]; redirects: boolean }

/**
 * A line as its simple commands: split at `&&`, `||`, `;`, `|` and line
 * breaks outside quotes. `redirects`: it writes a file (`>`, `>>`, `tee`).
 * A here-document's body is skipped. Good enough to tell `ls | grep x` from
 * `curl … | sh`; it is not a shell.
 */
export function simpleCommands(line: string): Simple[] {
  const out: Simple[] = [];
  let words: string[] = [], word = '', has = false, redirects = false, quote = '';
  const endWord = () => { if (has) words.push(word); word = ''; has = false; };
  const endCommand = () => { endWord(); if (words.length) out.push({ words, redirects: redirects || words.includes('tee') }); words = []; redirects = false; };
  const text = line.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, (m) => m.slice(0, m.indexOf('\n')));
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < text.length) { word += text[++i]; has = true; continue; }
    if (c === '#' && !has) { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (c === '\n' || c === ';') { endCommand(); continue; }
    if (c === '&' || c === '|') {
      // (the & of &> belongs to the redirection)
      if (c === '&' && text[i + 1] === '>') { endWord(); word = '&'; has = true; continue; }
      if (text[i + 1] === c) i++;
      endCommand();
      continue;
    }
    if (c === '>') {
      const m = /^>>?\s*(&[0-9-]|[^\s;&|<>]*)/.exec(text.slice(i))!;
      // (to one of the screen's own streams, or to nowhere, writes no file)
      if (!/^&[0-9-]$/.test(m[1]) && !/^\/dev\/(null|stdout|stderr|tty)$/.test(m[1])) redirects = true;
      // a number, or &, just before > names the stream: it is not a word
      if (has && /^(&|[0-9]+)$/.test(word)) { word = ''; has = false; } else endWord();
      i += m[0].length - 1;
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c;
    has = true;
  }
  endCommand();
  return out;
}

/** The program a simple command runs, past assignments and wrappers (`FOO=1 sudo make` is make) */
function program(words: string[]): { name: string; args: string[] } {
  let i = 0;
  let wrapper = '';
  for (; i < words.length; i++) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    if (WRAPPERS.has(w)) { wrapper = w; continue; }
    // a wrapper's own options (sudo -u NAME, env -i)
    if (wrapper && w.startsWith('-')) { if (wrapper === 'sudo' && /^-[ugh]$/.test(w)) i++; continue; }
    break;
  }
  // (a wrapper with nothing after it is the program: `env` alone lists the environment)
  if (i >= words.length) return { name: wrapper, args: [] };
  return { name: words[i].replace(/^.*\//, ''), args: words.slice(i + 1) };
}

const isLook = (s: Simple): boolean => {
  const { name, args } = program(s.words);
  // (no program at all is an assignment, `X=1`: that sets the shell up)
  if (s.redirects || !name) return false;
  if (args.length && args.every((a) => a === '--help' || a === '-h' || a === '--version' || a === '-V' || a === '-version')) return true;
  if (LOOK.has(name)) return !(name === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir'));
  const sub = args.find((a) => !a.startsWith('-'));
  if (name === 'git' && sub === 'branch') return args.filter((a) => !a.startsWith('-')).length === 1;
  if (name === 'git' && (sub === 'remote' || sub === 'stash' || sub === 'tag' || sub === 'config')) return args.filter((a) => !a.startsWith('-')).length === 1 || args.includes('-l') || args.includes('--list') || args.includes('--get');
  return !!sub && !!LOOK_SUB[name]?.has(sub);
};

export type LineKind = 'link' | 'look' | 'cd' | 'editor' | 'inside' | 'state' | 'command';

/** What kind of line this is, by its words alone */
export function lineKind(line: string): LineKind {
  const cmds = simpleCommands(line);
  if (!cmds.length) return 'look';
  const first = program(cmds[0].words);
  if (cmds.length === 1 && first.name === 'link') return 'link';
  const cds = cmds.filter((c) => CD.has(program(c.words).name));
  const rest = cmds.filter((c) => !CD.has(program(c.words).name));
  // (before the editors and the programs one works inside: `vim --version` and `python3 --version` only look)
  if (rest.every(isLook)) return cds.length ? 'cd' : 'look';
  if (cmds.length === 1 && EDITORS.has(first.name)) return 'editor';
  if (cmds.length === 1 && (INSIDE.has(first.name) || (REPLS.has(first.name) && !first.args.some((a) => !a.startsWith('-')) && !first.args.includes('-c') && !first.args.includes('-e') && !first.args.includes('-m')))) return 'inside';
  if (rest.every((c) => { const p = program(c.words); return STATE.has(p.name) || (!p.name && c.words.length > 0) || isLook(c); })) return 'state';
  return 'command';
}

const why = (line: string): string => {
  const names = simpleCommands(line).map((c) => { const p = program(c.words); return [p.name, p.args.find((a) => !a.startsWith('-')) ?? ''] as const; });
  const has = (re: RegExp) => names.some(([n, s]) => re.test(`${n} ${s}`));
  if (has(/^git clone|^gh repo clone|^(curl|wget) /)) return 'fetched files';
  if (has(/^(pip3?|npm|pnpm|yarn|bun|apt|apt-get|pkg|toolchain|debian|app|cargo|gem|go|brew) (install|i|add|get|ci)\b|^(npm|pnpm) ci\b|^toolchain |^debian install/)) return 'installed something';
  if (has(/^(make|cmake|ninja|cc|gcc|g\+\+|clang|javac|tsc|rustc|mvn|gradle) |^(cargo|go|npm|pnpm|yarn) (build|run)\b|^(npm|pnpm|yarn) run /)) return 'built something';
  return 'changed files';
};

/**
 * The files an editor's line wrote: of what changed while it ran, the files
 * it was started on (`vim a.c`, `code src`), or, started on nothing, the
 * files under the folder it was started in. What something else wrote
 * meanwhile (a download in another Terminal) is not the editor's.
 */
export function editorFiles(e: TrimEntry): string[] {
  const cmd = simpleCommands(e.line)[0];
  if (!cmd) return [];
  const on = program(cmd.words).args.filter((a) => !a.startsWith('-') && !a.startsWith('+')).map((a) => {
    const p = a.startsWith('/') ? a : a === '~' || a.startsWith('~/') ? a : `${e.cwd}/${a}`;
    const parts: string[] = [];
    for (const s of p.split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }
    return (p.startsWith('~') ? '' : '/') + parts.join('/');
  });
  const under = on.filter((a) => !a.startsWith('~')).concat(on.length ? [] : [e.cwd]);
  // (`~/x` is under a home this function is not told: the path must end as the argument does)
  const homed = on.filter((a) => a.startsWith('~/')).map((a) => a.slice(1));
  return e.changed.filter((p) => under.some((a) => p === a || p.startsWith(a + '/')) || homed.some((a) => p.endsWith(a) || p.includes(a + '/')));
}

/** Paths `link` needs the present contents of: what editors wrote. The caller looks each up (FileNow). */
export function editedPaths(input: Pick<TrimInput, 'entries' | 'edits'>): string[] {
  const out = new Set<string>();
  for (const e of input.entries) if ((e.status === 0 || e.status === null) && lineKind(e.line) === 'editor') for (const p of editorFiles(e)) out.add(p);
  for (const e of input.edits ?? []) out.add(e.path);
  return [...out];
}

const SAFE_PATH = /^[A-Za-z0-9_@%+=:,./-]+$/;
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** A path as a script writes it: `~/x` under home, quoted where a shell would split it */
export function scriptPath(path: string, home: string): string {
  if (path === home) return '~';
  if (path.startsWith(home + '/')) { const rest = path.slice(home.length + 1); return SAFE_PATH.test(rest) ? `~/${rest}` : `~/${shq(rest)}`; }
  return SAFE_PATH.test(path) ? path : shq(path);
}

function hereDocument(target: string, text: string): string {
  let mark = 'EOF';
  for (let n = 2; text.split('\n').includes(mark); n++) mark = `EOF_${n}`;
  return `cat > ${target} <<'${mark}'\n${text}${text.endsWith('\n') || !text ? '' : '\n'}${mark}`;
}

const sizeText = (n: number): string => (n < 1000 ? `${n} bytes` : n < 1e6 ? `${Math.ceil(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const RUN_LINK = /^\.\s+~\/run\/([a-z0-9][a-z0-9-]*)\/\.run-link$/;

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const SECRET_SHAPE = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

/**
 * What a line may give away: the name it sets a secret under
 * (`export API_KEY=…`, `--token=…`), or 'a token' for text shaped like one.
 * '' for a line that only names a variable (`TOKEN=$OTHER`, `--token "$T"`).
 * A link is for other people: such a line is left out, and the link says so.
 */
export function secretIn(line: string): string {
  if (SECRET_SHAPE.test(line)) return 'a token';
  for (const cmd of simpleCommands(line)) {
    for (let i = 0; i < cmd.words.length; i++) {
      const m = /([A-Za-z_][A-Za-z0-9_-]*)=(.+)$/.exec(cmd.words[i]);
      if (m && SECRET_NAME.test(m[1]) && !/^\$[{(A-Za-z_]/.test(m[2])) return m[1];
      const flag = /^--?([A-Za-z][A-Za-z0-9-]*)$/.exec(cmd.words[i]);
      const next = cmd.words[i + 1];
      if (flag && SECRET_NAME.test(flag[1].replace(/-/g, '_')) && next && !next.startsWith('-') && !/^\$[{(A-Za-z_]/.test(next)) return flag[1];
    }
  }
  return '';
}

/** The script for a session, and what was kept, dropped and left out, with the reason for each */
export function trimSession(input: TrimInput): Trimmed {
  const { home } = input;
  const kept: Trimmed['kept'] = [];
  const dropped: Trimmed['dropped'] = [];
  const notInLink: string[] = [];
  const files: string[] = [];
  type Item = { at: number; kind: 'cmd'; entry: TrimEntry; text: string; why: string } | { at: number; kind: 'file'; path: string; cwd?: string };
  const items: Item[] = [];
  const seenFile = new Set<string>();
  const file = (path: string, at: number, cwd?: string) => { if (!seenFile.has(path)) { seenFile.add(path); items.push({ at, kind: 'file', path, cwd }); } };
  let program_: Item | null = null;
  const drop = (e: TrimEntry, reason: string) => { dropped.push({ line: e.line, why: reason }); };

  for (const e of input.entries) {
    const line = e.line.trim();
    if (!line) continue;
    const kind = lineKind(line);
    if (kind === 'link') { drop(e, 'the link command itself'); continue; }
    const secret = kind === 'look' || kind === 'cd' || e.status !== 0 ? '' : secretIn(line);
    if (secret) {
      drop(e, `it may hold a secret (${secret})`);
      notInLink.push(`A line that sets ${secret} was left out: it may hold a secret, and a link is for other people. Add it by hand if it holds none.`);
      continue;
    }
    const linked = RUN_LINK.exec(line);
    if (linked) {
      const text = input.linked?.get(linked[1]);
      if (text && e.status === 0) items.push({ at: e.at, kind: 'cmd', entry: { ...e, cwd: home }, text: text.replace(/\s+$/, ''), why: 'the commands of the link this tab opened with' });
      else { drop(e, 'a link this tab opened with'); if (!text) notInLink.push(`The setup began with a run link (${linked[1]}). Its script is not in this link: open that link first.`); }
      continue;
    }
    if (kind === 'editor') {
      const wrote = editorFiles(e);
      if (e.status === 0 || e.status === null) { for (const p of wrote) file(p, e.at, e.cwd); drop(e, wrote.length ? 'an editor: the files it wrote are recorded as they are now' : 'an editor that wrote nothing'); } else drop(e, `it failed (status ${e.status})`);
      continue;
    }
    if (kind === 'inside') {
      drop(e, 'work inside a program');
      if (e.changed.length || (e.more ?? 0) > 0) notInLink.push(`What was done inside ${program(simpleCommands(line)[0].words).name} is not in the link: it changed ${e.changed.length + (e.more ?? 0)} ${e.changed.length + (e.more ?? 0) === 1 ? 'file' : 'files'}.`);
      continue;
    }
    // A program that is still up, or that ran until the person stopped it: the last one is what the setup runs
    if (kind === 'command' && (e.status === null || (e.status === 130 && e.end - e.at >= RAN_MS))) {
      if (program_ && program_.kind === 'cmd') drop(program_.entry, 'a program that was run again later');
      program_ = { at: e.at, kind: 'cmd', entry: e, text: line, why: e.status === null ? 'the program that is running' : 'the program that was running until it was stopped' };
      continue;
    }
    if (e.status !== 0) { drop(e, e.status === null ? 'it had not finished' : e.status === 130 ? 'it was stopped with Ctrl-C' : e.status === 127 ? 'no such command (status 127)' : `it failed (status ${e.status})`); continue; }
    if (kind === 'look') { drop(e, 'looking around'); continue; }
    if (kind === 'cd') { drop(e, 'a change of folder: each kept line is given its folder'); continue; }
    if (kind === 'state') { items.push({ at: e.at, kind: 'cmd', entry: e, text: line, why: 'set the shell up' }); continue; }
    // (an install is kept by its name too: what it wrote may be outside what was recorded, src/session-log.ts sessionBackground)
    const reason = why(line);
    if (!e.changed.length && !(e.more ?? 0) && reason !== 'installed something') { drop(e, 'it changed nothing'); continue; }
    items.push({ at: e.at, kind: 'cmd', entry: e, text: line, why: reason });
  }
  for (const e of input.edits ?? []) file(e.path, e.at);

  // A line entered again later, word for word, in the same folder: the last one stays
  const last = new Map<string, Item>();
  for (const it of items) if (it.kind === 'cmd') last.set(`${it.entry.cwd}\n${it.text}`, it);
  const ordered = items.filter((it) => {
    if (it.kind !== 'cmd' || last.get(`${it.entry.cwd}\n${it.text}`) === it) return true;
    drop(it.entry, 'entered again later');
    return false;
  }).sort((a, b) => a.at - b.at);

  const lines: string[] = [];
  let at = home;
  // Folders the script is known to have by now: where a kept line ran, and what it made
  const known = new Set<string>([home]);
  const many: string[] = [];
  const parent = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/';
  const learn = (e: TrimEntry) => {
    known.add(e.cwd);
    known.add(e.cwdAfter);
    for (const p of e.changed) for (let d = p; d.length > 1 && !known.has(d); d = parent(d)) known.add(d);
    // (a line that changed more files than were recorded: what is under its folder is taken to be there)
    if ((e.more ?? 0) > 0) many.push(e.cwd + '/', e.cwdAfter + '/');
  };
  const go = (dir: string) => { if (dir !== at) { lines.push(`cd ${scriptPath(dir, home)}`); at = dir; known.add(dir); } };
  const run = (it: Extract<Item, { kind: 'cmd' }>) => {
    go(it.entry.cwd);
    lines.push(it.text);
    at = it.entry.cwdAfter;
    learn(it.entry);
    kept.push({ line: it.entry.line, why: it.why });
  };
  for (const it of ordered) {
    if (it.kind === 'cmd') { run(it); continue; }
    const now = input.files.get(it.path);
    const shown = scriptPath(it.path, home);
    if (!now || 'missing' in now) continue;
    if ('skip' in now) {
      if (now.skip !== 'folder') notInLink.push(`${shown} (${sizeText(now.size)}, ${now.skip === 'binary' ? 'not text' : 'too large for a link'}) is not in the link. Put it where the link's commands can fetch it, and add the line that fetches it.`);
      continue;
    }
    // Where the editor was started, when the file is under it: the path then reads as it was typed
    if (it.cwd && it.path.startsWith(it.cwd + '/')) go(it.cwd);
    const under = it.path.startsWith(at + '/');
    const name = (p: string): string => (under ? (SAFE_PATH.test(p.slice(at.length + 1)) ? p.slice(at.length + 1) : shq(p.slice(at.length + 1))) : scriptPath(p, home));
    const dir = parent(it.path);
    // (a folder outside home is the system's: it is taken to be there)
    if (dir !== at && (dir + '/').startsWith(home + '/') && !known.has(dir) && !many.some((m) => (dir + '/').startsWith(m))) lines.push(`mkdir -p ${name(dir)}`);
    known.add(dir);
    lines.push(hereDocument(name(it.path), now.text));
    files.push(it.path);
  }
  if (program_ && program_.kind === 'cmd') run(program_);
  else go(input.cwd);
  return { script: lines.length ? lines.join('\n') + '\n' : '', kept, dropped, files, notInLink };
}
