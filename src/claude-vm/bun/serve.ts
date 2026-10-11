/**
 * Bun.serve over the process's own `http` (node-compat's in the page). Each
 * request becomes a web Request for `fetch(req, server)` or a `routes` entry
 * (exact paths, `:param`s, `*`; a Response, a handler, or one per method);
 * the Response it gives (or promises) is written back, its body streamed. A
 * handler that throws gives `error(err)`'s Response, else a 500. The server:
 * port, hostname, url, stop(), reload(), fetch(), requestIP(), as Bun's.
 */

export interface ServeEnv { http?: any; Buffer?: any }

type Handler = (req: Request, server?: any) => Response | Promise<Response> | undefined;
type Route = Response | Handler | Record<string, Response | Handler>;

interface ServeOptions {
  fetch?: Handler;
  routes?: Record<string, Route | false>;
  error?: (err: Error) => Response | Promise<Response>;
  hostname?: string;
  port?: number | string;
  development?: boolean;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  id?: string;
}

/** A route pattern as a matcher: its params, or null */
function routeMatcher(pattern: string): { score: number; match(path: string): Record<string, string> | null } {
  const names: string[] = [];
  let wild = false;
  const re = pattern.split('/').map((seg) => {
    if (seg === '*') { wild = true; return '.*'; }
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const rx = new RegExp('^' + re + '$');
  return {
    // exact before params before wildcards
    score: wild ? 0 : names.length ? 1 : 2,
    match(path: string) {
      const m = rx.exec(path);
      if (!m) return null;
      const params: Record<string, string> = {};
      names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return params;
    },
  };
}

export function serve(env: ServeEnv, opts: ServeOptions) {
  const http = env.http;
  if (!http) throw new Error('Bun.serve needs the process\'s http module');
  if (typeof opts?.fetch !== 'function' && !opts?.routes) {
    throw new TypeError('Bun.serve() needs either:\n\n  - A routes object:\n     routes: {\n       "/path": {\n         GET: (req) => new Response("Hello")\n       }\n     }\n\n  - Or a fetch handler:\n     fetch: (req) => {\n       return new Response("Hello")\n     }\n\nLearn more at https://bun.com/docs/api/http');
  }
  let options = opts;
  let routes = compileRoutes(opts.routes);
  const peers = new WeakMap<Request, { address: string; family: string; port: number }>();
  let pending = 0;
  const hostname = opts.hostname ?? '0.0.0.0';
  const port = opts.port ?? 3000;

  async function handle(req: Request, srv: any): Promise<Response> {
    const path = new URL(req.url).pathname;
    for (const r of routes) {
      const params = r.match(path);
      if (!params) continue;
      let target: any = r.target;
      if (target === false) break;
      if (target && typeof target === 'object' && !(target instanceof Response)) target = target[req.method] ?? (req.method === 'HEAD' ? target.GET : undefined);
      if (!target) continue;
      Object.defineProperty(req, 'params', { value: params, configurable: true });
      return target instanceof Response ? target.clone() : await target(req, srv);
    }
    if (options.fetch) {
      const res = await options.fetch.call(srv, req, srv);
      if (res instanceof Response) return res;
      throw new TypeError('Expected a Response object, but received ' + (res === undefined ? "'undefined'" : typeof res));
    }
    return new Response('Not Found', { status: 404 });
  }

  const server: any = http.createServer(async (inc: any, out: any) => {
    pending++;
    try {
      const host = inc.headers?.host ?? `${hostname === '0.0.0.0' ? 'localhost' : hostname}:${api.port}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(inc.headers ?? {})) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, String(x)); else if (v !== undefined) headers.set(k, String(v));
      }
      let body: Uint8Array | undefined;
      if (inc.method !== 'GET' && inc.method !== 'HEAD') {
        const chunks: Uint8Array[] = [];
        for await (const c of inc) chunks.push(typeof c === 'string' ? new TextEncoder().encode(c) : c);
        const n = chunks.reduce((a, c) => a + c.length, 0);
        body = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) { body.set(c, at); at += c.length; }
      }
      const req = new Request(`http://${host}${inc.url}`, { method: inc.method, headers, body: body as BodyInit | undefined });
      const sock = inc.socket ?? {};
      peers.set(req, { address: sock.remoteAddress ?? '127.0.0.1', family: (sock.remoteAddress ?? '').includes(':') ? 'IPv6' : 'IPv4', port: sock.remotePort ?? 0 });
      let res: Response;
      try { res = await handle(req, api); }
      catch (e: any) {
        if (options.error) {
          try { res = await options.error(e); } catch { res = new Response('Internal Server Error', { status: 500 }); }
        } else {
          res = new Response('Internal Server Error', { status: 500 });
        }
      }
      const outHeaders: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => { if (k !== 'set-cookie') outHeaders[k] = v; });
      const cookies = (res.headers as any).getSetCookie?.() ?? [];
      if (cookies.length) outHeaders['set-cookie'] = cookies;
      out.writeHead(res.status, res.statusText || undefined, outHeaders);
      if (res.body && inc.method !== 'HEAD') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(env.Buffer ? env.Buffer.from(value) : value);
        }
      }
      out.end();
    } catch {
      try { out.statusCode = 500; out.end(); } catch { /* gone */ }
    } finally {
      pending--;
    }
  });
  server.on('error', () => { /* (a failed bind: port stays as asked) */ });
  server.listen(Number(port), hostname);

  const api: any = {
    get port(): number { return server.address()?.port ?? Number(port); },
    hostname,
    get url(): URL { return new URL(`http://${hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname}:${api.port}/`); },
    development: opts.development ?? false,
    id: opts.id ?? '',
    get pendingRequests() { return pending; },
    pendingWebSockets: 0,
    stop(closeActive = false): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
        if (closeActive) server.closeAllConnections?.();
      });
    },
    reload(o: ServeOptions) {
      options = { ...options, ...o };
      if (o.routes) routes = compileRoutes(o.routes);
      return api;
    },
    /** A request handled without the network (Bun gives the handler no server) */
    fetch: (input: Request | string, init?: RequestInit) => handle(input instanceof Request ? input : new Request(input, init), undefined),
    requestIP: (req: Request) => peers.get(req) ?? null,
    timeout() {},
    upgrade: () => false,
    publish: () => 0,
    subscriberCount: () => 0,
    ref() { server.ref?.(); },
    unref() { server.unref?.(); },
  };
  return api;
}

function compileRoutes(routes?: Record<string, Route | false>) {
  return Object.entries(routes ?? {})
    .map(([pattern, target]) => ({ ...routeMatcher(pattern), target }))
    .sort((a, b) => b.score - a.score);
}
