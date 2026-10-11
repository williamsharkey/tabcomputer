// A local Messages API for Claude Code sessions in the bench: streamed mock
// replies, no credentials, no network. ANTHROPIC_BASE_URL points here
// (node-compat/process.ts sets its own only when unset).
// - `claude --npm` fetches from a Worker, out of Playwright's routes, so this
//   is a real server on this machine (with CORS for the page's origin).
// - Native Claude Code (Blink) connects through server.mjs's TCP relay, which
//   reaches only allow-listed ports: run.mjs starts one on a fixed port for
//   the `claude` suite and passes that port to the relay.
// Bind this machine's address, not localhost: a guest's fetch of localhost
// goes to its own in-tab servers.
import { createServer } from 'node:http';

function sse(events) { return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''); }

/** A Messages API reply: `text` streamed in small deltas (or one JSON body when not streaming). */
export function mockMessage(body, text) {
  const model = body.model || 'claude-sonnet-4-5';
  const usage = { input_tokens: 12, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const id = `msg_bench_${Math.random().toString(36).slice(2, 10)}`;
  if (!body.stream) return { contentType: 'application/json', body: JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }) };
  const words = text.match(/\S+\s*/g) || [text];
  return {
    contentType: 'text/event-stream',
    body: sse([
      ['message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ...words.map((w) => ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: w } }]),
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } }],
      ['message_stop', {}],
    ]),
  };
}

/** A key the mock accepts; Claude Code wants one shaped like a real key. */
export const FAKE_KEY = 'sk-ant-api03-bench-not-a-real-key-000000000000000000000000';

/**
 * Starts the server on `host` (`port` 0 = any). A user turn containing
 * "bench turn N" gets a reply starting BENCH-REPLY-N; side calls (titles,
 * topic checks) get "ok". { url, port, calls(), paths, close() }.
 */
export async function startMockModel(host, port = 0) {
  let n = 0;
  const paths = [];
  const server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const path = new URL(req.url, 'http://x').pathname;
      if (paths.length < 200) paths.push(`${req.method} ${path}`);
      if (/\/v1\/messages\/count_tokens/.test(path)) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end('{"input_tokens":12}'); return; }
      if (/\/v1\/messages/.test(path)) {
        // the newest "bench turn N" anywhere in the request: builds differ in where the user's text
        // sits (native 2.1.x appends reminder blocks after it)
        const turns = [...raw.matchAll(/bench turn (\d+)/g)].map((m) => Number(m[1]));
        const turn = turns.length ? Math.max(...turns) : null;
        const text = turn ? `BENCH-REPLY-${turn} ` + 'Here is a mocked answer with a few sentences of text so the terminal renders a streamed reply. '.repeat(4) : 'ok';
        n++;
        const m = mockMessage(body, text);
        res.writeHead(200, { ...cors, 'content-type': m.contentType, 'request-id': `req_bench_${n}` });
        res.end(m.body);
        return;
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }); res.end('{}');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const p = server.address().port;
  return { url: `http://${host}:${p}`, port: p, calls: () => n, paths, close: () => new Promise((r) => server.close(r)) };
}
