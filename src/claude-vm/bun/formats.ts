/** Bun.YAML (parse, stringify) and Bun.TOML (parse), with the yaml and smol-toml packages */
import { parse as yamlParse, parseAllDocuments } from 'yaml';
import { parse as tomlParse } from 'smol-toml';

export const YAML = {
  /** One document's value; a stream of several documents is an array of them, as Bun returns it */
  parse(input: unknown): unknown {
    const text = typeof input === 'string' ? input : new TextDecoder().decode(input as Uint8Array);
    const docs = parseAllDocuments(text);
    if (Array.isArray(docs) && docs.length > 1) {
      return docs.map((d) => { if (d.errors.length) throw new SyntaxError(d.errors[0].message); return d.toJS(); });
    }
    try { return yamlParse(text); } catch (e: any) { throw new SyntaxError(e?.message ?? String(e)); }
  },
  /** JSON.stringify's arguments: (value, replacer, space); with space, block style; without, flow style, as Bun writes them */
  stringify(value: unknown, replacer?: unknown, space?: string | number): string {
    void replacer;
    const indent = typeof space === 'number' ? space : typeof space === 'string' ? space.length : 0;
    return indent ? block(value, 0, indent) : flow(value);
  },
};

/** YAML 1.1's other readings of a word: a string spelled like one is quoted */
const SPECIAL = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/;
const NUMERIC = /^[-+]?(?:\.\d+|\d+\.?\d*(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|\.inf|\.nan)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isNaN(v) ? '.nan' : v === Infinity ? '.inf' : v === -Infinity ? '-.inf' : Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'bigint') return String(v);
  const str = String(v);
  const quote = str === '' || SPECIAL.test(str) || NUMERIC.test(str) || /^\s|\s$/.test(str) || /[#'"\x00-\x1f\x7f]|: |[[\]{},]/.test(str)
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(str);
  return quote ? JSON.stringify(str) : str;
}

const isCollection = (v: unknown): v is object => typeof v === 'object' && v !== null;
const entries = (v: object): [string, unknown][] => Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function');

function flow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => flow(x)).join(',')}]`;
  if (isCollection(v)) return `{${entries(v).map(([k, x]) => `${scalar(k)}: ${flow(x)}`).join(',')}}`;
  return scalar(v);
}

/** Block style at `at` columns: a nested collection after "key: " on its own lines, an empty one as {} or [] */
function block(v: unknown, at: number, step: number): string {
  const pad = ' '.repeat(at);
  if (!isCollection(v)) return pad + scalar(v);
  const isArr = Array.isArray(v);
  const items: [string | null, unknown][] = isArr ? (v as unknown[]).map((x) => [null, x]) : entries(v);
  if (!items.length) return pad + (isArr ? '[]' : '{}');
  return items.map(([k, x]) => {
    if (k !== null) {
      if (!isCollection(x)) return `${pad}${scalar(k)}: ${scalar(x)}`;
      return `${pad}${scalar(k)}: \n${block(x, at + step, step)}`;
    }
    if (!isCollection(x)) return `${pad}- ${scalar(x)}`;
    // a collection in a sequence starts on the dash's line
    const inner = block(x, at + step, step);
    return pad + '- ' + inner.slice(at + step);
  }).join('\n');
}

export const TOML = {
  parse(input: unknown): unknown {
    const text = typeof input === 'string' ? input : new TextDecoder().decode(input as Uint8Array);
    let v: unknown;
    try { v = tomlParse(text); } catch (e: any) { throw new SyntaxError(e?.message ?? String(e)); }
    return datesAsText(v);
  },
};

/** TOML dates and times as Bun gives them: objects that print as the TOML text (not Dates) */
function datesAsText(v: unknown): unknown {
  if (v instanceof Date) {
    const t = typeof (v as any).toISOString === 'function' ? (v as any).toISOString() : String(v);
    return new String(String(t).replace(/\.000(?=Z|[+-]\d|$)/, ''));
  }
  if (Array.isArray(v)) return v.map(datesAsText);
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) (v as any)[k] = datesAsText((v as any)[k]); }
  return v;
}
