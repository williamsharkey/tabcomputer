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
  | remote-control code (both parts) | `localStorage.tabcomputer-remote-code` (`src/commands/remote.ts`) |

  **Every program that runs in the profile can read them.** `node`, npm install scripts and agents' tools are JavaScript in the page's origin; they can open IndexedDB and localStorage directly, and no kernel check is in that path (docs/research/GUEST_PROFILE.md). x86-64 and WASM programs read the files through the kernel, which does not hide them either.
- The server sets no cookie and keeps no account for you (`server.mjs` has no `set-cookie`).
- The page keeps its own console log and a freeze log in localStorage (`src/console-log.ts`, `src/watchdog.ts`). They are not sent anywhere unless a `remote` peer asks for them.

## Through the site's server

"Can read" below means the bytes pass through `server.mjs` unencrypted. "Logs" is what `server.mjs` writes to its own output (journald on the droplet). nginx sits in front; the repository's nginx config sets no `access_log`, so the distribution's default applies. What that default records on the droplet (normally the client address and the request line, which includes the path and query) was not checked: **unknown**.

| path | used by | the server can read | the server logs |
|---|---|---|---|
| Static files: the app, `/debian/chunks/`, `/debian/layers/`, `/pkg/`, `/recipes/` | boot, `debian install`, `toolchain install`, `pkg` | which files this browser asks for. Nothing of yours is sent | nothing |
| `/debian/mirror/…`, `/debian/pool/…` | `apt`, GUI apps | the package path. GET only, fixed upstreams (deb.debian.org, security.debian.org, snapshot.debian.org). The server fetches the file and keeps a copy on disk; Debian sees the server's address, not yours. apt checks signatures, GUI apps check sha256 | cache write failures |
| `/claude-releases/…` | `claude install` | the version asked for. GET only, from downloads.claude.ai, kept on disk, sha256-checked | one line per binary cached |
| `/tcp` (WebSocket to TCP relay), `/tcp/token` | every socket a program opens: curl, ssh, git in Debian, `claude --x86`, the Browser app, node `fetch` to a site without CORS (`src/commands/relay-fetch.ts`) | the host name, the port, how many bytes and when. **Not the contents when the program encrypts**: TLS and SSH are done in the tab (the program's own OpenSSL, or `src/browser/tls.ts`), so the relay carries ciphertext. Contents of unencrypted protocols (plain http on port 80, `git://`) are readable. Ports allowed by default: 22, 80, 443, 9418 | your address, host, resolved address and port, bytes up and down, duration, refusals. Never payloads |
| `/api/anthropic`, `/api/platform`, `/api/mcp-proxy`, `/api/gemini` | plain `claude` (`--vm`, the default on tabcomputer), `claude --npm`, Gemini CLI, any node program calling those hosts (`src/node-compat/execution.ts` rewrites the URL), Claude sign-in from Settings → Accounts | **everything**: the server ends the HTTPS connection and makes its own to the API. Prompts, replies and the `Authorization` header (your Claude token or API key) pass through it. It forwards them and does not store them | method and path of every request; per model call the model, stream flag, `max_tokens`, size, status and timing; up to 300 characters of an API error |
| `/api/ws-proxy` | `claude --vm` voice input | everything: the headers the tab sends (with the Claude token) and the audio frames. Only `wss://api.anthropic.com` is reachable | your address, the path, the close code, duration |
| `/api/github`, `/api/github-login` | `gh`, the Git app, the menu bar's account check, GitHub sign-in (device flow) | everything: the GitHub token in the `Authorization` header, requests and replies; during sign-in, the new token in GitHub's reply. Not stored | method, path, status |
| `/git-proxy/…` | `git clone`, `fetch`, `pull`, `push` (isomorphic-git, `src/commands/git.ts`) | everything: the GitHub token (basic auth, github.com remotes only) and the repository data. Reaches any public http(s) host on ports 80 and 443 | the URL, on an error |
| `/tcp/token` on a server that requires a sign-in (`TABCOMPUTER_TCP_REQUIRE_SIGNIN=1`; tabcomputer.com does not) | each relay token request (`relayToken` in `src/kernel/net.ts`) | the GitHub token, as `Authorization: Bearer`; the server checks it with GitHub (`githubSigninVerifier`) and keeps a hash of it in memory for 10 minutes. The page asks without it first and sends it only after the server answered `401 {"error":"signin_required"}`; a server that issues tokens to anyone never receives it | nothing |

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

- **`remote start`** lets whoever holds the code drive this tab: run commands, read and write files, evaluate JavaScript, read the console (`src/commands/remote.ts`). The code has two parts, `<id>#<secret>` (`src/remote-relay.ts`). The tab gives the server the id and its WebRTC offer sealed (AES-GCM) with a key derived from the secret (`POST /offer {v: 3, id, sealed}`); the peer fetches it by id and answers the same way. Data then goes peer to peer over WebRTC, or, when that cannot connect, through the server's `/relay/` mailbox, sealed with a key derived from the secret. **The server is never given the secret**, in a body, a path or a header, so it can read neither the offer nor the relayed messages, and it cannot answer in the peer's place (`createSignaling` in `server.mjs`; `remote-relay.test.ts` tries every value the handlers see as the key). It sees and logs the id (`[signal] offer registered: ID`), your address, and the sizes and timing of the sealed messages. Offers are kept in memory for 5 minutes. Requests in the older form, where the code itself was posted, are refused (426) and not logged.
- **`seed share`** uploads a snapshot of this machine to the server (`POST /api/seed`, at most 512 KB compressed). Anyone with the link can download it. The server stores it with your address and deletes it 60 days after the last visit. Before uploading, the command prints the file count, the size, what it left out and that the link is public, and asks for a typed `yes` (`--yes` skips the question; with nobody to ask it uploads nothing). **It carries no credentials** (`collectSeedState` in `src/seed-state.ts`, from the one list in `src/credentials.ts`):
  - left out whole: `~/.claude/.credentials.json`, `~/.claude.json`, ssh private keys and everything in `~/.ssh` but public keys, `known_hosts`, `config` and `authorized_keys`, `~/.netrc`, `~/.git-credentials`, gh's `hosts.yml`, `~/.pypirc`, `~/.aws/credentials`, `~/.docker/config.json`, `~/.kube/config`, cargo/gem/Codex/Gemini/opencode sign-in files, `~/.config/gcloud`, `~/.azure`, `~/.gnupg`, `.env` files (not `.env.example`), and any text file up to 1 MB that contains something shaped like a token or a private key (Anthropic, OpenAI, GitHub, Google, AWS, Slack, GitLab, npm, Hugging Face, Stripe);
  - kept without the lines that hold a login: `~/.gitconfig` and every repository's `.git/config` (`[credential]` sections, `user:password@` in URLs, Authorization headers), `~/.npmrc` and `.yarnrc` (auth tokens), shell startup files and histories (`NAME_TOKEN=…`-style assignments, lines with a token);
  - of localStorage, only layout and preferences go (an allowlist). The GitHub token, API keys, the own-relay setting, the remote-control code, the `wal:` copies node keeps of `~/.claude` files, the console log and anything not listed stay.

  The output lists every file and entry left out, by name. **What it cannot do:** recognise a secret with no known shape inside one of your own files (a password in a notes file, a token in a format not listed). Those go with the rest: read the file count and remove what should not be public. `seed share --with-credentials` is refused.
- **`seed`, `seed blob`** copy the same snapshot to the clipboard as a snippet to paste into another page's DevTools console; **`seed gif`, `seed html`** save it as a file on your disk. Same rules: no credentials unless `--with-credentials` (for moving your own machine; the output then starts with a warning and lists what is included; the remote-control code is never included). The snippet opens tabcomputer from this site in a frame and hands it the state (it used to load `https://shiro.computer` whatever site made it). A `seed blob` runs in the origin of the page it is pasted into, so that site's scripts can read the files.
- **Opening a seed** (`/s/<id>`, a dropped seed GIF, a pasted snippet; `importSeedState` in `src/seed-state.ts`) replaces every file. It does not replace your sign-ins: your own credential files are put back over the seed's, a credential entry in the seed's localStorage is taken only where you have none, and a remote-control code or `wal:` copy never. A `/s/<id>` link asks before it loads (`window.confirm`): the seed's startup scripts run in this profile afterwards and can read whatever it is signed in to, so open one only from someone you trust (a guest window is the place for the others, though a link does not open in one by itself).
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

**What can be changed in the app:** the TCP relay. Settings → Network → Connection → "My relay" takes a `ws://` or `wss://` relay URL and a token URL, saved in `localStorage.tabcomputer_relay` (`ownRelay`, `setOwnRelay`, `relayNetConfig` in `src/net-signin.ts`). Programs' sockets then go through your relay, and the site's server no longer sees those hosts and sizes. Your GitHub token is not sent to it, unless you tick the box 'Give this relay my GitHub sign-in if it asks for one' (`sendSignin`); then it is sent after that relay's token URL answered `401 signin_required`, as with the site's.

To run one:

```bash
git clone https://github.com/williamsharkey/tabcomputer && cd tabcomputer
npm install
TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=https://tabcomputer.com PORT=8787 node server.mjs
```

Then enter `wss://your-host/tcp`. The token URL may stay empty: the page then asks `https://your-host/tcp/token` (`/token` next to the relay URL, `relayTokenUrlFor` in `src/net-signin.ts`), which is where `server.mjs` issues the token it requires. A relay that has nothing at that path is used without a token; fill the field in only when its tokens come from somewhere else. A page served over https can only open `wss://` (your relay needs TLS in front), except to `localhost`. Whether a browser lets tabcomputer.com reach `ws://localhost:8787` without a prompt was not tested: **unknown**.

**What your own relay does not change:**

- The `/api/…` proxies, `/git-proxy/`, the Debian mirror, Claude releases and the static files still come from the site you opened. Claude prompts and GitHub traffic keep passing through that site's server.
- The setting is made in the desktop (Settings is a desktop app; there is no command for it) and applied in both UIs: boot points the kernel's sockets at it (`followRelaySetting` in `src/kernel/net.ts`), so `?ui=terminal` uses your relay too.
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
