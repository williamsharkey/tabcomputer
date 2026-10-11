/**
 * Which agent CLI each terminal is running, and the command that resumes it
 * after a reload (session restore: the desktop saves this with the window and
 * types it into the restored terminal).
 *
 * The terminal reports every line it runs (`lineStarted`/`lineEnded`). A line
 * whose command is `claude` or `codex` (after any VAR=value words) is tracked
 * while it runs: a poller finds the session it writes, so `forTerminal` can
 * answer synchronously (a pagehide save can't wait):
 *   - claude (native and --npm): ~/.claude/projects/<cwd, non-alphanumerics as ->/<id>.jsonl,
 *     resumed with `claude [--npm|--native|--x86|--vm] [kept flags] --resume <id>`;
 *   - codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
 *     resumed with `codex resume [kept flags] <id>`.
 * A session file another tracked terminal already has is never handed out
 * twice, so two terminals running claude in one directory resume their own.
 * One-shot runs (`claude -p`, `codex exec`) and subcommands aren't tracked.
 */

export type AgentId = 'claude' | 'codex';

export interface ResumeCommand {
  agent: AgentId;
  /** The session it resumes */
  sessionId: string;
  /** argv of the resume command */
  argv: string[];
  /** The same, as a shell line */
  line: string;
  cwd: string;
}

interface FsLike {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mtime?: number | Date; mtimeMs?: number; type?: string }>;
}

interface Tracked {
  agent: AgentId;
  argv: string[];
  cwd: string;
  home: string;
  startedAt: number;
  sessionId: string | null;
  timer: ReturnType<typeof setInterval> | null;
}

const POLL_MS = 3000;
const tracked = new Map<object, Tracked>();
const listeners = new Set<() => void>();
const changed = () => { for (const f of listeners) { try { f(); } catch { /* a listener's own problem */ } } };

const quote = (s: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** Shell words of a simple command line; null for anything compound (pipes, lists, substitutions). */
export function simpleWords(line: string): string[] | null {
  if (/[|;&<>`$(){}\n]/.test(line.replace(/'[^']*'|"[^"$`\\]*"/g, ''))) return null;
  const words: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  for (let m; (m = re.exec(line));) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

// Flags kept on resume: name → takes a value (codex's from `codex resume --help`, 0.162.1)
const CLAUDE_KEEP: Record<string, boolean> = {
  '--npm': false, '--native': false, '--x86': false, '--vm': false, '--dangerously-skip-permissions': false, '--verbose': false,
  '--model': true, '--permission-mode': true, '--add-dir': true, '--fallback-model': true,
};
const CLAUDE_ONE_SHOT = new Set(['-p', '--print', '-v', '--version', '-h', '--help']);
const CLAUDE_SUBCOMMANDS = new Set(['install', 'update', 'upgrade', 'login', 'logout', 'auth', 'mcp', 'config', 'doctor', 'migrate-installer', 'setup-token', 'plugin']);
const CODEX_ONE_SHOT = new Set(['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'a', 'cloud', 'features', 'help']);
const CODEX_KEEP: Record<string, boolean> = {
  '--dangerously-bypass-approvals-and-sandbox': false, '--search': false,
  '--model': true, '-m': true, '--sandbox': true, '-s': true, '--ask-for-approval': true, '-a': true, '--profile': true, '-p': true,
};

/** The agent a command line runs interactively, its argv (from the command), or null. */
export function agentOf(line: string): { agent: AgentId; argv: string[] } | null {
  const words = simpleWords(line.trim());
  if (!words) return null;
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const name = words[0]?.slice(words[0].lastIndexOf('/') + 1);
  const args = words.slice(1);
  if (name === 'claude') {
    const first = args.find((a) => a !== '--npm' && a !== '--native' && a !== '--x86' && a !== '--vm');
    if (args.some((a) => CLAUDE_ONE_SHOT.has(a)) || (first && CLAUDE_SUBCOMMANDS.has(first))) return null;
    return { agent: 'claude', argv: words };
  }
  if (name === 'codex') {
    // `codex [flags] [PROMPT]` and `codex resume ...` are interactive; exec, login, mcp, ... aren't
    if (args[0] && CODEX_ONE_SHOT.has(args[0])) return null;
    if (args.some((a) => a === '--version' || a === '-V' || a === '--help' || a === '-h')) return null;
    return { agent: 'codex', argv: words };
  }
  return null;
}

function keptFlags(args: string[], keep: Record<string, boolean>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (!(name in keep)) continue;
    if (keep[name] && eq < 0) { if (i + 1 < args.length) out.push(a, args[++i]); }
    else out.push(a);
  }
  return out;
}

/** The resume argv for a tracked run. */
export function resumeArgv(agent: AgentId, argv: string[], sessionId: string): string[] {
  const args = argv.slice(1);
  if (agent === 'claude') return ['claude', ...keptFlags(args, CLAUDE_KEEP), '--resume', sessionId];
  return ['codex', 'resume', ...keptFlags(args, CODEX_KEEP), sessionId];
}

/** Claude Code's project directory name for a working directory. */
export const claudeProjectDir = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-');

const mtimeOf = (st: { mtime?: number | Date; mtimeMs?: number }) =>
  st.mtimeMs ?? (st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime ?? 0));

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Session files the agent may be writing: [id, mtime], newest first. */
async function candidates(fs: FsLike, t: Tracked): Promise<Array<[string, number]>> {
  const dirs: string[] = [];
  if (t.agent === 'claude') dirs.push(`${t.home}/.claude/projects/${claudeProjectDir(t.cwd)}`);
  else {
    // today's and yesterday's dated directories (a run across midnight; local and UTC dates)
    const seen = new Set<string>();
    for (const ms of [Date.now(), Date.now() - 86_400_000]) {
      const d = new Date(ms);
      for (const [y, m, day] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]]) {
        const dir = `${t.home}/.codex/sessions/${y}/${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
        if (!seen.has(dir)) { seen.add(dir); dirs.push(dir); }
      }
    }
  }
  const out: Array<[string, number]> = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names) {
      const id = (t.agent === 'codex' && !n.startsWith('rollout-')) ? null : n.match(UUID)?.[1];
      if (!id) continue;
      try { out.push([id, mtimeOf(await fs.stat(`${dir}/${n}`))]); } catch { /* gone */ }
    }
  }
  return out.sort((a, b) => b[1] - a[1]);
}

/** Look for the session a tracked run writes (the newest file written since it started that no other run has). */
export async function refresh(fs: FsLike, key: object): Promise<string | null> {
  const t = tracked.get(key);
  if (!t) return null;
  const others = new Set([...tracked.entries()].filter(([k, o]) => k !== key && o.agent === t.agent && o.sessionId).map(([, o]) => o.sessionId));
  const found = (await candidates(fs, t)).find(([id, mtime]) => mtime >= t.startedAt - 2000 && !others.has(id));
  if (found && found[0] !== t.sessionId && tracked.get(key) === t) {
    t.sessionId = found[0];
    changed();
  }
  return t.sessionId;
}

/**
 * A terminal (any object identifying it) started running `line` in `cwd`.
 * Tracks it when it's an interactive agent run.
 */
export function lineStarted(key: object, line: string, cwd: string, env: Record<string, string>, fs: FsLike, now = Date.now()): boolean {
  lineEnded(key);
  const hit = agentOf(line);
  if (!hit) return false;
  const args = hit.argv.slice(1);
  // Resuming a known session: that's the session from the start
  let sessionId: string | null = null;
  if (hit.agent === 'claude') {
    const r = args.findIndex((a) => a === '--resume' || a === '-r');
    if (r >= 0 && args[r + 1] && !args[r + 1].startsWith('-')) sessionId = args[r + 1];
  } else if (args[0] === 'resume') {
    sessionId = args.slice(1).find((a) => UUID.test(`${a}.jsonl`)) ?? null;
  }
  const t: Tracked = { agent: hit.agent, argv: hit.argv, cwd, home: env.HOME || '/home/user', startedAt: now, sessionId, timer: null };
  tracked.set(key, t);
  const poll = () => { void refresh(fs, key).catch(() => {}); };
  t.timer = setInterval(poll, POLL_MS);
  (t.timer as { unref?: () => void }).unref?.();
  setTimeout(poll, 500);
  changed();
  return true;
}

/** The line a terminal was running finished. */
export function lineEnded(key: object): void {
  const t = tracked.get(key);
  if (!t) return;
  if (t.timer) clearInterval(t.timer);
  tracked.delete(key);
  changed();
}

/** The command that resumes what this terminal runs, once its session is known; else null. */
export function forTerminal(key: object): ResumeCommand | null {
  const t = tracked.get(key);
  if (!t?.sessionId) return null;
  const argv = resumeArgv(t.agent, t.argv, t.sessionId);
  return { agent: t.agent, sessionId: t.sessionId, argv, line: argv.map(quote).join(' '), cwd: t.cwd };
}

/** Called when any terminal's resume command appears, changes or goes (to save the session again). Returns unsubscribe. */
export function onChange(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/**
 * Commands for restored terminals, without two resuming one session (a saved
 * layout can name a session twice: the same window restored twice, a copy).
 */
export function dedupe(saved: Array<ResumeCommand | null | undefined>): Array<ResumeCommand | null> {
  const seen = new Set<string>();
  return saved.map((c) => {
    if (!c || seen.has(`${c.agent}:${c.sessionId}`)) return null;
    seen.add(`${c.agent}:${c.sessionId}`);
    return c;
  });
}
