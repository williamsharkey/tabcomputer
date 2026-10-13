/**
 * The Studio's model (docs/APPS.md "Studio"): a short form that is a one-file
 * app (`run`, `fields` or `table`), and the rules between the two. No DOM and
 * no filesystem here: `src/desktop/apps/studio.ts` draws it, and the tests
 * drive it.
 *
 * The form holds text as a person types it (a list of file types, a choice
 * per line); `draftToRaw` makes the app.json from it, leaving out every key at
 * its default, and `rawToDraft` reads an app.json back (to start from an app
 * or edit an installed one). The keys the form does not show (`window`,
 * `icon`, …) are carried through unchanged.
 *
 * A word in braces in the command is a field of a form, or an option of a
 * files app: the form grows one as the person types it, and keeps what was
 * said about one that is typed away and back.
 *
 * Problems are `validateManifest`'s, in `app check`'s words, each put beside
 * the part of the form its key belongs to (`problemField`).
 */
import { ManifestError, idFromName, validateManifest, type AppManifest } from './manifest';
import { placeholders, type ColumnType, type InputType, type OutputKind } from './declare';

export type StudioKind = 'files' | 'form' | 'table';

/** A field of a form or an option of a files app, as the form holds it */
export interface DraftInput {
  name: string;
  label: string;
  type: InputType;
  /** What it holds at first (a choice: its label; a checkbox: 'yes' or '') */
  value: string;
  /** For a choice: one per line, "what is shown: what goes in the command", or one text for both */
  choices: string;
  /** For a checkbox: what goes in the command when it is ticked */
  on: string;
  /** For a file field: its extensions as typed */
  accept: string;
}

export interface DraftColumn { name: string; type: ColumnType; choices: string }

export interface Draft {
  kind: StudioKind;
  name: string;
  about: string;
  /** The id of the installed app being edited; '' for a new one (the id comes from the name) */
  id: string;
  run: string;
  /** File types as typed: ".jpg .png", "jpg, png" */
  accept: string;
  out: string;
  /** Packages as typed: "imagemagick", "a b" */
  needs: string;
  /** A form's fields, or a files app's options, in the order the command names them */
  inputs: DraftInput[];
  stdin: string;
  live: boolean;
  output: OutputKind;
  shell: boolean;
  each: boolean;
  /** The table file's name ('' : made from the name); its kind is `store` */
  table: string;
  store: 'csv' | 'sqlite';
  columns: DraftColumn[];
  /** Keys of the app.json the form does not show, kept as they were */
  extra: Record<string, unknown>;
}

export const KINDS: { kind: StudioKind; title: string; text: string }[] = [
  { kind: 'files', title: 'Files', text: 'Runs a program on each file you give it, and gives back the results.' },
  { kind: 'form', title: 'Form', text: 'Fills in a command from a few fields, and shows what it prints.' },
  { kind: 'table', title: 'Table', text: 'Keeps a list, like a small spreadsheet.' },
];

/** The names a files app's command has without asking: the file, the result, the parts of the file's name */
const FILE_WORDS = ['in', 'out', 'name', 'ext', 'dir'];
const SHOWN_KEYS = new Set(['name', 'about', 'description', 'id', 'run', 'accept', 'out', 'needs', 'options', 'fields', 'stdin', 'live', 'output', 'shell', 'each', 'table', 'columns', 'manifest']);

/** Programs whose Debian package has another name, or that tabcomputer has no builtin for: the package a command needs */
export const KNOWN_PACKAGES: Record<string, string> = {
  convert: 'imagemagick', magick: 'imagemagick', mogrify: 'imagemagick', identify: 'imagemagick',
  gs: 'ghostscript', ps2pdf: 'ghostscript', tesseract: 'tesseract-ocr', pandoc: 'pandoc', qpdf: 'qpdf',
  pdftotext: 'poppler-utils', pdftoppm: 'poppler-utils', pdfunite: 'poppler-utils', pdfinfo: 'poppler-utils',
  lame: 'lame', 'heif-convert': 'libheif-examples', genisoimage: 'genisoimage', ffmpeg: 'ffmpeg', sox: 'sox',
  optipng: 'optipng', jpegoptim: 'jpegoptim', cwebp: 'webp', dwebp: 'webp', exiftool: 'libimage-exiftool-perl',
  libreoffice: 'libreoffice', soffice: 'libreoffice', ocrmypdf: 'ocrmypdf', xmllint: 'libxml2-utils',
};

const title = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');

export function blankInput(name: string, kind: StudioKind): DraftInput {
  return { name, label: title(name), type: kind === 'files' ? 'choice' : 'text', value: '', choices: '', on: '', accept: '' };
}

export function blankDraft(kind: StudioKind): Draft {
  return {
    kind, name: '', about: '', id: '', run: '', accept: '', out: '', needs: '', inputs: [], stdin: '', live: false, output: 'text',
    shell: false, each: true, table: '', store: 'csv', columns: kind === 'table' ? [{ name: '', type: 'text', choices: '' }] : [], extra: {},
  };
}

/** The words of a list as typed: "a, b c" → ["a", "b", "c"] */
const words = (s: string): string[] => s.split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);

/** File types as typed → extensions: "jpg, .PNG" → [".jpg", ".png"] */
export function acceptList(s: string): string[] {
  return [...new Set(words(s).map((w) => (w.startsWith('.') ? w : `.${w}`).toLowerCase()))];
}

/** A choice per line: "800 pixels: 800x800>" is shown as the first and becomes the second */
export function choiceLines(s: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const at = t.indexOf(':');
    const [label, value] = at > 0 ? [t.slice(0, at).trim(), t.slice(at + 1).trim()] : [t, t];
    if (label && !out.some((c) => c.label === label)) out.push({ label, value: value || label });
  }
  return out;
}
const choiceText = (c: { label: string; value: string }[]): string => c.map((x) => (x.label === x.value ? x.label : `${x.label}: ${x.value}`)).join('\n');

/** The names the command and the text the program reads put in braces: the form's fields or the options */
export function inputNames(d: Pick<Draft, 'kind' | 'run' | 'stdin' | 'output'>): string[] {
  if (d.kind === 'table') return [];
  const own = d.kind === 'files' ? FILE_WORDS : d.output === 'file' ? ['out'] : [];
  const found = placeholders(d.kind === 'form' ? `${d.run}\n${d.stdin}` : d.run);
  return found.filter((n) => !own.includes(n));
}

/** The table file a name gives: "My Expenses" → my-expenses.csv */
export function tableFile(d: Pick<Draft, 'name' | 'table' | 'store'>): string {
  const ext = d.store === 'sqlite' ? '.sqlite' : '.csv';
  if (d.table.trim()) return d.table.trim().replace(/\.(csv|sqlite)$/i, '') + ext;
  return (idFromName(d.name) || 'table') + ext;
}

function inputToRaw(i: DraftInput, kind: StudioKind): unknown {
  const o: Record<string, unknown> = {};
  if (i.label.trim() && i.label.trim() !== title(i.name)) o.label = i.label.trim();
  const plainDefault = kind === 'form' ? 'text' : '';
  if (i.type !== plainDefault) o.type = i.type;
  if (i.type === 'choice') {
    const c = choiceLines(i.choices);
    o.choices = c.every((x) => x.label === x.value) ? c.map((x) => x.label) : Object.fromEntries(c.map((x) => [x.label, x.value]));
    if (i.value && c.length && i.value !== c[0].label) o.value = i.value;
  } else if (i.type === 'checkbox') {
    o.on = i.on;
    if (i.value) o.value = true;
  } else if (i.type === 'number') {
    if (i.value.trim() !== '') o.value = Number.isFinite(Number(i.value)) ? Number(i.value) : i.value;
  } else if (i.type === 'file') {
    if (i.accept.trim()) o.accept = acceptList(i.accept);
  } else if (i.value) o.value = i.value;
  // A text field with nothing but its label is written as the label alone
  const keys = Object.keys(o);
  if (kind === 'form' && keys.length === 1 && keys[0] === 'label') return o.label;
  return o;
}

/** The app.json a draft makes: every key at its default left out, the ones the form does not show kept */
export function draftToRaw(d: Draft): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  if (d.id) raw.id = d.id;
  if (d.name.trim()) raw.name = d.name.trim();
  if (d.about.trim()) raw.about = d.about.trim();
  if (d.kind === 'table') {
    raw.table = tableFile(d);
    raw.columns = d.columns.filter((c) => c.name.trim()).map((c) => {
      const name = c.name.trim();
      if (c.type === 'choice') return { name, choices: [...new Set(c.choices.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))] };
      return c.type === 'text' ? name : { name, type: c.type };
    });
  } else {
    if (d.kind === 'files') {
      const accept = acceptList(d.accept);
      if (accept.length) raw.accept = accept;
      if (!d.each) raw.each = false;
    }
    const names = inputNames(d);
    const inputs = Object.fromEntries(d.inputs.filter((i) => names.includes(i.name)).map((i) => [i.name, inputToRaw(i, d.kind)]));
    if (d.kind === 'files') { if (Object.keys(inputs).length) raw.options = inputs; } else raw.fields = inputs;
    raw.run = d.run.trim();
    if (d.kind === 'form') {
      if (d.stdin) raw.stdin = d.stdin;
      if (d.output !== 'text') raw.output = d.output;
      if (d.live) raw.live = true;
    }
    if (d.out.trim() && (d.kind === 'files' || d.output === 'file')) raw.out = d.out.trim();
    if (d.shell) raw.shell = true;
  }
  const needs = words(d.needs);
  if (needs.length) raw.needs = needs;
  return { ...raw, ...d.extra };
}

function inputFromRaw(name: string, v: unknown, kind: StudioKind): DraftInput {
  const i = blankInput(name, kind);
  const o = (typeof v === 'string' ? { label: v } : v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (typeof o.label === 'string') i.label = o.label;
  const type = o.type ?? (o.choices !== undefined ? 'choice' : o.on !== undefined ? 'checkbox' : kind === 'form' ? 'text' : 'choice');
  i.type = type as InputType;
  if (Array.isArray(o.choices)) i.choices = (o.choices as unknown[]).map(String).join('\n');
  else if (o.choices && typeof o.choices === 'object') i.choices = choiceText(Object.entries(o.choices as Record<string, unknown>).map(([label, value]) => ({ label, value: String(value) })));
  if (typeof o.on === 'string') i.on = o.on;
  if (Array.isArray(o.accept)) i.accept = (o.accept as unknown[]).map(String).join(' ');
  if (o.value !== undefined) i.value = typeof o.value === 'boolean' ? (o.value ? 'yes' : '') : String(o.value);
  return i;
}

/** A draft from an app.json (to start from an app, or edit an installed one). Null for an app with a page of its own. */
export function rawToDraft(raw: Record<string, unknown>): Draft | null {
  const kind: StudioKind | null = raw.table !== undefined || raw.columns !== undefined ? 'table' : raw.fields !== undefined ? 'form' : raw.run !== undefined ? 'files' : null;
  if (!kind) return null;
  const d = blankDraft(kind);
  const str = (k: string) => (typeof raw[k] === 'string' ? raw[k] as string : '');
  d.name = str('name');
  d.about = str('about') || str('description');
  d.id = str('id');
  d.run = str('run');
  d.out = str('out');
  d.stdin = str('stdin');
  d.live = raw.live === true;
  d.shell = raw.shell === true;
  d.each = raw.each !== false;
  if (typeof raw.output === 'string' && ['text', 'html', 'markdown', 'file'].includes(raw.output)) d.output = raw.output as OutputKind;
  if (Array.isArray(raw.accept)) d.accept = raw.accept.map(String).join(' ');
  if (Array.isArray(raw.needs)) d.needs = raw.needs.map(String).join(' ');
  const inputs = (kind === 'files' ? raw.options : raw.fields) as Record<string, unknown> | undefined;
  if (inputs && typeof inputs === 'object') d.inputs = Object.entries(inputs).map(([n, v]) => inputFromRaw(n, v, kind));
  if (kind === 'table') {
    const t = str('table');
    d.store = /\.sqlite$/i.test(t) ? 'sqlite' : 'csv';
    // (a file named as the name would name it is left to the name, so a new name renames it)
    d.table = t && t !== tableFile({ name: d.name, table: '', store: d.store }) ? t : '';
    d.columns = Array.isArray(raw.columns) ? raw.columns.map((c) => {
      const o = (typeof c === 'string' ? { name: c } : c ?? {}) as Record<string, unknown>;
      const type = (o.type ?? (o.choices !== undefined ? 'choice' : 'text')) as ColumnType;
      return { name: String(o.name ?? ''), type, choices: Array.isArray(o.choices) ? o.choices.map(String).join(', ') : '' };
    }) : [];
  }
  for (const [k, v] of Object.entries(raw)) if (!SHOWN_KEYS.has(k)) d.extra[k] = v;
  // The format's own number is the default: it says nothing a person changes here
  if (raw.manifest !== undefined && raw.manifest !== 1) d.extra.manifest = raw.manifest;
  return d;
}

/** The part of the form a problem belongs to */
export type ProblemField = 'name' | 'about' | 'run' | 'accept' | 'out' | 'needs' | 'stdin' | 'output' | 'table' | 'columns' | 'other' | `input:${string}` | `column:${number}`;
export interface Problem { field: ProblemField; text: string }

/**
 * Where a problem `validateManifest` names goes in the form, from the key it
 * starts with: `run: {x} is not known` beside the command, `columns[2].type
 * must be…` beside the third column. `columns[i]` counts the columns that
 * were written, so `columnRows` maps it back to the row of the form.
 */
export function problemField(text: string, columnRows: number[] = []): ProblemField {
  const key = /^unknown key ([^\s(]+)/.exec(text)?.[1] ?? /^([A-Za-z_.[\]0-9]+)/.exec(text)?.[1] ?? '';
  let m: RegExpExecArray | null;
  if ((m = /^(?:fields|options)\.([a-z][a-z0-9_]*)/.exec(key))) return `input:${m[1]}`;
  if ((m = /^columns\[(\d+)\]/.exec(key))) return `column:${columnRows[Number(m[1])] ?? Number(m[1])}`;
  const head = key.split(/[.[:]/)[0];
  if (head === 'name' || head === 'id') return 'name';
  if (head === 'about' || head === 'description') return 'about';
  if (head === 'fields' || head === 'options') return 'run';
  if (head === 'each' || head === 'shell') return 'run';
  if (head === 'live') return 'output';
  if (['run', 'accept', 'out', 'needs', 'stdin', 'output', 'table', 'columns'].includes(head)) return head as ProblemField;
  return 'other';
}

export interface Checked {
  raw: Record<string, unknown>;
  /** The app the draft is, or null while it has problems */
  manifest: AppManifest | null;
  problems: Problem[];
}

/** The app.json of a draft, checked as `app check` checks one */
export function checkDraft(d: Draft): Checked {
  const raw = draftToRaw(d);
  const rows = d.columns.map((c, i) => (c.name.trim() ? i : -1)).filter((i) => i >= 0);
  try { return { raw, manifest: validateManifest(raw), problems: [] }; } catch (e) {
    if (!(e instanceof ManifestError)) throw e;
    // A field or option with a problem of its own is left out of the app, so the command "does not know" it:
    // that is the same problem said twice, and the second is said beside the command, where nothing is wrong
    const own = new Set(d.inputs.map((i) => i.name));
    const echo = (text: string) => { const m = /^(?:run|stdin): \{([a-z][a-z0-9_]*)\} is not known/.exec(text); return !!m && own.has(m[1]); };
    return { raw, manifest: null, problems: e.problems.filter((t) => !echo(t)).map((text) => ({ field: problemField(text, rows), text })) };
  }
}

/** The app.json's text, as the Studio writes and shares it */
export const draftText = (raw: Record<string, unknown>): string => JSON.stringify(raw, null, 2) + '\n';

/** The id the copy shown beside the form runs under: one for every draft, so its data is a try-out's */
export const PREVIEW_ID = 'studio-preview';

/**
 * The manifest of the app shown running beside the form: the draft as it is,
 * with a name while it has none yet, under PREVIEW_ID. Null while the draft
 * has a problem the name does not explain (the last one that worked stays).
 */
export function previewManifest(d: Draft): AppManifest | null {
  const raw = draftToRaw(d);
  const named = { ...raw, name: (raw.name as string | undefined) ?? 'New app', id: PREVIEW_ID };
  try { return validateManifest(named); } catch { return null; }
}

/**
 * The Studio's state: a draft per kind (switching kinds and back loses
 * nothing), what the person has touched (a problem is shown beside a part of
 * the form only once it was touched, or once Share or Install was asked for),
 * and what was said about fields that were typed away.
 */
export class StudioState {
  kind: StudioKind | null = null;
  private drafts = new Map<StudioKind, Draft>();
  readonly touched = new Set<string>();
  /** Share, Install or Save was asked for: every problem shows */
  tried = false;
  private stash = new Map<string, DraftInput>();
  /** The packages that were filled in from the command, not typed: they follow the command until needs is touched */
  private guessed = '';

  get draft(): Draft {
    if (!this.kind) throw new Error('no kind is chosen yet');
    let d = this.drafts.get(this.kind);
    if (!d) { d = blankDraft(this.kind); this.drafts.set(this.kind, d); }
    return d;
  }

  /** One tap on a kind. What every kind has (name, what it does, what it needs) goes along. */
  choose(kind: StudioKind): void {
    const before = this.kind ? this.draft : null;
    this.kind = kind;
    const d = this.draft;
    if (before && before !== d) {
      for (const k of ['name', 'about', 'id'] as const) d[k] = before[k];
      if (kind !== 'table' && before.kind !== 'table') d.needs = before.needs;
    }
  }

  /** Start from an app.json (one of the site's), or edit an installed one (`edit`: its id). False: it is not a one-file app. */
  load(raw: Record<string, unknown>, opts: { edit?: string } = {}): boolean {
    const d = rawToDraft(raw);
    if (!d) return false;
    // Editing keeps the installed app's id (its folder's name when its app.json gives none); a start makes a new one from the name
    d.id = opts.edit ?? '';
    this.drafts.clear();
    this.drafts.set(d.kind, d);
    this.kind = d.kind;
    this.touched.clear();
    this.stash.clear();
    this.tried = false;
    this.guessed = '';
    return true;
  }

  /** A part of the form changed */
  set<K extends 'name' | 'about' | 'run' | 'accept' | 'out' | 'needs' | 'stdin' | 'live' | 'output' | 'shell' | 'each' | 'table' | 'store'>(key: K, value: Draft[K]): void {
    const d = this.draft;
    d[key] = value;
    this.touched.add(key);
    if (key === 'needs') this.guessed = '';
    if (key === 'run' || key === 'stdin' || key === 'output') this.syncInputs();
    if (key === 'run') this.guessNeeds();
  }

  /** The packages the command's program needs, filled in while the person has not typed any */
  private guessNeeds(): void {
    const d = this.draft;
    if (d.kind === 'table' || (d.needs && d.needs !== this.guessed)) return;
    const first = d.shell ? '' : d.run.trim().split(/\s+/)[0] ?? '';
    const pkg = KNOWN_PACKAGES[first] ?? '';
    d.needs = pkg;
    this.guessed = pkg;
  }

  /** The fields (or options) follow the words in braces: new ones appear, ones typed away are kept aside */
  syncInputs(): void {
    const d = this.draft;
    const names = inputNames(d);
    for (const i of d.inputs) if (!names.includes(i.name)) this.stash.set(`${d.kind}:${i.name}`, i);
    d.inputs = names.map((n) => d.inputs.find((i) => i.name === n) ?? this.stash.get(`${d.kind}:${n}`) ?? blankInput(n, d.kind));
  }

  setInput<K extends keyof DraftInput>(name: string, key: K, value: DraftInput[K]): void {
    const i = this.draft.inputs.find((x) => x.name === name);
    if (!i) return;
    i[key] = value;
    // A choice that starts as a label no longer there starts as the first
    if (i.type === 'choice' && i.value && !choiceLines(i.choices).some((c) => c.label === i.value)) i.value = '';
    if (key === 'type' && value === 'checkbox' && !i.on) i.on = `--${i.name}`;
    this.touched.add(`input:${name}`);
  }

  addColumn(): void { this.draft.columns.push({ name: '', type: 'text', choices: '' }); }
  removeColumn(i: number): void { this.draft.columns.splice(i, 1); if (!this.draft.columns.length) this.addColumn(); }
  moveColumn(i: number, by: -1 | 1): void {
    const c = this.draft.columns;
    const j = i + by;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
  }
  setColumn<K extends keyof DraftColumn>(i: number, key: K, value: DraftColumn[K]): void {
    const c = this.draft.columns[i];
    if (!c) return;
    c[key] = value;
    this.touched.add(`column:${i}`);
    this.touched.add('columns');
  }

  check(): Checked & { shown: Problem[] } {
    const c = checkDraft(this.draft);
    const seen = (f: string) => this.tried || this.touched.has(f) || (f.startsWith('column:') && this.touched.has('columns'));
    return { ...c, shown: c.problems.filter((p) => seen(p.field)) };
  }

  preview(): AppManifest | null { return previewManifest(this.draft); }
}

// ── Try it: sample input made without a DOM ──

const today = (): Date => new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Three rows for a table's try-out, as CSV with its line of column names */
export function sampleCsv(m: Pick<AppManifest, 'columns'>, now: Date = today()): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const texts = ['A first row', 'A second row', 'A third row'];
  const numbers = ['12.5', '40', '7.25'];
  const rows = [0, 1, 2].map((r) => m.columns.map((c) => {
    if (c.type === 'number') return numbers[r];
    if (c.type === 'date') return iso(new Date(now.getTime() - r * 86_400_000));
    if (c.type === 'checkbox') return r === 1 ? 'yes' : '';
    if (c.type === 'choice') return c.choices[r % c.choices.length] ?? '';
    return texts[r];
  }));
  return [m.columns.map((c) => c.name), ...rows].map((row) => row.map(cell).join(',')).join('\n') + '\n';
}

/** A one-page PDF that says `text`, written by hand (its cross-reference table counts bytes) */
export function samplePdf(text = 'A sample page'): Uint8Array {
  const t = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 36 Tf 72 700 Td (${t}) Tj ET\nBT /F1 14 Tf 72 660 Td (Made by Try it in the tabcomputer Studio.) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objects.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Text samples by extension; pictures are drawn by the window (a canvas), PDFs by samplePdf */
export const TEXT_SAMPLES: Record<string, string> = {
  '.txt': 'A sample text file.\nIt has two lines.\n',
  '.md': '# A sample\n\nSome *Markdown* text, with a list:\n\n- one\n- two\n',
  '.markdown': '# A sample\n\nSome *Markdown* text.\n',
  '.json': '{"people": [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 21}]}\n',
  '.csv': 'name,age\nAda,36\nLinus,21\n',
  '.html': '<!doctype html>\n<title>A sample</title>\n<h1>A sample</h1>\n<p>A short web page.</p>\n',
  '.htm': '<!doctype html>\n<title>A sample</title>\n<h1>A sample</h1>\n<p>A short web page.</p>\n',
  '.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#2456c8"/><circle cx="100" cy="60" r="40" fill="#fff"/></svg>\n',
};
/** The picture kinds a canvas in this browser can write */
export const PICTURE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** The extension Try it makes a sample of: the first accepted one it can make ('.txt' when every file is taken), or '' */
export function sampleKind(accept: string[]): string {
  if (!accept.length) return '.txt';
  return accept.find((e) => e === '.pdf' || e in TEXT_SAMPLES || e in PICTURE_TYPES) ?? '';
}
