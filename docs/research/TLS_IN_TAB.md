# TLS in the tab for the paths that end at the server

A design note, not an implementation. It comes from the "by design" finding in
[docs/DATA_FLOW.md](../DATA_FLOW.md) (issue #117): the default `claude` (`--vm`)
reaches Anthropic through `/api/anthropic`, and GitHub traffic goes through
`/git-proxy`, `/api/github` and `/api/github-login`. On each of them
`server.mjs` ends the HTTPS connection and opens its own, so prompts, replies
and tokens are readable there in transit. Only `claude --x86` is end to end:
its own TLS, carried as ciphertext by the `/tcp` relay.

Everything below was read from the code at Build 1004. Nothing in it was
measured for this note; where a number is needed it says so.

## Why each proxy exists

| path | upstream | why the page can't call it directly | code |
|---|---|---|---|
| `/api/anthropic`, `/api/platform`, `/api/mcp-proxy` | api.anthropic.com, platform.claude.com, mcp-proxy.anthropic.com | A page's `fetch` always sends `Origin` and the browser's `User-Agent`, and the API refuses OAuth tokens from a browser (`SKIP_REQUEST_HEADERS` drops `origin`, `referer`, `sec-fetch-*`, `anthropic-dangerous-direct-browser-access`; the proxy sets a node-like `user-agent`: "Browser UA causes API to reject OAuth tokens"). API keys can go direct with `anthropic-dangerous-direct-browser-access` (`src/commands/cv.ts` does); subscription tokens can't. Also no 5-minute header timeout (undici `Agent`) and one log line per model call | `handleProxy`, `PROXY_TARGETS` in `server.mjs`; `corsProxyMap` in `src/node-compat/execution.ts`; `ANTHROPIC_BASE_URL` in `src/node-compat/process.ts` |
| `/api/gemini` | generativelanguage.googleapis.com | "Google's API rejects its preflights (custom x-goog headers)" | same |
| `/api/ws-proxy` | wss://api.anthropic.com (voice) | The page's `WebSocket` cannot send an `Authorization` header | `createWsProxy` in `server.mjs`; `wsShimSource` in `src/claude-vm/extract.ts` |
| `/api/github` | api.github.com | Mostly habit: api.github.com allows `Authorization: Bearer` from any origin, and the Git app already calls it directly with the proxy as the fallback (`src/desktop/github-home.ts`). `gh` always uses the proxy (`ghApi` in `src/commands/gh.ts`) | same |
| `/api/github-login` | github.com `/login/device/code`, `/login/oauth/access_token` | "GitHub's OAuth device flow lives on github.com, which has no CORS" | `PROXY_ALLOWED_PATHS`; `src/github-auth.ts` |
| `/git-proxy/…` | any public http(s) git host | Git's smart-HTTP endpoints send no CORS headers; isomorphic-git takes a `corsProxy`. The proxy also drops `WWW-Authenticate` (a same-origin 401 with it makes the browser show a login prompt that stalls the origin) and re-checks every redirect hop against private addresses | `handleGitProxy`, `gitProxyRefusal`; `corsProxy` in `src/commands/git.ts` |

So the reasons are: headers a page cannot set or cannot avoid sending, hosts
with no CORS, and a WebSocket that needs a header. None of them needs the
server to see the contents. Streaming is not a reason either way: the proxies
pipe bodies through, and so can the tab.

## What the tab already has

There is no need to pick a JS or WASM TLS stack: the tab has one, written for
the Browser app and already used by commands.

- `src/browser/tlsclient.ts`: a TLS 1.3 and 1.2 client on WebCrypto (X25519,
  P-256, P-384; AES-GCM; ECDSA and RSA-PSS; ALPN), with a Chrome-shaped or a
  narrow ClientHello. `src/browser/tls.ts` wraps it and holds the trust roots.
- Certificates: `src/browser/vendor/subtls` checks chains, names, validity
  and CA key usage against Mozilla's roots (`public/browse/cacert.pem`,
  189 KB, from curl.se) plus roots the user added.
- `src/browser/http1.ts`, `http2.ts` + `hpack.ts`, `websocket.ts`, and
  `netfetch.ts` (`NetFetcher`: a `fetch` over those, one shared HTTP/2 session
  per origin or up to six kept-alive HTTP/1.1 connections).
- `src/commands/relay-fetch.ts` (`relayFetch`): a `fetch(url, init)` built on
  that, over the kernel's relay sockets. curl and wget use it, and
  node-compat's `fetch` already falls back to it when a cross-origin request
  fails for lack of CORS (`execution.ts`, after `_origFetch` rejects). It
  works from a node Worker through the guest's own sockets. Response bodies
  are streams; the request body is buffered.

What is missing is routing, not cryptography. Two gaps:

- node-compat's `tls` module is inert ("tls has no userspace TLS
  implementation here", `src/node-compat/modules/net-tls.ts`), and `https` is
  built on `fetch`. A program that opens `tls.connect` itself gets nothing.
- A WASM stack is also present in another form: curl's own OpenSSL (WASIX)
  and the x86 programs' libraries do TLS over the relay today. They serve
  those programs, not node-compat.

## What each path would take

1. **`/api/github` → the browser, directly.** api.github.com accepts the
   token cross-origin, so `ghApi` and the menu bar's account check can do what
   `github-home.ts` does. This is the browser's own TLS: no relay, no server,
   nothing to build. The fallback for a request that can't go direct (a
   redirect to a host without CORS, an upload host) should be `relayFetch`,
   not the proxy.
2. **`/api/github-login` → `relayFetch`.** Two small POSTs. The new token
   then exists only in the tab.
3. **`/git-proxy` → an isomorphic-git `http` client on `relayFetch`.**
   isomorphic-git takes the HTTP client as a parameter, so this is one adapter
   (request body as an async iterable in, response body as one out) and no
   `corsProxy`. `WWW-Authenticate` stops mattering (nothing is same-origin).
   The redirect and private-address checks move to where they already are for
   every relay connection (`isBlockedAddress` in the relay). `relayFetch`
   buffers the request body; a push of a large pack needs it streamed
   (`NetRequest.body` already accepts a stream).
4. **`/api/anthropic`, `/api/platform`, `/api/mcp-proxy`, `/api/gemini` →
   `relayFetch` from node-compat's `fetch`.** Replace the `corsProxyMap`
   rewrite with "send these hosts over the relay". The tab sets every header
   itself (no `Origin`, any `User-Agent`), which is the proxy's whole job.
   Server-sent events arrive as a stream already. `ANTHROPIC_BASE_URL` stops
   pointing at the origin.
5. **`/api/ws-proxy` → `src/browser/websocket.ts` over in-tab TLS**, with the
   `Authorization` header in the handshake the tab writes.
6. **node-compat `tls.connect`** on `tlsclient.ts` over a `KSocket`, so
   programs that do their own HTTPS work, and `https` can stop depending on
   which hosts have CORS. Useful, not required for 1–5.

## Costs and risks

- **Speed.** Per connection: one relay WebSocket, a token, a TCP connect and
  a full TLS handshake in JavaScript (no session resumption in
  `tlsclient.ts`). `NetFetcher` keeps connections, so a Claude session pays it
  once per origin, not per call. Bulk transfer is AES-GCM through
  `crypto.subtle`, one awaited call per record: fine for prompts, **unmeasured
  for a large `git clone` or push**. Measure both before deciding 3 (a clone of
  a repository of some tens of MB, against the same clone through the proxy).
  The crypto runs on the page's thread, or in the node Worker when the caller
  is one: a frozen page stalls a stream, as it does today.
- **Size.** The TLS, HTTP/2 and subtls code is in the build already (the
  Browser app and curl load it lazily). New for a `claude` session: that chunk
  and the 189 KB root file, once.
- **HTTP/2.** Implemented (`http2.ts`, HPACK, flow control), and exercised by
  the Browser app's scoreboard. The APIs here also speak HTTP/1.1, so
  `http2: false` is an available fallback per host.
- **Certificate validation and the CA store.** This is the real cost. The
  browser's verifier is replaced by ours: chains, names, validity and key
  usage are checked; **revocation (OCSP, CRL) and Certificate Transparency
  are not**, and there is no chain building beyond what the server sends. The
  root file ships with the build, so a distrusted root stays trusted until the
  next release, and it is fetched from the site's server: the server can hand
  out a root of its own. That is the limit of this design. It moves the
  server from "reads everything by default" to "would have to serve a
  malicious page or root file", which is the trust a web app's server always
  has (it serves the code). Pinning the root file's hash in the build makes it
  the same trust as the code, no more.
- **Fingerprints.** The upstreams sit behind bot defenses. Today they see
  node's TLS from the server; they would see our Chrome-shaped or narrow
  hello with node-like headers, from the same address. `claude --x86` shows
  the relay's address is accepted with Bun's TLS; ours is a new combination
  and has to be tried against api.anthropic.com and github.com.
- **Relay limits.** Model streams become relay connections: the 5-minute idle
  timeout, the 4-hour lifetime, 1 GB per connection and the per-address byte
  budget (`tcpRelayConfigFromEnv`) now apply to them. A long thinking pause
  with no bytes for 5 minutes would be cut; whether the API's keep-alive
  events prevent that was not checked.
- **What the server loses.** The per-call log line (`[proxy] messages model=…
  bytes=…`) and the API error excerpts, which are how stuck sessions have been
  diagnosed. It keeps host, port, sizes and timing from the relay log. The
  tab's own console log can carry what the proxy logged.
- **No relay, no Claude.** A server without `TABCOMPUTER_TCP_RELAY=1`, or a
  no-network guest, has no path at all then. The proxies would have to stay as
  an explicit, labelled fallback for such servers, or the relay becomes a
  requirement for `claude`.

## Recommendation

Do it in this order, each step shippable alone, and keep the explainer honest
at each one (a path moves from "server can read the contents" to "server sees
where, not what" only when the proxy is no longer used for it):

1. `/api/github` direct from the browser, and `/api/github-login` over
   `relayFetch`. Small, no performance question, and it takes the GitHub token
   off the server entirely for `gh` and sign-in.
2. The model APIs over `relayFetch`, behind a setting first
   (`TABCOMPUTER_CLAUDE_TLS=tab`), with the proxy as the default until the
   fingerprint and idle-timeout questions are answered on production. This is
   the one that matters most: prompts, replies and the Claude token.
3. git over `relayFetch` after measuring a large clone and push; keep
   `GIT_CORS_PROXY` as the way back.
4. Pin the hash of `cacert.pem` in the build when 2 becomes the default.
5. The voice WebSocket and node's `tls.connect` last.

Not recommended: a second TLS stack in WASM for node-compat. The one in
`src/browser` is already the code the Browser app trusts with page traffic;
two verifiers would be two places for a certificate bug.
