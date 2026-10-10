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
hotswap test tests/shiro-vitest/shell-conformance.test.ts   # (planned) run suites in the tab
git commit -am 'shell: ...' && git push -u origin fix/my-change
```

- `hotswap apply [--root DIR] [--ttl 90s | --no-ttl] FILE...` builds the files named, the *swap set*, with the page's esbuild-wasm and swaps them in. The root defaults to the nearest directory above the cwd that has `src/shell.ts`.
- Every apply arms a TTL, 90 s by default. If `hotswap confirm` doesn't come in time, the swap reverts by itself. A swap that breaks the shell can't run `confirm`, so it undoes itself.
- `hotswap revert [--all]` undoes the newest swap, or all of them. `hotswap status` lists what's applied, what each swap changed, and the time left on its TTL.
- `hotswap confirm --persist` also saves the confirmed swaps in IndexedDB, and boot re-applies them before `~/.profile` runs. That happens only on the same build (`__BUILD_SHA__` plus the build number): a new deploy discards them. Safe mode (`?safe=1`, or the automatic one) and `?hotswap=0` skip them, and `hotswap persisted [clear]` shows or drops them. A swap you never confirmed is never persisted, so a reload always gets rid of it.
- Out of band: `window.__tabcomputer.hotswap.revert(true)` from devtools, or the shiro-mcp `eval` of a remote session.

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

The live map keeps every `src/` module's exports from being tree-shaken. On build 959 that added about 3.8% to the JS (8.07 MB → 8.37 MB, 2.46 MB → 2.52 MB gzipped), measured with `npx vite build`.

## Tests

`tests/tests/shiro-vitest/hotswap.test.ts` covers the swap, the revert, the TTL, migrateFrom, hooks, the build's live resolution, persistence with its build guard, and a real `src/shell.ts` edited, built with esbuild and swapped into a live Shell. `tests/browser/hotswap.mjs` does the same in Chromium against a build: it copies `src/` into the tab, edits `src/shell.ts` with sed, applies it, sees the change in the main shell, lets the TTL revert it, then persists one, reloads, checks safe mode and reverts.
