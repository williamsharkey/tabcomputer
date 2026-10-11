# Developing tabcomputer from inside tabcomputer

An agent in a tab (Claude Code, or you at the prompt) can change tabcomputer's own core code: the shell, the terminal, kernel classes. The change goes into the running tab without a reload, because a reload would kill the agent making it. This is `hotswap` (`src/hotswap/`, `src/commands/hotswap.ts`). It is experimental.

## The workflow

```sh
git clone --depth 1 https://github.com/williamsharkey/shiro ~/shiro   # a checkout in the tab
cd ~/shiro && git checkout -b fix/my-change
vi src/shell.ts                          # edit
hotswap build src/shell.ts               # optional: build only and report
hotswap apply src/shell.ts               # swap it in; reverts by itself in 90 s
echo $BASH_VERSION; ...                  # try it in this tab
hotswap confirm                          # keep it (this page load only)
hotswap test shell-posix shell-syntax   # run vitest suites from the checkout in the tab
git commit -am 'shell: ...' && git push -u origin fix/my-change
```

- `hotswap apply [--root DIR] [--ttl 90s | --no-ttl] FILE...` builds the files named, the *swap set*, with the page's esbuild-wasm and swaps them in. The root defaults to the nearest directory above the cwd that has `src/shell.ts`.
- Every apply arms a TTL, 90 s by default. If `hotswap confirm` doesn't come in time, the swap reverts by itself. A swap that breaks the shell can't run `confirm`, so it undoes itself.
- `hotswap revert [--all]` undoes the newest swap, or all of them. `hotswap status` lists what's applied, what each swap changed, and the time left on its TTL.
- `hotswap confirm --persist` also saves the confirmed swaps in IndexedDB, and boot re-applies them before `~/.profile` runs. That happens only on the same build (`__BUILD_SHA__` plus the build number): a new deploy discards them. Safe mode (`?safe=1`, or the automatic one) and `?hotswap=0` skip them, and `hotswap persisted [clear]` shows or drops them. A swap you never confirmed is never persisted, so a reload always gets rid of it.
- Out of band: `window.__tabcomputer.hotswap.revert(true)` from devtools, or the shiro-mcp `eval` of a remote session.

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
- **New instances.** Code in the swap that does `new Shell()` (forks, subshells) makes instances of the new class. `instanceof` treats the live class and the classes swapped into it as one class, both ways. On revert, those instances run the old code again.
- **Hooks.**
  - `migrateFrom(old)` on the new class's prototype runs once for each tracked live instance. `this` is the instance, and `old` carries the previous methods. It isn't installed on the prototype. The boot's shell, terminal, kernel and fs and the desktop's extra shells are tracked (`trackInstance` in `src/hotswap/live.ts`).
  - `export function __hotswap(ctx)` in a swapped module runs after its classes are swapped. `ctx.old` is the live namespace, `ctx.instances(Class)` the tracked instances, and `ctx.onRevert(fn)` registers cleanup. It may also return a function to run on revert.
- **Lazy modules.**
  - An `import()` of a module outside the swap set gets the page's module when the code runs, loading the page's chunk if needed. The plugin records a loader for every `import()` in `src/`.
  - A static import of a lazy module that isn't loaded yet is loaded before the bundle runs.
  - A module the page has no copy of and no loader for is copied into the bundle from the checkout. The build warns about it, because that copy has its own module state.
- **All or nothing.** A swap that throws (in a hook, for instance) is undone before `apply` returns.

## What a swap can't change

- **Free functions and constants** exported by a swapped file and imported by modules outside the swap set: ESM bindings are fixed, so `hotswap apply` lists them as "not swapped". To change one, add the importer to the swap set, or move the logic into a method.
- **Constructors and fields of existing instances.** The new constructor runs only for instances the new code makes. Set new fields on old instances in `migrateFrom`.
- **Module-level state of a swapped file** (`let cache = ...`). The bundle has a fresh copy, and all the swapped methods use it. Carry state over in `__hotswap` if it matters. The module's top-level code also runs again.
- **Closures already handed out**: bound listeners, timers, a stored `this.fn.bind(this)`. They keep the old code until they're re-created.
- **Classes with `#private` members**: old instances fail the brand check in new methods.
- **Anything running in a Worker**: the node runtime's workers, WASM and Blink guests, the watchdog worker. That includes everything they share with the page: the kernel's syscall channel layout, SharedArrayBuffer formats, syscall numbers and ABI structs. Change those with a deploy.
- **Vite-only imports in the swap set** (`?worker`, `?url`): they can't be built in the tab. `?raw` works. Bare npm imports work for the packages in `LIVE_DEPS` in `vite-plugin-hotswap.ts` (xterm today).
- **The dev server** (`npm run dev`). The plugin runs only in production builds, where module ids are stable.

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

The live map stops tree-shaking from removing unused exports of `src/` modules, and the registrations add bytes of their own. On build 961 it added 4.3% to the JS: 8.17 MB → 8.52 MB, or 2.49 MB → 2.56 MB gzipped (all of `dist/assets/*.js`, `npx vite build` with and without the plugin).

## Tests

`tests/tests/shiro-vitest/hotswap.test.ts` covers the swap, the revert, the TTL, migrateFrom, hooks, the build's live resolution, persistence with its build guard, the test runner, and a real `src/shell.ts` edited, built with esbuild and swapped into a live Shell. `tests/browser/hotswap.mjs` does the same in Chromium against a build: it copies `src/` into the tab, edits `src/shell.ts` with sed, applies it, sees the change in the main shell, lets the TTL revert it, then persists one, reloads, checks safe mode and reverts. Last, it runs three shell suites with `hotswap test` and checks that the tab's own file and localStorage key are unchanged.
