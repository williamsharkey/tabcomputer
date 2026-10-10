/**
 * A named pipe is not a regular file (tabcomputer#21 follow-up): stat's
 * isFile() is false and isFIFO() true, so test -f, [[ -f ]], find -type f,
 * stat %F, cp -r/-a, tar and node's fs.Stats all see a FIFO, as on Linux.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await sh('rm -rf /tmp/ff && mkdir -p /tmp/ff/d && cd /tmp/ff && mkfifo d/p && echo x > d/r');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('a FIFO is not a regular file', () => {
  it('fs.stat', async () => {
    const st = await fs.stat('/tmp/ff/d/p');
    expect(st.isFile()).toBe(false);
    expect(st.isFIFO()).toBe(true);
    expect((await fs.stat('/tmp/ff/d/r')).isFile()).toBe(true);
  });

  it('test, [[ ]], find', async () => {
    expect((await sh('test -f d/p; echo $?; test -p d/p; echo $?; [[ -f d/p ]]; echo $?; [[ -p d/p ]]; echo $?')).out).toBe('1\n0\n1\n0\n');
    expect((await sh('find d -type f; find d -type p')).out).toBe('d/r\nd/p\n');
  });

  it('stat names the type', async () => {
    expect((await sh("stat -c '%n %F' d/p d/r d")).out).toBe('d/p fifo\nd/r regular file\nd directory\n');
  });

  it('cp -r and cp -a make a FIFO, tar archives and extracts one', async () => {
    expect((await sh('cp -r d d2 && stat -c %F d2/p; cp -a d d3 && stat -c %F d3/p')).out).toBe('fifo\nfifo\n');
    const r = await sh('tar cf t.tar d && mkdir x && tar xf t.tar -C x && stat -c %F x/d/p && cat x/d/r && tar tvf t.tar | grep -c "^p"');
    expect(r.out).toBe('fifo\nx\n1\n');
  });

  it("node's fs.Stats and Dirents", async () => {
    const r = await sh(`node -e 'const fs=require("fs");const s=fs.statSync("/tmp/ff/d/p");console.log(s.isFile(),s.isFIFO(),(s.mode&0o170000).toString(8));console.log(fs.readdirSync("/tmp/ff/d",{withFileTypes:true}).map(d=>d.name+":"+d.isFile()+":"+d.isFIFO()).join(" "))'`);
    expect(r.out).toBe('false true 10000\np:false:true r:true:false\n');
  });
});
