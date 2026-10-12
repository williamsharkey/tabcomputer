# Run links

A run link is a tabcomputer address that names a setup script. The page boots, runs the script in a new Terminal, and leaves the person where they need to be. A solution sent to someone is then one URL.

```
https://tabcomputer.com/?run=c-class
https://tabcomputer.com/?run=latex-paper&repo=https://github.com/someone/thesis&main=thesis.tex
https://tabcomputer.com/?run=gh:someone/project
```

Code: `src/run-url.ts` (parsing, the trust decision, the start file), `src/run-prompt.ts` (the Run / Cancel window), called from `src/main.ts` after the first prompt. Tests: `tests/tests/shiro-vitest/run-links.test.ts`, `tests/browser/run-links.mjs`.

## Forms

| Form | Meaning |
| --- | --- |
| `?run=<name>` | A curated recipe, served by the site at `/recipes/<name>.sh`. The name has only `a-z`, `0-9` and `-`. |
| `?run=gh:<owner>/<repo>[/<path>]` | A script in a GitHub repository, `.tabcomputer/run.sh` unless a path is given, fetched from `raw.githubusercontent.com` at the default branch. Public repositories only. |
| `?run=sh:<base64url>` | A script carried in the link itself (UTF-8, base64url, at most 64 KB). |
| `&<name>=<value>` | An argument: the script reads it as `RUN_<NAME>` (`&repo=` is `$RUN_REPO`). |

The script runs in `~/run/<name>/`: the recipe's name, `gh-<owner>-<repo>` or `sh-<hash>`. The page removes `run` and its arguments from the address (`history.replaceState`) before it fetches anything, so a reload does not run it again. `?ui=`, `?profile=` and the page's other parameters stay. `?safe=1` skips run links.

`/recipes` lists the curated recipes with a Run link each.

## Trust

A tab can hold Claude and GitHub tokens and the person's files, so a link never runs code that nobody reviewed without asking.

- **Curated recipes run at once.** The Terminal first prints one line, `running recipe c-class (tabcomputer.com/recipes/c-class.sh)`. A recipe is curated only when `/recipes/index.json` on the page's own origin lists its name with the sha256 of the bytes `/recipes/<name>.sh` returned. Both are fetched with redirects refused, and an HTML answer (the app shell standing in for a missing file) is refused.
- **`gh:` and `sh:` scripts are shown first**, whole, in a window with Run and Cancel, with where the script came from and the variables the link sets. Only the Run button runs it. Cancel has the focus, closing the window is Cancel, and Run is off for the first moment. The window asks on every load, also when the script already ran here (then Run only does its `on-open` line). What runs is the text that was shown: it is not fetched again.
- **The script must be what it looks like.** UTF-8 text without control characters, bidirectional overrides or invisible characters; otherwise it is refused. The prompt puts the script in with `textContent`, so markup in a script stays text.
- **Arguments are data.** Only the names in the script's `# args:` header are passed, as `RUN_<NAME>` in the Terminal's environment; other parameters are ignored and named in the Terminal. A link can't set `PATH` or any other variable. Values are never written into shell text. A value with control characters, or longer than 2000 characters, stops the run.
- **A framed page ignores run links**: the page around it could cover the prompt.

A refused link prints `run link: <why>` in the terminal and runs nothing.

### What a curated recipe may do with its arguments

Anyone can make a link to a curated recipe with any argument values, and it runs without a prompt. So a recipe treats its arguments as hostile:

- It may fetch what an argument names (clone a repository, download an archive). It must not run it: no build, no `pip install`, no `latexmk`, no unpacking. It prints the command instead, and the person runs it.
- It checks a URL is `https://` before using it, and passes it after `--`.
- It quotes every `"$RUN_X"`. Before it prints a value as part of a command for the person to run, it checks the value is plain (see `python-class.sh`, `latex-paper.sh`).

`run-links.test.ts` runs every shipped recipe with hostile values.

## Second loads

A script that finishes leaves `~/run/<name>/.done-<hash of the script>`. On the next load the runner sees the marker and runs only the script's `# on-open:` line. A changed script has another hash and runs again, so recipes guard their steps (`[ -d work/.git ] || git clone ...`) to keep that cheap. A script that fails leaves no marker; the Terminal says how to run it again.

The runner writes two files in the directory: `.recipe.sh` (the script) and `.run-link` (what the Terminal sources: the first line, the script in a subshell, the marker, the on-open line).

## Recipe format

A recipe is a bash script in `public/recipes/`. It is sourced in a subshell of tabcomputer's own shell, so `toolchain`, `debian`, `gui` and `open` work before and after Debian is installed. Header comments carry its metadata:

```bash
#!/bin/bash
# title: C programming class
# for: students and teachers on machines where nothing can be installed
# needs: debian toolchain:c net
# args: repo (optional https URL of the starter code)
# on-open: cd ~/run/c-class/work
# status: untested
set -e
toolchain list | grep -q '^c  *yes' || toolchain install c
mkdir -p work && cd work
```

| Key | Use |
| --- | --- |
| `title` | The Terminal window's title and the gallery card |
| `for` | Who it helps (gallery) |
| `needs` | `debian`, `toolchain:<set>`, `gui`, `net`, `claude` (gallery; the runner does not act on it yet) |
| `args` | The arguments a link may pass: `name (what it is), name (...)` |
| `on-open` | One line run in the Terminal's own shell after the script, and alone on later loads: usually a `cd` |
| `first-run`, `later` | Measured times, once someone has measured them |
| `profile` | The product it suits (`shiro` for terminal-only recipes); informational |
| `status` | `untested` until the recipe has been run in tabcomputer |

Notes for authors:

- Guard every step so a rerun costs seconds, and prefer `toolchain install <set>` to `apt install` where a layer exists (docs/DEBIAN.md "Toolchain layers").
- `gcc`, `python3` and other names are tabcomputer builtins before Debian's are installed, so `command -v gcc` is true on a fresh machine. Ask `toolchain list` instead.
- After changing a recipe run `node scripts/recipes/gen-index.mjs`: it rewrites `public/recipes/index.json`, and a recipe whose hash is not in the list does not run. `run-links.test.ts` fails when the list is out of date.

A `gh:` or `sh:` script uses the same header keys; only `args` and `on-open` matter to the runner.

## A badge for a README

Put the setup script at `.tabcomputer/run.sh` in the repository, then:

```markdown
[![Run in tabcomputer](https://tabcomputer.com/recipes/badge.svg)](https://tabcomputer.com/?run=gh:owner/repo)
```

## Recipes

| Recipe | For | Status |
| --- | --- | --- |
| `c-class` | a C class on machines where nothing can be installed | untested (needs Debian) |
| `python-class` | the same, Python | untested (needs Debian) |
| `latex-paper` | a LaTeX project with no compile time limit and no upload | untested (needs Debian) |
| `wordperfect-rescue` | old WordPerfect / Works / ClarisWorks / Visio / CorelDraw files, converted in the tab | untested (needs Debian) |
| `claude-sandbox` | Claude Code on a repository in a throwaway machine | runs (`tests/browser/run-links.mjs`, without `repo`) |
| `untrusted-repo` | looking inside a repository or archive you don't trust | runs (`tests/browser/run-links.mjs`, without `url`) |

## Not built yet

- Recipe snapshots: a heavy recipe's resulting files built on the server and streamed, as toolchain layers are.
- A separate filesystem profile per third-party script, so it never sees `~/.claude`.
- Acting on `needs` (a warning when the page can't run what the recipe needs) and measured `first-run` times.
