/**
 * http.Server and net.Server have node's `_handle` while listening (null
 * before listen and after close). supertest closes the server it started only
 * `if (server._handle)`, so without it a mocha + supertest suite (jshttp/vary)
 * passed and then never exited.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });
const node = async (code: string) => (await run(shell, `node -e '${code}' < /dev/null`)).output.replace(/\r\n/g, '\n');

describe('server._handle', () => {
  it('http.Server: null, then set while listening, then null after close', async () => {
    const out = await node(`const s = require("http").createServer(() => {}); console.log("before", s._handle === null || s._handle === undefined); s.listen(0, () => { console.log("listening", !!s._handle); s.close(() => console.log("closed", s._handle === null)); });`);
    expect(out).toBe('before true\nlistening true\nclosed true\n');
  });

  it('net.Server: the same', async () => {
    const out = await node(`const s = require("net").createServer(() => {}); console.log("before", !s._handle); s.listen(0, "127.0.0.1", () => { console.log("listening", !!s._handle); s.close(() => console.log("closed", s._handle === null)); });`);
    expect(out).toBe('before true\nlistening true\nclosed true\n');
  });

  it("supertest's pattern ends: a server it started is closed, and the script exits", async () => {
    const out = await node(`const http = require("http"); const s = http.createServer((q, r) => r.end("ok")); s.listen(0, () => { http.get({ port: s.address().port, path: "/" }, (res) => { res.resume(); res.on("end", () => { if (s._handle) s.close(() => console.log("closed by the _handle check")); }); }); });`);
    expect(out).toBe('closed by the _handle check\n');
  });
});
