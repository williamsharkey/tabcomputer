/**
 * `node -e` stays alive until a fetch body is read (tabcomputer#50): the
 * Response settles with the headers, and a slow or large chunked body used
 * to arrive with nothing pending, so the script exited 0 mid-download.
 * The bodies come from a server on this host at 127.0.0.2, which node fetches
 * as it does any outside site (localhost and 127.0.0.1 are tabcomputer's own).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

// (the real http module: vite-plugin-node-polyfills aliases `http` to a browser one)
const http: typeof import('node:http') = createRequire(import.meta.url)('node:http');
const LARGE = 8 * 1024 * 1024;
let server: Server;
let base = '';
let cleanup: () => void;

beforeAll(async () => {
  cleanup = await installNodeWorker();
  // Chunked (no length), with gaps longer than the runner's 150 ms idle check.
  // slow: 6 chunks of 1 KiB, 400 ms apart; large: 8 MiB in 64 KiB chunks, 2 ms apart, 400 ms after every 32nd
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const [count, size, every] = req.url === '/slow' ? [6, 1024, 1] : [LARGE / 65536, 65536, 32];
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i++ === count) return void res.end();
      res.write(Buffer.alloc(size, 120));
      setTimeout(next, i % every ? 2 : 400);
    };
    next();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
  base = `http://127.0.0.2:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(() => { server?.close(); cleanup?.(); });

const READER = `(async()=>{const r=await fetch(process.argv[1]);const rd=r.body.getReader();let n=0;for(;;){const {done,value}=await rd.read();if(done)break;n+=value.length}console.log("done",n)})()`;
const BUFFER = `(async()=>{const r=await fetch(process.argv[1]);console.log("done",(await r.arrayBuffer()).byteLength)})()`;
const ITERATE = `(async()=>{const r=await fetch(process.argv[1]);let n=0;for await(const c of r.body)n+=c.length;console.log("done",n)})()`;

describe.each([['as a kernel guest', ''], ['in the page', 'export TABCOMPUTER_NODE_WORKER=0; ']])('node %s: a fetch body being read keeps the script alive (#50)', (_where, env) => {
  it.each([
    ['slow', 'reader.read()', READER, 6 * 1024],
    ['slow', 'arrayBuffer()', BUFFER, 6 * 1024],
    ['large', 'reader.read()', READER, LARGE],
    ['large', 'arrayBuffer()', BUFFER, LARGE],
    ['large', 'for await', ITERATE, LARGE],
  ])('%s body, %s: "done N", rc 0', async (kind, _how, js, bytes) => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(`${env}node -e '${js}' ${base}/${kind} < /dev/null; echo "rc=$?"`, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe(`done ${bytes}\nrc=0\n`);
  }, 60_000);
});
