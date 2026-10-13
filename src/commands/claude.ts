/**
 * claude - Run Claude Code in this terminal.
 *
 * Claude Code signs itself in, in the terminal: signed out, it opens the
 * sign-in page in a new browser tab (xdg-open, src/open-url.ts) and asks for
 * the code that page shows. Settings → Accounts has the page's own sign-in
 * panel (src/claude-signin.ts) as an alternative; `claude` never opens it.
 *
 *   claude                   # Interactive session
 *   claude -p "fix the bug"  # Print mode
 *   claude login             # Sign in, or switch accounts (`claude auth login`)
 *
 * Which build plain `claude` runs is the profile's `shims.claude`: tabcomputer
 * runs Anthropic's native build's JavaScript on this page's engine (`--vm`,
 * docs/CLAUDE_VM.md), shiro the pinned npm build. Either way:
 *   claude --vm ...                          # the native build's JavaScript on this page's engine (tabcomputer's default)
 *   claude --x86 ...                         # the native binary in the x86-64 emulator (--native is the same; CLAUDE_X86=1)
 *   claude --npm ...                         # the pinned npm build (CLAUDE_NATIVE=0)
 *   claude install [--native|--npm] [ver]    # install that build (native: claude-native.ts; --vm runs it too)
 */

import { Command } from './index';
import {
  CLAUDE_CODE_CLI_JS,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_REPORTED_VERSION,
  ensureClaudeCodeInstalled,
  isClaudeCodeInstalled,
} from '../claude-code-version';
import { activeProfile } from '../profile';

// Flags that make Claude print something and exit instead of starting a session
const INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);

export function needsSession(args: string[]): boolean {
  if (args.some(a => INFO_FLAGS.has(a))) return false;
  // Subcommands (mcp, config, doctor, ...) take their own flags
  return args.length === 0 || args[0].startsWith('-');
}

/**
 * `claude login` (and `/login`): Claude Code's own sign-in. The native build's
 * `claude auth login` asks for the code to paste; the npm build's (2.1.112)
 * only waits for a localhost callback that can't arrive here, so it starts a
 * session whose first input is `/login`, which has the paste prompt.
 */
export function loginArgs(args: string[], build: 'native' | 'npm' = 'native'): string[] {
  if (args[0] !== 'login' && args[0] !== '/login') return args;
  return build === 'native' ? ['auth', 'login', ...args.slice(1)] : ['/login'];
}

/** Where `claude --native` looks for the binary: $CLAUDE_NATIVE_PATH, else ~/.local/bin/claude. */
export function nativeClaudePath(env: Record<string, string>): string {
  return env.CLAUDE_NATIVE_PATH || `${env.HOME || '/home/user'}/.local/bin/claude`;
}

const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;

/**
 * `claude --native` / CLAUDE_NATIVE=1: run Anthropic's native build in Blink
 * instead of the pinned npm one. The linux-x64-musl build works (it needs
 * musl's loader at /lib/ld-musl-x86_64.so.1); the glibc build still crashes
 * at startup in Blink. `claude install --native` downloads it from inside
 * the guest (claude-native.ts). docs/COMPAT.md "Agent CLIs".
 */
async function runNative(ctx: Parameters<Command['exec']>[0], args: string[]): Promise<number> {
  const path = nativeClaudePath(ctx.env);
  let elf = false;
  let raw: Uint8Array | string | null = null;
  try {
    raw = await ctx.fs.readFile(path);
    elf = typeof raw !== 'string' && raw.length > 4 && raw[0] === 0x7f && raw[1] === 0x45 && raw[2] === 0x4c && raw[3] === 0x46;
  } catch { /* missing */ }
  if (!elf) {
    ctx.stderr += `claude: native Claude Code is not installed (no binary at ${path}).\n`
      + 'Run `claude install` to download it (about 240 MB; it runs in the x86-64 emulator),\n'
      + 'or `claude --npm` for the pinned npm build, which needs no download.\n'
      + '(CLAUDE_NATIVE_PATH picks another path for the linux-x64-musl binary.)\n';
    return 1;
  }
  args = loginArgs(args);
  // Sessions skip permission prompts, as the npm build's do (below). Without the
  // flag native Claude ran in auto mode, whose safety check is a model call
  // before every Bash command: about 2-2.5 s each in the emulator (#40)
  const bypass = needsSession(args) && !args.some(a => a === '--dangerously-skip-permissions' || a === '--permission-mode');
  if (bypass) args.unshift('--dangerously-skip-permissions');
  // Same settings cleanup as the npm build's start (e.g. drop the "mcp__*"
  // allow rule older Shiro seeded, which current Claude Code warns about)
  try {
    const { ensureClaudeBootstrap } = await import('../claude-config');
    // Trust the working directory as the npm build does (node-compat/preload.ts):
    // without it every native start in a fresh or reset project stopped at
    // Claude's workspace trust prompt, a session restore included
    await ensureClaudeBootstrap(ctx.fs, { homeDir: ctx.env.HOME || '/home/user', projectPath: ctx.cwd, trustProject: true, completeProjectOnboarding: true, acceptBypassPermissions: bypass });
  } catch { /* settings are Claude's own business; never block the run */ }
  // JSC's JIT costs more than it saves under Blink: the code it writes at run
  // time mostly runs interpreted there. `-p` took 32.8 s without it, 56.9 s with
  // it and 61.1 s with only the baseline JIT (mean of 3 each, build 965, #40).
  // Export BUN_JSC_useJIT=1 to keep it.
  const jit = ctx.env.BUN_JSC_useJIT === undefined ? 'BUN_JSC_useJIT=0 ' : '';
  // URLs as OSC 8 links: the sign-in URL Claude prints wraps over several
  // lines, and a click on the link opens it (no popup blocker involved)
  const links = ctx.env.FORCE_HYPERLINK === undefined ? 'FORCE_HYPERLINK=1 ' : '';
  // Which build an agent inside is (~/AGENTS.md, src/agent-docs.ts)
  const { nativeClaudeVersion } = await import('./claude-native');
  const version = await nativeClaudeVersion(ctx.fs, path, raw as Uint8Array);
  const build = `TABCOMPUTER_CLAUDE_BUILD=native TABCOMPUTER_CLAUDE_VERSION=${quote(version ?? 'unknown')} `;
  // grep/find/rg in the agent's shell and its search tools: tabcomputer's (~1 ms) rather than
  // the 240 MB binary re-run as ugrep/bfs/rg in Blink (300-1400 ms each, tabcomputer#42)
  const search = nativeSearchSetup(args, ctx.env);
  // As the npm build (node-compat/process.ts): no self-install or updater and no
  // official-marketplace clone at start. Without them its first launch copied its
  // own 250 MB into ~/.local/share/claude/versions through staging/ (~1000
  // eventfd wakes/s for 24-70 s) and git-cloned the plugin marketplace (#40).
  // Export any of them to change it.
  const quiet = Object.entries(quietEnv(ctx.env)).map(([k, v]) => `${k}=${v} `).join('');
  const line = jit + links + quiet + build + search.env + [path, ...search.args].map(quote).join(' ');
  return ctx.shell.execute(line, (s) => { ctx.stdout += s.replace(/\r\n/g, '\n'); }, (s) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, ctx.terminal, true);
}

/**
 * What native Claude Code and `claude --vm` start with, unless the user set it:
 * - no self-install, updater or official-marketplace clone (see runNative);
 * - DISABLE_ERROR_REPORTING and DISABLE_TELEMETRY: its telemetry, error reports,
 *   feature-flag fetches and probes are round trips that cost ~5 s of a signed-in
 *   `claude -p` in the tab (20.5 -> 15.6 s); the version check, `claude update` and
 *   sign-in stay. Their cost: this computer can't take a Remote Control session
 *   started on claude.ai. TABCOMPUTER_CLAUDE_TELEMETRY=1 (or DISABLE_TELEMETRY or
 *   DO_NOT_TRACK set by the user) leaves telemetry as Claude Code's default; Claude
 *   Code reads any non-empty DISABLE_TELEMETRY, 0 included, as set.
 *   (docs/CLAUDE_VM.md, "Network traffic".)
 */
export function quietEnv(env: Record<string, string>): Record<string, string> {
  const keys = ['DISABLE_AUTOUPDATER', 'DISABLE_INSTALLATION_CHECKS', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', 'DISABLE_ERROR_REPORTING'];
  if (env.TABCOMPUTER_CLAUDE_TELEMETRY !== '1' && env.DO_NOT_TRACK === undefined) keys.push('DISABLE_TELEMETRY');
  return Object.fromEntries(keys.filter((k) => env[k] === undefined).map((k) => [k, '1']));
}

/**
 * `claude --vm`: the native build's own JavaScript, taken out of the binary
 * and run on tabcomputer's node in the page's JS engine, with a Bun shim
 * (src/claude-vm/, docs/CLAUDE_VM.md). The binary is the one `claude install`
 * put at $CLAUDE_NATIVE_PATH; nothing else is downloaded.
 */
async function runVm(ctx: Parameters<Command['exec']>[0], args: string[]): Promise<number> {
  const path = nativeClaudePath(ctx.env);
  let elf = false;
  try {
    const st = await ctx.fs.stat(path);
    elf = st.size > 1_000_000;
  } catch { /* missing */ }
  if (!elf) {
    ctx.stderr += `claude --vm: native Claude Code is not installed (no binary at ${path}).\n`
      + 'Run `claude install` first: --vm runs that build\'s JavaScript without the x86-64 emulator.\n';
    return 1;
  }
  const home = ctx.env.HOME || '/home/user';
  const say = (t: string) => { if (ctx.terminal) ctx.terminal.writeOutput(t.replace(/\n/g, '\r\n')); else ctx.stderr += t; };
  let layout;
  try {
    const { ensureClaudeVm } = await import('../claude-vm/extract');
    layout = await ensureClaudeVm(ctx.fs as any, path, home, say);
  } catch (e: any) {
    // (what --vm can't run yet, the native build in the emulator can)
    say(`claude --vm: could not read the native build's JavaScript (${e?.message || e}); running it in the emulator instead\n`);
    return runNative(ctx, args);
  }
  args = loginArgs(args);
  // Sessions skip permission prompts, as runNative's and the npm build's do (#40)
  const bypass = needsSession(args) && !args.some(a => a === '--dangerously-skip-permissions' || a === '--permission-mode');
  if (bypass) args.unshift('--dangerously-skip-permissions');
  try {
    const { ensureClaudeBootstrap } = await import('../claude-config');
    await ensureClaudeBootstrap(ctx.fs, { homeDir: home, projectPath: ctx.cwd, trustProject: true, completeProjectOnboarding: true, acceptBypassPermissions: bypass });
  } catch { /* settings are Claude's own business; never block the run */ }
  const nodeCmd = ctx.shell.commands.get('node');
  if (!nodeCmd) { ctx.stderr += 'claude: node command not available\n'; return 127; }
  const { nativeClaudeVersion } = await import('./claude-native');
  const version = await nativeClaudeVersion(ctx.fs, path);
  // the service worker that serves the compiled bundle (src/claude-vm/code-cache.ts);
  // without it (or switched off) the launcher requires bundle.js
  const cached = ctx.env.TABCOMPUTER_VM_CODECACHE !== '0'
    && await import('../claude-vm/sw-host').then((m) => m.ensureVmServiceWorker()).catch(() => false);
  const search = nativeSearchSetup(args, ctx.env);
  const quiet = quietEnv(ctx.env);
  const env: Record<string, string> = {
    FORCE_HYPERLINK: '1', ...quiet, ...(search.env ? { USE_BUILTIN_RIPGREP: '0' } : {}), ...ctx.env,
    TABCOMPUTER_CLAUDE_BUILD: 'vm', TABCOMPUTER_CLAUDE_VERSION: version ?? 'unknown',
    ...(cached ? {} : { TABCOMPUTER_VM_CODECACHE: '0' }),
  };
  const nodeCtx = { ...ctx, env, args: [layout.launcher, ...search.args], stdout: '', stderr: '' };
  const code = await nodeCmd.exec(nodeCtx);
  ctx.stdout += nodeCtx.stdout;
  ctx.stderr += nodeCtx.stderr;
  return code;
}

const CLAUDE_SUBCOMMANDS = new Set(['auth', 'mcp', 'config', 'doctor', 'install', 'update', 'upgrade', 'plugin', 'setup-token', 'migrate-installer']);

/**
 * Native Claude Code's search, pointed at tabcomputer's programs. By default it
 * replaces the Bash tool's grep and find with functions that re-run its own
 * binary as ugrep and bfs, and runs rg as itself too: each a whole Blink start
 * of the 240 MB binary. Opting in to its Grep and Glob tools (an
 * --allowedTools rule naming them) makes it leave grep and find alone, and
 * USE_BUILTIN_RIPGREP=0 makes those tools use the rg on PATH. Not for
 * subcommands, or when the user gave --allowedTools or --tools themselves.
 */
export function nativeSearchSetup(args: string[], env: Record<string, string>): { args: string[]; env: string } {
  const first = args.find((a) => !a.startsWith('-'));
  const own = args.some((a) => /^--(allowedTools|allowed-tools|tools)(=|$)/.test(a));
  if ((first && CLAUDE_SUBCOMMANDS.has(first) && args.indexOf(first) === 0) || args.some((a) => a === '--version' || a === '-v' || a === '--help' || a === '-h')) return { args, env: '' };
  return {
    // (=: a separate value would take the user's prompt as another tool name)
    args: own ? args : ['--allowedTools=Grep,Glob', ...args],
    env: env.USE_BUILTIN_RIPGREP === undefined ? 'USE_BUILTIN_RIPGREP=0 ' : '',
  };
}

export const claudeCmd: Command = {
  name: 'claude',
  description: 'Run Claude Code (installed automatically; it signs itself in)',
  async exec(ctx) {
    const args = [...ctx.args];
    // The build: --npm/--native/--x86/--vm first (or after `install`), then CLAUDE_X86=1 /
    // CLAUDE_NATIVE=0/1, then the profile. The native build runs as --vm (its JavaScript
    // on this page's engine) unless --x86/--native or CLAUDE_X86=1 asks for the emulator.
    const install = args[0] === 'install';
    const flagAt = install ? 1 : 0;
    let pick: 'npm' | 'native' | null = null;
    let x86 = !install && ctx.env.CLAUDE_X86 === '1';
    let vm = false;
    while (['--npm', '--native', '--x86', '--vm'].includes(args[flagAt])) {
      const f = args.splice(flagAt, 1)[0];
      pick = f === '--npm' ? 'npm' : 'native';
      if (f === '--native' || f === '--x86') { x86 = true; vm = false; }
      if (f === '--vm') { vm = true; x86 = false; }
    }
    if (!install && pick === 'native' && vm) return runVm(ctx, args);
    if (install && !pick) {
      const i = args.findIndex((a) => a === '--npm' || a === '--native');
      if (i > 0) pick = args.splice(i, 1)[0] === '--npm' ? 'npm' : 'native';
    }
    const native = pick ? pick === 'native'
      : ctx.env.CLAUDE_NATIVE === '1' ? true
      : ctx.env.CLAUDE_NATIVE === '0' ? false
      : activeProfile().shims.claude === 'native';
    if (native) {
      // `claude install [version]` and `claude update` download the native build (never the binary's own installer)
      if (install || args[0] === 'update' || args[0] === 'upgrade') {
        const version = install ? args.slice(1).find((a) => !a.startsWith('-')) : undefined;
        // About 240 MB in browser storage: keep it from eviction (tabcomputer#71)
        void import('../storage').then(m => m.requestPersistentStorage('claude install', true));
        const { installNativeClaude } = await import('./claude-native');
        return installNativeClaude(ctx, nativeClaudePath(ctx.env), version);
      }
      // Plain `claude` (and --vm, CLAUDE_NATIVE=1): the native build's JavaScript on this
      // page's engine, about 15x faster to start and 7x faster to type into than the
      // emulator (docs/CLAUDE_VM.md); --x86/--native or CLAUDE_X86=1 keep the emulator
      return x86 ? runNative(ctx, args) : runVm(ctx, args);
    }
    const write = (s: string) => {
      if (ctx.terminal) ctx.terminal.writeOutput(s.replace(/\n/g, '\r\n'));
      else ctx.stderr += s;
    };

    if (args[0] === 'update' || args[0] === 'upgrade' || args[0] === 'install') {
      ctx.stdout += `Claude Code in tabcomputer is pinned to ${CLAUDE_CODE_VERSION}, the last release that ships as JavaScript\n`
        + `(later releases are native binaries). It reports itself as ${CLAUDE_CODE_REPORTED_VERSION} so current models work.\n`
        + (activeProfile().shims.claude === 'native'
          ? 'Plain `claude` runs Anthropic\'s current build (`claude install` downloads it); `claude --npm` runs this one.\n'
          : 'Anthropic\'s current build runs too: claude install --native, then claude --vm (its JavaScript on this page\'s engine)\nor claude --x86 (the binary in the x86-64 emulator, much slower).\n');
      return 0;
    }

    if (!(await isClaudeCodeInstalled(ctx.fs))) {
      write(`Installing Claude Code ${CLAUDE_CODE_VERSION}...\n`);
      try {
        await ensureClaudeCodeInstalled(ctx.fs);
      } catch (e: any) {
        ctx.stderr += `claude: install failed: ${e?.message || e}\n`;
        return 1;
      }
    }

    args.splice(0, args.length, ...loginArgs(args, 'npm'));

    if (needsSession(args) && !args.some(a => a === '--dangerously-skip-permissions' || a === '--permission-mode')) {
      args.unshift('--dangerously-skip-permissions');
    }

    const nodeCmd = ctx.shell.commands.get('node');
    if (!nodeCmd) {
      ctx.stderr += 'claude: node command not available\n';
      return 127;
    }
    // OSC 8 links for the URLs it prints (the sign-in URL is clickable), as for the native build
    // Which build an agent inside is (~/AGENTS.md, src/agent-docs.ts)
    const env = { FORCE_HYPERLINK: '1', ...ctx.env, TABCOMPUTER_CLAUDE_BUILD: 'npm', TABCOMPUTER_CLAUDE_VERSION: CLAUDE_CODE_VERSION };
    const nodeCtx = { ...ctx, env, args: [CLAUDE_CODE_CLI_JS, ...args], stdout: '', stderr: '' };
    const exitCode = await nodeCmd.exec(nodeCtx);
    ctx.stdout += nodeCtx.stdout;
    ctx.stderr += nodeCtx.stderr;
    return exitCode;
  },
};
