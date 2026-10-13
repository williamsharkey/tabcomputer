# Convert Old Files (`converter`): an app on tabcomputer's toolkit

Drop Publisher, WordPerfect, Works, Lotus 1-2-3, ClarisWorks or Access files (or
a folder of them), pick HTML or CSV, get a results folder, a list of what
failed, and "Download all" as a zip. The converting is done by Debian's own
command-line programs inside the tab; nothing is uploaded
([issue #114](https://github.com/williamsharkey/tabcomputer/issues/114)).

It is an app in the sense of [docs/APPS.md](../../docs/APPS.md): a folder with
a manifest and a page. It has no server of its own. The page reaches the tab
through `tab.js`, and the tab checks every call against `app.json`.

| File | What |
|---|---|
| `app.json` | The manifest: the window, the `rescue` toolchain set it needs, the converter programs its page may run, the one folder it may write (`~/Converted`). |
| `public/` | The page: `index.html`, `app.js`, `style.css`, `icon.svg`. No framework. |
| `measure/` | The scripts that produced the numbers in [docs/research/APP_MAKER.md](../../docs/research/APP_MAKER.md), and `measure/legacy/`: the first design (a node server in the tab and a page with plain `fetch`) and the thin hardwired window, kept so the comparison can be run again. Not shipped with the app. |

## Run it

It ships with the site:

```
https://tabcomputer.com/?app=converter            a window on the desktop
https://tabcomputer.com/?app=converter&become     the tab is the app
```

or the "Convert Old Files" entry in the dock, which every profile has before the app is installed (docs/APPS.md "Shipped apps"); or, in a shell: `app install converter && app open converter`. From a checkout
of this repository in the tab:

```sh
app dev apps/converter         # try it: the page reloads when a file is saved
app install apps/converter     # the dock entry
app open converter --become    # full-tab, at /converter; a reload comes back to it
```

The first install applies the `rescue` toolchain set (`toolchain install
rescue`: a prebuilt layer where the server has one, else apt), with its
progress in the placeholder window. DOCX is offered when `pandoc` is
installed, PDF when `soffice` or `pandoc` is.

Results go to `~/Converted/<date-time>/` in the tab's filesystem. Dropped
originals go to the app's data folder (`~/.local/share/apps/converter/in/`) and
are removed once their batch has converted.

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

## How the page does it

Everything the first design's 370-line server did is a call to the tab now:

| The first design | Now |
|---|---|
| `PUT` each dropped file to the server, which wrote it | `tab.files.import(dataTransfer, { dir, onProgress })`: folders walked, each file reported as it lands |
| `POST /api/…/convert`, the server running `child_process.exec` | `tab.run(['wpd2html', file], { stdout: out })`: the program named in `app.json`, the file one argument, no shell |
| `GET /api/status` (`command -v` in a shell) | `tab.commands()` |
| `POST /api/setup`, a streamed apt log | the manifest's `toolchains`, installed by the tab; `tab.toolchain.ensure()` if they went missing |
| `GET /results/…`, `GET /api/jobs/JOB` | `tab.fs.readText`, `tab.fs.list` |
| `GET /api/…/zip`, a `Blob`, an `<a download>` | `tab.download(folder, { zip: true })` |
| the title `localhost:4780/` | `tab.window.setTitle('Converter: 3 of 40')` |

What the manifest's list means here: the page can start only the twelve
programs it names and can write only `~/Converted` and its own data folder,
and it cannot reach another site. A converter program is still an ordinary
program: it reads whatever file it is given.

## Test

```sh
npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
node tests/browser/app-converter.mjs
```

The check stands in shell scripts for the converter programs and marks the
toolchain set as installed, so it needs no Debian and no network.
`node apps/converter/measure/measure-local-toolkit.mjs` times this version
beside the first design and the hardwired window on a local build.
