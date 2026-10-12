# Developing tabcomputer from inside tabcomputer

A walkthrough for a coding agent running in someone's tab, such as Claude Code. You'll fix
something in tabcomputer itself, try the fix in the running tab, test it, push it as a
branch, and report it so the coordinator can merge it. [HOTSWAP.md](HOTSWAP.md) is the
reference for what `hotswap` can and can't swap. This page is the order to do things in.

Every command and output below is real. They were run in headless Chromium against a
local production build of cf60c7b (build number 973), in a shell forked from the tab's
main shell. Times are from that run.

## Before you start

- You need a deployed build (tabcomputer.com, or `npm run build` and `node server.mjs`).
  A dev server has no source tarball, so `hotswap checkout` fails there.
- `hotswap push` needs a GitHub sign-in: `gh auth login` (the device flow, or the globe
  icon in the menu bar). The name and email for the commit come from `~/.gitconfig`.
- A swap changes the shell you're running in. A broken swap undoes itself after its TTL
  (90 s by default) unless you confirm it, so never confirm a swap you haven't tried.

## 1. Check out this build's source

```console
$ hotswap checkout
checked out build 973 (cf60c7b1b1e5), 873 files, in /home/user/tabcomputer
edit, then: cd /home/user/tabcomputer && hotswap apply src/shell.ts
```

- It takes about 150 ms. The default directory is `~/tabcomputer`. In a tab that already
  has a checkout in `~/shiro` (the default before Build 974) and no `~/tabcomputer`,
  `hotswap checkout` keeps using `~/shiro` and says so; `hotswap checkout ~/tabcomputer`
  makes a new one.
- The checkout is the source of the page you're running, not of main. That is the
  build's `src/`, `profiles/`, `tests/`, the root build files, AGENTS.md and the docs on
  hot-swapping. It doesn't include `public/`, `vendor/`, `scripts/`, `bench/` or
  `server.mjs`. Use `git clone --depth 1` if you need to read those.
- `.hotswap-source.json` records the commit, the build number and each file's git blob
  id. `hotswap diff` and `hotswap push` use it.
- A directory that isn't empty is refused (`is not empty (--force unpacks over it)`).
  `--force` unpacks over it and resets your edits.
- The other `hotswap` commands find the checkout from the cwd: the nearest directory
  above it that has `src/shell.ts`. Elsewhere they say `no checkout found above the cwd
  (a directory with src/shell.ts); pass --root DIR`.

## 2. Edit, and see what you changed

Edit with `vi`, `sed` or Claude's Edit tool. This example changes what `$BASH_VERSION`
expands to:

```console
$ cd ~/tabcomputer
$ sed -i "s/result += '5.0.0'/result += '5.0.0-mine'/" src/shell.ts
$ hotswap diff --stat
M src/shell.ts
$ hotswap diff
--- a/src/shell.ts
+++ b/src/shell.ts
@@ -5712,7 +5712,7 @@
...
-          if (varName === 'BASH_VERSION') { result += '5.0.0'; i += m[0].length; continue; }
+          if (varName === 'BASH_VERSION') { result += '5.0.0-mine'; i += m[0].length; continue; }
```

## 3. Swap it in, try it, keep it or undo it

```console
$ hotswap build src/shell.ts            # optional: build only (1.3 s)
built src/shell.ts (416269 bytes)
$ hotswap apply src/shell.ts            # build and swap (about 0.5 s)
built src/shell.ts (416269 bytes)
applied #1 src/shell.ts (reverts in 90s unless confirmed, applied 0s ago)
  src/shell.ts: Shell: 169 method(s) swapped
  src/shell.ts: shares the page's module state: _wasiRuntime, _shellKernel, ...
  src/shell.ts: not swapped (other modules keep the old ones): capturingStdout, formatPrintf, ...
run 'hotswap confirm' to keep it, 'hotswap revert' to undo it now
$ echo $BASH_VERSION
5.0.0-mine
```

Every shell in the tab runs the new methods from its next call, including the one
running you. There's no reload. Then do one of these:

- `hotswap confirm` keeps the swap for this page load (`confirmed #1 src/shell.ts`).
  `hotswap confirm --persist` also re-applies it at boot, on this build only.
- `hotswap revert` undoes the newest swap (`reverted #1 src/shell.ts`), and
  `hotswap revert --all` undoes all of them.
- Do nothing. With `--ttl 5s`, `echo $BASH_VERSION` printed `5.0.0` again 6.5 s later,
  and `hotswap status` printed `No swaps applied.`

Read the `not swapped` line. A swap replaces class methods, registry commands and declared
module state. It doesn't replace free functions that other modules import, or the
constructors of objects that already exist. The #49 fix below changed `BufferFile`'s
constructor. `hotswap apply src/kernel/fd.ts` swapped 12 of `BufferFile`'s methods, but
not the constructor: every `new BufferFile(...)` in the page still ran the old one. So the
fix could be tested, but couldn't be tried live in the tab. The issue said so, and the full suite was
run outside the tab instead.

## 4. Test it in the tab

`hotswap test SUITE...` builds a vitest suite from the checkout and runs it in the tab.
A SUITE is a name under `tests/tests/shiro-vitest/` or a path. The suite tests the source
as you edited it, whether or not it's swapped in. Its IndexedDB, localStorage and
`document` are separate from the tab's, so a suite that clears `document.body` leaves
the desktop alone.

```console
$ hotswap test byte-text
 PASS tests/tests/shiro-vitest/byte-text.test.ts: 6 passed (0.3s)
$ hotswap test shell-posix
 PASS tests/tests/shiro-vitest/shell-posix.test.ts: 37 passed (0.7s)
```

Each took about 4 s, most of it the build. `-v` lists each test, `-t RE` runs only the
tests whose names match, and `--root DIR` names the checkout.

Show that your test catches the bug: run it once with the fix taken out. Here, with
#49's fix undone in `src/kernel/fd.ts` (`encodeText(input)` back to
`new TextEncoder().encode(input)`):

```console
$ hotswap test byte-text
 × binary data through string-stdio commands > a kernel stdin given as a string reads back the bytes it stands for
     AssertionError: expected Uint8Array [0, 7, 14, ..., 126, 239, 191, 189, 239, 191, 189, ...] to deeply equal Uint8Array [...]
 FAIL tests/tests/shiro-vitest/byte-text.test.ts: 5 passed, 1 failed (0.4s)
```

Limits: `node:fs`, `node:child_process`, Workers and esbuild aren't available to suites in
the tab, so tests that need them fail here and pass outside it. Run the same suite without
your change and report those failures as failing both ways, as #49 did for `kernel-core`.
HOTSWAP.md "Testing in the tab" lists what the runner supports.

## 5. Push a branch

```sh
hotswap push hotswap/stdin-bytes -m 'kernel: keep binary stdin byte-exact in BufferFile (#49)'
```

- This commits your changes on top of the build's commit and creates the branch on
  williamsharkey/tabcomputer through GitHub's API. It prints the branch URL and a
  `gh pr create` line.
- Pushing again from the same checkout adds a commit on top.
- It only makes new branches. These are refused before anything is sent:
  ```console
  $ hotswap push main -m x
  hotswap push: won't push to main: push a new branch (e.g. hotswap/main-fix) and open a pull request
  $ hotswap push unix/tab-stdin-bytes -m x
  hotswap push: won't push to unix/tab-stdin-bytes: push a new branch (e.g. hotswap/tab-stdin-bytes-fix) and open a pull request
  ```
  So are master, deploy, any other `unix/*` name, an existing branch this checkout didn't
  make, and a branch that has moved since this checkout pushed it.
- Without a sign-in it fails with `hotswap push: not signed in to GitHub: run gh auth login`.
- The branch is based on the build's commit, which is usually behind main. The
  coordinator merges it into main, so you don't need to rebase it.

## 6. Report it: issue, branch, test results

[#49](https://github.com/williamsharkey/tabcomputer/issues/49) and its branch
`unix/tab-stdin-bytes` are a complete example: from report to merge in 36 minutes, with
no follow-up questions.

**The issue** (`gh issue create`, or the GitHub tools) gave:

- **The build:** `**Build:** #965 · deploy e4bf7da19d32 · perf2.tabcomputer.com (Chrome 154)`.
  The `build` line of `doctor` has it.
- **The symptom in one bold sentence:** *Bytes given on stdin to a kernel program (x86 in
  Blink, WASM, node) from the builtin shell lose every byte that isn't valid UTF-8: each
  becomes U+FFFD.*
- **A repro with actual output next to the right answer.** The issue showed hash values,
  so the difference can't be read wrong:
  ```sh
  printf '\x80' > t.bin
  $X hash-object t.bin                 # 5416677b…  (right)
  $X hash-object --stdin < t.bin       # f488f849…  = hash of EF BF BD
  ```
- **The edges:** which bytes survive (`\x00\x01\x7f`, valid UTF-8) and which don't (`\x80`,
  `\xff\xfe`).
- **The effect on real work:** `git index-pack --stdin < pack` fails, and so do
  `gzip -d < f.gz` and `tar x < f.tar`.
- **The cause, with file and line,** and every caller that reaches it:
  `src/kernel/fd.ts` `BufferFile` encodes with a plain `TextEncoder`, the stdin of x86
  (`x86-engine/blink.ts:685`), WASM (`wasi/run-command.ts:96`) and node.
- **The fix in one line,** and "Branch coming."

**The branch** was one commit on the build's commit (Build 965, e4bf7da1), +24/-4: the fix
in `src/kernel/fd.ts` and a new test in `byte-text.test.ts`. Its message said what was
wrong, what it broke and what changed, and named the issue.

**A comment on the issue** when the branch was up:

- the branch, the commit, and what it was based on ("one commit on build 965's e4bf7da1.
  Not on main, not deployed");
- the diff, file by file;
- the tests run in the tab. These were `hotswap test byte-text` with 6 passed, and
  5 passed, 1 failed with the original fd.ts. There was also `kernel-core` with 48 passed,
  1 failed, and that one failed the same without the change;
- what wasn't verified, and why: "hotswap moves prototype methods, not constructors, so
  the constructor fix can't be swapped into this tab. Please run the full suite off-tab."

Then the coordinator took over. It ran the suites outside the tab, merged the branch into
Build 972, commented with the result, and closed the issue.

Rules of thumb:

- File the issue first, and claim it in a comment before you start, so nobody else does
  the same fix.
- One issue, one branch, one fix. Put unrelated findings in their own issues.
- Push to a new name. The `unix/tab-*` branches field testers pushed (`unix/tab-stdin-bytes`,
  `unix/tab-node-fetch-exit`) came from outside `hotswap push`, which refuses `unix/*`.
  From the tab, use `hotswap/<topic>` and name it in the issue.
- Say what you couldn't check. Leave closing to the coordinator: it closes an issue when
  the fix ships.
