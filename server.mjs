/**
 * Shiro unified server — static files + API proxy + OAuth callback + WebSocket relay
 * + opt-in WebSocket-to-TCP relay for kernel sockets (TABCOMPUTER_TCP_RELAY=1, see docs/NETWORKING.md).
 * Single Node.js process; depends on `ws` (and optionally `undici`).
 */

import { createServer } from 'node:http';
import { readFile, writeFile, stat, readdir, unlink, mkdir, rename, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { realpathSync, readFileSync, readdirSync, createReadStream } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';

const PORT = process.env.PORT || 3000;
const STATIC_DIR = process.env.STATIC_DIR || '/opt/tabcomputer/public';

// --- Cross-origin isolation ---
// COOP same-origin + COEP credentialless make the app page crossOriginIsolated,
// which turns on SharedArrayBuffer and Atomics.wait (needed for blocking
// syscalls from worker processes; see docs/UNIX_COMPAT.md). credentialless
// (not require-corp) lets no-cors CDN loads (Pyodide, esm.sh, fonts) through
// without CORP headers; they just go out without cookies.
// TABCOMPUTER_ISOLATION=0 turns it off.
export function isolationEnabled() {
  return process.env.TABCOMPUTER_ISOLATION !== '0';
}

export function isolationHeaders() {
  if (!isolationEnabled()) return {};
  return {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'credentialless',
  };
}

// --- MIME types ---
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain', '.sh': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.mjs': 'application/javascript',
};

// --- API proxy ---
// Node's built-in fetch gives up if response headers take over 5 minutes. A
// non-streaming model call only sends headers when the whole reply is done, so
// long ones died at exactly 5:00 ("fetch failed") and Claude Code sat waiting.
// undici (installed next to server.mjs on the host) lets the proxy wait as long
// as the client does; without it we fall back to the built-in fetch.
let upstreamFetch = fetch;
try {
  const { Agent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  upstreamFetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
} catch { console.warn('[proxy] undici not installed; upstream calls time out after 5 minutes'); }

const PROXY_TARGETS = {
  'anthropic': 'https://api.anthropic.com',
  'platform': 'https://platform.claude.com',
  'mcp-proxy': 'https://mcp-proxy.anthropic.com',
  // Gemini CLI: Google's API rejects its preflights (custom x-goog headers)
  'gemini': 'https://generativelanguage.googleapis.com',
  'github': 'https://api.github.com',
  // GitHub's OAuth device flow lives on github.com, which has no CORS
  'github-login': 'https://github.com',
};

// Only these paths may be proxied per target (targets not listed are unrestricted)
const PROXY_ALLOWED_PATHS = {
  'github-login': ['/login/device/code', '/login/oauth/access_token'],
};

const SKIP_REQUEST_HEADERS = new Set([
  // hop-by-hop: fetch rejects upgrade/expect (UND_ERR_INVALID_ARG/NOT_SUPPORTED),
  // and nginx adds Upgrade for the /tcp WebSocket, which broke git-proxy POSTs
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'accept-encoding',
  'upgrade', 'expect', 'te', 'trailer', 'proxy-connection', 'proxy-authorization',
  // fetch sets Content-Length from the body; newer Node rejects a caller's
  'content-length',
  'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-user', 'anthropic-dangerous-direct-browser-access',
  'user-agent',  // Browser UA causes API to reject OAuth tokens
]);

// Node fetch auto-decompresses, so strip encoding headers from upstream responses
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
]);

// The git proxy also drops WWW-Authenticate: a browser answers it with a native
// login prompt that stalls the request (and later ones to the origin). Git
// clients still see the 401 and supply credentials themselves.
const SKIP_GIT_RESPONSE_HEADERS = new Set([...SKIP_RESPONSE_HEADERS, 'www-authenticate']);

const DEFAULT_CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'x-app',
  'x-stainless-arch',
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-package-version',
  'x-stainless-retry-count',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-timeout',
  'mcp-session-id',
];

function buildAllowedHeaders(requestHeaders) {
  const requested = String(requestHeaders || '')
    .split(',')
    .map((header) => header.trim())
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_CORS_ALLOW_HEADERS, ...requested])).join(', ');
}

export function corsHeaders(origin, requestHeaders) {
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': buildAllowedHeaders(requestHeaders),
    'access-control-expose-headers': 'x-request-id, request-id, x-oauth-scopes, anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, anthropic-ratelimit-tokens-limit, anthropic-ratelimit-tokens-remaining, retry-after, mcp-session-id',
    'access-control-max-age': '86400',
    'vary': 'Origin, Access-Control-Request-Headers',
  };
}

async function handleProxy(req, res, pathAfterApi) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // Log all proxy requests for debugging
  console.log(`[proxy] ${req.method} /api/${pathAfterApi}`);

  const slashIdx = pathAfterApi.indexOf('/');
  const target = slashIdx === -1 ? pathAfterApi : pathAfterApi.slice(0, slashIdx);
  const rest = slashIdx === -1 ? '/' : pathAfterApi.slice(slashIdx);
  const base = PROXY_TARGETS[target];

  if (!base) {
    res.writeHead(404, cors);
    return res.end(`Unknown API target: ${target}`);
  }

  const allowed = PROXY_ALLOWED_PATHS[target];
  if (allowed && (!allowed.includes(rest) || req.method !== 'POST')) {
    res.writeHead(403, cors);
    return res.end(`Not allowed: ${req.method} ${target}${rest}`);
  }

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // Build upstream headers
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers['host'] = new URL(base).host;
  // Replace browser UA with Node.js-like UA to avoid API rejecting OAuth from browsers
  headers['user-agent'] = 'node-fetch/1.0 (+https://github.com/node-fetch/node-fetch)';

  try {
    const url = new URL(rest, base);
    // Preserve query string from original request
    const origUrl = new URL(req.url, 'http://localhost');
    url.search = origUrl.search;

    // One line per model call: size, streaming, and time to first byte of headers
    let callInfo = '';
    if (rest.startsWith('/v1/messages') && body.length) {
      try {
        const j = JSON.parse(body.toString());
        callInfo = ` model=${j.model} stream=${!!j.stream} max_tokens=${j.max_tokens} bytes=${body.length}`;
      } catch { /* not JSON */ }
    }
    const t0 = Date.now();
    const upstream = await upstreamFetch(url.toString(), {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
      duplex: 'half',
    });
    if (callInfo) console.log(`[proxy] messages${callInfo} → ${upstream.status} headers in ${Date.now() - t0}ms`);

    const respHeaders = { ...cors };
    // Allow-listed targets are github.com pages: pass only the body's type. Their
    // headers (long CSP, cookies) overflow nginx's proxy buffer (502) and the page
    // has no use for them.
    const passHeader = allowed ? (k) => k.toLowerCase() === 'content-type' : (k) => !SKIP_RESPONSE_HEADERS.has(k.toLowerCase());
    for (const [k, v] of upstream.headers) {
      if (passHeader(k)) respHeaders[k] = v;
    }
    // Stream event-streams straight through. nginx buffers proxied responses by
    // default, so while a model thinks (only tiny keep-alive pings) the browser saw
    // nothing, not even headers, for minutes, then the whole reply at once.
    if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
      respHeaders['x-accel-buffering'] = 'no';
      respHeaders['cache-control'] = 'no-cache';
    }

    console.log(`[proxy] ${req.method} /api/${pathAfterApi} → ${upstream.status}`);
    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      // For model streams, note how each one ends: an `event: error` from the API
      // (overloaded, etc.), an upstream read failure, or the browser going away.
      const isStream = callInfo && (upstream.headers.get('content-type') || '').includes('text/event-stream');
      let bytes = 0, sawStop = false, apiError = '';
      let clientGone = false;
      res.on('close', () => {
        if (!res.writableFinished) clientGone = true;
        // A non-streaming reply only arrives when complete; say whether it reached the browser
        if (callInfo && !isStream) console.log(`[proxy] reply ${res.writableFinished ? 'delivered' : 'NOT delivered (browser went away)'}: ${bytes} bytes, ${Date.now() - t0}ms`);
      });
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (isStream) {
            const text = Buffer.from(value).toString();
            if (text.includes('message_stop')) sawStop = true;
            const m = text.match(/event: error\ndata: (.*)/);
            if (m) apiError = m[1].slice(0, 300);
          }
          if (clientGone) { reader.cancel().catch(() => {}); break; }
          res.write(value);
        }
        res.end();
      };
      pump().then(() => {
        if (isStream && (!sawStop || apiError || clientGone)) {
          console.log(`[proxy] stream ended early: ${bytes} bytes in ${Date.now() - t0}ms` +
            `${apiError ? ` api error: ${apiError}` : ''}${clientGone ? ' (browser closed it)' : ''}` +
            `${!sawStop && !apiError && !clientGone ? ' (no message_stop from upstream)' : ''}`);
        }
      }, (err) => {
        if (isStream) console.log(`[proxy] stream read failed after ${bytes} bytes in ${Date.now() - t0}ms: ${err?.message || err} ${err?.cause?.code || ''}`);
        res.end();
      });
    } else {
      res.end();
    }
  } catch (err) {
    console.error(`Proxy error [${req.method} ${req.url}]:`, err.message || err, err.cause?.code || err.cause?.message || '');
    res.writeHead(502, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// --- OAuth callback ---
function handleOAuthCallback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());

  const html = `<!DOCTYPE html>
<html><head><title>OAuth Callback - Shiro</title></head>
<body><p>Authenticating...</p>
<script>
(function() {
  var params = ${JSON.stringify(params)};
  var msg = {
    type: 'shiro-oauth-callback',
    code: params.code || '', state: params.state || '',
    port: params.port || '', params: params
  };
  // COOP same-origin on Shiro severs window.opener once the popup has been to
  // the provider's origin, so also post on a same-origin BroadcastChannel.
  var sent = false;
  if (window.opener) {
    try { window.opener.postMessage(msg, window.location.origin); sent = true; } catch (e) {}
  }
  if (!sent && typeof BroadcastChannel !== 'undefined') {
    var bc = new BroadcastChannel('shiro-oauth-callback');
    bc.postMessage(msg);
    bc.close();
    sent = true;
  }
  if (sent) {
    document.body.innerHTML = '<p>Authentication complete. You can close this window.</p>';
    setTimeout(function() { window.close(); }, 1000);
  } else {
    document.body.innerHTML = '<p>Error: Could not communicate with Shiro.</p>';
  }
})();
</script></body></html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...isolationHeaders() });
  res.end(html);
}

// --- Product profiles (docs/PROFILES.md) ---
// profiles/<id>/profile.json says which hosts a product serves and its brand;
// the page reads the same files (src/profile.ts). Read from profiles/ next to
// this script (a checkout) or STATIC_DIR/profiles.json (the build writes it;
// releases carry only dist/ and server.mjs). Without either, nothing is branded.
const PROFILES = (() => {
  try {
    const dir = new URL('./profiles/', import.meta.url);
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => { try { return [JSON.parse(readFileSync(new URL(`${d.name}/profile.json`, dir), 'utf8'))]; } catch { return []; } });
    if (found.length) return found;
  } catch {}
  try { return JSON.parse(readFileSync(join(STATIC_DIR, 'profiles.json'), 'utf8')); } catch {}
  return [];
})();

// The same choice as profiles/select.mjs (not imported: a release has no
// profiles/ directory); desktop-wm.test.ts checks the two agree.
function hostMatches(pattern, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const p = String(pattern).toLowerCase();
  return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
}
export function profileFor(host, override, profiles = PROFILES) {
  const hostname = String(host || '').split(':')[0];
  if (override) { const named = profiles.find((p) => p.id === override); if (named) return named; }
  return profiles.find((p) => (p.hosts || []).some((pat) => hostMatches(pat, hostname)))
    ?? profiles.find((p) => p.default) ?? profiles[0] ?? null;
}

// --- Branding of the app shell ---
// Link previews don't run JS, so the shared index.html gets the profile's
// title and meta tags here. A profile without a brand (shiro.computer) keeps
// the page's own.

/** index.html with the brand's title and meta tags, for the profile serving `host`. */
export function brandAppShell(html, host, brand = profileFor(host)?.brand) {
  if (!brand) return html;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const url = `https://${brand.domain}/`;
  const tags = [
    `<meta name="description" content="${esc(brand.description)}" />`,
    `<meta property="og:title" content="${esc(brand.name)}" />`,
    `<meta property="og:description" content="${esc(brand.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(brand.name)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="application-name" content="${esc(brand.name)}" />`,
    `<meta name="apple-mobile-web-app-title" content="${esc(brand.name)}" />`,
  ].join('\n  ');
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(brand.name)}</title>\n  ${tags}`);
  if (brand.favicon) out = out.replace(/href="\/favicon\.svg"/, `href="${esc(brand.favicon)}"`);
  // The brand's mark, centered while the app loads (inline: no extra request).
  // main.ts removes #boot-mark once the terminal exists.
  const mark = brand.favicon && bootMark(brand.favicon);
  if (mark) out = out.replace(/<body>/, `<body>\n  <div id="boot-mark" aria-hidden="true">${mark}</div>`);
  return out;
}

/** An SVG favicon as an inline mark in currentColor (its own color and dark-mode style dropped) */
const bootMarks = new Map();
function bootMark(favicon) {
  if (!/^\/[\w.-]+\.svg$/.test(favicon)) return '';
  if (bootMarks.has(favicon)) return bootMarks.get(favicon);
  let svg = '';
  for (const at of [new URL('./public' + favicon, import.meta.url), join(STATIC_DIR, favicon)]) {
    try { svg = readFileSync(at, 'utf8'); break; } catch {}
  }
  svg = svg.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/(<svg\b[^>]*?)\s+color="[^"]*"/, '$1').trim();
  if (!/^<svg\b[\s\S]*<\/svg>$/.test(svg) || /<script|\son\w+=/i.test(svg)) svg = '';
  bootMarks.set(favicon, svg);
  return svg;
}

// --- Guests (docs/research/GUEST_PROFILE.md) ---
// A guest is the app on an origin of its own, `guest--<name>[--<flags>].<base>`
// (src/guest.ts parses the same label), so the browser keeps its storage apart
// from the main profile's. Flags: `t` thrown away (the page's business), `x`
// no network: this server then refuses its proxies and the relay to that host,
// and to that Origin on any host, and sends a CSP that stops the page's own
// requests to other sites. The mode is in the hostname because script in the
// guest cannot change its origin.
//   TABCOMPUTER_GUESTS=1          guests under the brand domain (https://guest--x.<domain>);
//                                 localhost has them without it; 0 turns them off
//   TABCOMPUTER_GUEST_ORIGIN      another template, e.g. https://{guest}.example-guests.com
// Off (the default away from localhost), a guest hostname is an ordinary host.
const GUEST_LABEL = /^guest--([a-z0-9]{1,32})(?:--(t|x|tx))?$/;

export function parseGuestLabel(label) {
  const m = GUEST_LABEL.exec(String(label || '').toLowerCase());
  if (!m) return null;
  const flags = m[2] || '';
  return { label: m[0], name: m[1], ephemeral: flags.includes('t'), noNetwork: flags.includes('x') };
}

/** { template, scheme, suffix } for the app host or guest host `hostHeader`, or null when guests are off. */
export function guestConfigFor(hostHeader, env = process.env, brand = profileFor(hostHeader)?.brand) {
  if (env.TABCOMPUTER_GUESTS === '0') return null;
  const host = String(hostHeader || '').toLowerCase();
  let template = env.TABCOMPUTER_GUEST_ORIGIN || '';
  if (!template) {
    const local = /^((?:[a-z0-9-]+\.)*localhost)(:\d+)?$/.exec(host);
    const domain = String(brand?.domain || '').toLowerCase();
    if (local) {
      // A guest's own host answers with the template it was made from
      const first = local[1].split('.')[0];
      const base = parseGuestLabel(first) ? local[1].slice(first.length + 1) : local[1];
      template = `http://{guest}.${base}${local[2] || ''}`;
    } else if (env.TABCOMPUTER_GUESTS === '1' && domain && (host === domain || host.endsWith('.' + domain))) {
      template = `https://{guest}.${domain}`;
    } else return null;
  }
  template = template.toLowerCase().replace(/\/+$/, '');
  const tm = /^(https?):\/\/\{guest\}\.([a-z0-9.-]+(?::\d+)?)$/.exec(template);
  return tm ? { template, scheme: tm[1], suffix: tm[2] } : null;
}

/** The guest `host` (a Host header, or an Origin's host) is under `cfg`, or null. */
export function guestOfHost(host, cfg) {
  if (!cfg || !host) return null;
  const h = String(host).toLowerCase();
  if (!h.endsWith('.' + cfg.suffix)) return null;
  return parseGuestLabel(h.slice(0, -cfg.suffix.length - 1));
}

/**
 * The guest a request comes from: its Host, or else its Origin (a guest's page
 * calling another host of this server). `via` says which.
 */
export function guestOfRequest(req, cfg = guestConfigFor(req.headers.host)) {
  if (!cfg) return null;
  const byHost = guestOfHost(req.headers.host, cfg);
  if (byHost) return { ...byHost, via: 'host' };
  const origin = req.headers['origin'];
  if (!origin) return null;
  let oh = '';
  try { const u = new URL(origin); if (u.protocol === cfg.scheme + ':') oh = u.host; } catch { /* bad origin */ }
  const byOrigin = guestOfHost(oh, cfg);
  return byOrigin ? { ...byOrigin, via: 'origin' } : null;
}

// This server's routes that reach other hosts, or carry data between clients
const GUEST_NETWORK_ROUTES = ['/api', '/tcp', '/git-proxy', '/offer', '/answer', '/relay', '/oauth', '/channel', '/browse/fetch'];
const underRoute = (pathname, route) => pathname === route || pathname.startsWith(route + '/');

/** Why this server won't do `method pathname` for `guest`, or '' when it will. */
export function guestRefusal(guest, method, pathname) {
  if (!guest) return '';
  // The device flow hands a token to whoever started it: never to a guest
  if (underRoute(pathname, '/api/github-login')) return 'sign-in is not offered to a guest';
  if (!guest.noNetwork) return '';
  if (GUEST_NETWORK_ROUTES.some((r) => underRoute(pathname, r))) return 'this guest has no network';
  if (method !== 'GET' && method !== 'HEAD') return 'this guest has no network';
  return '';
}

// A no-network guest's page may load only this host's own files. The inline
// entry chunk, node-compat's eval and blob Workers need the unsafe-* and blob:
// sources: the policy is about where requests go, not about script injection.
// Nothing here stops the page navigating itself to another address.
const GUEST_NO_NETWORK_CSP = [
  "default-src 'self' blob: data:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' blob: data:",
  "form-action 'self'",
  "webrtc 'block'",
].join('; ');

/** Response headers for a guest host's pages and scripts (Workers take their policy from their script). */
export function guestHeaders(guest) {
  if (!guest || guest.via === 'origin') return {};
  return {
    'origin-agent-cluster': '?1',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
    ...(guest.noNetwork ? { 'content-security-policy': GUEST_NO_NETWORK_CSP } : {}),
  };
}

/**
 * True when the app shell is asked for as a frame of another origin of the
 * same site. A guest under the brand domain is same-site with the main
 * profile, so such a frame would run with the main profile's own storage.
 */
export function sameSiteFrame(req) {
  const dest = String(req.headers['sec-fetch-dest'] || '');
  return req.headers['sec-fetch-site'] === 'same-site' && ['iframe', 'frame', 'embed', 'object', 'fencedframe'].includes(dest);
}

/** First path segments the app never reads as /<user>/<repo> (src/guest.ts RESERVED_PATHS; guest.test.ts checks the two agree) */
export const REPO_LINK_RESERVED = ['s', 'api', 'oauth', 'offer', 'answer', 'git-proxy', 'channel', 'assets', 'guest', 'browse', 'tcp', 'relay', 'debian', 'claude-releases', 'apps', 'apphost'];

/**
 * A page address below the root that the app acts on (inboundCodeLink in
 * src/guest.ts): a shared seed, where this server keeps them, or a
 * repository. Only these get the app shell's base element.
 */
export function appLinkPath(pathname, seedShare = process.env.TABCOMPUTER_SEED_SHARE === '1') {
  if (/^\/s\/[a-z0-9]{4,16}$/.test(pathname)) return seedShare ? 'seed' : null;
  const m = /^\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/?$/.exec(pathname);
  return m && !REPO_LINK_RESERVED.includes(m[1].toLowerCase()) ? 'repo' : null;
}

// --- Static file server ---
async function handleStatic(req, res, guest = null, guests = null) {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  let filePath = join(STATIC_DIR, pathname);
  const requestExt = extname(pathname);
  const staticHeaders = {
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    ...guestHeaders(guest),
  };

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    if (pathname.startsWith('/assets/') || requestExt) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...staticHeaders });
      return res.end('Not found');
    }
    // Try .html extension (e.g. /about → about.html)
    try {
      await stat(filePath + '.html');
      filePath = filePath + '.html';
    } catch {
      // Fall through to index.html for SPA routing
      filePath = join(STATIC_DIR, 'index.html');
    }
  }

  try {
    let data = await readFile(filePath);
    const ext = extname(filePath);
    // Isolation headers go on the app shell (index.html, also the SPA fallback for
    // /s/:id) and on scripts, which a same-origin Worker needs to start inside an
    // isolated page. The public/*.html docs pages stay unisolated: they embed
    // the app in iframes and need nothing from SharedArrayBuffer.
    const isAppShell = filePath === join(STATIC_DIR, 'index.html');
    if (isAppShell && guests && !guest && sameSiteFrame(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('tabcomputer does not load in a frame of another site under this domain.');
    }
    const isolation = isAppShell || ext === '.js' || ext === '.mjs' ? isolationHeaders() : {};
    if (isAppShell) {
      const override = new URL(req.url, 'http://localhost').searchParams.get('profile');
      let html = brandAppShell(data.toString('utf8'), req.headers['host'], profileFor(req.headers['host'], override)?.brand);
      // The shell names its entry relative to the page ("./assets/…"): under /s/<id>
      // that is /s/assets/…, a 404, and the app never starts. A base element makes it
      // the root again, for the addresses the app acts on (appLinkPath). The app asks
      // before such a link imports or runs anything (src/inbound-link.ts, tabcomputer#116).
      if (appLinkPath(new URL(req.url, 'http://localhost').pathname) && !/<base\b/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, '<head$1>\n  <base href="/">');
      }
      data = Buffer.from(html);
    }
    // The streamed Debian rootfs's chunks are content-addressed (named by sha256),
    // and so are the engines' hashed wasm copies and versioned Blink directories
    // (vite-plugin-engines.ts) and
    // vite's /assets/ (name-HASH.ext). Everything else, the app shell above all,
    // is revalidated on every load so a reload always gets the deployed build.
    const immutable = pathname.startsWith('/debian/chunks/') || pathname.startsWith('/assets/')
      || /^\/engines\/.*\.[0-9a-f]{12}\.wasm$/.test(pathname)
      || /^\/engines\/blink\/v-[0-9a-f]{12}\//.test(pathname)
      ? { 'cache-control': 'public, max-age=31536000, immutable' } : { 'cache-control': 'no-cache' };
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', ...staticHeaders, ...isolation, ...immutable });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...staticHeaders });
    res.end('Not found');
  }
}

// --- Toolchain layers (docs/DEBIAN.md "Toolchain layers") ---
// scripts/debian/build-layers.sh writes them (index.json, <id>/layer.json and
// index, chunks/<sha256>.gz). They are large, so they live outside the
// release: TABCOMPUTER_DEBIAN_LAYERS names the directory. Unset, /debian/layers/
// is whatever STATIC_DIR has there.
const DEBIAN_LAYERS = process.env.TABCOMPUTER_DEBIAN_LAYERS || '';

async function handleDebianLayers(req, res, rel) {
  const headers = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
  if (!/^(index\.json|[a-z0-9-]+\/(layer\.json|index-[0-9a-f]+\.json\.gz)|chunks\/[0-9a-f]{64}\.gz)$/.test(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    return res.end('Not found');
  }
  try {
    const data = await readFile(join(DEBIAN_LAYERS, rel));
    // Chunks and indexes are content-addressed; the catalog and manifests change with a rebuild
    const cache = rel.endsWith('.gz') ? 'public, max-age=31536000, immutable' : 'no-cache';
    res.writeHead(200, { 'content-type': rel.endsWith('.json') ? 'application/json' : 'application/gzip', 'cache-control': cache, ...headers });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end('Not found');
  }
}

// --- Debian package mirror (docs/DEBIAN.md "Package mirror") ---
// apt inside the page fetches http://HOST/PATH as /debian/mirror/HOST/PATH
// (src/debian/apt-method.ts), so it needs no TCP relay. Only the hosts in
// TABCOMPUTER_DEBIAN_MIRRORS are served ("host=https://upstream,host2=..."; by
// default deb.debian.org and security.debian.org from their own CDNs), and
// only archive paths (dists/, pool/). apt verifies everything against the
// signed InRelease, so the mirror needs no trust (the GUI apps check each
// .deb's sha256 themselves). Files under pool/ and by-hash/ are immutable and
// kept in TABCOMPUTER_DEBIAN_CACHE (default: $TMPDIR/shiro-debian) forever; other
// index files for TABCOMPUTER_DEBIAN_INDEX_TTL seconds (default 600). A deb.debian.org
// pool file the mirror no longer has comes from TABCOMPUTER_DEBIAN_SNAPSHOT.
// /debian/pool/PATH (the GUI apps' URL) is /debian/mirror/deb.debian.org/debian/pool/PATH.
function debianMirrorConfig() {
  const upstreams = new Map([['deb.debian.org', 'https://deb.debian.org'], ['security.debian.org', 'https://security.debian.org']]);
  if (process.env.TABCOMPUTER_DEBIAN_MIRRORS) {
    upstreams.clear();
    for (const part of process.env.TABCOMPUTER_DEBIAN_MIRRORS.split(',')) {
      const i = part.indexOf('=');
      if (i > 0) upstreams.set(part.slice(0, i).trim(), part.slice(i + 1).trim().replace(/\/+$/, ''));
    }
  }
  return {
    upstreams,
    // Pool files a point release removed from deb.debian.org (the GUI apps pin
    // versions): fetched from snapshot.debian.org instead
    snapshot: (process.env.TABCOMPUTER_DEBIAN_SNAPSHOT || 'https://snapshot.debian.org/archive/debian/20260712T000000Z/').replace(/\/+$/, ''),
    cacheDir: process.env.TABCOMPUTER_DEBIAN_CACHE || process.env.TABCOMPUTER_DEB_CACHE || join(tmpdir(), 'shiro-debian'),
    indexTtl: Number(process.env.TABCOMPUTER_DEBIAN_INDEX_TTL || 600) * 1000,
  };
}
const DEBIAN_MIRROR = debianMirrorConfig();
const DEBIAN_PATH = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._+~%-]+)*\/(?:dists|pool)\/[A-Za-z0-9._+~%/-]+$/;
const debianInflight = new Map();

async function debianFetch(upstreamUrl, cacheFile, immutable) {
  if (cacheFile) {
    try {
      const st = await stat(cacheFile);
      if (immutable || Date.now() - st.mtimeMs < DEBIAN_MIRROR.indexTtl) {
        return { status: 200, body: await readFile(cacheFile), lastModified: await readFile(cacheFile + '.lm', 'utf8').catch(() => '') };
      }
    } catch { /* not cached */ }
  }
  let r;
  try {
    r = await upstreamFetch(upstreamUrl, { redirect: 'follow' });
  } catch (e) {
    // Upstream down: a stale index beats none
    if (cacheFile) {
      try { return { status: 200, body: await readFile(cacheFile), lastModified: '' }; } catch {}
    }
    return { status: 502, body: Buffer.from(`upstream: ${e.message}\n`) };
  }
  if (!r.ok) return { status: r.status, body: Buffer.from(`upstream: ${r.status} ${r.statusText}\n`) };
  const body = Buffer.from(await r.arrayBuffer());
  const lastModified = r.headers.get('last-modified') || '';
  if (cacheFile) {
    try {
      await mkdir(cacheFile.slice(0, cacheFile.lastIndexOf('/')), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${randomBytes(4).toString('hex')}`;
      await writeFile(tmp, body);
      await writeFile(cacheFile + '.lm', lastModified);
      await rename(tmp, cacheFile);
    } catch (e) { console.warn('[debian-mirror] cache write failed:', e.message); }
  }
  return { status: 200, body, lastModified };
}

async function handleDebianMirror(req, res, rest) {
  const slash = rest.indexOf('/');
  const host = slash > 0 ? rest.slice(0, slash) : '';
  const path = slash > 0 ? rest.slice(slash) : '';
  const upstream = DEBIAN_MIRROR.upstreams.get(host);
  if (!upstream || !DEBIAN_PATH.test(path) || path.includes('..') || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not a mirrored Debian archive path\n');
  }
  const immutable = path.includes('/pool/') || path.includes('/by-hash/');
  const cacheFile = DEBIAN_MIRROR.cacheDir ? join(DEBIAN_MIRROR.cacheDir, host, path) : '';
  const key = upstream + path;
  let p = debianInflight.get(key);
  if (!p) {
    p = debianFetch(upstream + path, cacheFile, immutable).then((r) =>
      r.status === 404 && host === 'deb.debian.org' && path.startsWith('/debian/pool/')
        ? debianFetch(DEBIAN_MIRROR.snapshot + path.slice('/debian'.length), cacheFile, true) : r,
    ).finally(() => debianInflight.delete(key));
    debianInflight.set(key, p);
  }
  const r = await p;
  const headers = {
    'content-type': r.status === 200 ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    'cache-control': r.status === 200 && immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (r.lastModified) headers['last-modified'] = r.lastModified;
  const ims = req.headers['if-modified-since'];
  if (r.status === 200 && ims && r.lastModified && Date.parse(ims) >= Date.parse(r.lastModified)) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['content-length'] = r.body.length;
  res.writeHead(r.status, headers);
  res.end(req.method === 'HEAD' ? undefined : r.body);
}

// --- Claude Code releases (tabcomputer#40) ---
// `claude install` fetched Anthropic's 250 MB native build from inside the
// guest, through the TCP relay and its per-IP rate limit (TABCOMPUTER_TCP_BYTES_PER_SEC,
// 4 MiB/s: ~56 s). /claude-releases/ serves the same files from this origin
// to the page's own fetch (src/commands/claude-native.ts), fetched from
// downloads.claude.ai once and kept on disk:
//   /claude-releases/latest                      the latest version (re-checked every TABCOMPUTER_CLAUDE_LATEST_TTL s, default 600)
//   /claude-releases/VERSION/manifest.json       a release's manifest (immutable)
//   /claude-releases/VERSION/PLATFORM/claude     the binary, kept only if its sha256 matches the manifest (immutable)
// Not a proxy: only these three shapes, semver versions and the platforms in
// TABCOMPUTER_CLAUDE_PLATFORMS (default linux-x64-musl, the build Blink runs)
// are served; anything else is a 404, and so is everything with
// TABCOMPUTER_CLAUDE_RELEASES=0 (the client then downloads through the relay as before).
// The newest TABCOMPUTER_CLAUDE_KEEP (3) versions stay in TABCOMPUTER_CLAUDE_CACHE, and at
// most TABCOMPUTER_CLAUDE_DOWNLOADS (2) binaries download at once (others get a 503 and
// the relay), so the disk holds at most KEEP + DOWNLOADS binaries (~250 MB each).
export const CLAUDE_KNOWN_PLATFORMS = ['linux-x64', 'linux-x64-musl', 'linux-arm64', 'linux-arm64-musl', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
const CLAUDE_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,4})?$/;
const CLAUDE_MAX_BYTES = 1024 * 1024 * 1024;

export function claudeReleasesConfig(env = process.env) {
  const platforms = (env.TABCOMPUTER_CLAUDE_PLATFORMS || 'linux-x64-musl').split(',').map((p) => p.trim()).filter((p) => CLAUDE_KNOWN_PLATFORMS.includes(p));
  return {
    enabled: env.TABCOMPUTER_CLAUDE_RELEASES !== '0',
    upstream: (env.TABCOMPUTER_CLAUDE_RELEASES_UPSTREAM || 'https://downloads.claude.ai/claude-code-releases').replace(/\/+$/, ''),
    cacheDir: env.TABCOMPUTER_CLAUDE_CACHE || join(tmpdir(), 'shiro-claude'),
    platforms,
    latestTtl: Number(env.TABCOMPUTER_CLAUDE_LATEST_TTL || 600) * 1000,
    keep: Math.max(1, Number(env.TABCOMPUTER_CLAUDE_KEEP || 3)),
    downloads: Math.max(1, Number(env.TABCOMPUTER_CLAUDE_DOWNLOADS || 2)),
  };
}

/** What /claude-releases/REST asks for, or null when it isn't one of the served shapes. */
export function claudeReleaseRequest(rest, platforms = ['linux-x64-musl']) {
  if (rest === 'latest') return { kind: 'latest' };
  const parts = rest.split('/');
  if (!CLAUDE_VERSION_RE.test(parts[0] || '')) return null;
  if (parts.length === 2 && parts[1] === 'manifest.json') return { kind: 'manifest', version: parts[0] };
  if (parts.length === 3 && parts[2] === 'claude' && platforms.includes(parts[1])) return { kind: 'binary', version: parts[0], platform: parts[1] };
  return null;
}

const CLAUDE_RELEASES = claudeReleasesConfig();
const claudeInflight = new Map();

async function claudeCachedText(url, file, maxAgeMs, check) {
  try {
    const st = await stat(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) return { ok: true, text: await readFile(file, 'utf8') };
  } catch { /* not cached */ }
  try {
    const r = await upstreamFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return { ok: false, status: r.status === 404 ? 404 : 502, text: `upstream: ${r.status}\n` };
    const text = await r.text();
    if (!check(text)) return { ok: false, status: 502, text: 'upstream: unexpected content\n' };
    await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, text);
    await rename(tmp, file);
    return { ok: true, text };
  } catch (e) {
    // Upstream down: a stale copy beats none
    try { return { ok: true, text: await readFile(file, 'utf8') }; } catch {}
    return { ok: false, status: 502, text: `upstream: ${e.message}\n` };
  }
}

function claudeManifestEntry(text, platform) {
  try {
    const e = JSON.parse(text)?.platforms?.[platform];
    if (e && /^[0-9a-f]{64}$/.test(e.checksum) && Number.isInteger(e.size) && e.size > 0 && e.size <= CLAUDE_MAX_BYTES) return e;
  } catch { /* below */ }
  return null;
}

const claudeManifestOk = (text) => { try { return typeof JSON.parse(text)?.platforms === 'object'; } catch { return false; } };

/** The binary on disk, downloaded and checked once; { file, size, checksum } or { status, text }. */
async function claudeBinary(version, platform) {
  const cfg = CLAUDE_RELEASES;
  const m = await claudeCachedText(`${cfg.upstream}/${version}/manifest.json`, join(cfg.cacheDir, version, 'manifest.json'), Infinity, claudeManifestOk);
  if (!m.ok) return { status: m.status, text: m.text };
  const entry = claudeManifestEntry(m.text, platform);
  if (!entry) return { status: 404, text: `no ${platform} build in ${version}\n` };
  const file = join(cfg.cacheDir, version, platform, 'claude');
  try {
    if ((await stat(file)).size === entry.size) return { file, size: entry.size, checksum: entry.checksum };
  } catch { /* not cached */ }
  const key = `${version}/${platform}`;
  let p = claudeInflight.get(key);
  if (!p) {
    // Requests for many versions at once would each write a temp file of ~250 MB
    if (claudeInflight.size >= cfg.downloads) return { status: 503, text: 'busy: other releases are downloading; try again later\n' };
    p = (async () => {
      await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`;
      const fh = await open(tmp, 'w');
      try {
        const r = await upstreamFetch(`${cfg.upstream}/${version}/${platform}/claude`, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60_000) });
        if (!r.ok || !r.body) return { status: r.status === 404 ? 404 : 502, text: `upstream: ${r.status}\n` };
        const hash = createHash('sha256');
        let n = 0;
        for await (const chunk of r.body) {
          n += chunk.length;
          if (n > entry.size) return { status: 502, text: 'upstream: larger than the manifest says\n' };
          hash.update(chunk);
          await fh.write(chunk);
        }
        const got = hash.digest('hex');
        if (n !== entry.size || got !== entry.checksum) return { status: 502, text: `upstream: sha256/size mismatch (${n} bytes, ${got})\n` };
        await fh.close();
        await rename(tmp, file);
        console.log(`[claude-releases] cached ${key} (${n} bytes)`);
        claudePrune().catch(() => {});
        return { file, size: n, checksum: got };
      } catch (e) {
        return { status: 502, text: `upstream: ${e.message}\n` };
      } finally {
        await fh.close().catch(() => {});
        await unlink(tmp).catch(() => {});
      }
    })().finally(() => claudeInflight.delete(key));
    claudeInflight.set(key, p);
  }
  return p;
}

/** Keep the newest CLAUDE_RELEASES.keep versions on disk */
async function claudePrune() {
  const dir = CLAUDE_RELEASES.cacheDir;
  const versions = [];
  for (const name of await readdir(dir)) {
    if (!CLAUDE_VERSION_RE.test(name)) continue;
    versions.push({ name, mtime: (await stat(join(dir, name))).mtimeMs });
  }
  versions.sort((a, b) => b.mtime - a.mtime);
  for (const v of versions.slice(CLAUDE_RELEASES.keep)) await rm(join(dir, v.name), { recursive: true, force: true });
}

async function handleClaudeReleases(req, res, rest) {
  const cfg = CLAUDE_RELEASES;
  const what = cfg.enabled && (req.method === 'GET' || req.method === 'HEAD') ? claudeReleaseRequest(rest, cfg.platforms) : null;
  const fail = (status, text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(text);
  };
  if (!what) return fail(404, 'not a served Claude Code release path\n');
  const head = req.method === 'HEAD';
  const same = { 'cross-origin-resource-policy': 'same-origin' };
  if (what.kind === 'latest' || what.kind === 'manifest') {
    const r = what.kind === 'latest'
      ? await claudeCachedText(`${cfg.upstream}/latest`, join(cfg.cacheDir, 'latest'), cfg.latestTtl, (t) => CLAUDE_VERSION_RE.test(t.trim()))
      : await claudeCachedText(`${cfg.upstream}/${what.version}/manifest.json`, join(cfg.cacheDir, what.version, 'manifest.json'), Infinity, claudeManifestOk);
    if (!r.ok) return fail(r.status, r.text);
    const body = Buffer.from(r.text);
    res.writeHead(200, {
      'content-type': what.kind === 'latest' ? 'text/plain; charset=utf-8' : 'application/json',
      'cache-control': what.kind === 'latest' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'content-length': body.length, ...same,
    });
    return res.end(head ? undefined : body);
  }
  const b = await claudeBinary(what.version, what.platform);
  if (!b.file) return fail(b.status, b.text);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': b.size,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: `"sha256-${b.checksum}"`,
    ...same,
  });
  if (head) return res.end();
  createReadStream(b.file).on('error', () => res.destroy()).pipe(res);
}

// --- Pyodide distribution (docs/research/PYTHON_NATIVE_WHEELS.md "Hosting") ---
// numpy, pandas and matplotlib run in Pyodide (src/pyodide-worker/). The page
// took it from cdn.jsdelivr.net: a school filter that allows only this site
// broke `import numpy`, and jsdelivr saw every tab that used it.
//   /pyodide/v<VERSION>/full/<FILE>
// serves the same files from this origin, each fetched from the upstream once
// and kept on disk. Not a proxy: only the versions in PYODIDE_DISTS (the one
// src/python/pyodide-dist.ts pins), and only the core files named there and
// the files that version's pyodide-lock.json lists. Every file is checked
// before it is kept or served: the core files and the lock against the sha256
// here, the rest against the sha256 the lock gives them.
//   TABCOMPUTER_PYODIDE=0              the route is a 404; the page then uses jsdelivr
//   TABCOMPUTER_PYODIDE_UPSTREAM       default https://cdn.jsdelivr.net/pyodide (files at <it>/v<VERSION>/full/<FILE>)
//   TABCOMPUTER_PYODIDE_CACHE          default $TMPDIR/tabcomputer-pyodide
//   TABCOMPUTER_PYODIDE_CACHE_MAX_MB   default 1024; past it a file is served without being kept
// One version's whole distribution is 462 MiB (every file of 0.29.5's lock,
// measured 2026-10-13; the largest is 73 MB); what a class uses (the
// core, numpy, pandas, matplotlib and what they need) is about 30 MB.
// JavaScript, wasm and JSON are also kept brotli-compressed (made once, in the
// background) and sent that way to a browser that accepts it; wheels and zips
// are already compressed. A file is held in memory until it is checked, so at
// most PYODIDE_DOWNLOADS are fetched at once; the others wait.
export const PYODIDE_DISTS = {
  '0.29.5': {
    'pyodide-lock.json': '14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d',
    'pyodide.mjs': '510ca14305230018f50c40fb81be673afd68080e70ce7733fcce6600dd6a1714',
    'pyodide.js': '7f832a350240263d9946a9c3c877f7bcdab6c37d6dc65f72cd3be5905dca62dd',
    'pyodide.asm.js': '356c42f69e1695397e9d8670bd3c2e678248cde76e18bdae1731e848537b47d7',
    'pyodide.asm.wasm': '54309a5a2cfd757b1f0fdbc9093c92503f7b341500110329d932487183912718',
    'python_stdlib.zip': '831fd1e535084b972f87c6a35275de3d236efd5166f5e77ce89497710635e73c',
  },
};
const PYODIDE_PATH = /^\/pyodide\/v(\d{1,3}\.\d{1,3}\.\d{1,3})\/full\/([A-Za-z0-9][A-Za-z0-9._+-]{0,199})$/;
const PYODIDE_FILE_MAX = 128 * 1024 * 1024;
const PYODIDE_DOWNLOADS = 4;
const PYODIDE_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm', '.zip': 'application/zip',
};
const PYODIDE_COMPRESSIBLE = /\.(?:mjs|js|json|wasm)$/;

/** What `/pyodide/…` asks for ({ version, file }), or null when the path is not a file of a distribution's `full/` directory. */
export function pyodideRequest(pathname) {
  const m = PYODIDE_PATH.exec(pathname);
  return m && !m[2].includes('..') ? { version: m[1], file: m[2] } : null;
}

export function pyodideMirrorConfig(env = process.env) {
  const maxMb = Number(env.TABCOMPUTER_PYODIDE_CACHE_MAX_MB || 1024);
  return {
    enabled: env.TABCOMPUTER_PYODIDE !== '0',
    upstream: (env.TABCOMPUTER_PYODIDE_UPSTREAM || 'https://cdn.jsdelivr.net/pyodide').replace(/\/+$/, ''),
    cacheDir: env.TABCOMPUTER_PYODIDE_CACHE || join(tmpdir(), 'tabcomputer-pyodide'),
    maxBytes: (Number.isFinite(maxMb) && maxMb >= 0 ? maxMb : 1024) * 1024 * 1024,
    dists: PYODIDE_DISTS,
  };
}

export function createPyodideMirror(cfg = pyodideMirrorConfig(), { fetchFn = (url, init) => upstreamFetch(url, init), log = console.log } = {}) {
  const inflight = new Map(); // "version/file" → the one fetch every first request waits for
  const lists = new Map();    // version → Promise<Map<file name, sha256>> from that version's lock
  const packing = new Set();  // files being brotli-compressed
  let counted = null;         // the one scan of the cache directory
  let used = 0;               // bytes on disk, once counted
  let fetching = 0;           // upstream fetches in flight
  const waiting = [];

  const diskUsed = async () => {
    await (counted ??= (async () => {
      for (const v of await readdir(cfg.cacheDir).catch(() => [])) {
        for (const f of await readdir(join(cfg.cacheDir, v)).catch(() => [])) used += (await stat(join(cfg.cacheDir, v, f)).catch(() => ({ size: 0 }))).size;
      }
    })());
    return used;
  };
  // A file is held in memory until it is checked: a few at a time, the rest wait their turn
  const turn = async () => { if (fetching >= PYODIDE_DOWNLOADS) await new Promise((r) => waiting.push(r)); else fetching++; };
  const done = () => { const next = waiting.shift(); if (next) next(); else fetching--; };
  const keep = async (file, data) => {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
      await writeFile(tmp, data);
      await rename(tmp, file);
      await diskUsed();
      used += data.length;
      return true;
    } catch (e) {
      await unlink(tmp).catch(() => {});
      log(`[pyodide] cache write failed: ${e.message}`);
      return false;
    }
  };

  /** The file checked and (room allowing) on disk: { file?, body?, size, sha256 } or { status, text } */
  async function fetched(version, name, sha256) {
    const file = join(cfg.cacheDir, version, name);
    try { return { file, size: (await stat(file)).size, sha256 }; } catch { /* not kept yet */ }
    const key = `${version}/${name}`;
    let p = inflight.get(key);
    if (!p) {
      p = (async () => {
        let body;
        await turn();
        try {
          const r = await fetchFn(`${cfg.upstream}/v${version}/full/${name}`, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
          if (!r.ok || !r.body) return { status: 502, text: `upstream: ${r.status}\n` };
          const parts = [];
          let n = 0;
          for await (const chunk of r.body) {
            n += chunk.length;
            if (n > PYODIDE_FILE_MAX) return { status: 502, text: 'upstream: file too large\n' };
            parts.push(chunk);
          }
          body = Buffer.concat(parts);
        } catch (e) {
          return { status: 502, text: `upstream: ${e.message}\n` };
        } finally {
          done();
        }
        const got = createHash('sha256').update(body).digest('hex');
        if (got !== sha256) {
          log(`[pyodide] ${key}: sha256 ${got}, expected ${sha256}; not served`);
          return { status: 502, text: 'upstream: sha256 mismatch\n' };
        }
        if (await diskUsed() + body.length > cfg.maxBytes) {
          log(`[pyodide] cache full (TABCOMPUTER_PYODIDE_CACHE_MAX_MB): ${key} served without being kept`);
          return { body, size: body.length, sha256 };
        }
        if (!await keep(file, body)) return { body, size: body.length, sha256 };
        log(`[pyodide] cached ${key} (${body.length} bytes)`);
        return { file, size: body.length, sha256 };
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  /** The file names of a version's lock and their sha256 */
  function listOf(version) {
    let p = lists.get(version);
    if (!p) {
      p = (async () => {
        const lock = await fetched(version, 'pyodide-lock.json', cfg.dists[version]['pyodide-lock.json']);
        if (lock.status) return lock;
        const names = new Map();
        const text = lock.file ? await readFile(lock.file) : lock.body;
        for (const pkg of Object.values(JSON.parse(text.toString('utf8')).packages ?? {})) {
          if (typeof pkg?.file_name === 'string' && /^[0-9a-f]{64}$/.test(pkg.sha256 ?? '')) names.set(pkg.file_name, pkg.sha256);
        }
        return { names };
      })().catch((e) => ({ status: 502, text: `pyodide-lock.json: ${e.message}\n` }));
      lists.set(version, p);
      p.then((r) => { if (r.status) lists.delete(version); });
    }
    return p;
  }

  /** `name` of `version`: the checked file, or { status, text } (404: not a file of that distribution) */
  async function resolve(version, name) {
    const dist = cfg.dists[version];
    if (!dist) return { status: 404, text: `Pyodide ${version} is not served here\n` };
    if (Object.hasOwn(dist, name)) return fetched(version, name, dist[name]);
    const list = await listOf(version);
    if (list.status) return list;
    const sha256 = list.names.get(name);
    if (!sha256) return { status: 404, text: `not a file of Pyodide ${version}\n` };
    return fetched(version, name, sha256);
  }

  /** FILE.br beside FILE, made once; null until it exists */
  async function brotliOf(file) {
    try { return { file: file + '.br', size: (await stat(file + '.br')).size }; } catch { /* not made yet */ }
    if (!packing.has(file)) {
      packing.add(file);
      (async () => {
        const { brotliCompress, constants } = await import('node:zlib');
        const data = await readFile(file);
        const br = await new Promise((ok, fail) => brotliCompress(data, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
        }, (e, out) => e ? fail(e) : ok(out)));
        if (br.length < data.length && await diskUsed() + br.length <= cfg.maxBytes) await keep(file + '.br', br);
      })().catch((e) => log(`[pyodide] brotli ${file}: ${e.message}`)).finally(() => packing.delete(file));
    }
    return null;
  }

  /** Answer `req` for what pyodideRequest() found. `extra`: the headers this host's scripts carry (isolation, a guest's policy). */
  async function handle(req, res, what, extra = {}) {
    const cors = { 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' };
    const fail = (status, text, more = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...cors, ...more });
      res.end(text);
    };
    if (!cfg.enabled || !what) return fail(404, 'Pyodide is not served here\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'GET or HEAD only\n', { allow: 'GET, HEAD' });
    const r = await resolve(what.version, what.file);
    if (r.status) return fail(r.status, r.text);
    const ext = extname(what.file);
    const headers = {
      'content-type': PYODIDE_TYPES[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"sha256-${r.sha256}"`,
      ...cors,
      ...(ext === '.js' || ext === '.mjs' ? extra : {}),
    };
    let send = r.file ? { file: r.file, size: r.size } : { body: r.body, size: r.size };
    if (PYODIDE_COMPRESSIBLE.test(what.file)) {
      headers.vary = 'accept-encoding';
      const br = r.file ? await brotliOf(r.file) : null;
      if (br && /\bbr\b/.test(String(req.headers['accept-encoding'] || ''))) {
        send = br;
        headers['content-encoding'] = 'br';
      }
    }
    headers['content-length'] = send.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    if (send.file) return createReadStream(send.file).on('error', () => res.destroy()).pipe(res);
    res.end(send.body);
  }

  return { handle, resolve, config: cfg };
}
const pyodideMirror = createPyodideMirror();

// --- WebRTC signaling ---
const OFFER_TTL = 5 * 60 * 1000; // 5 minutes

// --- Remote relay: `remote start` over HTTPS when WebRTC can't connect ---
// A peer that can't do UDP (a cloud container behind an HTTPS proxy) answers an
// offer with {type: 'relay'} instead of SDP; then the tab and the peer exchange
// the same JSON messages through a mailbox here, by long-polling. The tab names
// the mailbox (a random id) in its offer; message bodies are AES-GCM sealed
// with a key derived from the secret part of the remote code, which this
// server is never given (src/remote-relay.ts), so it only queues opaque strings.
//
//   POST /relay/:id/send?as=tab|peer   {msgs: [string]}  → queued for the other side
//   GET  /relay/:id/recv?as=tab|peer&wait=MS            → {msgs, peerSeenMs}
export const RELAY_LIMITS = {
  mailboxes: 500, idleMs: 5 * 60 * 1000, maxWaitMs: 25_000,
  queueMsgs: 4000, queueBytes: 16 * 1024 * 1024, bodyBytes: 4 * 1024 * 1024,
};

export function createRemoteRelay(limits = RELAY_LIMITS) {
  const boxes = new Map(); // id -> { tab: Side, peer: Side, touched }
  const side = () => ({ queue: [], bytes: 0, waiter: null, seen: 0 });
  const prune = () => {
    const now = Date.now();
    for (const [id, box] of boxes) if (now - box.touched > limits.idleMs) { close(box); boxes.delete(id); }
  };
  const close = (box) => { for (const s of [box.tab, box.peer]) if (s.waiter) s.waiter(true); };
  const timer = setInterval(prune, 60_000);
  timer.unref?.();

  /** The tab's offer names its mailbox; unknown ids are refused. */
  function open(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return false;
    if (!boxes.has(id)) {
      if (boxes.size >= limits.mailboxes) prune();
      if (boxes.size >= limits.mailboxes) return false;
      boxes.set(id, { tab: side(), peer: side(), touched: Date.now() });
    }
    boxes.get(id).touched = Date.now();
    return true;
  }

  function deliver(to, msgs) {
    for (const m of msgs) {
      if (to.queue.length >= limits.queueMsgs || to.bytes + m.length > limits.queueBytes) return false;
      to.queue.push(m);
      to.bytes += m.length;
    }
    if (to.waiter) to.waiter(false);
    return true;
  }

  async function handle(req, res, pathname, cors = {}) {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    const m = pathname.match(/^\/relay\/([a-f0-9]{32})\/(send|recv)$/);
    const url = new URL(req.url, 'http://localhost');
    const as = url.searchParams.get('as');
    if (!m || (as !== 'tab' && as !== 'peer')) return json(404, { error: 'Unknown relay endpoint' });
    const box = boxes.get(m[1]);
    if (!box) return json(404, { error: 'No such mailbox' });
    box.touched = Date.now();
    const me = box[as], other = box[as === 'tab' ? 'peer' : 'tab'];
    me.seen = Date.now();
    // A side waiting in a long-poll is present now
    const peerSeenMs = () => (other.waiter ? 0 : other.seen ? Date.now() - other.seen : null);

    if (m[2] === 'send' && req.method === 'POST') {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limits.bodyBytes) return json(413, { error: 'Too large' });
        chunks.push(chunk);
      }
      let msgs;
      try { msgs = JSON.parse(Buffer.concat(chunks).toString()).msgs; } catch { return json(400, { error: 'Bad JSON' }); }
      if (!Array.isArray(msgs) || !msgs.every((x) => typeof x === 'string')) return json(400, { error: 'msgs must be strings' });
      if (!deliver(other, msgs)) return json(429, { error: 'Mailbox full' });
      return json(200, { ok: true, peerSeenMs: peerSeenMs() });
    }

    if (m[2] === 'recv' && req.method === 'GET') {
      const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, limits.maxWaitMs));
      if (!me.queue.length && wait > 0) {
        // One long-poll per side: a newer one replaces the older (it gets [])
        if (me.waiter) me.waiter(false);
        let closed = false;
        await new Promise((resolve) => {
          const t = setTimeout(done, wait);
          function done(gone = false) { clearTimeout(t); closed = gone; if (me.waiter === done) me.waiter = null; resolve(); }
          me.waiter = done;
          res.on('close', () => done());
        });
        if (closed) return json(410, { error: 'Mailbox closed' });
        if (res.destroyed) return;
      }
      const msgs = me.queue.splice(0);
      me.bytes = 0;
      me.seen = Date.now();
      return json(200, { msgs, peerSeenMs: peerSeenMs() });
    }
    return json(405, { error: 'Method not allowed' });
  }

  return { open, handle, boxes, stop: () => { clearInterval(timer); for (const b of boxes.values()) close(b); boxes.clear(); } };
}
const remoteRelay = createRemoteRelay();

// --- Remote signaling (`remote start`), protocol 3 ---
// A remote code is `<id>#<secret>`. This server is given the id only: it is the
// key offers are kept under and the last segment of /offer/:id and /answer/:id.
// The offer and the answer arrive AES-GCM sealed with a key derived from the
// secret (src/remote-relay.ts), so nothing here can read the session, and
// nothing that reaches this handler is a value its key can be derived from.
// Before protocol 3 the whole code was posted here (and logged), and the code
// was the key. Such requests are refused with 426 and never logged: an old tab
// or an old shiro-mcp gets an error, not a session this server could read.
//
//   POST /offer            {v: 3, id, sealed, relay?: {id}}  → {ok, v: 3}
//   GET  /offer/:id?v=3    → {v: 3, sealed, relay?: {id}}
//   POST /answer/:id       {v: 3, sealed}                    → {ok, v: 3}
//   GET  /answer/:id       → {v: 3, sealed} | {waiting} | {expired}
export const SIGNAL_PROTOCOL = 3;
const SIGNAL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;
const SIGNAL_UPGRADE = 'This server takes remote protocol 3 only: a remote code is now words#letters and its secret part is never sent here. Reload the tab and run `remote start` again; update shiro-mcp (git pull, npm run build).';

export function createSignaling({ relay = null, log = console.log, ttlMs = OFFER_TTL, maxBody = 512 * 1024, maxOffers = 5000 } = {}) {
  const offers = new Map(); // id -> { sealed, relay, answer, created }
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of offers) if (now - entry.created > ttlMs) offers.delete(id);
  }, 60_000);
  timer.unref?.();
  const validId = (id) => typeof id === 'string' && id.length <= 80 && SIGNAL_ID_RE.test(id);

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) return undefined;
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return null; }
  }

  async function handle(req, res, pathname, cors = {}) {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    // What an older client sends carried (or was) its key: answer, and log nothing of it
    const upgrade = () => json(426, { error: 'upgrade_required', protocol: SIGNAL_PROTOCOL, message: SIGNAL_UPGRADE });
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, 'http://localhost');

    if (pathname === '/offer' && req.method === 'POST') {
      const data = await readJson(req);
      if (data === undefined) return json(413, { error: 'Too large' });
      if (!data || typeof data !== 'object') return json(400, { error: 'Bad JSON' });
      if (data.v !== SIGNAL_PROTOCOL || 'code' in data || 'offer' in data) return upgrade();
      if (!validId(data.id) || typeof data.sealed !== 'string' || !data.sealed) return json(400, { error: 'Missing id or sealed offer' });
      if (!offers.has(data.id) && offers.size >= maxOffers) return json(503, { error: 'Too many offers' });
      log(`[signal] offer registered: ${data.id} (${offers.has(data.id) ? 'refresh' : 'new'})`);
      // A tab that can relay names its mailbox; open it now so the peer can use it
      const box = data.relay && relay && relay.open(data.relay.id) ? { id: data.relay.id } : null;
      offers.set(data.id, { sealed: data.sealed, relay: box, answer: null, created: Date.now() });
      return json(200, { ok: true, v: SIGNAL_PROTOCOL });
    }

    const offerMatch = pathname.match(/^\/offer\/([^/]+)$/);
    if (offerMatch && req.method === 'GET') {
      // A peer from before protocol 3 doesn't say v=3 (and its old code was the key: not logged)
      if (url.searchParams.get('v') !== String(SIGNAL_PROTOCOL)) return upgrade();
      const entry = validId(offerMatch[1]) ? offers.get(offerMatch[1]) : null;
      if (!entry) {
        log(`[signal] offer lookup miss (${offers.size} registered)`);
        return json(404, { error: 'Not found' });
      }
      return json(200, { v: SIGNAL_PROTOCOL, sealed: entry.sealed, ...(entry.relay ? { relay: entry.relay } : {}) });
    }

    const answerMatch = pathname.match(/^\/answer\/([^/]+)$/);
    if (answerMatch && req.method === 'POST') {
      const data = await readJson(req);
      if (data === undefined) return json(413, { error: 'Too large' });
      if (!data || typeof data !== 'object') return json(400, { error: 'Bad JSON' });
      if (data.v !== SIGNAL_PROTOCOL || 'answer' in data) return upgrade();
      const entry = validId(answerMatch[1]) ? offers.get(answerMatch[1]) : null;
      if (!entry) return json(404, { error: 'Not found' });
      if (typeof data.sealed !== 'string' || !data.sealed) return json(400, { error: 'Missing sealed answer' });
      entry.answer = data.sealed;
      return json(200, { ok: true, v: SIGNAL_PROTOCOL });
    }
    if (answerMatch && req.method === 'GET') {
      const entry = validId(answerMatch[1]) ? offers.get(answerMatch[1]) : null;
      // (an old tab polling with its old code lands here too: its offer was refused, so "expired")
      if (!entry) return json(200, { expired: true });
      if (entry.answer) return json(200, { v: SIGNAL_PROTOCOL, sealed: entry.answer });
      return json(200, { waiting: true });
    }

    return json(404, { error: 'Unknown signaling endpoint' });
  }

  return { handle, offers, stop: () => { clearInterval(timer); offers.clear(); } };
}
const signaling = createSignaling({ relay: remoteRelay });

// --- Git CORS proxy (for isomorphic-git clone) ---
/**
 * Why the git proxy won't fetch `url`, or '' if it may: only http(s) on the
 * default ports, and only hosts whose every address is public (not loopback,
 * private, link-local or cloud metadata; same list as the TCP relay).
 */
export async function gitProxyRefusal(url, lookup = (host) => dns.lookup(host, { all: true, verbatim: true })) {
  let u;
  try { u = new URL(url); } catch { return 'bad url'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http(s)';
  if (u.port && u.port !== '80' && u.port !== '443') return 'port not allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await lookup(host); } catch { return 'host not found'; }
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) return 'address not allowed';
  return '';
}

async function handleGitProxy(req, res, targetUrl) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  // Forward headers (strip browser-specific ones)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }

  try {
    // Redirects are followed here, each hop re-checked, so a public URL can't
    // bounce the server to a private one.
    let url = targetUrl;
    let upstream;
    for (let hop = 0; ; hop++) {
      const refusal = await gitProxyRefusal(url);
      if (refusal) {
        res.writeHead(403, { 'content-type': 'application/json', ...cors });
        return res.end(JSON.stringify({ error: refusal }));
      }
      headers['host'] = new URL(url).host;
      upstream = await fetch(url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
        duplex: 'half',
        redirect: 'manual',
      });
      const next = upstream.headers.get('location');
      if (upstream.status < 300 || upstream.status > 399 || !next || hop >= 5) break;
      url = new URL(next, url).href;
    }

    const respHeaders = { ...cors };
    for (const [k, v] of upstream.headers) {
      if (!SKIP_GIT_RESPONSE_HEADERS.has(k.toLowerCase())) respHeaders[k] = v;
    }

    res.writeHead(upstream.status, respHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch(() => res.end());
    } else {
      res.end();
    }
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json', ...cors });
    console.warn('[git-proxy]', targetUrl, err.message, err.cause || '');
    res.end(JSON.stringify({ error: err.message, cause: err.cause ? [err.cause.code, err.cause.message].filter(Boolean).join(': ') || String(err.cause) : undefined }));
  }
}

// --- Seed sharing ---
// `seed share` uploads a snapshot of a tab's files; anyone with the link can
// download it. Off unless TABCOMPUTER_SEED_SHARE=1: with it on, this server
// stores what people upload (SEED_DIR), which is a decision for whoever runs
// it. The routes are matched before the /api/ proxy, which used to answer
// /api/seed itself ("Unknown API target: seed"), so sharing never worked here.
//   GET  /api/seed       → {enabled, maxBytes, keepDays}
//   POST /api/seed       → {id, url}        (the gzipped snapshot)
//   GET  /api/seed/:id   → the snapshot
const SEED_SHARE = process.env.TABCOMPUTER_SEED_SHARE === '1';
const SEED_KEEP_DAYS = 60;
const SEED_DIR = process.env.SEED_DIR || '/opt/tabcomputer/seeds';
const SEED_MAX_SIZE = 512 * 1024; // 512KB max per seed (gzipped)
const SEED_RATE_LIMIT = 200; // per IP per month

// In-memory rate limit tracker: ip -> { count, resetAt }
const seedRates = new Map();

// Ensure seed directory exists
if (SEED_SHARE) mkdir(SEED_DIR, { recursive: true }).catch(() => {});

async function handleSeed(req, res, pathname) {
  const cors = corsHeaders(req.headers['origin'], req.headers['access-control-request-headers']);
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (pathname === '/api/seed' && req.method === 'GET') return json(200, { enabled: SEED_SHARE, maxBytes: SEED_MAX_SIZE, keepDays: SEED_KEEP_DAYS });
  if (!SEED_SHARE) return json(404, { error: 'Seed sharing is off on this server' });
  if (pathname === '/api/seed' && req.method === 'POST') return handleSeedUpload(req, res);
  const m = pathname.match(/^\/api\/seed\/([a-z0-9]{4,16})$/);
  if (m && req.method === 'GET') return handleSeedDownload(req, res, m[1]);
  return json(404, { error: 'Unknown seed endpoint' });
}

function checkSeedRateLimit(ip) {
  const now = Date.now();
  let entry = seedRates.get(ip);
  if (!entry || now > entry.resetAt) {
    // Reset monthly
    entry = { count: 0, resetAt: now + 30 * 24 * 60 * 60 * 1000 };
    seedRates.set(ip, entry);
  }
  if (entry.count >= SEED_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

async function handleSeedUpload(req, res) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!checkSeedRateLimit(ip)) {
    res.writeHead(429, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ error: 'Rate limit exceeded (200/month)' }));
  }

  // Collect body (already gzipped from client)
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > SEED_MAX_SIZE) {
      res.writeHead(413, { 'content-type': 'application/json', ...cors });
      return res.end(JSON.stringify({ error: 'Seed too large (max 512KB)' }));
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // The id is all that guards a seed: 16 base36 characters (about 82 random bits).
  // (Buffer has no 'base36' encoding: the old line threw, and took the server down.)
  const id = BigInt('0x' + randomBytes(11).toString('hex')).toString(36).padStart(16, '0').slice(-16);
  const meta = JSON.stringify({ created: Date.now(), lastVisited: Date.now(), ip, size: body.length });

  try {
    await writeFile(join(SEED_DIR, `${id}.gz`), body);
    await writeFile(join(SEED_DIR, `${id}.meta`), meta);
    console.log(`[seed] Created ${id} (${body.length} bytes) from ${ip}`);
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ id, url: `/s/${id}` }));
  } catch (err) {
    console.error('[seed] Write error:', err.message);
    res.writeHead(500, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Failed to save seed' }));
  }
}

async function handleSeedDownload(req, res, id) {
  const origin = req.headers['origin'];
  const cors = corsHeaders(origin, req.headers['access-control-request-headers']);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  try {
    const data = await readFile(join(SEED_DIR, `${id}.gz`));
    // Update lastVisited
    try {
      const metaPath = join(SEED_DIR, `${id}.meta`);
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      meta.lastVisited = Date.now();
      await writeFile(metaPath, JSON.stringify(meta));
    } catch {}
    res.writeHead(200, { 'content-type': 'application/octet-stream', ...cors });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify({ error: 'Seed not found' }));
  }
}

// Lazy cleanup: delete seeds not visited in 60 days (runs every 6 hours)
setInterval(async () => {
  try {
    const files = await readdir(SEED_DIR);
    const cutoff = Date.now() - SEED_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const file of files) {
      if (!file.endsWith('.meta')) continue;
      try {
        const meta = JSON.parse(await readFile(join(SEED_DIR, file), 'utf-8'));
        if (meta.lastVisited < cutoff) {
          const id = file.replace('.meta', '');
          await unlink(join(SEED_DIR, `${id}.gz`)).catch(() => {});
          await unlink(join(SEED_DIR, `${id}.meta`)).catch(() => {});
          console.log(`[seed] Cleaned up expired seed: ${id}`);
        }
      } catch {}
    }
  } catch {}
}, 6 * 60 * 60 * 1000).unref();

// --- TCP relay (kernel sockets) ---
// One WebSocket per TCP connection at /tcp. Opt-in with TABCOMPUTER_TCP_RELAY=1.
// Protocol (docs/NETWORKING.md): the first frame is text JSON, either
//   {"op":"connect","host":"example.com","port":443}  → {"op":"connected",...} | {"op":"error",...}
//   {"op":"resolve","host":"example.com"}             → {"op":"resolved","addresses":[...]} | {"op":"error",...}
// After "connected", binary frames are the byte stream in both directions and
// text frames are control: client {"op":"shutdown"} (SHUT_WR), {"op":"ack","n":N}
// (bytes consumed, opens the flow-control window); server {"op":"eof"} (peer
// sent FIN) and {"op":"error","code":"E..."}.
//
// Security model: the egress policy is the boundary. Every address a host
// resolves to is checked against the blocked ranges below, the relay connects
// to the checked IP literal (never re-resolving, so DNS rebinding can't swap in
// a private address between check and connect), and only allow-listed ports
// are reachable. On top of that: Origin allow-list, a short-lived HMAC token
// bound to the client IP (issued by POST /tcp/token), per-IP and global
// connection caps, per-IP connect rate, per-IP bandwidth and hourly byte
// budget, per-connection byte cap, handshake/connect/idle/lifetime timeouts,
// and logs that record endpoints and byte counts but never payloads.

const TCP_BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// Mapped/translated forms (::ffff:0:0/96, NAT64, 6to4, Teredo) embed IPv4
// addresses, so they are blocked outright rather than decoded.
const TCP_BLOCKED_V6 = [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
];
// Separate lists per family: node's BlockList matches an IPv4 address against
// the IPv6 subnet ::ffff:0:0/96, so one shared list blocked every IPv4 address.
const tcpBuiltinBlockV4 = new net.BlockList();
const tcpBuiltinBlockV6 = new net.BlockList();
for (const [a, p] of TCP_BLOCKED_V4) tcpBuiltinBlockV4.addSubnet(a, p, 'ipv4');
for (const [a, p] of TCP_BLOCKED_V6) tcpBuiltinBlockV6.addSubnet(a, p, 'ipv6');

function cidrBlockList(cidrs) {
  const list = new net.BlockList();
  for (const c of cidrs || []) {
    const [addr, bits] = String(c).trim().split('/');
    const family = net.isIP(addr);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    list.addSubnet(addr, bits === undefined ? (family === 6 ? 128 : 32) : Number(bits), type);
  }
  return list;
}

/** True if the relay must not connect to `ip` (private, loopback, link-local, metadata, ...). */
export function isBlockedAddress(ip, { allow, deny } = {}) {
  const family = net.isIP(ip);
  if (!family) return true;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (allow && allow.check(ip, type)) return false;
  if (deny && deny.check(ip, type)) return true;
  return (family === 6 ? tcpBuiltinBlockV6 : tcpBuiltinBlockV4).check(ip, type);
}

const envList = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : null);
const envInt = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// 22 (ssh, git over ssh), 80/443 (http/https, the bulk of guest traffic), 9418
// (git://). SMTP and database ports stay closed by default: an open relay to
// 25 is a spam cannon, and nobody should reach a database through a browser.
export const TCP_DEFAULT_PORTS = [22, 80, 443, 9418];

export function tcpRelayConfigFromEnv(env = process.env) {
  return {
    enabled: env.TABCOMPUTER_TCP_RELAY === '1',
    allowedOrigins: envList(env.TABCOMPUTER_TCP_ORIGINS) || ['https://shiro.computer', 'https://*.shiro.computer'],
    ports: (envList(env.TABCOMPUTER_TCP_PORTS) || TCP_DEFAULT_PORTS).map(Number).filter((p) => p > 0 && p < 65536),
    allowCidrs: envList(env.TABCOMPUTER_TCP_ALLOW_CIDRS) || [],
    denyCidrs: envList(env.TABCOMPUTER_TCP_DENY_CIDRS) || [],
    secret: env.TABCOMPUTER_TCP_SECRET || '',
    // Token requests need a GitHub sign-in (Authorization: Bearer <github token>); docs/DESKTOP.md
    requireSignin: env.TABCOMPUTER_TCP_REQUIRE_SIGNIN === '1',
    trustProxy: env.TABCOMPUTER_TRUST_PROXY || 'loopback', // 'loopback' | 'always' | 'never'
    tokenTtlMs: envInt(env.TABCOMPUTER_TCP_TOKEN_TTL_MS, 10 * 60_000),
    // Tie each token to the IP that fetched it. Clients whose outgoing IP changes per
    // connection (proxy pools, iCloud Private Relay, dual-stack) fail with it on.
    tokenBindIp: env.TABCOMPUTER_TCP_TOKEN_BIND_IP !== '0',
    maxConns: envInt(env.TABCOMPUTER_TCP_MAX_CONNS, 512),
    maxConnsPerIp: envInt(env.TABCOMPUTER_TCP_MAX_CONNS_PER_IP, 64),
    connectsPerMinute: envInt(env.TABCOMPUTER_TCP_CONNECTS_PER_MIN, 300),
    bytesPerSecPerIp: envInt(env.TABCOMPUTER_TCP_BYTES_PER_SEC, 4 * 1024 * 1024),
    byteBurstPerIp: envInt(env.TABCOMPUTER_TCP_BYTE_BURST, 16 * 1024 * 1024),
    maxBytesPerIpPerHour: envInt(env.TABCOMPUTER_TCP_BYTES_PER_HOUR, 4 * 1024 ** 3),
    maxBytesPerConn: envInt(env.TABCOMPUTER_TCP_MAX_BYTES_PER_CONN, 1024 ** 3),
    handshakeTimeoutMs: envInt(env.TABCOMPUTER_TCP_HANDSHAKE_TIMEOUT_MS, 10_000),
    connectTimeoutMs: envInt(env.TABCOMPUTER_TCP_CONNECT_TIMEOUT_MS, 15_000),
    idleTimeoutMs: envInt(env.TABCOMPUTER_TCP_IDLE_TIMEOUT_MS, 5 * 60_000),
    maxLifetimeMs: envInt(env.TABCOMPUTER_TCP_MAX_LIFETIME_MS, 4 * 60 * 60_000),
    window: envInt(env.TABCOMPUTER_TCP_WINDOW, 512 * 1024),
    // http://host:port of an HTTP CONNECT proxy to dial through (egress that only allows proxied traffic)
    upstreamProxy: env.TABCOMPUTER_TCP_UPSTREAM_PROXY || '',
  };
}

function originAllowed(origin, allowed) {
  if (!origin) return false;
  for (const pat of allowed) {
    if (pat === '*' || pat === origin) return true;
    const star = pat.indexOf('://*.');
    if (star !== -1) {
      const scheme = pat.slice(0, star + 3);
      const suffix = pat.slice(star + 4); // ".example.com"
      if (origin.startsWith(scheme) && origin.endsWith(suffix) && !origin.slice(scheme.length, -suffix.length).includes('/')) return true;
    }
  }
  return false;
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
  } catch { /* socket already gone */ }
  socket.destroy();
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62})(\.[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,62}))*\.?$/;

/**
 * Create the relay. Returns { handleUpgrade(req, socket, head), handleToken(req, res), close(), stats() }.
 * `lookup(host)` → [{address, family}] can be injected (tests); defaults to dns.lookup(all).
 */
/** GitHub login for a token, or null (cached 10 min per token hash, both ways). */
function githubSigninVerifier(fetchImpl = globalThis.fetch) {
  const cache = new Map();
  return async (token) => {
    const key = createHash('sha256').update(token).digest('base64url');
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.login;
    let login = null;
    try {
      const r = await fetchImpl('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'shiro-relay' } });
      if (r.ok) login = (await r.json())?.login || null;
    } catch { return null; } // GitHub unreachable: don't cache
    if (cache.size > 10000) cache.clear();
    cache.set(key, { login, until: Date.now() + 10 * 60_000 });
    return login;
  };
}

export function createTcpRelay(config, { lookup, log = console.log, verifySignin } = {}) {
  const cfg = { ...tcpRelayConfigFromEnv({}), ...config };
  const secret = cfg.secret || randomBytes(32).toString('hex');
  const allow = cidrBlockList(cfg.allowCidrs);
  const deny = cidrBlockList(cfg.denyCidrs);
  const ports = new Set(cfg.ports);
  const resolve = lookup || ((host) => dns.lookup(host, { all: true, verbatim: true }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const perIp = new Map(); // ip -> { conns, connTokens, connAt, byteTokens, byteAt, hourBytes, hourAt }
  const live = new Set();
  let total = 0;
  let nextId = 1;

  const ipState = (ip) => {
    let st = perIp.get(ip);
    if (!st) {
      const now = Date.now();
      st = { conns: 0, connTokens: cfg.connectsPerMinute, connAt: now, byteTokens: cfg.byteBurstPerIp, byteAt: now, hourBytes: 0, hourAt: now };
      perIp.set(ip, st);
    }
    return st;
  };
  const refill = (st, now = Date.now()) => {
    st.connTokens = Math.min(cfg.connectsPerMinute, st.connTokens + ((now - st.connAt) / 60_000) * cfg.connectsPerMinute);
    st.connAt = now;
    st.byteTokens = Math.min(cfg.byteBurstPerIp, st.byteTokens + ((now - st.byteAt) / 1000) * cfg.bytesPerSecPerIp);
    st.byteAt = now;
    if (now - st.hourAt >= 3_600_000) { st.hourBytes = 0; st.hourAt = now; }
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, st] of perIp) {
      refill(st, now);
      if (st.conns === 0 && st.connTokens >= cfg.connectsPerMinute && st.byteTokens >= cfg.byteBurstPerIp && st.hourBytes === 0) perIp.delete(ip);
    }
  }, 60_000);
  sweep.unref?.();

  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (cfg.trustProxy === 'always' || (cfg.trustProxy === 'loopback' && loop)) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return peer;
  };

  const verify = verifySignin || githubSigninVerifier();
  const sign = (exp, ip) => createHmac('sha256', secret).update(`shiro-tcp.${exp}.${cfg.tokenBindIp ? ip : '*'}`).digest('base64url');
  const issueToken = (ip) => {
    const exp = Date.now() + cfg.tokenTtlMs;
    return { token: `${exp}.${sign(exp, ip)}`, expires: exp };
  };
  const tokenValid = (token, ip) => {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
    if (!m || Number(m[1]) < Date.now()) return false;
    const want = Buffer.from(sign(m[1], ip));
    const got = Buffer.from(m[2]);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  /** POST /tcp/token from an allowed Origin → { token, expires }, bound to the caller's IP unless tokenBindIp is off. */
  function handleToken(req, res) {
    const origin = req.headers['origin'];
    const ok = originAllowed(origin, cfg.allowedOrigins);
    const headers = ok ? { 'access-control-allow-origin': origin, 'vary': 'Origin', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization' } : {};
    if (req.method === 'OPTIONS') { res.writeHead(ok ? 204 : 403, headers); return res.end(); }
    if (req.method !== 'POST' || !ok) {
      res.writeHead(403, { 'content-type': 'text/plain', ...headers });
      return res.end('Forbidden');
    }
    if (cfg.requireSignin) {
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers['authorization'] || ''));
      (m ? verify(m[1]) : Promise.resolve(null)).then((login) => {
        if (!login) {
          res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
          return res.end(JSON.stringify({ error: 'signin_required', provider: 'github' }));
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
        res.end(JSON.stringify(issueToken(clientIp(req))));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(issueToken(clientIp(req))));
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    if (!originAllowed(req.headers['origin'], cfg.allowedOrigins)) {
      log(`[tcp] refused ${ip}: origin ${req.headers['origin'] || '(none)'}`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    if (!tokenValid(url.searchParams.get('t'), ip)) {
      log(`[tcp] refused ${ip}: bad or expired token`);
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    const st = ipState(ip);
    refill(st);
    if (total >= cfg.maxConns) return rejectUpgrade(socket, 503, 'Relay busy');
    if (st.conns >= cfg.maxConnsPerIp) {
      log(`[tcp] refused ${ip}: ${st.conns} connections open`);
      return rejectUpgrade(socket, 429, 'Too many connections');
    }
    if (st.connTokens < 1) {
      log(`[tcp] refused ${ip}: connect rate`);
      return rejectUpgrade(socket, 429, 'Too many requests');
    }
    st.connTokens -= 1;
    // Reserve the slot now so concurrent handshakes can't overshoot the caps.
    st.conns++; total++;
    let released = false;
    let attached = false;
    const release = () => { if (!released) { released = true; st.conns--; total--; } };
    socket.once('close', () => { if (!attached) release(); });
    wss.handleUpgrade(req, socket, head, (ws) => {
      attached = true;
      onConnection(ws, ip, st, release);
    });
  }

  function onConnection(ws, ip, st, release) {
    const id = nextId++;
    const started = Date.now();
    let phase = 'handshake'; // handshake → connecting → open → closed
    let tcp = null;
    let target = '';
    let up = 0, down = 0;
    let inflight = 0;          // bytes sent to the client and not yet acked
    let tcpWriteBlocked = false;
    let throttledUntil = 0;
    let throttleTimer = null;
    let reason = '';
    live.add(ws);

    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const fail = (code, message, wsCode = 1000) => {
      reason ||= code;
      send({ op: 'error', code, message });
      ws.close(wsCode, code);
      tcp?.destroy();
    };

    const handshakeTimer = setTimeout(() => fail('ETIMEDOUT', 'no request'), cfg.handshakeTimeoutMs);
    let idleTimer = null;
    const touch = () => {
      if (!cfg.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { reason = 'idle'; ws.close(4010, 'idle timeout'); tcp?.destroy(); }, cfg.idleTimeoutMs);
    };
    const lifeTimer = cfg.maxLifetimeMs ? setTimeout(() => { reason = 'lifetime'; ws.close(4011, 'lifetime limit'); tcp?.destroy(); }, cfg.maxLifetimeMs) : null;

    const updateFlow = () => {
      if (!tcp || phase !== 'open') return;
      const throttled = throttledUntil > Date.now();
      if (inflight > cfg.window || throttled) tcp.pause(); else tcp.resume();
      if (tcpWriteBlocked || throttled) ws.pause(); else ws.resume();
      if (throttled && !throttleTimer) {
        throttleTimer = setTimeout(() => { throttleTimer = null; updateFlow(); }, throttledUntil - Date.now());
      }
    };
    // Charge n bytes to the connection and the client IP; false = connection closed for a limit.
    const account = (n) => {
      refill(st);
      st.hourBytes += n;
      st.byteTokens -= n;
      if (up + down > cfg.maxBytesPerConn) { reason = 'byte cap'; fail('EDQUOT', 'per-connection byte limit', 4008); return false; }
      if (st.hourBytes > cfg.maxBytesPerIpPerHour) { reason = 'hourly cap'; fail('EDQUOT', 'hourly byte limit', 4008); return false; }
      if (st.byteTokens < 0) {
        throttledUntil = Date.now() + Math.ceil((-st.byteTokens / cfg.bytesPerSecPerIp) * 1000);
        updateFlow();
      }
      touch();
      return true;
    };

    async function start(req) {
      const host = String(req.host || '').replace(/^\[(.*)\]$/, '$1');
      const family = net.isIP(host);
      if (!family && !HOSTNAME_RE.test(host)) return fail('EINVAL', 'bad host');
      let addrs;
      try {
        addrs = family ? [{ address: host, family }] : await Promise.race([
          resolve(host),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'EAI_AGAIN' })), cfg.connectTimeoutMs).unref?.()),
        ]);
      } catch (err) {
        return fail(err?.code === 'ENOTFOUND' || err?.code === 'ENODATA' ? 'ENOTFOUND' : 'EAI_AGAIN', 'lookup failed');
      }
      if (ws.readyState !== 1) return;
      const usable = addrs.filter((a) => !isBlockedAddress(a.address, { allow, deny }));
      if (req.op === 'resolve') {
        reason = 'resolve';
        log(`[tcp] #${id} ${ip} resolve ${host} → ${usable.length}/${addrs.length} usable`);
        if (!usable.length) return fail(addrs.length ? 'EACCES' : 'ENOTFOUND', addrs.length ? 'only blocked addresses' : 'no addresses');
        send({ op: 'resolved', addresses: usable.map((a) => ({ address: a.address, family: a.family })) });
        return ws.close(1000);
      }
      const port = Number(req.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('EINVAL', 'bad port');
      if (!ports.has(port)) {
        log(`[tcp] #${id} ${ip} refused ${host}:${port}: port not allowed`);
        return fail('EACCES', `port ${port} not allowed by relay policy`);
      }
      if (!usable.length) {
        log(`[tcp] #${id} ${ip} refused ${host}:${port}: ${addrs.length ? 'blocked address' : 'no address'}`);
        return fail(addrs.length ? 'EACCES' : 'ENOTFOUND', addrs.length ? 'address blocked by relay policy' : 'no addresses');
      }
      const { address } = usable[0];
      target = `${host === address ? '' : host + '→'}${address}:${port}`;
      log(`[tcp] #${id} ${ip} connect ${target}`);
      phase = 'connecting';
      const forward = (chunk) => {
        down += chunk.length;
        inflight += chunk.length;
        if (!account(chunk.length)) return;
        ws.send(chunk, { binary: true });
        updateFlow();
      };
      const opened = (remoteAddress, remotePort) => {
        phase = 'open';
        touch();
        send({ op: 'connected', remoteAddress, remotePort, family: net.isIP(remoteAddress) });
      };
      if (cfg.upstreamProxy) {
        // Through an HTTP CONNECT proxy (egress that only allows proxied traffic). The address
        // policy above already vetted what the name resolves to; the proxy dials the name.
        const proxy = new URL(cfg.upstreamProxy);
        tcp = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80, timeout: cfg.connectTimeoutMs, allowHalfOpen: true });
        tcp.setNoDelay(true);
        tcp.once('timeout', () => { if (phase === 'connecting') fail('ETIMEDOUT', 'connect timeout'); });
        tcp.once('connect', () => tcp.write(`CONNECT ${net.isIP(host) === 6 ? `[${host}]` : host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
        let head = Buffer.alloc(0);
        const onHead = (chunk) => {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf('\r\n\r\n');
          if (end < 0) { if (head.length > 16384) fail('EPROTO', 'proxy reply too long'); return; }
          tcp.off('data', onHead);
          const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1]);
          if (status !== 200) return fail(status === 403 || status === 407 ? 'EACCES' : 'ECONNREFUSED', `proxy answered ${status || '?'}`);
          tcp.setTimeout(0);
          opened(address, port);
          tcp.on('data', forward);
          if (head.length > end + 4) forward(head.subarray(end + 4));
        };
        tcp.on('data', onHead);
      } else {
        // Connect to the vetted IP literal: no second lookup, so no rebinding window.
        // allowHalfOpen: the peer's FIN must not end our side; the client decides with {"op":"shutdown"}
        tcp = net.connect({ host: address, port, timeout: cfg.connectTimeoutMs, allowHalfOpen: true });
        tcp.setNoDelay(true);
        tcp.once('timeout', () => { if (phase === 'connecting') fail('ETIMEDOUT', 'connect timeout'); });
        tcp.once('connect', () => {
          tcp.setTimeout(0);
          if (isBlockedAddress(tcp.remoteAddress, { allow, deny })) return fail('EACCES', 'address blocked by relay policy');
          opened(tcp.remoteAddress, tcp.remotePort);
        });
        tcp.on('data', forward);
      }
      tcp.on('drain', () => { tcpWriteBlocked = false; updateFlow(); });
      tcp.on('end', () => send({ op: 'eof' }));
      tcp.on('error', (err) => { reason ||= err.code || 'error'; send({ op: 'error', code: err.code || 'EIO', message: 'socket error' }); });
      tcp.on('close', () => { if (ws.readyState === 1) ws.close(1000); });
    }

    ws.on('message', (data, isBinary) => {
      if (phase === 'handshake') {
        clearTimeout(handshakeTimer);
        let req;
        try { req = !isBinary && data.length <= 1024 ? JSON.parse(data.toString()) : null; } catch { req = null; }
        if (!req || (req.op !== 'connect' && req.op !== 'resolve')) return fail('EPROTO', 'expected connect or resolve');
        phase = 'resolving';
        start(req).catch(() => fail('EIO', 'relay error'));
        return;
      }
      if (phase !== 'open') return fail('EPROTO', 'data before connected');
      if (isBinary) {
        up += data.length;
        if (!account(data.length)) return;
        if (!tcp.write(data)) { tcpWriteBlocked = true; updateFlow(); }
        return;
      }
      let ctl;
      try { ctl = data.length <= 256 ? JSON.parse(data.toString()) : null; } catch { ctl = null; }
      if (ctl?.op === 'ack' && Number.isFinite(ctl.n) && ctl.n > 0) { inflight = Math.max(0, inflight - ctl.n); updateFlow(); }
      else if (ctl?.op === 'shutdown') tcp.end();
      else fail('EPROTO', 'bad control frame');
    });

    ws.on('close', () => {
      phase = 'closed';
      clearTimeout(handshakeTimer); clearTimeout(idleTimer); clearTimeout(lifeTimer); clearTimeout(throttleTimer);
      tcp?.destroy();
      live.delete(ws);
      release();
      if (target) log(`[tcp] #${id} ${ip} closed ${target} up=${up} down=${down} ms=${Date.now() - started}${reason ? ` reason=${reason}` : ''}`);
    });
    ws.on('error', () => { reason ||= 'ws error'; tcp?.destroy(); });
  }

  return {
    handleUpgrade,
    handleToken,
    issueToken,
    stats: () => ({ connections: total, ips: perIp.size }),
    close() {
      clearInterval(sweep);
      for (const ws of live) ws.terminate();
      wss.close();
    },
  };
}

// --- Browser app: browse origins (docs/BROWSER.md) ---
// Each site the desktop's Browser app shows lives on its own origin, one DNS
// label per real origin (src/browser/origin-map.ts): https://{key}.web.<domain>.
// Those hosts serve only three scripts and a bootstrap page that installs the
// origin's service worker; all content comes from the app's broker in the
// user's page. They never serve the app, /api, /tcp or anything else.
//   TABCOMPUTER_BROWSE_ORIGIN       template; default https://{key}.web.<brand domain> on the brand
//                             domain and its instances (music.<domain>, …), http://{key}.localhost:PORT
//                             on localhost, else off. Needs wildcard DNS and a *.web.<domain> certificate.
//   TABCOMPUTER_BROWSE_APP_ORIGINS  origins (with *. wildcards) whose Browser may use them; default the
//                             brand domain and its subdomains, or http://localhost:PORT
//   TABCOMPUTER_BROWSE=0            off
export function browseConfigFor(hostHeader, env = process.env, brand = profileFor(hostHeader)?.brand) {
  if (env.TABCOMPUTER_BROWSE === '0') return null;
  const host = String(hostHeader || '').toLowerCase();
  let template = env.TABCOMPUTER_BROWSE_ORIGIN || '';
  let apps = envList(env.TABCOMPUTER_BROWSE_APP_ORIGINS);
  if (!template) {
    const local = /^(?:[a-z0-9-]+\.)*localhost(:\d+)?$/.exec(host);
    const domain = String(brand?.domain || '').toLowerCase();
    if (local) {
      template = `http://{key}.localhost${local[1] || ''}`;
      apps ||= [`http://localhost${local[1] || ''}`];
    } else if (domain && (host === domain || host.endsWith('.' + domain))) {
      template = `https://{key}.web.${domain}`;
      apps ||= [`https://${domain}`, `https://*.${domain}`];
    } else return null;
  }
  template = template.toLowerCase().replace(/\/+$/, '');
  const tm = /^(https?):\/\/\{key\}\.([a-z0-9.-]+(?::\d+)?)$/.exec(template);
  if (!tm) return null;
  apps ||= [`${tm[1]}://${tm[2]}`];
  return {
    template,
    scheme: tm[1],
    suffix: tm[2],                       // host[:port] after "{key}."
    apps: apps.map((a) => a.toLowerCase()),
  };
}

/** The app origin a request to the app host comes from (for /browse/config.json). */
function appOriginOf(req, cfg) {
  return `${cfg.scheme}://${String(req.headers.host || '').toLowerCase()}`;
}

/** The browse key when `hostHeader` is a browse host of `cfg`, else null. */
export function browseKeyOf(hostHeader, cfg) {
  if (!cfg || !hostHeader) return null;
  const host = String(hostHeader).toLowerCase();
  if (!host.endsWith('.' + cfg.suffix)) return null;
  const key = host.slice(0, -cfg.suffix.length - 1);
  if (/^guest--/.test(key)) return null; // a guest's host (localhost shares the zone)
  if (APP_LABEL.test(key)) return null;  // an app's host (below)
  // Keys are one label with at least one dash (a dot of the real host): never "www" or "api"
  return /^[a-z0-9-]{1,63}$/.test(key) && key.includes('-') && !key.startsWith('-') && !key.endsWith('-') ? key : null;
}

function browseHeaders(cfg) {
  const browseAny = `${cfg.scheme}://*.${cfg.suffix}`;
  return {
    'cross-origin-embedder-policy': 'credentialless',
    'cross-origin-resource-policy': 'cross-origin',
    'origin-agent-cluster': '?1',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors ${cfg.apps.join(' ')} ${browseAny}`,
  };
}

const BROWSE_SCRIPTS = new Set(['sw.js', 'boot.js', 'client.js', 'shim.js']);

async function handleBrowseHost(req, res, cfg) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const headers = browseHeaders(cfg);
  if (pathname.startsWith('/__tc/')) {
    const name = pathname.slice('/__tc/'.length);
    if (!BROWSE_SCRIPTS.has(name)) { res.writeHead(404, headers); return res.end(); }
    try {
      const data = await readFile(join(STATIC_DIR, 'browse', name));
      res.writeHead(200, {
        ...headers,
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-cache',
        ...(name === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
      });
      return res.end(data);
    } catch {
      res.writeHead(404, headers);
      return res.end();
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') { res.writeHead(405, headers); return res.end(); }
  const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title></title>`
    + `<script src="/__tc/boot.js" data-apps="${esc(cfg.apps.join(' '))}"></script></head><body></body></html>`;
  res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : html);
}

// --- Apps: app origins (docs/APPS.md "The page's origin") ---
// An installed app's page lives on an origin of its own, one label in the
// browse zone: app--<id>--<16 hex>.<zone> (src/apps/frame.ts makes the label).
// Its `--` runs can't be a browse key's, so the two never meet. Such a host
// serves only /__tabcomputer/: the frame that holds the port to the tab, the
// origin's service worker, tab.js, and page.js (the page of an app that has
// none of its own). The app's own files and its backend
// are answered by the tab, through that worker. Never the app shell, /api,
// /tcp or anything else: script on an app origin must find nothing here.
// Where there are no browse origins there are no app origins, and the tab
// shows an app's page on its own origin instead (and says so).
const APP_LABEL = /^app--[a-z0-9]{1,24}--[a-f0-9]{16}$/;
const APP_HOST_SCRIPTS = new Set(['frame.js', 'sw.js', 'tab.js', 'page.js']);

/** The app label when `hostHeader` is an app host of `cfg` (browseConfigFor), else null. */
export function appLabelOf(hostHeader, cfg) {
  if (!cfg || !hostHeader) return null;
  const host = String(hostHeader).toLowerCase();
  if (!host.endsWith('.' + cfg.suffix)) return null;
  const label = host.slice(0, -cfg.suffix.length - 1);
  return APP_LABEL.test(label) ? label : null;
}

/** Origins (with *. wildcards) whose tab may frame an app host: the Browser's, and on localhost its guests and other names */
export function appFramers(cfg) {
  const local = /^localhost(:\d+)?$/.test(cfg.suffix);
  return [...new Set([...cfg.apps, ...(local ? [`${cfg.scheme}://*.${cfg.suffix}`] : [])])];
}

const APP_HOST_HEADERS = {
  'cross-origin-embedder-policy': 'credentialless',
  'cross-origin-resource-policy': 'cross-origin',
  'origin-agent-cluster': '?1',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

async function handleAppHost(req, res, cfg) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const headers = APP_HOST_HEADERS;
  const framers = appFramers(cfg);
  const plain = (status, text) => { res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'Method not allowed');
  if (pathname === '/__tabcomputer/frame.html') {
    const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><title></title>`
      + `<style>html,body{margin:0;height:100%;overflow:hidden;background:#fff;font:14px system-ui,sans-serif}iframe{display:block;width:100%;height:100%;border:0}</style></head>`
      + `<body><script src="/__tabcomputer/frame.js" data-apps="${esc(framers.join(' '))}" data-zone="${esc(cfg.suffix)}"></script></body></html>`;
    res.writeHead(200, {
      ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      // The frame's own page: its script and the app's page under it, nothing from anywhere else
      'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ${framers.join(' ')}`,
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  if (pathname.startsWith('/__tabcomputer/')) {
    const name = pathname.slice('/__tabcomputer/'.length);
    if (!APP_HOST_SCRIPTS.has(name)) return plain(404, 'Not found');
    try {
      const data = await readFile(join(STATIC_DIR, 'apphost', name));
      res.writeHead(200, {
        ...headers, 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache',
        ...(name === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch { return plain(404, 'Not found'); }
  }
  // Everything else is the app's, answered by its tab through the service worker
  return plain(503, 'This address is an app of tabcomputer. It shows when the app is opened from the desktop.');
}

// --- Browser app: server-side fetch, for local measurement only ---
// The product path is TLS in the page over /tcp (the server only sees
// ciphertext). This transport makes the *server* do the request, so it sees
// plaintext: it exists only to compare the two on the scoreboard, is off unless
// TABCOMPUTER_BROWSE_SERVER_FETCH=1, and must never be set in production (owner
// decision, docs/BROWSER.md). Same address policy as the relay.
const BROWSE_SERVER_FETCH = process.env.TABCOMPUTER_BROWSE_SERVER_FETCH === '1';
const browseAgents = { 'https:': new https.Agent({ keepAlive: true, maxSockets: 6 }), 'http:': new http.Agent({ keepAlive: true, maxSockets: 6 }) };

async function handleBrowseFetch(req, res) {
  const fail = (status, msg) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(msg); };
  const browse = browseConfigFor(req.headers.host);
  const origin = req.headers.origin;
  if (req.method !== 'POST' || !browse || (origin && origin !== `${browse.scheme}://${String(req.headers.host).toLowerCase()}`)) return fail(403, 'forbidden');
  let target, method, headers;
  try {
    target = new URL(String(req.headers['x-tc-url']));
    method = String(req.headers['x-tc-method'] || 'GET').toUpperCase();
    headers = JSON.parse(decodeURIComponent(String(req.headers['x-tc-headers'] || '%5B%5D')));
  } catch { return fail(400, 'bad request'); }
  if (!/^https?:$/.test(target.protocol) || !/^[A-Z]+$/.test(method)) return fail(400, 'bad request');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }); } catch { return fail(502, 'ENOTFOUND'); }
  const usable = addrs.filter((a) => !isBlockedAddress(a.address, { allow: cidrBlockList(envList(process.env.TABCOMPUTER_TCP_ALLOW_CIDRS) || []), deny: cidrBlockList([]) }));
  if (!usable.length) return fail(403, 'address blocked by relay policy');
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  if (!(envList(process.env.TABCOMPUTER_TCP_PORTS) || TCP_DEFAULT_PORTS).map(Number).includes(port)) return fail(403, 'port blocked');
  const flat = {};
  for (const [k, v] of headers) { const n = String(k).toLowerCase(); if (n !== 'host' && n !== 'connection' && n !== 'content-length' && n !== 'transfer-encoding') flat[k] = flat[k] ? `${flat[k]}, ${v}` : String(v); }
  const mod = target.protocol === 'https:' ? https : http;
  const up = mod.request({
    host: usable[0].address, port, method, path: target.pathname + target.search, servername: net.isIP(host) ? undefined : host,
    headers: { ...flat, host: target.host }, agent: browseAgents[target.protocol], timeout: 30000,
  }, (r) => {
    const pairs = [];
    for (let i = 0; i < r.rawHeaders.length; i += 2) pairs.push([r.rawHeaders[i], r.rawHeaders[i + 1]]);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-tc-status': String(r.statusCode), 'x-tc-status-text': encodeURIComponent(r.statusMessage || ''), 'x-tc-headers': encodeURIComponent(JSON.stringify(pairs)) });
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { if (!res.headersSent) fail(502, e.code || 'EIO'); else res.destroy(); });
  req.pipe(up);
}

// --- WebSocket proxy for Anthropic's API (/api/ws-proxy) ---
// A page's WebSocket can't send headers, and Claude Code's voice stream
// (wss://api.anthropic.com/api/ws/speech_to_text/voice_stream) authenticates
// with `Authorization: Bearer <oauth token>`. claude --vm's `ws`
// (src/claude-vm/extract.ts, wsShimSource) connects here instead and sends
// the real URL and headers as its first message (never in the URL, so tokens
// stay out of access logs); this server opens the upstream WebSocket with
// them and pipes frames both ways, text and binary, and the close codes.
// Protocol (docs/CLAUDE_VM.md, "Voice"):
//   client → first frame, text: {"url": "wss://api.anthropic.com/...", "headers": {...}, "protocols": [...]}
//   server → first frame, text: {"type": "open", "protocol": "..."}
//                             | {"type": "unexpected-response", "status": 401, "headers": {...}}
//                             | {"type": "error", "message": "..."}
//   after "open": every frame in either direction is the upstream's own.
// Only WS_PROXY_HOSTS are reachable, so it is no open relay. A browser page of
// another site can't use it (its Origin isn't this host); a client without an
// Origin isn't a browser and could reach the API itself.
// TABCOMPUTER_ANTHROPIC_WS_UPSTREAM (tests): the ws(s)://host:port standing in
// for https://api.anthropic.com.
export const WS_PROXY_PATH = '/api/ws-proxy';
const WS_PROXY_HOSTS = new Set(['api.anthropic.com']);
const WS_PROXY_DROP_HEADERS = /^(host|connection|upgrade|origin|cookie|content-length|transfer-encoding|keep-alive|te|trailer|expect|proxy-.*|sec-websocket-.*)$/i;

export function createWsProxy({ upstreamOrigin = process.env.TABCOMPUTER_ANTHROPIC_WS_UPSTREAM || '', maxPerIp = 8, maxTotal = 500, log = console.log } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const perIp = new Map();
  const live = new Set();
  const clientIp = (req) => {
    const peer = req.socket.remoteAddress || '';
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return peer;
  };
  /** The upstream URL for an allowed `wss://` URL, else null */
  const upstreamOf = (raw) => {
    let u;
    try { u = new URL(String(raw)); } catch { return null; }
    if (u.protocol !== 'wss:' || !WS_PROXY_HOSTS.has(u.hostname) || (u.port && u.port !== '443') || u.username || u.password) return null;
    if (!upstreamOrigin) return u.href;
    return upstreamOrigin.replace(/\/+$/, '') + u.pathname + u.search;
  };
  const headersOf = (h) => {
    const out = {};
    if (!h || typeof h !== 'object') return out;
    for (const [k, v] of Object.entries(h)) {
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) || WS_PROXY_DROP_HEADERS.test(k)) continue;
      const s = String(v);
      if (/[\r\n\0]/.test(s)) continue;
      out[k] = s;
    }
    return out;
  };
  // ws's close() takes 1000 and 3000-4999 (and the other sendable codes); 1005 is "no code"
  const closeWith = (ws, code, reason) => {
    try {
      if (code === 1005 || code === undefined) ws.close();
      else if (code === 1006) ws.terminate();
      else ws.close(code, reason);
    } catch { try { ws.close(1011); } catch { ws.terminate(); } }
  };

  function handleUpgrade(req, socket, head) {
    const origin = req.headers['origin'];
    if (origin) {
      let oh = '';
      try { oh = new URL(origin).host.toLowerCase(); } catch { /* bad origin */ }
      if (oh !== String(req.headers.host || '').toLowerCase()) return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const ip = clientIp(req);
    const n = perIp.get(ip) || 0;
    if (live.size >= maxTotal) return rejectUpgrade(socket, 503, 'Busy');
    if (n >= maxPerIp) return rejectUpgrade(socket, 429, 'Too many connections');
    perIp.set(ip, n + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const m = (perIp.get(ip) || 1) - 1;
      if (m > 0) perIp.set(ip, m); else perIp.delete(ip);
    };
    socket.once('close', release);
    wss.handleUpgrade(req, socket, head, (client) => onClient(client, ip, release));
  }

  function onClient(client, ip, release) {
    live.add(client);
    let upstream = null;
    let opened = false;
    let target = '';
    const pending = [];
    const started = Date.now();
    const hello = setTimeout(() => closeWith(client, 1008, 'no request'), 10_000);
    const fail = (msg, code = 1011) => {
      try { client.send(JSON.stringify({ type: 'error', message: msg })); } catch { /* gone */ }
      closeWith(client, code, msg.slice(0, 120));
    };
    client.on('message', (data, isBinary) => {
      if (upstream) {
        if (opened) upstream.send(data, { binary: isBinary });
        else pending.push([data, isBinary]);
        return;
      }
      clearTimeout(hello);
      let reqMsg;
      try { reqMsg = isBinary ? null : JSON.parse(String(data)); } catch { reqMsg = null; }
      const url = reqMsg && upstreamOf(reqMsg.url);
      if (!url) return fail('ws-proxy: only wss://api.anthropic.com is reachable here', 1008);
      target = new URL(reqMsg.url).pathname;
      const protocols = Array.isArray(reqMsg.protocols) ? reqMsg.protocols.filter((p) => typeof p === 'string') : typeof reqMsg.protocols === 'string' ? [reqMsg.protocols] : [];
      try {
        upstream = new WebSocket(url, protocols, { headers: headersOf(reqMsg.headers), handshakeTimeout: 15_000, maxPayload: 16 * 1024 * 1024 });
      } catch (e) {
        return fail(`ws-proxy: ${e.message}`);
      }
      upstream.on('open', () => {
        opened = true;
        client.send(JSON.stringify({ type: 'open', protocol: upstream.protocol || '' }));
        for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b });
      });
      upstream.on('unexpected-response', (_r, res) => {
        const headers = {};
        for (const k of ['content-type', 'cf-mitigated', 'cf-ray', 'request-id', 'x-request-id', 'retry-after']) if (res.headers[k] !== undefined) headers[k] = String(res.headers[k]);
        res.resume();
        try { client.send(JSON.stringify({ type: 'unexpected-response', status: res.statusCode || 0, statusText: res.statusMessage || '', headers })); } catch { /* gone */ }
        upstream.terminate?.();
        closeWith(client, 1000);
      });
      upstream.on('message', (d, b) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: b }); });
      upstream.on('error', (e) => { if (!opened) fail(`ws-proxy: ${e.message}`); });
      upstream.on('close', (code, reason) => {
        if (opened && client.readyState === WebSocket.OPEN) closeWith(client, code, String(reason || ''));
      });
    });
    client.on('close', (code, reason) => {
      clearTimeout(hello);
      live.delete(client);
      release();
      if (upstream && upstream.readyState === WebSocket.OPEN) closeWith(upstream, code, String(reason || ''));
      else upstream?.terminate();
      if (target) log(`[ws-proxy] ${ip} ${target} closed ${code} ms=${Date.now() - started}`);
    });
    client.on('error', () => upstream?.terminate());
  }

  return {
    handleUpgrade,
    stats: () => ({ connections: live.size }),
    close() { for (const ws of live) ws.terminate(); wss.close(); },
  };
}

// --- HTTP server ---
const TCP_RELAY_CONFIG = tcpRelayConfigFromEnv();
const tcpRelay = TCP_RELAY_CONFIG.enabled ? createTcpRelay(TCP_RELAY_CONFIG) : null;
const wsProxy = createWsProxy();

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  const browse = browseConfigFor(req.headers.host);
  if (appLabelOf(req.headers.host, browse)) return handleAppHost(req, res, browse);
  if (browseKeyOf(req.headers.host, browse)) return handleBrowseHost(req, res, browse);
  // Guests (docs/research/GUEST_PROFILE.md): what a guest may not ask of this server
  const guests = guestConfigFor(req.headers.host);
  const guest = guestOfRequest(req, guests);
  if (pathname === '/guest/config.json') {
    const own = guest?.via === 'host' ? guest : null;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...guestHeaders(own) });
    return res.end(JSON.stringify(guests
      ? { origin: guests.template, ...(own ? { guest: { name: own.name, ephemeral: own.ephemeral, noNetwork: own.noNetwork }, enforced: true } : {}) }
      : { origin: null }));
  }
  const refusal = guestRefusal(guest, req.method, pathname);
  if (refusal) {
    res.writeHead(403, { 'content-type': 'application/json', ...corsHeaders(req.headers['origin'], req.headers['access-control-request-headers']), ...guestHeaders(guest) });
    return res.end(JSON.stringify({ error: 'guest', reason: refusal }));
  }
  if (pathname === '/apps/config.json') {
    // Where app pages live (src/apps/frame.ts). None for a guest without network: its
    // Content-Security-Policy allows no frame of another origin, and it holds nothing to protect
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...guestHeaders(guest?.via === 'host' ? guest : null) });
    return res.end(JSON.stringify({ origin: browse && !guest?.noNetwork ? `${browse.scheme}://{app}.${browse.suffix}` : null }));
  }
  if (pathname === '/browse/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    // The Browser app is off in a guest: browse origins are shared by every app origin
    return res.end(JSON.stringify(browse && !guest ? { origin: browse.template, app: appOriginOf(req, browse), ...(BROWSE_SERVER_FETCH ? { serverFetch: true } : {}) } : { origin: null }));
  }
  if (pathname === '/browse/fetch' && BROWSE_SERVER_FETCH) {
    return handleBrowseFetch(req, res);
  }

  if (pathname === '/tcp/token' && tcpRelay) {
    return tcpRelay.handleToken(req, res);
  }

  // Seed sharing, before the API proxy (which would take /api/seed for an unknown target)
  if (pathname === '/api/seed' || pathname.startsWith('/api/seed/')) {
    return handleSeed(req, res, pathname);
  }
  if (pathname.startsWith('/api/')) {
    return handleProxy(req, res, pathname.slice(5));
  }
  if (pathname.startsWith('/claude-releases/')) {
    return handleClaudeReleases(req, res, pathname.slice('/claude-releases/'.length));
  }
  if (pathname.startsWith('/pyodide/v')) {
    // (only the shape of a distribution file: /pyodide/<repo> stays a repository link)
    const what = pyodideRequest(pathname);
    if (what) return pyodideMirror.handle(req, res, what, { ...isolationHeaders(), ...guestHeaders(guest) });
  }
  if (pathname.startsWith('/debian/pool/')) {
    // The GUI apps' .debs (src/gui/apps.ts fetches debian/<Filename>): the same mirror
    return handleDebianMirror(req, res, 'deb.debian.org/debian' + pathname.slice('/debian'.length));
  }
  // Git CORS proxy: /git-proxy/github.com/... or /git-proxy/https://github.com/...
  // isomorphic-git strips the protocol, sending just "github.com/..." as the path.
  // nginx merge_slashes may also collapse "https://" to "https:/".
  if (pathname.startsWith('/git-proxy/')) {
    let targetUrl = req.url.slice('/git-proxy/'.length);
    // Restore protocol if missing (isomorphic-git strips it)
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('https:/')) {
      targetUrl = 'https://' + targetUrl;
    }
    // Fix nginx merge_slashes: https:/ → https://
    targetUrl = targetUrl.replace(/^(https?:\/)([^/])/, '$1/$2');
    return handleGitProxy(req, res, targetUrl);
  }
  if (pathname === '/oauth/callback') {
    return handleOAuthCallback(req, res);
  }
  if (pathname.startsWith('/debian/mirror/')) {
    return handleDebianMirror(req, res, pathname.slice('/debian/mirror/'.length));
  }
  if (pathname.startsWith('/debian/layers/') && DEBIAN_LAYERS) {
    return handleDebianLayers(req, res, pathname.slice('/debian/layers/'.length));
  }
  if (pathname === '/health') {
    res.writeHead(200);
    return res.end('ok');
  }
  if (pathname === '/show') {
    res.writeHead(301, { location: '/about' });
    return res.end();
  }
  if (pathname === '/offer' || pathname.startsWith('/offer/') || pathname.startsWith('/answer/')) {
    return signaling.handle(req, res, pathname, corsHeaders(req.headers['origin'], req.headers['access-control-request-headers']));
  }
  if (pathname.startsWith('/relay/')) {
    const cors = corsHeaders(req.headers['origin'], req.headers['access-control-request-headers']);
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    return remoteRelay.handle(req, res, pathname, cors);
  }
  // /s/:id falls through to handleStatic which SPA-fallbacks to index.html
  return handleStatic(req, res, guest, guests);
});

// --- WebSocket relay ---
// Upgrades are routed by path here. (ws's own `path` option only matches exact
// strings, so the old regex path rejected every channel handshake with 400.)
const CHANNEL_PATH = /^\/channel\/[a-f0-9]{1,64}$/;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (appLabelOf(req.headers.host, browseConfigFor(req.headers.host))) return rejectUpgrade(socket, 404, 'Not found');
  if (browseKeyOf(req.headers.host, browseConfigFor(req.headers.host))) return rejectUpgrade(socket, 404, 'Not found');
  if (guestOfRequest(req)?.noNetwork) return rejectUpgrade(socket, 403, 'This guest has no network');
  if (CHANNEL_PATH.test(pathname)) {
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
  if (pathname === '/tcp' && tcpRelay) return tcpRelay.handleUpgrade(req, socket, head);
  if (pathname === WS_PROXY_PATH) return wsProxy.handleUpgrade(req, socket, head);
  rejectUpgrade(socket, 404, 'Not found');
});
const channels = new Map(); // channelId -> Set<WebSocket>
const rates = new WeakMap();

wss.on('connection', (ws, req) => {
  const channelId = new URL(req.url, 'http://localhost').pathname.slice(9); // "/channel/xxx" -> "xxx"
  if (!channels.has(channelId)) channels.set(channelId, new Set());
  const room = channels.get(channelId);
  room.add(ws);

  ws.on('message', (data) => {
    // Rate limit: 10 msgs/sec
    const now = Date.now();
    let r = rates.get(ws);
    if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 1000 }; rates.set(ws, r); }
    if (++r.count > 10) return;

    const msg = typeof data === 'string' ? data : data.toString();
    if (msg.length > 16384) return;

    for (const peer of room) {
      if (peer !== ws && peer.readyState === 1) {
        try { peer.send(msg); } catch { room.delete(peer); }
      }
    }
  });

  ws.on('close', () => {
    room.delete(ws);
    if (room.size === 0) channels.delete(channelId);
  });
});

// import.meta.url is the resolved path, so resolve argv[1] too: tabcomputer.com
// starts this through a `current -> releases/<sha>` symlink.
function isMainModule(arg) {
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(arg)).href; } catch { return false; }
}
const isDirectRun = isMainModule(process.argv[1]);

if (isDirectRun) {
  server.listen(PORT, () => {
    console.log(`Shiro server listening on :${server.address().port}`); // the real one when PORT=0
    if (tcpRelay) console.log(`[tcp] relay enabled at /tcp, ports ${TCP_RELAY_CONFIG.ports.join(',')}, origins ${TCP_RELAY_CONFIG.allowedOrigins.join(',')}`);
  });
}
