// node apps/converter/measure/render-results.mjs
// Screenshots of converted Publisher files ($APPMAKER_OUT/results, saved by measure-prod.mjs as the
// converter wrote them) for the quality notes: each as pub2xhtml's own output opened as .html, and
// after the app's fix (un-prefixed inline SVG), into $APPMAKER_OUT/quality/.
import { pw, EXE, OUT } from './lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const RES = join(OUT, 'results'), Q = join(OUT, 'quality');
mkdirSync(Q, { recursive: true });
const fix = (x) => {
  const body = x.slice(x.indexOf('<body>') + 6, x.lastIndexOf('</body>'))
    .replace(/<\?import[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(\/?)svg:/g, '<$1').replace(/\sxmlns:svg="[^"]*"/g, '')
    .replace(/<svg /g, '<svg xmlns="http://www.w3.org/2000/svg" ');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;background:#888}svg{display:block;margin:12px auto;background:#fff;max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
};
const browser = await pw.chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
for (const name of readdirSync(RES).filter((n) => /\.pub|PUBLISHER|Flyer|TEST|MISSAL|Publication/i.test(n) && n.endsWith('.html'))) {
  const raw = readFileSync(join(RES, name), 'utf8');
  const stem = name.replace(/\.html$/, '');
  const info = { name, bytes: raw.length, pages: (raw.match(/<svg:svg/g) || []).length, texts: (raw.match(/<svg:text/g) || []).length, images: (raw.match(/<svg:image/g) || []).length, fonts: [...new Set([...raw.matchAll(/font-family:\s*([^;"]+)/g)].map((m) => m[1].trim()))].slice(0, 12) };
  const rawPath = join(Q, `${stem}.raw.html`), fixedPath = join(Q, `${stem}.fixed.html`);
  writeFileSync(rawPath, raw); writeFileSync(fixedPath, fix(raw));
  await page.goto('file://' + rawPath); await page.screenshot({ path: join(Q, `${stem}.raw.png`) });
  info.rawVisibleChars = (await page.evaluate(() => document.body.innerText.trim().length));
  await page.goto('file://' + fixedPath);
  const first = await page.$('svg');
  if (first) await first.screenshot({ path: join(Q, `${stem}.page1.png`) });
  const second = (await page.$$('svg'))[1];
  if (second) await second.screenshot({ path: join(Q, `${stem}.page2.png`) });
  console.log(JSON.stringify(info));
}
await browser.close();
