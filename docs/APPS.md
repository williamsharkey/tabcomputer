# Apps

An app is a folder with an `app.json`. Its page is ordinary HTML, CSS and JavaScript; what runs behind it runs in the tab. Installed, it has an icon in the dock, a window of its own, and comes back after a reload.

```
my-app/
  app.json        the manifest
  icon.svg
  public/         the page (index.html, …)
  server.js       optional: a backend
```

A bare script is the rung below: a [run link](RUN_LINKS.md) runs it in a Terminal, and `app new NAME --from script.sh` wraps it as an app.

Code: `src/apps/` (the core: manifest, registry, access checks, the host side of `tab.js`, the supervisor, links), `src/commands/app.ts` (the `app` command), `src/desktop/app-window.ts` (windows and the dock), `public/apphost/` (what an app's own origin serves: `tab.js`, the frame, the service worker). The study this implements is [research/APP_MAKER.md](research/APP_MAKER.md).

## The manifest

`app.json`, format 1. Only `manifest`, `id`, `name` and one of `entry` or `backend` are required.

```json
{
  "manifest": 1,
  "id": "converter",
  "name": "Converter",
  "description": "Convert old office files on this computer.",
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
| `manifest` | The format version. A manifest newer than the build reads is refused. | required |
| `id` | 2 to 32 of `a-z`, `0-9`, `-`, starting with a letter. The app's folder under `~/Apps`, its dock entry, its `app` name, its address (`/<id>` in app mode). Names tabcomputer uses itself (`terminal`, `files`, `api`, …) are refused. | required |
| `name` | What the title bar and the dock show. 1 to 60 characters. | required |
| `description`, `version` | Text shown by `app list -l` and the install prompt. | empty |
| `icon` | An `.svg`, `.png`, `.jpg` or `.webp` in the folder (at most 256 KB). | a monogram |
| `window.width`, `height` | The client area in CSS px, 120 to 10000. | 720 × 560 |
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
