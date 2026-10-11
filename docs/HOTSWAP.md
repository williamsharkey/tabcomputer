# Developing tabcomputer from inside tabcomputer

An agent in a tab (Claude Code, or you at the prompt) can change tabcomputer's own core code: the shell, the terminal, kernel classes. The change goes into the running tab without a reload, because a reload would kill the agent making it. This is `hotswap` (`src/hotswap/`, `src/commands/hotswap.ts`). It is experimental.

## The workflow

```sh
hotswap checkout                         # this build's own source, in ~/tabcomputer
cd ~/tabcomputer
hotswap watch -d                         # the save loop (below): each save is swapped in
vi src/shell.ts                          # edit
hotswap watch --wait                     # what the save did
hotswap test --changed                   # the suites that import what changed
```

or one step at a time:

```sh
vi src/shell.ts                          # edit
hotswap build src/shell.ts               # optional: build only and report
hotswap apply src/shell.ts               # swap it in; reverts by itself in 90 s
echo $BASH_VERSION; ...                  # try it in this tab
hotswap test shell-posix shell-syntax    # run vitest suites from the checkout in the tab
hotswap confirm                          # keep it (this page load only)
hotswap diff                             # what you changed
hotswap push fix/my-change -m 'shell: ...'   # a branch on GitHub, on the build's commit
```

- `hotswap checkout [DIR] [--force]` downloads `assets/hotswap-source-<sha>.tar.gz` from the page's own origin and unpacks it into DIR (`~/tabcomputer` by default; when that doesn't exist and `~/shiro` holds a checkout from an older build's default, `hotswap checkout` says so and uses it). A production build emits that tarball (`hotswapSource` in `vite-plugin-hotswap.ts`, about 3 MB). It holds the build's `src/`, `profiles/`, the vitest suites with their fixtures and the root files a build needs, plus `.hotswap-source.json`: the commit, the build number, and each file's git blob id. So the checkout matches the running page exactly. A dev server has no tarball. A deploy keeps older builds' tarballs for a week, like other assets. A `git clone` of the whole repository would also work but is several hundred MB (`public/pkg`), too much for a tab.
- `hotswap diff [--stat] [FILE...]` compares the checkout with its manifest: modified, added (under the source directories) and deleted files, as unified diffs against the copy of the tarball kept in `.hotswap/`.
- `hotswap push BRANCH -m MSG [--repo OWNER/NAME]` commits those changes on top of the build's commit as a new branch, with GitHub's REST API (blobs, a tree on the commit's tree, a commit, a ref; `src/hotswap/source.ts`). It uses your own `gh auth login` token and the name and email in `~/.gitconfig`, and prints the branch URL. The default repository is williamsharkey/tabcomputer, where tabcomputer is developed.
  - A second push to the same branch from the same checkout adds a commit on top of the first.
  - Any other existing branch is refused, and so is a branch that moved since this checkout pushed it. Push to a new name instead.
  - main, master, deploy and `unix/*` are always refused, and nothing is ever force-pushed.
- `hotswap apply [--root DIR] [--ttl 90s | --no-ttl] FILE...` builds the files named, the *swap set*, with the page's esbuild-wasm and swaps them in. The root defaults to the nearest directory above the cwd that has `src/shell.ts`.
- Every apply arms a TTL, 90 s by default. If `hotswap confirm` doesn't come in time, the swap reverts by itself. A swap that breaks the shell can't run `confirm`, so it undoes itself.
- `hotswap revert [--all]` undoes the newest swap, or all of them. `hotswap status` lists what's applied, what each swap changed, and the time left on its TTL.
- `hotswap confirm --persist` also saves the confirmed swaps in IndexedDB, and boot re-applies them before `~/.profile` runs. That happens only on the same build (`__BUILD_SHA__` plus the build number): a new deploy discards them. Safe mode (`?safe=1`, or the automatic one) and `?hotswap=0` skip them, a load after a freeze drops them, and `hotswap persisted [clear]` shows or drops them. A swap you never confirmed is never persisted, so a reload always gets rid of it.
- Out of band: `window.__tabcomputer.hotswap.revert(true)` from devtools, or the shiro-mcp `eval` of a remote session.
- A swap that freezes the page (a loop that never yields) stops the TTL timer too. If the page comes back from a freeze of 3 s or more, the unconfirmed swaps applied before it are reverted at once (a wedge revert, below). The watchdog's abort (`watchdog abort`, shiro-mcp `abort`) breaks loops that pass the shell's yield points. Otherwise reload: an unconfirmed swap is gone after a reload, though the reload also ends the agent's session. If the watchdog records that a load froze (a wedge), the next load drops the persisted swaps instead of applying them. If a persisted swap freezes the boot before the watchdog sees it, the tab goes into safe mode by itself after two loads that never reach the prompt, and safe mode skips persisted swaps.

## The save loop: `hotswap watch`

`hotswap watch [--root DIR] [--ttl 90s | --no-ttl] [--debounce 150ms] [--test [--test-max N]] [-d] [PATH...]` (`src/hotswap/watch.ts`) swaps each module under the checkout's `src/` into the page as it's saved. PATHs narrow what it watches (default: `src/`).

- In the foreground it prints one line per save until Ctrl-C. With `-d` it runs in the background of the page. `hotswap watch --wait` then waits for a save in progress and prints the lines since the last `--wait`; it exits 1 if the last one failed. `hotswap watch --stop` stops it. That's the loop for an agent, whose Bash tool can't sit on a foreground command: save with its own tools, then `hotswap watch --wait`.
- A line says what changed: the methods the save changed (`Shell.expandVars`), the commands patched, a module that isn't loaded, and a free function that changed but that importers outside the swap keep the old copy of. A build error gives its file, line and column, and changes nothing: the page keeps the last good save.
- Each save goes on top of the watcher's previous swap and is folded into it (`squash` in `swap.ts`), so one editing session is one record in `hotswap status`. Its TTL counts from the latest save, `hotswap confirm` keeps all of it, and `hotswap revert` undoes all of it. `confirm --persist` saves the session's bundles in order, leaving out the ones later saves rebuilt.
- Saves within the debounce (150 ms) build together, and a save during a build is picked up after it. Only `.ts`, `.tsx`, `.js` and `.mjs` files under `src/` trigger a swap (not `.d.ts`); edits to suites are for `hotswap test`.
- `--test` runs the suites for each good save after it: those that import the saved files, or are named for them (`hotswap test --changed`'s choice), up to `--test-max` (3; 0 for all). They run beside the next saves and never delay a swap. Files saved during a run are tested together after it. Each run adds one line: `✓ tests after #7: shell-posix (1 of 113): 37 passed (0.7 s)`, or the count failed and the first failure. `--wait` waits for them too.
- The build runs in esbuild-wasm's Worker (`src/commands/build.ts`, `worker: true`). Its plugin callbacks (reading the checkout, resolving live modules) answer from the page, but the compiling doesn't block it.
  - Long tasks on the page over 5 saves of `src/shell.ts`, after a first save: 10 tasks of up to 158 ms (blocking time ~460 ms) when esbuild ran on the page's thread; none now. What's left on the page (loading the bundle, patching the classes) stays under 50 ms.
- Latency, edit to live in the main shell, headless Chromium, `src/shell.ts`:
  - The first save takes about 1.6 s (esbuild-wasm starting).
  - Later saves take 340–490 ms: the 150 ms debounce, about 200–250 ms of build, and the swap. The build took 330–460 ms on the page's thread.
  - With `--debounce 50ms`, saves take 280–350 ms.

### When a swap breaks things

- The TTL reverts a swap nobody confirmed.
- A wedge reverts it too. When the page runs again after freezing for 3 s or more (the watchdog's `onWedge`, `src/watchdog.ts`), every unconfirmed swap applied before the freeze began is reverted, as if its TTL had run out (`revertOnWedge` in `swap.ts`). A freeze during hot-swap's own builds and test runs doesn't count (`quietDuring`). The suites run on the page's thread, and so does esbuild where there are no Workers. A loop that passes the shell's yield points can be broken with `watchdog abort`; one that never yields needs a reload, which drops unconfirmed swaps anyway.
- `hotswap watch --wait` and the foreground watcher report either revert.

## Testing in the tab

`hotswap test [--root DIR] [-t RE] [-v] [--changed [--max N]] [SUITE...]` runs vitest suites from the checkout in the tab. A SUITE is a path, or a name under `tests/tests/shiro-vitest/` (`shell-posix`). Use it to check a fix before you propose it. All 15 shell suites build and run this way (`shell-*.test.ts`, `shell.test.ts`). On build 972 plus the node:fs below, 702 of their tests passed in Chromium, in about a minute. The two that don't are node-only: shell-args spawns a real `node` with `child_process`, and shell-stdio's setup builds a `worker_threads` worker with node's esbuild. Suites that read fixtures run too: x86 (88 of 89), wasi (64 of 69; the rest download packages), shell-conformance, base-utils, agent-docs, ssh-openssh.

- `--changed` picks the suites for what `hotswap diff` lists:
  - Which suites: those that import a changed file directly (`@shiro/x` or a relative path), and those named for it or its directory (`src/commands/awk.ts`: `awk-conformance`; `src/hotswap/watch.ts`: `hotswap`).
  - The cap: it runs at most `--max` of them (20; 0 for all). Suites that need what the tab doesn't have (`node:child_process`, `worker_threads`, node's esbuild) go last. Then the named ones come first, then the ones with the fewest imports.
  - Scale: `src/shell.ts` is imported directly by 113 of 242 suites, so a shell change runs the 20 most focused ones, the shell suites first.
- The suite is built with `buildTest` (`src/hotswap/build.ts`). Unlike a swap, every module comes from the checkout, so the suite tests the source as edited, in fresh module instances, whether or not it's swapped in. `@shiro/x` is `src/x`.
- Storage is isolated. The bundle's references to `indexedDB`, `localStorage` and `sessionStorage` go to the runner's stand-ins: IndexedDB names get a per-run `tabcomputer-test-` prefix (deleted afterwards), and the two storages live in memory. The tab's own files are never touched.
- Shared: singletons the page publishes on `window` (the kernel, `__tabcomputerKernel`, and the kernel log) are the page's, and so is the DOM.
- The runner (`src/hotswap/test-runner.ts`) is a subset of vitest:
  - `describe`/`it`/`test` with `.skip`, `.only`, `.todo`, `.each`, `.skipIf`, `.runIf`, `.fails`, and the four hooks.
  - `expect` with the common matchers, `.not`, `.resolves`/`.rejects` and the asymmetric matchers (`expect.any`, `objectContaining`, ...).
  - `vi.fn`, `vi.spyOn`, `vi.waitFor` and `vi.stubGlobal`. `vi.useFakeTimers` and `vi.mock` aren't supported.
  - Tests run one at a time, with vitest's 5 s default timeout.
- Imports: `node:path`, `node:os`, `node:fs`, `node:fs/promises`, `node:url`, `node:buffer` and `node:process` are the runner's, npm packages are the page's live ones (`LIVE_DEPS`), and anything else (`node:child_process`, `node:worker_threads`, `esbuild`) throws when a test uses it.
- `node:fs` (`src/hotswap/test-fs.ts`) works in memory. Before the first suite, `hotswap test` reads the checkout into a snapshot (about 1,100 files, ~10 ms; `.hotswap/` and `node_modules/` skipped). Suites read it synchronously, fixtures included: the source tarball carries `tests/tests/shiro-vitest/fixtures/`. Their writes (`mkdtempSync('/tmp/x-')`, `writeFileSync`) stay in that memory, so the tab's files are never touched, the checkout included. Only the checkout is in it: `/home/user/notes.txt` is ENOENT. Sync, callback and promise forms are there for the common calls (read, write, append, stat, readdir, mkdir, mkdtemp, rm, rename, copy, access, chmod); a missing one (`createReadStream`) throws a message saying so.
- The tests' own files (not `src/`) also get node's `Buffer` and a small `process` (`env`, `cwd()`, `nextTick`, `hrtime`, ...), and their `import.meta.url` is their `file://` path, so `new URL('./fixtures/x.wasm', import.meta.url)` works. `src/` modules see the page's globals, as they do in the page.
- A `?worker` import the page hasn't registered yet (its module is lazy, like `src/wasi/browser-worker.ts`) is registered by loading that module the page's way first, so a suite's wasm programs run in the page's guest worker.

## What a swap can change

The swap bundle includes only the swap set. Every other import resolves to the page's **live** module. `vite-plugin-hotswap.ts` makes each module under `src/` register its namespace in `globalThis.__tabcomputerLive` under its path (`src/shell.ts`), except generated and vendored ones (`NOT_LIVE`). New code therefore shares the page's singletons: the registry, the kernel, the filesystem, the process table.

- **Classes.** When a swapped file exports a class and its live module exports a class of the same name, the live class gets the new class's prototype methods, getters, setters and static methods. Every existing instance runs the new code from its next call, the main shell and the agent's own shell included. The replaced descriptors are kept, and a revert restores them exactly.
- **Commands.** A registry command (`src/commands/*`) is a plain exported object (`{ name, exec, ... }`), not a class. When a swapped file exports one whose live module exports a command of the same name, the live object is patched in place: `exec`, `description` and its other properties. So the command registry, a lazy command's cache and the ModuleRegistry all run the new code, and a revert restores each property. `withHelpFlags` reads `cmd.exec` at each call for this. A lazy command's module is loaded before the build, so its own imports resolve to live modules too.
- **New instances.** Code in the swap that does `new Shell()` (forks, subshells) makes instances of the new class. `instanceof` treats the live class and the classes swapped into it as one class, both ways. On revert, those instances run the old code again.
- **Hooks.**
  - `migrateFrom(old)` on the new class's prototype runs once for each tracked live instance. `this` is the instance, and `old` carries the previous methods. It isn't installed on the prototype. The boot's shell, terminal, kernel and fs and the desktop's extra shells are tracked (`trackInstance` in `src/hotswap/live.ts`).
  - `export function __hotswap(ctx)` in a swapped module runs after its classes are swapped. `ctx.old` is the live namespace, `ctx.instances(Class)` the tracked instances, and `ctx.onRevert(fn)` registers cleanup. It may also return a function to run on revert.
- **Module state.**
  - The plugin also exposes each module's state: its column-0 `let`/`var` bindings, and consts holding an empty `new Map()`/`Set`/`WeakMap`/`WeakSet`, `[]` or `{}`.
  - A swapped module's copy then shares that state with the page (`src/hotswap/state.ts`). Containers become the live objects, so both copies see the same Map. `let` values are carried in, and a revert writes them back. For shell.ts that covers the in-page PID counter, the shell-by-PID map and the job table, for example. `hotswap apply` lists what it shared.
  - A const declared with its contents (a lookup table) is code: the swap uses its own copy, so edits to it take effect.
  - `--fresh-state` turns the sharing off.
- **Lazy modules.**
  - An `import()` of a module outside the swap set gets the page's module when the code runs, loading the page's chunk if needed. The plugin records a loader for every `import()` in `src/`.
  - A static import of a lazy module that isn't loaded yet is loaded before the bundle runs.
  - A module the page has no copy of and no loader for is copied into the bundle from the checkout. The build warns about it, because that copy has its own module state.
- **All or nothing.** A swap that throws (in a hook, for instance) is undone before `apply` returns.

## What a swap can't change

- **Free functions and constants** exported by a swapped file and imported by modules outside the swap set: ESM bindings are fixed, so `hotswap apply` lists them as "not swapped". To change one, add the importer to the swap set, or move the logic into a method.
- **Constructors and fields of existing instances.** The new constructor runs only for instances the new code makes. Set new fields on old instances in `migrateFrom`.
- **Module state not declared as above**: a `const` object filled in at load, or a binding inside a closure. The bundle has its own copy, and all the swapped methods use it; carry it over in `__hotswap` if it matters.
- **Top-level code** runs again when the bundle loads, so registrations in it (`addProcInfoSource(...)` and the like) happen twice.
- **Closures already handed out**: bound listeners, timers, a stored `this.fn.bind(this)`. They keep the old code until they're re-created.
- **Classes with `#private` members**: old instances fail the brand check in new methods.
- **Anything running in a Worker**: the node runtime's workers, WASM and Blink guests, the watchdog worker. That includes everything they share with the page: the kernel's syscall channel layout, SharedArrayBuffer formats, syscall numbers and ABI structs. Change those with a deploy.
- **Generated or vendored modules** (`src/gl/gen/`, `src/browser/vendor/`) aren't live: a swap that imports one bundles its own copy, which is fine for tables and stateless code. Swapping one directly has nothing live to patch. To change one, swap the modules that import it, or deploy.
- **Vite-only imports in the swap set** (`?worker`, `?url`): they can't be built in the tab. `?raw` works. Bare npm imports work for the packages in `LIVE_DEPS` in `vite-plugin-hotswap.ts` (xterm today).
- **The dev server** (`npm run dev`). The plugin runs only in production builds, where module ids are stable.

## `reload`

`reload commands/NAME [PATH]` (`src/commands/reload.ts`) replaces a registry module without a TTL or revert. It now builds through hotswap's builder, so a command's relative imports (`./index`, `../utils/x`) resolve to the page's live modules. The root is the directory above the file's `src/`. For commands, prefer `hotswap apply src/commands/NAME.ts`: it has the TTL and the revert.

## Stable handles

Patches and page scripts shouldn't depend on minified names. Use these on `window.__tabcomputer`:

| Handle | What |
| --- | --- |
| `hotswap` | the swap stack: `.stack`, `.revert(all?)`, `.confirm(id?)`, `.pending()` |
| `live('src/x.ts')` | a live module's namespace |
| `esbuild(fn)` | runs `fn` with the page's initialized esbuild-wasm |
| `Shell`, `ShiroTerminal`, `Kernel`, `FileSystem` | the live classes |
| `shell`, `terminal`, `kernel`, `fs` | the boot's instances |

## Cost

The live map keeps the exports and state bindings of `src/` modules from being tree-shaken, and the registrations add bytes of their own. On build 973 the JS grew by 3.1%: 8.54 MB → 8.81 MB, or 2.67 MB → 2.73 MB gzipped. That's all of `dist/assets/*.js`, measured with `npx vite build` with and without the plugin. About 5 KB gz of that is a second copy of the zstd codec chunk, which the page and the deb worker would otherwise share as one file; a load fetches only one of them.
- Most of the rest is in the boot chunk (+20 KB gz, +129 KB raw). About 74 KB raw is the namespace objects (a getter per export), and 44 KB is the registration statements. That's what makes a module swappable.
- Generated tables (`src/gl/gen/`) and vendored code (`src/browser/vendor/`) aren't registered (`NOT_LIVE` in `src/hotswap/live.ts`). Registering them cost about 29 KB gz, mostly unused GL enum names. A swap that imports one gets its own copy from the checkout, and the build says so. Before that change the plugin cost 93 KB gz; it now costs 64 KB. Boot time doesn't change measurably. Over six fresh loads each in headless Chromium, the median time to `shiro:terminal:ready` was 218 ms with the plugin and 208 ms without, which is within the run-to-run spread (180–257 ms). The JS loaded at boot grows from 1.67 MB to 1.79 MB. The source tarball (about 3.3 MB, 0.2 MB of it fixtures) is downloaded only by `hotswap checkout`.

## Tests

`tests/tests/shiro-vitest/hotswap.test.ts` covers the swap, the revert, the TTL, migrateFrom, hooks, the build's live resolution, persistence with its build guard, the watcher (debounce, squash, TTL from the last save, build errors, persisting a squashed session, the wedge revert), `--changed`'s suite choice, the test runner, checkout/diff/push (with a fake GitHub), and a real `src/shell.ts` edited, built with esbuild and swapped into a live Shell. `tests/browser/hotswap.mjs` does the same in Chromium against a build: it runs `hotswap checkout`, edits `src/shell.ts` with sed, checks `hotswap diff`, applies it, sees the change in the main shell, lets the TTL revert it, then persists one, reloads, checks safe mode and reverts. Last, it runs three shell suites with `hotswap test`, a suite that runs a wasm fixture, and one that writes with `node:fs`, and checks that the tab's own file, the checkout and the localStorage key are unchanged. Then it runs the save loop: `hotswap watch -d`, three saves of `src/shell.ts` each seen live in the main shell (it prints the edit-to-live times and the page's long tasks during them, and fails on 200 ms of blocking time), `--wait`, a broken save and its fix, `hotswap test --changed --max 1`, one revert for the session, the foreground watcher stopped by Ctrl-C, and `--test` running a suite after a save.
