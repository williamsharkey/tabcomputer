/**
 * Links written after the `#` of the address (src/link-fragment.ts,
 * docs/RUN_LINKS.md "After the #", tabcomputer#147): commands, a one-file
 * app as key=value pairs, a gist.
 *
 * The rules under test: the part after `#` is an app when it starts with a
 * key of app.json and `=`, else commands; whatever it is, it goes through the
 * prompt of the app links or the run links, and nothing runs or installs
 * without the person's yes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { createTestShell, run } from './helpers';
import {
  FRAGMENT_MAX, READABLE_MAX, FragmentError, appFragment, commandsFragment, decodeLoose, isAppKey, manifestFromPairs,
  packCommands, pairsFromManifest, parseFragment, scriptLink, splitPairs, unpackCommands,
} from '@shiro/link-fragment';
import {
  RunLinkError, SCRIPT_FILE, START_FILE, cleanRunUrl, encodeShLink, fetchOnce, gistFragmentQuery, handleRunLink, parseRunFragment, parseRunUrl,
  type RunLinkDeps, type RunPromptInfo,
} from '@shiro/run-url';
import { appLinkQuery, handleAppLink, keysApp, parseAppFragment, parseAppUrl, type AppLinkDeps, type FetchedApp, type InstallChoice } from '@shiro/apps/links';
import { validateManifest, manifestSentences } from '@shiro/apps/manifest';
import { readableAppUrl, shareApp, shareStatement } from '@shiro/apps/share';

const ORIGIN = 'https://tabcomputer.com';
const ROOT = path.resolve(__dirname, '../../..');
const example = (id: string) => readFileSync(path.join(ROOT, 'apps/examples', id, 'app.json'));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
/** The part after `#` as a browser hands it over for an address typed by hand (it encodes blanks, quotes, < > and `) */
const typed = (s: string) => '#' + s.replace(/[ "<>`]/g, (c) => encodeURIComponent(c));
const commands = (hash: string) => { const p = parseFragment(hash); return p?.kind === 'commands' ? p.text : `(${p?.kind})`; };

describe('the part after #: what it is', () => {
  it('commands are anything that does not start with an app key and =', () => {
    expect(parseFragment(typed('pip install flask && python3 app.py'))).toEqual({ kind: 'commands', text: 'pip install flask && python3 app.py\n' });
    // the awkward ones: an assignment before a command, an = inside an argument
    expect(commands(typed('FOO=1 make'))).toBe('FOO=1 make\n');
    expect(commands(typed('echo a=b'))).toBe('echo a=b\n');
    expect(commands(typed('git config user.name=x'))).toBe('git config user.name=x\n');
    expect(commands(typed('NAME=World; echo hi $NAME'))).toBe('NAME=World; echo hi $NAME\n');
    expect(commands(typed('ls -la'))).toBe('ls -la\n');
    expect(commands('#make')).toBe('make\n');
    // an app key that is not at the start does not make an app
    expect(commands(typed('echo x && run=1 ./go'))).toBe('echo x && run=1 ./go\n');
    expect(commands(typed('./configure --name=x&make'))).toBe('./configure --name=x&make\n');
  });

  it('an app starts with a key of app.json and =', () => {
    const app = parseFragment(typed('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr'));
    expect(app).toEqual({ kind: 'app', pairs: [['run', 'tesseract {in} stdout pdf'], ['accept', '.png,.jpg'], ['name', 'Make scans searchable'], ['needs', 'tesseract-ocr']] });
    expect(parseFragment('#name=Tidy&run=jq%20.%20%7Bin%7D')!.kind).toBe('app');
    expect(parseFragment('#table=people.csv&columns=Name,Age:number')!.kind).toBe('app');
    expect(parseFragment('#field.n=N&run=seq%20%7Bn%7D')!.kind).toBe('app');
    // a shell line that starts the same way is read as an app, and its error says how to run it instead
    const shell = parseFragment(typed('name=World; echo hi $name'))!;
    expect(shell.kind).toBe('app');
    expect(manifestFromPairs((shell as { pairs: [string, string][] }).pairs).problems.join('\n')).toMatch(/run is missing.*#sh:/);
    for (const k of ['run', 'name', 'about', 'table', 'columns', 'fields', 'field.x', 'fields.x.value', 'option.q', 'window.width', 'accept', 'needs', 'live']) expect(isAppKey(k), k).toBe(true);
    for (const k of ['FOO', 'Run', 'NAME', 'echo a', 'user.name', 'entry', 'backend', 'access', 'icon', 'files', '']) expect(isAppKey(k), k).toBe(false);
  });

  it('#sh: is commands whatever follows', () => {
    expect(commands(typed('sh:name=World; echo hi $name'))).toBe('name=World; echo hi $name\n');
    expect(commands(typed('sh:run=1 ./go'))).toBe('run=1 ./go\n');
    expect(commands('#SH:ls')).toBe('ls\n');
    expect(commands('#sh:gist:abc')).toBe('gist:abc\n');
    expect(() => parseFragment('#sh:')).toThrow(/no commands after #sh:/);
    expect(() => parseFragment('#sh:%20%0A')).toThrow(FragmentError);
  });

  it('%0A separates lines, and ; and && are the shell\'s own', () => {
    expect(commands('#mkdir%20site%0Acd%20site%0Aecho%20hi%20%3E%20index.html')).toBe('mkdir site\ncd site\necho hi > index.html\n');
    expect(commands(typed('mkdir site; cd site; ls'))).toBe('mkdir site; cd site; ls\n');
    expect(commands('#a%0D%0Ab')).toBe('a\nb\n');
    // blank lines around the commands go; the ones between stay
    expect(commands('#%0A%0Aa%0A%0Ab%0A%0A')).toBe('a\n\nb\n');
  });

  it('percent-decoding never fails, + is a plus, and other alphabets come through', () => {
    expect(decodeLoose('100%')).toBe('100%');
    expect(decodeLoose('%zz %2')).toBe('%zz %2');
    expect(decodeLoose('a%20b%2Bc+d')).toBe('a b+c+d');
    expect(decodeLoose('%E9')).toBe('%E9');
    expect(decodeLoose('%E9%20x')).toBe('%E9 x');
    expect(commands(typed('g++ -o hi hi.cc && ./hi'))).toBe('g++ -o hi hi.cc && ./hi\n');
    expect(commands(typed('echo 100% done'))).toBe('echo 100% done\n');
    // non-ASCII: as a browser encodes it, and as it is
    expect(commands('#echo%20%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF%20%F0%9F%8C%8D')).toBe('echo こんにちは 🌍\n');
    expect(commands('#echo naïve café')).toBe('echo naïve café\n');
    expect(parseFragment('#name=Caf%C3%A9&run=cat%20%7Bin%7D')).toEqual({ kind: 'app', pairs: [['name', 'Café'], ['run', 'cat {in}']] });
  });

  it('a # inside a command stays in it', () => {
    // (a browser splits an address at its first # only)
    const u = new URL('https://tabcomputer.com/#echo one # two && echo "#three"');
    expect(commands(u.hash)).toBe('echo one # two && echo "#three"\n');
    expect(commands('#echo%20%23%20x')).toBe('echo # x\n');
  });

  it('a gist, a gzipped script, an app\'s files', () => {
    const id = 'ab12'.repeat(8);
    expect(parseFragment(`#gist:${id}`)).toEqual({ kind: 'gist', user: '', id, file: '' });
    expect(parseFragment(`#gist:someone/${id}`)).toEqual({ kind: 'gist', user: 'someone', id, file: '' });
    expect(parseFragment(`#gist:someone/${id}/setup.sh`)).toEqual({ kind: 'gist', user: 'someone', id, file: 'setup.sh' });
    expect(parseFragment(`#GIST:${id}`)!.kind).toBe('gist');
    for (const bad of ['#gist:', '#gist:xyz', `#gist:a/b/${id}/d`, `#gist:-bad-/${id}`, `#gist:someone/${id}/..`, `#gist:${id}?x=1`]) expect(() => parseFragment(bad), bad).toThrow(/a gist link is #gist:ID or #gist:USER\/ID/);
    expect(parseFragment('#gz:H4sIAAAA_-x')).toEqual({ kind: 'packed-commands', payload: 'H4sIAAAA_-x' });
    expect(() => parseFragment('#gz:not base64!')).toThrow(/cut short/);
    expect(parseFragment('#app=H4sIAAAA')).toEqual({ kind: 'packed-app', payload: 'H4sIAAAA' });
  });

  it('nothing, safe mode, and a link that is too long', () => {
    for (const none of ['', '#', '#%20', '#   ', '#safe', '#safe=1']) expect(parseFragment(none), none).toBeNull();
    expect(commands('#safely remove it')).toBe('safely remove it\n');
    expect(() => parseFragment('#echo ' + 'x'.repeat(FRAGMENT_MAX))).toThrow(/longer than 48,000 characters.*gist/);
    expect(parseFragment('#echo ' + 'x'.repeat(FRAGMENT_MAX - 5))!.kind).toBe('commands');
  });
});

describe('a one-file app from the keys of a link', () => {
  const app = (f: string) => manifestFromPairs(splitPairs(f));
  const valid = (f: string) => { const r = app(f); expect(r.problems, f).toEqual([]); return validateManifest(r.raw); };

  it('each kind, with the short forms for what is nested', () => {
    const files = valid('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr&out={name}.pdf');
    expect(files).toMatchObject({ kind: 'files', id: 'make-scans-searchable', run: 'tesseract {in} stdout pdf', accept: ['.png', '.jpg'], needs: ['tesseract-ocr'], out: '{name}.pdf' });

    const form = valid('name=jq playground&field.filter=Filter&field.filter.value=.a | .b&field.json=JSON&field.json.type=long text&field.json.value={"a": {"b": 1}}&run=jq {filter}&stdin={json}&live');
    expect(form).toMatchObject({ kind: 'form', live: true, stdin: '{json}' });
    expect(form.fields.map((f) => [f.name, f.label, f.type, f.value])).toEqual([['filter', 'Filter', 'text', '.a | .b'], ['json', 'JSON', 'long text', '{"a": {"b": 1}}']]);

    const table = valid('name=Expenses&table=expenses.csv&columns=Date:date,What,Category:Food|Travel|Home|Other,Amount:number,Paid back:checkbox');
    expect(table.columns).toEqual([
      { name: 'Date', type: 'date', choices: [] }, { name: 'What', type: 'text', choices: [] },
      { name: 'Category', type: 'choice', choices: ['Food', 'Travel', 'Home', 'Other'] },
      { name: 'Amount', type: 'number', choices: [] }, { name: 'Paid back', type: 'checkbox', choices: [] },
    ]);
  });

  it('fields and options: types, values, choices and switches', () => {
    const m = valid('name=Shrink&run=gs -dPDFSETTINGS={quality} {gray} -o {out} {in}&accept=.pdf&option.quality=Quality&option.quality.choices=Small=/ebook|Print=/printer&option.gray=Gray&option.gray.on=-g&option.gray.value=true');
    expect(m.options).toEqual([
      { name: 'quality', label: 'Quality', type: 'choice', value: 'Small', choices: [{ label: 'Small', value: '/ebook' }, { label: 'Print', value: '/printer' }], on: '', accept: [] },
      { name: 'gray', label: 'Gray', type: 'checkbox', value: 'yes', choices: [], on: '-g', accept: [] },
    ]);
    const f = valid('name=Count&fields.from.type=number&fields.from.value=1&field.to=To&field.to.type=number&field.to.value=10&field.step.choices=1|2|5&field.doc.type=file&field.doc.accept=.txt,.md&run=seq {from} {step} {to}');
    expect(f.fields.map((x) => [x.name, x.type, x.value])).toEqual([['from', 'number', '1'], ['to', 'number', '10'], ['step', 'choice', '1'], ['doc', 'file', '']]);
    expect(f.fields[3].accept).toEqual(['.txt', '.md']);
    // a number field's value may be written before its type
    expect(valid('name=Nn&field.n.value=3&field.n.type=number&run=seq {n}').fields[0].value).toBe('3');
    // the window's size, and the switches' spellings
    expect(valid('name=Win&run=cat {in}&window.width=400&window.height=300&window.resizable=no').window).toMatchObject({ width: 400, height: 300, resizable: false });
    for (const [text, want] of [['shell=true', true], ['shell=yes', true], ['shell', true], ['shell=false', false], ['shell=no', false]] as const) expect(valid(`name=Sw&run=cat {in}&${text}`).shell, text).toBe(want);
  });

  it('app.json\'s own JSON, for what the short forms cannot say', () => {
    const m = valid('name=Tab&table=t.csv&columns=["A, B", {"name": "When: day", "type": "date"}]');
    expect(m.columns.map((c) => c.name)).toEqual(['A, B', 'When: day']);
    expect(valid('name=Form&run=echo {x}&fields={"x": {"label": "X", "choices": {"a|b": "1", "c=d": "2"}}}').fields[0].choices).toEqual([{ label: 'a|b', value: '1' }, { label: 'c=d', value: '2' }]);
    expect(app('name=T&table=t.csv&columns=[oops').problems).toEqual([expect.stringMatching(/^columns is not valid JSON/)]);
    expect(app('name=F&run=echo&fields=Filter').problems[0]).toMatch(/^fields is JSON here.*field\.NAME=Label/);
  });

  it('every problem names its key', async () => {
    expect(app('run=jq . {in}&acept=.json').problems).toEqual([expect.stringMatching(/^unknown key acept \(known: name, about, id, version, run, /)]);
    expect(app('run=a {in}&run=b {in}').problems).toEqual(['run is given twice']);
    expect(app('name=X').problems[0]).toMatch(/^run is missing: an app in a link has run, fields or table/);
    expect(app('run=cat {in}&field.x.colour=red').problems[0]).toMatch(/^unknown key field\.x\.colour \(known: field\.x, field\.x\.label, /);
    expect(app('run=cat {in}&field.=X').problems[0]).toMatch(/^field\. needs a name: field\.NAME=Label/);
    expect(app('run=cat {in}&window.colour=red').problems[0]).toMatch(/^unknown key window\.colour/);
    expect(app('run=cat {in}&field.a=A&field.a.label=B').problems[0]).toMatch(/field\.a has two labels/);
    expect(app('run=cat {in}&=x').problems[0]).toMatch(/^unknown key \(nothing before =\)/);
    // what a value must be is the manifest's to say, in app check's words
    const said = async (f: string) => { try { await keysApp(splitPairs(f)); } catch (e) { return (e as Error).message; } return ''; };
    expect(await said('name=Xy&run=cat')).toBe('the app in the link is not valid:\n  run must say where the file goes: {in}');
    expect(await said('run=cat {in}')).toMatch(/\n  name is missing \(got nothing\)/);
    expect(await said('name=Xy&run=cat {in}&accept=pdf')).toMatch(/\n  accept\[0\] must be an extension such as "\.pdf" \(got "pdf"\)/);
    expect(await said('name=Xy&run=cat {in}&live=maybe')).toMatch(/\n  unknown key live \(known: /);
    expect(await said('name=Xy&run=cat {in}&each=maybe')).toMatch(/\n  each must be true or false \(got "maybe"\)/);
    expect(await said('name=Xy&run=cat {in}&window.width=wide')).toMatch(/\n  window\.width must be a number from 120 to 10000 \(got "wide"\)/);
    expect(await said('name=Xy&table=t.csv&columns=A:money')).toMatch(/columns\[0\]/);
    expect(await said('name=Xy&run=cat {in} | wc')).toMatch(/\n  run: \| is something only a shell understands; add "shell": true/);
    expect(await said('name=Xy&fields.n=N&run=seq {m}')).toMatch(/\n  run: \{m\} is not known \(known: \{n\}\)/);
    expect(await said('name=Terminal&id=terminal&run=cat {in}')).toMatch(/id "terminal" is taken by tabcomputer itself/);
    // a control character in a value
    expect(await said('name=Xy&run=cat%1B {in}')).toMatch(/\n  run must be one line/);
    expect(await said('name=Xy%E2%80%AE&run=cat {in}')).toMatch(/\n  name must be 1 to 60 characters/);
    // several problems at once, each on its line
    expect((await said('name=Xy&run=cat&accept=pdf&bogus=1')).split('\n')).toHaveLength(2);
    expect((await said('name=Xy&run=cat&accept=pdf')).split('\n')).toHaveLength(3);
  });

  it('the link is its own app.json: what is shown is what is installed', async () => {
    const pairs = splitPairs('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr');
    const fetched = await keysApp(pairs);
    expect(fetched.curated).toBe(false);
    expect(fetched.from).toBe('the link itself, which holds the whole app');
    expect(fetched.source).toMatch(/^link:[0-9a-f]{16}$/);
    expect(JSON.parse(fetched.manifestText)).toEqual({ run: 'tesseract {in} stdout pdf', accept: ['.png', '.jpg'], name: 'Make scans searchable', needs: ['tesseract-ocr'] });
    const files = await fetched.files();
    expect([...files.keys()]).toEqual(['app.json']);
    expect(dec(files.get('app.json')!)).toBe(fetched.manifestText);
    // the sentences the prompt shows: the exact command, and what it installs
    const said = manifestSentences(fetched.manifest).join('\n');
    expect(said).toContain('Make scans searchable runs this command once for each file you give it: tesseract {in} stdout pdf');
    expect(said).toContain('Before its first start it installs the Debian package tesseract-ocr.');
    // the same link is the same app; another command is another
    expect((await keysApp(splitPairs('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr'))).source).toBe(fetched.source);
    expect((await keysApp(splitPairs('run=rm -rf {in}&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr'))).source).not.toBe(fetched.source);
  });

  it('the three examples as links a person can read, and their lengths', () => {
    const lengths: Record<string, number> = {};
    for (const id of ['searchable-pdf', 'jq-playground', 'expenses']) {
      const url = readableAppUrl(example(id), id, ORIGIN)!;
      expect(url, id).toBeTruthy();
      lengths[id] = url.length;
      expect(url.length).toBeLessThanOrEqual(READABLE_MAX);
      // only characters a mail or chat program keeps in a link
      expect(url.slice(ORIGIN.length + 2)).toMatch(/^[A-Za-z0-9\-._~!$'()*+,;=:@/?&%]+$/);
      const back = parseFragment(new URL(url).hash)!;
      expect(back.kind).toBe('app');
      const again = validateManifest(manifestFromPairs((back as { pairs: [string, string][] }).pairs).raw);
      expect(again).toEqual(validateManifest(JSON.parse(dec(example(id))), { id }));
    }
    console.log('[link] characters of each example\'s readable link:', JSON.stringify(lengths));
    expect(readableAppUrl(example('expenses'), 'expenses', ORIGIN)).toBe(
      `${ORIGIN}/#name=Expenses&about=A%20list%20of%20what%20was%20spent,%20with%20a%20total.&table=expenses.csv&columns=Date:date,What,Category:Food%7CTravel%7CHome%7COther,Amount:number,Paid%20back:checkbox`);
  });

  it('pairs from an app.json: the short forms where they fit, JSON where they do not, nothing for an app with a page', () => {
    expect(pairsFromManifest({ name: 'T', table: 't.csv', columns: ['A', { name: 'B', type: 'number' }, { name: 'C', choices: ['x', 'y'] }, { name: 'D', type: 'choice', choices: ['number'] }] }))
      .toEqual([['name', 'T'], ['table', 't.csv'], ['columns', 'A,B:number,C:x|y,D:choice:number']]);
    expect(pairsFromManifest({ name: 'T', table: 't.csv', columns: ['A, B'] })).toEqual([['name', 'T'], ['table', 't.csv'], ['columns', '["A, B"]']]);
    expect(pairsFromManifest({ name: 'F', fields: { a: 'A', b: { type: 'number', value: 3 }, c: { label: 'C', on: '-c', value: true } }, run: 'x {a} {b} {c}', shell: false }))
      .toEqual([['name', 'F'], ['field.a', 'A'], ['field.b.type', 'number'], ['field.b.value', '3'], ['field.c', 'C'], ['field.c.on', '-c'], ['field.c.value', 'true'], ['run', 'x {a} {b} {c}'], ['shell', 'false']]);
    expect(pairsFromManifest({ name: 'F', fields: { a: { choices: ['x|y'] } }, run: 'x {a}' })![1]).toEqual(['fields', '{"a":{"choices":["x|y"]}}']);
    for (const page of [{ name: 'P', entry: 'public' }, { name: 'P', run: 'cat {in}', icon: 'icon.svg' }, { name: 'P', backend: { start: 'node s.js' } }]) expect(pairsFromManifest(page), JSON.stringify(page)).toBeNull();
    // an app with a page of its own, or one too long to read, has no readable link
    expect(readableAppUrl(enc('{"name":"P","entry":"public"}'), 'p', ORIGIN)).toBeNull();
    const long = (n: number) => enc(JSON.stringify({ name: 'Long', fields: { text: { label: 'Text', type: 'long text', value: 'x'.repeat(n) } }, run: 'wc -w', stdin: '{text}' }));
    expect(readableAppUrl(long(1800), 'long', ORIGIN)!.length).toBeLessThanOrEqual(READABLE_MAX);
    expect(readableAppUrl(long(2000), 'long', ORIGIN)).toBeNull();
    expect(readableAppUrl(enc('not json'), 'x', ORIGIN)).toBeNull();
    // the id goes in the link only where the name would give another
    expect(readableAppUrl(enc('{"name": "Tidy", "run": "jq . {in}"}'), 'tidy', ORIGIN)).toBe(`${ORIGIN}/#name=Tidy&run=jq%20.%20%7Bin%7D`);
    expect(readableAppUrl(enc('{"manifest": 1, "name": "Something else", "run": "jq . {in}"}'), 'tidy-it', ORIGIN)).toBe(`${ORIGIN}/#name=Something%20else&run=jq%20.%20%7Bin%7D&id=tidy-it`);
  });
});

describe('writing a link', () => {
  it('commands read back as themselves, with sh: only where they would be read as something else', () => {
    const cases: [string, string][] = [
      ['pip install flask && python3 app.py', 'pip%20install%20flask%20&&%20python3%20app.py'],
      ['python3 -c "print(6*7)"', 'python3%20-c%20%22print(6*7)%22'],
      ['mkdir site\ncd site\necho hi > index.html', 'mkdir%20site%0Acd%20site%0Aecho%20hi%20%3E%20index.html'],
      ['name=World; echo hi $name', 'sh:name=World;%20echo%20hi%20$name'],
      ['run=1 ./go', 'sh:run=1%20./go'],
      ['gist:abc', 'sh:gist:abc'],
      ['safe', 'sh:safe'],
      ['echo done.', 'echo%20done%2E'],
      ['echo (a)', 'echo%20(a%29'],
      ['echo # x', 'echo%20%23%20x'],
      ['echo 100%', 'echo%20100%25'],
      ['echo こんにちは', 'echo%20%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF'],
    ];
    for (const [script, want] of cases) {
      const f = commandsFragment(script);
      expect(f, script).toBe(want);
      expect(parseFragment('#' + f), script).toEqual({ kind: 'commands', text: script + '\n' });
      // and through a real address
      expect(parseFragment(new URL(`${ORIGIN}/#${f}`).hash), script).toEqual({ kind: 'commands', text: script + '\n' });
    }
    // a here-document survives
    const here = 'cat > app.py <<\'EOF\'\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route("/")\ndef hi():\n    return "héllo & <b>bye</b>"\nEOF\npython3 app.py';
    expect(commands('#' + commandsFragment(here))).toBe(here + '\n');
  });

  it('pairs read back as themselves, whatever a value holds', () => {
    const pairs: [string, string][] = [['name', 'A & B = C?'], ['run', 'sh -c "echo {x} #1 100%"'], ['field.x', 'What & why'], ['field.x.value', 'a\nb'], ['about', 'Ends with a dot.']];
    const f = appFragment(pairs);
    expect(f).not.toMatch(/[ "#\n]/);
    expect(f.endsWith('%2E')).toBe(true);
    expect(parseFragment('#' + f)).toEqual({ kind: 'app', pairs });
  });

  it('the size tiers: a readable link, a compressed link, a gist', async () => {
    const short = await scriptLink('pip install flask\npython3 app.py', ORIGIN);
    expect(short).toMatchObject({ form: 'readable', url: `${ORIGIN}/#pip%20install%20flask%0Apython3%20app.py` });
    expect(short.readable).toBe(short.url.length);
    // text that compresses: too long to read, fine packed
    const medium = await scriptLink(Array.from({ length: 200 }, (_v, i) => `echo "step ${i}: the quick brown fox jumps over the lazy dog"`).join('\n'), ORIGIN);
    expect(medium.form).toBe('compressed');
    expect(medium.readable).toBeGreaterThan(READABLE_MAX);
    expect(medium.url).toMatch(/\/#gz:[A-Za-z0-9_-]+$/);
    expect(medium.compressed).toBe(medium.url.length);
    const back = await parseRunFragment(new URL(medium.url).hash);
    expect(dec((back!.target as { bytes: Uint8Array }).bytes)).toContain('step 199: the quick brown fox');
    // the edge of the readable form
    const at = (n: number) => scriptLink('echo ' + 'x'.repeat(n), ORIGIN);
    const room = READABLE_MAX - `${ORIGIN}/#echo%20`.length;
    expect((await at(room)).form).toBe('readable');
    expect((await at(room + 1)).form).toBe('compressed');
    // what does not compress, past 48,000 characters: only a gist holds it
    let noise = '';
    let seed = 7;
    while (noise.length < 60_000) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise += seed.toString(36); }
    const long = await scriptLink(`echo ${noise}`, ORIGIN);
    expect(long).toMatchObject({ form: 'gist', url: '' });
    expect(long.compressed).toBeGreaterThan(FRAGMENT_MAX);
  });

  it('a packed script: round trip, a cut link, and one that unpacks too large', async () => {
    const script = 'echo héllo\n';
    expect(dec(await unpackCommands(await packCommands(script), 1000))).toBe(script);
    const said = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return ''; };
    expect(await said(unpackCommands('AAAA', 1000))).toMatch(/cut short/);
    expect(await said(unpackCommands((await packCommands(script)).slice(0, 12), 1000))).toMatch(/cut short/);
    const bomb = gzipSync(Buffer.alloc(200_000, 0x20)).toString('base64url');
    expect(await said(unpackCommands(bomb, 64 << 10))).toMatch(/too long/);
    expect(await said(parseRunFragment(`#gz:${bomb}`))).toMatch(/too long/);
  });
});

function appHarness(hash: string, answer: InstallChoice, over: Partial<AppLinkDeps> = {}) {
  const log = { cleaned: 0, fetched: [] as string[], prompts: [] as FetchedApp[], installs: [] as { app: FetchedApp; files: Map<string, Uint8Array> }[], opens: [] as [string, boolean][], guests: [] as string[], reports: [] as string[] };
  const sources = new Map<string, string>();
  const deps: AppLinkDeps = {
    search: '', hash, origin: ORIGIN, framed: false,
    fetch: async (url) => { log.fetched.push(url); return new Response('no', { status: 404 }); },
    cleanUrl: () => { log.cleaned++; },
    installedSource: async (id) => sources.get(id) ?? null,
    confirm: async (app) => { log.prompts.push(app); return answer; },
    install: async (app, files) => { log.installs.push({ app, files }); sources.set(app.manifest.id, app.source); },
    open: async (id, become) => { log.opens.push([id, become]); },
    openInGuest: async (query) => { log.guests.push(query); return true; },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, log, sources };
}

describe('opening an app written after the #', () => {
  const LINK = typed('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr');

  it('asks first; Cancel installs nothing, and nothing is fetched', async () => {
    const h = appHarness(LINK, 'cancel');
    expect(await handleAppLink(h.deps)).toBe('cancelled');
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.prompts[0].manifest).toMatchObject({ id: 'make-scans-searchable', kind: 'files', run: 'tesseract {in} stdout pdf', needs: ['tesseract-ocr'] });
    expect(h.log.cleaned).toBe(1);
    expect(h.log.installs).toEqual([]);
    expect(h.log.opens).toEqual([]);
    expect(h.log.fetched).toEqual([]);
  });

  it('Install writes the app.json that was shown; the same link again opens it without asking; a changed link asks again', async () => {
    const h = appHarness(LINK, 'install');
    expect(await handleAppLink(h.deps)).toBe('installed');
    expect(h.log.installs).toHaveLength(1);
    expect(dec(h.log.installs[0].files.get('app.json')!)).toBe(h.log.prompts[0].manifestText);
    expect(h.log.opens).toEqual([['make-scans-searchable', false]]);
    // again: no prompt, no install
    expect(await handleAppLink(h.deps)).toBe('opened');
    expect(h.log.prompts).toHaveLength(1);
    expect(h.log.installs).toHaveLength(1);
    expect(h.log.opens).toHaveLength(2);
    // the same app under another command: the person is asked again
    const changed = appHarness(typed('run=rm -rf {in}&name=Make scans searchable'), 'cancel');
    changed.sources.set('make-scans-searchable', h.sources.get('make-scans-searchable')!);
    expect(await handleAppLink(changed.deps)).toBe('cancelled');
    expect(changed.log.prompts).toHaveLength(1);
    expect(changed.log.opens).toEqual([]);
  });

  it('a framed page takes none, a link that is not valid says which key, and "Open in a guest" carries the same link', async () => {
    const framed = appHarness(LINK, 'install', { framed: true });
    expect(await handleAppLink(framed.deps)).toBe('refused');
    expect(framed.log.cleaned).toBe(1);
    expect(framed.log.prompts).toEqual([]);
    expect(framed.log.reports[0]).toMatch(/ignored inside a frame/);
    const bad = appHarness(typed('run=cat {in}&name=X&acept=.txt'), 'install');
    expect(await handleAppLink(bad.deps)).toBe('refused');
    expect(bad.log.cleaned).toBe(1);
    expect(bad.log.reports[0]).toMatch(/^the app in the link is not valid:\n {2}unknown key acept/);
    expect(bad.log.installs).toEqual([]);
    const guest = appHarness(LINK, 'guest');
    expect(await handleAppLink(guest.deps)).toBe('guest');
    expect(guest.log.installs).toEqual([]);
    expect(parseFragment(guest.log.guests[0])).toEqual(parseFragment(LINK));
    expect(appLinkQuery({ kind: 'keys', pairs: [['name', 'A b'], ['run', 'cat {in}']] })).toBe('#name=A%20b&run=cat%20%7Bin%7D');
  });

  it('#app= alone is an app\'s files, and the query forms are as they were', () => {
    expect(parseAppFragment('#app=H4sIAAAA')).toEqual({ target: { kind: 'link', payload: 'H4sIAAAA' }, become: false });
    expect(parseAppFragment(typed('pip install flask'))).toBeNull();
    expect(parseAppFragment('#gist:' + 'ab12'.repeat(8))).toBeNull();
    expect(parseAppFragment('')).toBeNull();
    expect(parseAppUrl('', typed('name=X&run=cat {in}'))!.target.kind).toBe('keys');
    expect(parseAppUrl('?app=converter', typed('name=X&run=cat {in}'))!.target).toEqual({ kind: 'site', id: 'converter' });
    expect(() => parseAppUrl('?app=link', typed('name=X&run=cat {in}'))).toThrow(/incomplete/);
    expect(() => parseAppFragment('#name=X&run=' + 'x'.repeat(FRAGMENT_MAX))).toThrow(RunLinkError);
  });
});

function runHarness(over: Partial<RunLinkDeps>, answer = false) {
  const files = new Map<string, string>();
  const log = { cleaned: 0, fetched: [] as string[], prompts: [] as RunPromptInfo[], terminals: [] as Parameters<RunLinkDeps['openTerminal']>[0][], reports: [] as string[] };
  const deps: RunLinkDeps = {
    search: '', origin: ORIGIN, home: '/home/user', framed: false,
    fetch: async (url) => { log.fetched.push(url); return new Response('no', { status: 404 }); },
    fs: { mkdir: async () => {}, writeFile: async (p, d) => { files.set(p, d); }, exists: async (p) => files.has(p) },
    cleanUrl: () => { log.cleaned++; },
    confirm: async (info) => { log.prompts.push(info); return answer; },
    openTerminal: (o) => { log.terminals.push(o); },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, files, log };
}

describe('opening commands written after the #', () => {
  const HASH = typed('pip install flask && python3 app.py');

  it('shows them whole and asks; Cancel runs nothing and writes nothing', async () => {
    const h = runHarness({ hash: HASH });
    expect(await handleRunLink(h.deps)).toBe('cancelled');
    expect(h.log.cleaned).toBe(1);
    expect(h.log.prompts).toHaveLength(1);
    const p = h.log.prompts[0];
    expect(p.script).toBe('pip install flask && python3 app.py\n');
    expect(p.from).toBe('the link itself');
    expect(p.wording).toMatchObject({ title: 'Run these commands?', action: 'Run', where: 'They run in a new Terminal, in your home folder.' });
    expect(p.wording!.warn).toMatch(/can read and change the files here and use any account this tab is signed in to/);
    expect(h.files.size).toBe(0);
    expect(h.log.terminals).toEqual([]);
    expect(h.log.fetched).toEqual([]);
  });

  it('Run opens a Terminal in the home folder that sources them in its own shell', async () => {
    const h = runHarness({ hash: HASH }, true);
    expect(await handleRunLink(h.deps)).toBe('ran');
    expect(h.log.terminals).toHaveLength(1);
    const t = h.log.terminals[0];
    expect(t.cwd).toBe('/home/user');
    expect(t.env).toEqual({});
    expect(t.title).toBe('From a link');
    const name = /^\. ~\/run\/(sh-[0-9a-f]{12})\/\.run-link$/.exec(t.command)![1];
    // what runs is the text that was shown
    expect(h.files.get(`/home/user/run/${name}/${SCRIPT_FILE}`)).toBe(h.log.prompts[0].script);
    const start = h.files.get(`/home/user/run/${name}/${START_FILE}`)!;
    expect(start).toContain(`\n. ~/run/${name}/${SCRIPT_FILE}\n`);
    expect(start).not.toMatch(/\( \. /);
    expect(start).not.toMatch(/^cd /m);
    expect(start).toMatch(new RegExp(`touch ~/run/${name}/\\.done-[0-9a-f]{16}`));
  });

  it('a second visit asks nothing and runs nothing: the commands already ran here', async () => {
    const h = runHarness({ hash: HASH }, true);
    await handleRunLink(h.deps);
    const name = /run\/(sh-[0-9a-f]{12})\//.exec(h.log.terminals[0].command)![1];
    const marker = /touch (~\/run\/\S+)/.exec(h.files.get(`/home/user/run/${name}/${START_FILE}`)!)![1].replace('~', '/home/user');
    // (the Terminal ran the commands to their end)
    h.files.set(marker, '');
    const again = runHarness({ hash: HASH, fs: h.deps.fs }, false);
    expect(await handleRunLink(again.deps)).toBe('on-open');
    expect(again.log.prompts).toEqual([]);
    expect(again.log.terminals).toHaveLength(1);
    const start = h.files.get(`/home/user/run/${name}/${START_FILE}`)!;
    expect(start).toContain('already ran here');
    expect(start).not.toContain(`\n. ~/run/${name}/${SCRIPT_FILE}\n`);
    expect(start).not.toContain('touch');
    // commands that did not finish (no marker), and other commands, ask
    const unfinished = runHarness({ hash: typed('python3 -m http.server') }, false);
    await handleRunLink({ ...unfinished.deps, confirm: async () => true });
    expect(await handleRunLink(unfinished.deps)).toBe('cancelled');
    expect(unfinished.log.prompts).toHaveLength(1);
    const other = runHarness({ hash: typed('pip install flask && python3 other.py'), fs: h.deps.fs }, false);
    expect(await handleRunLink(other.deps)).toBe('cancelled');
    expect(other.log.prompts).toHaveLength(1);
    // with an on-open line something would run: that still asks
    const onOpen = runHarness({ hash: '#' + commandsFragment('# on-open: cd ~/site\nmkdir -p ~/site') }, true);
    await handleRunLink(onOpen.deps);
    const n2 = /run\/(sh-[0-9a-f]{12})\//.exec(onOpen.log.terminals[0].command)![1];
    onOpen.files.set(/touch (~\/run\/\S+)/.exec(onOpen.files.get(`/home/user/run/${n2}/${START_FILE}`)!)![1].replace('~', '/home/user'), '');
    const asked = runHarness({ hash: onOpen.deps.hash, fs: onOpen.deps.fs }, false);
    expect(await handleRunLink(asked.deps)).toBe('cancelled');
    expect(asked.log.prompts[0].wording!.where).toBe('They already ran here. Run only does their on-open line: cd ~/site');
  });

  it('a framed page takes none; text that hides what it does is refused; #gz: is the same commands', async () => {
    const framed = runHarness({ hash: HASH, framed: true }, true);
    expect(await handleRunLink(framed.deps)).toBe('refused');
    expect(framed.log.cleaned).toBe(1);
    expect(framed.log.prompts).toEqual([]);
    expect(framed.log.terminals).toEqual([]);
    for (const bad of ['#echo%20hi%1B%5B2Jbye', '#echo%20%E2%80%AEdrowssap', '#echo%20a%00b']) {
      const h = runHarness({ hash: bad }, true);
      expect(await handleRunLink(h.deps), bad).toBe('refused');
      expect(h.log.reports[0], bad).toMatch(/control or invisible characters/);
      expect(h.log.terminals).toEqual([]);
    }
    const packed = runHarness({ hash: `#gz:${await packCommands('pip install flask && python3 app.py\n')}` }, true);
    expect(await handleRunLink(packed.deps)).toBe('ran');
    expect(packed.log.prompts[0].script).toBe('pip install flask && python3 app.py\n');
    expect(packed.log.terminals[0].cwd).toBe('/home/user');
    const cut = runHarness({ hash: '#gz:H4sIAAAA' }, true);
    expect(await handleRunLink(cut.deps)).toBe('refused');
    expect(cut.log.reports[0]).toMatch(/cut short/);
    // an app, a gist or nothing after the # is not a run link
    for (const none of [typed('name=X&run=cat {in}'), '#gist:' + 'ab12'.repeat(8), '#app=H4sIAAAA', '#safe']) expect(await parseRunFragment(none), none).toBeNull();
  });

  it('?run=sh: is as it was: asked on every load, in ~/run/<name>, in a subshell', async () => {
    const search = `?run=${encodeShLink('echo hi\n')}`;
    expect(parseRunUrl(search)!.lines).toBeUndefined();
    const h = runHarness({ search }, true);
    expect(await handleRunLink(h.deps)).toBe('ran');
    const t = h.log.terminals[0];
    expect(t.cwd).toMatch(/^\/home\/user\/run\/sh-[0-9a-f]{12}$/);
    expect(h.log.prompts[0].wording).toBeUndefined();
    const start = h.files.get(`${t.cwd}/${START_FILE}`)!;
    expect(start).toContain('( . ./.recipe.sh )');
    h.files.set(`${t.cwd}/${/touch (\S+)/.exec(start)![1]}`, '');
    const again = runHarness({ search, fs: h.deps.fs }, false);
    expect(await handleRunLink(again.deps)).toBe('cancelled');
    expect(again.log.prompts).toHaveLength(1);
    // the query's link wins over a part after #, which is left alone
    expect(cleanRunUrl(`${ORIGIN}/?run=x#section`)).toBe(`${ORIGIN}/#section`);
  });

  it('in a real shell: the lines run where the Terminal is, and a cd stays', async () => {
    const { fs, shell } = await createTestShell();
    const home = '/home/user';
    await fs.rm(`${home}/linked`, { recursive: true }).catch(() => {});
    await fs.rm(`${home}/run`, { recursive: true }).catch(() => {});
    const script = 'mkdir -p linked\ncd linked\ncat > note.txt <<\'EOF\'\nfrom a link\nEOF\nexport LINKED=yes';
    const h = runHarness({ hash: '#' + commandsFragment(script), fs }, true);
    expect(await handleRunLink(h.deps)).toBe('ran');
    shell.cwd = home;
    const r = await run(shell, h.log.terminals[0].command);
    expect(r.exitCode, r.output).toBe(0);
    expect(shell.cwd).toBe(`${home}/linked`);
    expect(shell.env['LINKED']).toBe('yes');
    expect(await fs.readFile(`${home}/linked/note.txt`, 'utf8')).toBe('from a link\n');
    // it finished: the next visit finds the marker and asks nothing
    const again = runHarness({ hash: h.deps.hash, fs }, false);
    expect(await handleRunLink(again.deps)).toBe('on-open');
    expect(again.log.prompts).toEqual([]);
    shell.cwd = home;
    const second = await run(shell, again.log.terminals[0].command);
    expect(second.output).toContain('already ran here');
    expect(shell.cwd).toBe(home);
    // a last command that fails leaves no marker, and says so
    const failing = runHarness({ hash: typed('echo before; false'), fs }, true);
    await handleRunLink(failing.deps);
    const f = await run(shell, failing.log.terminals[0].command);
    expect(f.output).toContain('before');
    expect(f.output).toMatch(/link: the last command stopped with status 1/);
    const asked = runHarness({ hash: failing.deps.hash, fs }, false);
    expect(await handleRunLink(asked.deps)).toBe('cancelled');
    expect(asked.log.prompts).toHaveLength(1);
  });
});

describe('#gist: an app or a script, by what the gist holds', () => {
  const ID = 'ab12'.repeat(8);
  const api = `https://api.github.com/gists/${ID}`;
  const gist = (files: string[], login = 'someone') => JSON.stringify({ owner: { login }, history: [{ version: 'c'.repeat(40) }], files: Object.fromEntries(files.map((f) => [f, { content: 'x' }])) });
  const site = (body: string, status = 200) => {
    const asked: string[] = [];
    const fetchFn = async (url: string) => { asked.push(url); return url === api ? new Response(body, { status, headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 404 }); };
    return { fetchFn, asked };
  };
  const link = (f: string) => parseFragment(f) as Extract<NonNullable<ReturnType<typeof parseFragment>>, { kind: 'gist' }>;

  it('an app.json makes it an app; otherwise its first script runs', async () => {
    expect(await gistFragmentQuery(link(`#gist:${ID}`), site(gist(['README.md', 'app.json'])).fetchFn)).toEqual({ app: `?app=gist:${ID}` });
    expect(await gistFragmentQuery(link(`#gist:someone/${ID}`), site(gist(['app.json', 'index.html'])).fetchFn)).toEqual({ app: `?app=gist:someone/${ID}` });
    expect(await gistFragmentQuery(link(`#gist:${ID}`), site(gist(['README.md', 'setup.sh', 'z.sh'])).fetchFn)).toEqual({ run: `?run=gist:someone/${ID}/setup.sh` });
    expect(await gistFragmentQuery(link(`#gist:${ID}`), site(gist(['notes.txt'])).fetchFn)).toEqual({ run: `?run=gist:someone/${ID}/notes.txt` });
    // both queries are ones the existing links read
    expect(parseAppUrl(`?app=gist:${ID}`)!.target).toEqual({ kind: 'gist', user: '', id: ID });
    expect(parseRunUrl(`?run=gist:someone/${ID}/setup.sh`)!.target).toMatchObject({ kind: 'gist', user: 'someone', id: ID, file: 'setup.sh' });
    // a file named in the link is the script, and nothing is asked of GitHub to know that
    const named = site(gist(['app.json']));
    expect(await gistFragmentQuery(link(`#gist:someone/${ID}/other.sh`), named.fetchFn)).toEqual({ run: `?run=gist:someone/${ID}/other.sh` });
    expect(named.asked).toEqual([]);
  });

  it('refuses a gist of another account, one with no files, a name a link cannot use, and what GitHub does not have', async () => {
    const said = async (p: Promise<unknown>) => { try { await p; } catch (e) { expect(e).toBeInstanceOf(RunLinkError); return (e as Error).message; } return ''; };
    expect(await said(gistFragmentQuery(link(`#gist:mallory/${ID}`), site(gist(['app.json'], 'someone')).fetchFn))).toMatch(/is not a gist of that account/);
    expect(await said(gistFragmentQuery(link(`#gist:${ID}`), site(gist([])).fetchFn))).toMatch(/holds no files/);
    expect(await said(gistFragmentQuery(link(`#gist:${ID}`), site(gist(['my script.sh'])).fetchFn))).toMatch(/not one a link can use/);
    expect(await said(gistFragmentQuery(link(`#gist:${ID}`), site('{}', 404).fetchFn))).toMatch(/does not exist/);
    expect(await said(gistFragmentQuery(link(`#gist:${ID}`), site('<html>', 200).fetchFn))).toMatch(/could not read/);
    expect(await said(gistFragmentQuery(link(`#gist:${ID}`), site(gist(['a.sh'], '../evil')).fetchFn))).toMatch(/no owner/);
  });

  it('the listing is asked for once, and the prompt reads the same answer', async () => {
    const s = site(gist(['app.json']));
    const once = fetchOnce(s.fetchFn, api);
    expect(await gistFragmentQuery(link(`#gist:${ID}`), once)).toEqual({ app: `?app=gist:${ID}` });
    const second = await once(api, {});
    expect(JSON.parse(await second.text()).owner.login).toBe('someone');
    await once('https://example.com/other');
    expect(s.asked).toEqual([api, 'https://example.com/other']);
    // signed in is another answer
    await once(api, { headers: { authorization: 'Bearer t' } });
    expect(s.asked.filter((u) => u === api)).toHaveLength(2);
  });
});

describe('the /link page writes what the app reads', () => {
  type Page = {
    EXAMPLES: { name: string; text: string }[];
    readBox(text: string): { kind: string; fragment: string; key: string };
    pairsFromLines(text: string): [string, string][];
    pack(text: string): Promise<string>;
    isAppKey(key: string): boolean;
    READABLE_MAX: number; FRAGMENT_MAX: number;
  };
  const page = (): Promise<Page> => import(/* @vite-ignore */ path.join(ROOT, 'public/link/fragment.js')) as Promise<Page>;

  it('each example reads back as what was typed, and the apps are valid', async () => {
    const p = await page();
    const lengths: Record<string, string> = {};
    expect(p.EXAMPLES.map((e) => e.name)).toEqual(['A Python one-liner', 'A Flask hello', 'The jq playground', 'An expenses table', 'A C hello']);
    for (const ex of p.EXAMPLES) {
      const r = p.readBox(ex.text);
      const url = `${ORIGIN}/#${r.fragment}`;
      lengths[ex.name] = `${url.length} (${r.kind})`;
      expect(url.length, ex.name).toBeLessThanOrEqual(READABLE_MAX);
      expect(r.fragment, ex.name).toMatch(/^[A-Za-z0-9\-._~!$'()*+,;=:@/?&%]+$/);
      const back = parseFragment(new URL(url).hash)!;
      expect(back.kind, ex.name).toBe(r.kind);
      if (back.kind === 'commands') {
        expect(back.text).toBe(ex.text + '\n');
        expect(r.fragment).toBe(commandsFragment(ex.text));
      } else if (back.kind === 'app') {
        expect(back.pairs).toEqual(p.pairsFromLines(ex.text));
        expect(r.fragment).toBe(appFragment(back.pairs));
        const app = await keysApp(back.pairs);
        expect(app.manifest.kind).not.toBe('page');
      }
    }
    console.log('[link] characters of each /link example:', JSON.stringify(lengths));
    // the two examples the site also ships are the same apps
    const same = async (name: string, id: string) => {
      const pairs = (parseFragment('#' + p.readBox(p.EXAMPLES.find((e) => e.name === name)!.text).fragment) as { pairs: [string, string][] }).pairs;
      expect((await keysApp(pairs)).manifest, name).toEqual(validateManifest(JSON.parse(dec(example(id)))));
    };
    await same('The jq playground', 'jq-playground');
    await same('An expenses table', 'expenses');
    // the C hello: a program of several lines in one value, and a toolchain set under needs
    const c = await keysApp(p.pairsFromLines(p.EXAMPLES[4].text));
    expect(c.manifest).toMatchObject({ kind: 'form', shell: true, needs: ['c'], stdin: '{code}' });
    expect(c.manifest.fields[0].value).toBe('#include <stdio.h>\n\nint main(void) {\n    puts("hello from a link");\n    return 0;\n}');
  });

  it('the box follows the address\'s rule, and the two lists of keys agree', async () => {
    const p = await page();
    expect(p.READABLE_MAX).toBe(READABLE_MAX);
    expect(p.FRAGMENT_MAX).toBe(FRAGMENT_MAX);
    for (const k of ['run', 'name', 'about', 'description', 'id', 'version', 'out', 'stdin', 'output', 'table', 'shell', 'each', 'live', 'accept', 'needs', 'toolchains', 'columns', 'fields', 'options', 'manifest',
      'field.x', 'fields.x.value', 'option.q', 'window.width', 'FOO', 'entry', 'icon', 'echo a', 'user.name', '']) expect(p.isAppKey(k), k).toBe(isAppKey(k));
    expect(p.readBox('')).toEqual({ kind: 'none', fragment: '', key: '' });
    expect(p.readBox('  \n ').kind).toBe('none');
    for (const text of ['FOO=1 make', 'echo a=b', 'git config user.name=x', 'ls -la', 'echo done.', 'safe', 'app=1 ./go', 'echo こんにちは # hi']) {
      const r = p.readBox(text);
      expect(r.kind, text).toBe('commands');
      expect(r.fragment, text).toBe(commandsFragment(text));
      expect(commands('#' + r.fragment), text).toBe(text + '\n');
    }
    // a line that starts with an app key is an app here too, and sh: says otherwise
    expect(p.readBox('name=World; echo hi $name')).toMatchObject({ kind: 'app', key: 'name' });
    const sh = p.readBox('sh:name=World; echo hi $name');
    expect(sh.kind).toBe('commands');
    expect(commands('#' + sh.fragment)).toBe('name=World; echo hi $name\n');
    const gist = p.readBox(`gist:someone/${'ab12'.repeat(8)}`);
    expect(gist.kind).toBe('gist');
    expect(parseFragment('#' + gist.fragment)).toEqual({ kind: 'gist', user: 'someone', id: 'ab12'.repeat(8), file: '' });
    // a value keeps its & and =; a line that starts no key continues the value above
    expect(p.pairsFromLines('name=A & B\nrun=sh -c "x=1; echo $x"\nabout=two\nlines\n')).toEqual([['name', 'A & B'], ['run', 'sh -c "x=1; echo $x"'], ['about', 'two\nlines']]);
    expect(parseFragment('#' + p.readBox('name=A & B\nrun=cat {in}').fragment)).toEqual({ kind: 'app', pairs: [['name', 'A & B'], ['run', 'cat {in}']] });
    // the compressed form is the one the app unpacks
    expect(dec(await unpackCommands(await p.pack('echo héllo'), 1000))).toBe('echo héllo\n');
  });
});

describe('app share for a one-file app', () => {
  it('gives the readable link when the app is one app.json, and says what it is', async () => {
    const { fs } = await createTestShell();
    const dir = '/home/user/Apps/expenses';
    await fs.rm(dir, { recursive: true }).catch(() => {});
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/app.json`, example('expenses'));
    const base = { id: 'expenses', name: 'Expenses', version: '', dir, installedAt: 0, icon: '', source: 'dir:/x' };
    const share = await shareApp(fs, base, ORIGIN);
    expect(share).toMatchObject({ kind: 'files', files: 1, readable: true, asks: true });
    expect(share.url.startsWith(`${ORIGIN}/#name=Expenses&`)).toBe(true);
    const said = shareStatement(share);
    expect(said.promise).toHaveLength(3);
    expect(said.details[0]).toBe('The link is Expenses itself: its app.json is written after the #, key by key. The link is not stored on a server.');
    expect(said.details.join(' ')).toMatch(/installs it only when they choose Install/);
    // the copy made from the link is the same app
    const copy = await keysApp((parseFragment(new URL(share.url).hash) as { pairs: [string, string][] }).pairs);
    expect(copy.manifest).toEqual(validateManifest(JSON.parse(dec(example('expenses'))), { id: 'expenses' }));
    // a second file beside it: the packed form, as before
    await fs.writeFile(`${dir}/notes.txt`, 'x');
    const packed = await shareApp(fs, base, ORIGIN);
    expect(packed.readable).toBeUndefined();
    expect(packed.url).toMatch(/\/\?app=link#app=[A-Za-z0-9_-]+$/);
    await fs.rm(dir, { recursive: true });
  });
});
