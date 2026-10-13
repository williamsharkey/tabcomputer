/**
 * Apps that are their manifest (src/apps/declare.ts, docs/APPS.md "The
 * manifest alone"): the three kinds' keys and defaults, that every mistake
 * names its key, how `run` becomes a program's arguments (a value is one
 * argument whatever it holds), how results are named, what the app may do,
 * the sentences a person reads before installing, and the command run end to
 * end through the tab's side of tab.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { appCmd } from '@shiro/commands/app';
import { validateManifest, parseManifest, manifestSentences, describeManifest, ManifestError, MANIFEST_VERSION, type AppManifest } from '@shiro/apps/manifest';
import { argvFor, inputValue, outputName, placeholders, rulesOf, shellLineFor, splitRun, type RunRules } from '@shiro/apps/declare';
import { configureApps, instanceFor, resetApps, setTabJsSource, suppliedPage, PAGE_JS_PATH, type AppInstance } from '@shiro/apps/runtime';
import { loadManifest } from '@shiro/apps/registry';

const ROOT = resolve(__dirname, '../../..');
const HOME = '/home/user';
const example = (name: string) => readFileSync(join(ROOT, 'apps/examples', name, 'app.json'));
const problems = (raw: unknown): string[] => {
  try { validateManifest(raw); } catch (e) { if (e instanceof ManifestError) return e.problems; throw e; }
  return [];
};
const FILES = { name: 'Tidy', run: 'jq . {in}' };
const FORM = { name: 'Count', fields: { first: { type: 'number', value: 1 }, last: 'To' }, run: 'seq {first} {last}' };
const TABLE = { name: 'People', table: 'people.csv', columns: ['Name'] };
const RULES: RunRules = { drop: new Set(['quality', 'verbose']), names: new Set(['name', 'ext']) };

describe('an app that is its manifest: the three kinds', () => {
  it('files: the issue\'s example, with every default filled in', () => {
    const m = parseManifest(example('searchable-pdf'), { id: 'searchable-pdf' });
    expect(m).toMatchObject({
      manifest: MANIFEST_VERSION, id: 'searchable-pdf', name: 'Make a scanned PDF searchable', kind: 'files', icon: '', entry: '', backend: null,
      description: 'Adds a text layer to scanned pages, so the text can be searched and copied.',
      accept: ['.pdf', '.png', '.jpg'], run: 'ocrmypdf {in} {out}', out: '{name}.pdf', needs: ['ocrmypdf'], each: true, shell: false, options: [],
      window: { width: 560, height: 580, resizable: true },
      // what it may do is read from `run`: its program, its own data folder, no other site
      access: { fs: [], network: false, commands: ['ocrmypdf'], shell: false },
    });
  });

  it('form: fields in the order written, their types and first values', () => {
    const m = parseManifest(example('jq-playground'), { id: 'jq-playground' });
    expect(m).toMatchObject({ kind: 'form', run: 'jq {filter}', stdin: '{json}', live: true, output: 'text', access: { commands: ['jq'], shell: false, network: false, fs: [] }, window: { width: 600, height: 620 } });
    expect(m.fields.map((f) => [f.name, f.label, f.type])).toEqual([['filter', 'Filter', 'text'], ['json', 'JSON', 'long text']]);
    expect(JSON.parse(m.fields[1].value).people).toHaveLength(3);
    const f = validateManifest({ ...FORM, fields: { a: 'Plain label', n: { type: 'number', value: 2.5 }, c: { choices: { Small: '-s', Large: '-l' }, value: 'Large' }, list: { choices: ['x', 'y'] }, v: { label: 'Loud', on: '--verbose', value: true }, f: { type: 'file', accept: ['.CSV'] }, t: { type: 'long text' } }, run: 'echo {a} {n} {c} {list} {v} {f} {t}' }).fields;
    expect(f.map((x) => x.type)).toEqual(['text', 'number', 'choice', 'choice', 'checkbox', 'file', 'long text']);
    expect(f[0]).toMatchObject({ label: 'Plain label', value: '' });
    expect(f[1]).toMatchObject({ label: 'N', value: '2.5' });
    expect(f[2]).toMatchObject({ value: 'Large', choices: [{ label: 'Small', value: '-s' }, { label: 'Large', value: '-l' }] });
    expect(f[3]).toMatchObject({ value: 'x', choices: [{ label: 'x', value: 'x' }, { label: 'y', value: 'y' }] });
    expect(f[4]).toMatchObject({ on: '--verbose', value: 'yes' });
    expect(f[5].accept).toEqual(['.csv']);
  });

  it('table: columns by name, with a type and choices; SQLite brings its one program', () => {
    const m = parseManifest(example('expenses'), { id: 'expenses' });
    expect(m).toMatchObject({ kind: 'table', table: 'expenses.csv', window: { width: 780, height: 540 }, access: { fs: [], network: false, commands: [], shell: false } });
    expect(m.columns).toEqual([
      { name: 'Date', type: 'date', choices: [] }, { name: 'What', type: 'text', choices: [] },
      { name: 'Category', type: 'choice', choices: ['Food', 'Travel', 'Home', 'Other'] }, { name: 'Amount', type: 'number', choices: [] }, { name: 'Paid back', type: 'checkbox', choices: [] },
    ]);
    expect(validateManifest({ ...TABLE, table: 'people.sqlite' }).access.commands).toEqual(['sqlite3']);
  });

  it('name is the only key every app needs: the id comes from the folder, else from the name', () => {
    expect(validateManifest(FILES)).toMatchObject({ id: 'tidy', manifest: MANIFEST_VERSION, out: '', accept: [] });
    expect(validateManifest(FILES, { id: 'my-folder' }).id).toBe('my-folder');
    // a folder whose name makes no id (a scratch folder, a gist's hex): the name
    expect(validateManifest({ ...FILES, name: 'Make a scanned PDF searchable' }, { id: '0123' }).id).toBe('make-a-scanned-pdf-searchable');
    expect(validateManifest({ ...FILES, id: 'given' }, { id: 'my-folder' }).id).toBe('given');
    expect(validateManifest({ ...FILES, about: 'What it does.' }).description).toBe('What it does.');
    expect(validateManifest({ ...FILES, window: { width: 400 } }).window).toMatchObject({ width: 400, height: 580 });
  });

  it('a folder with a page works as before, and may leave out entry when the page is beside app.json', () => {
    expect(validateManifest({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public' })).toMatchObject({ kind: 'page', entry: 'public', run: '', fields: [], columns: [] });
    expect(validateManifest({ name: 'Demo' }, { page: '.' })).toMatchObject({ kind: 'page', entry: '.', id: 'demo' });
    expect(problems({ name: 'Demo' })).toEqual([expect.stringMatching(/^entry is missing.*Or give run, fields or table/)]);
  });

  it('every mistake names its key', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...FILES, run: 'jq .' }, /^run must say where the file goes: \{in\}/],
      [{ ...FILES, run: 'jq {inn}' }, /^run: \{inn\} is not known \(known: \{in\}, \{out\}, \{name\}, \{ext\}, \{dir\}\)/],
      [{ ...FILES, run: '' }, /^run must be one line/],
      [{ name: 'X', accept: ['.pdf'] }, /^entry is missing/],
      [{ ...FILES, run: './jq {in}' }, /^run must start with a program's name, without a path \(got ".\/jq"\)/],
      [{ ...FILES, run: 'jq . {in} | sort' }, /^run: \| is something only a shell understands; add "shell": true/],
      [{ ...FILES, run: 'jq "." {in' }, /^run must say where the file goes|^run: /],
      [{ ...FILES, run: 'jq \'. {in}' }, /^run: a ' is never closed/],
      [{ ...FILES, accept: ['pdf'] }, /^accept\[0\] must be an extension such as "\.pdf" \(got "pdf"\)/],
      [{ ...FILES, accept: '.pdf' }, /^accept must be a list of extensions/],
      [{ ...FILES, out: 'a/b.pdf' }, /^out must be the result's name, without a folder/],
      [{ ...FILES, out: '{stem}.pdf' }, /^out: \{stem\} is not known here \(known: \{name\}, \{ext\}\)/],
      [{ ...FILES, each: 'no' }, /^each must be true or false \(got "no"\)/],
      [{ ...FILES, each: false }, /^out is missing: with "each": false there is one result/],
      [{ ...FILES, each: false, out: 'all.json', run: 'jq -s . x{in}' }, /^run: with "each": false \{in\} is every file, so it must be a word of its own/],
      [{ ...FILES, each: false, out: 'all.json', run: 'jq {name} {in}' }, /^run: \{name\} is not known .*there is no one input to name/],
      [{ ...FILES, shell: 1 }, /^shell must be true or false/],
      [{ ...FILES, shell: true, run: 'jq . "{in}" | sort' }, /^run: \{in\} is inside quotes; with "shell": true tabcomputer quotes each value itself/],
      [{ ...FILES, options: [] }, /^options must be an object/],
      [{ ...FILES, options: { Quality: { choices: ['a'] } } }, /^options\.Quality: a name is a-z, 0-9 and _/],
      [{ ...FILES, options: { name: { choices: ['a'] } } }, /^options\.name: \{name\} already means something/],
      [{ ...FILES, options: { q: { type: 'text' } } }, /^options\.q\.type must be one of choice, checkbox \(got "text"\)/],
      [{ ...FILES, options: { q: { choices: [] } } }, /^options\.q\.choices must be a list of 1 to 40 choices/],
      [{ ...FILES, options: { q: { choices: ['a'], value: 'b' } } }, /^options\.q\.value must be one of its choices \(got "b"\)/],
      [{ ...FILES, options: { q: { type: 'checkbox' } } }, /^options\.q\.on is missing: what \{q\} becomes when the box is ticked/],
      [{ ...FILES, options: { q: { on: '-q', colour: 'red' } } }, /^unknown key options\.q\.colour \(known: label, type, value, choices, on, accept\)/],
      [{ ...FILES, entry: 'public' }, /^entry does not go with run: tabcomputer supplies the page/],
      [{ ...FILES, access: { network: true } }, /^access does not go with run/],
      [{ ...FILES, backend: { start: 'node s.js' } }, /^backend does not go with run/],
      [{ ...FILES, needs: ['Not A Package'] }, /^needs\[0\] must be the name of a Debian package \(got "Not A Package"\)/],
      [{ ...FILES, needs: 'jq' }, /^needs must be a list/],
      [{ ...FILES, about: 'a', description: 'b' }, /^about and description are the same thing: give one/],
      [{ ...FILES, fieldz: {} }, /^unknown key fieldz \(known: manifest, id, name, about, .*accept, run, out, options, each, shell\)/],
      [{ ...FORM, run: 'seq {first} {end}' }, /^run: \{end\} is not known \(known: \{first\}, \{last\}\)/],
      [{ ...FORM, fields: { first: { type: 'slider' } } }, /^fields\.first\.type must be one of text, long text, number, choice, checkbox, file \(got "slider"\)/],
      [{ ...FORM, fields: { first: { type: 'number', value: 'one' } }, run: 'seq {first}' }, /^fields\.first\.value must be a number \(got "one"\)/],
      [{ ...FORM, output: 'pdf' }, /^output must be one of text, html, markdown, file \(got "pdf"\)/],
      [{ ...FORM, output: 'file' }, /^out is missing: the name of the file the command makes/],
      [{ ...FORM, out: 'x.txt' }, /^out goes with "output": "file"/],
      [{ ...FORM, live: 'yes' }, /^live must be true or false/],
      [{ ...FORM, stdin: '{nope}' }, /^stdin: \{nope\} is not known/],
      [{ ...FORM, accept: ['.txt'] }, /^unknown key accept \(known: .*fields, run, stdin, output, out, live, shell\)/],
      [{ ...TABLE, table: '../people.csv' }, /^table must be the name of a \.csv or \.sqlite file/],
      [{ ...TABLE, table: 'people.xlsx' }, /^table must be the name of a \.csv or \.sqlite file/],
      [{ ...TABLE, columns: [] }, /^columns must be a list of 1 to 40 columns/],
      [{ name: 'T', table: 'a.csv' }, /^columns must be a list/],
      [{ name: 'T', columns: ['A'] }, /^table must be the name/],
      [{ ...TABLE, columns: ['A', 'a'] }, /^columns\[1\]\.name "a" is the name of an earlier column/],
      [{ ...TABLE, columns: [{ name: 'A', type: 'money' }] }, /^columns\[0\]\.type must be one of text, number, date, choice, checkbox \(got "money"\)/],
      [{ ...TABLE, columns: [{ name: 'A', type: 'choice' }] }, /^columns\[0\]\.choices must be a list of 1 to 60 choices/],
      [{ ...TABLE, columns: [{ name: 'A', width: 3 }] }, /^unknown key columns\[0\]\.width \(known: name, type, choices\)/],
      [{ ...TABLE, run: 'cat {in}' }, /^unknown key run \(known: .*table, columns\)/],
    ];
    for (const [raw, want] of cases) {
      const got = problems(raw);
      expect(got.some((p) => want.test(p)), `${JSON.stringify(raw)} → ${JSON.stringify(got)}`).toBe(true);
    }
    // all at once, each by its key
    const all = problems({ name: 'X', run: 'jq {in}', each: 1, accept: 3, out: 7 });
    for (const key of ['each', 'accept', 'out']) expect(all.some((p) => p.startsWith(`${key} must be`)), `${key}: ${all}`).toBe(true);
  });
});

describe('run becomes a program and its arguments, and nothing reads them again', () => {
  it('splits run into words once; quotes keep a blank in one word; nothing else is special', () => {
    expect(splitRun('ocrmypdf {in} {out}')).toEqual(['ocrmypdf', '{in}', '{out}']);
    expect(splitRun('  jq   \'.a | .b\'  "x y"  {in} ')).toEqual(['jq', '.a | .b', 'x y', '{in}']);
    expect(splitRun('gs -sOutputFile={out} -dPDFSETTINGS={quality} ""')).toEqual(['gs', '-sOutputFile={out}', '-dPDFSETTINGS={quality}', '']);
    expect(splitRun('echo $(id) ; `id` * ~ > x')).toEqual(['echo', '$(id)', ';', '`id`', '*', '~', '>', 'x']);
    expect(() => splitRun('echo "open')).toThrow(/a " is never closed/);
    expect(placeholders('a {in} b{out}c {in} {Not} {9x}')).toEqual(['in', 'out']);
  });

  it('a value is one argument whatever it holds: spaces, quotes, ; and $(…) are data', () => {
    const words = splitRun('convert {in} -title {name} {out}');
    for (const nasty of ['my file.pdf', 'a"b\'c.pdf', 'x; rm -rf ~ ;.pdf', '$(touch /tmp/pwned).pdf', '`id`.pdf', 'a\nb.pdf', '* ? [a].pdf', '> /etc/passwd', '{out}', '']) {
      const argv = argvFor(words, { in: `/data/in/${nasty}`, name: nasty, out: '/data/out/r.pdf' }, RULES);
      expect(argv, nasty).toHaveLength(5);
      expect(argv[1], nasty).toBe(`/data/in/${nasty}`);
      // (only a name that would read as an option is changed: below)
      expect(argv[3], nasty).toBe(nasty);
    }
    // inside a word: substituted within that one word
    expect(argvFor(splitRun('tool --out={dir}/{name}.{ext} {in}'), { dir: '/o', name: 'a b', ext: 'p df', in: '/i/a b.p df' }, RULES)).toEqual(['tool', '--out=/o/a b.p df', '/i/a b.p df']);
    // a placeholder's value is not expanded again
    expect(argvFor(['echo', '{name}'], { name: '{in}', in: '/secret' }, RULES)).toEqual(['echo', '{in}']);
    expect(() => argvFor(['echo', '{missing}'], {}, RULES)).toThrow(/\{missing\} has no value/);
  });

  it('a file named -rf is passed as ./-rf: a name never becomes an option', () => {
    // {in} and {out} are absolute paths, so they never start with a dash; {name} and {ext} come from the file's name
    expect(argvFor(splitRun('rm {name}'), { name: '-rf' }, RULES)).toEqual(['rm', './-rf']);
    expect(argvFor(splitRun('tool {name}.{ext}'), { name: '--exec=sh', ext: 'pdf' }, RULES)).toEqual(['tool', './--exec=sh.pdf']);
    expect(argvFor(splitRun('tool --title={name} {name}'), { name: '-x' }, RULES)).toEqual(['tool', '--title=-x', './-x']);
    expect(argvFor(splitRun('tool {name}'), { name: 'plain' }, RULES)).toEqual(['tool', 'plain']);
    // an option the author wrote is the author's
    expect(argvFor(splitRun('tool {quality} {in}'), { quality: '-dFAST', in: '/i/a' }, RULES)).toEqual(['tool', '-dFAST', '/i/a']);
  });

  it('an unticked box or an empty choice leaves its word out; empty text is still an argument', () => {
    const words = splitRun('tool {verbose} {quality} {text} {in}');
    expect(argvFor(words, { verbose: '', quality: '', text: '', in: '/i/a' }, RULES)).toEqual(['tool', '', '/i/a']);
    expect(argvFor(words, { verbose: '--verbose', quality: '/ebook', text: 'x', in: '/i/a' }, RULES)).toEqual(['tool', '--verbose', '/ebook', 'x', '/i/a']);
    expect(argvFor(splitRun('tool -q={quality}'), { quality: '' }, RULES)).toEqual(['tool', '-q=']);
  });

  it('"each": false: {in} is every input, one argument each', () => {
    expect(argvFor(splitRun('pdfunite {in} {out}'), { in: ['/i/a b.pdf', '/i/-c.pdf', '/i/$(x).pdf'], out: '/o/all.pdf' }, RULES)).toEqual(['pdfunite', '/i/a b.pdf', '/i/-c.pdf', '/i/$(x).pdf', '/o/all.pdf']);
  });

  it('"shell": true: the line is a shell\'s, and each value goes in as one quoted word', () => {
    const line = shellLineFor('pdftotext {in} - | wc -w > {out}; echo {name}', { in: "/i/it's $(id); x.pdf", out: '/o/n.txt', name: '-n' }, RULES);
    expect(line).toBe(`pdftotext '/i/it'\\''s $(id); x.pdf' - | wc -w > '/o/n.txt'; echo './-n'`);
    expect(shellLineFor('cat {in} {verbose}', { in: ['/a b', '/c'], verbose: '' }, RULES)).toBe(`cat '/a b' '/c' `);
  });

  it('what a field holds becomes its argument: a choice its value, a box its switch, a number only a number', () => {
    const m = validateManifest({ ...FORM, fields: { n: { type: 'number' }, c: { choices: { Small: '/ebook', Print: '/printer' } }, v: { on: '--verbose' }, t: 'Text' }, run: 'x {n} {c} {v} {t}' });
    const [n, c, v, t] = m.fields;
    expect(inputValue(n, '12.5')).toBe('12.5');
    expect(inputValue(n, '')).toBe('');
    expect(() => inputValue(n, '1; rm -rf')).toThrow(/N must be a number/);
    expect(inputValue(c, 'Print')).toBe('/printer');
    expect(() => inputValue(c, '/etc/passwd')).toThrow(/C has no choice named/);
    expect(inputValue(v, true)).toBe('--verbose');
    expect(inputValue(v, false)).toBe('');
    expect(inputValue(t, '--help; $(x)')).toBe('--help; $(x)');
    expect(() => inputValue(t, 'a\0b')).toThrow(/cannot be given/);
    expect(rulesOf(m).drop).toEqual(new Set(['c', 'v']));
  });
});

describe('results', () => {
  it('are named from out, keep a dropped folder\'s structure, and never share a name', () => {
    const taken = new Set<string>();
    expect(outputName('{name}.pdf', 'page.png', taken)).toEqual({ rel: 'page.pdf', name: 'page', ext: 'png', dir: '' });
    // the same name again (a second pick), and another input that would get it (#140)
    expect(outputName('{name}.pdf', 'page.png', taken).rel).toBe('page (2).pdf');
    expect(outputName('{name}.pdf', 'page.jpg', taken).rel).toBe('page (3).pdf');
    expect(outputName('{name}.pdf', 'PAGE.png', taken).rel).toBe('PAGE (4).pdf');
    expect(outputName('{name}.pdf', 'scans/2024/page.png', taken)).toEqual({ rel: 'scans/2024/page.pdf', name: 'page', ext: 'png', dir: 'scans/2024/' });
    expect(outputName('{name}.pdf', 'scans/2024/page.png', taken).rel).toBe('scans/2024/page (2).pdf');
    // without out: the input's own name
    expect(outputName('', 'notes.txt', taken).rel).toBe('notes.txt');
    expect(outputName('', 'README', taken)).toMatchObject({ rel: 'README', name: 'README', ext: '' });
    expect(outputName('', '.env', taken)).toMatchObject({ rel: '.env', name: '.env', ext: '' });
    expect(outputName('{name}.{ext}.txt', 'a.tar.gz', taken)).toMatchObject({ rel: 'a.tar.gz.txt', name: 'a.tar', ext: 'gz' });
    expect(outputName('merged.pdf', 'merged.pdf', taken).rel).toBe('merged.pdf');
    expect(outputName('merged.pdf', 'merged.pdf', taken).rel).toBe('merged (2).pdf');
  });
});

describe('what a person reads before installing', () => {
  it('says what it does, the exact command, what it installs', () => {
    const m = parseManifest(example('searchable-pdf'), { id: 'searchable-pdf' });
    expect(manifestSentences(m)).toEqual([
      'Adds a text layer to scanned pages, so the text can be searched and copied.',
      'Make a scanned PDF searchable runs this command once for each file you give it: ocrmypdf {in} {out}',
      'Each result is named {name}.pdf.',
      'ocrmypdf is an ordinary program in this tab: it can read and change every file here.',
      'Before its first start it installs the Debian package ocrmypdf.',
      'Its page may use only its own data folder, and is kept from other sites.',
    ]);
    expect(manifestSentences(parseManifest(example('jq-playground')))[1]).toBe('jq playground runs this command as you type: jq {filter}');
    expect(manifestSentences(parseManifest(example('expenses')))).toEqual([
      'A list of what was spent, with a total.',
      'Expenses keeps a table in expenses.csv, in its own data folder.',
      'It runs no program.',
      'Its page may use only its own data folder, and is kept from other sites.',
    ]);
    const shell = manifestSentences(validateManifest({ ...FILES, shell: true, run: 'jq . {in} | sort', each: false, out: 'all.txt', needs: ['jq', 'moreutils'], toolchains: ['python'] }));
    expect(shell).toContain('Tidy runs this shell line once, with all the files you give it: jq . {in} | sort');
    expect(shell).toContain('A shell line can do everything a terminal here can: it can read and change every file in this tab.');
    expect(shell).toContain('The result is named all.txt.');
    expect(shell).toContain('Before its first start it installs the toolchain python, and the Debian packages jq and moreutils.');
    expect(validateManifest({ ...FILES, shell: true }).access).toMatchObject({ shell: true, commands: [] });
    expect(manifestSentences(validateManifest({ ...TABLE, table: 'p.sqlite' }))).toContain('It runs the program sqlite3 on that file, and no other program.');
    // the same sentences where a list is wanted (app list -l); an app with its own page keeps its labelled lines
    expect(describeManifest(m).map((l) => l.text)).toEqual(manifestSentences(m).slice(1));
    expect(manifestSentences(validateManifest({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public' }))).toEqual([]);
    expect(describeManifest(validateManifest({ manifest: 1, id: 'demo', name: 'Demo', entry: 'public', needs: ['jq'] })).find((l) => l.label === 'Installs')!.text).toMatch(/^jq \(Debian packages/);
  });
});

describe('a declared app, run through the tab', () => {
  let fs: FileSystem;
  let shell: Shell;
  let toolchains: string[];
  let packages: string[];
  const app = async (line: string) => { const r = await run(shell, `app ${line}`); return { ...r, output: r.output.replace(/\r\n/g, '\n') }; };

  beforeEach(async () => {
    ({ fs, shell } = await createTestShell());
    shell.commands.register(appCmd);
    for (const p of ['/var/lib/tabcomputer/apps.json', `${HOME}/Apps`, `${HOME}/decl`, `${HOME}/.local/share/apps`, '/tmp/pwned']) await fs.rm(p, { recursive: true }).catch(() => {});
    toolchains = [];
    packages = [];
    configureApps({
      fs, shell, download: () => {},
      toolchains: {
        known: async (names) => names.filter((n) => n === 'python'),
        installed: async (sets) => Object.fromEntries(sets.map((s) => [s, toolchains.includes(s)])),
        install: async (set, onLine) => { onLine(`unpacking ${set}`); toolchains.push(set); return 0; },
      },
      packages: {
        installed: async (names) => Object.fromEntries(names.map((n) => [n, packages.includes(n)])),
        install: async (names, onLine) => { onLine(`Setting up ${names.join(' ')}`); if (names.includes('nosuchpkg')) return 100; packages.push(...names); return 0; },
      },
    });
    setTabJsSource('// tab.js', 'tab.js');
    setTabJsSource('// page.js', 'page.js');
    shell.cwd = HOME;
  });
  afterEach(() => { resetApps(); configureApps(null); setTabJsSource(null); setTabJsSource(null, 'page.js'); });

  async function open(id: string, manifest: Record<string, unknown>): Promise<AppInstance> {
    const dir = `${HOME}/decl/${id}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/app.json`, JSON.stringify(manifest));
    const inst = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dev:${dir}` });
    await inst.prepare();
    return inst;
  }
  const put = async (inst: AppInstance, pick: number, rel: string, data: string) =>
    ((await inst.host.call('files.put', { dir: `${inst.dataDir}/in/s/${pick}`, rel, data }, () => {}, () => {})) as { value: { path: string; rel: string } }).value;
  type Result = { code: number; out: string | null; name: string; size: number; said: string; err: string; stdout: string };
  const job = async (inst: AppInstance, a: Record<string, unknown>): Promise<Result> => {
    let err = '', stdout = '';
    const r = await inst.host.call('job', { session: 's', ...a }, (e, d) => { if (e === 'err') err += d; if (e === 'out') stdout += d; }, () => {}) as { value: Result };
    return { ...r.value, err, stdout };
  };

  it('files: three files, two with one name and one the program refuses', async () => {
    const inst = await open('tidy', { name: 'Tidy', accept: ['.json'], run: 'jq . {in}', out: '{name}.json' });
    expect(inst.id).toBe('tidy');
    const a = await put(inst, 1, 'data.json', '{"n":1}');
    const b = await put(inst, 2, 'data.json', '{"n":2}');
    const bad = await put(inst, 2, 'broken.json', '{"n": oops');
    const ra = await job(inst, { files: [a] });
    const rb = await job(inst, { files: [b] });
    const rbad = await job(inst, { files: [bad] });
    expect(ra).toMatchObject({ code: 0, name: 'data.json', out: `${inst.dataDir}/out/s/data.json` });
    expect(rb).toMatchObject({ code: 0, name: 'data (2).json', out: `${inst.dataDir}/out/s/data (2).json` });
    expect(JSON.parse((await fs.readFile(ra.out!, 'utf8')) as string)).toEqual({ n: 1 });
    expect(JSON.parse((await fs.readFile(rb.out!, 'utf8')) as string)).toEqual({ n: 2 });
    // the refused one: no result file, and the program's own words
    expect(rbad.code).not.toBe(0);
    expect(rbad.out).toBeNull();
    expect((rbad.err + rbad.said).trim()).not.toBe('');
    expect((await fs.readdir(`${inst.dataDir}/out/s`)).sort()).toEqual(['data (2).json', 'data.json']);
    // a dropped folder keeps its structure
    const deep = await put(inst, 3, 'reports/2024/q1.json', '[1]');
    expect(await job(inst, { files: [deep] })).toMatchObject({ code: 0, name: 'reports/2024/q1.json', out: `${inst.dataDir}/out/s/reports/2024/q1.json` });
    // a new page: what the last one left is gone
    await inst.host.call('job.start', { session: 't' }, () => {}, () => {});
    expect(await fs.exists(`${inst.dataDir}/out/s`)).toBe(false);
  });

  it('files: a file\'s name is never shell text or an option, here in a real run', async () => {
    const inst = await open('show', { name: 'Show', run: 'printf %s\\n {name} {in}', out: '{name}.txt' });
    for (const [i, rel] of ['-rf.txt', 'x; touch pwned;.txt', '$(touch pwned).txt', "it's \"q\".txt", '`touch pwned`.txt', 'a  b   c.txt', '* ?.txt'].entries()) {
      const f = await put(inst, i + 10, rel, 'x');
      const r = await job(inst, { files: [f] });
      expect(r.code, rel).toBe(0);
      const [name, path] = ((await fs.readFile(r.out!, 'utf8')) as string).split('\n');
      expect(f.rel, rel).toBe(rel);
      const stem = f.rel.replace(/\.txt$/, '');
      expect(name, rel).toBe(stem.startsWith('-') ? `./${stem}` : stem);
      expect(path, rel).toBe(f.path);
      expect(path.startsWith('/'), rel).toBe(true);
    }
    expect(await fs.exists(`${inst.dataDir}/pwned`)).toBe(false);
    // a path the app may not read is refused before anything runs
    await expect(job(inst, { files: [{ path: '/etc/passwd', rel: 'passwd' }] })).rejects.toMatchObject({ code: 'EACCES' });
    await expect(job(inst, { files: [] })).rejects.toMatchObject({ code: 'EINVAL' });
    // and the page's own tab.run is held to the program run names
    await expect(inst.host.call('run', { cmd: ['sh', '-c', 'id'] }, () => {}, () => {})).rejects.toMatchObject({ code: 'EACCES' });
    await expect(inst.host.call('run', { cmd: 'id' }, () => {}, () => {})).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('files: options fill their placeholders; "each": false runs once with every file; {out} names the result', async () => {
    const inst = await open('join', {
      name: 'Join', run: 'cat {number} {in}', out: 'joined.txt', each: false,
      options: { number: { label: 'Number the lines', on: '-n' } },
    });
    const a = await put(inst, 1, 'a b.txt', 'one\n');
    const b = await put(inst, 1, 'c.txt', 'two\n');
    const plain = await job(inst, { files: [a, b], values: { number: false } });
    expect(plain).toMatchObject({ code: 0, name: 'joined.txt' });
    expect(await fs.readFile(plain.out!, 'utf8')).toBe('one\ntwo\n');
    const numbered = await job(inst, { files: [a, b], values: { number: true } });
    expect(numbered.name).toBe('joined (2).txt');
    expect(((await fs.readFile(numbered.out!, 'utf8')) as string).replace(/\s+/g, ' ').trim()).toBe('1 one 2 two');
    const copy = await open('copy', { name: 'Copy', run: 'cp {in} {out}', out: '{name}.bak' });
    const f = await put(copy, 1, 'notes.md', '# hi\n');
    const r = await job(copy, { files: [f] });
    expect(r).toMatchObject({ code: 0, name: 'notes.bak', size: 5 });
    expect(await fs.readFile(r.out!, 'utf8')).toBe('# hi\n');
  });

  it('form: fields fill the command, stdin feeds it, the output streams back', async () => {
    const inst = await open('jq-playground', JSON.parse(new TextDecoder().decode(example('jq-playground'))));
    const m = inst.manifest;
    const r = await job(inst, { values: { filter: m.fields[0].value, json: m.fields[1].value } });
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['"Ada"', '"Grace"']);
    // what is typed is the filter, never an option or a second command
    const bad = await job(inst, { values: { filter: '.[', json: '{}' } });
    expect(bad.code).not.toBe(0);
    expect(bad.err.trim()).not.toBe('');
    const seq = await open('count', { name: 'Count', fields: { first: { type: 'number', value: 1 }, last: { type: 'number' } }, run: 'seq {first} {last}' });
    expect((await job(seq, { values: { first: '3', last: '5' } })).stdout).toBe('3\n4\n5\n');
    await expect(job(seq, { values: { first: '3; id', last: '5' } })).rejects.toMatchObject({ code: 'EINVAL', message: expect.stringMatching(/First must be a number/) });
    // "output": "file": the command's result is a file to download
    const file = await open('report', { name: 'Report', fields: { title: 'Title' }, run: 'printf %s {title}', output: 'file', out: 'report.txt' });
    const made = await job(file, { values: { title: 'Q1; $(id)' } });
    expect(made).toMatchObject({ code: 0, name: 'report.txt', out: `${file.dataDir}/out/s/report.txt` });
    expect(await fs.readFile(made.out!, 'utf8')).toBe('Q1; $(id)');
  });

  it('"shell": true runs a shell line, with each value still one word', async () => {
    const inst = await open('words', { name: 'Words', shell: true, run: 'cat {in} | tr a-z A-Z', out: '{name}.txt' });
    expect(inst.manifest.access).toMatchObject({ shell: true, commands: [] });
    const f = await put(inst, 1, 'x; touch pwned.txt', 'shout\n');
    const r = await job(inst, { files: [f] });
    expect(r.code).toBe(0);
    expect(await fs.readFile(r.out!, 'utf8')).toBe('SHOUT\n');
    expect(await fs.exists(`${inst.dataDir}/pwned.txt`)).toBe(false);
  });

  it('needs: packages are installed before the first start, once; a name that is a toolchain set goes that way', async () => {
    const inst = await open('scan', { name: 'Scan', run: 'ocrmypdf {in} {out}', needs: ['ocrmypdf', 'python'] });
    expect(packages).toEqual(['ocrmypdf']);
    expect(toolchains).toEqual(['python']);
    expect(inst.log.join('\n')).toMatch(/apt-get install ocrmypdf/);
    resetApps();
    packages.length = 0;
    await (await open('scan', { name: 'Scan', run: 'ocrmypdf {in} {out}', needs: ['ocrmypdf', 'python'] })).prepare();
    expect(packages).toEqual([]);
    // a package that cannot be installed stops the app and says which
    const dir = `${HOME}/decl/nope`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/app.json`, JSON.stringify({ name: 'Nope', run: 'x {in}', needs: ['nosuchpkg'] }));
    const bad = instanceFor({ manifest: await loadManifest(fs, dir), dir, source: `dev:${dir}` });
    const stages: string[] = [];
    await expect(bad.prepare((s) => stages.push(s))).rejects.toThrow(/nosuchpkg could not be installed \(exit 100\); Nope needs it/);
    expect(stages[0]).toBe('Nope needs some programs. They are being downloaded. This happens once.');
  });

  it('the page is tabcomputer\'s: one script for every such app, and nothing of the app\'s folder is served', async () => {
    const inst = await open('tidy', { name: 'Tidy & "x"', run: 'jq . {in}' });
    const page = await inst.fetch({ method: 'GET', path: '/' });
    expect(page.body).toBe(suppliedPage(inst.manifest));
    expect(String(page.body)).toContain('<title>Tidy &#38; &#34;x&#34;</title>');
    expect(String(page.body)).toContain(`<script src="${PAGE_JS_PATH}"></script>`);
    expect((await inst.fetch({ method: 'GET', path: PAGE_JS_PATH })).body).toBe('// page.js');
    expect((await inst.fetch({ method: 'GET', path: '/app.json' })).status).toBe(404);
    const hello = await inst.host.call('hello', {}, () => {}, () => {}) as { value: { manifest: AppManifest; theme: string } };
    expect(hello.value.manifest).toMatchObject({ kind: 'files', run: 'jq . {in}' });
    expect(['light', 'dark']).toContain(hello.value.theme);
  });

  it('app check prints a declared app as those sentences; app new makes each kind as one working file', async () => {
    shell.cwd = `${HOME}/decl`;
    await fs.mkdir(`${HOME}/decl`, { recursive: true });
    expect((await app('new my-files')).exitCode).toBe(0);
    const check = await app('check my-files');
    expect(check.exitCode).toBe(0);
    expect(check.output).toBe([
      'my-files: My files (app.json is valid)',
      '  Makes a tidy, indented copy of each JSON file.',
      '  My files runs this command once for each file you give it: jq . {in}',
      '  Each result is named {name}.json.',
      '  jq is an ordinary program in this tab: it can read and change every file here.',
      '  Its page may use only its own data folder, and is kept from other sites.',
      '',
    ].join('\n'));
    expect((await app('new my-form --template form')).exitCode).toBe(0);
    expect((await app('check my-form')).output).toContain('My form runs this command when you choose Run: seq {first} {step} {last}');
    expect((await app('new my-table --template table')).exitCode).toBe(0);
    expect((await app('check my-table')).output).toContain('My table keeps a table in people.csv, in its own data folder.');
    const installed = await app('install my-files');
    expect(installed.exitCode, installed.output).toBe(0);
    expect(installed.output).toMatch(/Installed My files \(my-files\) in ~\/Apps\/my-files: 1 files\./);
    // installed, the folder is named by the id, so the one file still needs no id
    expect(await loadManifest(fs, `${HOME}/Apps/my-files`)).toMatchObject({ id: 'my-files', kind: 'files' });
    const bad = `${HOME}/decl/bad`;
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(`${bad}/app.json`, JSON.stringify({ name: 'Bad', run: 'jq .', accept: ['json'] }));
    const r = await app('check bad');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('app.json: accept[0] must be an extension such as ".pdf" (got "json")');
    expect(r.output).toContain('app.json: run must say where the file goes: {in}');
  });
});
