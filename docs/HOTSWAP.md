# Developing tabcomputer from inside tabcomputer

An agent in a tab (Claude Code, or you at the prompt) can change tabcomputer's own core code: the shell, the terminal, kernel classes. The change goes into the running tab without a reload, because a reload would kill the agent making it. This is `hotswap` (`src/hotswap/`, `src/commands/hotswap.ts`). It is experimental.

## The workflow

```sh
hotswap checkout                         # this build's own source, in ~/shiro
cd ~/shiro
vi src/shell.ts                          # edit
hotswap build src/shell.ts               # optional: build only and report
hotswap apply src/shell.ts               # swap it in; reverts by itself in 90 s
echo $BASH_VERSION; ...                  # try it in this tab
hotswap test shell-posix shell-syntax    # run vitest suites from the checkout in the tab
hotswap confirm                          # keep it (this page load only)
hotswap diff                             # what you changed
hotswap push fix/my-change -m 'shell: ...'   # a branch on GitHub, on the build's commit
```

- `hotswap checkout [DIR] [--force]` downloads `assets/hotswap-source-<sha>.tar.gz` from the page's own origin and unpacks it into DIR (`~/shiro` by default). A production build emits that tarball (`hotswapSource` in `vite-plugin-hotswap.ts`, about 3 MB). It holds the build's `src/`, `profiles/`, the vitest suites and the root files a build needs, plus `.hotswap-source.json`: the commit, the build number, and each file's git blob id. So the checkout matches the running page exactly. A dev server has no tarball. A deploy keeps older builds' tarballs for a week, like other assets. A `git clone` of the whole repository would also work but is several hundred MB (`public/pkg`), too much for a tab.
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
- A swap that freezes the page (a loop that never yields) stops the TTL timer too. The watchdog's abort (`watchdog abort`, shiro-mcp `abort`) breaks loops that pass the shell's yield points. Otherwise reload: an unconfirmed swap is gone after a reload, though the reload also ends the agent's session. If the watchdog records that a load froze (a wedge), the next load drops the persisted swaps instead of applying them. If a persisted swap freezes the boot before the watchdog sees it, the tab goes into safe mode by itself after two loads that never reach the prompt, and safe mode skips persisted swaps.

## Testing in the tab

`hotswap test [--root DIR] [-t RE] [-v] SUITE...` runs vitest suites from the checkout in the tab. A SUITE is a path, or a name under `tests/tests/shiro-vitest/` (`shell-posix`). Use it to check a fix before you propose it. All 14 shell suites build and run this way (`shell-*.test.ts`, `shell.test.ts`); on build 961, 694 of their 698 tests passed in Chromium, about a minute for all of them.

- The suite is built with `buildTest` (`src/hotswap/build.ts`). Unlike a swap, every module comes from the checkout, so the suite tests the source as edited, in fresh module instances, whether or not it's swapped in. `@shiro/x` is `src/x`.
- Storage is isolated. The bundle's references to `indexedDB`, `localStorage` and `sessionStorage` go to the runner's stand-ins: IndexedDB names get a per-run `tabcomputer-test-` prefix (deleted afterwards), and the two storages live in memory. The tab's own files are never touched.
- Shared: singletons the page publishes on `window` (the kernel, `__tabcomputerKernel`, and the kernel log) are the page's, and so is the DOM.
- The runner (`src/hotswap/test-runner.ts`) is a subset of vitest:
  - `describe`/`it`/`test` with `.skip`, `.only`, `.todo`, `.each`, `.skipIf`, `.runIf`, `.fails`, and the four hooks.
  - `expect` with the common matchers, `.not`, `.resolves`/`.rejects` and the asymmetric matchers (`expect.any`, `objectContaining`, ...).
  - `vi.fn`, `vi.spyOn`, `vi.waitFor` and `vi.stubGlobal`. `vi.useFakeTimers` and `vi.mock` aren't supported.
  - Tests run one at a time, with vitest's 5 s default timeout.
- Imports: `node:path` and `node:os` are small shims, npm packages are the page's live ones (`LIVE_DEPS`), and anything else (`node:fs`, `node:child_process`) throws when a test uses it. Suites that read fixtures with `readFileSync` fail those tests with that message.

## What a swap can change

The swap bundle includes only the swap set. Every other import resolves to the page's **live** module. `vite-plugin-hotswap.ts` makes each module under `src/` register its namespace in `globalThis.__tabcomputerLive` under its path (`src/shell.ts`). New code therefore shares the page's singletons: the registry, the kernel, the filesystem, the process table.

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

The live map keeps the exports and state bindings of `src/` modules from being tree-shaken, and the registrations add bytes of their own. On build 962 the JS grew by 4.8%: 8.17 MB → 8.56 MB, or 2.49 MB → 2.58 MB gzipped. That's all of `dist/assets/*.js`, measured with `npx vite build` with and without the plugin. Boot time doesn't change measurably. Over six fresh loads each in headless Chromium, the median time to `shiro:terminal:ready` was 218 ms with the plugin and 208 ms without, which is within the run-to-run spread (180–257 ms). The JS loaded at boot grows from 1.67 MB to 1.79 MB. The source tarball (about 3 MB) is downloaded only by `hotswap checkout`.

## Tests

`tests/tests/shiro-vitest/hotswap.test.ts` covers the swap, the revert, the TTL, migrateFrom, hooks, the build's live resolution, persistence with its build guard, the test runner, checkout/diff/push (with a fake GitHub), and a real `src/shell.ts` edited, built with esbuild and swapped into a live Shell. `tests/browser/hotswap.mjs` does the same in Chromium against a build: it runs `hotswap checkout`, edits `src/shell.ts` with sed, checks `hotswap diff`, applies it, sees the change in the main shell, lets the TTL revert it, then persists one, reloads, checks safe mode and reverts. Last, it runs three shell suites with `hotswap test` and checks that the tab's own file and localStorage key are unchanged.
