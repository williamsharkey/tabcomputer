/**
 * What the part of an address after `#` means (docs/RUN_LINKS.md "After the
 * #", tabcomputer#147). A browser never sends that part to a server, so a
 * link written this way reaches only the page.
 *
 *   #pip install flask && python3 app.py     commands, run in a new Terminal
 *   #sh:name=World; echo hello $name         commands, whatever they start with
 *   #gz:H4sIA…                               commands, gzipped (what `link` makes for a long script)
 *   #run=jq . {in}&accept=.json&name=Tidy    a one-file app: the keys of app.json as key=value
 *   #app=H4sIA…                              an app's files, gzipped (what `app share` makes)
 *   #gist:ID   #gist:USER/ID                 a gist: an app when it holds an app.json, else its first script
 *
 * The rule that tells an app from commands: the part after `#` is an app when
 * it starts with a key of app.json and `=` (`run=`, `name=`, `table=`, …).
 * Everything else is commands. `#sh:` makes it commands whatever follows.
 *
 * Nothing here runs or installs anything: src/run-url.ts and
 * src/apps/links.ts take what this module reads to their prompts.
 *
 * No DOM and no imports. public/link/fragment.js is the same encoding for the
 * /link page; link-fragment.test.ts checks the two agree.
 */

/** The longest part after `#` this page reads, in characters */
export const FRAGMENT_MAX = 48_000;
/** The longest address that still counts as one a person can read (and that mail and chat programs keep whole) */
export const READABLE_MAX = 2_000;

/** A part after `#` that this page will not act on, and why (a sentence; no text from the link) */
export class FragmentError extends Error {}

export type FragmentLink =
  /** `key=value` pairs, in the order written, percent-decoded */
  | { kind: 'app'; pairs: [string, string][] }
  /** `#app=<payload>`: an app's files (src/apps/share.ts) */
  | { kind: 'packed-app'; payload: string }
  /** The commands, percent-decoded: what the prompt shows and the Terminal runs */
  | { kind: 'commands'; text: string }
  /** `#gz:<payload>`: the commands, gzipped and base64url */
  | { kind: 'packed-commands'; payload: string }
  /** `user` is '' for #gist:ID; `file` is '' unless the link names one */
  | { kind: 'gist'; user: string; id: string; file: string };

const STRING_KEYS = ['name', 'about', 'description', 'id', 'version', 'run', 'out', 'stdin', 'output', 'table'];
const FLAG_KEYS = ['shell', 'each', 'live'];
const LIST_KEYS = ['accept', 'needs', 'toolchains'];
const WINDOW_NUMBERS = ['width', 'height', 'minWidth', 'minHeight'];
const WINDOW_FLAGS = ['resizable', 'multiple'];
const INPUT_KEYS = ['label', 'type', 'value', 'choices', 'on', 'accept'];
const COLUMN_TYPES = ['text', 'number', 'date', 'choice', 'checkbox'];
/** The keys a link may give, as the error for an unknown one lists them */
export const LINK_KEYS = [...STRING_KEYS.filter((k) => k !== 'description'), ...LIST_KEYS, ...FLAG_KEYS, 'columns', 'field.NAME', 'option.NAME', 'window.width', 'window.height'];
const TOP_KEYS = new Set([...STRING_KEYS, ...FLAG_KEYS, ...LIST_KEYS, 'columns', 'fields', 'options', 'manifest']);
const GROUP = /^(fields?|options?|window)\./;

/** Is `key` one a link's app may give? (`run`, `field.filter`, `window.width`, …) */
export function isAppKey(key: string): boolean {
  return TOP_KEYS.has(key) || GROUP.test(key);
}

/**
 * Percent-decoding that never fails: `%20` is a space and `%0A` a line break;
 * a `%` that starts no UTF-8 sequence stays as it was typed (`50%`). `+` is a
 * plus (`g++`), not a space.
 */
export function decodeLoose(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try { return decodeURIComponent(run); } catch {
      return run.replace(/%([0-7][0-9A-Fa-f])/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  });
}

const GIST_ID = /^[0-9a-f]{5,40}$/;
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const PAYLOAD = /^[A-Za-z0-9_-]+$/;

/**
 * Read the part of an address after `#` (with or without the `#`). Null when
 * it is empty or is safe mode's `#safe`. Throws FragmentError for a link that
 * is too long or names nothing.
 */
export function parseFragment(hash: string): FragmentLink | null {
  const f = (hash.startsWith('#') ? hash.slice(1) : hash).replace(/^(?:%20|%09|%0[AaDd]|\s)+/, '');
  if (!f || /^safe\b/.test(f)) return null;
  if (f.length > FRAGMENT_MAX) throw new FragmentError(`the link is longer than ${FRAGMENT_MAX.toLocaleString('en-US')} characters: put the script or the app in a gist and open #gist:ID`);
  const prefix = /^(sh|gz|gist):/i.exec(f);
  if (prefix) {
    const kind = prefix[1].toLowerCase();
    const rest = f.slice(prefix[0].length);
    if (kind === 'sh') {
      const text = commandsText(decodeLoose(rest));
      if (!text) throw new FragmentError('the link has no commands after #sh:');
      return { kind: 'commands', text };
    }
    if (kind === 'gz') {
      if (!PAYLOAD.test(rest)) throw new FragmentError('the link does not hold a script (it may have been cut short when it was copied)');
      return { kind: 'packed-commands', payload: rest };
    }
    const parts = decodeLoose(rest).trim().split('/');
    const [user, id, file] = parts.length === 1 ? ['', parts[0], ''] : [parts[0], parts[1] ?? '', parts[2] ?? ''];
    if (parts.length > 3 || !GIST_ID.test(id) || (parts.length > 1 && !GH_OWNER.test(user)) || (parts.length === 3 && (!GH_SEGMENT.test(file) || file === '.' || file === '..'))) {
      throw new FragmentError('a gist link is #gist:ID or #gist:USER/ID');
    }
    return { kind: 'gist', user, id, file };
  }
  if (f.startsWith('app=')) return { kind: 'packed-app', payload: f.slice(4) };
  const eq = f.indexOf('=');
  const amp = f.indexOf('&');
  const first = eq > 0 && (amp < 0 || eq < amp) ? decodeLoose(f.slice(0, eq)).trim() : '';
  if (first && isAppKey(first)) return { kind: 'app', pairs: splitPairs(f) };
  const text = commandsText(decodeLoose(f));
  return text ? { kind: 'commands', text } : null;
}

/** Commands as the Terminal gets them: LF line ends, no blank lines around them, one line end at the end */
function commandsText(s: string): string {
  const t = s.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  return t.trim() ? t + '\n' : '';
}

/**
 * `a=1&b=two words` as pairs. `&` separates them and the first `=` of each
 * ends its key, both before percent-decoding, so a value holds either as
 * `%26` and `%3D` (an `=` in a value needs no escape). A part without `=` is a
 * key alone (`&live`); an empty part (a doubled or last `&`) is skipped.
 */
export function splitPairs(f: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of f.split('&')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    out.push(eq < 0 ? [decodeLoose(part).trim(), ''] : [decodeLoose(part.slice(0, eq)).trim(), decodeLoose(part.slice(eq + 1))]);
  }
  return out;
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;
const flag = (v: string): unknown => (/^(true|yes|on|1)$/i.test(v.trim()) ? true : /^(false|no|off|0)$/i.test(v.trim()) ? false : v);
const number = (v: string): unknown => (NUMBER.test(v.trim()) ? Number(v) : v);
const list = (v: string, sep: string): string[] => v.split(sep).map((s) => s.trim()).filter(Boolean);
const looksJson = (v: string): boolean => /^\s*[[{]/.test(v);

/** `Date:date,What,Category:Food|Travel,Amount:number` as app.json's `columns` */
function columnsOf(v: string): unknown[] {
  return list(v, ',').map((item) => {
    const [name, second, ...more] = item.split(':').map((s) => s.trim());
    if (second === undefined) return name;
    if (more.length) return { name, type: second, choices: list(more.join(':'), '|') };
    // (one word that is no type is a mistyped type, not a column with one choice: the manifest's check names it)
    return second.includes('|') ? { name, choices: list(second, '|') } : { name, type: second };
  });
}

/** `A|B|C` as a list; `Small=/ebook|Print=/printer` as what is shown and what it becomes */
function choicesOf(v: string): unknown {
  const items = v.split('|').map((s) => s.trim()).filter(Boolean);
  if (!items.length || !items.every((s) => s.indexOf('=') > 0)) return items;
  return Object.fromEntries(items.map((s) => [s.slice(0, s.indexOf('=')).trim(), s.slice(s.indexOf('=') + 1)]));
}

/**
 * The app.json a link's pairs spell, and what is wrong with them, each
 * problem naming its key. What a value must be is src/apps/manifest.ts's to
 * say: a number that is not one goes through as text, and is reported there.
 *
 *   name=…  about=…  run=…  out=…  stdin=…  output=…  table=…  id=…  version=…    text
 *   accept=.png,.jpg   needs=a,b   toolchains=c                                    lists, by commas
 *   shell  each  live  (=true|false|yes|no; the key alone is true)                 switches
 *   columns=Date:date,What,Category:Food|Travel,Amount:number                      Name, Name:type, Name:choice|choice (one choice: Name:choice:only)
 *   field.NAME=Label                                                               a field and its label, in the order written
 *   field.NAME.type|value|choices|on|accept=…                                      the rest of a field (choices: A|B, or Shown=value|Shown=value)
 *   option.NAME…                                                                   the same, for a files app's options
 *   window.width=…  window.height=…                                                numbers
 *   columns=[…]  fields={…}  options={…}                                           app.json's own JSON, for what the short forms cannot say
 */
export function manifestFromPairs(pairs: [string, string][]): { raw: Record<string, unknown>; problems: string[] } {
  const raw: Record<string, unknown> = {};
  const problems: string[] = [];
  const seen = new Set<string>();
  const json = (key: string, v: string): unknown => {
    try { return JSON.parse(v); } catch (e) { problems.push(`${key} is not valid JSON (${(e as Error).message})`); return undefined; }
  };
  const group = (key: 'fields' | 'options'): Record<string, unknown> => {
    if (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key])) raw[key] = {};
    return raw[key] as Record<string, unknown>;
  };
  for (const [k, v] of pairs) {
    if (seen.has(k)) { problems.push(`${k} is given twice`); continue; }
    seen.add(k);
    if (STRING_KEYS.includes(k)) raw[k] = v;
    else if (FLAG_KEYS.includes(k)) raw[k] = v === '' ? true : flag(v);
    else if (LIST_KEYS.includes(k)) raw[k] = list(v, ',');
    else if (k === 'manifest') raw[k] = number(v);
    else if (k === 'columns') { const c = looksJson(v) ? json(k, v) : columnsOf(v); if (c !== undefined) raw[k] = c; }
    else if (k === 'fields' || k === 'options') {
      if (!looksJson(v)) problems.push(`${k} is JSON here ({…}); one ${k.slice(0, -1)} is ${k.slice(0, -1)}.NAME=Label`);
      else { const o = json(k, v); if (o !== undefined) raw[k] = o; }
    } else if (k.startsWith('window.')) {
      const sub = k.slice(7);
      if (!WINDOW_NUMBERS.includes(sub) && !WINDOW_FLAGS.includes(sub)) { problems.push(`unknown key ${k} (known: ${[...WINDOW_NUMBERS, ...WINDOW_FLAGS].map((s) => `window.${s}`).join(', ')})`); continue; }
      if (!raw.window || typeof raw.window !== 'object') raw.window = {};
      (raw.window as Record<string, unknown>)[sub] = WINDOW_NUMBERS.includes(sub) ? number(v) : flag(v);
    } else if (GROUP.test(k)) {
      const [head, name = '', sub, ...more] = k.split('.');
      const which = head.startsWith('field') ? 'fields' : 'options';
      const one = which.slice(0, -1);
      if (!name) { problems.push(`${k} needs a name: ${one}.NAME=Label`); continue; }
      if (more.length || (sub !== undefined && !INPUT_KEYS.includes(sub))) { problems.push(`unknown key ${k} (known: ${one}.${name}, ${INPUT_KEYS.map((s) => `${one}.${name}.${s}`).join(', ')})`); continue; }
      const g = group(which);
      const o = (g[name] && typeof g[name] === 'object' ? g[name] : (g[name] = {})) as Record<string, unknown>;
      if (sub === undefined || sub === 'label') {
        if (o.label !== undefined) problems.push(`${one}.${name} has two labels (${one}.${name}= and ${one}.${name}.label=)`);
        o.label = v;
      } else if (sub === 'choices') o.choices = looksJson(v) ? json(k, v) : choicesOf(v);
      else if (sub === 'accept') o.accept = list(v, ',');
      else o[sub] = v;
    } else problems.push(`unknown key ${k || '(nothing before =)'} (known: ${LINK_KEYS.join(', ')})`);
  }
  // A field's value is typed by its type, which the link may give after it
  for (const key of ['fields', 'options'] as const) {
    const g = raw[key];
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    for (const o of Object.values(g as Record<string, unknown>)) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
      const i = o as Record<string, unknown>;
      if (typeof i.value !== 'string') continue;
      if (i.type === 'number') i.value = number(i.value);
      else if (i.type === 'checkbox' || (i.type === undefined && i.on !== undefined && i.choices === undefined)) i.value = flag(i.value);
    }
  }
  if (!problems.length && raw.run === undefined && raw.fields === undefined && raw.table === undefined && raw.columns === undefined) {
    problems.push('run is missing: an app in a link has run, fields or table. To run commands that start this way, write #sh: before them');
  }
  return { raw, problems };
}

const plainItem = (s: unknown, not: RegExp): s is string => typeof s === 'string' && !!s && s === s.trim() && !not.test(s);

function columnsText(cols: unknown): string | null {
  if (!Array.isArray(cols) || !cols.length) return null;
  const out: string[] = [];
  for (const c of cols) {
    const o = typeof c === 'string' ? { name: c } : c as { name?: unknown; type?: unknown; choices?: unknown };
    if (!o || typeof o !== 'object' || Object.keys(o).some((k) => !['name', 'type', 'choices'].includes(k))) return null;
    if (!plainItem(o.name, /[,:|]/) || /^[[{]/.test(o.name)) return null;
    const choices = o.choices === undefined ? '' : Array.isArray(o.choices) && o.choices.length && o.choices.every((x) => plainItem(x, /[,|]/)) ? (o.choices as string[]).join('|') : null;
    if (choices === null || (o.type !== undefined && !COLUMN_TYPES.includes(o.type as string))) return null;
    // Two or more choices are written without the type; one choice needs it, or it would read as a type
    if (choices) out.push(o.type === undefined && choices.includes('|') ? `${o.name}:${choices}` : `${o.name}:${(o.type as string | undefined) ?? 'choice'}:${choices}`);
    else out.push(o.type === undefined ? o.name : `${o.name}:${o.type as string}`);
  }
  return out.join(',');
}

function choicesText(c: unknown): string | null {
  if (Array.isArray(c)) return c.length && c.every((x) => plainItem(x, /[|=]/)) && !/^[[{]/.test(c[0]) ? c.join('|') : null;
  if (!c || typeof c !== 'object') return null;
  const e = Object.entries(c as Record<string, unknown>);
  return e.length && e.every(([k, v]) => plainItem(k, /[|=]/) && typeof v === 'string' && !/[|]/.test(v) && v === v.trim()) && !/^[[{]/.test(e[0][0])
    ? e.map(([k, v]) => `${k}=${v as string}`).join('|') : null;
}

function inputPairs(one: 'field' | 'option', group: unknown): [string, string][] | null {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
  const out: [string, string][] = [];
  for (const [name, v] of Object.entries(group as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) return null;
    const o = typeof v === 'string' ? { label: v } : v as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).some((k) => !INPUT_KEYS.includes(k))) return null;
    // The field's own pair comes first, so the fields keep their order; without a label, its first key does that
    if (typeof o.label === 'string') out.push([`${one}.${name}`, o.label]);
    else if (o.label !== undefined || !Object.keys(o).length) return null;
    for (const [k, x] of Object.entries(o)) {
      if (k === 'label') continue;
      if (k === 'choices') { const t = choicesText(x); if (t === null) return null; out.push([`${one}.${name}.choices`, t]); }
      else if (k === 'accept') { if (!Array.isArray(x) || !x.every((s) => plainItem(s, /,/))) return null; out.push([`${one}.${name}.accept`, x.join(',')]); }
      else if (k === 'value' && (typeof x === 'number' || typeof x === 'boolean')) out.push([`${one}.${name}.value`, String(x)]);
      else if (typeof x === 'string') out.push([`${one}.${name}.${k}`, x]);
      else return null;
    }
  }
  return out;
}

/**
 * An app.json (parsed) as a link's pairs, in the file's own order; null when
 * it has something a link's keys cannot say (an icon, a page, a backend).
 * The short forms are used where they fit and app.json's own JSON where they
 * do not. The caller checks that the pairs read back as the same app.
 */
export function pairsFromManifest(raw: Record<string, unknown>): [string, string][] | null {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (STRING_KEYS.includes(k)) { if (typeof v !== 'string') return null; out.push([k, v]); }
    else if (FLAG_KEYS.includes(k)) { if (typeof v !== 'boolean') return null; out.push([k, String(v)]); }
    else if (LIST_KEYS.includes(k)) { if (!Array.isArray(v) || !v.every((s) => plainItem(s, /,/))) return null; out.push([k, v.join(',')]); }
    else if (k === 'manifest') { if (typeof v !== 'number') return null; out.push([k, String(v)]); }
    else if (k === 'columns') out.push([k, columnsText(v) ?? JSON.stringify(v)]);
    else if (k === 'fields' || k === 'options') {
      const p = inputPairs(k === 'fields' ? 'field' : 'option', v);
      if (p) out.push(...p); else out.push([k, JSON.stringify(v)]);
    } else if (k === 'window') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      for (const [w, x] of Object.entries(v as Record<string, unknown>)) {
        if (!(WINDOW_NUMBERS.includes(w) && typeof x === 'number') && !(WINDOW_FLAGS.includes(w) && typeof x === 'boolean')) return null;
        out.push([`window.${w}`, String(x)]);
      }
    } else return null;
  }
  return out;
}

/**
 * Text as part of an address after `#`, so that a mail or chat program keeps
 * the link whole: letters, digits and `-._~!$'()*+,;=:@/?` stay, everything
 * else is percent-encoded (a space is `%20`, a line break `%0A`). `keep` adds
 * `&` for commands; in a pair's value `&` is `%26`.
 */
function encodePart(s: string, keep: string): string {
  let out = '';
  for (const ch of s) out += /[A-Za-z0-9\-._~!$'()*+,;=:@/?]/.test(ch) || keep.includes(ch) ? ch : encodeURIComponent(ch);
  return out;
}

/** A last character that programs take for the sentence's own punctuation, not the link's */
function endSafely(f: string): string {
  const last = f.slice(-1);
  return /[.,;:!?')]/.test(last) ? f.slice(0, -1) + '%' + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') : f;
}

/** Commands as the part of an address after `#` (without the `#`): `sh:` goes first only where they would read as something else */
export function commandsFragment(script: string): string {
  const text = script.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  const f = encodePart(text, '&');
  let other = true;
  try { const p = parseFragment(f); other = !p || p.kind !== 'commands' || p.text !== text + '\n'; } catch { /* too long: the caller measures it */ }
  return endSafely(other ? 'sh:' + f : f);
}

/** Pairs as the part of an address after `#` (without the `#`) */
export function appFragment(pairs: [string, string][]): string {
  return endSafely(pairs.map(([k, v]) => `${encodePart(k, '').replace(/=/g, '%3D')}=${encodePart(v, '')}`).join('&'));
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function throughStream(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, max: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new FragmentError('the script in the link is too long'); }
    parts.push(value);
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** A script as `#gz:`'s payload: UTF-8, gzipped, base64url */
export async function packCommands(script: string): Promise<string> {
  return toBase64Url(await throughStream(new TextEncoder().encode(script), new CompressionStream('gzip') as never, 64 << 20));
}

/** The bytes of the script a `#gz:` payload holds, at most `max` of them */
export async function unpackCommands(payload: string, max: number): Promise<Uint8Array> {
  if (!payload || payload.length > FRAGMENT_MAX || !PAYLOAD.test(payload)) throw new FragmentError('the link does not hold a script (it may have been cut short when it was copied)');
  try {
    const bin = atob(payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4));
    return await throughStream(Uint8Array.from(bin, (c) => c.charCodeAt(0)), new DecompressionStream('gzip') as never, max);
  } catch (e) {
    if (e instanceof FragmentError) throw e;
    throw new FragmentError('the link does not hold a script (it may have been cut short when it was copied)');
  }
}

export type LinkForm = 'readable' | 'compressed' | 'gist';

export interface ScriptLink {
  /** Which form the script fits: a link a person can read, a compressed link, or only a gist */
  form: LinkForm;
  /** The address ('' for 'gist': the script is too long for any link) */
  url: string;
  /** The readable address's length, and the compressed one's, in characters */
  readable: number;
  compressed: number;
}

/**
 * The link for a script, by size: the readable form up to READABLE_MAX
 * characters, else the compressed form up to FRAGMENT_MAX after the `#`, else
 * none (a gist holds it). `origin` is the site's, without a slash at its end.
 */
export async function scriptLink(script: string, origin: string): Promise<ScriptLink> {
  const readable = `${origin}/#${commandsFragment(script)}`;
  const payload = await packCommands(script.endsWith('\n') ? script : script + '\n');
  const compressed = `${origin}/#gz:${payload}`;
  const form: LinkForm = readable.length <= READABLE_MAX ? 'readable' : payload.length + 3 <= FRAGMENT_MAX ? 'compressed' : 'gist';
  return { form, url: form === 'readable' ? readable : form === 'compressed' ? compressed : '', readable: readable.length, compressed: compressed.length };
}
