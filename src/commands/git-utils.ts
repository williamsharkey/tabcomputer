/**
 * Git helper functions shared by git.ts and git-* command files.
 *
 * Extracted from git.ts to keep command implementations focused.
 */
import git from './git-cached';

// --- Diff helpers ---

/** A line's text as unifiedDiff shows it (the marker for a last line without its newline taken off) */
export const NO_EOL = '\u0000noeol';

/**
 * The edit script between two line arrays, Myers' O(ND) algorithm as git's
 * xdiff runs it: -1 a deletion, 1 an insertion, 0 a kept line. Groups of
 * changes are then slid down as far as the lines allow, as git does.
 */
export function diffEdits(a: string[], b: string[]): number[] {
  const n = a.length, m = b.length;
  // common prefix and suffix first: most diffs are small
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
  const N = A.length, M = B.length, max = N + M;
  const mid: number[] = [];
  // (each step keeps only its diagonals -d..d; past MAX_D steps the rest is one replacement, as xdiff gives up on cost)
  const MAX_D = 4000;
  if (N && M) {
    const v = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= Math.min(max, MAX_D) && !found; d++) {
      trace.push(v.slice(max - d, max + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[max + k] = x;
        if (x >= N && y >= M) { found = true; break; }
      }
    }
    if (!found) {
      for (let i = 0; i < N; i++) mid.push(-1);
      for (let i = 0; i < M; i++) mid.push(1);
    } else {
      // walk the trace back to the edit script (trace[d][j] is v[k] for k = j - d)
      let x = N, y = M;
      const rev: number[] = [];
      for (let d = trace.length - 1; d > 0; d--) {
        const vv = trace[d];
        const at = (k: number) => vv[k + d];
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const px = at(prevK), py = px - prevK;
        while (x > px && y > py) { rev.push(0); x--; y--; }
        if (x === px) { rev.push(1); y--; } else { rev.push(-1); x--; }
      }
      while (x > 0 && y > 0) { rev.push(0); x--; y--; }
      mid.push(...rev.reverse());
    }
  } else {
    for (let i = 0; i < N; i++) mid.push(-1);
    for (let i = 0; i < M; i++) mid.push(1);
  }
  const edits = [...new Array(pre).fill(0), ...mid, ...new Array(suf).fill(0)];
  // deletions before insertions within a run of changes, as git prints them
  for (let i = 0; i < edits.length;) {
    if (edits[i] === 0) { i++; continue; }
    let j = i;
    while (j < edits.length && edits[j] !== 0) j++;
    const dels = edits.slice(i, j).filter((e) => e === -1).length;
    for (let k = i; k < j; k++) edits[k] = k - i < dels ? -1 : 1;
    i = j;
  }
  return slideDown(edits, a, b);
}

/** A group of only insertions or only deletions moves down while the line after it equals its first */
function slideDown(edits: number[], a: string[], b: string[]): number[] {
  const e = edits.slice();
  let changed = true;
  while (changed) {
    changed = false;
    let ai = 0, bi = 0;
    for (let i = 0; i < e.length;) {
      if (e[i] === 0) { ai++; bi++; i++; continue; }
      let j = i;
      while (j < e.length && e[j] === e[i]) j++;
      const kind = e[i];
      const len = j - i;
      // the group is followed by a kept line equal to the group's first line: slide by one
      if (j < e.length && e[j] === 0 && (i === 0 || e[i - 1] === 0 || e[i - 1] === kind)) {
        const seq = kind === -1 ? a : b;
        const start = kind === -1 ? ai : bi;
        if (seq[start] === seq[start + len] && (j + 1 >= e.length || e[j + 1] !== -kind)) {
          e[i] = 0; e[j] = kind;
          changed = true;
        }
      }
      if (kind === -1) ai += len; else bi += len;
      i = j;
    }
  }
  return e;
}

/** git's default funcname: a line that starts with a letter, `_` or `$` (at most 80 bytes, trailing blanks off) */
function funcLine(line: string): string | null {
  if (!/^[A-Za-z_$]/.test(line)) return null;
  return line.replace(NO_EOL, '').slice(0, 80).replace(/\s+$/, '');
}

/**
 * Unified diff hunks between two arrays of lines, as git prints them: `context`
 * lines around each change (3), and the hunk header's funcname from the old side.
 * A line ending in NO_EOL is a last line without its newline.
 */
export function unifiedDiff(oldLines: string[], newLines: string[], opts: { context?: number; funcname?: boolean } = {}): string {
  const ctxLines = opts.context ?? 3;
  const edits = diffEdits(oldLines, newLines);
  // each edit's position in old and new
  const pos: [number, number][] = [];
  let oi = 0, ni = 0;
  for (const e of edits) { pos.push([oi, ni]); if (e <= 0) oi++; if (e >= 0) ni++; }
  let out = '';
  let i = 0;
  const show = (l: string) => (l.endsWith(NO_EOL) ? l.slice(0, -NO_EOL.length) + '\n\\ No newline at end of file' : l);
  while (i < edits.length) {
    if (edits[i] === 0) { i++; continue; }
    const start = Math.max(0, i - ctxLines);
    let end = i;
    // extend over changes closer than 2*context kept lines
    for (;;) {
      while (end < edits.length && edits[end] !== 0) end++;
      let next = end;
      while (next < edits.length && edits[next] === 0) next++;
      if (next < edits.length && next - end <= ctxLines * 2) { end = next; continue; }
      end = Math.min(edits.length, end + ctxLines);
      break;
    }
    let oldCount = 0, newCount = 0;
    for (let j = start; j < end; j++) { if (edits[j] <= 0) oldCount++; if (edits[j] >= 0) newCount++; }
    const [o0, n0] = pos[start];
    // as git writes it: "-5" for one line, "-4,0" (the line before) for none
    const range = (before: number, count: number) => `${count ? before + 1 : before}${count === 1 ? '' : ',' + count}`;
    let fn = '';
    if (opts.funcname !== false) {
      for (let k = o0 - 1; k >= 0; k--) { const f = funcLine(oldLines[k]); if (f !== null) { fn = ' ' + f; break; } }
    }
    out += `@@ -${range(o0, oldCount)} +${range(n0, newCount)} @@${fn}\n`;
    for (let j = start; j < end; j++) {
      const [ox, nx] = pos[j];
      if (edits[j] === 0) out += ` ${show(oldLines[ox])}\n`;
      else if (edits[j] === -1) out += `-${show(oldLines[ox])}\n`;
      else out += `+${show(newLines[nx])}\n`;
    }
    i = end;
  }
  return out;
}

/** Lines of a file's text for unifiedDiff: a last line without its newline carries NO_EOL */
export function diffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

/** Lines added and removed between two texts */
export function diffCounts(a: string, b: string): [number, number] {
  let plus = 0, minus = 0;
  for (const e of diffEdits(diffLines(a), diffLines(b))) { if (e === 1) plus++; else if (e === -1) minus++; }
  return [plus, minus];
}

/** --stat's lines as git draws them for an 80-column pipe: names, counts and a +/- graph scaled to fit */
export function formatStatRows(rows: { name: string; add: number; del: number; binary?: string }[], width = 80): string {
  if (!rows.length) return '';
  const maxChange = Math.max(0, ...rows.map((r) => (r.binary ? 0 : r.add + r.del)));
  let numberWidth = Math.max(String(maxChange).length, rows.some((r) => r.binary) ? 3 : 0);
  let nameWidth = Math.max(...rows.map((r) => r.name.length));
  if (width < 16 + 6 + numberWidth) width = 16 + 6 + numberWidth;
  let graphWidth = maxChange;
  if (nameWidth + numberWidth + 6 + graphWidth > width) {
    if (graphWidth > Math.floor((width * 3) / 8) - numberWidth - 6) graphWidth = Math.max(6, Math.floor((width * 3) / 8) - numberWidth - 6);
    if (nameWidth > width - numberWidth - 6 - graphWidth) nameWidth = width - numberWidth - 6 - graphWidth;
    else graphWidth = width - numberWidth - 6 - nameWidth;
  }
  const scale = (k: number) => (maxChange <= graphWidth || !k ? k : 1 + Math.floor((k * (graphWidth - 1)) / maxChange));
  let out = '';
  for (const r of rows) {
    let name = r.name;
    if (name.length > nameWidth) {
      // "...tail", cut at a directory when it can be
      let tail = name.slice(name.length - (nameWidth - 3));
      const slash = tail.indexOf('/');
      if (slash >= 0) tail = tail.slice(slash);
      name = '...' + tail;
    }
    if (r.binary) { out += ` ${name.padEnd(nameWidth)} | ${'Bin'.padStart(numberWidth)} ${r.binary}\n`; continue; }
    const total = r.add + r.del;
    let add = scale(r.add), del = scale(r.del);
    if (maxChange > graphWidth && add + del > graphWidth) { if (add > del) add = graphWidth - del; else del = graphWidth - add; }
    const graph = '+'.repeat(add) + '-'.repeat(del);
    out += ` ${name.padEnd(nameWidth)} | ${String(total).padStart(numberWidth)}${graph ? ' ' + graph : ''}\n`;
  }
  return out;
}

// --- Revision helpers ---

/**
 * `REF@{N}`: the new value of REF's Nth newest reflog entry (.git/logs/REF, as
 * git-reflog.ts writes them). REF '' or '@' is the current branch (HEAD when
 * detached), as git's `@{N}`. null when `spec` isn't that form.
 */
async function reflogEntry(fs: any, dir: string, spec: string): Promise<string | null> {
  const m = /^(.*)@\{(\d+)\}$/.exec(spec);
  if (!m) return null;
  let ref = m[1];
  if (ref === '' || ref === '@') ref = (await git.currentBranch({ fs, dir, fullname: true }).catch(() => undefined)) || 'HEAD';
  else if (ref !== 'HEAD') ref = await git.expandRef({ fs, dir, ref }).catch(() => ref);
  const text = String(await fs.promises.readFile(`${dir === '/' ? '' : dir}/.git/logs/${ref}`, 'utf8').catch(() => ''));
  const lines = text.split('\n').filter(Boolean);
  const n = Number(m[2]);
  if (n >= lines.length) throw new Error(lines.length ? `log for '${m[1] || ref}' only has ${lines.length} entries` : `log for '${m[1] || ref}' is empty`);
  return lines[lines.length - 1 - n].split(' ')[1];
}

/** Resolve a revision string like HEAD, HEAD~3, HEAD^2, short SHA, branch name */
export async function resolveRevision(fs: any, dir: string, ref: string): Promise<string> {
  const ops: { type: string; n: number }[] = [];
  let base = ref;
  const modRe = /([~^])(\d*)/g;
  let match: RegExpExecArray | null;
  const firstMod = ref.search(/[~^]/);
  if (firstMod > 0) {
    base = ref.slice(0, firstMod);
    const modStr = ref.slice(firstMod);
    while ((match = modRe.exec(modStr)) !== null) {
      ops.push({ type: match[1], n: match[2] ? parseInt(match[2], 10) : 1 });
    }
  }

  let oid: string;
  const logged = await reflogEntry(fs, dir, base);
  if (logged) oid = logged;
  else try {
    oid = await git.resolveRef({ fs, dir, ref: base });
  } catch {
    try {
      oid = await git.expandOid({ fs, dir, oid: base });
    } catch {
      throw new Error(`bad revision '${ref}'`);
    }
  }

  for (const op of ops) {
    if (op.type === '~') {
      for (let i = 0; i < op.n; i++) {
        const { commit } = await git.readCommit({ fs, dir, oid });
        if (!commit.parent || commit.parent.length === 0) {
          throw new Error(`revision '${ref}' has no parent at ~${i + 1}`);
        }
        oid = commit.parent[0];
      }
    } else if (op.type === '^') {
      const { commit } = await git.readCommit({ fs, dir, oid });
      const idx = op.n - 1;
      if (!commit.parent || idx >= commit.parent.length) {
        throw new Error(`revision '${ref}' has no parent at ^${op.n}`);
      }
      oid = commit.parent[idx];
    }
  }

  return oid;
}
