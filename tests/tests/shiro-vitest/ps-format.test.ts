/**
 * The builtin ps in procps-ng's formats: -o/-eo column lists with procps'
 * headers, -ef, aux, -p, `col=` headers; kernel processes' fields from /proc.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestOS } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => {
  ({ shell } = await createTestOS());
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('ps formats (procps-ng)', () => {
  it('-eo honours the columns, with procps headers', async () => {
    const r = await sh('ps -eo pid,ppid,pgid,sid,stat,user,uid,time,tty,comm,args');
    expect(r.out).toMatch(/^  PID  PPID  PGID   SID STAT USER       UID     TIME TT       COMMAND         COMMAND\n    1     0     1     1 \w+ +user      1000 00:00:\d\d \?        bash +bash\n/);
  });
  it('the default, -ef and aux', async () => {
    expect((await sh('ps')).out).toMatch(/^  PID TTY          TIME CMD\n    1 \?        00:00:\d\d bash\n/);
    expect((await sh('ps -ef')).out).toMatch(/^UID        PID  PPID  C STIME TTY          TIME CMD\nuser         1     0  0 \d\d:\d\d \?        00:00:\d\d bash\n/);
    expect((await sh('ps aux')).out).toMatch(/^USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\nuser         1 +\d+\.\d +0\.0 +0 +0 \? +\w+ +\d\d:\d\d +0:\d\d bash\n/);
  });
  it('-p, blank and renamed headers, an unknown column', async () => {
    expect((await sh('ps -p 1 -o pid=,comm=')).out).toBe('    1 bash\n');
    expect((await sh('ps -p 1 -o pid=ID,ppid')).out).toBe('   ID  PPID\n    1     0\n');
    expect((await sh('ps -p 99999 -o pid=; echo $?')).out).toBe('1\n');
    expect(await sh('ps -o bogus')).toMatchObject({ code: 1, err: expect.stringContaining('unknown user-defined format specifier "bogus"') });
  });
  it("the page's own processes too: a background job's ppid and state", async () => {
    const r = await sh('sleep 2 & ps -o pid,ppid,stat,comm; kill %1');
    expect(r.out).toMatch(/\n +\d+ +1 S    sleep\n/);
  });
});
