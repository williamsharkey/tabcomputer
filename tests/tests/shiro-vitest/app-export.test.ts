/**
 * An app with its data as one file (src/apps/export.ts, docs/APPS.md "Export
 * and import", tabcomputer#138): what the file holds, that it reads back
 * byte for byte, what an import asks before it changes anything, what it
 * says would be replaced, and the mark an app shows when its data is in no
 * file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { appCmd } from '@shiro/commands/app';
import { readZip, zipFiles } from '@shiro/commands/zip';
import { configureApps, resetApps, setTabJsSource } from '@shiro/apps/runtime';
import { findInstalled } from '@shiro/apps/registry';
import { importApp, setInstallConfirm, setReplaceConfirm } from '@shiro/apps/install';
import { EXPORT_HEADER, backupMark, dataFiles, exportApp, looksLikeExport, noteExported, readExport, sinceText, whenText } from '@shiro/apps/export';
import { buildReplacePrompt, replaceWords, type ReplaceInfo } from '@shiro/apps/prompt';
import { initAppDrop } from '@shiro/apps/drop';
import type { InstallPromptInfo } from '@shiro/apps/links';

const HOME = '/home/user';
const DATA = `${HOME}/.local/share/apps/expenses`;
const TABLE = { name: 'Expenses', about: 'A list of what was spent.', table: 'expenses.csv', columns: ['What', { name: 'Amount', type: 'number' }] };
const text = (b: Uint8Array | string) => (typeof b === 'string' ? b : new TextDecoder().decode(b));
const message = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return ''; };
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe('export and import: an app with its data as one file', () => {
  let fs: FileSystem;
  let shell: Shell;
  let downloads: { name: string; bytes: Uint8Array; type: string }[];
  let installAsked: InstallPromptInfo[];
  let replaceAsked: ReplaceInfo[];
  let installAnswer: 'install' | 'cancel';
  let replaceAnswer: boolean;
  const app = async (line: string) => { const r = await run(shell, `app ${line}`); return { ...r, output: r.output.replace(/\r\n/g, '\n') }; };

  beforeEach(async () => {
    ({ fs, shell } = await createTestShell());
    shell.commands.register(appCmd);
    for (const p of ['/var/lib/tabcomputer', `${HOME}/Apps`, `${HOME}/.local/share/apps`, `${HOME}/mine`, `${HOME}/backups`]) await fs.rm(p, { recursive: true }).catch(() => {});
    downloads = [];
    installAsked = [];
    replaceAsked = [];
    installAnswer = 'install';
    replaceAnswer = true;
    configureApps({ fs, shell, toolchains: { installed: async () => ({}), install: async () => 0 }, download: (name, bytes, type) => { downloads.push({ name, bytes, type }); } });
    setInstallConfirm(async (info) => { installAsked.push(info); return installAnswer; });
    setReplaceConfirm(async (info) => { replaceAsked.push(info); return replaceAnswer; });
    setTabJsSource('// tab.js', 'tab.js');
    setTabJsSource('// page.js', 'page.js');
    shell.cwd = HOME;
    // Expenses, installed from a folder, with two rows and things that are not its data
    await fs.mkdir(`${HOME}/mine/expenses`, { recursive: true });
    await fs.writeFile(`${HOME}/mine/expenses/app.json`, JSON.stringify(TABLE));
    expect((await app('install mine/expenses')).exitCode).toBe(0);
    await fs.mkdir(`${DATA}/in/s/1`, { recursive: true });
    await fs.writeFile(`${DATA}/expenses.csv`, 'What,Amount\nTrain,42.5\nLunch,18\n');
    await fs.writeFile(`${DATA}/.toolchains`, 'package:jq\n');
    await fs.writeFile(`${DATA}/in/s/1/scratch.txt`, 'an input of this session');
  });
  afterEach(() => { resetApps(); configureApps(null); setInstallConfirm(null); setReplaceConfirm(null); setTabJsSource(null); setTabJsSource(null, 'page.js'); });

  it('the file is a zip: a header, the app\'s files, its data; nothing that is not data', async () => {
    const installed = (await findInstalled(fs, 'expenses'))!;
    const exp = await exportApp(fs, installed, HOME, true, at(2026, 10, 13, 9, 5));
    expect(exp.name).toBe('expenses-2026-10-13.app.zip');
    expect(exp).toMatchObject({ appFiles: 1, dataFiles: 1 });
    expect(readZip(exp.bytes)!.map((m) => m.name)).toEqual([EXPORT_HEADER, 'app/app.json', 'data/expenses.csv']);
    expect(looksLikeExport(exp.bytes)).toBe(true);
    const back = await readExport(exp.bytes);
    expect(back.header).toEqual({ format: 1, id: 'expenses', name: 'Expenses', version: '', source: `dir:${HOME}/mine/expenses`, exported: new Date(at(2026, 10, 13, 9, 5)).toISOString() });
    expect(text(back.app.get('app.json')!)).toBe(JSON.stringify(TABLE));
    expect(text(back.data.get('expenses.csv')!)).toBe('What,Amount\nTrain,42.5\nLunch,18\n');
    expect(back.exportedAt).toBe(at(2026, 10, 13, 9, 5));
    // an app with a page of its own keeps folders named in/ and out/: they are its data
    expect((await dataFiles(fs, HOME, 'expenses', false)).map((f) => f.rel)).toEqual(['expenses.csv', 'in/s/1/scratch.txt']);
  });

  it('app export ID FILE writes it here; app export ID hands it to the browser\'s download', async () => {
    const here = await app('export expenses backups/mine');
    expect(here.exitCode, here.output).toBe(0);
    expect(here.output).toMatch(/^Exported Expenses with its data to ~\/backups\/mine\.app\.zip: 1 file of the app, 1 file of data, \d+ KB\.\nTo bring it back, here or on another computer: app import ~\/backups\/mine\.app\.zip, or drop the file on the desktop\.\n$/);
    expect(looksLikeExport((await fs.readFile(`${HOME}/backups/mine.app.zip`)) as Uint8Array)).toBe(true);
    expect(downloads).toEqual([]);
    // into a folder: under the export's own name
    await fs.mkdir(`${HOME}/backups/all`, { recursive: true });
    expect((await app('export expenses backups/all')).output).toMatch(/to ~\/backups\/all\/expenses-\d{4}-\d\d-\d\d\.app\.zip:/);
    const down = await app('export expenses');
    expect(down.output).toMatch(/^Exported Expenses with its data to your downloads, as expenses-\d{4}-\d\d-\d\d\.app\.zip:/);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ type: 'application/zip' });
    expect(looksLikeExport(downloads[0].bytes)).toBe(true);
    expect((await app('export nosuch')).output).toMatch(/app: no app named nosuch is installed/);
    expect((await app('export')).exitCode).toBe(2);
  });

  it('app import on another computer: asks before installing, then the app and its data are there', async () => {
    expect((await app('export expenses backups/e')).exitCode).toBe(0);
    // another computer: nothing of the app is here
    expect((await app('remove expenses --data')).exitCode).toBe(0);
    await fs.rm('/var/lib/tabcomputer/app-backups.json').catch(() => {});
    installAnswer = 'cancel';
    const no = await app('import backups/e.app.zip');
    expect(no.exitCode).toBe(1);
    expect(no.output).toBe('Cancelled: nothing was changed.\n');
    expect(await findInstalled(fs, 'expenses')).toBeNull();
    expect(await fs.exists(DATA)).toBe(false);
    // the prompt showed the app in the file, said it is from that file, and offered no guest
    expect(installAsked).toHaveLength(1);
    expect(installAsked[0]).toMatchObject({ from: 'the file e.app.zip', guests: false, manifestText: JSON.stringify(TABLE) });
    installAnswer = 'install';
    const yes = await app('import backups/e.app.zip');
    expect(yes.exitCode, yes.output).toBe(0);
    expect(yes.output).toBe('Installed Expenses (expenses) and restored its data (1 file).\nOpen it: app open expenses\n');
    expect((await findInstalled(fs, 'expenses'))!.source).toMatch(/^file:[0-9a-f]{16}$/);
    expect(text((await fs.readFile(`${DATA}/expenses.csv`)) as Uint8Array)).toBe('What,Amount\nTrain,42.5\nLunch,18\n');
    // nothing was there to replace, so nothing was asked about data; and the data is in a file now
    expect(replaceAsked).toEqual([]);
    expect(await backupMark(fs, HOME, 'expenses', true)).toBe('');
  });

  it('importing over other data asks first and says what would be replaced; Cancel changes nothing', async () => {
    const exp = await exportApp(fs, (await findInstalled(fs, 'expenses'))!, HOME, true, at(2026, 10, 3));
    await fs.mkdir(`${HOME}/backups`, { recursive: true });
    await fs.writeFile(`${HOME}/backups/old.app.zip`, exp.bytes);
    // since then: another row, and a second file
    await fs.writeFile(`${DATA}/expenses.csv`, 'What,Amount\nTrain,42.5\nLunch,18\nStamps,3\n');
    await fs.writeFile(`${DATA}/notes.txt`, 'mine');
    replaceAnswer = false;
    const no = await app('import backups/old.app.zip');
    expect(no.exitCode).toBe(1);
    expect(no.output).toBe('Cancelled: nothing was changed.\n');
    expect(text((await fs.readFile(`${DATA}/expenses.csv`)) as Uint8Array)).toContain('Stamps');
    expect(await fs.exists(`${DATA}/notes.txt`)).toBe(true);
    // the same app is installed: no install prompt, only the question about the data
    expect(installAsked).toEqual([]);
    expect(replaceAsked).toHaveLength(1);
    expect(replaceAsked[0]).toMatchObject({ name: 'Expenses', files: 1, exportedAt: at(2026, 10, 3) });
    expect(replaceAsked[0].replaced.map((f) => f.rel).sort()).toEqual(['expenses.csv', 'notes.txt']);
    replaceAnswer = true;
    const yes = await app('import backups/old.app.zip');
    expect(yes.output).toBe('Kept Expenses (expenses) and restored its data (1 file).\nOpen it: app open expenses\n');
    expect(text((await fs.readFile(`${DATA}/expenses.csv`)) as Uint8Array)).toBe('What,Amount\nTrain,42.5\nLunch,18\n');
    // the data is what the file holds: a file only this computer had is gone, what is not data stays
    expect(await fs.exists(`${DATA}/notes.txt`)).toBe(false);
    expect(await fs.exists(`${DATA}/.toolchains`)).toBe(true);
    // the same file again: the data is already that, so nothing is asked
    replaceAsked = [];
    expect((await app('import backups/old.app.zip')).exitCode).toBe(0);
    expect(replaceAsked).toEqual([]);
  });

  it('what the question says: the app, what the file holds, each file that would be replaced and when it changed', () => {
    const now = at(2026, 10, 13, 15, 0);
    const info: ReplaceInfo = { name: 'Expenses', files: 2, exportedAt: at(2026, 10, 3), now, replaced: [{ rel: 'expenses.csv', mtime: at(2026, 10, 13, 14, 5) }, { rel: 'notes/a.txt', mtime: at(2026, 10, 11) }] };
    expect(replaceWords(info)).toEqual({
      title: 'Replace the data Expenses has here?',
      says: 'The file holds 2 files of data, exported on 3 October. Importing it replaces what Expenses has here:',
      lines: ['expenses.csv, changed today at 14:05', 'notes/a.txt, changed on Sunday'],
      more: '',
    });
    const many = replaceWords({ ...info, files: 0, exportedAt: 0, replaced: Array.from({ length: 9 }, (_, i) => ({ rel: `f${i}`, mtime: now })) });
    expect(many.says).toBe('The file holds no data. Importing it replaces what Expenses has here:');
    expect(many.lines).toHaveLength(6);
    expect(many.more).toBe('and 3 more files');
    // two buttons, Cancel first; Replace is off for the first moment and only a person's click counts
    const answers: boolean[] = [];
    const root = buildReplacePrompt({ ...info, replaced: [{ rel: '<b>x</b>.csv', mtime: now }] }, (yes) => answers.push(yes));
    expect([...root.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Replace']);
    expect(root.querySelectorAll('b')).toHaveLength(0);
    expect(root.querySelector('li')!.textContent).toBe('<b>x</b>.csv, changed today at 15:00');
    (root.querySelectorAll('button')[1] as unknown as { click(): void }).click();
    expect(answers).toEqual([]);
    (root.querySelectorAll('button')[0] as unknown as { click(): void }).click();
    expect(answers).toEqual([false]);
  });

  it('refuses a file that is not an export, or holds a path that is not plain', async () => {
    const head = (over: Record<string, unknown> = {}) => ({ name: EXPORT_HEADER, bytes: new TextEncoder().encode(JSON.stringify({ format: 1, id: 'expenses', name: 'Expenses', version: '', source: 'dir:/x', exported: '2026-10-03T10:00:00.000Z', ...over })) });
    const manifest = { name: 'app/app.json', bytes: new TextEncoder().encode(JSON.stringify(TABLE)) };
    expect(await message(readExport(new TextEncoder().encode('not a zip')))).toBe('the file is not an app exported from tabcomputer');
    expect(await message(readExport(await zipFiles([manifest])))).toBe('the file is not an app exported from tabcomputer');
    expect(await message(readExport(await zipFiles([head({ format: 2 }), manifest])))).toBe('the file was made by a newer tabcomputer than this one');
    expect(await message(readExport(await zipFiles([head({ id: '../x' }), manifest])))).toBe('the file is not an app exported from tabcomputer');
    expect(await message(readExport(await zipFiles([head()])))).toBe('the file holds no app.json: it is not an app');
    for (const bad of ['data/../../.ssh/authorized_keys', 'data//x', 'data/a/./b', 'elsewhere/x', 'data/a\\b', '/etc/passwd', 'data/a\nb']) {
      expect(await message(readExport(await zipFiles([head(), manifest, { name: bad, bytes: new Uint8Array([1]) }]))), bad).toMatch(/not a plain path/);
    }
    // a file that says it is this site's app does not get its own files installed without a question
    const fake = await zipFiles([head({ source: 'site' }), { name: 'app/app.json', bytes: new TextEncoder().encode(JSON.stringify({ name: 'Expenses', run: 'sh -c {in}' })) }]);
    await fs.rm(`${HOME}/Apps/expenses`, { recursive: true });
    installAnswer = 'cancel';
    expect(await importApp(fake, 'fake.app.zip')).toBeNull();
    expect(installAsked).toHaveLength(1);
    expect(installAsked[0].manifest.run).toBe('sh -c {in}');
    // the header names one app and the files are another's
    const other = await zipFiles([head({ id: 'other-app' }), { name: 'app/app.json', bytes: new TextEncoder().encode(JSON.stringify({ ...TABLE, id: 'expenses' })) }]);
    expect(await message(importApp(other, 'x.app.zip'))).toBe('the file names one app and holds another');
    // what programs are installed is never a file's to say
    const marked = await readExport(await zipFiles([head(), manifest, { name: 'data/.toolchains', bytes: new TextEncoder().encode('package:everything\n') }]));
    expect([...marked.data.keys()]).toEqual([]);
  });

  it('the mark: nothing without data, "Not backed up" until the first export, then only when the data changed since', async () => {
    const now = at(2026, 10, 13, 15, 0);
    expect(await backupMark(fs, HOME, 'expenses', true, now)).toBe('Not backed up');
    // an app that was only opened has no data, so it says nothing
    await fs.rm(`${DATA}/expenses.csv`);
    expect(await backupMark(fs, HOME, 'expenses', true, now)).toBe('');
    await fs.writeFile(`${DATA}/expenses.csv`, 'What,Amount\n');
    // exported: nothing to say
    expect((await app('export expenses backups/now')).exitCode).toBe(0);
    expect(await backupMark(fs, HOME, 'expenses', true)).toBe('');
    // the last export was on a day, and the data changed after it
    await noteExported(fs, 'expenses', at(2026, 10, 6, 10, 0));
    expect(await backupMark(fs, HOME, 'expenses', true, now)).toBe('Not backed up since 6 October');
    await noteExported(fs, 'expenses', at(2026, 10, 9, 10, 0));
    expect(await backupMark(fs, HOME, 'expenses', true, now)).toBe('Not backed up since Friday');
    // a supplied page's inputs and results of this session are not data
    await noteExported(fs, 'expenses', Date.now() + 1000);
    await fs.writeFile(`${DATA}/in/s/1/more.txt`, 'x');
    expect(await backupMark(fs, HOME, 'expenses', true)).toBe('');
  });

  it('says a moment the way a person does, looking back', () => {
    const now = at(2026, 10, 13, 15, 0);   // a Tuesday
    expect(sinceText(at(2026, 10, 13, 9, 5), now)).toBe('09:05');
    expect(sinceText(at(2026, 10, 12, 23, 59), now)).toBe('Monday');
    expect(sinceText(at(2026, 10, 7), now)).toBe('Wednesday');
    expect(sinceText(at(2026, 10, 6), now)).toBe('6 October');
    expect(sinceText(at(2025, 12, 24), now)).toBe('24 December 2025');
    expect(whenText(at(2026, 10, 13, 9, 5), now)).toBe('today at 09:05');
    expect(whenText(at(2026, 10, 10), now)).toBe('on Saturday');
    expect(whenText(at(2026, 10, 3), now)).toBe('on 3 October');
  });

  it('a dropped NAME.app.zip is imported and opened; any other file is left alone', async () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const target = { addEventListener: (t: string, cb: (e: unknown) => void) => { listeners.set(t, cb); }, removeEventListener: (t: string) => { listeners.delete(t); } };
    const log: string[] = [];
    const stop = initAppDrop({
      import: async (_bytes, name) => { log.push(`import ${name}`); if (name.startsWith('bad')) throw new Error('the file is not an app exported from tabcomputer'); return name.startsWith('no') ? null : 'expenses'; },
      open: async (id) => { log.push(`open ${id}`); },
      report: (m) => { log.push(m); },
    }, target as never);
    const drop = async (...names: string[]) => {
      let prevented = 0, stopped = 0;
      listeners.get('drop')!({ dataTransfer: { files: names.map((name) => ({ name, arrayBuffer: async () => new ArrayBuffer(4) })) }, preventDefault: () => { prevented++; }, stopPropagation: () => { stopped++; } });
      await new Promise((r) => setTimeout(r, 5));
      return { prevented, stopped };
    };
    expect(await drop('photo.png', 'notes.zip')).toEqual({ prevented: 0, stopped: 0 });
    expect(log).toEqual([]);
    expect(await drop('Expenses-2026-10-13.APP.ZIP')).toEqual({ prevented: 1, stopped: 1 });
    expect(log).toEqual(['import Expenses-2026-10-13.APP.ZIP', 'open expenses']);
    log.length = 0;
    await drop('no.app.zip', 'bad.app.zip');
    expect(log).toEqual(['import no.app.zip', 'import bad.app.zip', 'bad.app.zip was not imported: the file is not an app exported from tabcomputer']);
    // a file may be dropped anywhere: the drag is accepted when it carries files, and only then
    let over = 0;
    listeners.get('dragover')!({ dataTransfer: { types: ['Files'] }, preventDefault: () => { over++; } });
    listeners.get('dragover')!({ dataTransfer: { types: ['text/plain'] }, preventDefault: () => { over++; } });
    expect(over).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});
