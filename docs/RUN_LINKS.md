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
| `?run=gh:<owner>/<repo>[/<path>]` | A script in a GitHub repository, `.tabcomputer/run.sh` unless a path is given, fetched from `raw.githubusercontent.com` at the default branch, as a visitor. When GitHub does not give the file to a visitor, see "A repository that is not there" below. |
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

From a link to working, each from a fresh profile, on a local build with the site's files from localhost (`tests/browser/link-is-computer.mjs --only times`, headless Chrome on a Mac, 1280 px and a 390 x 844 touch screen alike): the Run / Cancel window or the install prompt is up about 0.35 s after the link is opened. From the click on Run or Install: the Python one-liner prints after 0.2 s, the Flask hello answers after 1.1 s (it fetches Flask from PyPI), the jq playground shows its first result after 0.15 s, the expenses table is usable after 0.15 s. The C hello was not run: its `needs=c` is Debian's gcc, which a local build does not serve. A deployed site adds its own download times to each.

### link: a link from what you did

`link` (and System → "Share This Setup as a Link…") writes the shortest script that gets another person to where this tab is, and the address that carries it. It reads what was typed at this tab's terminals since the tab was new. It works by rules; no model reads the session.

Code: `src/session-log.ts` (what is recorded), `src/link-trim.ts` (the rules, with no DOM and no filesystem), `src/net-tally.ts` (the downloads), `src/qr.ts` (the QR code), `src/commands/link.ts` (the command), `src/link-ui.ts` (the window). `qr.test.ts` checks the encoder. Tests: `tests/tests/shiro-vitest/link-trim.test.ts` with six recorded sessions in `fixtures/link-sessions.ts`, and the `link` part of `tests/browser/link-is-computer.mjs`.

```
link              the script, which form it fits, what it downloaded here, and the link
link --print      the link only
link --script     the script only
link --why        each line that was left out, and why
link -o FILE      write the script to FILE; edit it, then: link FILE
link FILE         the link for the script in FILE
```

On the desktop `link` also opens a window with the script in a box. The person can change the script there; the size line and the link follow. Without a desktop, `link -o setup.sh`, an editor, and `link setup.sh` do the same. (`link FILE1 FILE2` is still link(1): a second name for a file.)

**What is recorded.** The terminal records each line a person entered (`runLine` in `src/terminal.ts`): the line, the shell's folder before and after, the exit status, the start and end times, the files that changed while it ran, and what the page downloaded while it ran. The files come from the filesystem's own change events (`FileSystem.onChange`); nothing is scanned and no copy of a file is kept. The Code app says which files it saved (`noteEdited`), and `upload` and a drop on the Files app say which files came from the person's computer (`noteArrived`). The log is in `sessionStorage`: a reload keeps it, and closing the tab ends it. It is never sent anywhere.

**The rules.**

| A line | What happens to it |
| --- | --- |
| It succeeded and wrote, made or removed files (a clone, a build, a redirect) | Kept. |
| It is an install by name (`pip`, `npm`, `apt`, `pkg`, `toolchain`, `app` … `install`) and succeeded | Kept. |
| It set the shell up (`export`, `alias`, `source`, `X=1`) | Kept. |
| It failed | Dropped. |
| It only looked (`ls`, `cat`, `pwd`, `git status`, `--help`, `man`, `history`, `clear`, and others without a redirect) | Dropped. |
| It succeeded and changed nothing | Dropped. |
| It is entered again later, word for word, in the same folder | The last one stays. |
| It made one thing and a later line took exactly that away (`touch F` … `rm F`, `mkdir D` … `rmdir D` or `rm -r D`, `pip install X` … `pip uninstall X`, also `npm`, `pnpm`, `yarn`, `bun`, `apt`, `pkg`, `toolchain`, `app`, `gem`, `brew`) | Both are dropped, when no line between them named the thing or worked in or under it. `link --why` says "undone later (rm F)" and "it only undid an earlier line (touch F)". |
| `upload` | Dropped: the file it brought is named under "not in the link". |
| `cd` | Never kept as typed. Each kept line gets the folder it ran in: one `cd` where the folder changes, and one at the end for where the shell is now. A `cd` that nets out leaves nothing. |
| An editor (`vim`, `nano`, the Code app …) | Not replayed. Each file it was started on and wrote is recorded as a here-document with what the file holds now, where it was first edited, if it is text of at most 20,000 characters. A larger or binary file is named under "not in the link". |
| Work inside a program (`claude`, `python3` alone, `ssh`) | Dropped, and named under "not in the link" when it changed files. |
| A program that is still running, or that ran for 3 seconds or more until Ctrl-C (a server) | The last one is kept, at the end of the script. |
| It may hold a secret (`export API_KEY=…`, `--token …`, text shaped like a token) | Dropped, and the link says which name. |
| `link` | Dropped. |
| A line that sourced a link's own commands (`. ~/run/sh-…/.run-link`) | Replaced by those commands. |

A change that belongs to no line is ignored, so a download in the background does not make a line look as if it changed something. While boot's own preinstalls run, a change outside home belongs to no line (`sessionBackground`).

**The size line** says which form the script fits: a link a person can read (at most 2,000 characters), a compressed link (`#gz:`, at most 48,000 characters after the `#`), or neither. For the last, "Make a gist" keeps the script as a secret gist of the person's GitHub account and gives `#gist:USER/ID`. It asks for the GitHub sign-in with the desktop's sheet when the tab has none. That button is the one place `link` sends a script anywhere: to GitHub, through this site's GitHub proxy unless the network mode is private.

**The downloads line** says what the kept lines downloaded here and by which path: straight from the browser (npm, PyPI, GitHub), from this site's own files (Debian packages, Pyodide, tabcomputer packages), or through this site's relay (the TCP relay, the git proxy). More than 5 MB through the relay gets a warning: the relay is the part that costs this site each time someone opens the link. The counts come from the browser's own record of the page's requests (Resource Timing) and from the relay's transport (`tallyRelay` in `src/kernel/net.ts`); no request is intercepted. A site that does not let its sizes be read is counted in files only. A Worker's own requests (Pyodide loading a package) are not counted.

**The six recorded sessions** (`link-trim.test.ts` prints these; "too many" is lines kept that a person would still take out):

| Session | Typed | Kept | Dropped | Files as here-documents | Too many | Link |
| --- | --- | --- | --- | --- | --- | --- |
| A Flask hello | 11 | 3 | 8 | 1 | 0 | readable, 316 characters |
| A Vite app | 12 | 4 | 8 | 1 | 0 | readable, 306 |
| A C lab with an edited file | 13 | 2 | 11 | 1 | 0 | readable, 429 |
| A clone and a build | 14 | 7 | 7 | 0 | 0 | readable, 254 |
| A session full of mistakes | 24 | 6 | 18 | 0 | 0 | readable, 181 |
| A session with a large binary file | 6 | 3 | 3 | 2 | 0 | readable, 458 |

The session full of mistakes held `touch main.py` and, later, `rm main.py`. Each changed a file, so both were kept until the rule for two lines that cancel out; now neither is.

**A pair cancels out only when it is plain that it does.** Each line must be one simple command (no `&&`, no pipe). The first must have made one thing and nothing else: the one file it changed, the folder `mkdir` named, or the packages an install named. The second must take away exactly that: the same path, or the same installer with the same names (for `npm` and its kind, in the same folder, unless `-g`). A line between them that names the thing, runs in or under it, or changes a file under it keeps both: a `cd build && cmake ..` between `mkdir build` and `rm -r build` does. An uninstall with no install before it in the session is kept: it changes the other person's computer too.

**A file that came from outside.** A file put in the tab with `upload`, or dropped on the Files app, was made by no command, so no line of the script makes it. The window and `link` name it: "~/data.csv (13 KB, from your computer) is not in the link. Put it where the link's commands can fetch it, and add the line that fetches it." A file that an editor then saved as text is in the script as a here-document and is not named.

**The QR code.** The window's "QR code" button shows the link as a QR code under it, for a phone's camera, and follows the script as it is edited. It is offered for a link of at most 2,953 bytes, which is what the largest code holds (version 40, error correction L, byte mode); a longer link has no button. `src/qr.ts` is the encoder: 255 lines, no dependency, byte mode and level L only. `qr.test.ts` checks it against the standard's own numbers (ISO/IEC 18004: the Reed-Solomon worked example of Annex I, the format words of table C.1, the version words of Annex D, the block and alignment tables for all 40 versions) and reads codes back with a decoder written for the test, for every version at its last byte and one byte past it. `tests/browser/link-is-computer.mjs` reads the window's code with Chrome's own reader (`BarcodeDetector`) and gets the link back, for a link of 180 characters and one of 1,856, at 1280 px and on a 390 x 844 touch screen, in both appearances. It was not scanned with a phone's camera.

**The relay's bytes, checked in a browser.** `tests/browser/link-is-computer.mjs --only relay`, on a server started with the relay on for this machine's own address: `curl` of a file from a site that sends no CORS headers goes over the relay, and `link` says "Through this site's relay: 192.168.1.38 3 KB." for a file of 2,000 bytes and "… 6.0 MB." with the warning for one of 6 MB (headless Chrome 155 on a Mac). The check found one false sentence: the browser tries such a file itself first and is refused, and that refused request was counted as "Straight from the browser: 192.168.1.38 1 file". A request the browser's record gives status 0 is no longer counted (`received` in `src/net-tally.ts`).

Not built: "Tidy with Claude", a QR code on the `/link` page, and a count of what a Worker downloads. A file dropped on a terminal or on the desktop itself is recorded only where that path goes through `upload` or the Files app.

## Trust

A tab can hold Claude and GitHub tokens and the person's files, so a link never runs code that nobody reviewed without asking.

- **Curated recipes run at once.** The Terminal first prints one line, `running recipe c-class (tabcomputer.com/recipes/c-class.sh)`. A recipe is curated only when `/recipes/index.json` on the page's own origin lists its name with the sha256 of the bytes `/recipes/<name>.sh` returned. Both are fetched with redirects refused, and an HTML answer (the app shell standing in for a missing file) is refused.
- **`gh:`, `gist:` and `sh:` scripts are shown first**, whole, in a window with Run and Cancel, with where the script came from and the variables the link sets. The window says four things and no more: the question ("Run this script?", or "Run these commands?" for commands after the `#`), where it is from ("From github.com/someone/project, .tabcomputer/run.sh. Not reviewed by tabcomputer.", or "From this link. …"), the script, and one sentence on what it can touch: "It runs as you: it can read and change every file in this tab and use its sign-ins (Claude, GitHub)." Where it ran is said only when it ran here before. On a phone the window is the whole screen, without the desktop's menu bar and dock, with Cancel and Run as two wide buttons at the bottom. Only the Run button runs it. Cancel has the focus, closing the window is Cancel, and Run is off for the first moment. The window asks on every load, also when the script already ran here (then Run only does its `on-open` line). What runs is the text that was shown: it is not fetched again. Commands written after the `#` are shown the same way; the one difference is that a second visit to commands that finished here, with no `on-open` line, runs nothing and so asks nothing ("After the #" above).
- **A script from GitHub is fetched as exactly the file asked for**: without cookies or a referrer, no redirect followed, and an HTML answer is refused. A gist is never curated, whatever it is named.
- **The script must be what it looks like.** UTF-8 text without control characters, bidirectional overrides or invisible characters; otherwise it is refused. The prompt puts the script in with `textContent`, so markup in a script stays text.
- **Arguments are data.** Only the names in the script's `# args:` header are passed, as `RUN_<NAME>` in the Terminal's environment; other parameters are ignored and named in the Terminal. A link can't set `PATH` or any other variable. Values are never written into shell text. A value with control characters, or longer than 2000 characters, stops the run.
- **A framed page ignores run links**: the page around it could cover the prompt.

A refused link prints `run link: <why>` in the terminal and runs nothing.

### A repository that is not there

GitHub answers 404 for a file in a private repository and for one that does not exist, so that a visitor cannot tell the two apart. Before the sign-in sheet is shown, the tab asks GitHub's public API two questions, as a visitor, with no token (`githubNotThere` in `src/run-url.ts`):

| GitHub's answer | What the person sees |
| --- | --- |
| `repos/O/R` is there (a public repository) | At once, with no sheet: `run link: github.com/O/R has no .tabcomputer/run.sh`. |
| `users/O` is not there | At once, with no sheet: `run link: github.com/O/R does not exist: GitHub has no account named O`. |
| The account exists and the repository is not shown to a visitor | The sign-in sheet: "gh:O/R needs a GitHub sign-in. GitHub did not give this repository to a visitor who is not signed in. The repository is private, or its name is wrong." Signed in, the file is fetched again through `api.github.com` with the tab's token and shown with Run and Cancel as always. "Not now" leaves `run link: github.com/O/R, .tabcomputer/run.sh does not exist, or it is private: a private repository needs a GitHub sign-in`. |
| The API does not answer (rate limit, no network) | The sheet, as in the row above. |

The same check is in front of `?app=gh:` (`src/apps/links.ts`). `tests/browser/run-links.mjs` runs each row against a stand-in for GitHub.

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

A message about a link (`run link: …`, `link: …`, `app link: …`) is written to the Terminal with `ShiroTerminal.notice()`, above a new prompt. Written under the prompt instead, it was taken for the prompt when the session was saved, and each reload then added one more "the output above is from before the page reloaded" line and one more copy of the message (tabcomputer#128). A restored screen now also holds one such line, whatever was saved (`dropNotes` in `src/desktop/restore-note.ts`); `tests/browser/run-links.mjs` loads one profile nine times, each load printing a message, and counts one.

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
| `python-class` | the same, Python (the built-in one: nothing to install) | untested in a browser |
| `latex-paper` | a LaTeX project with no compile time limit and no upload | untested (needs Debian) |
| `wordperfect-rescue` | old WordPerfect / Works / ClarisWorks / Visio / CorelDraw files, converted in the tab | untested (needs Debian) |
| `claude-sandbox` | Claude Code on a repository in a throwaway machine | runs (`tests/browser/run-links.mjs`, without `repo`) |
| `untrusted-repo` | looking inside a repository or archive you don't trust | runs (`tests/browser/run-links.mjs`, without `url`) |

## Not built yet

- Recipe snapshots: a heavy recipe's resulting files built on the server and streamed, as toolchain layers are.
- `gh:` and `sh:` links opening in a guest by themselves, and the `claude-sandbox` gallery link carrying `&guest` (GUEST_PROFILE.md "Owner decisions"; Claude Code would need a sign-in of its own in the guest). The gallery's `untrusted-repo` card does carry `&guest` where the server has guests (`public/recipes/index.html` asks `/guest/config.json`).
- Acting on `needs` (a warning when the page can't run what the recipe needs) and measured `first-run` times.
