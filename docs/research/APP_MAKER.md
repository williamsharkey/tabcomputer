# tabcomputer as an app maker: `serve` and `become` against a hardwired app

Research worker (unix/app-maker-converter), 2026-10-12.

**The question.** Are `serve`, `serve open` and `become` good enough for a fast,
seamless app, or does that take hardwiring the app into tabcomputer?

**The answer.** For speed, yes: they are good enough today, and hardwiring buys
almost nothing. The same converter built both ways starts in 0.12 s against
about 1 ms, and costs about 55 ms more per file (134 ms against 80 ms median),
of which the conversion program itself is 70 ms. With four conversions at a
time the user-space app finishes 50 files in 4.8 s; the thin hardwired window,
which runs them one by one, takes 9.4 s. For seamlessness, no, and none of what
is missing is about speed or needs hardwiring: nothing installs or launches an
app (three typed commands), a reload loses it, the deployed `become` cannot
show an app that has a backend, the window is a developer's Preview with a
`localhost:4780` title, and a served page runs with the tab's full authority,
tokens included. The recommendation is to keep apps in user space and build a
thin app layer over what exists: a manifest, an `app` command with a dock
entry and an address, a supervised backend, a small client library, and an
origin of their own for app pages. The rest of this document is the evidence
and that design.

**Verified** means run in a real tab: headless Chrome on a Mac driving
https://tabcomputer.com (Builds 995 to 998 as deployed that day; parts 2 and 3
logged commit 2151f107, Build 998), or, where it says "local build", this
branch's own build served by `server.mjs` with the converter programs stood in
for by shell scripts. The scripts are in `apps/converter/measure/`, their raw
output in `apps/converter/measure/results/`.

## What was built

| | Where | Size |
|---|---|---|
| The app, in user space | `apps/converter/`: `server.js` (node `http`, `fs`, `child_process`; 370 lines), `public/` (a page with plain `fetch`; 300 lines of JS) | no tabcomputer API used |
| The app, hardwired (thinnest version) | `src/desktop/apps/converter.ts`: a desktop window that writes dropped files with the filesystem object and runs the converter in a forked shell, as Files and Git do. `desktop open converter`; not in the dock | 135 lines |
| A fix it needed | `src/commands/become.ts`, `src/main.ts`: `become PORT SLUG --start CMD`, and the app page as a real document | tests in `become.test.ts` |
| A browser check | `tests/browser/app-converter.mjs`: 25 checks of both versions against a local server, converters stubbed | |
| A manifest | `apps/converter/app.json`: the proposal below, written out. Nothing reads it | |

The user-space app does what issue #114 asks: drop files or a folder, pick
HTML or CSV (DOCX and PDF appear when `pandoc` or `soffice` is installed),
results in `~/Converted/<date-time>/`, a list of what failed with the
converter's own message, "Download all" as a zip, and a first-use install with
its log on the page. The hardwired one does a drop, one conversion per file,
the results folder and the zip. It installs nothing.

## How a served page reaches its backend today

Found by building, not from the docs; `apps/converter/README.md` has the short
form for app authors.

- **The page is a real document** at `/__preview/<tab>/<port>/`. The preview
  service worker (`public/preview-sw.js`) sends every request the document
  makes to the tab, which calls the node server's request handler
  (`src/preview-sw-host.ts`). `fetch('/api/…')` works with a binary request
  body and a binary response, and a response written in pieces arrives in
  pieces. That is the whole bridge an outside developer needs, and it is
  ordinary HTTP: the same page and server run outside tabcomputer.
- **Dropped `File` objects** have no direct way into the tab's filesystem from
  a served page. The page `PUT`s the bytes to its server, which writes them.
- **A file reaches the real disk** as `fetch` → `Blob` → an `<a download>`
  clicked without being added to the document. The `download` command is no
  use to an app: it works from a shell, on one file.
- **`injectIframeScripts`** (the `srcdoc` fallback, and the only path in the
  deployed `become`) replaces `fetch` in the page twice. A URL that starts with
  `/` takes the newer, byte-safe bridge (`preview-streams.ts`); a bare relative
  URL (`api/status`) takes the older one, which turns every body into text.
  It also intercepts every link click, `blob:` links included.
- **There is a second, undocumented bridge.** The preview document is on
  tabcomputer's own origin, so `window.parent.__tabcomputer` is the whole
  machine: the shell, the filesystem, `localStorage` with the GitHub token.
  Verified: `typeof parent.__tabcomputer` is `"object"` from the app's page.
  The app does not use it. It is the security finding below.

## Measurements

Production, one tab, 49 sample files from public corpora (LibreOffice's import
tests, Apache Tika's test documents, mdbtools' test data, .pub attachments of
LibreOffice bug reports). "Shell" is the same command line run in a fork of
the tab's shell with no app at all.

### Start

| | User space | Hardwired |
|---|---|---|
| The tab itself, first visit, to a working shell | 0.36–0.50 s | same |
| The tab itself, later visits | 0.12–0.43 s | same |
| Backend listening (`node server.js`), first visit / later | 0.20–0.22 s / 0.02–0.04 s | none |
| Window open to interactive page, first visit / later | 0.09–0.24 s / 0.10–0.15 s | 0.6 ms to build the window; 11 ms until it is on screen |
| App start in a booted tab, later visits (backend + page) | 0.12–0.19 s | about 0.01 s |
| First use: Debian plus the five packages by apt, drop to first converted file | 26.6 s (setup 26.4 s) | not built; it would be the same apt run |
| Reload in app mode, to an interactive app with its backend back (local build, this branch) | 0.10 s (0.098–0.115 s over six reloads) | not measured: the thin window does not register a restore command, so the desktop session would not bring it back either |

The hardwired number leaves out the fetch of its lazy chunk, which a built-in
app pays on first launch; the measurement loaded the module by hand.

### Per file (20 documents, 4.0 MB, one at a time, three rounds each, warm)

| | Median per file | 20 files |
|---|---|---|
| Shell | 70–72 ms | 3.3–3.4 s |
| Hardwired window | 72–78 ms (1–2 ms of it writing the file) | 3.4–3.5 s |
| User space | 128–173 ms | 4.5–4.7 s |

Where the user-space 55 ms goes, per file (medians of the last round): 17 ms
to upload the bytes through the service worker and write them; 6 ms for the
convert request; and 37 ms because the same command run through node's
`child_process.exec` takes longer than in a page shell (106 ms against 71 ms).
A request that does nothing costs 6.1 ms through the service worker and 6.1 ms
calling the server's handler directly from the page, so the service worker hop
is free and the cost is the round trip to the node Worker.

### 50 files (11.8 MB)

| | Wall time | Median per file |
|---|---|---|
| User space, 1 at a time | 11.9 s | 134 ms |
| User space, 2 at a time (the app's default) | 6.8 s | 168 ms |
| User space, 4 at a time | 4.8 s | 232 ms |
| Hardwired (one at a time: the thin version has no queue) | 9.4 s | 80 ms |

All 50 converted in every run. The longest gap between timer ticks during a
50-file run was 20 ms in both the tab and the app's page: the desktop stays
responsive. The zip of 50 results (9.5 MB) reached the disk in 0.5 s; the
hardwired zip path is the same command plus one file read.

### Memory and storage

`measureUserAgentSpecificMemory` (page, frames and workers): 12 MB after boot,
124 MB after Debian and the converters were installed, 142–157 MB after two
batches of 49 files. During the 50-file runs it read between 84 and 138 MB
with no upward trend, the same with the hardwired window (138 MB before and
after). Some readings fell back to the page's JS heap alone (87–105 MB) because
that API only answers at a garbage collection. Browser storage for the origin
grew from 364 MB to 538 MB across the measurement runs: `/tmp` is persistent,
and the app's uploads and every batch's results stay until something deletes
them.

### Behaviour

| | Result |
|---|---|
| Reload, app in a Preview window, backend started with `node server.js 4780 &` in the Terminal (deployed build) | The Terminal comes back. The Preview window does not, and nothing listens on 4780. `node …` is not in the session's restartable list, so `serve open` has nothing to open |
| Reload in app mode (deployed build) | A page that says "404 Not Found". The saved state names `/tmp` and the port; the restore runs `serve /tmp 4780` |
| App mode at all (deployed build) | The page never reaches its backend: 20 s and still not ready. The listener for the page's `fetch` is only installed once a Preview window has been opened in that page load. With a bare relative URL instead, an upload gets HTTP 500 |
| App mode and its reload (this branch, local build) | Works: bytes both ways, zip downloads, a reload restarts `node server.js` and the page lists the last batch |
| 360 px wide | The desktop makes the Preview fill the work area; the app's page has no sideways scroll (360 of 360 px) and converts. Viewport emulation only, no real phone |
| Offline, tab already open | Converts (6 files, 1.9 s) and downloads the zip. Installed Debian programs are in browser storage |
| Offline reload | The tab does not load at all (`ERR_INTERNET_DISCONNECTED`): there is no offline copy of tabcomputer itself |

## Conversion quality

34 of the 49 samples converted. Of the 15 that did not: 8 are deliberately
malformed files from LibreOffice's crash tests (refused as "Unsupported file
format", which is right); 6 are ClarisWorks spreadsheets and databases and Mac
Works files, for which Debian 13's `libmwaw-tools` ships no `mwaw2csv`
(`mwaw2html` refuses them); 1 is a Quattro Pro `.wq2` that `wks2csv` wrote
nothing for. WordPerfect 4 to 6, Works 2 to 6 documents, Lotus `.wk1` and
`.123`, Quattro `.wq1`, Works spreadsheets and databases, a ClarisWorks 6
document and Access 97, 2000 and 2002 databases (every table, plus the schema)
came through with their text and tables.

**Publisher is the weak one, and the issue's open question has an answer:
`pub2xhtml` does not keep a multi-column layout in a usable way.** Tested on
`Flyer_04a.pub`, a real three-panel flyer attached to LibreOffice bug 61579
with Publisher's own rendering beside it:

- `pub2xhtml` writes XHTML whose pages are namespace-prefixed SVG
  (`<svg:svg>`). Saved as `.html` and opened in a browser, none of the drawing
  appears: the whole flyer is one unstyled run of words.
- Drawn as SVG, the page geometry and coloured shapes are in the right
  places, but font sizes are written in inches inside a drawing measured in
  points (14 pt becomes `0.1944`), so the text is invisible.
- With the sizes corrected, headings sit where they should. Body text does
  not: each text frame is a single unwrapped line starting at the frame's
  corner, running off the page and over its neighbours.
- Clip art embedded as WMF or EMF is not shown (6 of the flyer's 8 pictures;
  22 of 23 in another sample, which came out blank). Pictures that are shown
  are tiled at the wrong scale (bug 133297's test file).

What the tool does deliver from a .pub is all of the text, in frame order, and
where each frame was. The app therefore rewrites Publisher output: the drawing
with corrected font sizes, then the words of each page as plain paragraphs,
with a sentence saying so at the top. That is honest text recovery, not a
faithful copy of a newsletter. A faithful copy needs a real layout engine:
`soffice --convert-to pdf` is the candidate and was not tested (LibreOffice is
not installed in the tab and is several hundred MB).

PDF and DOCX were not tested: `pandoc` was not installed, and the `rescue`
layer that carries it (branch unix/toolchain-layers) was not on the server.

## Gaps and papercuts, ranked

Ranked by how much each hurts the person using the app, then the author.

1. **An app cannot be installed, launched or linked to.** There is no
   manifest, no dock entry and no address. Getting the converter on screen is
   `cd`, `node server.js 4780 &`, `serve open 4780`, typed by someone who came
   because they will not type commands. Run links (Build 998) can now carry
   those commands in a URL, but nothing connects them to an app's files,
   window or lifecycle.
2. **A reload loses the app.** In a window: the Preview is gone and so is the
   backend. In app mode on the deployed build: a 404 page. A person who drops
   40 files and reloads sees a terminal. Fixed for app mode on this branch
   (`become --start`); not fixed for windows.
3. **The deployed `become` cannot run an app with a backend.** Its `srcdoc`
   page has no working `fetch` unless a Preview was opened first, and bare
   relative URLs corrupt bytes. Fixed on this branch: the page is the same
   real document a Preview shows.
4. **A served page has the tab's full authority.** Same origin as
   tabcomputer: `parent.__tabcomputer`, the filesystem, `localStorage` with the
   GitHub and API tokens. Fine for a developer previewing their own project;
   not for an app someone was sent a link to. The backend is no more confined:
   it is a shell.
5. **`child_process.spawn` with a piped stdin never returns from `sudo`.**
   `spawn('sh', ['-c', 'sudo echo hi'])` hangs with `sudo` and `node` spinning
   (verified, production); the app's first setup hung for 15 minutes on
   `sudo apt-get update` until `stdio: ['ignore','pipe','pipe']`. With a piped
   stdin even `spawn('sh', ['-c', 'echo one; sleep 1; echo two'])` took 19 s to
   report its exit; with stdin ignored, 48 ms. `exec` works but delivers its
   output in one piece at the end, so it cannot show progress.
6. **First use is 26 s of apt behind a log.** The `rescue` layer removes it;
   the app already prefers `toolchain install rescue` when the set exists. An
   app cannot declare what it needs, so each one writes this script itself.
7. **The window is a developer's Preview.** Title `localhost:4780/`, a reload
   button and address bar, snapped to the right half with the Terminal on the
   left, the generic Preview dock icon, one window per port. The app cannot
   set its title, icon or size, or open a second window.
8. **Nothing works offline after a reload,** although everything the app
   needs is in browser storage and converting works offline in an open tab.
9. **Links leave the app.** A `target=_blank` link opens a path of
   tabcomputer itself, which boots a second desktop. In the `srcdoc` fallback
   every link click is intercepted. The app shows results in a frame inside
   its own page instead, and downloads through an anchor that is never added
   to the document.
10. **Every app writes its own upload, download and zip plumbing.** About a
    third of `server.js` is moving bytes that are already in the tab.
11. **Storage only grows.** `/tmp` survives reloads; nothing tells an app or
    the person how much is used (538 MB after these runs).
12. **Small ones.** `command -v` is no test for "installed" for names that are
    also builtins (gcc, python3), as RUN_LINKS.md notes; `become` leaves by
    `?unbecome` or a console call only; app mode boots the terminal UI, so
    there is no menu bar or dock to get back to; `become`'s title is the slug
    with a capital letter.

Not gaps: bridge latency (6 ms), file transfer (13–25 ms a file whether it is
64 bytes or 1.8 MB), responsiveness, memory, the phone layout.

## Proposal: an app layer

Each item says whether it was **prototyped** on this branch or is only
**proposed**.

### 1. Manifest (written out, not read: `apps/converter/app.json`)

```json
{
  "id": "converter",
  "name": "Converter",
  "icon": "public/icon.svg",
  "window": { "width": 620, "height": 640, "minWidth": 320, "minHeight": 320 },
  "backend": { "start": "node server.js $PORT", "port": 4780 },
  "entry": "/",
  "toolchains": ["rescue"],
  "packages": ["libwpd-tools", "libmspub-tools", "libwps-tools", "libmwaw-tools", "mdbtools"],
  "access": { "fs": ["/tmp/converter", "~/Converted"], "network": false, "commands": ["wpd2html", "pub2xhtml", "zip"] }
}
```

`backend` is optional: an app that only needs the client library (below) is a
folder of static files. `toolchains` are tried first, `packages` are the apt
fallback, as `toolchain install` already does.

### 2. `app` command and the dock (proposed)

- `app install DIR | gh:owner/repo | NAME` copies the folder to
  `~/Apps/<id>/` and records it in `/var/lib/tabcomputer/apps.json`. Boot
  registers each with `wm.registerApp`, so it is in the dock and in
  `desktop open <id>` like a built-in app.
- `app open ID [--full]` installs missing toolchains with a progress sheet
  drawn by the desktop (not by each app), starts the backend on a free port
  passed as `$PORT`, and opens an **app window**: the same `/__preview/`
  document a Preview uses, in a window with the manifest's name, icon and
  size and no toolbar. `--full` is app mode. `app list`, `app stop`,
  `app remove`.
- It sits on `preview.ts`, `become.ts` and `toolchain.ts` and looks small
  (an estimate, a few hundred lines). It was not built because the address
  and the security model below decide its shape.

### 3. Lifecycle (app mode prototyped, the rest proposed)

- **Prototyped:** `become PORT SLUG --start CMD` records the command and its
  directory; a reload runs it again and waits for the port
  (`startBecomeServer`). A reload to an interactive app took 0.10 s on a local
  build. `become` now also says so when it cannot restart a server.
- **Proposed:** an app window's restore command is `app open ID`, so the
  desktop session restores it like Files. The backend belongs to the app, not
  to a terminal: started on open, restarted if it exits while a window is
  open, stopped when the last window closes. That replaces guessing from the
  command line (`RESTARTABLE` in `session.ts`).
- **Proposed:** a state hook for the page: the converter keeps its batch id in
  `localStorage` and asks the backend what is in the results folder. It works
  (the browser check covers it) but each app has to invent it.
- **Proposed:** a service worker for tabcomputer's own shell, so an installed
  app opens offline. Converting already works offline.

### 4. An address, and how it relates to run links (proposed)

A run link names a script that runs in a Terminal. An app link names an app
and ends in a window. They should share one mechanism and one trust rule:

- `?app=converter`: a curated app, its files served by the site at
  `/apps/converter/` with their hashes in `/apps/index.json`, exactly as
  `/recipes/index.json` does for recipes. It opens at once.
- `?app=gh:owner/repo`: the manifest is shown first with Run and Cancel, as a
  `gh:` script is, but the prompt lists what the app asks for (`access`,
  `toolchains`, the backend command) instead of a script to read.
- Internally `?app=X` is `?run=` with a generated script (`app install X &&
  app open X --full`), so `src/run-url.ts` keeps the trust decision, the
  argument rules (`&to=csv` reaches the page as a query parameter, never
  shell text) and the "runs once, opens on later loads" marker.
- After the first load the address becomes `/<id>` (what `become` does), and
  that address reopens the app after a reload or from a bookmark.
- Today, without any of this, a curated recipe could already do it:
  `wordperfect-rescue` could fetch the app's files, start `node server.js`
  and run `become 4780 converter --start node server.js 4780`. That needs
  only this branch's `become` change and the app's files on the site.

### 5. Client library for served pages (proposed)

A script the preview service worker serves to app documents at a fixed path,
talking to the tab over a `MessagePort`, each call checked against the
manifest's `access`:

```js
import { tab } from '/__tabcomputer/app.js';
await tab.toolchain.ensure(['rescue'], (line) => log(line));     // install with progress
const dir = await tab.files.import(event.dataTransfer, '/tmp/converter/in'); // drop → files, folders kept
const p = tab.run('pub2xhtml', [dir + '/a.pub'], { stdout: '/home/user/Converted/a.html' });
p.onStderr((s) => …); const { code } = await p.done;            // streaming, exit status
await tab.fs.readFile(path); await tab.fs.writeFile(path, bytes); await tab.fs.list(dir);
await tab.download(['/home/user/Converted/2026-10-12'], 'converted.zip');   // zips on the way out
tab.open('/home/user/Converted/2026-10-12');                    // in Files
tab.window.setTitle('Converter: 3 of 40');
```

With it the converter needs no server: about 150 lines of page script. It
removes the three costs measured above (17 ms upload, 6 ms request, 37 ms of
`child_process`), which puts a user-space app at the hardwired number, and it
removes gap 10. A backend stays possible for apps that want one (a database,
a long-running job, an existing node or Python program).

### 6. Security model (proposed)

What a served app may touch today: everything. The proposal, in the order it
can be built:

1. **Say it.** Curated apps open at once; any other app shows its manifest
   first, and until confinement exists the prompt says plainly "this app can
   read every file and token in this tab". Same rule as `gh:` run links.
2. **Give app pages their own origin.** A sandboxed frame is not enough: a
   frame without `allow-same-origin` is not controlled by the preview service
   worker, and with it the page can reach `parent`. The Browser app already
   serves other sites from separate browse origins that must never serve the
   app or its APIs (`handleBrowseHost`); app documents should come from an
   origin of the same kind, with the broker port as the only way back.
3. **Confine the backend.** The guest profile of issue #113 (a filesystem
   and storage namespace with no `~/.claude`, no GitHub token, the relay off
   unless asked for) is the right container: an app's backend and its
   `tab.run` calls run in a guest whose only shared paths are the manifest's
   `access.fs`, with network only if `access.network`. The converter needs
   two folders and no network, and its promise "nothing is uploaded" becomes
   something tabcomputer enforces rather than something the page says.
4. **Results the person keeps** go through an explicit door: `tab.download`
   and a "save into my files" sheet, not write access to the home directory.

### 7. Packaging and sharing (proposed)

An app is a folder with `app.json`. Sharing is a repository
(`?app=gh:owner/repo`, and a README badge like the run-link one) or a
curated entry on the site with a gallery page at `/apps`, built from the
manifests as `/recipes` is built from recipe headers. `app pack` makes a
tarball for sending a private app by hand. An app whose first run is heavy
should name a toolchain set rather than packages, so it rides on layers.

### Bugs to fix whatever is decided

- `child_process.spawn` with the default piped stdin: `sudo` never returns,
  and plain commands take seconds to report their exit (gap 5).
- `child_process.exec` should deliver output as it is written.
- `serve open`'s restored window needs its server: restart a `node X &` that
  was running in the terminal, or leave the window up saying the server is not
  running, rather than no window.
- `/tmp` should be emptied at boot, or have a size shown in Settings.

## What could not be tested

- A real drag from the operating system, and a dropped folder: headless
  Chrome has no file drag. The picker and a synthetic `drop` event were
  tested; the folder walk in `app.js` (`webkitGetAsEntry`) was not exercised.
- A real phone, Safari and Firefox. The phone result is a 360 px viewport in
  desktop Chrome.
- PDF and DOCX output, `pandoc`, `soffice`, and the `rescue` layer path
  (`toolchain install rescue`): none was on the server.
- Files over 6 MB, and more than 50 files at once.
- A first visit offline, a slow network, and a low-memory device.
- Two tabs running the same app, and two apps asking for the same port.
- The hardwired version beyond a drop, a conversion and a zip: no setup, no
  folders, no failure list, no database or spreadsheet handling.
