/**
 * Converter, hardwired: the thinnest built-in version of apps/converter, kept
 * to compare the two ways of making an app (docs/research/APP_MAKER.md). A
 * window that takes dropped files, writes them with the filesystem object and
 * runs Debian's converter programs in a forked shell: no server, no bridge.
 * Not in the dock (`desktop open converter`). It installs nothing: the
 * programs must be there already.
 *
 * Only type imports, so the measurement scripts can also load this one file
 * into a production tab and hand it the desktop's own AppContext.
 */

import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';

/** extension → [program that writes HTML to stdout, program that writes CSV] */
const TOOLS: Record<string, { html?: string; csv?: string }> = {
  wpd: { html: 'wpd2html' }, wp: { html: 'wpd2html' }, pub: { html: 'pub2xhtml' }, wps: { html: 'wps2html' },
  wks: { csv: 'wks2csv' }, wk1: { csv: 'wks2csv' }, wk3: { csv: 'wks2csv' }, wk4: { csv: 'wks2csv' },
  cwk: { html: 'mwaw2html', csv: 'mwaw2csv' },
};

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface ConverterRow { name: string; status: 'waiting' | 'converting' | 'done' | 'failed'; out?: string; error?: string; writeMs?: number; toolMs?: number; totalMs?: number }

export function open(ctx: AppContext): DesktopWindow {
  const { wm, fs, shell } = ctx;
  const t0 = performance.now();
  const root = document.createElement('div');
  root.className = 'sd-app';
  root.innerHTML = `
    <div class="sd-toolbar">
      <label class="sd-btn">Choose files<input type="file" multiple hidden></label>
      <select class="sd-btn" aria-label="Convert to"><option value="html">HTML</option><option value="csv">CSV</option></select>
      <button class="sd-btn" data-act="zip" disabled>Download all (.zip)</button>
      <button class="sd-btn" data-act="folder" disabled>Show in Files</button>
    </div>
    <div class="sd-scroll" style="padding:14px">
      <div class="sd-conv-drop" style="border:2px dashed var(--sd-border, #8884);border-radius:10px;padding:22px;text-align:center">Drop .pub .wpd .wps .wks .cwk files here</div>
      <table class="sd-table"><tbody></tbody></table>
    </div>`;
  const dropEl = root.querySelector<HTMLElement>('.sd-conv-drop')!;
  const tbody = root.querySelector('tbody')!;
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const to = root.querySelector<HTMLSelectElement>('select')!;
  const zipBtn = root.querySelector<HTMLButtonElement>('[data-act=zip]')!;
  const folderBtn = root.querySelector<HTMLButtonElement>('[data-act=folder]')!;

  const win = wm.createWindow({ appId: 'converter', title: 'Converter', width: 560, height: 420, minWidth: 320, minHeight: 220, content: { kind: 'dom', element: root } });

  const job = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const inDir = `/tmp/converter-hw/${job}`;
  const outDir = `/home/user/Converted/${job}`;
  const rows: ConverterRow[] = [];
  const marks: Record<string, number> = { open: Math.round(t0) };
  // For tests and the measurement scripts
  (globalThis as any).__converterHW = { rows, marks, outDir, win, take };

  const render = () => {
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = r.name;
      const b = document.createElement('td'); b.textContent = r.status === 'failed' ? `failed: ${r.error}` : r.status === 'done' ? `converted in ${((r.totalMs ?? 0) / 1000).toFixed(1)} s` : r.status;
      tr.append(a, b); tbody.appendChild(tr);
    }
    const busy = rows.some(r => r.status === 'waiting' || r.status === 'converting');
    zipBtn.disabled = folderBtn.disabled = busy || !rows.some(r => r.status === 'done');
  };

  let chain: Promise<void> = Promise.resolve();
  function take(files: File[]): Promise<void> {
    marks.firstDrop ??= Math.round(performance.now());
    const fmt = to.value as 'html' | 'csv';
    for (const file of files) {
      const row: ConverterRow = { name: file.name, status: 'waiting' };
      rows.push(row);
      chain = chain.then(() => one(file, row, fmt)).then(render);
    }
    render();
    return chain.then(() => { marks.allDone = Math.round(performance.now()); });
  }

  async function one(file: File, row: ConverterRow, fmt: 'html' | 'csv'): Promise<void> {
    const start = performance.now();
    row.status = 'converting'; render();
    const tool = TOOLS[(file.name.split('.').pop() ?? '').toLowerCase()]?.[fmt];
    if (!tool) { row.status = 'failed'; row.error = `no ${fmt.toUpperCase()} converter for this kind of file`; return; }
    try {
      const src = `${inDir}/${file.name}`;
      const out = `${outDir}/${file.name.replace(/\.[^.]+$/, '')}.${fmt}`;
      await fs.mkdir(inDir, { recursive: true });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(src, new Uint8Array(await file.arrayBuffer()));
      row.writeMs = Math.round(performance.now() - start);
      const t1 = performance.now();
      let err = '';
      const side = shell.fork();
      (side as any).terminal = null;
      const code = await side.execute(`${tool} ${q(src)} > ${q(out)}`, () => {}, (s) => { err += s; });
      row.toolMs = Math.round(performance.now() - t1);
      const size = code === 0 ? (await fs.stat(out).catch(() => null))?.size ?? 0 : 0;
      if (!size) { await fs.unlink(out).catch(() => {}); throw new Error(err.trim().split('\n').pop() || `exit ${code}`); }
      row.status = 'done'; row.out = out;
      marks.firstDone ??= Math.round(performance.now());
    } catch (e) {
      row.status = 'failed'; row.error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    row.totalMs = Math.round(performance.now() - start);
  }

  dropEl.addEventListener('dragover', (e) => { e.preventDefault(); });
  dropEl.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); void take([...(e.dataTransfer?.files ?? [])]); });
  input.addEventListener('change', () => { void take([...(input.files ?? [])]); input.value = ''; });
  root.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'folder') void wm.openApp('files', { path: outDir });
    if (act !== 'zip') return;
    const t1 = performance.now();
    const zip = `${inDir}/converted.zip`;
    const side = shell.fork();
    (side as any).terminal = null;
    await side.execute(`rm -f ${q(zip)}; cd ${q(outDir)} && zip -r ${q(zip)} .`, () => {}, () => {});
    const bytes = await fs.readFile(zip) as Uint8Array;
    marks.zipMs = Math.round(performance.now() - t1); marks.zipBytes = bytes.length;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
    a.download = `converted-${job}.zip`;
    a.click();
  });

  marks.interactive = Math.round(performance.now());
  return win;
}
