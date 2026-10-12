/**
 * tabcomputer#110: `upload --help` opened the browser's file picker (it took
 * --help for the target directory), and `help` didn't mention download,
 * upload or zip. Both commands print usage for -h/--help, download hands
 * over a file's bytes unchanged (a zip), and help has a "Save your work"
 * section.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { uploadCmd, downloadCmd } from '@shiro/commands/upload';

const sh = async (shell: any, cmd: string) => {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s: string) => { out += s; }, (s: string) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
};

async function shellWithTransfer() {
  const t = await createTestShell();
  (t.shell as any).commands.register(uploadCmd);
  (t.shell as any).commands.register(downloadCmd);
  return t;
}

/** A stand-in page: counts the elements commands make, keeps what a download link was given */
function fakePage() {
  const made: string[] = [];
  const blobs: Blob[] = [];
  const saved: string[] = [];
  const g = globalThis as any;
  const before = { document: g.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  g.document = {
    createElement(tag: string) {
      made.push(tag);
      const el: any = { style: {}, addEventListener() {}, click() { if (tag === 'a') saved.push(el.download); } };
      return el;
    },
    body: { appendChild() {}, removeChild() {}, contains: () => false },
  };
  URL.createObjectURL = ((b: Blob) => { blobs.push(b); return 'blob:test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  return {
    made, blobs, saved,
    restore() {
      if (before.document === undefined) delete g.document; else g.document = before.document;
      URL.createObjectURL = before.create;
      URL.revokeObjectURL = before.revoke;
    },
  };
}

describe('upload and download (#110)', () => {
  let page: ReturnType<typeof fakePage> | undefined;
  afterEach(() => { page?.restore(); page = undefined; });

  it('-h and --help print usage and open nothing', async () => {
    const { shell } = await shellWithTransfer();
    page = fakePage();
    for (const flag of ['--help', '-h']) {
      const up = await sh(shell, `upload ${flag}`);
      expect(up).toMatchObject({ code: 0, err: '' });
      expect(up.out).toMatch(/^Usage: upload \[DIR\]\n/);
      const down = await sh(shell, `download ${flag}`);
      expect(down).toMatchObject({ code: 0, err: '' });
      expect(down.out).toMatch(/^Usage: download \[FILE\]\.\.\.\n/);
      expect(down.out).toContain('zip -r');
    }
    expect(page.made).toEqual([]); // no <input type=file>, no dialog, no link
  });

  it('download saves the bytes as they are (a zip of a folder)', async () => {
    const { shell, fs } = await shellWithTransfer();
    await fs.mkdir('/tmp/work/src', { recursive: true });
    await fs.writeFile('/tmp/work/src/a.txt', 'hello\n');
    expect((await sh(shell, 'cd /tmp && zip -qr work.zip work')).code).toBe(0);
    const bytes = await fs.readFile('/tmp/work.zip') as Uint8Array;
    page = fakePage();
    const r = await sh(shell, 'cd /tmp && download work.zip');
    expect(r).toMatchObject({ code: 0, out: 'Downloaded: work.zip\n' });
    expect(page.saved).toEqual(['work.zip']);
    expect(new Uint8Array(await page.blobs[0].arrayBuffer())).toEqual(new Uint8Array(bytes));
    expect((await sh(shell, 'download /tmp/no-such-file')).code).toBe(1);
  });
});

describe('help (#110)', () => {
  it('says how to save your work: download, zip, upload', async () => {
    const { shell } = await createTestShell();
    const { code, out } = await sh(shell, 'help');
    expect(code).toBe(0);
    const section = out.slice(out.indexOf('Save your work'));
    expect(out).toContain('Save your work');
    expect(section).toMatch(/^ {2}download FILE /m);
    expect(section).toMatch(/^ {2}zip -r work\.zip DIR /m);
    expect(section).toMatch(/^ {2}upload \[DIR\] /m);
  });
});
