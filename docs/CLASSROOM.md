# Classroom workspace

A student on a shared school computer opens a link, edits a few files, runs them, and pushes to hand in (tabcomputer#130). Four parts: the lab link, the lab's config file, the Code app's buttons and saved mark, and the sign-out for a shared computer. For the school's IT there is [SCHOOL_IT.md](SCHOOL_IT.md).

Code: `src/run-url.ts` (the `lab:` form of a run link), `src/lab.ts` (the config, Submit, the saved state), `src/commands/lab.ts` (`lab`), `src/commands/code-editor.ts` (the bar and the mark in the Code app), `src/sign-out.ts` and `src/commands/signout.ts`. Tests: `tests/tests/shiro-vitest/classroom.test.ts` (against an in-memory GitHub), `tests/browser/classroom.mjs`.

## The lab link

```
https://tabcomputer.com/?run=lab:OWNER/REPO
```

`OWNER/REPO` is the student's own repository, so a template can stay private: the link never reads the template. With GitHub Classroom, it is the repository Classroom made for the student.

It is a [run link](RUN_LINKS.md) and follows their rules: the address is cleaned before anything happens, a framed page ignores it, `?safe=1` skips it, `&guest` moves it to a guest. It fetches no script. What it runs is `lab open OWNER/REPO` in a new Terminal:

1. If the clone fails and the tab is not signed in to GitHub, it says the repository is private or misnamed and runs `gh auth login` (GitHub's device flow), then clones again.
2. It clones into `~/src/REPO` (`~/src/OWNER/REPO` when that name holds something else).
3. It installs the toolchains the config names that are missing (`toolchain install`).
4. It opens the Code app on the folder, beside the Terminal, and leaves the Terminal in the folder.
5. If the config names a notebook, it opens that notebook in the Notebook app.

The first time, a window asks first ("Open OWNER/REPO?", with what opening does, Open and Cancel). Nothing from the repository runs by opening it; its `run` and `test` commands run when the student presses the buttons. A folder that is already a clone of that repository opens without the question: nothing is fetched. `lab open` does every step only if it is needed, so the same link is how a student comes back.

## The config file

`.tabcomputer/lab.json` in the repository (beside `.tabcomputer/run.sh`, a run link's script). Every key but `lab` is optional.

```json
{
  "lab": 1,
  "name": "Lab 3: loops",
  "toolchains": ["python"],
  "run": "python3 main.py",
  "test": "python3 -m unittest -q",
  "notebook": "lab3.ipynb"
}
```

| Key | Meaning |
| --- | --- |
| `lab` | The format's version: `1`. A newer one is refused. |
| `name` | Shown beside the buttons. At most 60 characters. |
| `toolchains` | Sets `toolchain install` applies when the lab opens (`toolchain list` shows the ids). At most 8. The built-in `python3` and `node` need none. |
| `run` | A shell line, run in the config's folder in a Terminal. |
| `test` | The same, for the teacher's tests. |
| `notebook` | A Jupyter notebook in the repository (a path from the config's folder, ending in `.ipynb`). The lab link opens it in the Notebook app ([NOTEBOOK.md](NOTEBOOK.md)), in front of the Code app. It needs no toolchain. A notebook the repository does not have is said in the Terminal, and the lab still opens. |

Validation is strict, like `app.json`'s: an unknown key, a wrong type, a command with a line break or an invisible character is an error, each reported by its key (`lab check` prints them). A file with a problem gives no buttons and the Code app shows the problem.

A repository without the file still opens from a lab link; it has no buttons.

## Run, Test and Submit

When the folder open in the Code app has the config (its own, or the one at the top of its repository), a bar above the editor has the buttons the config provides.

- **Run** and **Test** save every edited file, then type the command in a Terminal in the lab's folder: the Terminal the lab link opened if it is at a prompt, else a new one. A Terminal that is still running something is not interrupted; the bar says so.
- **Submit** saves, then does `git add -A`, `git commit -m "Submit <date>"` and `git push origin <branch>` with the built-in git, and says the result in the bar:
  - `Submitted. 2 changed files went to github.com/OWNER/REPO, branch main. The newest commit there is abc1234.`
  - `Nothing to submit. GitHub already has this work (…).`
  - `Not submitted. 2 changed files are committed on this computer only. …` followed by the reason: not signed in, the account refused, GitHub has commits this computer does not (pull first), GitHub not reachable, or git's own last line.

`lab run`, `lab test`, `lab submit` and `lab status` do the same from a terminal, also in the terminal UI, where the Code app has no bar.

## Not saved to GitHub yet

A Code window on a clone of a GitHub repository (with or without the config) shows whether GitHub has the work: "Saved to GitHub" or "Not saved to GitHub yet" at the right of its status bar (hover for what is missing: changed files, commits not pushed, files with edits not saved), the same words in the window's title, and a dot before the tab's title. The state is read from the repository when the filesystem reports a change in it; nothing polls.

While a window on a lab folder (one with `.tabcomputer/lab.json`) has work GitHub does not have, the browser asks before the tab closes or reloads. A clone without a lab config shows the mark and the browser does not ask. A repository whose origin is not on github.com gets neither the mark nor the question.

Not built: automatic commits to a backup branch.

## Classroom tools that are gh extensions

Classroom tools ship as extensions of `gh` (Classroom 50's `gh student accept` and `gh student submit`). `gh extension install OWNER/REPO` installs one, `gh extension list`, `upgrade` and `remove` manage them, and `gh NAME ...` runs it (`src/commands/gh-extension.ts`, tabcomputer#127). As in upstream gh, the repository is named `gh-NAME` and lands in `~/.local/share/gh/extensions/gh-NAME`.

- An extension whose latest release carries builds is installed from the `linux-amd64` asset and runs in the x86-64 emulator. A release with builds for other systems only is refused in one line that names them.
- Otherwise the repository has to hold an executable named `gh-NAME`: it is cloned and runs as it is (a shell script runs in the tab's shell).
- Either runs with `GH_TOKEN` set to the tab's GitHub sign-in. An extension written in Go finds the token there, and makes its own connections to `api.github.com` through the TCP relay.

Checked against github.com on 2026-10-13, read-only and signed in to nothing (`node tests/browser/gh-extension.mjs URL --real`, a local build, headless Chrome):

| Extension | Kind | Install | Then |
| --- | --- | --- | --- |
| `HaywardMorihara/gh-tidy` | a bash script, cloned | 1.2 s | `gh tidy --help` prints its usage |
| `seachicken/gh-poi` v0.18.4 | Go, 2.9 MB | 0.5 s | `gh poi --help` in 0.1 s |
| `foundation50/gh-student` v1.58.0 (Classroom 50) | Go, 9.8 MB | 1.5 s | `gh student --help`, `accept --help` and `submit --help` in 0.2 s each |

In a tab that is not signed in, `gh student accept cs50 cs50-fall-2026 hello`, `gh student submit` and `gh student whoami` each stop at "not signed in to github.com; run `gh student login`", and at a terminal the tab then offers its own GitHub sign-in. With a token GitHub does not know, `gh student whoami` answers `GET /user: HTTP 401: Bad credentials` in 0.7 s in both network modes: the program reached api.github.com through the relay, with its own TLS. Nothing was tried with a real account: `gh student login`, accepting an assignment and submitting are not verified.

Tests: `tests/tests/shiro-vitest/gh-extension.test.ts` (an in-memory GitHub), `tests/browser/gh-extension.mjs` (a stand-in GitHub and a real x86-64 program as the release asset; `--real` installs public extensions from github.com, read-only).

## Sign-out for a shared computer

Settings, Accounts, "Sign out of this computer", or `signout` in a terminal (`signout --yes` to go through with it).

The confirm lists what will be deleted: the sign-ins that are present (GitHub, Claude, API keys, other saved logins, by name and never by value; the list is `src/credentials.ts`) and every file of the tab computer. It names each clone under the home folder whose work GitHub does not have, and says to submit or push first.

Then the sign-ins are removed at once (the localStorage entries and the credential files), and the tab loads a page that deletes everything else this site stores in the browser (the filesystem, caches, settings) before it opens any of it, and says "This computer is signed out". If another tab of the site is still open, the page says what it could not delete; reloading it tries again.

What it cannot do: revoke the token at GitHub (github.com, Settings, Applications does that), or delete guests, which are other origins.
