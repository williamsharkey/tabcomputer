/**
 * lab: a class repository as a workspace (docs/CLASSROOM.md).
 *
 *   lab open OWNER/REPO   sign in if the repository is private, clone it, install the
 *                         toolchains its config names, open the Code app on it
 *                         (what a lab link, ?run=lab:OWNER/REPO, runs)
 *   lab run | lab test    the config's run / test command, here
 *   lab submit            git add -A, commit, push; the result in plain words
 *   lab status            whether GitHub has this work
 *   lab check             read .tabcomputer/lab.json and say what is wrong with it
 */
import type { Command, CommandContext } from './index';
import { GH_OWNER, GH_REPO, labFolder, shq } from '../run-url';
import { GITHUB_TOKEN_STORAGE_KEY } from '../credentials';
import { LAB_CONFIG_PATH, SAVED_TEXT, UNSAVED_TEXT, labState, readLabConfig, submitLab, unsavedReason } from '../lab';

const USAGE = `usage: lab open OWNER/REPO
       lab run | test | submit | status | check
`;

function token(ctx: CommandContext): string {
  if (ctx.env['GITHUB_TOKEN'] || ctx.env['GH_TOKEN']) return ctx.env['GITHUB_TOKEN'] || ctx.env['GH_TOKEN'];
  try { return localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) || ''; } catch { return ''; }
}

/** The parts of the desktop `lab open` uses (src/desktop/wm.ts) */
interface Win {
  appId?: string; kind?: string; codeDir?: string; content?: { terminals?(): unknown[] };
  focus(): void; snap?(side: 'left' | 'right'): void;
}
interface Desk { windows(): Win[]; compact?: boolean }

export const labCmd: Command = {
  name: 'lab',
  description: 'Class repositories: open one, run it, test it, submit it',
  async exec(ctx) {
    // On a terminal each line appears as it is said: the commands this runs (git, gh) write there
    // directly, and a line kept for the end would come after the sign-in it announces
    const now = (s: string) => { if (!ctx.terminal) return false; ctx.terminal.writeOutput(s.replace(/\r?\n/g, '\r\n')); return true; };
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else if (!now(s)) ctx.stdout += s; };
    const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else if (!now(s)) ctx.stderr += s; };
    /** A line in this shell, on this terminal (its `cd` stays) */
    const sh = (line: string) => ctx.shell.execute(line, out, err, false, ctx.terminal, true);
    const home = ctx.env['HOME'] || '/home/user';
    const tilde = (p: string) => (p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
    const [sub, ...rest] = ctx.args;

    if (sub === 'open') {
      const m = /^(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(rest[0] ?? '');
      if (!m || !GH_OWNER.test(m[1]) || !GH_REPO.test(m[2]) || m[2].startsWith('.')) { err('lab: name the repository as OWNER/REPO\n'); return 2; }
      const [, owner, repo] = m;
      const full = `${owner}/${repo}`;
      let where: { dir: string; cloned: boolean };
      try { where = await labFolder(ctx.fs, home, owner, repo); } catch (e) { err(`lab: ${(e as Error).message}\n`); return 1; }
      const { dir } = where;
      if (!where.cloned) {
        const clone = async () => {
          await ctx.fs.mkdir(dir.slice(0, dir.lastIndexOf('/')), { recursive: true });
          const code = await sh(`builtin git clone -- ${shq(`https://github.com/${full}`)} ${shq(dir)}`);
          if (code === 0 && await ctx.fs.exists(`${dir}/.git`).catch(() => false)) return true;
          // What a failed clone left is not the student's work: the folder did not exist before
          await sh(`rm -rf -- ${shq(dir)}`);
          return false;
        };
        out(`Copying ${full} from GitHub to ${tilde(dir)}.\n`);
        let ok = await clone();
        if (!ok && !token(ctx)) {
          out(`GitHub did not give ${full} to a tab that is not signed in: the repository is private, or the name is wrong.\nSign in to GitHub to go on.\n`);
          const code = await sh('gh auth login');
          if (code !== 0 || !token(ctx)) { err(`lab: not signed in to GitHub, so ${full} was not opened. Open the link again to retry.\n`); return 1; }
          ok = await clone();
        }
        if (!ok) {
          err(`lab: GitHub did not let this account copy ${full}. Check the name, and ask the teacher whether this account has access.\n`);
          return 1;
        }
      }
      const lab = await readLabConfig(ctx.fs, dir);
      if (!lab) out(`${full} has no ${LAB_CONFIG_PATH}, so the Code app shows no Run, Test or Submit buttons for it.\n`);
      else if (!lab.config) err(lab.problems.map((p) => `lab: ${p}\n`).join(''));
      for (const set of lab?.config?.toolchains ?? []) {
        let installed = false;
        try {
          const { listToolchains } = await import('./toolchain');
          const entry = (await listToolchains(ctx.fs)).find((t) => t.id === set);
          if (!entry) { err(`lab: ${LAB_CONFIG_PATH} names the toolchain ${set}, which this computer does not have (toolchain list shows them).\n`); continue; }
          installed = entry.installed;
        } catch { /* the list could not be read: let toolchain install say why */ }
        if (installed) continue;
        out(`Installing the ${set} toolchain, which ${LAB_CONFIG_PATH} names.\n`);
        if (await sh(`toolchain install ${set}`) !== 0) err(`lab: the ${set} toolchain did not install. Run "toolchain install ${set}" to try again.\n`);
      }
      await sh(`cd ${shq(dir)}`);
      const desk = (globalThis as { __shiroDesktop?: Desk }).__shiroDesktop;
      const editor = desk?.windows().find((w) => w.appId === 'code' && w.codeDir === dir);
      if (editor) editor.focus();
      else {
        // (from inside the folder: the window is named after it and shows paths relative to it)
        await sh('code .');
        // The editor beside its Terminal (not on a phone, where every window fills the screen)
        const mine = desk?.windows().find((w) => w.kind === 'terminal' && !!ctx.terminal && !!w.content?.terminals?.().includes(ctx.terminal));
        const opened = desk?.windows().find((w) => w.appId === 'code' && w.codeDir === dir);
        if (desk && !desk.compact && mine && opened) { opened.snap?.('left'); mine.snap?.('right'); }
      }
      // The lab's notebook, in the Notebook app (docs/NOTEBOOK.md), in front of the editor
      let notebookNote = '';
      const notebook = lab?.config?.notebook;
      if (notebook && lab) {
        const path = `${lab.dir}/${notebook}`;
        if (!(await ctx.fs.exists(path).catch(() => false))) err(`lab: ${LAB_CONFIG_PATH} names the notebook ${notebook}, which is not in the repository.\n`);
        else if (desk && await sh(`jupyter notebook ${shq(path)}`) === 0) notebookNote = ` The notebook ${notebook} is open in the Notebook app.`;
        else if (!desk) notebookNote = ` Run the notebook with: jupyter execute ${notebook}`;
      }
      out(`${full} is open in ${tilde(dir)}.${lab?.config ? ' Run, Test and Submit are at the top of the Code app. Submit sends the work to GitHub.' : ''}${notebookNote}\n`);
      return 0;
    }

    if (sub === 'run' || sub === 'test' || sub === 'check') {
      const lab = await readLabConfig(ctx.fs, ctx.cwd);
      if (!lab) { err(`lab: this folder has no ${LAB_CONFIG_PATH}\n`); return 1; }
      if (!lab.config) { err(lab.problems.map((p) => `lab: ${p}\n`).join('')); return 1; }
      if (sub === 'check') {
        out(`${tilde(lab.dir)}/${LAB_CONFIG_PATH} is valid.\n  toolchains: ${lab.config.toolchains.join(', ') || 'none'}\n  run: ${lab.config.run || 'none'}\n  test: ${lab.config.test || 'none'}\n`);
        return 0;
      }
      const command = sub === 'run' ? lab.config.run : lab.config.test;
      if (!command) { err(`lab: ${LAB_CONFIG_PATH} names no ${sub} command\n`); return 1; }
      // In a subshell, so the command's own cd does not move this shell
      return sh(`( cd ${shq(lab.dir)} && ${command} )`);
    }

    if (sub === 'submit') {
      const fork = ctx.shell.fork();
      const result = await submitLab(ctx.fs, ctx.cwd, {
        run: async (line) => {
          const s = await labState(ctx.fs, ctx.cwd);
          fork.cwd = s?.root ?? ctx.cwd;
          let text = '';
          const code = await fork.execute(line, (t) => { text += t; }, (t) => { text += t; });
          return { code, out: text };
        },
      });
      (result.ok ? out : err)(result.text + '\n');
      return result.ok ? 0 : 1;
    }

    if (sub === 'status') {
      const s = await labState(ctx.fs, ctx.cwd);
      if (!s) { err('lab: this folder is not in a git repository\n'); return 1; }
      if (!s.remote) { out('This repository has no GitHub address (no origin remote on github.com).\n'); return 0; }
      out(s.unsaved ? `${UNSAVED_TEXT}: ${unsavedReason(s)} (github.com/${s.remote}).\n` : `${SAVED_TEXT}: github.com/${s.remote}, branch ${s.branch ?? ''}, commit ${s.head}.\n`);
      return s.unsaved ? 1 : 0;
    }

    (sub && sub !== 'help' && sub !== '--help' ? err : out)(USAGE);
    return sub && sub !== 'help' && sub !== '--help' ? 2 : 0;
  },
};
