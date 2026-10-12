/**
 * dataflow: how data leaves this tab, and what the site's server can read of
 * it, for this tab as it is now (src/data-flow.ts, docs/DATA_FLOW.md). The
 * desktop shows the same as a window (System → How Your Data Flows); this is
 * the text version, and the only one in the terminal UI.
 */
import type { Command } from './index';
import { currentDataFlowState, dataFlowText } from '../data-flow';

const USAGE = `Usage: dataflow           where this tab's files, sign-ins and traffic go
       dataflow --json    the state it is drawn from (presence of sign-ins only, never a value)
`;

export const dataflowCmd: Command = {
  name: 'dataflow',
  description: 'How your data flows: what leaves this tab, by which path, and what the server can read',
  async exec(ctx) {
    const arg = ctx.args[0];
    if (arg === '-h' || arg === '--help' || arg === 'help') { ctx.stdout = USAGE; return 0; }
    if (arg && arg !== '--json') { ctx.stderr = USAGE; return 2; }
    const state = await currentDataFlowState(ctx.fs);
    if (arg === '--json') { ctx.stdout = JSON.stringify(state, null, 2) + '\n'; return 0; }
    const cols = Number(ctx.env.COLUMNS) || (ctx.stdoutIsTTY !== false ? ctx.terminal?.getSize?.().cols : 0) || 80;
    ctx.stdout = dataFlowText(state, cols);
    return 0;
  },
};
