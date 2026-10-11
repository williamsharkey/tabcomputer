/**
 * The instructions a coding agent finds in the home directory: one file,
 * ~/AGENTS.md, describing the machine it is actually on, and Claude Code's
 * user memory ~/.claude/CLAUDE.md, which imports it (`@~/AGENTS.md`), so
 * Claude Code reads it in every directory. Earlier builds seeded ~/CLAUDE.md
 * (`@AGENTS.md`) instead: in a directory below home that import is outside
 * the project, and Claude Code stopped at "Allow external CLAUDE.md file
 * imports?" in every new project. It is removed while it is still as written.
 *
 * Seeded on every boot, but never over a file the user changed: the hashes of
 * what was seeded are kept in /var/lib/tabcomputer/seeded.json, and a file is
 * replaced only while it still hashes to what we wrote. Installs from before
 * that manifest are recognized by the exact texts older builds seeded. Those
 * builds also wrote ~/NEO.md and ~/.shiro-context.json, which are removed when
 * they are still as written and left alone otherwise.
 */
import type { FileSystem } from './filesystem';
import { activeProfile } from './profile';
import { type ShiroRuntimeContext, parseRuntimeContext } from './seed-runtime-context';

export const AGENTS_PATH = '/home/user/AGENTS.md';
export const CLAUDE_PATH = '/home/user/.claude/CLAUDE.md';
/** Where earlier builds put the import (retired, see above). */
export const OLD_CLAUDE_PATH = '/home/user/CLAUDE.md';
export const MANIFEST_PATH = '/var/lib/tabcomputer/seeded.json';
const OLD_NEO_PATH = '/home/user/NEO.md';
const OLD_CONTEXT_PATH = '/home/user/.shiro-context.json';

/** Where each product's source lives (not checked out on the machine). */
const SOURCE: Record<string, string> = {
  shiro: 'https://github.com/williamsharkey/shiro',
  tabcomputer: 'https://github.com/williamsharkey/tabcomputer',
};

/** sha256 of the AGENTS.md and CLAUDE.md texts earlier builds seeded. */
const OLD_SEEDED = new Set([
  '48d10c82579a06f3264a6703cb3a32b4951da31900ff2713769db2f01f5a4eec', // AGENTS.md, "running inside Shiro Browser OS"
  'efcb97c487e617e44606b520e4f7da8a876a86c43b9f8c12e396e6b6214a799c', // AGENTS.md, the same renamed
  '7c740cab9e4ae89d026900d8fc02575164c8773bc2e1708f2b7daf7f605679ce', // CLAUDE.md, "Deprecated. Read AGENTS.md, then NEO.md"
]);

function bootSection(ctx: ShiroRuntimeContext, name: string): string {
  if (!ctx.injected) {
    return `This boot runs on its own page (not injected into another site). \`hc live\` inspects ${name}'s own page.`;
  }
  return [
    `This boot was injected into a host page by \`seed${ctx.mode === 'seed-blob' ? ' blob' : ''}\`:`,
    '',
    `- Host page: ${ctx.hostUrl || '(unknown)'} (origin ${ctx.hostOrigin || 'unknown'}, title "${ctx.hostTitle || ''}")`,
    `- Same-origin access to the host's DOM: ${ctx.sameOriginParentAccess ? 'yes' : 'no'}`,
    '',
    'Start with `hc outer` to inspect the host page, then `hc s`, `hc look`, `hc q <selector>`, `hc @0`.',
    `\`hc live\` inspects ${name}'s own page, not the host.`,
  ].join('\n');
}

/**
 * Known problems an agent here should plan around, rendered into AGENTS.md.
 * Facts about this build only: remove an entry in the change that fixes it.
 * Live state (what is installed, signed in, reachable) is `doctor`'s job.
 */
export const KNOWN_ISSUES: { issue: string; workaround?: string }[] = [
  {
    issue: "Claude Code's Bash tool adds `< /dev/null` only to commands without a `<` of their own, so a command with a here-doc or input redirect inherits the tool's stdin, which never ends; anything else in it that reads stdin (`cat`, `node`, `npx`, `claude --npm`) hangs until the tool's timeout.",
    workaround: 'Wrap a command that may read stdin as `{ cmd; } </dev/null`; a group\'s redirect works.',
  },
  {
    issue: "Images can't be pasted into Claude Code: `xclip` and `xsel` here are text only.",
    workaround: 'Save the image to a file and give its path.',
  },
  {
    issue: "In Debian mode, dpkg-deb's `.xz` decompression sometimes crashes or reports corrupt data under the x86-64 emulator, so `apt install` stops with a dpkg error.",
    workaround: 'Run the install again.',
  },
  {
    issue: '`gh issue view --comments` is not implemented (an unknown-flag error).',
    workaround: 'Use `gh api repos/OWNER/REPO/issues/N/comments --jq ".[].body"`.',
  },
  {
    issue: "node can exit with status 0 while it is still reading a large `fetch` body (tabcomputer#50), so the rest of the script never runs.",
    workaround: 'Hold the process open until the read ends: `const t = setInterval(() => {}, 1000);` before the fetch, `clearInterval(t)` after.',
  },
  {
    issue: "A backgrounded `timeout N node server.mjs > log &` isn't stopped at N seconds, and the log stays empty until node exits (tabcomputer#53).",
    workaround: 'Stop it with `kill PID`.',
  },
  {
    issue: "node's ES module imports are copies, not live bindings, and an entry module in an import cycle runs twice (tabcomputer#35); vitest 4 can't run tests (tabcomputer#32).",
  },
  {
    issue: 'Native Claude Code sometimes stops between a tool result and its next request, and ignores SIGTERM (tabcomputer#19).',
    workaround: '`kill -9` it, or reload the page, then `claude --resume`.',
  },
];

function knownIssues(): string {
  return KNOWN_ISSUES.map((k) => `- ${k.issue}${k.workaround ? ` ${k.workaround}` : ''}`).join('\n');
}

/** ~/AGENTS.md for this boot. */
export function buildAgentsMd(ctx: ShiroRuntimeContext): string {
  const p = activeProfile();
  const name = p.name;
  const site = p.brand?.domain ?? 'shiro.computer';
  const source = SOURCE[p.id] ?? SOURCE.tabcomputer;
  const claude = p.shims.claude === 'native'
    ? `- Plain \`claude\` runs Anthropic's native build's own JavaScript on this page's JS
  engine (\`--vm\`): about 3 s to the prompt. \`claude install\` downloads the native build
  (about 240 MB) it reads that JavaScript from, and \`claude update\` fetches a newer one.
- \`claude --x86\` (or \`--native\`) runs the same binary in the x86-64 emulator instead:
  much slower (a minute or so to start), for comparing or when \`--vm\` misbehaves.
- \`claude --npm\` runs the pinned pure-JavaScript build on ${name}'s Node runtime
  instead: installed at boot, starts fast.`
    : `- Plain \`claude\` runs the pinned pure-JavaScript build on ${name}'s Node runtime.
- \`claude install --native\` then \`claude --native\` runs Anthropic's native build in
  the x86-64 emulator (about 240 MB; one request takes a minute or two).`;
  return `# AGENTS.md

You are on ${name} (${site}): a computer that lives in a browser tab. You are a
coding agent inside it. The kernel, filesystem, shell and programs all run in
this page; there is no VM or server-side machine behind it.

## This boot

${bootSection(ctx, name)}

## Orient yourself

- \`doctor\` prints this tab's state, one OK/WARN/FAIL line per subsystem.
  \`doctor --agents\` checks, step by step, what agent CLIs need from both
  runtimes.
- \`echo $TABCOMPUTER_CLAUDE_BUILD $TABCOMPUTER_CLAUDE_VERSION\` tells you which
  Claude Code you are, when ${name}'s \`claude\` started you. \`native\` is Anthropic's
  binary in the x86-64 emulator: about 2 minutes per request. \`npm\` is the pinned
  pure-JavaScript build on ${name}'s Node runtime: much faster.
- Read "Known issues" below before working around something that fails, and
  check the tracker for newer ones: \`gh issue list -R ${source.replace('https://github.com/', '')}\`.

## The machine

- A Unix kernel written in TypeScript runs in the page: processes, fork/exec,
  pipes, ptys, signals, job control, sockets, \`/proc\`. \`ps\` lists kernel
  processes.
- The shell is ${name}'s own bash-compatible shell, with many builtins:
  coreutils, grep/sed/awk, \`rg\`, \`jq\`, \`git\`, \`gh\`, \`curl\`, \`vi\`, \`nano\`, \`tmux\`.
- Home is \`/home/user\`. Files persist in this browser's storage for this site
  across reloads. They are not synced anywhere else: commit and push work you
  want to keep. You run as uid 1000; \`sudo\` gives root inside ${name}.
- x86-64 Linux programs run in the Blink emulator, compiled to WebAssembly:
  correct, but big programs take seconds to start. WASM programs run directly.
- \`node\`, \`npm\` and \`npx\` are a Node.js-compatible runtime built into the page,
  not real Node. Most pure-JS npm packages work; native addons (\`.node\`) don't.
  Each \`node\` is a real process in a background worker: \`*Sync\` child_process
  calls block, \`ps\` and \`kill\` see it, and a server (\`node server.js\`, \`npm run
  dev\`) stays in the foreground while it listens, as on Linux. Start one with
  \`&\` (\`node server.js > server.log 2>&1 &\`) to keep using the shell, and stop it
  with \`kill %1\`. That needs a cross-origin isolated page (\`doctor\` says;
  ${site} is one): elsewhere, or with \`TABCOMPUTER_NODE_WORKER=0\`, node runs in
  the page instead.
- Network: outbound HTTP(S) works. Linux programs get TCP through the site's
  relay when it is on (ports 22, 80, 443, 9418); UDP is DNS only. Nothing on the
  internet can connect in.
- \`/dom\` is the page itself as files (\`ls /dom\`).

## Installing software

- Real Debian: \`debian install\` streams in Debian 13, then \`sudo apt update\` (about
  45 s) and \`sudo apt install -y NAME\` (Debian's own apt and dpkg, x86-64 in the
  emulator: about a minute for a small package, python3 about 4 minutes). 1846 of
  popcon's top 2000 packages pass a smoke test.
- Whole toolchains: \`toolchain install c\` (gcc, g++, make, gdb, cmake), \`python\`,
  \`go\` (std precompiled), \`tex\`, \`classic\` (Fortran, COBOL, Pascal, Ada), \`node\`
  or \`java\` puts the Debian packages in place in seconds instead of apt's minutes;
  dpkg knows them, so apt keeps working. \`toolchain list\` shows the sets. The first run of each program
  downloads it (gcc's hello world takes about 9 s from a fresh tab).
- Prebuilt: \`pkg install NAME\` installs one of ${name}'s 72 prebuilt programs
  (WebAssembly or static x86-64: vim, htop, git, python3, jq, curl, make, clang,
  go, ...) in about a second, and they start faster than Debian's. \`pkg available\`
  lists them. Before \`debian install\`, \`apt\` is \`pkg\`; after it, \`apt\` is Debian's.
- \`/usr/bin/NAME\` is whichever was installed last. To go back from Debian's to the
  prebuilt one: \`sudo apt remove -y NAME && pkg install --reinstall NAME\`.
  \`tabcomputer-alternatives --list\` shows which programs are ${name}'s builtins
  and which are Debian's; \`--set NAME debian\` and \`--auto NAME\` switch one.
- \`npm install\` works; \`pip install\` installs pure-Python wheels.
- \`python3\` is Pyodide until a \`pkg\` or Debian python3 is installed.
- \`gui\` lists X11 desktop apps; \`gui NAME\` opens one in a window.

## Useful here

- Web apps: \`npm create vite@latest app -- --template react\`, \`npm i\`, \`npm run dev\`,
  then \`serve open 5173\` shows it in a preview window with hot reload.
- \`serve DIR\` serves a folder in a preview window; a program that \`listen()\`s on
  a port is served the same way. Both are reachable only from this tab.
- \`page :PORT text|click|input|eval ...\` drives that page, so you can test a UI
  without a browser automation tool.
- The globe icon in the menu bar signs the user in to GitHub with a click
  (quicker than \`gh auth login\`, which needs them at a terminal; point them
  to the globe). git and gh then use the token. The built-in
  gh takes \`--body-file FILE\` and \`--json FIELDS --jq EXPR\`; a flag it doesn't
  implement is an error, never silently ignored.
- If a prebuilt package misbehaves, check \`pkg outdated\` and run \`pkg upgrade\` first: fixed builds ship as
  new versions (a stale python3 caused tabcomputer#5).

## What doesn't work

- inotify is ENOSYS for Linux programs (entr, inotifywait). Node's \`fs.watch\`
  works, so nodemon, vite's hot reload and jest --watch do.
- \`time\` reports no user/sys CPU time.
- Docker, VMs, kernel modules, GPU access, a D-Bus session bus.
- \`systemctl\` is a small built-in service manager, not systemd.
- Everything stops when the tab is closed or reloaded, including background jobs.
- Concurrency: an x86-64 process runs one guest thread at a time, and every
  process shares this one browser tab's CPU and memory. The tab uses about 220 MB
  booted; \`apt-get update\` adds about 580 MB at its peak and an install up to
  about 880 MB. Run one \`apt\` or build at a time, at most one subagent, gh and curl
  calls one after another, and at most 4 tool calls in parallel (Claude Code
  here is set to 4). Running the same apt work in four
  tabs at once made each step 1.4–1.7 times slower.

## When something is wrong

- \`doctor\` prints one OK/WARN/FAIL line per subsystem: the build, browser
  isolation, the x86 engine, the network relay, sign-ins, Debian, storage and
  the kernel. It never prints secrets. Run it first.
- \`dmesg\` shows the kernel log; relay refusals land there when curl or git
  only say "Could not connect".
- A command that hangs: press Ctrl-C at the terminal. Linux and WASM programs are
  kernel processes: \`ps\` lists them, \`kill PID\` (or \`kill -9 PID\`) stops
  them; \`node\` is one too. Builtins (the Pyodide \`python3\`, and \`node\` with
  \`TABCOMPUTER_NODE_WORKER=0\`) run inside the page, not as kernel processes.
  Started in the background, one still has a PID (\`$!\`, \`jobs -l\`): \`ps\`
  lists it, it has a \`/proc/PID\`, and \`kill PID\` stops it from any shell. A
  builtin in the foreground has none: Ctrl-C it, or reload.
- If a boot freezes, \`?safe=1\` in the address skips ~/.profile and the saved
  layout; \`safe-mode\` lists what failed.
- \`console -g PATTERN\` searches the page's console log (\`--prev\` includes the
  load before the last reload).
- Report bugs at ${source}/issues (\`gh issue create\` works here): the command,
  what happened, what you expected, and the \`doctor\` output.

## Source

${name} is open source: ${source}. \`hotswap checkout\` puts this build's own
source in ~/tabcomputer (below); \`git clone --depth 1 ${source}\` gets the latest. Its docs/
folder has the details and the measured scoreboards. Where things live:

- the shell: \`src/shell.ts\` and \`src/shell-*.ts\` (some builtins, like \`eval\`,
  are special-cased in shell.ts); other commands: \`src/commands/NAME.ts\` (a few
  files there, like \`eval.ts\`, are unused stubs)
- the kernel (processes, fds, pipes, ptys, signals, sockets, IPC): \`src/kernel/\`;
  \`/proc\`: \`src/kernel/procfs.ts\`
- the filesystem: \`src/filesystem.ts\`; the Node runtime: \`src/node-compat/\`
- WASM programs: \`src/wasi/\`; x86-64 programs: \`src/x86-engine/\` and the Blink
  patches in \`vendor/blink/patches/\`; Debian mode: \`src/debian/\`
- prebuilt packages: \`src/pkg-index.json\`, recipes in \`scripts/pkgbuild/\`

## Changing ${name} from here

You can change ${name}'s own code in this running tab, without a reload (a
reload would end your session). The loop:

    hotswap checkout && cd ~/tabcomputer   # this build's source (src/, the suites)
    hotswap watch -d                       # once: each save under src/ is swapped in
    # edit src/shell.ts (or any module) with your usual tools, then:
    hotswap watch --wait                   # one line per save: what changed, or the build error
    hotswap test --changed                 # the suites that import what you changed
                                           # (or: hotswap watch -d --test, after each save)
    hotswap confirm                        # keep it; otherwise it reverts 90 s after the last save
    hotswap push BRANCH -m MSG             # a new branch of williamsharkey/tabcomputer (never main)

- A save is live about 0.4 s later, and the build doesn't block the page. A save that doesn't build changes
  nothing. A swap that breaks things undoes itself: by the TTL, or, if the page
  froze, when it runs again. \`hotswap revert --all\` undoes everything now.
- Classes and registry commands are patched in place, so existing shells run
  the new methods. A changed free function isn't, for modules that already
  imported it; \`--wait\` says so. ~/tabcomputer/docs/HOTSWAP.md has the details, and
  ~/tabcomputer/docs/DEVELOP_IN_TAB.md walks through it, up to reporting a fix.
- \`hotswap test\` runs vitest suites in this tab; their node:fs is an
  in-memory copy of the checkout. \`hotswap push\` uses your own \`gh auth login\`.
- Commits to ${name}'s repository end with the plain trailer
  \`Co-Authored-By: Claude <noreply@anthropic.com>\`: no model names or versions
  in commit messages, branch names or code.

## Known issues

${knownIssues()}

## Claude Code here

${claude}
- Signed out, Claude Code opens the sign-in page in a new browser tab and asks for the
  code it shows; \`claude login\` signs in again.
- Credentials are in \`~/.claude/.credentials.json\`; never print them or any other token.
`;
}

/** ~/.claude/CLAUDE.md: Claude Code imports AGENTS.md from it. */
export const CLAUDE_MD = '@~/AGENTS.md\n';
/** What earlier builds wrote to ~/CLAUDE.md. */
const OLD_CLAUDE_MD = '@AGENTS.md\n';

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** ~/NEO.md as builds before AGENTS.md held the boot context wrote it. */
function oldNeoMd(ctx: ShiroRuntimeContext, name: string): string {
  if (!ctx.injected) {
    return `# NEO.md\n\nThis file describes the runtime context for this ${name} boot.\n\n- Mode: standalone\n- Host page DOM bridge: unavailable\n- \`hc live\` inspects ${name}'s own DOM\n- \`hc outer\` is not expected to work in this boot\n`;
  }
  return `# NEO.md

This ${name} instance was spawned from a host page.

- Mode: ${ctx.mode === 'seed-blob' ? 'seed blob injection' : 'seed injection'}
- Host page: ${ctx.hostUrl || '(unknown)'}
- Host origin: ${ctx.hostOrigin || '(unknown)'}
- Host title: ${ctx.hostTitle || '(untitled)'}
- Host DOM bridge: available via \`hc outer\`
- Same-origin parent DOM access: ${ctx.sameOriginParentAccess ? 'yes' : 'no'}

Start with:

1. Run \`hc outer\`
2. Then use \`hc s\`, \`hc look\`, \`hc q <selector>\`, \`hc @0\`

Notes:

- \`hc live\` inspects ${name}'s own DOM, not the host page
- Prefer \`hc outer\` for host-page inspection even in blob mode
- Machine-readable details are in \`/home/user/.shiro-context.json\`
`;
}

type SeedFS = Pick<FileSystem, 'mkdir' | 'readFile' | 'writeFile' | 'unlink'>;

async function readText(fs: SeedFS, path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8') as string; } catch { return null; }
}

/**
 * Write AGENTS.md and ~/.claude/CLAUDE.md, replacing earlier seeded versions
 * but never a file the user edited; remove the retired ~/CLAUDE.md, NEO.md and
 * .shiro-context.json the same way. Returns what it did, one line per file it
 * touched or left alone.
 */
export async function seedAgentDocs(fs: SeedFS, ctx: ShiroRuntimeContext): Promise<string[]> {
  const log: string[] = [];
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse((await readText(fs, MANIFEST_PATH)) ?? '{}') ?? {}; } catch { manifest = {}; }
  const seededByUs = async (path: string, text: string) => {
    const h = await sha256(text);
    return h === manifest[path] || OLD_SEEDED.has(h);
  };

  // Retired files: NEO.md is recognized by regenerating it from the context
  // file written next to it; the context file is machine-written JSON.
  const oldJson = await readText(fs, OLD_CONTEXT_PATH);
  const oldCtx = oldJson === null ? null : parseRuntimeContext(oldJson);
  const jsonIsOurs = oldJson !== null && JSON.stringify(oldCtx, null, 2) === oldJson;
  const neo = await readText(fs, OLD_NEO_PATH);
  if (neo !== null) {
    const basis = jsonIsOurs ? oldCtx! : { ...ctx, injected: false };
    if (['Shiro', 'tabcomputer'].some((n) => oldNeoMd(basis, n) === neo)) {
      await fs.unlink(OLD_NEO_PATH);
      log.push(`removed ${OLD_NEO_PATH} (now part of AGENTS.md)`);
    } else log.push(`kept ${OLD_NEO_PATH} (edited)`);
  }
  if (oldJson !== null) {
    if (jsonIsOurs) { await fs.unlink(OLD_CONTEXT_PATH); log.push(`removed ${OLD_CONTEXT_PATH}`); }
    else log.push(`kept ${OLD_CONTEXT_PATH} (edited)`);
  }

  await fs.mkdir('/home/user/.claude', { recursive: true });
  for (const [path, text] of [[AGENTS_PATH, buildAgentsMd(ctx)], [CLAUDE_PATH, CLAUDE_MD]] as const) {
    const have = await readText(fs, path);
    if (have === text) { manifest[path] = await sha256(text); continue; }
    if (have !== null && !(await seededByUs(path, have))) { log.push(`kept ${path} (edited)`); continue; }
    await fs.writeFile(path, text);
    manifest[path] = await sha256(text);
    log.push(`${have === null ? 'wrote' : 'updated'} ${path}`);
  }
  // The old ~/CLAUDE.md goes once the user memory imports AGENTS.md (with a
  // ~/.claude/CLAUDE.md of the user's own, it stays: home still reads AGENTS.md)
  const old = await readText(fs, OLD_CLAUDE_PATH);
  if (old !== null) {
    if (await readText(fs, CLAUDE_PATH) !== CLAUDE_MD) log.push(`kept ${OLD_CLAUDE_PATH} (${CLAUDE_PATH} is the user's own)`);
    else if (old === OLD_CLAUDE_MD || await seededByUs(OLD_CLAUDE_PATH, old)) {
      await fs.unlink(OLD_CLAUDE_PATH);
      log.push(`removed ${OLD_CLAUDE_PATH} (now ${CLAUDE_PATH})`);
    } else log.push(`kept ${OLD_CLAUDE_PATH} (edited)`);
  }
  delete manifest[OLD_CLAUDE_PATH];
  await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  return log;
}
