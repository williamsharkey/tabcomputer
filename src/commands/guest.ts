/**
 * guest: open a guest, or say what this one is (src/guest.ts,
 * docs/research/GUEST_PROFILE.md). A guest is tabcomputer on another origin
 * of the browser, for a repository, an archive or an agent you don't trust
 * with your own files and sign-ins.
 */
import type { Command } from './index';
import {
  cleanGuestName, currentBoundaryStatement, discardGuest, guestConfig, guestInfo, guestUrl, keptGuests, openGuest,
} from '../guest';

const USAGE = `Usage: guest                                   what this window is
       guest open [--no-network] [--keep NAME]  open a guest in a new tab
       guest url  [--no-network] [--keep NAME]  print its address instead
       guest list                               guests kept under a name
       guest discard --yes                      in a guest: delete everything it stores
`;

export const guestCmd: Command = {
  name: 'guest',
  description: 'A clean, separate tabcomputer for untrusted work: open one, or see what this one can reach',
  async exec(ctx) {
    const sub = ctx.args[0] ?? 'status';
    const out = (s: string) => { ctx.stdout += s + '\n'; };
    const here = guestInfo();
    switch (sub) {
      case 'status': {
        const st = await currentBoundaryStatement();
        if (st) { out(`${st.title} (${here!.ephemeral ? 'thrown away' : `kept as "${here!.name}"`})`); for (const l of st.lines) out(`  ${l}`); return 0; }
        const cfg = await guestConfig();
        out('This is not a guest: programs here can read your files and sign-ins.');
        out(cfg.origin ? 'Open a guest for untrusted work: guest open [--no-network] [--keep NAME]' : 'This server has no guests.');
        return 0;
      }
      case 'open':
      case 'url': {
        let noNetwork = false, name = '';
        for (let i = 1; i < ctx.args.length; i++) {
          const a = ctx.args[i];
          if (a === '--no-network') noNetwork = true;
          else if (a === '--keep' && ctx.args[i + 1]) {
            name = cleanGuestName(ctx.args[++i]);
            if (!name) { ctx.stderr += 'guest: a name is letters and digits (up to 32)\n'; return 2; }
          } else { ctx.stderr += USAGE; return 2; }
        }
        if (here) { ctx.stderr += 'guest: this is a guest already; open another from your main tabcomputer\n'; return 1; }
        const cfg = await guestConfig();
        if (!cfg.origin) { ctx.stderr += 'guest: this server has no guests\n'; return 1; }
        if (sub === 'url') { out(guestUrl(cfg.origin, { name, noNetwork })); return 0; }
        // The browser may block a new tab that no click asked for: the address is printed too
        const url = await openGuest({ name, noNetwork });
        out(`${name ? `Guest "${name}"` : 'A thrown-away guest'}${noNetwork ? ', no network' : ''}: ${url}`);
        return 0;
      }
      case 'list': {
        const list = keptGuests();
        if (!list.length) { out('No guests kept under a name were opened from here.'); return 0; }
        for (const g of list) out(`${g.name}${g.noNetwork ? '  (no network)' : ''}`);
        return 0;
      }
      case 'discard': {
        if (!here) { ctx.stderr += 'guest: this is not a guest; nothing is deleted\n'; return 1; }
        if (ctx.args[1] !== '--yes') { ctx.stderr += 'guest: this deletes everything stored in this guest. Run: guest discard --yes\n'; return 1; }
        discardGuest();
        return 0;
      }
      case '-h': case '--help': case 'help':
        ctx.stdout += USAGE;
        return 0;
      default:
        ctx.stderr += USAGE;
        return 2;
    }
  },
};
