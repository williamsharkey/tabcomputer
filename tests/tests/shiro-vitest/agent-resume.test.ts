import { describe, it, expect, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import {
  agentOf, resumeArgv, claudeProjectDir, lineStarted, lineEnded, refresh, forTerminal, onChange, dedupe, simpleWords,
} from '@shiro/agent-resume';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OLD = '99999999-9999-4999-8999-999999999999';
const env = { HOME: '/home/user' };

describe('agent session restore: which lines run an agent', () => {
  it('interactive claude and codex runs, not one-shots, subcommands or compound lines', () => {
    expect(agentOf('claude')?.agent).toBe('claude');
    expect(agentOf('CLAUDE_NATIVE=0 claude --model opus')?.argv).toEqual(['claude', '--model', 'opus']);
    expect(agentOf('/home/user/.local/bin/claude')?.agent).toBe('claude');
    expect(agentOf("claude --npm 'fix the tests'")?.argv).toEqual(['claude', '--npm', 'fix the tests']);
    for (const l of ['claude -p hi', 'claude --print hi', 'claude --version', 'claude install', 'claude --npm login', 'claude mcp list', 'claude | tee x', 'cd x && claude', 'echo claude', 'claude "$(cat p)"']) {
      expect(agentOf(l), l).toBeNull();
    }
    expect(agentOf('codex --sandbox danger-full-access')?.agent).toBe('codex');
    expect(agentOf('codex resume ' + A)?.agent).toBe('codex');
    for (const l of ['codex exec hi', 'codex login', 'codex --version', 'codex mcp list']) expect(agentOf(l), l).toBeNull();
    expect(simpleWords(`a 'b c' "d"`)).toEqual(['a', 'b c', 'd']);
  });

  it('resume commands keep the build, model and permission flags, not the prompt', () => {
    expect(resumeArgv('claude', ['claude', '--npm', '--model', 'opus', '--dangerously-skip-permissions', 'fix the tests'], A))
      .toEqual(['claude', '--npm', '--model', 'opus', '--dangerously-skip-permissions', '--resume', A]);
    expect(resumeArgv('claude', ['claude', '--native', '--resume', OLD, '--permission-mode=plan'], A))
      .toEqual(['claude', '--native', '--permission-mode=plan', '--resume', A]);
    expect(resumeArgv('codex', ['codex', '--sandbox', 'danger-full-access', '-m', 'o4', 'write a test'], A))
      .toEqual(['codex', 'resume', '--sandbox', 'danger-full-access', '-m', 'o4', A]);
    expect(claudeProjectDir('/home/user/my.app')).toBe('-home-user-my-app');
  });
});

describe('agent session restore: finding the session', () => {
  const keys: object[] = [];
  afterEach(() => { for (const k of keys.splice(0)) lineEnded(k); });

  it("finds the transcript claude writes, and two terminals in one directory get their own", async () => {
    const { fs } = await createTestShell();
    const dir = `/home/user/.claude/projects/${claudeProjectDir('/home/user/proj')}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${OLD}.jsonl`, '{"old":1}\n'); // an earlier session in the same directory
    const t0 = Date.now() + 5000; // runs that start after it was written
    const one = {}, two = {};
    keys.push(one, two);
    let changes = 0;
    const off = onChange(() => { changes++; });
    expect(lineStarted(one, 'claude --npm', '/home/user/proj', env, fs, t0)).toBe(true);
    expect(lineStarted(two, 'claude', '/home/user/proj', env, fs, t0)).toBe(true);
    expect(lineStarted({}, 'ls -l', '/home/user/proj', env, fs, t0)).toBe(false);
    expect(forTerminal(one)).toBeNull(); // nothing written yet: the old session isn't theirs
    expect(await refresh(fs, one)).toBeNull();

    // claude in terminal one writes its transcript (the fake: a file with a fresh mtime)
    await new Promise((r) => setTimeout(r, 5100));
    await fs.writeFile(`${dir}/${A}.jsonl`, '{"type":"user"}\n');
    expect(await refresh(fs, one)).toBe(A);
    expect(await refresh(fs, two)).toBeNull(); // A is one's
    await fs.writeFile(`${dir}/${B}.jsonl`, '{"type":"user"}\n');
    expect(await refresh(fs, two)).toBe(B);
    expect(await refresh(fs, one)).toBe(A);
    expect(forTerminal(one)).toEqual({ agent: 'claude', sessionId: A, argv: ['claude', '--npm', '--resume', A], line: `claude --npm --resume ${A}`, cwd: '/home/user/proj' });
    expect(forTerminal(two)?.line).toBe(`claude --resume ${B}`);
    expect(changes).toBeGreaterThanOrEqual(4);
    lineEnded(one); // claude exited: nothing to resume there
    expect(forTerminal(one)).toBeNull();
    off();
  }, 20000);

  it('a resumed session is known from the start; codex sessions are found in its dated directory', async () => {
    const { fs } = await createTestShell();
    const k = {};
    keys.push(k);
    lineStarted(k, `claude --resume ${OLD}`, '/home/user', env, fs);
    expect(forTerminal(k)?.argv).toEqual(['claude', '--resume', OLD]);

    const c = {};
    keys.push(c);
    const now = new Date();
    const day = `/home/user/.codex/sessions/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    await fs.mkdir(day, { recursive: true });
    lineStarted(c, 'codex --sandbox danger-full-access', '/home/user', env, fs, Date.now() - 1000);
    await fs.writeFile(`${day}/rollout-2026-10-11T01-02-03-${A}.jsonl`, '{"type":"session_meta"}\n');
    expect(await refresh(fs, c)).toBe(A);
    expect(forTerminal(c)?.line).toBe(`codex resume --sandbox danger-full-access ${A}`);
  });

  it('restoring never resumes one session twice', () => {
    const cmd = (id: string) => ({ agent: 'claude' as const, sessionId: id, argv: ['claude', '--resume', id], line: `claude --resume ${id}`, cwd: '/' });
    expect(dedupe([cmd(A), null, cmd(A), cmd(B)]).map((c) => c?.sessionId ?? null)).toEqual([A, null, null, B]);
  });
});
