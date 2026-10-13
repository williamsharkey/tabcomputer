// The /link page's side of src/link-fragment.ts (docs/RUN_LINKS.md "After the #"):
// what a person typed in the box, as the part of an address after `#`. The app
// reads that part with src/link-fragment.ts; link-fragment.test.ts checks that
// what this file writes is what that module writes and reads.
//
// No DOM here: index.html does the page.

export const READABLE_MAX = 2000;
export const FRAGMENT_MAX = 48000;

const TOP_KEYS = new Set([
  'name', 'about', 'description', 'id', 'version', 'run', 'out', 'stdin', 'output', 'table',
  'shell', 'each', 'live', 'accept', 'needs', 'toolchains', 'columns', 'fields', 'options', 'manifest',
]);
const GROUP = /^(fields?|options?|window)\./;

/** Is `key` one a link's app may give? */
export function isAppKey(key) {
  return TOP_KEYS.has(key) || GROUP.test(key);
}

/** Letters, digits and -._~!$'()*+,;=:@/? stay; everything else is percent-encoded. `keep` adds characters that stay. */
export function encodePart(s, keep = '') {
  let out = '';
  for (const ch of s) out += /[A-Za-z0-9\-._~!$'()*+,;=:@/?]/.test(ch) || keep.includes(ch) ? ch : encodeURIComponent(ch);
  return out;
}

/** A last character that programs take for the sentence's own punctuation, not the link's */
function endSafely(f) {
  const last = f.slice(-1);
  return /[.,;:!?')]/.test(last) ? f.slice(0, -1) + '%' + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') : f;
}

const tidy = (text) => text.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
const keyOf = (line) => { const m = /^\s*([A-Za-z][A-Za-z0-9_.]*)=/.exec(line); return m && isAppKey(m[1]) ? m[1] : ''; };

/**
 * The box's lines as an app's pairs: a line that starts with a key and `=` is
 * a pair, and a line that does not continues the value above it on a new line.
 */
export function pairsFromLines(text) {
  const pairs = [];
  for (const line of tidy(text).split('\n')) {
    const key = keyOf(line);
    if (key) pairs.push([key, line.slice(line.indexOf('=') + 1)]);
    else if (pairs.length) pairs[pairs.length - 1][1] += '\n' + line;
  }
  return pairs.map(([k, v]) => [k, v.replace(/\s+$/, '')]);
}

/** Pairs as the part of an address after `#` */
export function appFragment(pairs) {
  return endSafely(pairs.map(([k, v]) => `${encodePart(k).replace(/=/g, '%3D')}=${encodePart(v)}`).join('&'));
}

/**
 * What the box holds, by the address's own rule: an app when it starts with a
 * key of app.json and `=`, a gist for `gist:`, and commands otherwise.
 * Returns { kind: 'none' | 'app' | 'commands' | 'gist', fragment, key }.
 */
export function readBox(text) {
  const t = tidy(text);
  if (!t.trim()) return { kind: 'none', fragment: '', key: '' };
  if (/^gist:/i.test(t)) return { kind: 'gist', fragment: encodePart(t.trim()), key: '' };
  if (/^sh:/i.test(t)) return { kind: 'commands', fragment: endSafely('sh:' + encodePart(t.slice(3), '&')), key: '' };
  const key = keyOf(t.split('\n')[0]);
  if (key) return { kind: 'app', fragment: appFragment(pairsFromLines(t)), key };
  // (text that would read as something else gets sh: in front)
  const other = /^(gz:|app=|safe\b)/i.test(t) || t !== t.replace(/^\s+/, '');
  return { kind: 'commands', fragment: endSafely((other ? 'sh:' : '') + encodePart(t, '&')), key: '' };
}

/** Text gzipped, as base64url: the payload of `#gz:` */
export async function pack(text) {
  const stream = new Blob([text.endsWith('\n') ? text : text + '\n']).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The examples the page offers: a name, and what goes in the box */
export const EXAMPLES = [
  {
    name: 'A Python one-liner',
    text: 'python3 -c "print(sum(range(101)))"',
  },
  {
    name: 'A Flask hello',
    text: [
      'pip install flask',
      'cat > app.py <<\'EOF\'',
      'from flask import Flask',
      'app = Flask(__name__)',
      '',
      '@app.route("/")',
      'def hello():',
      '    return "Hello from a link"',
      '',
      'app.run(port=5000)',
      'EOF',
      'python3 app.py',
    ].join('\n'),
  },
  {
    name: 'The jq playground',
    text: [
      'name=jq playground',
      'about=Try a jq filter on some JSON. The result changes as you type.',
      'field.filter=Filter',
      'field.filter.value=.people[] | select(.age > 30) | .name',
      'field.json=JSON',
      'field.json.type=long text',
      'field.json.value={"people": [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 21}, {"name": "Grace", "age": 45}]}',
      'run=jq {filter}',
      'stdin={json}',
      'live=true',
    ].join('\n'),
  },
  {
    name: 'An expenses table',
    text: [
      'name=Expenses',
      'about=A list of what was spent, with a total.',
      'table=expenses.csv',
      'columns=Date:date,What,Category:Food|Travel|Home|Other,Amount:number,Paid back:checkbox',
    ].join('\n'),
  },
  {
    name: 'A C hello',
    text: [
      'name=C hello',
      'about=Write a C program. Run compiles it with gcc and shows what it prints.',
      'needs=c',
      'field.code=Program',
      'field.code.type=long text',
      'field.code.value=#include <stdio.h>',
      '',
      'int main(void) {',
      '    puts("hello from a link");',
      '    return 0;',
      '}',
      'run=cat > hello.c && gcc -o hello hello.c && ./hello',
      'stdin={code}',
      'shell=true',
    ].join('\n'),
  },
];
