# tabcomputer for school IT

tabcomputer is a web page. A student opens a link in Chrome or Edge and gets a Linux desktop with an editor, a terminal and compilers, running inside that browser tab. This page says what the tab connects to, which hosts to allow, and what it leaves on the computer. The details, with the code each claim comes from, are in [DATA_FLOW.md](DATA_FLOW.md) and [NETWORKING.md](NETWORKING.md).

## Nothing is installed

- There is no installer, no browser extension, no native program and no administrator right. The page runs in the browser's sandbox like any website.
- Programs (Python, gcc, node, git) are WebAssembly or run in an emulator written in WebAssembly. They cannot reach the computer's disk, other programs, or the local network except through the browser.
- Files and sign-ins are kept in the browser's storage for the site (IndexedDB and localStorage), in the browser profile that opened it. Clearing the site's data in the browser removes all of it.
- The site sets no cookie and keeps no account. A student signs in to GitHub with GitHub's own device flow; the token stays in the browser.

## Hosts to allow

All connections are HTTPS or secure WebSocket on port 443, made by the browser.

| Host | Needed for | Without it |
| --- | --- | --- |
| `tabcomputer.com` (HTTPS and `wss://`) | The page, the Linux packages and toolchains, GitHub traffic (below), and the relay that carries programs' own connections (`wss://tabcomputer.com/tcp`) | Nothing works |
| `github.com` | The sign-in page a student opens to enter the device code | No sign-in: private class repositories cannot be opened or submitted |
| `esm.sh` | The Code app's editor component | The Code app does not load. `vi` in the terminal still works |
| `*.tabcomputer.com` | Guest profiles (`guest--NAME.tabcomputer.com`) and pages shown by the Browser app and by installed apps (`*.web.tabcomputer.com`) | Guests, the Browser app and installed apps do not open. A class that only edits, runs and submits does not need them |
| `api.github.com`, `raw.githubusercontent.com` | Private network mode (below), and run links to scripts in GitHub repositories | Private mode cannot reach GitHub |
| `registry.npmjs.org` | `npm install` | No npm packages |
| `pypi.org`, `files.pythonhosted.org` | `pip install` | No pip packages |
| `cdn.jsdelivr.net`, `unpkg.com` | Code some commands load on first use | Those commands fail and say so |
| `cloudflare-dns.com` | Name lookups for programs, when the relay's own lookup is not used | Programs' lookups fail in that case |

A class that uses the standard library of its language needs the first three rows.

A filter that inspects TLS must let WebSocket upgrades through on `tabcomputer.com`. The page also needs the response headers `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` to arrive unchanged; a proxy that strips them leaves the page running in a slower mode without threads.

## What goes where

- **Files stay in the tab.** They are not uploaded. They leave the browser only when the student pushes to GitHub, downloads a file, or runs a program that sends them somewhere.
- **GitHub traffic** (clone, push, the sign-in's token exchange) goes through `tabcomputer.com` by default: the browser cannot make those requests itself. The server forwards them and stores nothing, but it can read them in transit, the GitHub token included. See "Private network mode" to change that.
- **Programs' own connections** (`curl`, `ssh`, `apt`) go through the relay at `tabcomputer.com/tcp`. The relay sees the host name, the port and the byte counts, and logs them with the client's address. It does not see the contents of TLS or SSH connections. It allows ports 22, 80, 443 and 9418 and refuses private, local and link-local addresses ([NETWORKING.md](NETWORKING.md) "Security model"). It dials from the server, not from the school, so it gives a program in the tab no path into the school's internal network.
- **Loopback stays in the tab.** A web server a student starts on `localhost` is reachable only from that tab.
- **Claude Code** is available in the tab but is not part of the class workflow. It runs only if a student signs in to Claude; its traffic then goes through `tabcomputer.com` to Anthropic.

## Private network mode

Settings, Network, Privacy (or `netmode private` in the terminal) changes the GitHub traffic so that the site's server cannot read it: the browser talks to `api.github.com` directly, and what cannot go that way is encrypted in the tab and carried by the relay as ciphertext. The server then sees host names and byte counts only. It is slower for large repositories, and it needs `api.github.com` and `raw.githubusercontent.com` allowed. The setting is per browser profile. [NETWORKING.md](NETWORKING.md) "Private mode" has the full table and the costs.

A school can also run the relay or the whole server itself: it is one Node program (`server.mjs`). [DATA_FLOW.md](DATA_FLOW.md) "Using your own relay or server" says how.

## Shared computers

On a computer several students use, the previous student's files and GitHub sign-in are still in the browser profile unless they are removed.

- **Sign Out and Erase** (Settings, Accounts, or `signout` in the terminal) removes the GitHub sign-in, the Claude sign-in and every file of the tab computer from the browser. It first lists what it will delete and which work has not been pushed to GitHub. See [CLASSROOM.md](CLASSROOM.md).
- It does not revoke the token at GitHub. A student can do that at github.com, Settings, Applications.
- Browser profiles that are wiped at logout (a managed guest session, a kiosk profile, or "clear site data on exit" for `tabcomputer.com`) do the same thing without relying on the student. Then the push is the only copy of the work: the Code app shows "Not saved to GitHub yet" and the tab warns before it closes while work is unpushed.
- Storage: a toolchain is kept in the browser's storage for the profile and fetched as its programs are first used (`toolchain list` in the terminal shows each set's size). A profile that is wiped fetches it again.

## Browser

A current Chromium browser (Chrome, Edge) on a desktop or laptop. The measurements in this repository are from Chromium ([../README.md](../README.md)); other browsers are not measured here.
