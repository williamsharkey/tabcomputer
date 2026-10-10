/**
 * tabcomputer#22: eval with a here-document whose body holds shell keywords
 * (`if`, `case`, `{`, `done`): the body is data, not syntax, so eval neither
 * reports "syntax error" nor rewrites a quoted `<<` before eval sees it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('eval and here-document bodies', () => {
  it('writes a file whose quoted body has if/case/{ (an agent file write)', async () => {
    const body = 'if [ -n "$1" ]; then\n  case $1 in\n    a) { echo a; } ;;\n  esac\nfi\n# a comment line\n';
    const r = await sh(`eval "cat > /tmp/w22.sh <<'EOF'\n${body.replace(/[$"\\]/g, '\\$&')}EOF"; echo st=$?`);
    expect(r.out).toBe('st=0\n');
    expect(await fs.readFile('/tmp/w22.sh', 'utf8')).toBe(body);
  });

  it('a "X" and an unquoted delimiter too', async () => {
    expect((await sh(`eval 'cat <<"X"\nfi }\ndone\nX'; echo st=$?`)).out).toBe('fi }\ndone\nst=0\n');
    expect((await sh(`eval 'cat <<X\nesac\nX'; echo st=$?`)).out).toBe('esac\nst=0\n');
  });

  it('a here-document inside an evaluated if', async () => {
    expect((await sh(`eval 'if true; then cat <<E\nin if\nE\nfi'; echo st=$?`)).out).toBe('in if\nst=0\n');
  });

  it('still reports a real syntax error, outside the body', async () => {
    const r = await sh(`eval 'if true; then cat <<E\nfi\nE\n'; echo st=$?`);
    expect(r.out).toMatch(/eval: syntax error[^\n]*\nst=2\n$/);
  });

  it('a quoted << is a word, not a here-document', async () => {
    expect((await sh(`echo 'a <<B\nb'`)).out).toBe('a <<B\nb\n');
  });
});
