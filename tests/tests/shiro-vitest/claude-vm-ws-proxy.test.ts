/**
 * claude --vm's voice stream: Claude Code opens
 * wss://api.anthropic.com/api/ws/speech_to_text/voice_stream with `ws` and an
 * `Authorization: Bearer` header, which the page's WebSocket can't send. The
 * `ws` shim (extract.ts wsShimSource) goes through server.mjs's
 * /api/ws-proxy instead, which opens the upstream with the headers. Here
 * server.mjs runs for real with a local stand-in for the API
 * (TABCOMPUTER_ANTHROPIC_WS_UPSTREAM); the shim runs on tabcomputer's node
 * (in the page under vitest.config.ts, a kernel guest in a Worker under
 * vitest.worker.config.ts). The client side mirrors 2.1.296's voice_stream
 * client: KeepAlive, binary PCM, CloseStream, JSON frames back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { wsShimSource } from '@shiro/claude-vm/extract';
import { createTestShell, run } from './helpers';

const nodeRequire = createRequire(import.meta.url);
const { spawn } = nodeRequire('node:child_process');
const path = nodeRequire('node:path');
const net = nodeRequire('node:net');
const rootRequire = createRequire(path.resolve(__dirname, '../../../server.mjs'));
const { WebSocketServer, WebSocket: NodeWs } = rootRequire('ws');

const serverPath = path.resolve(__dirname, '../../../server.mjs');
let proc: any;
let port = 0;
let upstream: any;
/** What the stand-in API saw: one entry per connection */
const seen: { url: string; headers: Record<string, string>; frames: string[] }[] = [];

const freePort = () => new Promise<number>((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

beforeAll(async () => {
  // The stand-in for api.anthropic.com: /reject answers the upgrade 401;
  // /bye closes with 4001 at once; otherwise the voice_stream protocol
  upstream = new WebSocketServer({
    port: 0,
    verifyClient: (info: any, cb: any) => (info.req.url.startsWith('/reject') ? cb(false, 401, 'Unauthorized') : cb(true)),
  });
  await new Promise((r) => upstream.on('listening', r));
  upstream.on('connection', (ws: any, req: any) => {
    const rec = { url: req.url, headers: req.headers, frames: [] as string[] };
    seen.push(rec);
    if (req.url.startsWith('/bye')) return ws.close(4001, 'bye');
    if (!/^Bearer \S+$/.test(String(req.headers.authorization || ''))) {
      // what the real API sends without it (2.1.296 calls this an "unstructured error frame")
      ws.send(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Invalid authorization' } }));
      return ws.close(1008, 'Invalid authorization');
    }
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      rec.frames.push(isBinary ? `bin:${d.length}:${d[0]},${d[d.length - 1]}` : `text:${d}`);
      if (isBinary) {
        ws.send(JSON.stringify({ type: 'TranscriptInterim', data: `heard ${d.length} bytes` }));
        ws.send(Buffer.from([1, 2, 3, d.length & 255]), { binary: true });
      } else if (String(d) === '{"type":"CloseStream"}') {
        ws.send(JSON.stringify({ type: 'TranscriptText', data: 'hello world' }));
        ws.send(JSON.stringify({ type: 'TranscriptEndpoint' }));
        ws.close(1000);
      }
    });
  });
  port = await freePort();
  proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), STATIC_DIR: __dirname, TABCOMPUTER_TCP_RELAY: '', TABCOMPUTER_ANTHROPIC_WS_UPSTREAM: `ws://127.0.0.1:${upstream.address().port}` },
    stdio: 'pipe',
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    proc.stdout.on('data', (d: Buffer) => { if (String(d).includes('listening')) { clearTimeout(t); resolve(); } });
  });
}, 20000);
afterAll(() => { proc?.kill(); upstream?.close(); });

/** A raw client of /api/ws-proxy: everything it receives, until it closes */
function rawClient(first: object | string, opts: any = {}, after: (ws: any) => void = () => {}) {
  return new Promise<{ got: string[]; code: number; reason: string; status?: number }>((resolve) => {
    const got: string[] = [];
    const ws = new NodeWs(`ws://127.0.0.1:${port}/api/ws-proxy`, opts);
    ws.on('open', () => ws.send(typeof first === 'string' ? first : JSON.stringify(first)));
    let opened = false;
    ws.on('message', (d: Buffer, bin: boolean) => {
      got.push(bin ? `bin:${[...d].join(',')}` : String(d));
      if (!opened) { opened = true; after(ws); }
    });
    ws.on('unexpected-response', (_q: any, res: any) => resolve({ got, code: 0, reason: '', status: res.statusCode }));
    ws.on('close', (code: number, reason: Buffer) => resolve({ got, code, reason: String(reason) }));
    ws.on('error', () => {});
  });
}

const VOICE = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1';

describe('server.mjs /api/ws-proxy', () => {
  it('opens the upstream with the client\'s headers and pipes text, binary and the close', async () => {
    const before = seen.length;
    const r = await rawClient({ url: VOICE, headers: { Authorization: 'Bearer tok-1', 'User-Agent': 'claude-cli/2.1.296', 'x-app': 'cli', Cookie: 'no', Host: 'evil', 'Sec-WebSocket-Key': 'x' } }, {}, (ws) => {
      ws.send('{"type":"KeepAlive"}');
      ws.send(Buffer.from([7, 0, 0, 9]), { binary: true });
      setTimeout(() => ws.send('{"type":"CloseStream"}'), 50);
    });
    expect(r.got[0]).toBe('{"type":"open","protocol":""}');
    expect(r.got.slice(1)).toEqual([
      '{"type":"TranscriptInterim","data":"heard 4 bytes"}', 'bin:1,2,3,4',
      '{"type":"TranscriptText","data":"hello world"}', '{"type":"TranscriptEndpoint"}',
    ]);
    expect(r.code).toBe(1000);
    const s = seen[before];
    expect(s.url).toBe('/api/ws/speech_to_text/voice_stream?encoding=linear16&sample_rate=16000&channels=1');
    expect(s.headers.authorization).toBe('Bearer tok-1');
    expect(s.headers['user-agent']).toBe('claude-cli/2.1.296');
    expect(s.headers['x-app']).toBe('cli');
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers.host).toBe(`127.0.0.1:${upstream.address().port}`);
    expect(s.frames).toEqual(['text:{"type":"KeepAlive"}', 'bin:4:7,9', 'text:{"type":"CloseStream"}']);
  });

  it('passes the upstream\'s close code and reason, and the client\'s', async () => {
    const r = await rawClient({ url: 'wss://api.anthropic.com/bye', headers: { Authorization: 'Bearer t' } });
    expect([r.got[0], r.code, r.reason]).toEqual(['{"type":"open","protocol":""}', 4001, 'bye']);
    const before = seen.length;
    const c = await rawClient({ url: VOICE, headers: { Authorization: 'Bearer t' } }, {}, (ws) => ws.close(4321, 'done'));
    expect(c.code).toBe(4321);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBe(before + 1);
  });

  it('reports an upgrade the upstream refuses with its HTTP status', async () => {
    const r = await rawClient({ url: 'wss://api.anthropic.com/reject', headers: {} });
    expect(JSON.parse(r.got[0])).toMatchObject({ type: 'unexpected-response', status: 401 });
  });

  it('reaches nothing but wss://api.anthropic.com', async () => {
    const before = seen.length;
    for (const url of ['wss://example.com/x', 'ws://api.anthropic.com/x', 'wss://api.anthropic.com:8443/x', 'wss://api.anthropic.com.evil.com/x', 'wss://u:p@api.anthropic.com/x', 'nonsense']) {
      const r = await rawClient({ url, headers: {} });
      expect(JSON.parse(r.got[0]).type).toBe('error');
      expect(r.code).toBe(1008);
    }
    expect((await rawClient('not json')).code).toBe(1008);
    expect(seen.length).toBe(before);
  });

  it('refuses another site\'s page (its Origin), takes this one\'s', async () => {
    expect((await rawClient({ url: VOICE }, { origin: 'https://evil.example' })).status).toBe(403);
    const r = await rawClient({ url: VOICE, headers: { Authorization: 'Bearer t' } }, { origin: `http://127.0.0.1:${port}` }, (ws) => ws.close(1000));
    expect(r.got[0]).toBe('{"type":"open","protocol":""}');
  });
});

describe("claude --vm's ws shim", () => {
  /** Claude Code 2.1.296's voice_stream client, cut down: its options, frames and handlers */
  const client = (url: string, auth: boolean) => `
const WebSocket = require('ws');
const out = [];
const s = new WebSocket(${JSON.stringify(url)}, { headers: ${auth ? "{ Authorization: 'Bearer oauth-tok', 'User-Agent': 'claude-cli/2.1.296 (external, cli)', 'x-app': 'cli', 'anthropic-client-platform': 'linux' }" : '{}'}, proxy: undefined, tls: undefined });
out.push('state ' + s.readyState);
s.on('open', () => {
  out.push('open ' + s.readyState);
  s.send('{"type":"KeepAlive"}');
  s.send(Buffer.from(new Uint8Array(2048).fill(5)));
  setTimeout(() => s.send('{"type":"CloseStream"}'), 50);
});
s.on('message', (r, bin) => out.push((bin ? 'bin ' + [...r].join(',') : 'msg ' + r.toString())));
s.on('unexpected-response', (q, res) => { out.push('rejected ' + res.statusCode); res.resume(); });
s.on('error', (e) => out.push('error ' + e.message));
s.on('close', (code, reason) => { out.push('close ' + code + ' ' + reason.toString() + ' ' + s.readyState); console.log(JSON.stringify(out)); });
`;

  async function runClient(url: string, auth = true) {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/wsx/node_modules/ws', { recursive: true });
    await fs.writeFile('/tmp/wsx/node_modules/ws/index.js', wsShimSource());
    await fs.writeFile('/tmp/wsx/node_modules/ws/package.json', JSON.stringify({ name: 'ws', main: 'index.js' }));
    await fs.writeFile('/tmp/wsx/voice.js', client(url, auth));
    const r = await run(shell, `cd /tmp/wsx && TABCOMPUTER_VM_WS_PROXY=http://127.0.0.1:${port} node voice.js`);
    const line = r.output.trim().split('\n').filter((l) => l.startsWith('[')).pop();
    expect(line, r.output).toBeTruthy();
    return JSON.parse(line!) as string[];
  }

  it('the voice stream: Authorization reaches the API, frames go both ways', async () => {
    const before = seen.length;
    const out = await runClient(VOICE);
    expect(out).toEqual([
      'state 0', 'open 1',
      'msg {"type":"TranscriptInterim","data":"heard 2048 bytes"}', 'bin 1,2,3,0',
      'msg {"type":"TranscriptText","data":"hello world"}', 'msg {"type":"TranscriptEndpoint"}',
      'close 1000  3',
    ]);
    const s = seen[before];
    expect(s.headers.authorization).toBe('Bearer oauth-tok');
    expect(s.headers['user-agent']).toBe('claude-cli/2.1.296 (external, cli)');
    expect(s.headers['anthropic-client-platform']).toBe('linux');
    expect(s.frames).toEqual(['text:{"type":"KeepAlive"}', 'bin:2048:5,5', 'text:{"type":"CloseStream"}']);
  });

  it('without the header, the API\'s own error frame and close come through', async () => {
    const out = await runClient(VOICE, false);
    expect(out[1]).toBe('open 1');
    expect(JSON.parse(out[2].slice(4))).toMatchObject({ type: 'error', error: { message: 'Invalid authorization' } });
    expect(out.at(-1)).toBe('close 1008 Invalid authorization 3');
  });

  it('an upgrade refused upstream is ws\'s unexpected-response', async () => {
    const out = await runClient('wss://api.anthropic.com/reject');
    expect(out).toEqual(['state 0', 'rejected 401', 'close 1006  3']);
  });

  it('the server\'s close code reaches the client', async () => {
    const out = await runClient('wss://api.anthropic.com/bye');
    expect(out).toEqual(['state 0', 'open 1', 'close 4001 bye 3']);
  });

  it('other URLs still go to the page\'s WebSocket directly', async () => {
    const before = seen.length;
    const out = await runClient(`ws://127.0.0.1:${upstream.address().port}/direct`, false);
    expect(out[1]).toBe('open 1');
    expect(seen[before].url).toBe('/direct');
    expect(seen[before].headers.authorization).toBeUndefined();
  });

  it('a process knows the page\'s origin for the route (a guest too: not its Worker\'s)', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, `node -e "console.log(require('tabcomputer:claude-vm').origin())"`);
    // (setup.ts's page location)
    expect(r.output.trim()).toBe('http://shiro.test');
  });
});
