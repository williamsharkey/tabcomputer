/**
 * Apps without a page of their own (docs/APPS.md "The manifest alone"): an
 * `app.json` that has `run`, `fields` or `table` is the whole app, and
 * tabcomputer supplies the page (public/apphost/page.js).
 *
 *   files   `run` with {in}: a command run on each file the person gives it
 *   form    `fields` and `run`: labelled inputs fill a command; its output shows
 *   table   `table` and `columns`: a CSV or SQLite file shown as a table
 *
 * This module is the kinds' rules, with no DOM and no filesystem: which keys a
 * kind takes, how `run` becomes a program's arguments, and how a result is
 * named. A placeholder's value is always one argument: `run` is split into
 * words once, here, and no shell reads what a person typed or what a file is
 * called. `"shell": true` makes `run` a shell line; the values then go in
 * quoted.
 */

export type AppKind = 'page' | 'files' | 'form' | 'table';
export type InputType = 'text' | 'long text' | 'number' | 'choice' | 'checkbox' | 'file';
export type ColumnType = 'text' | 'number' | 'date' | 'choice' | 'checkbox';
export type OutputKind = 'text' | 'html' | 'markdown' | 'file';

/** One of a form's `fields`, or one of a file job's `options` */
export interface AppInput {
  name: string;
  label: string;
  type: InputType;
  /** What it holds at first: text, a number as text, a choice's label, 'yes' for a ticked box */
  value: string;
  /** For a choice: what the person reads, and what the placeholder becomes */
  choices: { label: string; value: string }[];
  /** For a checkbox: what the placeholder becomes when it is ticked (unticked: nothing) */
  on: string;
  /** For a file: the extensions the picker offers */
  accept: string[];
}

export interface AppColumn { name: string; type: ColumnType; choices: string[] }

/** What a kind adds to a manifest; every key has its default here */
export interface KindKeys {
  kind: AppKind;
  run: string;
  shell: boolean;
  accept: string[];
  out: string;
  each: boolean;
  options: AppInput[];
  fields: AppInput[];
  stdin: string;
  output: OutputKind;
  live: boolean;
  table: string;
  columns: AppColumn[];
}

export const NO_KIND: KindKeys = {
  kind: 'page', run: '', shell: false, accept: [], out: '', each: true, options: [], fields: [],
  stdin: '', output: 'text', live: false, table: '', columns: [],
};

/** The keys each kind takes, beside the ones every app has */
export const KIND_KEYS: Record<Exclude<AppKind, 'page'>, string[]> = {
  files: ['accept', 'run', 'out', 'options', 'each', 'shell'],
  form: ['fields', 'run', 'stdin', 'output', 'out', 'live', 'shell'],
  table: ['table', 'columns'],
};
/** The client area a kind's window starts with */
export const KIND_WINDOW: Record<AppKind, { width: number; height: number }> = {
  page: { width: 720, height: 560 }, files: { width: 560, height: 580 }, form: { width: 600, height: 620 }, table: { width: 780, height: 540 },
};

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;
const WHOLE = /^\{([a-z][a-z0-9_]*)\}$/;
const INPUT_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;
const EXT = /^\.[A-Za-z0-9][A-Za-z0-9+_-]{0,15}$/;
const TABLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,60}\.(csv|sqlite)$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\u061c\ufeff]/;
/** What a file job's `run` may name: the input, the result, and the parts of their names */
const FILE_WORDS = ['in', 'out', 'name', 'ext', 'dir'];
/** Words only a shell understands */
const SHELL_WORDS = new Set(['|', '||', '&&', ';', '&', '>', '>>', '<', '2>', '2>&1', '|&']);
const INPUT_TYPES: InputType[] = ['text', 'long text', 'number', 'choice', 'checkbox', 'file'];
const COLUMN_TYPES: ColumnType[] = ['text', 'number', 'date', 'choice', 'checkbox'];
const OUTPUTS: OutputKind[] = ['text', 'html', 'markdown', 'file'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'nothing' : JSON.stringify(v) ?? String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};
const plainText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CONTROL.test(v);
const title = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');

/** The names in `{…}` that `text` uses, in order, once each */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/**
 * `run` as words. Blanks separate words; '…' and "…" keep blanks inside one
 * word. Nothing else is special: `;`, `|`, `$(…)` and `*` are plain characters.
 * Throws an Error (its message says what is wrong) for a quote left open.
 */
export function splitRun(run: string): string[] {
  const words: string[] = [];
  let word = '', open = '', has = false;
  for (const c of run) {
    if (open) { if (c === open) open = ''; else word += c; continue; }
    if (c === '"' || c === "'") { open = c; has = true; continue; }
    if (/\s/.test(c)) { if (has) words.push(word); word = ''; has = false; continue; }
    word += c;
    has = true;
  }
  if (open) throw new Error(`a ${open} is never closed`);
  if (has) words.push(word);
  return words;
}

export interface RunRules {
  /** Placeholders whose empty value leaves the whole word out (an unticked box, a choice of nothing) */
  drop: Set<string>;
  /** Placeholders that hold a file's name: a word that starts with one never starts with `-` */
  names: Set<string>;
}
export type RunValues = Record<string, string | string[]>;

const value = (values: RunValues, name: string): string | string[] => {
  const v = values[name];
  if (v === undefined) throw new Error(`{${name}} has no value`);
  return v;
};
/** A file may be called `-rf`: as `./-rf` no program takes it for an option */
const guard = (word: string, template: string, rules: RunRules): string => {
  const first = /^\{([a-z][a-z0-9_]*)\}/.exec(template);
  return first && rules.names.has(first[1]) && word.startsWith('-') ? './' + word : word;
};

/**
 * The program and its arguments: each word of `run`, its placeholders filled.
 * A value is never split and never read again, whatever it holds. A word that
 * is only a list placeholder ({in} with every input) becomes one argument per
 * item.
 */
export function argvFor(words: string[], values: RunValues, rules: RunRules): string[] {
  const out: string[] = [];
  for (const w of words) {
    const whole = WHOLE.exec(w);
    if (whole) {
      const v = value(values, whole[1]);
      if (Array.isArray(v)) { out.push(...v); continue; }
      if (v === '' && rules.drop.has(whole[1])) continue;
    }
    out.push(guard(w.replace(PLACEHOLDER, (_m, n: string) => { const v = value(values, n); return Array.isArray(v) ? v.join(' ') : v; }), w, rules));
  }
  return out;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `"shell": true`: `run` as a shell line, each value one quoted word */
export function shellLineFor(run: string, values: RunValues, rules: RunRules): string {
  return run.replace(PLACEHOLDER, (m, n: string, at: number) => {
    const v = value(values, n);
    if (Array.isArray(v)) return v.map(shq).join(' ');
    if (v === '' && rules.drop.has(n)) return '';
    const starts = at === 0 || /\s/.test(run[at - 1]);
    return shq(starts ? guard(v, m, rules) : v);
  });
}

/** Text with its placeholders filled (a form's `stdin`) */
export function fill(text: string, values: RunValues): string {
  return text.replace(PLACEHOLDER, (_m, n: string) => { const v = value(values, n); return Array.isArray(v) ? v.join('\n') : v; });
}

/** A placeholder inside quotes of a shell line (it would be quoted twice): its name, or '' */
function quotedPlaceholder(run: string): string {
  let open = '';
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (open) {
      if (c === open) open = '';
      else if (c === '{') { const m = /^\{([a-z][a-z0-9_]*)\}/.exec(run.slice(i)); if (m) return m[1]; }
    } else if (c === '"' || c === "'") open = c;
  }
  return '';
}

export interface OutputName {
  /** The result's path inside the results folder, a dropped folder's structure kept */
  rel: string;
  /** The input's name without its extension, its extension, and its folder ('' or `a/b/`) */
  name: string;
  ext: string;
  dir: string;
}

/**
 * The name of an input's result: `template` with {name} and {ext} filled, in
 * the input's own folder. Two inputs that would get one name get two:
 * `page.pdf`, `page (2).pdf`. `taken` holds the names given so far.
 */
export function outputName(template: string, rel: string, taken: Set<string>): OutputName {
  const at = rel.lastIndexOf('/');
  const dir = at < 0 ? '' : rel.slice(0, at + 1);
  const base = rel.slice(at + 1);
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  const file = (template || '{name}.{ext}').replace(PLACEHOLDER, (_m, n: string) => (n === 'name' ? name : n === 'ext' ? ext : ''))
    .replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/\.+$/, '') || 'result';
  const cut = file.lastIndexOf('.');
  const [stem, tail] = cut > 0 ? [file.slice(0, cut), file.slice(cut)] : [file, ''];
  let out = dir + file;
  // (compared without case: the zip is unpacked on disks that do not tell Page.pdf from page.pdf)
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${dir}${stem} (${n})${tail}`;
  taken.add(out.toLowerCase());
  return { rel: out, name, ext, dir };
}

/** What a field or option holds on the page, as the argument it becomes. Throws an Error for a value it cannot hold. */
export function inputValue(input: AppInput, raw: unknown): string {
  const s = raw === undefined || raw === null ? '' : typeof raw === 'boolean' ? (raw ? 'yes' : '') : String(raw);
  if (s.includes('\0')) throw new Error(`${input.label} holds a character a program cannot be given`);
  if (input.type === 'checkbox') return s ? input.on : '';
  if (input.type === 'choice') {
    const c = input.choices.find((x) => x.label === s);
    if (!c) throw new Error(`${input.label} has no choice named ${show(s)}`);
    return c.value;
  }
  if (input.type === 'number' && s && !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s.trim())) throw new Error(`${input.label} must be a number`);
  return input.type === 'number' ? s.trim() : s;
}

/** The rules for a manifest's `run`: which empty values leave their word out */
export function rulesOf(k: KindKeys): RunRules {
  const drop = new Set([...k.options, ...k.fields].filter((i) => i.type === 'choice' || i.type === 'checkbox').map((i) => i.name));
  return { drop, names: new Set(['name', 'ext']) };
}

function parseInputs(raw: unknown, key: string, types: InputType[], bad: (msg: string) => void): AppInput[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) { bad(`${key} must be an object: a name, then what the page shows for it (got ${show(raw)})`); return []; }
  const out: AppInput[] = [];
  const names = Object.keys(raw);
  if (names.length > 24) bad(`${key} has ${names.length} entries; at most 24`);
  for (const name of names) {
    const at = `${key}.${name}`;
    if (!INPUT_NAME.test(name)) { bad(`${at}: a name is a-z, 0-9 and _, starting with a letter (it is written {name} in run)`); continue; }
    if (FILE_WORDS.includes(name)) { bad(`${at}: {${name}} already means something (${FILE_WORDS.join(', ')}): pick another name`); continue; }
    const o = typeof raw[name] === 'string' ? { label: raw[name] } : raw[name];
    if (!isObject(o)) { bad(`${at} must be a label, or { "label", "type", … } (got ${show(raw[name])})`); continue; }
    const known = ['label', 'type', 'value', 'choices', 'on', 'accept'];
    for (const k of Object.keys(o)) if (!known.includes(k)) bad(`unknown key ${at}.${k} (known: ${known.join(', ')})`);
    const input: AppInput = { name, label: title(name), type: 'text', value: '', choices: [], on: '', accept: [] };
    if (o.label !== undefined) {
      if (!plainText(o.label, 80) || !o.label.trim()) bad(`${at}.label must be 1 to 80 characters (got ${show(o.label)})`);
      else input.label = o.label.trim();
    }
    const type = o.type ?? (o.choices !== undefined ? 'choice' : o.on !== undefined ? 'checkbox' : types.includes('text') ? 'text' : undefined);
    if (!types.includes(type as InputType)) { bad(`${at}.type must be one of ${types.join(', ')} (got ${show(type)})`); continue; }
    input.type = type as InputType;
    if (input.type === 'choice') {
      const c = o.choices;
      const pairs: [string, unknown][] = Array.isArray(c) ? c.map((x) => [x as string, x]) : isObject(c) ? Object.entries(c) : [];
      if (!pairs.length || pairs.length > 40) { bad(`${at}.choices must be a list of 1 to 40 choices, or { "what is shown": "what {${name}} becomes" } (got ${show(c)})`); continue; }
      for (const [label, v] of pairs) {
        if (!plainText(label, 80) || !label || !plainText(v, 400)) bad(`${at}.choices: each choice is text (got ${show(label)}: ${show(v)})`);
        else if (!input.choices.some((x) => x.label === label)) input.choices.push({ label, value: v });
      }
    } else if (o.choices !== undefined) bad(`${at}.choices goes with "type": "choice"`);
    if (input.type === 'checkbox') {
      if (!plainText(o.on, 400) || !o.on) bad(`${at}.on is missing: what {${name}} becomes when the box is ticked`);
      else input.on = o.on;
    } else if (o.on !== undefined) bad(`${at}.on goes with "type": "checkbox"`);
    if (o.accept !== undefined) {
      if (input.type !== 'file') bad(`${at}.accept goes with "type": "file"`);
      else input.accept = parseAccept(o.accept, `${at}.accept`, bad);
    }
    const v = o.value;
    if (v !== undefined) {
      if (input.type === 'checkbox') { if (typeof v !== 'boolean') bad(`${at}.value must be true or false (got ${show(v)})`); else input.value = v ? 'yes' : ''; }
      else if (input.type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${at}.value must be a number (got ${show(v)})`); else input.value = String(v); }
      else if (input.type === 'file') bad(`${at}.value: a file field starts empty`);
      else if (typeof v !== 'string' || v.length > 20_000 || CONTROL.test(v.replace(/[\n\t]/g, ' '))) bad(`${at}.value must be text (got ${show(v)})`);
      else if (input.type === 'choice' && !input.choices.some((c) => c.label === v)) bad(`${at}.value must be one of its choices (got ${show(v)})`);
      else input.value = v;
    }
    if (input.type === 'choice' && !input.value && input.choices.length) input.value = input.choices[0].label;
    out.push(input);
  }
  return out;
}

function parseAccept(raw: unknown, key: string, bad: (msg: string) => void): string[] {
  if (!Array.isArray(raw) || raw.length > 40) { bad(`${key} must be a list of extensions such as ".pdf" (got ${show(raw)})`); return []; }
  const out: string[] = [];
  for (const [i, e] of raw.entries()) {
    if (typeof e !== 'string' || !EXT.test(e)) bad(`${key}[${i}] must be an extension such as ".pdf" (got ${show(e)})`);
    else if (!out.includes(e.toLowerCase())) out.push(e.toLowerCase());
  }
  return out;
}

/** The kind an app.json asks for, by the keys it has */
export function kindOf(raw: Record<string, unknown>): AppKind {
  return raw.table !== undefined || raw.columns !== undefined ? 'table' : raw.fields !== undefined ? 'form' : raw.run !== undefined ? 'files' : 'page';
}

/** Check a kind's own keys and fill in their defaults. Every problem goes to `bad`, with its key. */
export function validateKind(raw: Record<string, unknown>, kind: Exclude<AppKind, 'page'>, bad: (msg: string) => void): KindKeys & { commands: string[] } {
  const k: KindKeys = { ...NO_KIND, kind, options: [], fields: [], accept: [], columns: [] };
  const flag = (key: 'shell' | 'each' | 'live'): void => {
    if (raw[key] === undefined) return;
    if (typeof raw[key] !== 'boolean') bad(`${key} must be true or false (got ${show(raw[key])})`);
    else k[key] = raw[key] as boolean;
  };

  if (kind === 'table') {
    if (typeof raw.table !== 'string' || !TABLE_FILE.test(raw.table)) bad(`table must be the name of a .csv or .sqlite file, kept in the app's data folder (got ${show(raw.table)})`);
    else k.table = raw.table;
    const cols = raw.columns;
    if (!Array.isArray(cols) || !cols.length || cols.length > 40) bad(`columns must be a list of 1 to 40 columns: a name, or { "name", "type", "choices" } (got ${show(cols)})`);
    else for (const [i, c] of cols.entries()) {
      const o = typeof c === 'string' ? { name: c } : c;
      const at = `columns[${i}]`;
      if (!isObject(o)) { bad(`${at} must be a name, or { "name", "type", "choices" } (got ${show(c)})`); continue; }
      for (const key of Object.keys(o)) if (!['name', 'type', 'choices'].includes(key)) bad(`unknown key ${at}.${key} (known: name, type, choices)`);
      if (!plainText(o.name, 40) || !o.name.trim() || /["\n]/.test(o.name)) { bad(`${at}.name must be 1 to 40 characters, without " (got ${show(o.name)})`); continue; }
      const name = o.name.trim();
      if (k.columns.some((x) => x.name.toLowerCase() === name.toLowerCase())) { bad(`${at}.name ${show(name)} is the name of an earlier column`); continue; }
      const type = (o.type ?? (o.choices !== undefined ? 'choice' : 'text')) as ColumnType;
      if (!COLUMN_TYPES.includes(type)) { bad(`${at}.type must be one of ${COLUMN_TYPES.join(', ')} (got ${show(o.type)})`); continue; }
      const choices: string[] = [];
      if (type === 'choice') {
        if (!Array.isArray(o.choices) || !o.choices.length || o.choices.length > 60 || o.choices.some((x) => !plainText(x, 80) || !x)) { bad(`${at}.choices must be a list of 1 to 60 choices (got ${show(o.choices)})`); continue; }
        choices.push(...new Set(o.choices as string[]));
      } else if (o.choices !== undefined) bad(`${at}.choices goes with "type": "choice"`);
      k.columns.push({ name, type, choices });
    }
    return { ...k, commands: k.table.endsWith('.sqlite') ? ['sqlite3'] : [] };
  }

  flag('shell');
  if (kind === 'files') {
    flag('each');
    if (raw.accept !== undefined) k.accept = parseAccept(raw.accept, 'accept', bad);
    k.options = parseInputs(raw.options, 'options', ['choice', 'checkbox'], bad);
  } else {
    flag('live');
    k.fields = parseInputs(raw.fields, 'fields', INPUT_TYPES, bad);
    if (raw.output !== undefined) {
      if (!OUTPUTS.includes(raw.output as OutputKind)) bad(`output must be one of ${OUTPUTS.join(', ')} (got ${show(raw.output)})`);
      else k.output = raw.output as OutputKind;
    }
    if (raw.stdin !== undefined) {
      if (typeof raw.stdin !== 'string' || raw.stdin.length > 2000) bad(`stdin must be text: what the program reads, with {fields} filled in (got ${show(raw.stdin)})`);
      else k.stdin = raw.stdin;
    }
  }
  const inputs = kind === 'files' ? k.options : k.fields;
  const fileOut = kind === 'files' || k.output === 'file';

  // out: the result's name
  if (raw.out !== undefined) {
    if (!plainText(raw.out, 120) || !raw.out.trim() || /[/\\]/.test(raw.out)) bad(`out must be the result's name, without a folder (got ${show(raw.out)})`);
    else if (!fileOut) bad('out goes with "output": "file": the name of the file the command makes');
    else k.out = raw.out.trim();
  }
  const nameWords = kind === 'files' && k.each ? ['name', 'ext'] : [];
  for (const p of placeholders(k.out)) if (!nameWords.includes(p)) bad(`out: {${p}} is not known here (${nameWords.length ? `known: ${nameWords.map((n) => `{${n}}`).join(', ')}` : 'the name is plain text'})`);
  if (fileOut && !k.out && !(kind === 'files' && k.each)) bad(kind === 'files' ? 'out is missing: with "each": false there is one result, and it needs a name' : 'out is missing: the name of the file the command makes');

  // run: the command
  let commands: string[] = [];
  const run = raw.run;
  if (typeof run !== 'string' || !run.trim() || run.length > 2000 || CONTROL.test(run)) {
    bad(`run ${run === undefined ? 'is missing' : 'must be one line'}: the command, with ${kind === 'files' ? '{in} where the file goes' : 'a {field} where each value goes'} (got ${show(run)})`);
    return { ...k, commands };
  }
  k.run = run.trim();
  const known = [...(kind === 'files' ? (k.each ? FILE_WORDS : ['in', 'out', 'dir']) : fileOut ? ['out'] : []), ...inputs.map((i) => i.name)];
  for (const [key, text] of [['run', k.run], ['stdin', k.stdin]] as const) {
    for (const p of placeholders(text)) {
      if (known.includes(p) && !(key === 'stdin' && p === 'out')) continue;
      bad(`${key}: {${p}} is not known (known: ${known.map((n) => `{${n}}`).join(', ') || 'none'})${kind === 'files' && !k.each && (p === 'name' || p === 'ext') ? '; with "each": false there is no one input to name' : ''}`);
    }
  }
  if (kind === 'files' && !placeholders(k.run).includes('in')) bad('run must say where the file goes: {in}');
  if (k.shell) {
    const q = quotedPlaceholder(k.run);
    if (q) bad(`run: {${q}} is inside quotes; with "shell": true tabcomputer quotes each value itself, so write it bare`);
    return { ...k, commands };
  }
  let words: string[] = [];
  try { words = splitRun(k.run); } catch (e) { bad(`run: ${(e as Error).message}`); }
  if (words.length && !COMMAND.test(words[0])) bad(`run must start with a program's name, without a path (got ${show(words[0])})`);
  else if (words.length) commands = [words[0]];
  const op = words.find((w) => SHELL_WORDS.has(w));
  if (op) bad(`run: ${op} is something only a shell understands; add "shell": true, or leave it out`);
  if (kind === 'files' && !k.each && words.some((w) => w.includes('{in}') && w !== '{in}')) bad('run: with "each": false {in} is every file, so it must be a word of its own');
  return { ...k, commands };
}

const list = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A declared app, said in parts: the install prompt shows the first five, and the rest on request */
export interface KindSaid {
  /** Its own words for what it does ('' without `about`) */
  about: string;
  /** What it does, up to the command: "NAME runs this command once for each file you give it" (a table: where it is kept) */
  does: string;
  /** The exact command ('' for a table) */
  run: string;
  /** What is installed before its first start ('' when nothing is) */
  installs: string;
  /** The one sentence on what it can touch: the program's reach, or that it runs none */
  touches: string;
  /** How a result is named ('' when there is no result file) */
  named: string;
  /** What its page may use */
  page: string;
}

export function kindSaid(m: KindKeys & { name: string; description: string; needs: string[]; toolchains: string[] }): KindSaid {
  const s: KindSaid = { about: m.description, does: '', run: '', installs: '', touches: '', named: '', page: 'Its page may use only its own data folder, and is kept from other sites.' };
  if (m.kind === 'table') {
    s.does = `${m.name} keeps a table in ${m.table}, in its own data folder.`;
    s.touches = m.table.endsWith('.sqlite') ? 'It runs the program sqlite3 on that file, and no other program.' : 'It runs no program.';
  } else {
    const when = m.kind === 'files' ? (m.each ? 'once for each file you give it' : 'once, with all the files you give it') : m.live ? 'as you type' : 'when you choose Run';
    s.does = `${m.name} runs this ${m.shell ? 'shell line' : 'command'} ${when}`;
    s.run = m.run;
    // (without `out` a result keeps its file's name, with the extension of what the program made: host.ts)
    if (m.kind === 'files') s.named = m.each ? `Each result is named ${m.out || 'after the file it came from'}.` : `The result is named ${m.out}.`;
    else if (m.output === 'file') s.named = `The result is named ${m.out}.`;
    s.touches = m.shell
      ? 'A shell line can do everything a terminal here can: it can read and change every file in this tab.'
      : `${m.run.split(/\s+/)[0]} is an ordinary program in this tab: it can read and change every file here.`;
  }
  const installs = [
    m.toolchains.length ? `the ${m.toolchains.length > 1 ? 'toolchains' : 'toolchain'} ${list(m.toolchains)}` : '',
    m.needs.length ? `the Debian ${m.needs.length > 1 ? 'packages' : 'package'} ${list(m.needs)}` : '',
  ].filter(Boolean);
  if (installs.length) s.installs = `Before its first start it installs ${installs.join(', and ')}.`;
  return s;
}

/**
 * A declared app as every sentence there is to say about it (`app check`):
 * what it does, the exact command, how results are named, what the program
 * can touch, what it installs, what its page may use.
 */
export function kindSentences(m: KindKeys & { name: string; description: string; needs: string[]; toolchains: string[] }): string[] {
  const s = kindSaid(m);
  return [s.about, s.run ? `${s.does}: ${s.run}` : s.does, s.named, s.touches, s.installs, s.page].filter(Boolean);
}

/** The extensions `sniffKind` names, by what the bytes are */
const ZIP_KINDS: [RegExp, string][] = [
  [/^mimetypeapplication\/vnd\.oasis\.opendocument\.text/, 'odt'], [/^mimetypeapplication\/vnd\.oasis\.opendocument\.spreadsheet/, 'ods'],
  [/^mimetypeapplication\/vnd\.oasis\.opendocument\.presentation/, 'odp'], [/^mimetypeapplication\/epub\+zip/, 'epub'],
];

/**
 * What a file is, from its first bytes, as the extension such a file has:
 * pdf, png, jpg, gif, zip (docx, xlsx, pptx, odt, ods, odp, epub), gz, and for
 * text json, html, svg or txt. '' when it is none of these (or empty).
 * `head` is the start of the file, and `whole` says that it is all of it.
 */
export function sniffKind(head: Uint8Array, whole = true): string {
  const at = (bytes: number[], from = 0) => bytes.every((b, i) => head[from + i] === b);
  if (!head.length) return '';
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at([0xff, 0xd8, 0xff])) return 'jpg';
  if (at([0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'gif';
  if (at([0x1f, 0x8b])) return 'gz';
  const latin = (from: number, to: number) => String.fromCharCode(...head.subarray(from, Math.min(head.length, to)));
  if (at([0x50, 0x4b, 0x03, 0x04])) {
    // The first member's name and, when it is stored as it is, its text: OpenDocument and EPUB say what they are there
    const nameLen = (head[26] ?? 0) | ((head[27] ?? 0) << 8), extra = (head[28] ?? 0) | ((head[29] ?? 0) << 8);
    const first = latin(30, 30 + nameLen) + latin(30 + nameLen + extra, 30 + nameLen + extra + 60);
    for (const [re, ext] of ZIP_KINDS) if (re.test(first)) return ext;
    // Office Open XML: the folder of its parts is named among the first members
    const names = latin(0, 4096);
    if (/\[Content_Types\]\.xml|_rels\/\.rels/.test(names)) return /word\//.test(names) ? 'docx' : /xl\//.test(names) ? 'xlsx' : /ppt\//.test(names) ? 'pptx' : 'zip';
    return 'zip';
  }
  // Text: UTF-8 that decodes (a part of a file may end inside a character) and has no control characters
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(whole ? head : head.subarray(0, lastWhole(head))); } catch { return ''; }
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return '';
  const t = text.replace(/^﻿/, '').trim();
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return 'html';
  if (/^<svg[\s>]/i.test(t) || (/^<\?xml/i.test(t) && /<svg[\s>]/i.test(t))) return 'svg';
  // JSON: an object or a list that reads as one; of a long file only the start is known
  if (/^[{[]/.test(t)) {
    if (!whole) { if (/^(\{\s*["}]|\[\s*[[{"\]])/.test(t)) return 'json'; } else { try { JSON.parse(t); return 'json'; } catch { /* text that starts with a bracket */ } }
  }
  return t ? 'txt' : '';
}
/** Where the last whole UTF-8 character of `b` ends */
function lastWhole(b: Uint8Array): number {
  let i = b.length;
  while (i > 0 && (b[i - 1] & 0xc0) === 0x80) i--;
  return i > 0 && b[i - 1] >= 0xc0 ? i - 1 : b.length;
}
