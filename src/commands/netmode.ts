/**
 * netmode: choose whether this site's server may make requests for the page
 * (net-mode.ts, docs/NETWORKING.md "Private mode"). Settings → Network has
 * the same switch.
 */
import type { Command } from './index';
import { NETWORK_MODE_ENV, networkMode, setNetworkMode } from '../net-mode';

const USAGE = `Usage: netmode            which mode this tab is in
       netmode private    keep tokens, code and prompts from this site's server
       netmode proxy      let this site's server make those requests (the default)

proxy    git, gh and Claude go through this site's server, which makes the
         request for the page. It is the faster and more dependable way, and
         the server can read what passes.
private  gh and git on github.com call GitHub's API straight from the
         browser. Everything else (GitHub sign-in, other git hosts, Claude and
         other model APIs) is encrypted in this tab and carried by the TCP
         relay, which sees a host name and byte counts. Slower, and voice
         input in Claude is off.

One command the other way: ${NETWORK_MODE_ENV}=proxy git push
dataflow shows what the server can read in the current mode.
`;

const SAY = {
  proxy: "proxy: this site's server makes requests for git, gh and Claude, and can read them.\n",
  private: "private: GitHub's API is called from the browser, the rest is encrypted here and carried by the relay.\n",
};

export const netmodeCmd: Command = {
  name: 'netmode',
  description: "Network mode: proxy (this site's server makes requests) or private (it cannot read them)",
  async exec(ctx) {
    const arg = ctx.args[0];
    if (arg === '-h' || arg === '--help' || arg === 'help') { ctx.stdout = USAGE; return 0; }
    if (arg === undefined) {
      const mode = networkMode(ctx.env);
      ctx.stdout = SAY[mode];
      if (ctx.env[NETWORK_MODE_ENV] && ctx.env[NETWORK_MODE_ENV] !== networkMode()) ctx.stdout += `(from ${NETWORK_MODE_ENV} in this shell; the saved choice is ${networkMode()})\n`;
      return 0;
    }
    if (arg !== 'proxy' && arg !== 'private') { ctx.stderr = USAGE; return 2; }
    setNetworkMode(arg);
    ctx.stdout = SAY[arg];
    if (ctx.env[NETWORK_MODE_ENV] && ctx.env[NETWORK_MODE_ENV] !== arg) ctx.stdout += `(this shell still has ${NETWORK_MODE_ENV}=${ctx.env[NETWORK_MODE_ENV]}, which wins here: unset ${NETWORK_MODE_ENV})\n`;
    return 0;
  },
};
