/**
 * The Studio's model (src/apps/studio.ts, docs/APPS.md "Studio"): the form a
 * person fills in, the app.json it makes, the problems beside each part of
 * the form, and the state between them. The three example apps are made from
 * nothing here, as a person would make them in the window.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '@shiro/apps/manifest';
import {
  StudioState, blankDraft, checkDraft, draftToRaw, rawToDraft, problemField, inputNames, acceptList, choiceLines, tableFile,
  previewManifest, sampleCsv, samplePdf, sampleKind, PREVIEW_ID, draftText,
} from '@shiro/apps/studio';
import { shareFiles } from '@shiro/apps/share';
import { jsonPlaces, locateProblems, problemPath } from '@shiro/apps/manifest-locate';

const EXAMPLES = join(__dirname, '../../../apps/examples');
const example = (id: string) => JSON.parse(readFileSync(join(EXAMPLES, id, 'app.json'), 'utf8')) as Record<string, unknown>;
const ORIGIN = 'https://tabcomputer.com';
/** What the app is, whatever the order and spelling of its keys */
const same = (raw: Record<string, unknown>, id: string) => expect({ ...validateManifest(raw, { id }), id }).toEqual(validateManifest(example(id), { id }));

describe('the three example apps, made from nothing', () => {
  it('jq playground: a live form whose JSON is the text the program reads', () => {
    const s = new StudioState();
    s.choose('form');
    s.set('name', 'jq playground');
    s.set('about', 'Try a jq filter on some JSON. The result changes as you type.');
    s.set('run', 'jq {filter}');
    expect(s.draft.inputs.map((i) => i.name)).toEqual(['filter']);
    s.set('stdin', '{json}');
    expect(s.draft.inputs.map((i) => [i.name, i.label, i.type])).toEqual([['filter', 'Filter', 'text'], ['json', 'JSON', 'text']]);
    s.setInput('filter', 'value', '.people[] | select(.age > 30) | .name');
    s.setInput('json', 'type', 'long text');
    s.setInput('json', 'value', '{"people": [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 21}, {"name": "Grace", "age": 45}]}');
    s.set('live', true);
    const c = s.check();
    expect(c.problems).toEqual([]);
    same(c.raw, 'jq-playground');
    // jq is a builtin: nothing to install
    expect(s.draft.needs).toBe('');
  });

  it('Make pictures smaller: a files app with one choice, its package filled in from the command', () => {
    const s = new StudioState();
    s.choose('files');
    s.set('name', 'Make pictures smaller');
    s.set('about', 'Shrinks each picture to fit a size, keeping its shape. A picture that is already smaller is left as it is.');
    s.set('accept', 'jpg jpeg png webp gif tif tiff');
    s.set('run', 'convert {in} -auto-orient -resize {size} {out}');
    expect(s.draft.needs).toBe('imagemagick');
    expect(s.draft.inputs.map((i) => [i.name, i.type])).toEqual([['size', 'choice']]);
    s.setInput('size', 'label', 'Longest side');
    s.setInput('size', 'choices', '800 pixels: 800x800>\n1600 pixels: 1600x1600>\n2560 pixels: 2560x2560>');
    s.setInput('size', 'value', '1600 pixels');
    s.set('out', '{name}-small.{ext}');
    const c = s.check();
    expect(c.problems).toEqual([]);
    same(c.raw, 'resize-pictures');
  });

  it('Expenses: a table of five columns', () => {
    const s = new StudioState();
    s.choose('table');
    s.set('name', 'Expenses');
    s.set('about', 'A list of what was spent, with a total.');
    const cols: [string, 'text' | 'date' | 'choice' | 'number' | 'checkbox', string][] = [
      ['Date', 'date', ''], ['What', 'text', ''], ['Category', 'choice', 'Food, Travel, Home, Other'], ['Amount', 'number', ''], ['Paid back', 'checkbox', ''],
    ];
    cols.forEach(([name, type, choices], i) => {
      if (i) s.addColumn();
      s.setColumn(i, 'name', name);
      s.setColumn(i, 'type', type);
      if (choices) s.setColumn(i, 'choices', choices);
    });
    const c = s.check();
    expect(c.problems).toEqual([]);
    expect(c.raw.table).toBe('expenses.csv');
    same(c.raw, 'expenses');
  });
});

describe('form to app.json and back', () => {
  it('every one-file example reads into the form and comes back as the same app', () => {
    const ids = readdirSync(EXAMPLES).filter((id) => !id.startsWith('.'));
    expect(ids.length).toBeGreaterThanOrEqual(13);
    for (const id of ids) {
      const d = rawToDraft(example(id));
      expect(d, id).not.toBeNull();
      same(draftToRaw(d!), id);
    }
  });

  it('leaves out every key at its default', () => {
    const d = blankDraft('files');
    d.name = 'Tidy';
    d.run = 'jq . {in}';
    expect(draftToRaw(d)).toEqual({ name: 'Tidy', run: 'jq . {in}' });
    const f = blankDraft('form');
    f.name = 'Count';
    f.run = 'seq {from} {to}';
    f.inputs = inputNames(f).map((n) => ({ name: n, label: n === 'from' ? 'From' : 'Up to', type: 'number', value: n === 'from' ? '1' : '', choices: '', on: '', accept: '' }));
    expect(draftToRaw(f)).toEqual({ name: 'Count', fields: { from: { type: 'number', value: 1 }, to: { label: 'Up to', type: 'number' } }, run: 'seq {from} {to}' });
  });

  it('keeps the keys the form does not show, and an installed app\'s id', () => {
    const s = new StudioState();
    expect(s.load({ name: 'Wide', run: 'cat {in}', window: { width: 900 }, version: '2' }, { edit: 'wide-one' })).toBe(true);
    s.set('name', 'Wider');
    expect(draftToRaw(s.draft)).toEqual({ id: 'wide-one', name: 'Wider', run: 'cat {in}', window: { width: 900 }, version: '2' });
    // An app with a page of its own is not the Studio's
    expect(s.load({ name: 'Paged', entry: 'public' })).toBe(false);
  });

  it('gives an id to a name that makes none, since the form has no box for one', () => {
    const d = blankDraft('files');
    d.run = 'cat {in}';
    d.name = 'A';
    expect(checkDraft(d)).toMatchObject({ problems: [], raw: { id: 'a-app', name: 'A' } });
    d.name = 'Files';
    expect(checkDraft(d)).toMatchObject({ problems: [], raw: { id: 'files-app' } });
    d.name = 'Copy';
    expect(draftToRaw(d).id).toBeUndefined();
  });

  it('reads file types and choices as a person types them', () => {
    expect(acceptList('jpg, .PNG  .jpg tiff')).toEqual(['.jpg', '.png', '.tiff']);
    expect(choiceLines('Small: /ebook\n\n Print : /printer\nPlain\nPlain')).toEqual([
      { label: 'Small', value: '/ebook' }, { label: 'Print', value: '/printer' }, { label: 'Plain', value: 'Plain' },
    ]);
    expect(tableFile({ name: 'My Expenses!', table: '', store: 'csv' })).toBe('my-expenses.csv');
    expect(tableFile({ name: '', table: '', store: 'sqlite' })).toBe('table.sqlite');
    expect(tableFile({ name: 'x', table: 'kept.csv', store: 'sqlite' })).toBe('kept.sqlite');
  });

  it('writes the app.json as text a person can read', () => {
    expect(draftText({ name: 'A', run: 'cat {in}' })).toBe('{\n  "name": "A",\n  "run": "cat {in}"\n}\n');
  });
});

describe('live validation', () => {
  it('puts each problem beside the part of the form its key names', () => {
    expect(problemField('name is missing (got nothing)')).toBe('name');
    expect(problemField('id must be 2 to 32 of a-z')).toBe('name');
    expect(problemField('run must say where the file goes: {in}')).toBe('run');
    expect(problemField('run: {x} is not known (known: {in})')).toBe('run');
    expect(problemField('accept[1] must be an extension such as ".pdf" (got ".p df")')).toBe('accept');
    expect(problemField('options.size.choices must be a list of 1 to 40 choices')).toBe('input:size');
    expect(problemField('fields.json.value must be text (got 3)')).toBe('input:json');
    expect(problemField('unknown key fields.json.colour (known: label, type)')).toBe('input:json');
    expect(problemField('columns[1].name "a" is the name of an earlier column', [0, 2])).toBe('column:2');
    expect(problemField('columns must be a list of 1 to 40 columns')).toBe('columns');
    expect(problemField('needs[0] must be the name of a Debian package (got "x-")')).toBe('needs');
    expect(problemField('out goes with "output": "file"')).toBe('out');
    expect(problemField('unknown key colour (known: …)')).toBe('other');
    expect(problemField('window.width must be a number')).toBe('other');
  });

  it('shows a problem only once its part of the form was touched, or Share was asked for', () => {
    const s = new StudioState();
    s.choose('files');
    let c = s.check();
    expect(c.problems.map((p) => p.field).sort()).toEqual(['name', 'run']);
    expect(c.shown).toEqual([]);
    s.set('run', 'convert -resize 50% {out}');
    c = s.check();
    expect(c.shown).toEqual([{ field: 'run', text: 'run must say where the file goes: {in}' }]);
    s.tried = true;
    expect(s.check().shown.map((p) => p.field).sort()).toEqual(['name', 'run']);
  });

  it('an option without choices is named beside that option, in app check\'s words', () => {
    const s = new StudioState();
    s.choose('files');
    s.set('name', 'Shrink');
    s.set('run', 'gs -dPDFSETTINGS={quality} -o {out} {in}');
    const c = s.check();
    expect(c.problems.map((p) => p.text)).toHaveLength(1);
    expect(c.problems[0].field).toBe('input:quality');
    expect(c.problems[0].text).toMatch(/^options\.quality\.choices must be a list of 1 to 40 choices/);
  });

  it('a column whose name another has is named beside its own row, past rows left empty', () => {
    const s = new StudioState();
    s.choose('table');
    s.set('name', 'List');
    s.setColumn(0, 'name', 'Item');
    s.addColumn();
    s.addColumn();
    s.setColumn(2, 'name', 'item');
    const c = s.check();
    expect(c.problems.map((p) => p.field)).toEqual(['column:2']);
    // Removing the last column leaves one empty row to type in, and the table needs one
    s.removeColumn(2); s.removeColumn(1); s.removeColumn(0);
    expect(s.draft.columns).toHaveLength(1);
    expect(s.check().problems.map((p) => p.field)).toEqual(['columns']);
  });
});

describe('the Studio\'s state', () => {
  it('keeps what was said about a field that is typed away and back', () => {
    const s = new StudioState();
    s.choose('form');
    s.set('run', 'jq {filter}');
    s.setInput('filter', 'label', 'The filter');
    s.set('run', 'jq {filt}');
    expect(s.draft.inputs.map((i) => i.name)).toEqual(['filt']);
    s.set('run', 'jq {filter}');
    expect(s.draft.inputs[0].label).toBe('The filter');
  });

  it('switching kinds and back loses nothing; the name goes along', () => {
    const s = new StudioState();
    s.choose('files');
    s.set('name', 'Thing');
    s.set('run', 'cat {in}');
    s.choose('table');
    expect(s.draft.name).toBe('Thing');
    s.choose('files');
    expect(s.draft.run).toBe('cat {in}');
  });

  it('fills in the package from the command until the person types one', () => {
    const s = new StudioState();
    s.choose('files');
    s.set('run', 'gs -o {out} {in}');
    expect(s.draft.needs).toBe('ghostscript');
    s.set('run', 'pandoc {in} -o {out}');
    expect(s.draft.needs).toBe('pandoc');
    s.set('needs', 'pandoc texlive');
    s.set('run', 'convert {in} {out}');
    expect(s.draft.needs).toBe('pandoc texlive');
  });

  it('the copy beside the form runs before it has a name, under one id', () => {
    const d = blankDraft('table');
    d.columns = [{ name: 'Item', type: 'text', choices: '' }];
    const m = previewManifest(d)!;
    expect(m.id).toBe(PREVIEW_ID);
    expect(m.name).toBe('New app');
    expect(m.table).toBe('table.csv');
    d.columns = [];
    expect(previewManifest(d)).toBeNull();
    expect(checkDraft(d).problems.map((p) => p.field).sort()).toEqual(['columns', 'name']);
  });
});

describe('Try it and Share', () => {
  it('makes three rows a table can read, of each column\'s kind', () => {
    const m = validateManifest(example('expenses'), { id: 'expenses' });
    const csv = sampleCsv(m, new Date('2026-10-13T12:00:00Z'));
    expect(csv.split('\n')[0]).toBe('Date,What,Category,Amount,Paid back');
    expect(csv.split('\n')[1]).toBe('2026-10-13,A first row,Food,12.5,');
    expect(csv.split('\n')[2]).toBe('2026-10-12,A second row,Travel,40,yes');
    expect(csv.trim().split('\n')).toHaveLength(4);
  });

  it('makes a PDF whose cross-reference table points at its objects', () => {
    const pdf = new TextDecoder().decode(samplePdf('Hello (world)'));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => expect(pdf.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
    expect(pdf).toContain('(Hello \\(world\\))');
  });

  it('picks a sample it can make for the file types', () => {
    expect(sampleKind([])).toBe('.txt');
    expect(sampleKind(['.heic', '.jpg'])).toBe('.jpg');
    expect(sampleKind(['.pdf'])).toBe('.pdf');
    expect(sampleKind(['.heic', '.heif'])).toBe('');
  });

  it('shares a draft as the readable link app share gives an installed one', async () => {
    const s = new StudioState();
    s.load(example('resize-pictures'));
    const text = draftText(s.check().raw);
    const share = await shareFiles(new Map([['app.json', new TextEncoder().encode(text)]]), { id: 'make-pictures-smaller', name: 'Make pictures smaller' }, ORIGIN);
    expect(share.readable).toBe(true);
    expect(share.url.startsWith(`${ORIGIN}/#`)).toBe(true);
    expect(share.url).toContain('run=convert%20%7Bin%7D');
  });
});

describe('app mode in the Code app: app.json checked as it is typed', () => {
  const at = (text: string, l: { from: number; to: number }) => text.slice(l.from, l.to);

  it('finds every key path with where its key and its value are', () => {
    const text = '{\n  "name": "A",\n  "columns": ["x", { "name": "y", "type": "nope" }],\n  "window": { "width": "wide" }\n}\n';
    const j = jsonPlaces(text);
    expect(j.error).toBeNull();
    expect(text.slice(...j.places.get('name')!.key!)).toBe('"name"');
    expect(text.slice(...j.places.get('window.width')!.value)).toBe('"wide"');
    expect(text.slice(...j.places.get('columns[1].type')!.key!)).toBe('"type"');
    expect(j.places.get('columns[0]')!.key).toBeNull();
  });

  it('underlines each problem at the key it names, in app check\'s words', () => {
    const text = '{\n  "name": "Shrink",\n  "acept": [".pdf"],\n  "run": "gs -o {out} {in} {q}",\n  "window": { "width": "wide" }\n}\n';
    const found = locateProblems(text);
    const by = (re: RegExp) => found.find((p) => re.test(p.message))!;
    expect(at(text, by(/^unknown key acept/))).toBe('"acept"');
    expect(at(text, by(/^run: \{q\} is not known/))).toBe('"run"');
    expect(at(text, by(/^window\.width must be/))).toBe('"width"');
    // Each message is validateManifest's own
    let own: string[] = [];
    try { validateManifest(JSON.parse(text)); } catch (e) { own = (e as { problems: string[] }).problems; }
    expect(found.map((p) => p.message).sort()).toEqual([...own].sort());
  });

  it('puts a missing key at the nearest key above it, the top line for the whole', () => {
    const text = '{ "name": "Big table",\n  "table": "t.csv" }';
    const [p] = locateProblems(text);
    expect(p.message).toMatch(/^columns must be a list/);
    expect(at(text, p)).toBe('{ "name": "Big table",');
    const t2 = '{ "name": "X", "fields": { "a": { "type": "choice" } }, "run": "echo {a}" }';
    const q = locateProblems(t2).find((x) => /choices/.test(x.message))!;
    expect(at(t2, q)).toBe('"a"');
    expect(problemPath('unknown key backend.socket (known: start)')).toBe('backend.socket');
    expect(problemPath('columns[2].type must be one of')).toBe('columns[2].type');
  });

  it('says where the text stops being JSON', () => {
    const text = '{\n  "name": "A",\n  "run": "cat {in}"\n  "accept": []\n}';
    const [p] = locateProblems(text);
    expect(p.message).toMatch(/^app\.json is not valid JSON: a , or a \} is expected here/);
    expect(text.slice(p.from).startsWith('"accept"')).toBe(true);
    expect(locateProblems('{"name": "Cat", "run": "cat {in}"}')).toEqual([]);
  });
});
