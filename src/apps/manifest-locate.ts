/**
 * Where in the text of an app.json each problem is (the Code app's app mode,
 * docs/APPS.md "App mode in the Code app"): the manifest is checked as it is
 * typed, and each problem `validateManifest` names is underlined at the key it
 * names. No DOM here.
 *
 * `jsonPlaces` reads JSON and keeps, for every key path (`window.width`,
 * `columns[2].type`, `fields.json.value`), where its key and its value are. A
 * problem's message starts with the path it is about; a path the text does not
 * have (a key that is missing) is underlined at the nearest key above it that
 * it does have, the object itself at the top.
 */
import { ManifestError, validateManifest, type ManifestHint } from './manifest';

/** A span of the text: [from, to) */
export type Span = [number, number];
export interface Place { key: Span | null; value: Span }
export interface JsonPlaces { places: Map<string, Place>; error: { at: number; message: string } | null }

class JsonSyntax extends Error { constructor(readonly at: number, message: string) { super(message); } }

/** Every key path of a JSON text with its spans, or where the text stops being JSON */
export function jsonPlaces(text: string): JsonPlaces {
  const places = new Map<string, Place>();
  let i = 0;
  const ws = () => { while (i < text.length && /[ \t\n\r]/.test(text[i])) i++; };
  const fail = (what: string): never => {
    throw new JsonSyntax(i, i >= text.length ? `the text ends where ${what} is expected` : `${what} is expected here, not ${JSON.stringify(text[i])}`);
  };
  const str = (): string => {
    if (text[i] !== '"') fail('a "');
    const from = i++;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        i++;
        try { return JSON.parse(text.slice(from, i)) as string; } catch { throw new JsonSyntax(from, 'a string has a \\ that JSON does not know'); }
      }
      if (c === '\\') i++;
      else if (c < ' ') throw new JsonSyntax(i, 'a line break or a control character is inside a string: write it as \\n');
    }
    throw new JsonSyntax(from, 'a string is never closed');
  };
  const value = (path: string, key: Span | null): void => {
    ws();
    const from = i;
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') i++;
      else for (;;) {
        ws();
        const kFrom = i;
        const k = str();
        const kSpan: Span = [kFrom, i];
        ws();
        if (text[i] !== ':') fail('a :');
        i++;
        value(path ? `${path}.${k}` : k, kSpan);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('a , or a }');
      }
    } else if (c === '[') {
      i++; ws();
      let n = 0;
      if (text[i] === ']') i++;
      else for (;;) {
        value(`${path}[${n++}]`, null);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('a , or a ]');
      }
    } else if (c === '"') str();
    else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) fail('a value');
      i += m![0].length;
    }
    places.set(path, { key, value: [from, i] });
  };
  try {
    value('', null);
    ws();
    if (i < text.length) fail('the end of the text');
    return { places, error: null };
  } catch (e) {
    if (e instanceof JsonSyntax) return { places, error: { at: e.at, message: e.message } };
    throw e;
  }
}

/** The key path a problem's message is about: `unknown key a.b`, `columns[2].type must…`, `run: {x}…`; '' for the whole */
export function problemPath(message: string): string {
  const unknown = /^unknown key (\S+?)(?: \(|$)/.exec(message);
  if (unknown) return unknown[1];
  return /^([A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z0-9_]+)*)/.exec(message)?.[1] ?? '';
}

/** The span to underline for a path: its key, or an array item's value; the nearest one the text has above a missing one */
export function spanFor(path: string, j: JsonPlaces, text: string): Span {
  let p = path;
  for (;;) {
    const place = j.places.get(p);
    if (place && p) return place.key ?? place.value;
    if (!p) break;
    const cut = Math.max(p.lastIndexOf('.'), p.lastIndexOf('['));
    p = cut > 0 ? p.slice(0, cut) : '';
  }
  // The whole manifest: its first line
  const top = j.places.get('')?.value[0] ?? 0;
  const eol = text.indexOf('\n', top);
  return [top, Math.max(top + 1, eol < 0 ? text.length : eol)];
}

export interface Located { from: number; to: number; message: string }

/**
 * The problems of an app.json's text, each with where it is: what `app check`
 * says (`validateManifest`), or where the text stops being JSON.
 */
export function locateProblems(text: string, hint: ManifestHint = {}): Located[] {
  const j = jsonPlaces(text);
  if (j.error) {
    const at = Math.min(j.error.at, Math.max(0, text.length - 1));
    return [{ from: at, to: Math.min(text.length, at + 1), message: `app.json is not valid JSON: ${j.error.message}` }];
  }
  try { validateManifest(JSON.parse(text), hint); return []; } catch (e) {
    if (!(e instanceof ManifestError)) throw e;
    return e.problems.map((message) => { const [from, to] = spanFor(problemPath(message), j, text); return { from, to, message }; });
  }
}
