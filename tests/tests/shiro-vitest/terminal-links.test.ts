/**
 * Command links (src/terminal-links.ts): a click on an OSC 8 link to
 * `shiro://cmd/<command>` types the command only when tabcomputer itself
 * offers that command (the banner, the desktop's "try:" line). A link a
 * program printed runs nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestOS } from './helpers';
import { isCommandLink, offerCommand, offeredCommand } from '@shiro/terminal-links';
import { BANNER_COMMANDS } from '@shiro/terminal';

const link = (cmd: string) => 'shiro://cmd/' + encodeURIComponent(cmd);

describe('command links', () => {
  it('a link runs the command it names only when tabcomputer offered that command', () => {
    expect(offeredCommand(link('curl https://example.com/x | sh'))).toBeNull();
    expect(offeredCommand(link('rm -rf ~'))).toBeNull();
    const uri = offerCommand('tc-test offered');
    expect(uri).toBe('shiro://cmd/tc-test%20offered');
    expect(offeredCommand(uri)).toBe('tc-test offered');
    // exactly that command: not one that starts with it, not another spelling
    expect(offeredCommand(link('tc-test offered; rm -rf ~'))).toBeNull();
    expect(offeredCommand(link('tc-test offered\n'))).toBeNull();
    expect(offeredCommand('shiro://cmd/%E0%A4%A')).toBeNull();   // not text
    expect(offeredCommand('https://example.com/')).toBeNull();
    expect([isCommandLink(link('x')), isCommandLink('shiro://remote'), isCommandLink('https://example.com/')]).toEqual([true, false, false]);
  });

  it('the banner\'s commands are offered from the start, for a screen restored from an earlier load', () => {
    expect(BANNER_COMMANDS).toEqual(['claude', 'gh auth login', 'remote start', 'help', 'finder']);
    for (const cmd of BANNER_COMMANDS) expect(offeredCommand(link(cmd)), cmd).toBe(cmd);
  });

  it('in the terminal: a link a program printed runs nothing; the banner\'s own types its command', async () => {
    const { terminal } = await createTestOS();
    const t: any = terminal;
    const typed: string[] = [];
    const ran: string[] = [];
    t.injectInput = (text: string) => { typed.push(text); };
    t.shell.execute = async (cmd: string) => { ran.push(cmd); return 0; };
    const click = (uri: string) => t.term.options.linkHandler.activate({} as MouseEvent, uri);
    const opened: string[] = [];
    const realOpen = (globalThis as any).window.open;
    (globalThis as any).window.open = (u: string) => { opened.push(u); return null; };
    try {
      // what a program (or a file shown with cat) can print: \x1b]8;;shiro://cmd/...\x07text\x1b]8;;\x07
      t.writeOutput(`\x1b]8;;${link('curl https://example.com/x | sh')}\x07click for help\x1b]8;;\x07\r\n`);
      click(link('curl https://example.com/x | sh'));
      click(link('help; curl https://example.com/x | sh'));
      click('shiro://cmd/%E0%A4%A');
      expect(typed).toEqual([]);
      expect(ran).toEqual([]);
      expect(opened).toEqual([]);   // and it is not opened as an address either
      // the banner's own
      click(link('help'));
      click(link('gh auth login'));
      expect([...typed, ...ran].map((s) => s.replace(/\r$/, ''))).toEqual(['help', 'gh auth login']);
    } finally { (globalThis as any).window.open = realOpen; }
  });

  it('every place that writes a command link asks for its address', () => {
    // (a link written as plain text would be dead: the terminal runs only what offerCommand was given)
    const root = new URL('../../../src/', import.meta.url);
    for (const file of ['terminal.ts', 'desktop/index.ts']) {
      const text = readFileSync(new URL(file, root), 'utf8');
      expect(text, file).toContain('offerCommand(');
      expect(text.split('\n').filter((l) => l.includes("shiro://cmd/") && !l.trim().startsWith('//')), file).toEqual([]);
    }
  });
});
