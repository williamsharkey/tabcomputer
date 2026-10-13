# Run links

A run link is a tabcomputer address that names a setup script. The page boots, runs the script in a new Terminal, and leaves the person where they need to be. A solution sent to someone is then one URL.

```
https://tabcomputer.com/?run=c-class
https://tabcomputer.com/?run=latex-paper&repo=https://github.com/someone/thesis&main=thesis.tex
https://tabcomputer.com/?run=gh:someone/project
```

Code: `src/run-url.ts` (parsing, the trust decision, the start file), `src/run-prompt.ts` (the Run / Cancel window), called from `src/main.ts` after the first prompt. Tests: `tests/tests/shiro-vitest/run-links.test.ts`, `run-links-gist.test.ts`, `tests/browser/run-links.mjs`.

An app link, `?app=<id>` or `?app=gh:owner/repo[/path]`, is the same machinery with an app in place of a script: [APPS.md](APPS.md) "Links".

## Forms

| Form | Meaning |
| --- | --- |
| `?run=<name>` | A curated recipe, served by the site at `/recipes/<name>.sh`. The name has only `a-z`, `0-9` and `-`. |
| `?run=gh:<owner>/<repo>[/<path>]` | A script in a GitHub repository, `.tabcomputer/run.sh` unless a path is given, fetched from `raw.githubusercontent.com` at the default branch, as a visitor. When GitHub does not give the file to a visitor (a private repository), the sign-in sheet opens; signed in, the file is fetched again through `api.github.com` with the tab's GitHub token, and shown with Run and Cancel as always. |
| `?run=gist:<user>/<id>[/<file>]` | A file of a public gist, its first file unless one is named, fetched from `gist.githubusercontent.com/<user>/<id>/raw[/<file>]`. `<file>` is one name, never a path. |
| `?run=gist:<id>` | The same without the user: the owner is looked up with GitHub's API (`api.github.com/gists/<id>`), and only a plain account name is taken from the answer; the raw address is built here. |
| `?run=sh:<base64url>` | A script carried in the link itself (UTF-8, base64url, at most 64 KB). |
| `?run=lab:<owner>/<repo>` | A class repository, private or public: no script is fetched. After a question the first time, `lab open` signs in if needed, clones it, installs the toolchains its `.tabcomputer/lab.json` names and opens the Code app. [CLASSROOM.md](CLASSROOM.md). |
| `&<name>=<value>` | An argument: the script reads it as `RUN_<NAME>` (`&repo=` is `$RUN_REPO`). |

The script runs in `~/run/<name>/`: the recipe's name, `gh-<owner>-<repo>`, `gist-<user>-<id>` or `sh-<hash>`. The page removes `run` and its arguments from the address (`history.replaceState`) before it fetches anything, so a reload does not run it again. `?ui=`, `?profile=` and the page's other parameters stay. `?safe=1` skips run links.

`/recipes` lists the curated recipes with a Run link each.

## After the #

A link can also be written after the `#` of the address (tabcomputer#147). A browser never sends that part of an address to a server, so the server does not see what such a link runs. A person can write one by hand.

```
https://tabcomputer.com/#pip install flask && python3 app.py
https://tabcomputer.com/#sh:name=World; echo hello $name
https://tabcomputer.com/#run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr
https://tabcomputer.com/#gist:0123456789abcdef0123456789abcdef
```

Code: `src/link-fragment.ts` (what the part after `#` means, with no DOM), `src/link-capture.ts` (taking it out of the address), `startFragmentLink` in `src/main.ts`. Tests: `tests/tests/shiro-vitest/link-fragment.test.ts`, `tests/browser/link-is-computer.mjs`. `/link` is a page where a person types commands or an app and sees the address.

| After the `#` | What opens |
| --- | --- |
| commands | The Run / Cancel window with the commands whole. Run opens a new Terminal that runs them. |
| `sh:` and commands | The same, whatever the commands start with. |
| `gz:<base64url>` | The same, with the commands gzipped. `link` makes this form for a script too long to read. |
| `key=value&key=value` | A one-file app: the keys of `app.json`. The install prompt, then the app. [APPS.md](APPS.md) "An app in the address". |
| `app=<base64url>` | An app's files, as `app share` packs them. |
| `gist:<id>`, `gist:<user>/<id>` | A gist. With an `app.json` in it the link is `?app=gist:…`. Without one the link is `?run=gist:…` for its first script: the first file named `.sh`, else the first file. `gist:<user>/<id>/<file>` names the script. |

**The rule that tells an app from commands.** The part after `#` is an app when it starts with a key of `app.json` and `=`: `run=`, `name=`, `table=`, `field.x=` and the rest of [APPS.md](APPS.md)'s list. Everything else is commands. So `#FOO=1 make`, `#echo a=b` and `#git config user.name=x` are commands: none starts with a key of `app.json`. `#name=World; echo $name` starts with one, so it is read as an app, and its error says to write `#sh:` first. `#sh:` makes the rest commands whatever it is.

**How the text is read.** The part after `#` is percent-decoded: `%20` is a space and `%0A` is a line break. A space typed by hand works, because the browser encodes it. A `%` that starts no code stays (`100%`). `+` is a plus. `;` and `&&` are the shell's own, so they need nothing. A second `#` is part of the commands. The whole part is at most 48,000 characters, and holds text only: control characters and invisible characters are refused, as for any script.

**What happens when one is opened.**

- The part after `#` leaves the address at the top of boot (`takeFragment`, the first line of `main()`), before storage opens and before anything is fetched. It is in no reload and no history entry. A link pasted into the address of a tab that is already open is taken the same way (`hashchange`).
- A framed page ignores it. `?safe=1` skips it. The Welcome card is not shown on a visit that came for a link.
- Commands go to `handleRunLink` and the Run / Cancel window, on the rules under "Trust" below. An app goes to `handleAppLink` and the install prompt. There is no other path: a link never runs or installs anything before the person presses Run or Install.
- Commands run in a new Terminal in the home folder, in that Terminal's own shell, as if they were typed: a `cd` or an `export` stays. (A `?run=` script runs in `~/run/<name>/`, in a subshell.) The text and its marker are kept in `~/run/sh-<hash>/`.
- **A second visit.** Commands that ran to their end here leave the marker. The same link opened again asks nothing and runs nothing: the Terminal says that the commands already ran here and how to run them again. Changed commands, commands that did not finish (a server that is still up, a last command that failed), and commands with an `# on-open:` line ask again.

`?run=sh:<base64url>` still works and is unchanged. It is in the query, so the request for the page carries it to the server.

**What the server learns.** Nothing of the commands or the app's manifest: `tests/browser/link-is-computer.mjs` records every request and checks that none carries them. Two things do reach it later, as for any app or command: an app's id is in the host name of the app page's own origin once the app is open, and what the commands download through this site (the relay, the Debian mirror) is seen as those requests are.

### The /link page

`public/link/index.html` and `public/link/fragment.js`: a box, the address beside it with its length, Open, Copy, and five examples. The box follows the address's rule: text that starts with an app key and `=` is an app, one key on each line, and a line that starts no key continues the value above it. `fragment.js` writes the address the way `src/link-fragment.ts` does (`link-fragment.test.ts` checks the two agree). Commands longer than 2,000 characters are shown as the `gz:` form.

Addresses of the page's examples, with `https://tabcomputer.com` as the site (`link-fragment.test.ts` prints them): a Python one-liner 68 characters, a Flask hello 285, the jq playground 531, the expenses table 215, a C hello 460.

## Trust

A tab can hold Claude and GitHub tokens and the person's files, so a link never runs code that nobody reviewed without asking.

- **Curated recipes run at once.** The Terminal first prints one line, `running recipe c-class (tabcomputer.com/recipes/c-class.sh)`. A recipe is curated only when `/recipes/index.json` on the page's own origin lists its name with the sha256 of the bytes `/recipes/<name>.sh` returned. Both are fetched with redirects refused, and an HTML answer (the app shell standing in for a missing file) is refused.
- **`gh:`, `gist:` and `sh:` scripts are shown first**, whole, in a window with Run and Cancel, with where the script came from and the variables the link sets. Only the Run button runs it. Cancel has the focus, closing the window is Cancel, and Run is off for the first moment. The window asks on every load, also when the script already ran here (then Run only does its `on-open` line). What runs is the text that was shown: it is not fetched again. Commands written after the `#` are shown the same way; the one difference is that a second visit to commands that finished here, with no `on-open` line, runs nothing and so asks nothing ("After the #" above).
- **A script from GitHub is fetched as exactly the file asked for**: without cookies or a referrer, no redirect followed, and an HTML answer is refused. A gist is never curated, whatever it is named.
- **The script must be what it looks like.** UTF-8 text without control characters, bidirectional overrides or invisible characters; otherwise it is refused. The prompt puts the script in with `textContent`, so markup in a script stays text.
- **Arguments are data.** Only the names in the script's `# args:` header are passed, as `RUN_<NAME>` in the Terminal's environment; other parameters are ignored and named in the Terminal. A link can't set `PATH` or any other variable. Values are never written into shell text. A value with control characters, or longer than 2000 characters, stops the run.
- **A framed page ignores run links**: the page around it could cover the prompt.

A refused link prints `run link: <why>` in the terminal and runs nothing.

### Seed and repository links

Two older kinds of link name what to load in the path instead of `?run=`, and follow the same rule (`src/inbound-link.ts`, tabcomputer#116):

- `/s/<id>` loads a shared seed: it replaces every file with the seed's. (Only a server with `TABCOMPUTER_SEED_SHARE=1` keeps shared seeds; tabcomputer.com does not.)
- `/<user>/<repo>` clones `github.com/<user>/<repo>` into `~/<repo>` and starts the project (`src/github-player`): a web page is served, a Node project gets `npm install`, and so on.

Where the server has guests, the page goes to a guest before anything is fetched: a seed to the kept guest `seed<id>`, a repository to a thrown-away one. Nothing of yours is there, so those go ahead without a question. Everywhere else (a main profile on a server without guests, or a guest you keep under another name, which may hold work and sign-ins) the same Run / Cancel window asks first. For a seed it lists the files it holds, with the startup files (`~/.profile` …) and the browser settings it sets first; for a repository it shows the clone command and what starting it does. Cancel changes nothing.

The link leaves the address before it is handled, a framed page ignores it, `?safe=1` ignores it, and a link that asked for a guest on a server without guests does nothing. A repository whose name starts with a dot is refused (it would be cloned over `~/.claude`, `~/.ssh` …). One with a dot elsewhere in its name (`socket.io`) does not open from a link: the server answers a path with a file extension with 404, not the app. A refused link prints `link: <why>`.

server.mjs gives the app shell a `<base href="/">` at exactly these addresses (`appLinkPath`): the shell names its entry relative to the page, so without it the app never started there. That was all that kept such a link from importing or running code in a signed-in profile with no question. The two changes belong together: do not add an address the app acts on without a question in front of it.

### In a guest

`&guest` on a run link opens it in a guest (docs/research/GUEST_PROFILE.md): tabcomputer on a separate origin that cannot read the main profile's files or sign-ins. `&guest=NAME` keeps the guest under that name, `&nonet` gives it no network. The page goes to the guest before anything is fetched, and the rest of the link goes along, so the prompt and the script appear there. When the server has no guests the link runs nothing and the Terminal says so. `guest` and `nonet` are the page's own parameters, never arguments.

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

A `gh:`, `gist:` or `sh:` script uses the same header keys; only `args` and `on-open` matter to the runner.

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
- `gh:` and `sh:` links opening in a guest by themselves, and the `claude-sandbox` gallery link carrying `&guest` (GUEST_PROFILE.md "Owner decisions"; Claude Code would need a sign-in of its own in the guest). The gallery's `untrusted-repo` card does carry `&guest` where the server has guests (`public/recipes/index.html` asks `/guest/config.json`).
- Acting on `needs` (a warning when the page can't run what the recipe needs) and measured `first-run` times.
