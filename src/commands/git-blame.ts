/**
 * git blame: each line of a file with the commit that last changed it,
 * following first parents back from the revision (the work tree's own
 * changes, without one, are "Not Committed Yet"), and the file through its
 * renames: a line that came from the file under another name is shown with
 * that name, as git shows it. The default format,
 * -s, -e, -l, -L a,b / a,+n, and --porcelain / --line-porcelain.
 */
import git from './git-cached';
import type { CommandContext } from './index';
import { diffEdits, diffLines } from './git-utils';
import { resolveSpec, repoPath, gitDate, renamedFrom } from './git-plumbing';

type Fs = any;
const ZERO = '0'.repeat(40);

interface Origin { oid: string; line: number; path: string }

/** For each line of `cur`, its line in `prev` (or -1: new in cur) */
function lineMap(prev: string[], cur: string[]): number[] {
  const map: number[] = [];
  let i = 0;
  for (const e of diffEdits(prev, cur)) {
    if (e === 0) map.push(i++);
    else if (e === 1) map.push(-1);
    else i++;
  }
  return map;
}

async function blobText(fs: Fs, dir: string, commit: string, path: string): Promise<string | null> {
  const r = await git.readBlob({ fs, dir, oid: commit, filepath: path }).catch(() => null);
  return r ? new TextDecoder().decode(r.blob) : null;
}

export async function gitBlame(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = workDir === dir ? '' : workDir.slice(dir === '/' ? 1 : dir.length + 1) + '/';
  let porcelain = false, linePorcelain = false, noName = false, email = false, longHash = false;
  let range: string | null = null;
  const pos: string[] = [];
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1).map((p) => '\0' + p)); break; }
    if (a === '--porcelain' || a === '-p') porcelain = true;
    else if (a === '--line-porcelain') { porcelain = true; linePorcelain = true; }
    else if (a === '-s') noName = true;
    else if (a === '-e' || a === '--show-email') email = true;
    else if (a === '-l') longHash = true;
    else if (a === '-L') range = args[++i] ?? '';
    else if (a.startsWith('-L')) range = a.slice(2);
    else if (a.startsWith('-')) { /* -w, -M, -C, --date, ...: as they come */ }
    else pos.push(a);
  }
  // [rev] [--] file
  const files = pos.filter((p) => p.startsWith('\0')).map((p) => p.slice(1));
  const plain = pos.filter((p) => !p.startsWith('\0'));
  let rev: string | null = null, file: string | undefined;
  if (files.length) { file = files[0]; rev = plain[0] ?? null; }
  else if (plain.length >= 2) { rev = plain[0]; file = plain[1]; }
  else file = plain[0];
  if (!file) { ctx.stderr = 'usage: git blame [<options>] [<rev-opts>] [<rev>] [--] <file>\n'; return 129; }
  const path = repoPath(prefix, file);

  let start: string;
  try { start = await resolveSpec(fs, dir, rev ?? 'HEAD'); }
  catch { ctx.stderr = rev ? `fatal: bad revision '${rev}'\n` : 'fatal: no such ref: HEAD\n'; return 128; }
  const headText = await blobText(fs, dir, start, path);
  const root = dir === '/' ? '' : dir;
  // without a revision: the work tree's file, its changes since HEAD not committed yet
  let finalText = headText;
  if (!rev) {
    const w = await ctx.fs.readFile(`${root}/${path}`, 'utf8').catch(() => null) as string | null;
    if (w !== null) finalText = w;
  }
  if (finalText === null) { ctx.stderr = `fatal: no such path '${file}' in ${rev ?? 'HEAD'}\n`; return 128; }
  const finalLines = diffLines(finalText);

  // which commit each final line comes from, and its line there
  const origin: (Origin | null)[] = new Array(finalLines.length).fill(null);
  let pending: { finalIdx: number; idx: number }[] = finalLines.map((_, k) => ({ finalIdx: k, idx: k }));
  if (!rev && headText !== null) {
    const map = lineMap(diffLines(headText), finalLines);
    const next: typeof pending = [];
    for (const p of pending) {
      if (map[p.idx] < 0) origin[p.finalIdx] = { oid: ZERO, line: p.idx + 1, path };
      else next.push({ finalIdx: p.finalIdx, idx: map[p.idx] });
    }
    pending = next;
  } else if (!rev && headText === null) {
    pending.forEach((p) => { origin[p.finalIdx] = { oid: ZERO, line: p.idx + 1, path }; });
    pending = [];
  }
  const commits = new Map<string, any>();
  /** commit → the parent it was compared with, and the file's path there */
  const previous = new Map<string, string>();
  const boundary = new Set<string>();
  let oid = start, text = headText ?? '';
  // the file's name in the commit being looked at: it changes where a commit renamed it
  let at = path;
  while (pending.length) {
    const { commit } = await git.readCommit({ fs, dir, oid });
    commits.set(oid, commit);
    const parent = commit.parent[0];
    let parentPath = at;
    let parentText = parent ? await blobText(fs, dir, parent, at) : null;
    if (parent && parentText === null) {
      const from = await renamedFrom(fs, dir, parent, oid, at).catch(() => null);
      if (from) { parentPath = from; parentText = await blobText(fs, dir, parent, from); }
    }
    if (!parent || parentText === null) {
      if (!parent) boundary.add(oid);
      const here = at;
      pending.forEach((p) => { origin[p.finalIdx] = { oid, line: p.idx + 1, path: here }; });
      break;
    }
    const map = lineMap(diffLines(parentText), diffLines(text));
    const next: typeof pending = [];
    for (const p of pending) {
      if (map[p.idx] < 0) origin[p.finalIdx] = { oid, line: p.idx + 1, path: at };
      else next.push({ finalIdx: p.finalIdx, idx: map[p.idx] });
    }
    if (next.length < pending.length) previous.set(oid, `${parent} ${parentPath}`);
    pending = next;
    oid = parent;
    at = parentPath;
    text = parentText;
  }

  // -L a,b | a,+n | a
  let from = 1, to = finalLines.length;
  if (range !== null) {
    const m = /^(\d+)?(?:,(\+?)(\d+))?$/.exec(range);
    if (!m) { ctx.stderr = `fatal: -L parameter '${range}' starting at line 1: No such line\n`; return 128; }
    from = Number(m[1] ?? 1);
    to = m[3] === undefined ? finalLines.length : m[2] ? from + Number(m[3]) - 1 : Number(m[3]);
    if (from < 1 || from > finalLines.length) { ctx.stderr = `fatal: file ${file} has only ${finalLines.length} line${finalLines.length === 1 ? '' : 's'}\n`; return 128; }
    to = Math.min(to, finalLines.length);
  }

  const now = Math.floor(Date.now() / 1000);
  const notYet = { name: 'Not Committed Yet', email: 'not.committed.yet', timestamp: now, timezoneOffset: 0 };
  const who = (o: Origin) => (o.oid === ZERO ? notYet : commits.get(o.oid).author);
  const text1 = (l: string) => l.replace('\u0000noeol', '');
  const shown = origin.slice(from - 1, to);
  if (porcelain) {
    const seen = new Set<string>();
    let out = '';
    for (let k = from - 1; k < to; k++) {
      const o = origin[k]!;
      // a run of lines from one commit, consecutive there too, is a group
      const first = k === from - 1 || origin[k - 1]!.oid !== o.oid || origin[k - 1]!.line !== o.line - 1;
      let size = 1;
      if (first) while (k + size < to && origin[k + size]!.oid === o.oid && origin[k + size]!.line === o.line + size) size++;
      out += `${o.oid} ${o.line} ${k + 1}${first ? ` ${size}` : ''}\n`;
      if (!seen.has(o.oid) || linePorcelain) {
        seen.add(o.oid);
        const c = o.oid === ZERO ? null : commits.get(o.oid);
        const a = c ? c.author : notYet, cm = c ? c.committer : notYet;
        const tz = (p: any) => gitDate(p, 'raw').split(' ')[1];
        out += `author ${a.name}\nauthor-mail <${a.email}>\nauthor-time ${a.timestamp}\nauthor-tz ${tz(a)}\n`;
        out += `committer ${cm.name}\ncommitter-mail <${cm.email}>\ncommitter-time ${cm.timestamp}\ncommitter-tz ${tz(cm)}\n`;
        out += `summary ${c ? c.message.split('\n')[0] : `Version of ${path} from ${path}`}\n`;
        if (boundary.has(o.oid)) out += 'boundary\n';
        const prev = o.oid === ZERO ? `${start} ${path}` : previous.get(o.oid);
        if (prev && !boundary.has(o.oid)) out += `previous ${prev}\n`;
        out += `filename ${o.path}\n`;
      }
      out += `\t${text1(finalLines[k])}\n`;
    }
    ctx.stdout += out;
    return 0;
  }
  const nameOf = (o: Origin) => (email ? `<${who(o).email}>` : who(o).name);
  const nameWidth = Math.max(...shown.map((o) => nameOf(o!).length));
  const numWidth = String(to).length;
  // the file's name there, on every line, once any line came from another name
  const named = shown.some((o) => o!.path !== path);
  const pathWidth = named ? Math.max(...shown.map((o) => o!.path.length)) : 0;
  let out = '';
  for (let k = from - 1; k < to; k++) {
    const o = origin[k]!;
    // eight columns: the root commit's lines marked ^ (and seven of its hash)
    const hash = (longHash ? (boundary.has(o.oid) ? '^' + o.oid.slice(0, 39) : o.oid) : boundary.has(o.oid) ? '^' + o.oid.slice(0, 7) : o.oid.slice(0, 8)) + (named ? ' ' + o.path.padEnd(pathWidth) : '');
    const date = gitDate(who(o), 'iso');
    out += noName
      ? `${hash} ${String(k + 1).padStart(numWidth)}) ${text1(finalLines[k])}\n`
      : `${hash} (${nameOf(o).padEnd(nameWidth)} ${date} ${String(k + 1).padStart(numWidth)}) ${text1(finalLines[k])}\n`;
  }
  ctx.stdout += out;
  return 0;
}
