/**
 * The node http client (src/node-compat/modules/http.ts): Claude Code's sign-in
 * posts the token exchange through axios's http adapter, which calls https.request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createHttpsModule } from '@shiro/node-compat/modules/http';
import { Readable } from 'stream';
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';

const origFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = origFetch; });

describe('https.request', () => {
  it('posts a body and returns the response, the way axios reads it', async () => {
    let seen = '';
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen = `${String(url)} ${init?.method} ${init?.body}`;
      return new Response('{"access_token":"t"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const https = createHttpsModule({
      ctx: {} as never,
      iframeServer: { serve: () => () => {}, createIframe: async () => ({}) },
      fakeConsole: { log() {}, warn() {} },
      getBuiltinModule: (name: string) => {
        if (name === 'stream') return { Readable };
        if (name === 'buffer') return { Buffer };
        if (name === 'events') return EventEmitter;
        throw new Error(name);
      },
    });
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request({
        protocol: 'https:',
        hostname: 'platform.claude.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }, (res: { on: (ev: string, fn: (c?: Buffer) => void) => void; statusCode: number }) => {
        const chunks: Buffer[] = [];
        expect(res.statusCode).toBe(200);
        res.on('data', (c) => { if (c) chunks.push(c); });
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        res.on('error', reject);
      });
      expect(req.destroyed).toBe(false);
      req.on('error', reject);
      req.end('grant_type=authorization_code&code=abc');
    });
    expect(seen).toBe('https://platform.claude.com/v1/oauth/token POST grant_type=authorization_code&code=abc');
    expect(body).toBe('{"access_token":"t"}');
  });
});
