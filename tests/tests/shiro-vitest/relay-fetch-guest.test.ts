/**
 * fetch() of a site without CORS headers from node as a kernel guest (a
 * Worker: claude --vm's WebFetch and remote MCP servers, any node script):
 * after the page's fetch refuses it, the request goes over the guest's own
 * sockets (src/commands/relay-fetch.ts), as node in the page goes over the
 * page's. Here the guest's sockets are a stand-in that answers HTTP.
 */
import { describe, it, expect } from 'vitest';
import { relayFetch, type SocketStack } from '@shiro/commands/relay-fetch';

function standInSockets(seen: string[]): SocketStack {
  return {
    socket: () => {
      let reply: Uint8Array | null = null;
      let sent = false;
      return {
        connectHost: async (host: string, port: number) => { seen.push(`connect ${host}:${port}`); return 0; },
        write: async (b: Uint8Array) => {
          const req = new TextDecoder().decode(b);
          seen.push(req.split('\r\n')[0]);
          const body = 'no cors here';
          reply = new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
          return b.length;
        },
        read: async (buf: Uint8Array) => {
          for (let i = 0; i < 100 && !reply; i++) await new Promise((r) => setTimeout(r, 5));
          if (!reply || sent) return 0;
          sent = true;
          buf.set(reply);
          return reply.length;
        },
        close: () => {},
      };
    },
  };
}

describe("relayFetch over a kernel guest's sockets", () => {
  it('connects with the guest\'s own socket, not the page\'s network stack', async () => {
    const seen: string[] = [];
    // (the Worker's own fetch brings the TLS roots from the page's origin)
    const pageFiles: string[] = [];
    const workerFetch = (async (u: string) => { pageFiles.push(String(u)); return new Response(''); }) as typeof fetch;
    const r = await relayFetch('http://example.test/page?q=1', { headers: { 'x-a': '1' } }, { sockets: standInSockets(seen), fetch: workerFetch });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('no cors here');
    expect(seen).toEqual(['connect example.test:80', 'GET /page?q=1 HTTP/1.1']);
    expect(pageFiles.every((u) => u.endsWith('browse/cacert.pem'))).toBe(true);
  });
});
