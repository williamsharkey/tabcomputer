# Converter: a user-space app in a tab

Drop Publisher, WordPerfect, Works, Lotus 1-2-3, ClarisWorks or Access files (or
a folder of them), pick HTML or CSV, get a results folder, a list of what
failed, and "Download all" as a zip. The converting is done by Debian's own
command-line programs inside the tab; nothing is uploaded
([issue #114](https://github.com/williamsharkey/tabcomputer/issues/114)).

It is written the way an outside developer would write it, with only what a
tab offers: a page, and a node server in the tab that runs commands. It is one
half of a comparison; the other half is the hardwired window in
`src/desktop/apps/converter.ts`. The findings and the numbers are in
[docs/research/APP_MAKER.md](../../docs/research/APP_MAKER.md).

| File | What |
|---|---|
| `server.js` | The backend: node's `http`, `fs`, `child_process` only. Serves `public/`, takes uploads, runs the converters, zips the results. |
| `public/` | The page: `index.html`, `app.js` (plain `fetch` to the backend), `style.css`. No framework, no tabcomputer API. |
| `app.json` | A proposed manifest. Nothing reads it yet. |
| `measure/` | The scripts that produced the numbers in APP_MAKER.md. |

## Run it

Get the folder into the tab (clone the repository, or drag the folder onto
Files), then:

```sh
cd apps/converter
node server.js 4780 &          # the backend and the page on port 4780
serve open 4780                # a window on the desktop
```

As a full-tab app that comes back after a reload:

```sh
cd apps/converter
node server.js 4780 &
become 4780 converter --start node server.js 4780
```

The tab's address becomes `/converter`. `?unbecome` on that address, or
`unbecome` in a shell, returns to the desktop.

The first drop installs the converters if they are missing, with the log on
the page: `toolchain install rescue` when this build has a prebuilt `rescue`
set, else `debian install` (if Debian isn't there yet), `apt-get update` and
`apt-get install libwpd-tools libmspub-tools libwps-tools libmwaw-tools
mdbtools`. DOCX is offered when `pandoc` is on PATH, PDF when `soffice` or
pandoc with a PDF engine is.

Results go to `~/Converted/<date-time>/` in the tab's filesystem (open it in
Files); dropped originals to `/tmp/converter/<date-time>/in/`.

Nothing in `server.js` or the page is specific to tabcomputer, so it should run
on any Linux machine with node and the same packages (`node server.js`, then
http://localhost:4780/). On macOS without the packages the page loads and
reports the converters missing; the conversions were only run in a tab.

## What converts what

| Extension | HTML | CSV |
|---|---|---|
| .wpd .wp .wp5 .wp6 (WordPerfect) | `wpd2html` | no (a document) |
| .pub (Publisher) | `pub2xhtml` | no |
| .wps (Works document) | `wps2html` | no |
| .wks .wk1 .wk3 .wk4 .123 .wq1 .wq2 (Works, Lotus, Quattro Pro) | a table made from the CSV | `wks2csv` |
| .wdb (Works database) | a table made from the CSV | `wdb2csv` |
| .cwk .cws (ClarisWorks) | `mwaw2html`, else a table from `mwaw2csv` | `mwaw2csv` |
| .mdb (Access) | one table per database table, plus `schema.sql` | `mdb-export` per table, plus `schema.sql` |

## How the page reaches the backend

- The page is a real document at `/__preview/<tab>/<port>/`. A service worker
  hands each request it makes to the tab, which calls the node server's
  request handler. `fetch('/api/…')` with a binary body and a binary response
  works; a streamed response (the setup log) arrives as it is written.
- Use absolute paths (`/api/status`). In a tab without service workers the
  page is a `srcdoc` copy, and there a bare relative URL (`api/status`) takes an
  older text-only bridge that corrupts bytes.
- Dropped `File` objects become files in the tab by `PUT`ting their bytes to
  the server, which writes them with `fs.writeFileSync`.
- The zip reaches the real disk as a `fetch` → `Blob` → an `<a download>` that
  is created and clicked without being added to the document.
- Results open inside the page (a sandboxed `srcdoc` frame). A plain link with
  `target=_blank` would open a path of tabcomputer itself, not of this server.

## Test

```sh
npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
node tests/browser/app-converter.mjs
```

The check stands in shell scripts for the converter programs, so it needs no
Debian and no network.
