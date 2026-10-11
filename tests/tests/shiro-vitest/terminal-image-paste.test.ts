/**
 * An image pasted (Cmd+V: the browser's paste event, which xterm.js reads as
 * text only) or dropped on a terminal is saved to /tmp and its path pasted,
 * bracketed when the program asked for it: Claude Code attaches a pasted
 * image path as [Image #N]. Text pastes stay xterm's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestOS } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import { ShiroTerminal } from '@shiro/terminal';
import { imagesOf } from '@shiro/terminal-file-paste';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);

/** A DataTransfer as a paste or drop event carries it */
function transfer(files: File[], text = ''): DataTransfer {
  return {
    files: files as unknown as FileList,
    items: files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f })) as unknown as DataTransferItemList,
    types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
    getData: (t: string) => (t === 'text/plain' ? text : ''),
  } as unknown as DataTransfer;
}

/**
 * (linkedom, the suite's DOM, has no capture phase, so these fire on the
 * container, where the handler listens; that it runs before xterm's own
 * paste handler in a browser is tests/browser/image-paste.mjs's)
 */
function fire(target: EventTarget, type: string, data: DataTransfer): Event {
  const e = new (window as any).Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  target.dispatchEvent(e);
  return e;
}

let fs: FileSystem;
let terminal: ShiroTerminal;
let sent: string[];
const container = () => terminal.term.element!.parentElement!;

beforeEach(async () => {
  ({ fs, terminal } = await createTestOS());
  sent = [];
  // What reaches the program (or the line editor)
  terminal.term.onData((d) => sent.push(d));
});

const listTmp = async (prefix: string) => ((await fs.readdir('/tmp')) as string[]).filter((n) => n.startsWith(prefix)).sort();

describe('pasting an image', () => {
  it('saves it to /tmp and pastes its path, bracketed when the program asked', async () => {
    await new Promise<void>((r) => terminal.term.write('\x1b[?2004h', r)); // (Claude Code turns bracketed paste on)
    const e = fire(container(), 'paste', transfer([new File([PNG], 'image.png', { type: 'image/png' })]));
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const m = /^\x1b\[200~(\/tmp\/paste-\d{8}-\d{6}\.png)\x1b\[201~$/.exec(sent[0]);
    expect(m, JSON.stringify(sent[0])).not.toBeNull();
    expect([...(await fs.readFile(m![1])) as Uint8Array]).toEqual([...PNG]);
  });

  it('keeps the type; several images are several paths; plain without bracketed paste', async () => {
    fire(container(), 'paste', transfer([
      new File([PNG], 'a.jpg', { type: 'image/jpeg' }), new File([PNG], 'b.jpg', { type: 'image/jpeg' }),
    ]));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    const paths = sent[0].split(' ');
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(p).toMatch(/^\/tmp\/paste-\d{8}-\d{6}(-2)?\.jpg$/);
    expect(new Set(paths).size).toBe(2);
  });

  it('a paste with text stays text (xterm pastes it); a Finder copy (the file and its name) is the file', () => {
    const img = new File([PNG], 'shot.png', { type: 'image/png' });
    expect(imagesOf(transfer([img], 'some words'), 'paste')).toHaveLength(0);
    expect(imagesOf(transfer([img], 'shot.png'), 'paste')).toHaveLength(1);
    expect(imagesOf(transfer([new File(['x'], 'notes.txt', { type: 'text/plain' })]), 'paste')).toHaveLength(0);
    expect(imagesOf(transfer([], 'just text'), 'paste')).toHaveLength(0);
    const e = fire(container(), 'paste', transfer([img], 'some words'));
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('dropping an image', () => {
  it('saves it under its name and pastes the path', async () => {
    const e = fire(container(), 'drop', transfer([new File([PNG], 'My Photo (1).png', { type: 'image/png' })]));
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatch(/^\/tmp\/drop-\d{8}-\d{6}-My_Photo_1_\.png$/);
    expect([...(await fs.readFile(sent[0])) as Uint8Array]).toEqual([...PNG]);
  });

  it('a drop claimDrop takes (a snapshot GIF) is left to it', async () => {
    const seen: string[] = [];
    ShiroTerminal.claimDrop = async (files) => { seen.push(...files.map((f) => f.name)); return true; };
    try {
      fire(container(), 'drop', transfer([new File([PNG], 'seed.gif', { type: 'image/gif' })]));
      await vi.waitFor(() => expect(seen).toEqual(['seed.gif']));
      await new Promise((r) => setTimeout(r, 20));
      expect(sent).toEqual([]);
      expect((await listTmp('drop-')).filter((n) => n.includes('seed'))).toEqual([]);
    } finally {
      ShiroTerminal.claimDrop = undefined;
    }
  });
});
