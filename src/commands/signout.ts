/**
 * signout: sign out of a shared computer (src/sign-out.ts, docs/CLASSROOM.md).
 *
 *   signout          say what would be deleted, and which work GitHub does not have yet
 *   signout --yes    delete it: the sign-ins and every file of this profile, from this browser
 *
 * Settings, Accounts has the same action with the same words.
 */
import type { Command } from './index';
import { signOutLines, signOutOfThisComputer, signOutPlan } from '../sign-out';

export const signoutCmd: Command = {
  name: 'signout',
  description: 'Sign out of a shared computer: remove the sign-ins and every file from this browser',
  async exec(ctx) {
    const yes = ctx.args.includes('--yes') || ctx.args.includes('-y');
    const unknown = ctx.args.filter((a) => a !== '--yes' && a !== '-y');
    if (unknown.length) { ctx.stderr += 'usage: signout [--yes]\n'; return 2; }
    const plan = await signOutPlan(ctx.fs, localStorage, ctx.env['HOME'] || '/home/user');
    ctx.stdout += signOutLines(plan);
    if (!yes) {
      ctx.stdout += '\nNothing was deleted. Run "signout --yes" to do it.\n';
      return plan.unpushed.length ? 1 : 0;
    }
    ctx.stdout += '\nSigning out…\n';
    // After this line is printed: the page is about to be replaced
    setTimeout(() => { void signOutOfThisComputer(ctx.fs); }, 50);
    return 0;
  },
};
