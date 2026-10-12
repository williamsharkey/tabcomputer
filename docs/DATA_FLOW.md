# How your data flows

What is true today, read from the code. Each claim names the code it comes from. The same content is in the app: the welcome card's "How your data flows" button, System → How Your Data Flows, Settings → Network, and the `dataflow` command (`src/data-flow.ts`, `src/desktop/apps/dataflow.ts`, `src/commands/dataflow.ts`). When the code changes, change this file and `src/data-flow.ts` together.

There are three places: **this tab** (your browser, this site's origin), **the site's server** (`server.mjs`, behind nginx on tabcomputer.com), and **the internet** (every other host).

## In the tab

- **Files** live in the browser's IndexedDB for this origin, database `tabcomputer-fs` (`src/filesystem.ts`). They are not uploaded anywhere. Clearing this site's data in the browser deletes them. So can the browser itself when the disk runs low, unless storage is persistent: the page asks for persistence after a large write or a big install (`src/storage.ts`), and Settings → Storage shows the answer.
- **Programs** (x86-64, WASM, node, the shell) run in the page and its Workers. Loopback connections (`localhost`, `127.0.0.1`) and local servers stay inside the page's kernel (`src/kernel/net.ts`).
- **Sign-ins** are stored here and nowhere else:

  | secret | where |
  |---|---|
  | GitHub token | `localStorage.tabcomputer_github_token` (`src/github-auth.ts`, `src/net-signin.ts`) |
  | Claude credentials | the file `~/.claude/.credentials.json` (`src/claude-signin.ts`) |
  | API keys set with the shell | `localStorage.tabcomputer_{anthropic,openai,google,api}_key` (`src/shell.ts`, `src/main.ts`) |
  | remote-control code | `localStorage.tabcomputer-remote-code` (`src/commands/remote.ts`) |

  **Every program that runs in the profile can read them.** `node`, npm install scripts and agents' tools are JavaScript in the page's origin; they can open IndexedDB and localStorage directly, and no kernel check is in that path (docs/research/GUEST_PROFILE.md). x86-64 and WASM programs read the files through the kernel, which does not hide them either.
- The server sets no cookie and keeps no account for you (`server.mjs` has no `set-cookie`).
- The page keeps its own console log and a freeze log in localStorage (`src/console-log.ts`, `src/watchdog.ts`). They are not sent anywhere unless a `remote` peer asks for them.

## Through the site's server

"Can read" below means the bytes pass through `server.mjs` unencrypted. "Logs" is what `server.mjs` writes to its own output (journald on the droplet). nginx sits in front; the repository's nginx config sets no `access_log`, so the distribution's default applies. What that default records on the droplet (normally the client address and the request line, which includes the path and query) was not checked: **unknown**.

| path | used by | the server can read | the server logs |
|---|---|---|---|
| Static files: the app, `/debian/chunks/`, `/debian/layers/`, `/pkg/`, `/recipes/`, `/apps/` (the apps the site ships), and on an app's own origin `/__tabcomputer/` (its frame, service worker and `tab.js`) | boot, `debian install`, `toolchain install`, `pkg`, `app install ID`, opening an app | which files this browser asks for. Nothing of yours is sent: an app's page, its files and its backend's answers stay in the tab | nothing |
| `/debian/mirror/…`, `/debian/pool/…` | `apt`, GUI apps | the package path. GET only, fixed upstreams (deb.debian.org, security.debian.org, snapshot.debian.org). The server fetches the file and keeps a copy on disk; Debian sees the server's address, not yours. apt checks signatures, GUI apps check sha256 | cache write failures |
| `/claude-releases/…` | `claude install` | the version asked for. GET only, from downloads.claude.ai, kept on disk, sha256-checked | one line per binary cached |
| `/tcp` (WebSocket to TCP relay), `/tcp/token` | every socket a program opens: curl, ssh, git in Debian, `claude --x86`, the Browser app, node `fetch` to a site without CORS (`src/commands/relay-fetch.ts`) | the host name, the port, how many bytes and when. **Not the contents when the program encrypts**: TLS and SSH are done in the tab (the program's own OpenSSL, or `src/browser/tls.ts`), so the relay carries ciphertext. Contents of unencrypted protocols (plain http on port 80, `git://`) are readable. Ports allowed by default: 22, 80, 443, 9418 | your address, host, resolved address and port, bytes up and down, duration, refusals. Never payloads |
| `/api/anthropic`, `/api/platform`, `/api/mcp-proxy`, `/api/gemini` | plain `claude` (`--vm`, the default on tabcomputer), `claude --npm`, Gemini CLI, any node program calling those hosts (`src/node-compat/execution.ts` rewrites the URL), Claude sign-in from Settings → Accounts | **everything**: the server ends the HTTPS connection and makes its own to the API. Prompts, replies and the `Authorization` header (your Claude token or API key) pass through it. It forwards them and does not store them | method and path of every request; per model call the model, stream flag, `max_tokens`, size, status and timing; up to 300 characters of an API error |
| `/api/ws-proxy` | `claude --vm` voice input | everything: the headers the tab sends (with the Claude token) and the audio frames. Only `wss://api.anthropic.com` is reachable | your address, the path, the close code, duration |
| `/api/github`, `/api/github-login` | `gh`, the Git app, the menu bar's account check, GitHub sign-in (device flow) | everything: the GitHub token in the `Authorization` header, requests and replies; during sign-in, the new token in GitHub's reply. Not stored | method, path, status |
| `/git-proxy/…` | `git clone`, `fetch`, `pull`, `push` (isomorphic-git, `src/commands/git.ts`) | everything: the GitHub token (basic auth, github.com remotes only) and the repository data. Reaches any public http(s) host on ports 80 and 443 | the URL, on an error |
| `/tcp/token` with a saved GitHub token | each relay token request (`relayToken` in `src/kernel/net.ts`) | the GitHub token, sent as `Authorization: Bearer`. tabcomputer.com does not require or check it today (`TABCOMPUTER_TCP_REQUIRE_SIGNIN=0`), but the page sends it anyway | nothing |

**Browse origins** (`{key}.web.<domain>`, the Browser app): the server serves four fixed scripts and a bootstrap page there, nothing else. Page content comes from the app in your tab, fetched over `/tcp` with TLS in the tab, so the server sees hosts and sizes, not pages. A server-side fetch that would see plaintext exists for measurement only and is off unless `TABCOMPUTER_BROWSE_SERVER_FETCH=1` (`server.mjs`).

## Straight from the browser, not through the server

The browser itself connects to these, so they see your address and the request, like any website:

- the npm registry (`registry.npmjs.org`, `src/commands/npm.ts`) and PyPI (`pypi.org`, `src/commands/pip.ts`);
- CDNs some commands load code from (`esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`) and the Wasmer registry for some packages (`src/pkg-index.json`);
- any site a node program `fetch`es that allows cross-origin requests;
- DNS-over-HTTPS at `cloudflare-dns.com`, when the relay's own lookup is not used (`src/kernel/net.ts`);
- the Claude and GitHub sign-in pages, which open in another browser tab;
- Google's STUN servers, during `remote start` (`src/commands/remote.ts`).

Settings → Network says "the npm registry proxy". There is none: npm goes straight to the registry.

## Only when you run them

- **`remote start`** lets whoever holds the code drive this tab: run commands, read and write files, evaluate JavaScript, read the console (`src/commands/remote.ts`). The tab posts its WebRTC offer and the code to the server (`/offer`); the peer fetches it with the code. Data then goes peer to peer over WebRTC, or, when that cannot connect, through the server's `/relay/` mailbox, sealed with a key derived from the code (`src/remote-relay.ts`). **The server receives that code** in `POST /offer` and writes it to its log (`[signal] offer registered: CODE`), so the sealing does not keep the server out. Offers are kept in memory for 5 minutes.
- **`seed share`** uploads a snapshot to the server (`POST /api/seed`): every file **and all of localStorage, which includes the GitHub token; the files include `~/.claude/.credentials.json`** (`serializeState` in `src/commands/seed.ts`; it prints a warning only for values that look like API keys). At most 512 KB compressed. Anyone with the link can download it. The server stores it with your address and deletes it 60 days after the last visit. `seed` without `share` copies the same snapshot to the clipboard instead.
- **`group`** relays messages between tabs through the server's `/channel/` WebSocket, unencrypted (`src/commands/group.ts`).
- **`download`, `upload`, drag and drop** move files between the tab and your own disk. No server is involved.

## Guest profiles

A guest is the app on another origin, `guest--<name>[--t][x].<base>` (`src/guest.ts`, server.mjs "Guests", docs/research/GUEST_PROFILE.md).

- The browser keeps a guest's storage apart from the main profile's. What runs in a guest cannot read the main profile's files, `~/.claude`, git settings or GitHub token.
- A guest starts with no sign-ins. A sign-in made or a key pasted there can be read by everything that runs there. The server refuses the GitHub device flow to a guest.
- **Thrown away** (`t`): Discard deletes everything the origin stores. Closing the tab deletes nothing; what is left is deleted the next time that address opens in a new tab.
- **No network** (`x`): the page gives programs no relay, the server refuses its relay and proxies to that host, and a Content-Security-Policy makes the browser refuse requests to other sites. Static files, `/debian/` and `/claude-releases/` still answer. It does **not** stop the page navigating itself to another address, so a script can still send out what is in the guest.
- With a network, a guest uses the same relay and proxies as above, from your address.
- A guest under the same domain is same-site with the main profile. The separation then also rests on the checks listed in GUEST_PROFILE.md ("Same site").
- Guests are a server setting: on for tabcomputer.com (`TABCOMPUTER_GUESTS=1` in `profiles/tabcomputer/server.env`) and for localhost, off on any other server until it sets that. The app asks `/guest/config.json` and offers a guest only when the server has them; otherwise it says there are none.

## Using your own relay or server

**What can be changed in the app:** the TCP relay. Settings → Network → Connection → "My relay" takes a `ws://` or `wss://` relay URL and a token URL, saved in `localStorage.tabcomputer_relay` (`ownRelay`, `setOwnRelay`, `relayNetConfig` in `src/net-signin.ts`). Programs' sockets then go through your relay, and the site's server no longer sees those hosts and sizes. Your GitHub token is not sent to it.

To run one:

```bash
git clone https://github.com/williamsharkey/tabcomputer && cd tabcomputer
npm install
TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=https://tabcomputer.com PORT=8787 node server.mjs
```

Then enter `wss://your-host/tcp` and `https://your-host/tcp/token`. `server.mjs` refuses a connection without a token, so the token URL is needed with it. A page served over https can only open `wss://` (your relay needs TLS in front), except to `localhost`. Whether a browser lets tabcomputer.com reach `ws://localhost:8787` without a prompt was not tested: **unknown**.

**What your own relay does not change:**

- The `/api/…` proxies, `/git-proxy/`, the Debian mirror, Claude releases and the static files still come from the site you opened. Claude prompts and GitHub traffic keep passing through that site's server.
- The setting is applied by the desktop only (`initNetwork` in `src/desktop/network.ts`). In the terminal UI (`?ui=terminal`) it is ignored and the site's relay is used.
- A no-network guest has no relay, yours included.

Two environment variables move single paths, per shell: `GIT_CORS_PROXY` (the git proxy, `src/commands/git.ts`) and `ANTHROPIC_BASE_URL` (where node programs send Anthropic API calls, `src/node-compat/process.ts`). There is no setting for the other proxies.

**To keep everything on your own machine**, serve the whole app yourself. Then your server is "the site's server" in every row above:

```bash
git clone https://github.com/williamsharkey/tabcomputer && cd tabcomputer
npm install && npm run build
PORT=8080 STATIC_DIR=$PWD/dist TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=http://localhost:8080 node server.mjs
```

Open `http://localhost:8080`. Guests are on for localhost. The Debian base system (`public/debian/`) is built separately (docs/DEBIAN.md); without it `debian install` has nothing to fetch.

## Not established from the code

- What nginx on the droplet writes to its access log, and how long the server's logs are kept.
- Whether the droplet's disk or logs are read by anyone, or backed up.
- What the third parties above (npm, PyPI, CDNs, Cloudflare, Google STUN, GitHub, Anthropic) record.
- `ws://localhost` relays from an https page (above).
