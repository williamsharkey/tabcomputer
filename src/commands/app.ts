/**
 * app: make, try, install and run apps (docs/APPS.md). An app is a folder
 * with an app.json; installed, it has a dock entry and a window of its own.
 *
 *   app new NAME [--template T | --page | --from SCRIPT]   one file, app.json (or a folder with a page)
 *   app dev [DIR]                                 the developer loop: a window, the log, restart on save
 *   app install [DIR | ID | gh:OWNER/REPO[/PATH] | gist:ID | URL]
 *   app open ID [--become]
 *   app share ID                                  a link that gives each person their own copy
 *   app export ID [FILE] | app import FILE        the app with its data, as one file
 *   app list | stop ID | remove ID | check [DIR] | templates
 */
import type { Command, CommandContext } from './index';
import { describeManifest, manifestSentences, ManifestError, MANIFEST_FILE } from '../apps/manifest';
import { AppError, appDataDir, findInstalled, listInstalled, loadManifest, removeInstalled } from '../apps/registry';
import { RunLinkError, parseRecipeHeader, plain } from '../run-url';

const USAGE = `Usage: app new NAME [--template files|form|table] [--name "Shown name"] [--dir DIR]
                                         a new app as one file, app.json (app templates)
       app new NAME --page               a new app with a page of its own (five files)
       app new NAME --from SCRIPT        wrap a script as an app with a Run button
       app dev [DIR] [--no-open]         open the app in DIR, show its log, restart on save (Ctrl-C stops)
       app install [DIR]                 install the app in a folder (default: here)
       app install ID                    install an app this site ships
       app install gh:OWNER/REPO[/PATH]  install an app from GitHub (asks first)
       app install gist:ID               install an app from a gist (asks first)
       app install URL                   install an app from a .zip or .tar.gz (asks first)
                 [--guest[=NAME]]        open it in a guest instead of installing it here
       app open ID [--become] [--new]    open an installed app; --become: the tab is the app
       app share ID [--print]            a link to it: each person who opens the link gets their own copy
                                         and their own data (--print: only print the link)
       app export ID [FILE]              the app and its data as one file: to FILE here, or to your downloads
       app import FILE                   install the app in that file and restore its data (asks before replacing data)
       app list [-l]                     installed apps and whether they run
       app stop ID                       close its windows and stop its backend
       app remove ID [--data]            uninstall it; --data deletes what it stored too
       app check [DIR]                   validate app.json and say what the app does and asks for
       app templates                     the templates app new takes
`;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function core(ctx: CommandContext) {
  const runtime = await import('../apps/runtime');
  try { runtime.appsDeps(); } catch {
    // The tab's own shell where there is one: an app's backend outlives the terminal `app` was typed in
    const main = (globalThis as { __tabcomputer?: { shell?: CommandContext['shell']; fs?: CommandContext['fs'] } }).__tabcomputer;
    runtime.configureApps({ fs: ctx.fs, shell: main?.fs === ctx.fs && main.shell ? main.shell : ctx.shell });
  }
  return runtime;
}

const hasDesktop = (): boolean => !!(globalThis as { __shiroDesktop?: unknown }).__shiroDesktop;

export const appCmd: Command = {
  name: 'app',
  description: 'Apps: make one from a template, try it, install it in the dock, open it',
  async exec(ctx) {
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s + '\n'); else ctx.stdout += s + '\n'; };
    // What must show while the command still runs (app dev's log, an install's progress): straight to the terminal
    const term = !ctx.streamStdout && ctx.terminal && ctx.stdoutIsTTY !== false ? ctx.terminal : null;
    const live = (s: string) => { if (term) term.writeOutput((s + '\n').replace(/\r?\n/g, '\r\n')); else out(s); };
    const err = (s: string) => { ctx.stderr += `app: ${s}\n`; };
    const args = [...ctx.args];
    const sub = args.shift() ?? '';
    const flags = new Map<string, string>();
    const rest: string[] = [];
    const VALUE = new Set(['--template', '--from', '--name', '--dir']);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { rest.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--') && a.includes('=')) flags.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
      else if (VALUE.has(a)) {
        if (args[i + 1] === undefined) { err(`${a} needs a value`); return 2; }
        flags.set(a, args[++i]);
      } else if (a.startsWith('-') && a.length > 1) flags.set(a, '');
      else rest.push(a);
    }
    const known = (...names: string[]): boolean => {
      for (const f of flags.keys()) if (!names.includes(f)) { err(`unknown option ${f}`); ctx.stderr += USAGE; return false; }
      return true;
    };
    const home = ctx.env['HOME'] || '/home/user';
    const tilde = (p: string) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);

    try {
      switch (sub) {
        case '': case '-h': case '--help': case 'help':
          ctx.stdout += USAGE;
          return sub === '' ? 2 : 0;

        case 'templates': {
          const { TEMPLATES, DEFAULT_TEMPLATE } = await import('../apps/templates');
          for (const t of TEMPLATES) out(`${t.name.padEnd(7)} ${t.title}${t.name === DEFAULT_TEMPLATE ? ' (the default)' : ''}: ${t.description}`);
          return 0;
        }

        case 'new': {
          if (!known('--template', '--page', '--from', '--name', '--dir')) return 2;
          if (rest.length !== 1) { err('new needs one name'); ctx.stderr += USAGE; return 2; }
          const { scaffold, idFromName, titleFromId, TEMPLATES, DEFAULT_TEMPLATE } = await import('../apps/templates');
          const id = idFromName(rest[0]);
          if (!id) { err(`${JSON.stringify(rest[0])} does not make an id (2 to 32 of a-z, 0-9 and -, starting with a letter, and not a name tabcomputer uses)`); return 1; }
          if (['--template', '--page', '--from'].filter((f) => flags.has(f)).length > 1) { err('give one of --template, --page and --from'); return 2; }
          const template = flags.has('--page') ? 'page' : flags.get('--template');
          if (template !== undefined && !TEMPLATES.some((t) => t.name === template)) { err(`no template named ${template} (app templates)`); return 1; }
          let script: string | undefined;
          let name = flags.get('--name') ?? (rest[0] !== id ? rest[0] : titleFromId(id));
          if (flags.has('--from')) {
            const file = ctx.fs.resolvePath(flags.get('--from')!, ctx.cwd);
            try { script = (await ctx.fs.readFile(file, 'utf8')) as string; } catch { err(`${flags.get('--from')}: no such file`); return 1; }
            if (!flags.has('--name')) name = parseRecipeHeader(script).title ?? name;
          }
          const dir = ctx.fs.resolvePath(flags.get('--dir') ?? id, ctx.cwd);
          const files = await scaffold(ctx.fs, dir, id, { template, name, script });
          out(`Created ${id} in ${tilde(dir)}${script !== undefined ? ` (from ${flags.get('--from')})` : ` (template ${template ?? DEFAULT_TEMPLATE})`}:`);
          for (const f of files) out(`  ${f}`);
          if (files.length === 1) out(`That one file is the whole app. Say what it does: app check ${tilde(dir)}`);
          out(`Try it:     app dev ${tilde(dir)}`);
          out(`Install it: app install ${tilde(dir)}`);
          return 0;
        }

        case 'check': {
          if (!known()) return 2;
          const dir = ctx.fs.resolvePath(rest[0] ?? '.', ctx.cwd);
          const m = await loadManifest(ctx.fs, dir);
          out(`${m.id}: ${m.name}${m.version ? ` ${m.version}` : ''} (${MANIFEST_FILE} is valid)`);
          // An app that is its manifest reads as the sentences the install prompt shows
          if (m.kind !== 'page') for (const s of manifestSentences(m)) out(`  ${s}`);
          else for (const l of describeManifest(m)) out(`  ${l.label.padEnd(9)} ${l.text}`);
          return 0;
        }

        case 'dev': return await dev(ctx, rest, flags, live, err, known, tilde);

        case 'install': {
          if (!known('--guest', '--open')) return 2;
          if (rest.length > 1) { err('install takes one app'); return 2; }
          await core(ctx);
          const install = await import('../apps/install');
          const spec = rest[0] ?? '.';
          const asDir = ctx.fs.resolvePath(spec, ctx.cwd);
          const remote = /^(gh:|gist:|https?:)/i.test(spec);
          const isDir = !remote && await ctx.fs.stat(asDir).then((s) => s.isDirectory(), () => false);
          let id: string;
          if (isDir) {
            if (flags.has('--guest')) { err('a folder of this tab cannot be installed into a guest (a guest has its own files): put it in a repository and use gh:OWNER/REPO'); return 1; }
            const r = await install.installDir(asDir);
            id = r.app.id;
            live(`${r.replaced ? 'Updated' : 'Installed'} ${r.app.name} (${id}) in ${tilde(r.app.dir)}${r.files ? `: ${r.files} files` : ''}.`);
          } else {
            const { parseAppSpec, appLinkQuery } = await import('../apps/links');
            if (!remote && spec.includes('/') && !/^examples\/[a-z0-9-]+$/.test(spec)) { err(`${spec}: no such folder`); return 1; }
            const target = parseAppSpec(spec);
            const guest = flags.get('--guest');
            if (guest !== undefined) {
              if (target.kind === 'url') { err('--guest takes an app of this site or gh:OWNER/REPO'); return 1; }
              const g = await import('../guest');
              const name = g.cleanGuestName(guest);
              if (guest && !name) { err('a guest\'s name is letters and digits (up to 32)'); return 2; }
              if (g.guestInfo()) { err('this is a guest already'); return 1; }
              const url = await g.openGuest(name ? { name } : {}, { search: appLinkQuery(target) });
              if (!url) { err('this server has no guests'); return 1; }
              live(`Opening it in ${name ? `the guest "${name}"` : 'a thrown-away guest'}, which cannot read this tab's files or sign-ins: ${url}`);
              return 0;
            }
            live(`Fetching ${plain(spec)}…`);
            // A private repository, or GitHub's limit for visitors: ask for the sign-in and fetch again
            const needed = await import('../github-needed');
            const app = target.kind === 'gh' || target.kind === 'gist'
              ? await needed.fetchSignedIn(`app install ${target.kind === 'gh' ? `gh:${target.owner}/${target.repo}` : `gist:${target.id}`}`, (token) => install.fetchApp(target, undefined, token), { wait: needed.atTerminal(ctx) })
              : await install.fetchApp(target);
            if (!app.curated) {
              live(`${app.manifest.name} (${app.manifest.id}) from ${app.from}. tabcomputer has not reviewed it: a window shows what it asks for.`);
              const choice = await install.confirmInstall(app);
              if (choice === 'guest') {
                const g = await import('../guest');
                if (target.kind === 'url') { err('an archive cannot be opened in a guest from here'); return 1; }
                const url = await g.openGuest({}, { search: appLinkQuery(target) });
                live(url ? `Opened in a guest: ${url}` : 'This server has no guests.');
                return url ? 0 : 1;
              }
              if (choice !== 'install') { live('Cancelled: nothing was installed.'); return 1; }
            }
            const r = await install.installFetched(app);
            id = r.app.id;
            live(`${r.replaced ? 'Updated' : 'Installed'} ${r.app.name} (${id}) in ${tilde(r.app.dir)}: ${r.files} files.`);
          }
          // Its toolchain sets now, so the first open is quick (the dock shows the progress)
          await install.prepareInstalled(id, (l) => live(`  ${l}`));
          live(hasDesktop() ? `It is in the dock. Open it: app open ${id}` : `Open it: app open ${id}`);
          if (flags.has('--open')) await openById(ctx, id, false, false, out);
          return 0;
        }

        case 'open': {
          if (!known('--become', '--new')) return 2;
          if (rest.length !== 1) { err('open needs an app\'s id (app list)'); return 2; }
          await core(ctx);
          await openById(ctx, rest[0], flags.has('--become'), flags.has('--new'), out);
          return 0;
        }

        case 'list': case 'ls': {
          if (!known('-l', '--long')) return 2;
          const { instanceOf } = await core(ctx);
          const apps = await listInstalled(ctx.fs);
          if (!apps.length) { out('No apps are installed. app new NAME makes one; app install DIR installs it.'); return 0; }
          const long = flags.has('-l') || flags.has('--long');
          out(`${'ID'.padEnd(20)} ${'NAME'.padEnd(22)} ${'STATE'.padEnd(16)} FROM`);
          for (const a of apps) {
            const inst = instanceOf(a.id);
            const state = !inst ? '-' : inst.supervisor ? `${inst.supervisor.state} :${inst.supervisor.port}` : 'open';
            out(`${a.id.padEnd(20)} ${a.name.slice(0, 22).padEnd(22)} ${state.padEnd(16)} ${plain(a.source.replace(/^dir:/, ''), 80)}`);
            if (!long) continue;
            try {
              const m = await loadManifest(ctx.fs, a.dir);
              if (m.description) out(`  ${m.description}`);
              for (const l of describeManifest(m)) out(l.label ? `  ${l.label.padEnd(9)} ${l.text}` : `  ${l.text}`);
            } catch (e) { out(`  (its ${MANIFEST_FILE} can't be read: ${(e as Error).message.split('\n')[0]})`); }
          }
          return 0;
        }

        case 'share': {
          if (!known('--print')) return 2;
          if (rest.length !== 1) { err('share needs an app\'s id (app list)'); return 2; }
          const app = await findInstalled(ctx.fs, rest[0]);
          if (!app) { err(`no app named ${rest[0]} is installed (app list)`); return 1; }
          const { shareApp, shareStatement, siteOriginOf } = await import('../apps/share');
          const { guestInfo } = await import('../guest');
          const origin = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? siteOriginOf(location, !!guestInfo()) : 'https://tabcomputer.com';
          const share = await shareApp(ctx.fs, app, origin);
          if (flags.has('--print')) { out(share.url); return 0; }
          const { promise, details } = shareStatement(share);
          out(`A link to ${share.name}:`);
          out('');
          out(share.url);
          out('');
          for (const l of [...promise, ...details]) out(l);
          if (hasDesktop() && typeof document !== 'undefined') {
            const [{ showShareScreen }, { writeClipboard }] = await Promise.all([import('../apps/share-ui'), import('../utils/clipboard')]);
            showShareScreen(share, (globalThis as { __shiroDesktop?: import('../desktop/wm').DesktopAPI }).__shiroDesktop ?? null, (text) => writeClipboard(text).catch(() => false));
            out('');
            out('The Share window has a Copy link button.');
          }
          return 0;
        }

        case 'export': {
          if (!known()) return 2;
          if (rest.length < 1 || rest.length > 2) { err('export needs an app\'s id (app list), and may name the file'); return 2; }
          await core(ctx);
          const { exportInstalled } = await import('../apps/install');
          // A file in this tab when one is named; else the person's real disk
          const exp = await exportInstalled(rest[0], rest[1] === undefined ? undefined : ctx.fs.resolvePath(rest[1], ctx.cwd));
          const n = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;
          out(`Exported ${exp.header.name} with its data to ${exp.path ? tilde(exp.path) : `your downloads, as ${exp.name}`}: ${n(exp.appFiles, 'file')} of the app, ${n(exp.dataFiles, 'file')} of data, ${Math.max(1, Math.ceil(exp.bytes.length / 1000))} KB.`);
          out(`To bring it back, here or on another computer: app import ${exp.path ? tilde(exp.path) : exp.name}, or drop the file on the desktop.`);
          return 0;
        }

        case 'import': {
          if (!known('--open')) return 2;
          if (rest.length !== 1) { err('import needs the file app export made'); return 2; }
          await core(ctx);
          const file = ctx.fs.resolvePath(rest[0], ctx.cwd);
          let bytes: Uint8Array;
          try { bytes = (await ctx.fs.readFile(file)) as Uint8Array; } catch { err(`${rest[0]}: no such file`); return 1; }
          const { importApp } = await import('../apps/install');
          const done = await importApp(bytes, file.slice(file.lastIndexOf('/') + 1));
          if (!done) { live('Cancelled: nothing was changed.'); return 1; }
          const data = done.dataFiles ? `its data (${done.dataFiles} ${done.dataFiles === 1 ? 'file' : 'files'})` : 'no data: the file held none';
          live(`${done.installed ? 'Installed' : 'Kept'} ${done.app.name} (${done.app.id}) and restored ${data}.`);
          live(hasDesktop() ? `It is in the dock. Open it: app open ${done.app.id}` : `Open it: app open ${done.app.id}`);
          if (flags.has('--open')) await openById(ctx, done.app.id, false, false, out);
          return 0;
        }

        case 'stop': {
          if (!known()) return 2;
          if (rest.length !== 1) { err('stop needs an app\'s id'); return 2; }
          await core(ctx);
          const { stopApp } = await import('../apps/window');
          if (!stopApp(rest[0])) { err(`${rest[0]} is not running`); return 1; }
          out(`Stopped ${rest[0]}.`);
          return 0;
        }

        case 'remove': case 'rm': case 'uninstall': {
          if (!known('--data')) return 2;
          if (rest.length !== 1) { err('remove needs an app\'s id'); return 2; }
          await core(ctx);
          const id = rest[0];
          const app = await findInstalled(ctx.fs, id);
          if (!app) { err(`no app named ${id} is installed (app list)`); return 1; }
          const win = await import('../apps/window');
          win.stopApp(id);
          await removeInstalled(ctx.fs, id, { home, data: flags.has('--data') });
          win.unregisterInstalledApp(id);
          // An app this site ships has a dock entry before it is installed: removed, it stays out
          (await import('../apps/shipped')).setShippedHidden(id, true);
          const data = appDataDir(home, id);
          const kept = !flags.has('--data') && await ctx.fs.exists(data);
          out(`Removed ${app.name} (${id}).${kept ? ` What it stored is still in ${tilde(data)} (app remove --data deletes that too).` : ''}`);
          return 0;
        }
      }
      err(`unknown subcommand '${sub}'`);
      ctx.stderr += USAGE;
      return 2;
    } catch (e) {
      if (e instanceof ManifestError) { ctx.stderr += e.message + '\n'; return 1; }
      if (e instanceof AppError || e instanceof RunLinkError) { err(e.message); return 1; }
      err((e as Error)?.message ?? String(e));
      return 1;
    }
  },
};

async function openById(ctx: CommandContext, id: string, become: boolean, newWindow: boolean, out: (s: string) => void): Promise<void> {
  const win = await import('../apps/window');
  if (become) {
    await win.becomeApp((await win.installedRef(id)).ref);
    out(`The tab is ${id} now, at /${id}. unbecome (or ?unbecome on the address) returns to tabcomputer.`);
    return;
  }
  const d = (globalThis as { __shiroDesktop?: import('../desktop/wm').DesktopAPI }).__shiroDesktop;
  // Through the desktop when it knows the app: a second request while it starts goes to its placeholder
  const w = d?.apps().some((a) => a.id === id) ? await d.openApp(id, newWindow ? { newWindow: true } : undefined) : await win.openInstalled(id, { newWindow });
  if (w) out(w.id);
  else if (!d) out(`The tab is ${id} now, at /${id}. unbecome returns to the terminal.`);
  void ctx;
}

async function dev(
  ctx: CommandContext, rest: string[], flags: Map<string, string>, out: (s: string) => void, err: (s: string) => void,
  known: (...names: string[]) => boolean, tilde: (p: string) => string,
): Promise<number> {
  if (!known('--no-open')) return 2;
  if (rest.length > 1) { err('dev takes one folder'); return 2; }
  const runtime = await core(ctx);
  const dir = ctx.fs.resolvePath(rest[0] ?? '.', ctx.cwd);
  let manifest = await loadManifest(ctx.fs, dir);
  const installed = await findInstalled(ctx.fs, manifest.id);
  if (installed && installed.dir !== dir && runtime.instanceOf(manifest.id)?.dir === installed.dir) {
    err(`the installed ${manifest.id} is open: app stop ${manifest.id} first`);
    return 1;
  }
  const inst = runtime.instanceFor({ manifest, dir, source: `dev:${dir}`, dev: true });
  const headless = flags.has('--no-open') || !hasDesktop();
  const signal: AbortSignal | undefined = ctx.shell?.abortController?.signal ?? ctx.shell?.inheritedAbort?.signal;

  out(`app dev: ${manifest.name} (${manifest.id}) from ${tilde(dir)}`);
  out(`  page     ${manifest.kind !== 'page' ? 'tabcomputer\'s, from app.json' : manifest.entry ? `${manifest.entry === '.' ? 'this folder' : manifest.entry}` : 'served by the backend'}`);
  out(`  backend  ${inst.supervisor ? `${manifest.backend!.start}  (port ${inst.supervisor.port})` : 'none'}`);
  out('  A change to a file reloads the page; a change outside the page\'s folder restarts the backend first. Ctrl-C stops.');

  const offLog = inst.on((ev, text) => {
    if (ev === 'log' && text) for (const l of text.replace(/\r\n/g, '\n').split('\n')) if (l.trim()) out(l);
    if (ev === 'state' && inst.supervisor) out(`[app] backend ${inst.supervisor.state}${inst.supervisor.state === 'failed' ? `: ${inst.supervisor.error}` : ''}`);
  });
  const pane = { kind: 'pane' as const, close: () => {} };
  let stopWatch = () => {};
  try {
    if (headless) {
      inst.attach(pane);
      await inst.prepare((stage, line) => out(line ?? stage));
      if (!await inst.startBackend()) out(`[app] the backend did not start: ${inst.supervisor?.error ?? ''}`);
      if (!flags.has('--no-open')) out('(no desktop here: the app has no window; its backend runs)');
    } else {
      const { openAppWindow } = await import('../apps/window');
      const w = await openAppWindow({ manifest, dir, source: `dev:${dir}`, dev: true }, { restore: `app dev ${shq(dir)}` });
      if (!w && !inst.views.size) { err(`${manifest.name} did not open (its window shows why)`); return 1; }
      inst.attach(pane);
    }

    // ── restart on save ──
    const { PAGE_SET_TIMEOUT, PAGE_CLEAR_TIMEOUT } = await import('../node-compat/page-globals');
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pageRoot = !manifest.entry ? '' : /\.html?$/i.test(manifest.entry) ? manifest.entry.split('/').slice(0, -1).join('/') : manifest.entry === '.' ? '' : manifest.entry;
    const apply = async () => {
      timer = null;
      const rels = [...changed];
      changed.clear();
      let restart = false;
      if (rels.includes(MANIFEST_FILE)) {
        try {
          manifest = await loadManifest(ctx.fs, dir);
          inst.setManifest(manifest);
          out(`[app] ${MANIFEST_FILE} changed: read again`);
          restart = !!inst.supervisor;
        } catch (e) { out(`[app] ${MANIFEST_FILE} changed and is not valid; the app keeps the last valid one:\n${(e as Error).message}`); return; }
      }
      const backendFiles = rels.filter((r) => r !== MANIFEST_FILE && inst.supervisor && (manifest.entry === '.' || !pageRoot || !(r === pageRoot || r.startsWith(pageRoot + '/'))));
      if (backendFiles.length) restart = true;
      const shown = rels.slice(0, 3).join(', ') + (rels.length > 3 ? `, and ${rels.length - 3} more` : '');
      if (restart && inst.supervisor) {
        out(`[app] changed: ${shown}: restarting the backend`);
        await inst.supervisor.restart();
      } else out(`[app] changed: ${shown}: reloading the page`);
      inst.reload();
    };
    stopWatch = ctx.fs.onChange((_ev, path) => {
      if (path !== dir && !path.startsWith(dir + '/')) return;
      const rel = path.slice(dir.length + 1);
      if (!rel || /(^|\/)(node_modules|\.git)(\/|$)/.test(rel) || /(^|\/)\.[^/]*\.sw.$|~$/.test(rel)) return;
      changed.add(rel);
      if (timer) PAGE_CLEAR_TIMEOUT(timer);
      timer = PAGE_SET_TIMEOUT(() => { void apply(); }, 200);
    });

    // Until Ctrl-C, or the app's last window closes
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
      const off = inst.on((ev) => {
        if (ev !== 'views') return;
        if (!headless && inst.views.size === 1 && inst.views.has(pane)) { off(); resolve(); }
      });
    });
    return signal?.aborted ? 130 : 0;
  } finally {
    stopWatch();
    offLog();
    inst.detach(pane);
    if (runtime.instanceOf(manifest.id) === inst) inst.close();
    out(`app dev: ${manifest.id} stopped`);
  }
}

