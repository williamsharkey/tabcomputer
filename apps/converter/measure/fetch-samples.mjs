// node apps/converter/measure/fetch-samples.mjs [--get]
// List (and with --get, download into $APPMAKER_OUT/samples) sample files from public test corpora:
// LibreOffice's import tests, Apache Tika's test documents, mdbtools' test data, and .pub
// attachments of LibreOffice bug reports with the reference renderings filed beside them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT as BASE } from './lib.mjs';
const OUT = join(BASE, 'samples');
const get = process.argv.includes('--get');
const dirs = [
  ['LibreOffice/core', 'writerperfect/qa/unit/data/draw/libmspub/pass', 'lo-mspub'],
  ['LibreOffice/core', 'writerperfect/qa/unit/data/writer/libwpd/pass', 'lo-wpd'],
  ['LibreOffice/core', 'writerperfect/qa/unit/data/writer/libwps/pass', 'lo-wps'],
  ['LibreOffice/core', 'writerperfect/qa/unit/data/calc/libwps/pass', 'lo-wks'],
  ['LibreOffice/core', 'writerperfect/qa/unit/data/writer/libmwaw/pass', 'lo-mwaw'],
  ['LibreOffice/core', 'writerperfect/qa/unit/data/calc/libmwaw/pass', 'lo-mwaw-calc'],
  ['apache/tika', 'tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/test/resources/test-documents', 'tika-ms'],
  ['apache/tika', 'tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-miscoffice-module/src/test/resources/test-documents', 'tika-misc'],
  ['mdbtools/mdbtestdata', 'data', 'mdb'],
];
const want = /\.(pub|wpd|wp|wp5|wp6|wps|wks|wk1|wk3|wk4|123|wq1|wq2|wdb|cwk|cws|mdb)$/i;
for (const [repo, dir, tag] of dirs) {
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${dir}`, { headers: { 'user-agent': 'sample-fetch' } });
  if (!r.ok) { console.log(`== ${repo}/${dir}: HTTP ${r.status}`); continue; }
  const list = (await r.json()).filter((f) => f.type === 'file' && want.test(f.name));
  console.log(`== ${repo}/${dir}: ${list.length} files`);
  for (const f of list) {
    console.log(`   ${f.size} ${f.name}`);
    if (get && f.size < 6_000_000) {
      const b = Buffer.from(await (await fetch(f.download_url)).arrayBuffer());
      mkdirSync(join(OUT, tag), { recursive: true });
      writeFileSync(join(OUT, tag, f.name), b);
    }
  }
}

// Publisher files people attached to LibreOffice bug reports, and how Publisher itself rendered them
const BUGS = [61579, 133297, 130289, 100639];
const REFS = [[75757, 'flyer-publisher2002.png'], [109475, 'flyer.pdf'], [161175, 'test-publisher.png']];
const bz = 'https://bugs.documentfoundation.org/rest/bug';
for (const id of BUGS) {
  const list = (await (await fetch(`${bz}/${id}/attachment?include_fields=id,file_name,size,summary`)).json()).bugs?.[id] ?? [];
  for (const a of list) {
    if (!/\.pub$/i.test(a.file_name)) continue;
    console.log(`   bug ${id}: ${a.size} ${a.file_name}`);
    if (!get) continue;
    const d = await (await fetch(`${bz}/attachment/${a.id}?include_fields=data`)).json();
    mkdirSync(join(OUT, 'lo-bugs'), { recursive: true });
    writeFileSync(join(OUT, 'lo-bugs', `bug${id}-${a.file_name.replace(/[^\w.-]/g, '_')}`), Buffer.from(d.attachments[a.id].data, 'base64'));
  }
}
if (get) for (const [id, name] of REFS) {
  const d = await (await fetch(`${bz}/attachment/${id}?include_fields=data`)).json();
  mkdirSync(join(BASE, 'refs'), { recursive: true });
  writeFileSync(join(BASE, 'refs', name), Buffer.from(d.attachments[id].data, 'base64'));
}
