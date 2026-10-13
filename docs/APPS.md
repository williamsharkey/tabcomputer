# Apps

An app is an `app.json`. For three common shapes that one file is the whole app, and tabcomputer supplies the page. An app that wants a page of its own is a folder: the `app.json`, and ordinary HTML, CSS and JavaScript. Either way what runs behind the page runs in the tab, and an installed app has an icon in the dock, a window of its own, and comes back after a reload.

```
my-app/
  app.json        the whole app, when it has run, fields or table
```

```
my-app/
  app.json        the manifest
  icon.svg
  public/         the page (index.html, …)
  server.js       optional: a backend
```

A bare script is the rung below: a [run link](RUN_LINKS.md) runs it in a Terminal, and `app new NAME --from script.sh` wraps it as an app.

Code: `src/apps/` (the core: manifest, the kinds' rules in `declare.ts`, registry, access checks, the host side of `tab.js`, the supervisor, links), `src/commands/app.ts` (the `app` command), `src/apps/window.ts` (windows, the dock, app mode), `public/apphost/` (what an app's own origin serves: `tab.js`, `page.js`, the frame, the service worker). The study this implements is [research/APP_MAKER.md](research/APP_MAKER.md).

## The manifest alone

An `app.json` with `run`, `fields` or `table`, and no `entry`, is a complete app (tabcomputer#134). `name` is the only key every app needs. The page is `public/apphost/page.js`: one script, served by the tab to every such app, so a fix reaches all of them. The three in `apps/examples/` are each this one file.

**files**: a command run on each file a person gives it.

```json
{
  "name": "Make scans searchable",
  "about": "Turns photos or scans of pages into PDFs whose text can be searched and copied.",
  "accept": [".png", ".jpg", ".jpeg", ".tif", ".tiff"],
  "run": "tesseract {in} stdout pdf",
  "out": "{name}.pdf",
  "needs": ["tesseract-ocr"]
}
```

**form**: labelled fields fill a command, and its output shows.

```json
{
  "name": "jq playground",
  "about": "Try a jq filter on some JSON. The result changes as you type.",
  "fields": {
    "filter": { "label": "Filter", "value": ".people[] | select(.age > 30) | .name" },
    "json": {
      "label": "JSON",
      "type": "long text",
      "value": "{\"people\": [{\"name\": \"Ada\", \"age\": 36}, {\"name\": \"Linus\", \"age\": 21}, {\"name\": \"Grace\", \"age\": 45}]}"
    }
  },
  "run": "jq {filter}",
  "stdin": "{json}",
  "live": true
}
```

**table**: a CSV or SQLite file in the app's data folder, shown as a table.

```json
{
  "name": "Expenses",
  "about": "A list of what was spent, with a total.",
  "table": "expenses.csv",
  "columns": [
    { "name": "Date", "type": "date" },
    "What",
    { "name": "Category", "choices": ["Food", "Travel", "Home", "Other"] },
    { "name": "Amount", "type": "number" },
    { "name": "Paid back", "type": "checkbox" }
  ]
}
```

Keys every app may have:

| Key | Meaning | Default |
| --- | --- | --- |
| `name` | What the title bar and the dock show. | required |
| `about` | One or two sentences: what it does. The page and the install prompt show it. (`description` is the same key under its older name.) | empty |
| `needs` | Debian packages installed before the first start, from a ready-made layer for exactly these names when the server has or builds one ([DEBIAN.md](DEBIAN.md) "Package layers"): seconds, not apt's minutes. A name that is a toolchain set (`toolchain list`) is installed as that set. | none |
| `id` | The app's folder under `~/Apps`, its dock entry, its `app` name. | the folder's name, the repository's, or one made from `name` |
| `manifest`, `icon`, `window`, `version` | As for an app with its own page (below). | the current format, a monogram, a size per kind |

A **files** app (it has `run` with `{in}`):

| Key | Meaning | Default |
| --- | --- | --- |
| `run` | The command. `{in}` is the input file, `{out}` the result file, `{name}` the input's name without its extension, `{ext}` its extension, `{dir}` the folder the result goes to, and `{option}` each of `options`. Without `{out}` the command's standard output is the result. | required |
| `out` | The result's name, from `{name}` and `{ext}`. | the input's name |
| `accept` | Extensions taken (`".pdf"`). The picker offers them; another file gets a row that says why it was skipped. | every file |
| `options` | Named choices and switches shown above the files: `"quality": { "label": "Quality", "choices": { "Small": "/ebook", "Print": "/printer" } }` fills `{quality}` with the choice's value; `"gray": { "label": "Gray", "on": "-g" }` is a box that fills `{gray}` with `-g` when ticked. | none |
| `each` | `false`: the command runs once, and `{in}` is every file (merge these PDFs). `out` is then required. | `true` |
| `shell` | `true`: `run` is a shell line (pipes, redirects). | `false` |

The page: "Drop files or a folder here" with "Choose files" and "Choose a folder"; on a touch screen only "Choose files", since there is nothing to drag and a phone's browser picks no folders. One row per file with its state (waiting, working, done, failed, skipped), and on failure the program's own last line. "Download all" is a zip; each result downloads alone. A dropped folder's structure is kept in the results. Two inputs that would get one name get two (`page.pdf`, `page (2).pdf`, tabcomputer#140). Two files run at a time. Inputs and results live in the app's data folder (`in/`, `out/`) until the page is next opened. The page says "Your files stay on this computer.": the page uploads nothing, and what the program does with them is the program's.

A **form** app (it has `fields`):

| Key | Meaning | Default |
| --- | --- | --- |
| `fields` | The inputs, in order: a name, then a label or `{ "label", "type", "value", … }`. `type` is `text`, `long text`, `number`, `choice` (with `choices`: a list, or what is shown and what it becomes), `checkbox` (with `on`: what it becomes when ticked) or `file` (with `accept`). | required |
| `run` | The command, with a `{field}` where each value goes. | required |
| `stdin` | Text the program reads, with `{fields}` filled in. | none |
| `output` | `text` (as it is written), `html` (shown as a document that runs no script), `markdown`, or `file` (the result is a file named by `out`, with a Download button). | `text` |
| `live` | `true`: it runs when it opens and again as the person types, a quarter of a second after the last key. | `false` |
| `shell` | As above. | `false` |

The page: the fields, Run and Stop, a line that says Running, Done, Stopped or the exit status, and the output. Ctrl+Enter runs from any field.

A **table** app (it has `table`):

| Key | Meaning |
| --- | --- |
| `table` | A `.csv` or `.sqlite` file's name, kept in the app's data folder. |
| `columns` | A name, or `{ "name", "type", "choices" }`. `type` is `text`, `number`, `date`, `choice` or `checkbox`. |

The page: add a row, edit any cell in place, delete (with Undo), sort by a column, filter, a total for each number column, "Download CSV". Every edit is saved, and a change another program makes to the file shows at once. A CSV file's first line is the column names; a column only the file has is kept and shown as text. A SQLite file holds one table named after the file; the page reads and writes it with `sqlite3`. On a narrow screen each row is a card.

Rules, checked in `src/apps/declare.ts`:

- **No shell reads a value.** `run` is split into words once (blanks separate them; `'…'` and `"…"` keep blanks in one word; `;`, `|`, `$(…)` and `*` are plain characters). Each placeholder's value becomes one argument, or part of the one word it is written in (`{name}.pdf`), whatever it holds: spaces, quotes, `; rm -rf ~`. With `"shell": true` the line is a shell's and each value goes in as one quoted word.
- **A file's name is never an option.** `{in}`, `{out}` and `{dir}` are absolute paths. A word that starts with `{name}` or `{ext}` and would start with `-` gets `./` in front: a file named `-rf.txt` is passed as `./-rf`.
- **An unticked box or an empty choice leaves its word out**; empty text is still an argument.
- **What the app may do is read from `run`.** `access.commands` is its first word; with `"shell": true` it is `access.shell`. A `.sqlite` table adds `sqlite3`. `access.network` is false and `access.fs` is empty: the page may use only the app's data folder. `entry`, `backend`, `files` and `access` do not go with these keys.
- The page calls `tab.job`, and the tab builds the command from the manifest: the page never sends one.

The supplied pages work at 360 px, by keyboard and with a screen reader (every control is labelled, the state line is a live region, focus is visible), and follow the desktop's light or dark appearance. `tests/browser/app-declarative.mjs` checks each.

`apps/converter` is not one of these. It picks one of twelve programs by the file's extension, runs two or three in a row for some outputs (to HTML, then pandoc or LibreOffice), falls back to a second program when the first refuses a file, makes several results from one input (a database's tables), rewrites one program's output in JavaScript (Publisher's SVG) and builds HTML from CSV, keeps results in `~/Converted` and shows them in the page. A files app has one command, one result per input, and its own data folder.

## The manifest of an app with its own page

`app.json`, format 1. Only `name` and one of `entry` or `backend` are required; `entry` may be left out when `index.html` is beside `app.json` or in `public/`.

```json
{
  "manifest": 1,
  "id": "converter",
  "name": "Convert Old Files",
  "description": "Drop old office files and get modern files back. The files stay on this computer.",
  "version": "0.2.0",
  "icon": "public/icon.svg",
  "window": { "width": 620, "height": 640, "minWidth": 320, "minHeight": 320, "resizable": true, "multiple": false },
  "entry": "public",
  "backend": { "start": "node server.js", "port": "auto", "health": "/api/ping", "lazy": false, "keepAlive": false },
  "toolchains": ["rescue"],
  "files": ["~/Converted/"],
  "access": {
    "fs": ["~/Converted", { "path": "~/Documents", "mode": "read" }],
    "network": false,
    "commands": ["wpd2html", "pub2xhtml"],
    "shell": false
  }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `manifest` | The format version. A manifest newer than the build reads is refused. | the current one |
| `id` | 2 to 32 of `a-z`, `0-9`, `-`, starting with a letter. The app's folder under `~/Apps`, its dock entry, its `app` name, its address (`/<id>` in app mode). Names tabcomputer uses itself (`terminal`, `files`, `api`, …) are refused. | from the folder's or repository's name, else from `name` |
| `name` | What the title bar and the dock show. 1 to 60 characters, without `<` or `>`. | required |
| `about` (or `description`), `version` | Text shown by `app list -l` and the install prompt. | empty |
| `icon` | An `.svg`, `.png`, `.jpg` or `.webp` in the folder (at most 256 KB). | a monogram |
| `window.width`, `height` | The client area in CSS px, 120 to 10000. | 720 × 560 (files 560 × 580, form 600 × 620, table 780 × 540) |
| `window.minWidth`, `minHeight` | | 280 × 200, or the size if smaller |
| `window.resizable` | | `true` |
| `window.multiple` | `true`: each `app open` is another window. `false`: it focuses the one that is open. All windows share one backend. | `false` |
| `entry` | The page: a folder in the app (its `index.html`) or an `.html` file (its folder is served). Left out when the backend serves the page. | required without a backend |
| `backend.start` | A shell line that starts the backend, run in the app's folder with `PORT`, `APP_ID`, `APP_DIR` and `APP_DATA` set. | |
| `backend.port` | The port it listens on, 1024 to 65535, or `"auto"`: a free port, passed as `$PORT`. A unix socket is not supported. | `"auto"` |
| `backend.health` | A path that answers 2xx when the backend is ready (`"/api/ping"`, or `{ "path", "timeout" }` with seconds). Without it the port being open is enough. | none; timeout 20 |
| `backend.lazy` | Start on the page's first request to the backend, not when the window opens. Needs an `entry`. | `false` |
| `backend.keepAlive` | Keep running when the last window closes. | `false` |
| `toolchains` | Sets `toolchain install` applies before the first start (`toolchain list`). | none |
| `needs` | Debian packages installed before the first start (Debian itself first, if it is not there), with the launch placeholder's sentences: the layer of the set when the server has or builds one, else `apt-get install`. | none |
| `files` | Paths that must exist before it starts. One ending in `/` is a folder, made if missing. Others must be there, or the app does not start and says which is missing. Absolute, under `~`, or relative to the app's folder. | none |
| `access.fs` | Folders the page may read and write through `tab.js`: absolute or under `~`, never `/`. `{ "path", "mode": "read" }` is read only. The app's data folder is always allowed; its own folder is readable. | none |
| `access.network` | `false`: the page is kept from other sites. | `false` |
| `access.commands` | Program names `tab.run([name, …args])` may start. Names only: no paths, no arguments. | none |
| `access.shell` | `true`: `tab.run('a shell line')` is allowed. | `false` |

Validation is strict (`src/apps/manifest.ts`): an unknown key, a wrong type, a path with `..`, a leading `/` where a path inside the folder is meant, or a control character is an error. Every problem is reported at once, each naming its key:

```
app.json: window.width must be a number from 120 to 10000 (got "wide")
app.json: unknown key backend.socket (known: start, port, health, lazy, keepAlive)
app.json: access.fs may not be / (the whole filesystem): name the folders the app needs
```

When both `entry` and `backend` are given, a request for a file that exists under `entry` is answered from it; anything else (and every request that is not a GET) goes to the backend.

## The `app` command

```
app new NAME [--template files|form|table] [--name "Shown name"] [--dir DIR]
app new NAME --page
app new NAME --from SCRIPT
app dev [DIR] [--no-open]
app install [DIR | ID | examples/ID | gh:OWNER/REPO[/PATH] | gist:[USER/]ID | URL] [--guest[=NAME]] [--open]
app open ID [--become] [--new]
app share ID [--print]
app list [-l]
app stop ID
app remove ID [--data]
app check [DIR]
app templates
```

Exit status 0 when it did what was asked, 1 when it could not (the reason on stderr, after `app: `), 2 for a usage mistake. `app help` prints the usage.

- **`app new NAME`** asks nothing and writes one file, `./<id>/app.json`: a working app of the `files` kind (`--template form` or `table` for the others). `--page` makes an app with a page of its own (five files). A name with capitals or spaces is kept as the shown name and an id is made from it (`"My Notes"` → `my-notes`). `--from script.sh` wraps a script: the app is a page with a Run button, an arguments box and the script's output as it is written; the script's `# title:` header names it.
- **`app dev [DIR]`** is the developer loop: the app opens in a window as an installed app would (same frame, same origin rules, same access checks), with its backend started. The Terminal shows the backend's output and what `tab.js` refused. Saving a file under the page's folder reloads the page; saving anything else restarts the backend and then reloads; saving `app.json` reads the manifest again (an invalid one is reported and the last valid one stays). It ends with Ctrl-C or when the window closes. `--no-open` runs the backend and the watcher without a window.
- **`app install`** copies the app to `~/Apps/<id>/` (replacing an earlier install of that id; `~/.local/share/apps/<id>/`, its data, is kept), lists it in `/var/lib/tabcomputer/apps.json` and puts it in the dock. Then its `toolchains` and `needs` are installed, with the desktop's launch feedback: the dock entry is marked as starting and a placeholder window shows the installer's output. A folder installs at once. An app from GitHub, a gist or an archive is shown first ("Installing" below).
- **`app open ID`** opens its window (or focuses the one that is open; `--new` for another when the manifest allows several). `--become` makes the tab the app.
- **`app share ID`** makes a link to it and shows the share screen ("Sharing" below). `--print` prints only the link.
- **`app stop ID`** closes its windows and stops its backend. **`app remove ID`** uninstalls it and keeps its data unless `--data`.
- **`app check [DIR]`** validates `app.json` and the files it names, and prints what the app asks for in the words the install prompt uses. An app that is its manifest is printed as sentences:

```
searchable-pdf: Make scans searchable (app.json is valid)
  Turns photos or scans of pages into PDFs whose text can be searched and copied.
  Make scans searchable runs this command once for each file you give it: tesseract {in} stdout pdf
  Each result is named {name}.pdf.
  tesseract is an ordinary program in this tab: it can read and change every file here.
  Before its first start it installs the Debian package tesseract-ocr.
  Its page may use only its own data folder, and is kept from other sites.
```

### Templates

Each is a small working app in `apps/templates/<name>/` and runs as created: none needs a toolchain, a backend or a folder outside its own data.

| Template | What `app new` writes | What it is |
| --- | --- | --- |
| `files` (the default) | `app.json` | Makes a tidy copy of each JSON file: `jq . {in}`. |
| `form` | `app.json` | Counts from one number to another: three number fields over `seq`. |
| `table` | `app.json` | A list of people in `people.csv`. |
| `page` (`--page`) | `app.json`, `icon.svg`, `public/index.html`, `app.js`, `style.css` | A page of its own that does a file job with `tab.files.import`, `tab.run([…], { stdout })` and `tab.download(dir, { zip })`. |
| `script` (`--from`) | The same, with `run.sh` | A Run button, the script's output. |

## Lifecycle

Code: `src/apps/runtime.ts` (`AppInstance`), `src/apps/supervisor.ts`, `src/apps/window.ts`.

- **One instance per app** while it is open. It owns the backend, answers the page's requests and serves its `tab.js` channel.
- **Before the first start** the manifest's `toolchains` and `needs` are installed (once: `~/.local/share/apps/<id>/.toolchains` records it) and its `files` are checked. `needs` goes through `Packages` (`src/apps/runtime.ts`): `installed(names)` and `install(names, onLine)`. `install` asks the server for the layer of the set (`src/debian/package-sets.ts`, DEBIAN.md "Package layers"): a set someone needed before is applied in about a second; a set nobody needed yet is built on the server, and the placeholder shows what the server reports ("The server is installing package 12 of 71 for tesseract-ocr. This build happens once: the next person gets these programs in seconds."). When the server has no layer and cannot build one, one sentence says why and `apt-get install` runs in the tab. A failure leaves the launch's placeholder showing the reason, with Retry. While it installs, the placeholder shows a sentence for the person (`src/apps/progress.ts`: "NAME needs some programs. They are being downloaded. This happens once.", then one per step the installer reports); the installer's own lines are under "Show details". No fraction and no time left are shown: the installer measures neither (the server's "package N of M" is its own count). The installer is the `toolchain` builtin called with stream writers, so its lines arrive as it writes them.
- **The backend belongs to the app, not to a terminal.** It starts when the app opens (with `backend.lazy`, on the page's first request that is not a file of the page), in the app's folder, with `PORT`, `APP_ID`, `APP_DIR` and `APP_DATA` set. "Running" means the port is open and, with `backend.health`, that the path answered 2xx.
- **It is restarted when it dies.** A start that never becomes ready, or a backend that dies within 10 s of becoming ready, is a failure: the next start waits 0.5 s, then 1, 2, 4, 8 s. After 5 failures in a row the supervisor stops trying; the window covers the page with the error and the backend's last output, and Retry starts over. A backend that ran for 10 s is started again at once when it dies. While it is down the window says "Restarting NAME…".
- **It stops when the last window closes**, unless `backend.keepAlive`; then `app stop ID` (or closing the tab) stops it.
- **The window is the app's own:** its name and icon in the title bar and the dock, no toolbar, no `localhost:PORT`, the manifest's size and minimum size. One per app unless `window.multiple`. A click on its dock entry while it starts goes to its placeholder; nothing starts twice.
- **A reload brings it back.** The window's restore command is `app open ID` (`app dev DIR` for a dev window), so the desktop's session restore reopens it where it was, and opening starts the backend again. Measured on a local build (tests/browser/app-toolkit.mjs): an app with a node backend is interactive 0.24 s after a reload.
- **App mode** (`app open ID --become`, `?app=ID&become`, and any app link opened on a phone): the tab is the app, at `/<id>`, with the app's name as the tab's title. A reload comes back to it (0.08 s for the converter, 0.24 s for an app with a node backend, local build). `unbecome` in a shell, or `?unbecome` on the address, returns to the desktop. It reuses `become`'s state (`BecomeConfig.app`, src/commands/become.ts); the page and the backend come back through the toolkit instead of `serve`.

## tab.js

The client library an app's page loads from a fixed path:

```html
<script src="/__tabcomputer/tab.js"></script>
```

It defines `tab`. Every call is a message to the tab over one `MessagePort`; the tab checks it against the app's manifest and answers. A refused call rejects with an `Error` whose `code` is `'EACCES'`; other codes are `'EINVAL'`, `'ENOENT'`, `'ENOSYS'`, `'EIO'`. Paths may be absolute, start with `~`, or be relative to the app's data folder.

| Call | What it does |
| --- | --- |
| `await tab.ready` | Resolves to `tab.app` once the tab has answered. |
| `tab.app` | `{ id, name, version, manifest, dir, dataDir, home, confined, theme }`. `dataDir` is `~/.local/share/apps/<id>`, always the app's to read and write. `confined` is true when the page is on an origin of its own. `theme` is the desktop's appearance, `'light'` or `'dark'`. |
| `tab.onTheme(cb)` | `cb('light' \| 'dark')` when the desktop's appearance changes. Returns `{ close() }`. |
| `tab.job({ files, values }, opts)` | For an app that is its manifest: run the manifest's `run`. `files` is `[{ path, rel }]` (one, or all of them with `"each": false`), `values` what the fields or options hold. The tab builds the command. `opts.onStdout`, `opts.onStderr`. Resolves to `{ code, out, name, size, said, stdout, stderr }`: `out` is the result file, or null. The promise has `kill()`. `tab.job.start()` resolves to `{ in, out }`, the folders this page's inputs and results go to. |
| `tab.run(cmd, opts)` | Run a program. `cmd` is `[program, ...arguments]`: the program must be in `access.commands`, and each argument is one word (no shell reads them). With `access.shell`, `cmd` may be a shell line. `opts`: `cwd` (a folder the app may read; default its data folder), `env`, `stdin` (text), `stdout` / `stderr` (a file the app may write, to send that stream to), `onStdout(text)`, `onStderr(text)` (called as output is produced). Resolves to `{ code, stdout, stderr }` (the text is collected unless the callback took it). The promise has `kill()`. The command gets `APP_ID`, `APP_DIR`, `APP_DATA`. |
| `tab.commands(names?)` | `{ name: true \| false }`: which of the manifest's commands are installed. |
| `tab.fs.read(path, { as: 'text' })` | The file's bytes (`Uint8Array`), or its text. `tab.fs.readText(path)` is the short form. |
| `tab.fs.write(path, data)` | Text, an `ArrayBuffer`, a typed array or a `Blob`. Folders above it are made. |
| `tab.fs.list(path)` | `[{ name, type: 'file' \| 'dir' \| 'symlink', size, mtime }]`. |
| `tab.fs.stat(path)`, `tab.fs.exists(path)` | `{ path, type, size, mtime }` or `null`. |
| `tab.fs.mkdir(path)`, `tab.fs.remove(path, { recursive })`, `tab.fs.rename(from, to)` | |
| `tab.fs.watch(path, cb)` | `cb({ event, path })` for every change under `path` (`write`, `delete`, `mkdir`, `rename`, `attrib`). Returns `{ close(), ready }`. |
| `tab.files.import(source, opts)` | Dropped or picked files into the tab's filesystem. `source`: a `DataTransfer` (folders are walked; call it inside the drop event), a `FileList`, or an array of `File`s or `{ file, rel }`. `opts.dir`: a folder the app may write (default a new folder under its data folder). `opts.onProgress({ done, total, file })` as each file lands. Resolves to `{ dir, paths, files: [{ path, rel, size, ms }] }`. |
| `tab.files.pick({ multiple, directory, accept })` | The browser's file picker, then `import`. |
| `tab.download(path \| paths, { zip, name })` | Saves to the person's real disk. Several paths, a folder, or `zip: true` give a zip (a folder's contents at its top). Resolves to `{ name, size, zip }`. |
| `tab.toolchain.ensure(sets?, onProgress)` | Installs the manifest's toolchain sets that are missing; `onProgress({ set, line, text })`: `line` is the installer's output, `text` the sentence for a person. `tab.toolchain.status(sets?)` says which are installed. |
| `tab.window.setTitle(text)`, `.resize(width, height)`, `.close()` | The app's own window. |
| `tab.reveal(path)` | Shows a folder or file in the Files app. |

Output streams: `tab.run(['sh', '-c', 'echo one; sleep 1; echo two'], { onStdout })` calls back with `one`, and a second later with `two` (`app-host.test.ts` measures the gap).

### The protocol

`src/apps/host.ts` is the tab's side. The page sends `{ t: 'call', id, op, a }` and `{ t: 'cancel', id }`; the tab answers `{ t: 'ev', id, e, d }` (output, progress, a change), then `{ t: 'ok', id, v }` or `{ t: 'err', id, code, message }`. The operations are `hello`, `theme.watch`, `job.start`, `job`, `run`, `commands`, `fs.read`, `fs.write`, `fs.list`, `fs.stat`, `fs.mkdir`, `fs.remove`, `fs.rename`, `fs.watch`, `files.put`, `download`, `reveal`, `toolchain.status`, `toolchain.ensure`, `window.set`, `window.close`. Anything else is `ENOSYS`. Nothing in a message says which app is talking: the port does, because the tab handed that port to that app's frame.

How the page finds the tab: `tab.js` posts one end of a `MessageChannel` to its parent frame. On an app origin the parent is the app's frame (`public/apphost/frame.js`), which passes the port on to the tab over its own port. It does not use `parent.__tabcomputer`, which an app's page cannot reach.

## The page's origin

Code: `src/apps/frame.ts`, `public/apphost/` (`frame.js`, `sw.js`, `tab.js`), `server.mjs` ("Apps: app origins").

An app's page is served from an origin of its own, `app--<id>--<16 hex>.<zone>`, where the zone is the Browser app's browse zone (`https://….web.tabcomputer.com` in production, `http://….localhost:PORT` locally). The hex is a hash of the app's id, where it was installed from, and the tab's own host, so two apps with one id from different places, and one app in a guest and in the main profile, never share an origin.

- That host serves only `/__tabcomputer/`: `frame.html`, `frame.js`, `sw.js`, `tab.js`, `page.js`. Never the app shell, `/api`, `/tcp` or anything else of tabcomputer.
- The tab makes an `<iframe>` of `frame.html`, sandboxed (`allow-scripts allow-same-origin allow-forms allow-modals allow-downloads`, so it keeps its own origin and can never navigate the tab; with `access.network` also `allow-popups`). The frame registers the origin's service worker, tells the tab it is ready, and the tab hands it one `MessagePort`.
- The frame shows the app's page in a frame of its own. Every request that page makes to its origin goes to the service worker, to the frame, over the port to the tab, which answers from the app's files (`entry`) or its backend. `fetch('/api/x')`, ES modules, images and a streamed response work as on any site; nothing is injected into the page.
- `access.network: false` adds a Content-Security-Policy to every HTML document of the app (`default-src 'self'`, `connect-src 'self'`, `frame-src 'self'`, `form-action 'self'`), and the frame's own policy (`frame-src 'self'`) keeps the page from navigating itself to another site.

Where a server has no app origins (`/apps/config.json` answers `{ "origin": null }`: `vite dev`, a server with `TABCOMPUTER_BROWSE=0`, a guest without network), the page is a `/__preview/` document of the tab's own origin, as a Preview window's is. `tab.js` works the same, but the page is not confined; the window says so in a line under the page, `tab.app.confined` is false, and the install prompt says so.

Not built: WebSocket and EventSource from the page to its own backend on an app origin (a Preview bridges them; an app page's `fetch`, streamed or not, works). With the same app open in two tabs at once, a link inside a multi-page app is answered by the tab whose page it came from when that can be told, else by either.

## What is confined

| | Real boundary, or a declaration? |
| --- | --- |
| The page reading the tab's script, DOM, `localStorage` (the GitHub token, Claude's sign-in), IndexedDB, cookies | **Boundary**, on an app origin: the browser's same-origin policy. Checked in `tests/browser/app-toolkit.mjs` (`parent.__tabcomputer`, `top.localStorage`, `top.document` all throw). No boundary without app origins. |
| The page navigating the tab away, or opening windows (without `access.network`) | **Boundary**: the frame's `sandbox`. |
| The page fetching other sites, or the tab's own origin, without `access.network` | **Boundary** for requests, frames and forms (the Content-Security-Policy). It does not stop every channel a determined page could find (a DNS prefetch); it is not a boundary for the backend or for commands. |
| `tab.fs`, `tab.files`, `tab.download`, `tab.reveal` outside `access.fs` and the data folder | **Boundary** for the page: every path is resolved in the tab (`src/apps/access.ts`): `..` folded, symbolic links followed with the filesystem's `realpath`, and the real path must be inside an allowed folder. A link that leaves the allowed folders, or points at nothing, is refused; removing or renaming a link acts on the link. Read-only folders, and the app's own folder, cannot be written. |
| `tab.run` of a program not in `access.commands`; a shell line without `access.shell`; a toolchain set not in `toolchains` | **Boundary** for the page: refused in the tab. Arguments are never read by a shell. A page may not set `PATH`, `HOME`, `LD_PRELOAD` and the like for a command. |
| What a command started by `tab.run` does | **Declaration only.** It is an ordinary process of the profile. `access.commands: ["sh"]`, `["node"]`, `["python3"]` or `access.shell` lets the page do anything a terminal here can, whatever `access.fs` says. Even a narrow command reads whatever path it is given as an argument: `["cat"]` reads any file. List commands the way you would hand someone a tool. |
| What the backend does | **Declaration only.** `backend.start` is a shell line run as the person: every file, every sign-in, the network. |
| The app's own files on disk (`~/Apps/<id>`) | Not protected from other programs in the tab, nor from the app's own backend. |

So: an app that is only a page, with no commands or with commands that are safe to hand out, is confined by more than its word. An app with a backend, a shell, or an interpreter among its commands is as trusted as a script you run. **For that, the boundary is a guest** (docs/research/GUEST_PROFILE.md): tabcomputer on another origin of the browser, with its own filesystem and no sign-ins. `app install gh:… --guest[=NAME]` opens the app there instead of installing it here (`--guest` alone is a guest thrown away when its tab closes), and the install prompt offers "Open in a guest" when the server has guests. The guest shows the prompt again, since that is where it is installed.

## Installing

`src/apps/links.ts` (where an app comes from, no DOM), `src/apps/install.ts`, `src/apps/prompt.ts` (the prompt), `src/apps/registry.ts`.

| What | From | Asked first? |
| --- | --- | --- |
| `app install DIR` | A folder of this tab | No: they are your files and you typed it. |
| `app install ID`, `app install examples/ID`, `?app=ID` | An app this site ships, or one of its examples: `/apps/<id>/`, listed in `/apps/index.json` | No, when it is curated: the list is on the page's own origin and every file fetched has the sha256 the list gives (redirects refused; an HTML answer standing in for a missing file refused). |
| `app install gist:ID`, `gist:USER/ID`, `?app=gist:…` | A gist, read at its newest revision with one request to GitHub's API (tabcomputer#137). A gist holds no folders: its files are the app's, flat. One `app.json` is a whole app when it has `run`, `fields` or `table`; with `index.html` beside it the app has that page. GitHub's limit for visitors opens the sign-in sheet, as for `gh:`. | **Yes.** |
| `app install gh:OWNER/REPO[/PATH]`, `?app=gh:…` | A folder of a GitHub repository, fetched as a visitor. A private repository, or GitHub's limit of 60 requests an hour for visitors, opens the sign-in sheet; signed in, it is fetched again from `api.github.com` with the tab's GitHub token (`fetchSignedIn`) | **Yes.** |
| `app install https://…/x.zip` (`.tar.gz`, `.tgz`) | An archive with `app.json` at its top or in its one folder | **Yes.** Not as a link: an address never names an archive. |
| `?app=link#app=…` | The app's own files, carried by the address (`app share`, "Sharing" below) | **Yes.** |

For an app that is its manifest the prompt shows `app check`'s sentences: what it does, the exact command, what it installs. For an app with a page of its own, the prompt shows the app's name, where it comes from (for GitHub, the commit; for a gist, the revision), what it will run (`backend.start`), what it installs (`toolchains`), which commands and folders its page may use, whether it may reach other sites, and the manifest itself. It says which of that is enforced. Its rules are the run link prompt's: everything from the app goes in as text, Cancel has the focus, closing the window is Cancel, Install is off for the first moment, and a click made by script does nothing.

What is shown is what is installed. A gist's revision and files come in one answer. A repository is read at one commit (its default branch's head when asked): the manifest in the prompt and every file come from that commit, and the manifest is written from the bytes that were shown, not fetched again. Links (mode 120000), submodules and `.git*` are left out; at most 400 files and 32 MB. An archive is downloaded and unpacked in a scratch folder first, and installed from those files. An app whose id belongs to a built-in app is refused.

## Shipped apps

The apps this site ships are the folders of `apps/` with an `app.json` (not `templates/`): a build copies each to `dist/apps/<id>/` without what only measures or documents it (`measure/`, `README.md`) and writes `dist/apps/index.json` (`vite-plugin-apps.ts`, `scripts/apps/site-apps.mjs`). `apps/converter` ("Convert Old Files", #114) is the first.

The examples in `apps/examples/<id>/` (`searchable-pdf`, `jq-playground`, `expenses`) are built and listed the same way, so `app install examples/expenses` and `?app=expenses` install them without a prompt. They have no dock entry: the entries below come from `apps/*/app.json` only.

Each has an entry in the dock of every profile before it is installed (`src/apps/shipped.ts`, bundled from the manifests and `public/icon.svg`; its glyph for the icon sets other than Classic is in `GLYPHS` there). The first click installs the site's copy (curated, so without a prompt), installs what it needs with the launch placeholder showing each step in a sentence, and opens its window. After that the entry is the installed app's. `app remove ID` takes the entry out, and it stays out across reloads (localStorage `tabcomputer-apps-hidden`) until the app is installed again (`app install ID`, or its link). So a person reaches the converter three ways without a terminal: the dock entry, `https://tabcomputer.com/?app=converter` (a window on the desktop) and `https://tabcomputer.com/?app=converter&become` (the tab is the app).

## Sharing

`app share ID` makes a link to an installed app (`src/apps/share.ts`) and shows the share screen (`src/apps/share-ui.ts`; in a terminal without a desktop, the same sentences are printed):

> Each person who opens this link gets their own copy of NAME. Each copy keeps its own data on that person's computer. Nothing is shared between the copies. Other people do not see your data, and you do not see theirs.

A link shares the app, never its data: `~/.local/share/apps/<id>/` is not read.

| The app was installed from | The link | Asked first? |
| --- | --- | --- |
| this site (`site`) | `?app=<id>` | No: it is curated. |
| GitHub (`gh:…@commit`) | `?app=gh:owner/repo[/path]`: each person gets the repository's head when they open it | Yes. |
| a gist (`gist:ID@revision`) | `?app=gist:ID`: each person gets the gist's newest revision | Yes. |
| a folder, an archive, or a shared link | `?app=link#app=<payload>`: the files of `~/Apps/<id>` themselves, as gzipped JSON in base64url (`{ v: 1, t: { path: text }, b: { path: base64 } }`) | Yes. |

An app that is one `app.json` makes a short link of the last form: 336, 486 and 380 characters for the three examples on a local build, against 3,747 for `app new --page`'s five files (`tests/browser/app-declarative.mjs` prints them).

The last form needs no server. A browser never sends the part of an address after `#`, so the files are not uploaded and nothing stores them; `tests/browser/app-toolkit.mjs` checks that no request carries them. The address is cleaned of them before anything else happens (`cleanRunUrl`). The payload is at most 48,000 characters (`SHARE_PAYLOAD_MAX`: browsers take far more, mail and chat programs do not) and unpacks to at most 4 MB, 400 files, plain relative paths only. A larger app is refused with a sentence that says to put it in a public GitHub repository and share `?app=gh:OWNER/REPO`. A change made to the app later does not reach copies already installed from the link.

Opening one is an app link like any other (below): the address is cleaned first, a framed page ignores it, `?safe=1` skips it. It is never curated, so the install prompt is shown, in a main profile and in a guest alike, with "Open in a guest" where the server has guests (the whole link goes there). Its `source` is `link:<hash of the payload>`: the same link opened again opens the copy it installed without asking; a link with other files asks again. `app install link` is refused: the files come only from the address.

Not built: a share button in the app's window or the dock (sharing is the one command), a hosted store for apps too large for a link, and updates to copies already installed.

## Links

```
https://tabcomputer.com/?app=converter
https://tabcomputer.com/?app=converter&become
https://tabcomputer.com/?app=gh:someone/tool
https://tabcomputer.com/?app=gh:someone/tools/apps/notes&guest
https://tabcomputer.com/?app=gist:0123456789abcdef0123456789abcdef
https://tabcomputer.com/?app=link#app=H4sIA…          (what app share makes)
```

`?app=` is handled by the run links' machinery (docs/RUN_LINKS.md, `src/run-url.ts`), with an app in place of a script: the address is cleaned before anything is fetched (`app`, `become` and every parameter that is not the page's own), a framed page takes no app link, `?safe=1` skips it, and `&guest` (`&guest=NAME`, `&nonet`) moves the whole link to a guest first. A refused link prints `app link: <why>` in the terminal and installs nothing.

A curated app installs and opens. An app carried by its link (`?app=link`) shows the prompt ("Sharing" above). A `gh:` or `gist:` app shows the prompt; once installed, the same link opens it without asking for as long as the repository's head (the gist's newest revision) is the one that was installed, and asks again when it has moved. `&become` makes the tab the app.

On a phone (the desktop's compact layout and a touch screen) every app link opens as `&become` does, with a slim bar above the app whose one link, "tabcomputer", leads to the desktop (tabcomputer#139). The Welcome card is never shown on a visit that asked for an app, on any screen; it shows on the next visit without a link.

## The shared core

The Code app's app mode and a Studio would sit on the same modules the `app` command and the desktop use; none of them has DOM in it except where noted.

| Module | What a tool gets from it |
| --- | --- |
| `src/apps/manifest.ts` | `parseManifest`, `validateManifest` (every problem, by key), `manifestText`, `describeManifest` and `manifestSentences` (the prompt's lines and sentences). A manifest editor validates as it is typed with these. |
| `src/apps/declare.ts` | The kinds: `validateKind`, `splitRun`, `argvFor`, `shellLineFor`, `outputName`, `inputValue`, `kindSentences`. |
| `src/apps/templates.ts` | `TEMPLATES`, `scaffold(fs, dir, id, { template, name, script })`. |
| `src/apps/share.ts` | `shareApp(fs, app, origin)` → the link and what kind it is; `shareStatement` (the share screen's sentences); `packApp` / `unpackApp`. A Share button would call these. |
| `src/apps/registry.ts` | `loadManifest`, `installFromDir`, `installFromFiles`, `listInstalled`, `removeInstalled`. |
| `src/apps/runtime.ts` | `instanceFor({ manifest, dir, source, dev })` → `AppInstance`: `prepare`, `startBackend`, `fetch`, `supervisor` (state, `restart`, `tail`), `on('state' \| 'log' \| 'views' \| 'reload')`, `setManifest`, `reload`, `attach(view)` / `detach(view)`. |
| `src/apps/frame.ts` (DOM) | `createAppFrame(instance)` → `{ element, confined, reload, dispose }`: the app's page as an element for any container. A pane in the Code app mounts this and attaches a view of kind `'pane'`. |
| `src/apps/window.ts` (DOM) | `openAppWindow`, `becomeApp`, the dock entries. |
| `src/apps/host.ts` | `AppHost`: the `tab.js` operations, for a tool that wants to drive or record them. |

## Tests

- `tests/tests/shiro-vitest/app-manifest.test.ts`: the manifest.
- `app-declare.test.ts`: apps that are their manifest: each kind's keys and defaults, every mistake by its key, `run` to arguments (spaces, quotes, `;`, `$(…)`, a file named `-rf`), result names and collisions, derived access, the sentences, and the command run through the host for each kind.
- `app-host.test.ts`: the `tab.js` protocol and its checks (path escapes, links, undeclared commands, streaming, cancel).
- `app-supervisor.test.ts`: start, health, restart, backoff, giving up, stop.
- `app-command.test.ts`: the command, the templates (each runs as created), installing, what a page is served, the backend's life with its views.
- `app-links.test.ts`: `?app=` parsing, curated and GitHub apps and the attacks on each, apps from a gist, the trust decision, the site's app list and the examples.
- `app-origins.test.ts`: what an app host serves and who may frame it.
- `app-share.test.ts`: a shared link (round trip, refused payloads and names, the size limits, that it always asks, Cancel, the same link again, a frame), `app share`, the sentences.
- `app-shipped.test.ts`: the shipped apps' dock entries and their removal, the first start's sentences.
- `run-links-gist.test.ts`: `?run=gist:`.
- `tests/browser/app-toolkit.mjs`: new → dev → install → dock → open → drop → result → download; the page's boundary; a backend restarted, restored by a reload, stopped on close; app mode; remove; the prompt for a `gh:` app; `?app=`; `app share`, its screen, the link opened in another profile and in a guest; 360 px. `tests/browser/app-converter.mjs`: the converter, and its dock entry from a fresh profile: the first click, the first-run sentences, the window, removal.
- `tests/browser/app-declarative.mjs`: each kind at 1280 px and on a 390 x 844 touch screen: `app new`, install, open, the job (three files with two of one name and one the program refuses; Run, streamed output, Stop, live; add, edit, sort, filter, a reload, another program's change, SQLite), downloads, the keyboard alone, the appearance; an app link on the phone; the Welcome card; the key row; a gist; share link lengths; 360 px. It prints the times.
