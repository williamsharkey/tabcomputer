# tabcomputer docs

Start with the [README](../README.md). Contributors and coding agents: [AGENTS.md](../AGENTS.md).

## Using it

| Doc | What it covers |
| --- | --- |
| [DESKTOP.md](DESKTOP.md) | The desktop: windows, dock, keyboard, phone layout, the window manager API, `/dom` |
| [PACKAGES.md](PACKAGES.md) | `pkg`/`apt` before Debian mode: tabcomputer's 72 prebuilt WASM and static x86-64 programs (full list in the README's appendix) |
| [DEBIAN.md](DEBIAN.md) | Debian mode: the streamed root filesystem, apt and dpkg in Blink, the overlay of builtins |
| [GUI.md](GUI.md) | Linux GUI apps over X11: the X server in the page, `gui`, what runs and how fast |
| [NETWORKING.md](NETWORKING.md) | Kernel sockets, the WebSocket-to-TCP relay, its security model and how to run it |
| [DATA_FLOW.md](DATA_FLOW.md) | Where files, sign-ins and traffic go: what stays in the tab, what the server can read on each path, guests, using your own relay or server |
| [BROWSER.md](BROWSER.md) | The Browser app (research spike): browse origins, the broker, TLS in the page |
| [POSTGRES.md](POSTGRES.md) | PostgreSQL in the tab: the server on `localhost:5432` that starts on the first connection (PGlite), `psql`, `createdb`, `pg_dump`, node and Python programs, the data directory, the measurements, what it does not do, and Debian's own PostgreSQL |
| [RUN_LINKS.md](RUN_LINKS.md) | Run links: `?run=<recipe>`, `?run=gh:owner/repo`, the trust rules, the recipe format, the README badge |
| [CLASSROOM.md](CLASSROOM.md) | The classroom workspace: lab links (`?run=lab:owner/repo`), `.tabcomputer/lab.json`, Run / Test / Submit in the Code app, "Not saved to GitHub yet", sign-out for a shared computer |
| [NOTEBOOK.md](NOTEBOOK.md) | The Notebook app: Jupyter notebooks (.ipynb) opened, run and saved on the desktop, `jupyter notebook`, what runs the cells, the file format, what is not Jupyter, and why not JupyterLite |
| [SCHOOL_IT.md](SCHOOL_IT.md) | For a school's IT: what the tab connects to, the hosts to allow, that nothing is installed, private network mode, shared computers |
| [APPS.md](APPS.md) | Apps: the `app.json` manifest, the `app` command and its templates, the supervised backend, `tab.js`, app origins and what is confined, `?app=` links, the apps the site ships and their dock entries, `app share` |
| [PROFILES.md](PROFILES.md) | Product profiles (`tabcomputer`, `shiro`), the engine/product boundary, the rename |
| [RELEASES.md](RELEASES.md) | Each build shipped to tabcomputer.com: its commit, date and what changed |

## Scoreboards (measured)

These record measurements. Each says how it was produced; rerun the tool to update it.

| Doc | Measures | Produced by |
| --- | --- | --- |
| [DEBIAN_SCORE.md](DEBIAN_SCORE.md) | Debian popcon top 2000: install + smoke test | `npm run debian-score` |
| [CONFORMANCE.md](CONFORMANCE.md) | Shell specs, busybox, LTP and Open POSIX under Blink, wasi-testsuite | `npm run conformance` |
| [COMPAT.md](COMPAT.md) | Popular tools, languages, agent CLIs, GUI apps, developer workflows | per-section smoke tests in `tests/` |
| [GUI_SCORE.md](GUI_SCORE.md) | 29 Debian GUI apps: install, window, render, input, DOM text | `npm run gui-score` |
| [GUI_LAUNCH.md](GUI_LAUNCH.md) | Click to usable window for 13 GUI apps (cold, warm, after a reload), where the time goes, what was changed | `tests/browser/gui-launch-bench.mjs`, `scripts/gui/launch-profile.mjs` |
| [WEB_SCORE.md](WEB_SCORE.md) | The Browser app against real sites | `tests/browser/web-score.mjs` |
| [BENCHMARKS.md](BENCHMARKS.md) | Speed and memory baselines, round by round | `npm run bench` ([bench/README.md](../bench/README.md)) |

## Internals

| Doc | What it covers |
| --- | --- |
| [KERNEL_ABI.md](KERNEL_ABI.md) | The kernel's syscall contract, with a changelog |
| [HOTSWAP.md](HOTSWAP.md) | Developing tabcomputer from inside tabcomputer: `hotswap` swaps core code into a running tab |
| [DEVELOP_IN_TAB.md](DEVELOP_IN_TAB.md) | Walkthrough: fix tabcomputer from a tab, test it there, push a branch, report it |
| [X86_ENGINES.md](X86_ENGINES.md) | Why Blink, its patches (fork, signals, the wasm JIT, SSE4, `/proc/self/maps`), speed |
| [UNIX_COMPAT.md](UNIX_COMPAT.md) | The plan toward full Unix compatibility, phase by phase (written 2026-10-07) |
| [DOM-RENDERING.md](DOM-RENDERING.md) | Design note: X11 and GTK text as DOM text |
| [CLAUDE_VM.md](CLAUDE_VM.md) | Native Claude Code's embedded bundle (Bun's `.bun` section), the Bun APIs it uses, and `claude --vm` |

## Research and drafts

- [research/AGENT-EXPERIMENTS.md](research/AGENT-EXPERIMENTS.md): coding-agent workflows inside tabcomputer, and the limits they hit (2026-10-09).
- [research/DEV-TOOLS.md](research/DEV-TOOLS.md): developer tools tested in tabcomputer.
- [research/GDB.md](research/GDB.md): how gdb debugs programs here (a debug agent in the x86 engine and the remote protocol, not ptrace), what works and what remains.
- [research/GUEST_PROFILE.md](research/GUEST_PROFILE.md): guests, a clean tabcomputer on its own origin for untrusted work: threat model, design, what is built.
- [research/SANDBOXES.md](research/SANDBOXES.md): code sandboxes compared, and what tabcomputer offers.
- [research/TLS_IN_TAB.md](research/TLS_IN_TAB.md): a design note: why the model, GitHub and git proxies end TLS at the server, and what it would take to do TLS in the tab over the relay instead (not implemented).
- [research/APP_AUTHORING.md](research/APP_AUTHORING.md): the Studio and the Code app's app mode compared on the three example apps made from nothing, at a desk and on a phone; which to lead with.
- [research/APP_MAKER.md](research/APP_MAKER.md): one app built in user space (`serve`, `become`, a node backend) and hardwired, measured; the gaps, and the app layer it proposed, built since as [APPS.md](APPS.md) and re-measured (2026-10-12).
- [research/GUI_SNAPSHOTS.md](research/GUI_SNAPSHOTS.md): snapshots of started GUI apps (a process's image, its descriptors and its X client restored in a later page load): the design, what is built behind a setting, measurements, open problems (2026-10-12).
- [research/JAVA_SPEED.md](research/JAVA_SPEED.md): Java: where `javac`'s minute went, why JVM flags crashed (#122), the routes measured (JVM options, a warm compiler, ECJ, the Zero VM), what shipped, and the WebAssembly routes assessed (2026-10-13).
- [research/BLINK_MISCOMPUTE.md](research/BLINK_MISCOMPUTE.md): x86 instructions the emulator computed wrongly (#150: tesseract lost text lines to an x87 `fsubp`), the eleven faults found by checking every x87 form and 378 SSE forms against Rosetta, the check of tesseract, ImageMagick, numpy and Ghostscript against the Mac's own, and what still differs from an x86 (2026-10-13).
- [research/BLINK_RWX_JIT.md](research/BLINK_RWX_JIT.md): the x86 engine's JIT compiling the code other JITs generate (HotSpot, V8): why it didn't, the write tracking that makes it safe, the fixtures, the measurements, and what remains (2026-10-13).
- [research/PYTHON_NATIVE_WHEELS.md](research/PYTHON_NATIVE_WHEELS.md): compiled Python packages on the built-in Python (#125): why it can't load extensions, what `pip` installs from sdists instead, why Pyodide's wheels don't fit, and the plan for numpy (not built; 2026-10-12).
- [research/PACKAGE_LAYERS.md](research/PACKAGE_LAYERS.md): where `apt install`'s minute goes in the tab, and the layers built on request that replace it (#135): the profile, the two designs compared, limits on the server, what was measured and what was not run (2026-10-13).
- [research/BUILDER_CONFINEMENT.md](research/BUILDER_CONFINEMENT.md): a proposal, not applied: the systemd properties and script changes that would confine the package set builder further, and how to try them on the droplet first.
- [research/OPPORTUNITIES.md](research/OPPORTUNITIES.md): things people can't easily do without installing software, checked in tabcomputer.
- [upstream/vim-inchar-negative-wait.md](upstream/vim-inchar-negative-wait.md): a vim fix drafted for upstream.
