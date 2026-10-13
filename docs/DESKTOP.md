# Desktop, window manager API, and /dom

tabcomputer boots to a desktop: a menu bar, a dock, and windows. The
Terminal (the real tabcomputer terminal on a pty) opens front and center. The
full-page terminal (the `shiro` profile's UI) is still there with
`?ui=terminal`.

- Code: `src/desktop/` (window manager `wm.ts`, shell `index.ts`, Terminal
  `terminal-app.ts`, network sheet `network.ts`, lazy apps in `apps/`, the
  phone layout `phone.ts`), `src/dom-fs.ts` (/dom), `src/net-signin.ts`
  (sign-in hook), `src/ui-mode.ts`, `src/phone-rule.ts`.
- On a phone the same desktop has a second layout, a home screen of apps with
  one app on the whole screen: "Phone layout" below.
- Screenshots (1440×900, and phone width at 390 px):

  | | |
  |---|---|
  | ![first visit, dark](screenshots/desktop-dark.png) | ![light: cowsay just installed, Files](screenshots/desktop-light.png) |
  | ![htop (x86-64, Blink) from the dock, next to Activity](screenshots/apps-dark.png) | ![driving windows through /dom](screenshots/dom-dark.png) |
  | ![the network sign-in sheet](screenshots/signin-sheet.png) | ![phone width](screenshots/phone-dark.png) ![phone width, light](screenshots/phone-light.png) |

## Changelog (API)

All changes are additive. Nothing below renames or removes an earlier name.

- **2026-10-13 (unix/phone-layout), v1.7.** `MenuItem.phone` (`false`: the
  command is left out of the phone layout's menu sheet; the desktop sets it on
  the Window menu's moving and tiling). On the window manager, for the desktop
  shell and display servers to read: `phone` (the phone layout is on; it
  implies `compact`, a window then has no title bar and `geometry()` counts
  none) and the exported `phoneSurfaceSize(workArea)`, the size a `surface`
  window gets there. Nothing changes while `phone` is false.

- **2026-10-12 (unix/app-toolkit), v1.6.** Optional `unregisterApp(id)` on
  `DesktopAPI`: an app leaves the dock and the app list (an uninstalled app;
  check for it before calling). Installed apps (docs/APPS.md) register under
  their manifest's id with `order` 40, and their windows carry that id as
  `appId`. `?unbecome` now returns to the desktop on that load (it was the
  terminal UI until the next one).

- **2026-10-12 (unix/launch-feedback), v1.5.** `WindowOptions.behind` (open
  below the other windows) and `WindowOptions.splash` (a start-up splash
  screen: it doesn't end its app's launch); optional `launches` on
  `DesktopAPI`, the launches in progress (`LaunchTracker`,
  `src/desktop/launch-state.ts`; see "Launch feedback"). `openApp` on an app
  that is still starting starts nothing and returns its placeholder window
  (or `null`).

- **2026-10-09 (unix/desktop), v1.4.** `DockGroup.loose`: members that keep
  their own dock tile while the rest of the group is stacked (not on a
  crowded phone dock). Groups `developer` and `agents` (below).
- **2026-10-09 (unix/desktop), v1.3.** `AppDescriptor.glyph`: the app's
  glyph for the icon sets other than Classic (24-unit SVG path data, round
  strokes; see "Icon sets"). Optional: without it an app gets a built-in
  glyph if it has one, else a monogram.
- **2026-10-09 (unix/desktop), v1.2.** Dock stacks: `AppDescriptor.group`,
  `DockGroup` (`{ id, name, order?, collapse?: 'always' | 'auto', maxLoose? }`),
  and optional `registerGroup(group)` / `groups()` on `DesktopAPI` (check
  for them before calling, as with any addition). Apps with `order` ≥ 60 and
  no `group` go in the `debian` stack.
- **2026-10-09 (unix/desktop), v1.1.** Quarters: `WindowState` gains
  `'snapped-top-left' | 'snapped-top-right' | 'snapped-bottom-left' |
  'snapped-bottom-right'` (every snapped state still starts with `snapped-`),
  and `snap()` takes `SnapSide` (`'left' | 'right' | 'top-left' | 'top-right' |
  'bottom-left' | 'bottom-right'`). `snapZone(px, py, w, h)` is exported.
- **2026-10-09 (unix/desktop), v1.** First version: `DesktopAPI`,
  `DesktopWindow`, `Surface`, content kinds `dom`, `iframe`, `terminal`,
  `surface`, apps, desktop events, `/dom`, `requireNetworkSignIn`.

## Name

The Unix edition is **tabcomputer** (tabcomputer.com). The name, domain, tagline
and description are the tabcomputer profile's `brand`
(`profiles/tabcomputer/profile.json`, [PROFILES.md](PROFILES.md)): the desktop
reads it (`src/brand.ts`: tab title, wallpaper wordmark, welcome banner, About),
and `server.mjs` (`brandAppShell`) gives the shared `index.html` that title plus
description and Open Graph tags for every host whose profile has a brand (not
shiro.computer), since link previews don't run JS.

## Choosing the UI

`uiMode()` (src/ui-mode.ts):

| condition | UI |
|---|---|
| `?ui=desktop` / `?ui=terminal` | that one, remembered in localStorage `tabcomputer-ui` |
| `?ui=phone` | the desktop (remembered as such), in its phone layout whatever the screen; `?ui=desktop` likewise forces the windowed layout ("Phone layout") |
| `?demo=1`, embedded in another page (seeds), app ("become") mode (not on the `?unbecome` load that leaves it) | terminal |
| saved `tabcomputer-ui` | that one |
| host `shiro.computer` or `*.shiro.computer` | terminal |
| anything else (tabcomputer.com, localhost) | desktop |

From a shell: `desktop` switches to the desktop and `desktop classic` switches
back. System menu → Classic Terminal does the same. Both modes keep
`window.__tabcomputer.terminal`. On the desktop, that terminal is the first
Terminal window's first tab. Closing that tab parks the terminal (it is not
destroyed), and the next Terminal window adopts it again.

## Using it

- **Windows** have traffic lights (close, minimize, zoom). Drag a window by its
  title bar. Drag it to the left or right edge to tile it, or to the top edge
  to maximize. Double-click the title bar to zoom. Drag any edge or corner to
  resize.
- **The dock** shows Terminal, Files, Browser, Settings and Activity, then terminal
  programs: Vim, htop and Python, plus Neovim, Emacs, nano, tmux, Lua and
  SQLite once they are installed. A program that is not installed has a ↓
  badge; clicking it runs `apt install NAME && NAME` in a new Terminal
  window. A dot under an icon marks a running app; a larger, pulsing dot
  one that is starting ("Launch feedback" below). Right-click an icon to
  list its windows, open a new window, or close it.
- **Browser** (docs/BROWSER.md): tabs, address bar, back/forward/reload,
  history, bookmarks and saved passwords, showing real sites on per-site
  browse origins with TLS done in the page. "Open in real tab" (and a banner
  for passkeys, Google sign-in and TLS 1.2-only sites) hands a page to the
  host browser. `desktop open browser` / `openApp('browser', { url })`.
- **Keyboard.** The browser keeps Ctrl/Cmd+N, T and W for itself, so desktop
  shortcuts use Alt+Shift. Terminal programs rarely use that combination.

  | keys | action |
  |---|---|
  | Alt+Shift+Enter | new Terminal window |
  | Alt+Shift+T | new tab (in a Terminal window) |
  | Alt+Shift+W | close window |
  | Alt+Shift+M | minimize |
  | Alt+Shift+↑ / ↓ | zoom / restore (or minimize) |
  | Alt+Shift+← / → | tile left / right |
  | Alt+\` (Alt+Shift+\`) | cycle windows |
  | Ctrl+Alt+U / I / J / K | top-left / top-right / bottom-left / bottom-right quarter |
  | Ctrl+Space (Cmd+Space, Alt+Shift+Space) | search: apps, commands, recent commands, files |
  | Alt+Shift+F / Alt+Shift+, | Files / Settings |
  | Cmd+N / Cmd+W / Cmd+\` | new terminal / close / cycle, when the browser passes them on (installed app, fullscreen) |

- **Snapping**: drag a title bar to the left/right edge for a half, to an
  edge within 64 px of a corner for that quarter, to the top for maximized.
- **Search** (Ctrl+Space or the magnifier in the menu bar, `spotlight.ts`,
  loaded on first use): fuzzy matching over apps, builtins and programs on
  PATH, the last 200 lines of `~/.bash_history`, and up to 3000 files under
  `/home/user` (4 levels, skipping `node_modules`, `.git`, caches). Enter
  opens an app or file, or runs the command in a new Terminal window; the
  last entry always runs what you typed. Ctrl+Space no longer reaches the
  terminal (Ctrl+@ still sends NUL, e.g. for Emacs' set-mark).
- **Session restore on reload** (`session.ts`, on by default; Settings →
  Appearance "Restore session on reload"). Windows come back where they
  were, maximized/snapped/minimized as they were, in their stacking order
  (the main terminal included), and the window that had the focus gets it
  back.
  - Terminal windows: every tab with its working directory, the exported
    variables it changed (secrets never stored), a program's title and its
    last 2000 lines of scrollback, then a dim "— restored after reload —".
    A line still running at the reload is typed on the prompt, not run,
    under that one note: as it was when short, else as `source
    /tmp/restore-N.sh` (the script holds the line, `cat` shows it), and
    `claude --continue` for a claude whose session wasn't found. Known-safe servers (`RESTARTABLE`: `serve`,
    `npm run dev`, `vite`, `python -m http.server`) start again, and Claude
    Code or Codex resume their own session (`agent-resume.ts`).
  - Files (its folder), Settings (its pane), Activity, About.
  - Windows a command opened run that command again in its directory:
    mdview, html, img, finder, Code, Monaco, a Preview (`serve open`), and a
    Debian GUI app's main window (`gui APP`, once per app).
  - Saved small in localStorage `tabcomputer-desktop-session` (on window
    changes, every 3 s while terminals print, at pagehide), scrollback in
    IndexedDB `tabcomputer-session`; never a blocking write. Restore runs
    after the first prompt. Not in safe mode, and not after a load that froze
    (the watchdog's wedge record; the main terminal says so), so a session
    that freezes on restore can't loop. `safe-mode reset-layout` forgets it.
- **New windows open inside the work area**: a window's whole frame starts
  between the menu bar and the top of the dock (moved up, then shrunk if it
  has to be), however the cascade or an asked-for position would place it.
- **First visit**: a welcome card in the corner (`welcome.ts`, Drafting
  style, not modal; in the phone layout a sheet from the bottom over Home,
  which a choice closes, so it is never a box over an app) with one-click demos that type their command into a
  Terminal: a Debian package (`apt install cowsay`), a Vite + React app
  (its Preview opens when the dev server is up), Python (`toolchain install
  python`), Claude Code, a Linux GUI app (the Apps window) and Settings.
  Dismissed once per browser (localStorage `tabcomputer-desktop-welcome`);
  after that the module isn't loaded. Help → Welcome shows it again. A visit
  whose address asked for an app (`?app=`) does not show it: the app is what
  was asked for, and the card waits for a visit without a link. It
  drags like a window, by any part that isn't a button. Its "How your data
  flows" button opens the window below.
- **How Your Data Flows** (`apps/dataflow.ts`, drawn from `src/data-flow.ts`;
  the facts are in [DATA_FLOW.md](DATA_FLOW.md)): three places (this tab,
  this site's server, the internet) and one lane per kind of traffic, each
  saying what the server can read of it. It shows this tab as it is: main
  profile or a guest and its mode, which sign-ins are present (never a
  value), which relay is in use, whether storage persists. Hovering,
  tapping or focusing a part explains it; below 640 px of window width the
  lanes stack. Also under System and Help, in Settings → Network, and as
  the `dataflow` command (the only form in the terminal UI). Tests:
  `data-flow.test.ts`, `tests/browser/data-flow.mjs`.
- **Code** (`code`, the CodeMirror editor in `src/commands/code-editor.ts`)
  opens as a desktop window of the Code app. While it's focused the menu
  bar says Code, and its File menu starts with Open… and Open Folder… (a
  path sheet, `codesheet.ts`, that runs `code PATH`). The first window
  shows a one-line hint (File ▸ Open…, Ctrl+S, the ☰ file list, Ctrl+F);
  there is no command palette. In the classic terminal UI it keeps its
  floating server window. A folder with `.tabcomputer/lab.json` gets Run,
  Test and Submit above the editor, and a clone of a GitHub repository
  shows "Saved to GitHub" or "Not saved to GitHub yet" in the status bar and
  the window's title (`src/lab.ts`, [CLASSROOM.md](CLASSROOM.md)).
- **About This Computer** lists measured status with the document that
  records each number (`STATUS` in `apps/about.ts`: keep it in step with
  DEBIAN_SCORE.md and CONFORMANCE.md), and what is real, emulated and absent.

- **Themes**: light, dark, or match the system (View menu, the sun/moon icon
  in the menu bar, or Settings → Appearance). Saved in localStorage
  `tabcomputer-desktop-theme`. Terminals switch palettes with the theme.
- **Motion**: every animation and transition turns off under
  `prefers-reduced-motion: reduce`.
- **Phones** get the phone layout ("Phone layout" below). What follows in
  this item is the desktop's own compact mode, which a phone shows only when
  the desktop is forced (`?ui=desktop`, or Settings → Appearance → Layout:
  Desktop), and which a touched screen 600 to 640 px wide still gets
  (≤ 640 px wide, or a phone on its side: the screen's short side
  ≤ 500 px and the viewport ≤ 500 px tall; `compactViewport()` in `wm.ts`,
  which reads the screen so the on-screen keyboard doesn't flip it): every
  window fills the work area, Previews included. Menus collapse
  to the app name, the menu bar is solid (its color is the page's
  `theme-color`, set with the theme) and drops the clock. The network icon is
  a globe with a status dot: blue online, green signed in, amber sign-in
  needed, gray offline.
- **Tablets and narrow windows** (641–1024 px): ordinary windows, sized to
  fit the work area whatever size an app asks for; a Preview snaps beside
  the Terminal. The welcome sits above the dock and the extra-keys bar
  (`--sd-keybar-h`), in one column on phones, two on a phone on its side,
  and scrolls when it doesn't fit. `tests/browser/small-screens.mjs` checks
  phone, phone landscape, 600 px, iPad mini and iPad landscape: the page
  never scrolls sideways, and the menu bar, dock, windows, menus, stacks,
  notifications and the welcome stay inside the viewport
  (screenshots: `docs/screenshots/small-*.png`).
- **Touch devices** (`pointer: coarse`, `mobile.ts`, its own chunk): the
  desktop follows `visualViewport`, so when the on-screen keyboard opens the
  dock hides and windows shrink to the space above it, with the cursor line
  kept in view; the change crossfades over 0.3 s (instant with reduced
  motion). An extra-keys bar sits at the bottom: Esc, Tab, Ctrl, Alt, `|`,
  `~`, `` ` ``, arrows, paste, `/ - $ & ;`. Ctrl and Alt are one-shot and also
  apply to the next letter typed on the phone's keyboard. The keyboard button
  in the menu bar turns the bar on or off; Settings → Appearance → Extra keys
  picks Off, Auto (hidden while the phone's keyboard is open) or Always
  (localStorage `tabcomputer-keybar`). In every mode the bar shows only while
  the focused window holds a terminal: under an app's window its keys go
  nowhere. The classic UI keeps `src/mobile-input.ts`. The phone layout
  treats the keyboard differently: "Phone layout", "The keyboard".
- **Dock stacks**: when the dock would not fit (phones), Settings and
  Activity share a System stack and Vim, Python and installed programs a
  Programs stack; Terminal, Files and htop stay loose. Debian GUI apps stack
  once there are more than four, at any width. Tap a stack to open it.
- **Fonts** are self-hosted: Inter and JetBrains Mono (latin, variable,
  `public/fonts/`, SIL OFL, license files next to them). Only the desktop
  loads them.

## Phone layout

On a phone the desktop is a second layout (tabcomputer#154): **Home**, **one
app on the whole screen**, and **one control, the pill**. It replaces the
dock, the menu bar and the window frames, and nothing else: an open app is
still a window of the window manager (in its compact mode, every window the
size of the work area), with the content it has on a large screen. The desktop
on a large screen is the same as without it: the layout's code is a chunk of
its own (`phone.ts`, `phone.css`) that such a screen never loads.

- Code: `src/phone-rule.ts` (which screens), `src/desktop/phone-model.ts`
  (the rules that need no DOM: Home's pages, the pill's gestures, the menu
  sheet), `src/desktop/phone.ts` and `phone.css` (what is drawn),
  `src/desktop/mobile.ts` (the on-screen keyboard), a few lines in
  `index.ts` (the work area, switching) and `wm.ts` (`phone`).

**Which screens** (`phoneFor` in `src/phone-rule.ts`):

| screen | layout |
|---|---|
| the viewport is under 600 CSS px wide (a phone upright, a narrow browser window on a desktop) | phone |
| a touched screen (`pointer: coarse`) whose short side is under 500 px (a phone on its side) | phone |
| the short side is 600 px or more (a tablet, upright too; any large screen) | desktop |
| `?ui=phone` / `?ui=desktop` | that one, for the page that carries it |
| Settings → Appearance → Layout: Phone / Desktop (localStorage `tabcomputer-layout`) | that one, remembered |

It is decided at boot and again whenever the window's size changes (a
rotation, a desktop window dragged narrow): the layout switches at once, the
open apps stay open and the one in front stays in front. The short side is
the screen's, so a tablet does not become a phone while its keyboard is up.

- **Home.** App icons with their names, four across upright (more on a phone
  on its side), in pages that a sideways swipe turns, with dots under them.
  Page one: Terminal, Files, Code, Notebook, Browser, Python, Claude Code,
  Settings, Convert Old Files, then the installed apps (docs/APPS.md). Later
  pages: the rest in dock order, the dock's stacks as folders (Text Editors,
  Developer Tools, AI agents, and Linux apps, which holds every Debian GUI
  app, the ones not installed yet with the dock's ↓ badge). A folder opens
  over Home; a tap outside closes it. At the top, one status line (the network
  and the sign-in in words, the appearance button, the network button with its
  popover) and the search field, which opens the search (`spotlight.ts`). A
  dot before a name marks an open app. Holding an icon down gives a sheet:
  Open, Share as a Link… and Remove… for an installed app (Remove runs `app
  remove`), Info, and for any other app Remove from Home (it stays in the
  search; the pill's sheet on Home has Show All Apps on Home). There is no
  dock and no menu bar.
- **An app is the whole screen**: no title bar, window buttons, border or
  shadow. Its content reaches the screen's edges inside the safe areas
  (`env(safe-area-inset-*)`, read by `phone.ts`; the page has
  `viewport-fit=cover`) and ends above the pill's strip. The Browser's title
  bar holds its toolbar, so that bar stays, without the window buttons. The
  desktop's shared controls in an app (buttons, fields, sidebar rows, table
  rows) are 44 px high there, and the Code editor's file list starts closed.
- **The pill**: a small bar at the bottom centre, in an app and on Home.
  Tap: Home (on Home: its first page). Swipe up, or hold: the switcher.
  Swipe sideways: the next open app (leftwards) or the previous one, in the
  order they were opened. Two taps: the app's menus as a sheet from the
  bottom, a section each for File, Edit, View, Window, the app's own and
  Help, then the System menu's commands, without the ones that move and tile
  windows (`MenuItem.phone: false`) and without shortcuts. The visible bar is
  134 x 5 px in a strip 22 px high (18 on a phone on its side; taller over a
  home indicator, `pillStrip`); its target is 180 x 44 px, which reaches 22 px
  (26) above the strip into the middle of the app's bottom edge. A tap is
  answered after 280 ms, the wait for a second one.
- **The switcher**: the open apps as cards in a row, each the app's own
  window drawn smaller (so the picture is live), with the app's name above it
  and a turning mark when the app is busy (a command running in a terminal,
  an install or a launch in progress). Tap a card to open it, swipe it up to
  close it, tap beside the cards to go back.
- **Terminal.** The whole screen; text at 13 px, which is 49 columns on a
  393 px screen and 47 on 375. 13 px is the largest whole size with 48
  columns or more at 393 px (the desktop's 14 px gives 45 there); 12 px gives
  53, with text smaller than a phone's own small print. A pinch changes the size (8 to
  28 px, remembered in localStorage `tabcomputer-phone-font`). One finger
  scrolls the output. Two fingers tapped open another terminal (a tab of the
  same window: there is no tab bar, a line says "Terminal 2 of 2"); two
  fingers swiped sideways move between them. `exit` closes one.
- **The keyboard** (`mobile.ts`). The page keeps the height it has without the
  on-screen keyboard, so a terminal keeps its rows and columns when the
  keyboard opens (tabcomputer#146: nothing running in it sees a resize). The
  windows move up just far enough that the cursor's line is above the
  keyboard, and follow it as output arrives. The key row is one row on top of
  the keyboard that scrolls sideways (esc, tab, ctrl, alt, the arrows, then
  `| ~ / - $ & ;`, the backquote and paste), there only while the keyboard
  is up and a terminal is in front; ctrl and alt latch for one key. An app
  that is not a terminal ends at the keyboard instead, and a sheet stands on
  it. Where the keyboard is, is read from `visualViewport`.
- **Sheets, not windows.** A prompt comes from the bottom (the network and
  Claude sign-ins, Clone, Open…, every `.sd-sheet`) or is the whole screen
  (the Run and Install questions, `src/apps/surface.ts`; a starting app's
  placeholder; the share screen).
- **Linux GUI apps** were drawn for a large screen, so their windows keep
  one (1024 x 720 CSS px or the phone's own size where that is larger,
  `phoneSurfaceSize` in `wm.ts`; the display server is told the same). The
  window is shown whole across the phone's width; two fingers pan and pinch
  over it (up to three times its size), one finger is the app's pointer, and
  the app's dialogs and menus move with it. The first time each app opens, a
  line says so. A second finger landing lets go of the app's mouse button,
  which the app may take for a click where the first finger was.
- **A link to an app** opens as the app on the whole screen (after the
  install question where the link needs one), with the pill to leave it by
  and no bar back to the desktop; a reload comes back to the app. A tab that
  an earlier build's link turned into the app (`becomeApp` with `back`) opens
  the same way. Only the terminal UI on a phone, which has no desktop under
  it, still makes the tab the app with that bar.
- **At boot** it shows Home, with the main Terminal already open behind it;
  only a reload that left an installed app in front comes back to that app.

Measured by `tests/browser/phone-layout.mjs` in Chromium with a touch screen
(on a build served by `server.mjs` on the same machine):

| | 393 x 852 | 375 x 667 | 852 x 393 |
|---|---|---|---|
| the terminal's share of the screen's height | 830 px, 97.4% | 645 px, 96.7% | 375 px, 95.4% |
| columns x rows at 13 px | 49 x 43 | 47 x 33 | 108 x 19 |

One tap from a cold start to a running `python3` (Home's Python icon; it
installs python3 on the way). One gesture between two open apps (a sideways
swipe on the pill), or two by the switcher.

Not there, and not checked:

- No real phone was used. The on-screen keyboard cannot be raised in headless
  Chromium: the key row, the terminal's fixed size and the cursor following
  are checked with `visualViewport` made shorter by the test. iOS Safari and
  Android Chrome on real devices are tabcomputer#146.
- xterm sets 15 px aside for a scroll bar where the browser's scroll bars take
  no room (iOS); `phone.ts` widens the terminal by as much there
  (`sd-overlay-scroll`). Chromium's emulation has such scroll bars; a real
  iPhone was not tried.
- Linux GUI apps were checked with a canvas client standing in, not with a
  Debian app.
- Targets under 44 px that remain are in the apps' own pages, which the
  layout does not fork: the test lists the ones it can read.
- The other browser checks' phone-sized parts (`app-declarative.mjs`,
  `app-toolkit.mjs`, `launch-feedback.mjs` and others at 360 to 390 px) were
  written for the desktop on a phone; `small-screens.mjs` now asks for that
  desktop with `?ui=desktop`.
- Tests: `tests/tests/shiro-vitest/phone-layout.test.ts` (the rule, Home's
  pages, the pill's recogniser, the menu sheet, the window manager's part);
  `tests/browser/phone-layout.mjs` (the layout at 393 x 852, 375 x 667 and
  852 x 393, light and dark; the desktop at 1280 x 800 and on a tablet,
  where no part of it loads; `--baseline URL` compares the 1280 x 800
  desktop pixel for pixel with another build's; `--shots DIR`).

## Launch feedback

An app that was asked for and has no window yet is **starting**. The state
machine is `src/desktop/launch-state.ts` (no DOM; `wm.launches`):

```
requested → installing → starting → window → running
     └───────────┴──────────┴─────────┴──→ failed | cancelled
```

| stage | meaning | what is known |
|---|---|---|
| requested | asked for | nothing yet |
| installing | packages are fetched and unpacked | a real fraction (`InstallProgress.doneBytes / totalBytes`: a package counts half once fetched and decoded, half once written); none while triggers run or apt installs (Debian mode: apt's output lines instead) |
| starting | the process exists | its stdout and stderr, as lines |
| window | it reached the display: a client connected to Xshiro since it started, or its splash screen mapped | the same |
| running | its first window was created: the launch is over | |

Stages only move forward. Nothing has a time limit: a launch ends when a
window appears, the install fails, the process exits without a window, or
the person cancels. Who drives it: `wm.openApp` for any app whose `launch`
returns a promise (the lazily loaded built-in apps: asked for → its window;
an app that opens at once, like Terminal, is never tracked), and
`src/gui/launch.ts` (`startGuiApp`) for Debian GUI apps, which the dock, a
stack, the launcher, the Apps window's Open, `desktop open APP`,
`/dom/windows/ctl` and `gui APP` all reach. The window manager ends a launch
when a window with the app's id is created (`LaunchTracker.attach`): not an
override window, a dialog of another window, or a splash (`splash: true`,
from `_NET_WM_WINDOW_TYPE_SPLASH`), which moves it to `window`. A window can
come before the launcher has its process: an app restored from a snapshot
(docs/research/GUI_SNAPSHOTS.md, behind a setting) is on screen while its
process is still being rebuilt, and `startGuiApp` takes a launch that is
already `running` as started, not as cancelled.

- **Dock.** The app's tile gets a 6 px dot in the text color under it, with
  an accent ring that pulses outward (`.sd-starting`; the dot is on the
  dock, outside the tile, so it is the same in every icon set and theme).
  With reduced motion the ring is steady: a larger, ringed dot, unlike the
  4 px running dot. The tile is labelled "GIMP is starting"
  (`aria-busy`), and its tooltip says the stage. An app that isn't in the
  dock gets a tile while it starts; a stack's tile carries the mark for its
  member ("Debian apps (6): GIMP is starting"), as does the member's
  entry in the open stack. On a phone the dock scrolls to the tile. A
  launch that failed has a hollow amber dot and "GIMP did not start" until
  its placeholder is closed.
- **One launch at a time per app.** While an app is starting, another
  request for it (any of the ways above) starts nothing: its placeholder
  comes to the front, takes the focus and flashes; `gui APP` says "already
  starting" and exits 0. The same while a failed launch is still showing
  (the failure is what you get, not a silent second try; Retry is on it).
  Once the app's first window is up the app's own rule applies again, as
  before: Terminal and Files open another window, Settings and a dock click
  on a running GUI app focus it, and New Window or `gui APP` start another
  instance. The cost: two quick requests for a second Files window while
  its module is still loading (the first time only) open one.
- **Placeholder window** (`src/desktop/launch-ui.ts`, loaded with the first
  launch that asks for one: the Debian GUI apps). Reserved where the app's
  first window is likely to go: the geometry its main window had last
  (localStorage `tabcomputer-launch-geometry`, kept as the window moves),
  else a size from `SIZE_GUESS` in `src/gui/launch.ts` (guesses, not
  measurements; 800 × 560 for the rest), fitted to the work area and placed
  by the cascade. It opens behind the other windows without taking focus,
  after 250 ms (at once when installing), partly transparent, with the
  app's icon and name, the stage in words ("Installing 66 MB…", "Setting
  up…", "Starting…", "Opening window…"), a bar that is the real fraction or
  indeterminate (never a made-up number; a still striped track with reduced
  motion), the amount ("21 of 66 MB") or, from 10 s into starting, the time
  it has taken, the app's note ("first start takes a few minutes"), the
  newest output line and **Show details** (the last 80 lines, selectable).
  Its title bar repeats the stage with a thin progress line: that strip is
  what shows when another window covers its middle, and a guessed spot whose
  title bar would be hidden moves to the top of the work area. On a phone,
  where every window fills the screen, it opens in front instead.
- **Handing over.** When the app's first window is created it takes the
  placeholder's place in the same task, without its opening animation: the
  position always; the size when that was the app's own last size or the
  person resized the placeholder (a guess is never forced on the app, and a
  window that can't be resized keeps its size). The window comes to the
  front and takes the focus, as a new window does. A splash screen leaves
  the placeholder where it is.
- **Failure.** A failed install, or the process exiting before a window
  ("GIMP quit before opening a window (exit status 127)."): the placeholder
  comes to the front without taking the keyboard, with the error and the
  output selectable, **Close** and **Retry**. An exit with status 0 while
  the app already has a window (a single-instance app handing over) just
  focuses that window.
- **Cancel.** Closing the placeholder (or its Cancel) cancels, and a note
  says what that did. While installing: the app won't open, and the install
  finishes in the background, because stopping an unpack or apt half way
  would leave packages half installed; the app is then installed and opens
  without installing next time. While starting: the process and the
  processes it started get SIGTERM, then SIGKILL after 2 s; nothing of the
  app's can be unsaved before its first window.
- **Session restore.** A GUI app's saved window is reopened with `gui APP`,
  so it comes back the same way; its saved geometry is the placeholder's.
  An app that was still starting at the reload is not started again.
- Not covered: X programs started by hand (`xterm &`, a tool whose
  Terminal window runs `DISPLAY=:0 PROGRAM &`): no launch is recorded for
  them.
- Tests: `tests/tests/shiro-vitest/desktop-launch.test.ts` (the state
  machine, `openApp`, the launch path with a stand-in installer and
  process, the placeholder); `tests/browser/launch-feedback.mjs` (the same
  stand-in in Chromium, from the dock and the `gui` command down: marks,
  double requests, hand-over, failure, cancel, reduced motion, session
  restore, 360 px; `--shots DIR`); `tests/browser/small-screens.mjs`
  (the placeholder on every small screen).

## Previews

A server running in this tab (in-page node, a node worker, an emulated
program such as `python3 -m http.server`, `serve`) is shown in a **Preview**
window (`src/desktop/preview.ts`): a real document at
`/__preview/<tab>/<port>/` served by the preview service worker
(`src/preview-sw-host.ts`, so ES modules and Vite's HMR work), or a srcdoc
copy where service workers aren't available. One window per port, tiled
right with the Terminal on the left; its toolbar reloads, shows the address
and opens it in a browser tab.

- `serve open PORT [PATH]` and `serve PORT --split` open (or focus and
  navigate) it.
- A server that starts listening by itself (`node server.js`, express,
  `npm run dev`, any port that stays up a second) gets a notification with
  **Open Preview** instead of a window popping up; the notification goes when
  a preview opens or the server stops.
- When the server stops, the window says so; it reloads when a server
  listens on that port again.
- The hook: `setPreviewUI({ open, listening })` (`src/preview-ui.ts`), set by
  the desktop; without it the classic layout's split pane and floating
  windows are used. `iframeServer.onPortChange(cb)` reports ports going up
  and down.
- Tests: `tests/browser/previews.mjs` (serve open, stop and restart, the
  offer) and `tests/browser/vite-react.mjs` (Vite + React with HMR).

## Developer tools

Three dock stacks from the research in `docs/research/DEV-TOOLS.md` (catalog:
`src/desktop/devtools.ts`), each always one stack (`collapse: 'always'`, no
loose members), after htop and Python:

| stack | members |
|---|---|
| Text Editors | nano, Vim, Neovim, Emacs, Code (the CodeMirror window), Geany |
| Developer Tools | Git, tmux |
| AI agents | Claude Code, Gemini CLI, Codex, Grok, Antigravity (`agy`), aider |

Apps with a logo have a glyph drawn after it (`iconsets.ts`), on every icon
set's grid. A stack that doesn't fit above the dock (a phone on its side) gets
more columns, then scrolls.

A tool that isn't installed has a ↓ badge whose tooltip gives its install
time. The first click opens its Terminal window, which says what it installs
and how long that usually takes (`pkg install vim`, about 2 s; Geany and
aider go through Debian mode and take minutes), runs the install with its
progress, then starts the program; the tile has a spinning ring until the
executable appears. Later clicks just run it. The launch script checks PATH
itself (`command -v`), so a tool installed from the shell counts too. Agents
say first what they need (an API key or a sign-in); Codex runs with
`--sandbox danger-full-access` (no bubblewrap here).

## Git

- **Clone…** (Files' toolbar, File → Clone Repository…, Clone from URL… in the Git app's home): owner/repo
  or a GitHub URL into `~/src/OWNER/REPO`, in a Terminal window
  (`src/desktop/gitsheets.ts`). Signed in to GitHub, real git (installed
  with `pkg install git` on first use) makes a partial clone
  (`--filter=blob:none`) over the relay; the sign-in reaches git through the
  environment (`GIT_CONFIG_*` from `$GITHUB_TOKEN`), never the command line
  or `.git/config`. Not signed in, the builtin git makes a shallow clone of
  a public repository.
- **Branch folders**: New Branch Folder… (Files, inside a repository; the
  Git app's branch menu) runs `git worktree add ~/src/OWNER/REPO@BRANCH`
  (`-b` for a new branch; slashes in the name become dashes in the folder),
  one folder per branch, so parallel agents each get their own.
- **Badges in Files** (`src/desktop/gitstatus.ts`): inside a repository the
  toolbar shows the branch and ↑ahead/↓behind its `origin/BRANCH` (click: the
  Git app); entries get M, A, D or U (untracked), folders M when something
  inside changed; repository folders in a listing get their branch tag. It
  reads the repository with isomorphic-git, only for the folder on screen,
  and recomputes when the filesystem reports a change in the repository
  (debounced): nothing polls. Branch folders (worktrees) show their branch
  only.
- **The Git app's home** (`src/desktop/githome-ui.ts`, data and rows in
  `src/desktop/github-home.ts`): opened without a repository (dock, menu,
  spotlight) or with the ‹ Home button of a repository's toolbar, it never
  asks you to type anything first.
  - Signed out: **Sign in with GitHub** runs the device flow in place (the
    code, Copy Code, Open GitHub, then polling) and switches to the signed-in
    home without a reload. The token is the network sign-in's
    (`tabcomputer_github_token`), so git and gh use it too, and the git
    identity is filled in as `gh auth login` does.
  - Signed in: avatar and login; **Your repositories** (`GET /user/repos?sort=pushed`,
    50 a page, Show More) with owner/name, Private/Fork badges, description,
    language, stars and last push, a filter box, All/Public/Private and sort
    by last push, name or stars. A repository already on this computer
    (matched by its `origin` URL) has **Open** (and Files); any other has
    **Clone**, which clones with one click into `~/src/NAME` (`~/src/OWNER/NAME`
    when that's taken) in a shell of its own with the sign-in in its
    environment (`cloneScript`, so private repositories work), shows git's
    progress line in the row, then opens the repository; a failed clone
    says why and offers the same command in a Terminal. **Notifications**
    (`GET /notifications?all=true`, unread first; a click opens the issue or
    pull request on github.com in a new tab and marks it read), **Your pull
    requests** and **Assigned to you** (`/search/issues`, open ones).
  - Always: **On this computer**, the repositories in `~/src/*`,
    `~/src/*/*`, `~/*` and the recently opened ones (localStorage
    `tabcomputer_git_recent`), with branch and changed-file count; New
    Repository… and Clone from URL… (the sheet above) as secondary actions.
  - It calls api.github.com directly (CORS allows `Authorization: Bearer`),
    falling back to the same-origin `/api/github` proxy when that request
    can't be made. The lists are cached in localStorage
    (`tabcomputer_git_home`, tagged with a hash of the token, never the
    token) for an instant first paint and refreshed in the background;
    placeholder rows keep the layout still while loading. A 401 signs out
    with "Your GitHub sign-in has expired or was revoked"; a rate limit (with
    its reset time) or no connection keeps the lists on screen with a
    notice and Try again. All windows share one model, and signing in or
    out anywhere else (the network sheet, another tab) shows at once.
- **New Repository…** (Git's home, Files' Repositories): a name, `git init`
  in `~/src/NAME` on `main`, optionally a README and first commit (the
  author from `~/.gitconfig`), and signed in, the same repository created on
  GitHub (`POST /user/repos`, Private or Public) and set as `origin`; Push
  from the Git app publishes it.
- **The Git app** (`src/desktop/apps/git.ts`): staged, changed and untracked
  files with stage/unstage (one or all), the selected file's diff against the
  last commit, commit (staged files, or everything with "Stage All &
  Commit"; the author from git config), branches (switch, new, new branch
  folder) and the log. Pull and Push open a Terminal running git there. For
  a branch folder it offers a Terminal and the main folder.
- **Files' Repositories** (`~/src`, the Places item): always opens, making
  `~/src` if it isn't there yet. Above the listing: New Repository…, Clone
  from URL…, and your GitHub repositories (the same picker as Git's home,
  eight at a time; Sign in with GitHub when signed out; Hide GitHub
  collapses it). In Files, **Open** goes into the repository's folder and
  **Git** opens it in the Git app; a finished clone opens its folder. The
  listing below keeps its branch tags. A folder Files can't open shows the
  error in place of the listing (Back returns).
- `tests/browser/git-home.mjs` checks all of this against a stubbed
  api.github.com and device flow (signed out, the code, signed in, filter,
  Open and Home, Files' Repositories on a fresh computer, a 401, 360 px wide);
  `--shots DIR` saves the pictures. Unit tests:
  `tests/tests/shiro-vitest/desktop-githome.test.ts`.
- `tests/browser/dev-tools.mjs` checks the dock, the first install (Vim),
  badges, stage and commit, and a branch folder; `--shots` writes
  docs/screenshots/dev-*.png. Unit tests:
  `tests/tests/shiro-vitest/desktop-devtools.test.ts`.

## Accounts

Settings → Accounts (and the Accounts part of the menu bar's network
popover) lists the two accounts this computer signs in with, each with its
state and Sign In… / Sign Out… (`src/desktop/accounts.ts`):

- **GitHub**: the network sign-in (device flow, "Network sign-in" below);
  `git` and `gh` use it too.
- **Claude**: Claude Code's account. The state comes from Claude Code's own
  files, `~/.claude/.credentials.json` (signed in, and the plan when it is
  recorded) and `~/.claude.json` (the email); tokens are never shown. Sign
  In… opens a sheet: open the sign-in page, paste the code it shows
  (`src/claude-signin.ts` runs the OAuth PKCE exchange and writes
  `~/.claude/.credentials.json`, which both Claude Code builds read). Sign
  Out… asks in place, then removes that file. Signing in from the terminal
  (`claude`'s own /login) shows up here as it happens.

`openClaudeSignIn()` shows the desktop's sheet while the desktop runs
(`setClaudeSignInUI` in `src/claude-signin-ui.ts`), else a floating panel
in the same style. Screenshots: docs/screenshots/accounts-*.png,
claude-signin-sheet-*.png, claude-signin-panel-*.png.

## Icon sets

The dock, its stacks, the launcher and Settings draw app icons from one icon
set (`src/desktop/iconsets.ts`; design: `docs/design/dock-icon-studies.html`).
Every set draws the same glyphs, one geometry on a
24-unit grid with round strokes, so the apps belong together; a set changes
only the material. Settings → Dock & Icons picks one (localStorage
`tabcomputer-desktop-iconset`; a grid of cards, each a still mini dock).

| set | kind | |
|---|---|---|
| Drafting (default) | static | graphite on vellum / chalk on slate, construction lines, SVG wobble filter |
| Classic | static | the colorful tiles of `icons.ts` (each app's `icon`) |
| Vaporwave, Aurora field, Soft clay, Swiss line, Neo-brutalist, Risograph, One-bit, E-ink paper | static | SVG and CSS (`iconsets.css`); One-bit rasterizes each glyph to 16×16 once |
| Pearl, Holo foil | live | the mockup's fragment shader (`iconset-gl.ts`) |
| Liquid glass | live | three.js transmission (`iconset-glass.ts`, three.js in its own chunk) |

- **Glyphs**: every app the desktop knows has one, including the Debian GUI
  apps (mapped onto what they are: GIMP → paint, Mousepad → editor…).
  Others bring `AppDescriptor.glyph` or get a monogram in the set's style.
- **Swapping changes no layout.** Every set's tile (`.sd-ic`) has Classic's
  box; the static sets differ only by the `data-iconset` attribute on the
  dock. A swap crossfades over 0.3 s: a copy of the old dock fades out over
  the new one (opacity only; instant with reduced motion). A live set loads
  its chunk, compiles its shaders and draws its first frame before the
  crossfade starts, holds still during it, and animates after.
- **Unused sets cost nothing.** While a static set is active no live-set or
  three.js chunk is loaded, no WebGL context exists, and nothing requests
  animation frames or listens to the pointer. Settings' previews of the live
  sets are CSS stills. A live set draws all tiles with one WebGL context into
  a row that is copied into a small canvas per tile; it pauses while the dock
  is off screen or the tab hidden, draws one still frame under reduced
  motion, and leaving it releases the context, loops and listeners. A saved
  live set shows its still at load and comes alive after the desktop appears.
- `AppContext.iconSet()`, `setIconSet(id)` (resolves once shown) and
  `onIconSet(cb)` for apps; `globalThis.__shiroDesktopCtx` in the console.
- `tests/browser/icon-sets.mjs` checks the default, zero cost (with Settings
  open too), every swap (no layout shift, dock box unchanged, no long
  animation frame during the crossfade), live sets animating, pausing and
  tearing down, reduced motion and persistence; `--shots` writes
  docs/screenshots/iconsets-*.png. Unit tests:
  `tests/tests/shiro-vitest/desktop-iconsets.test.ts`.

## Loading: one draw

The first frame of the desktop is its final layout; nothing in the menu bar,
dock or windows moves afterwards unless the user acts.

- `bootDesktop` builds the desktop hidden (`.sd-booting`: `visibility:
  hidden`, transitions and animations off). The page shows its background
  and, on branded profiles, the boot mark (server.mjs inlines the brand's
  SVG favicon as `#boot-mark`; light or dark from the system's scheme).
- It appears in one frame once everything that would change the layout has
  settled: the Inter and JetBrains Mono fonts (preloaded by main.ts as soon
  as the desktop is chosen; `font-display: block`; if the terminal was
  measured before JetBrains Mono arrived it is re-measured first), the
  installed packages (dock badges, optional programs), the Debian GUI apps
  (`registerGuiApps` resolves once installed apps are registered), the phone
  layer (`mobile.ts`) and last session's windows (opened without their
  animation; the main terminal keeps focus). Anything that takes longer than
  1.5 s (`REVEAL_CAP_MS`) no longer holds it up.
- `Desktop.holdReveal(promise)` adds a wait (main.ts uses it for the GUI
  apps). The mark `shiro:desktop:revealed` records when it appeared.
- Dock hover magnifies with `transform` only: each icon keeps its slot, so
  neighbours never move.
- `tests/browser/no-reflow.mjs` checks it in Chromium at desktop and iPhone
  sizes, light and dark: cumulative layout shift 0, every menu bar, dock and
  window element's rect the same from the first visible frame to the
  settled page, and no neighbour moving while each dock icon is hovered.
  `--shots` writes screencast strips (docs/screenshots/load-frames-*.png).

## Window manager API

The page exposes it as `window.__tabcomputer.desktop` and `globalThis.__shiroDesktop`.
Code in this repo can call `getDesktop()` from `src/desktop/wm.ts` instead.
Both are `null` or `undefined` in the classic UI. The types live in `wm.ts`.

```ts
interface DesktopAPI {
  readonly version: number;                      // 1
  createWindow(opts: WindowOptions): DesktopWindow;
  windows(): DesktopWindow[];                    // bottom to top
  get(id: string): DesktopWindow | undefined;
  focused(): DesktopWindow | null;
  workArea(): Geometry;                          // page px between the menu bar and the dock
  registerContentKind(kind: string, factory: ContentFactory): void;
  registerApp(app: AppDescriptor): void;         // dock + `desktop open ID` + /dom/windows/ctl
  apps(): AppDescriptor[];
  openApp(id: string, args?: Record<string, unknown>): Promise<DesktopWindow | null>;
  readonly launches?: LaunchTracker;             // v1.5: apps that are starting (launch-state.ts)
  theme(): 'light' | 'dark';
  setTheme(pref: 'light' | 'dark' | 'system'): void;
  on(ev: 'window-created' | 'window-closed' | 'window-changed' | 'focus-changed' | 'apps-changed' | 'theme-changed',
     cb: (win?: DesktopWindow) => void): () => void;
}
```

### WindowOptions

| option | meaning |
|---|---|
| `id` | stable id (`[A-Za-z0-9_-]+`, unique), else `w1`, `w2`, … It names `/dom/windows/<id>`. |
| `title`, `appId`, `icon` | `appId` groups windows under a dock icon. `icon` (inline SVG or URL) is used when the app has none. |
| `content` | `{kind:'dom', element?}`, `{kind:'iframe', src? \| srcdoc?, sandbox?, allow?}`, `{kind:'terminal', command?, cwd?}`, `{kind:'surface', ...SurfaceOptions}`, or a registered kind |
| `width`, `height` | client area size in CSS px (the title bar adds 38 px) |
| `x`, `y` | frame position in work-area coordinates. Without them, the window is centered and cascaded. |
| `minWidth`, `minHeight`, `resizable` | defaults 220, 120, `true` |
| `decorations` | `'server'` (default: title bar, lights, resize edges) or `'none'` (the client draws its own; see `beginMove`/`beginResize`) |
| `override` | override-redirect, for X11 menus, tooltips and DnD icons: no frame, never focused, not in the dock, placed exactly, above normal windows |
| `transientFor` | parent window id (dialogs): kept above the parent, closed with it |
| `alwaysOnTop`, `skipTaskbar` | layer above normal windows; leave out of dock and cycling |
| `state` | `'normal'`, `'maximized'` or `'minimized'` at creation |
| `focus` | take focus on creation (default `true`, `false` for override windows) |
| `behind` | open below the other windows instead of on top (with `focus: false`): launch placeholders |
| `splash` | a start-up splash screen: it doesn't end its app's launch |
| `onClose(win)` | runs before closing; returning `false` keeps the window open |

### DesktopWindow

```ts
interface DesktopWindow {
  readonly id: string; readonly appId?: string; readonly kind: string;
  readonly element: HTMLElement;      // frame
  readonly body: HTMLElement;         // client area
  readonly titlebarExtra: HTMLElement | null;   // put title-bar buttons here
  readonly options: Readonly<WindowOptions>;
  title: string; readonly state: 'normal' | 'minimized' | 'maximized' | 'snapped-left' | 'snapped-right'
    | 'snapped-top-left' | 'snapped-top-right' | 'snapped-bottom-left' | 'snapped-bottom-right' | 'closed';
  readonly focused: boolean;
  readonly iframe?: HTMLIFrameElement; readonly surface?: Surface; readonly content?: unknown;
  setTitle(t): void; geometry(): Geometry;      // {x, y} of the frame, {width, height} of the client area
  move(x, y): void; resize(w, h): void; setGeometry(partial): void;
  focus(): void; minimize(): void; restore(): void; maximize(): void; zoom(): void; snap(side: SnapSide): void;   // halves and quarters
  close(force?): boolean;                        // false when onClose vetoed it
  beginMove(ev: PointerEvent): void;             // client-side decorations start a move...
  beginResize(ev: PointerEvent, edges: string): void;   // ...or a resize ('n','se','w',...)
  setAttention(on: boolean): void;
  on('close' | 'focus' | 'blur' | 'move' | 'resize' | 'state' | 'title', cb): () => void;
}
```

`move`/`resize` on a maximized or tiled window first return it to normal.
Geometry changes fire `move`/`resize` on the window and `window-changed` on
the desktop.

### Surfaces: native GUI clients (unix/gui)

A display server (X11 or Wayland on unix/gui) maps each toplevel to
`createWindow({ content: { kind: 'surface', ... } })` and talks to its
`Surface`:

```ts
interface SurfaceOptions { bufferWidth?; bufferHeight?; scale?; cursor?; autoResize? /* default true */ }
interface Surface {
  readonly canvas: HTMLCanvasElement;            // or transferControlToOffscreen() it to a worker
  readonly width: number; readonly height: number; readonly scale: number;   // buffer, device px
  present(src: CanvasImageSource | ImageData, dx?, dy?): void;   // a frame or a damaged rect
  setBufferSize(w, h, resizeWindow?: boolean): void;   // client-initiated resize
  setCursor(css: string): void;
  onInput(cb: (ev: SurfaceInputEvent) => void): () => void;
  onConfigure(cb: (w, h, scale) => void): () => void;  // like xdg_toplevel.configure
}
interface SurfaceInputEvent {
  type: 'pointerdown' | 'pointerup' | 'pointermove' | 'wheel' | 'keydown' | 'keyup' | 'enter' | 'leave' | 'focus' | 'blur';
  x; y;                 // buffer (device-pixel) coordinates
  button; buttons; deltaX; deltaY;   // wheel deltas in px
  key; code; keyCode; repeat; shift; ctrl; alt; meta; time;
}
```

Mapping notes:

- **Toplevels** are decorated by the desktop (server-side decorations).
  `_NET_WM_NAME` or `xdg_toplevel.set_title` → `setTitle`. Minimize, maximize
  and close requests → `minimize()`, `maximize()`, `close()`. The close
  button fires the window's `close` event: send `WM_DELETE_WINDOW` or
  `xdg_toplevel.close` from it, and use `onClose` returning `false` to let the
  client decide.
- **Override-redirect windows and popups** (menus, tooltips) use
  `override: true` with exact `x`, `y` in work-area coordinates, relative to
  the parent's `geometry()`. Transient dialogs use `transientFor`.
- **Client-side decorations** (GTK headerbars) use `decorations: 'none'` and
  call `beginMove(ev)` / `beginResize(ev, edges)` from the pointerdown that
  `xdg_toplevel.move`/`resize` answers.
- **Resizing**: with `autoResize` (default), the canvas buffer follows the
  window and keeps its pixels, and `onConfigure` reports the new size. The
  client then redraws. With `autoResize: false`, the buffer only changes when
  the client calls `setBufferSize`.
- **Keyboard**: the canvas takes focus with the window. Keys are
  `preventDefault`ed, except the desktop's shortcuts (`isDesktopShortcut`).

A canvas client takes about 15 lines:

```js
const d = window.__tabcomputer.desktop;
const w = d.createWindow({ title: 'xeyes', appId: 'x11', width: 300, height: 200, content: { kind: 'surface' } });
const ctx = w.surface.canvas.getContext('2d');
const draw = (mx = 0, my = 0) => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w.surface.width, w.surface.height);
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(mx, my, 10 * w.surface.scale, 0, 7); ctx.fill(); };
w.surface.onInput(e => e.type === 'pointermove' && draw(e.x, e.y));
w.surface.onConfigure(() => draw());
w.on('close', () => console.log('client gone'));
draw();
```

### Content kinds and apps

`registerContentKind(kind, (win, content, body) => instance)` adds a kind.
The factory fills `body`, and its return value becomes `win.content`. The
desktop registers `terminal`; the WM itself provides `dom`, `iframe` and
`surface`.

`registerApp({ id, name, icon, order, dock, launch(args), menus() })` puts an
app in the dock (if `dock` is not `false`), in `desktop open ID` and in
`/dom/windows/ctl` (`open ID`). `menus()` adds menu-bar menus while the app
has focus. Apps with `order` ≥ 20 sit after the dock's separator.

`registerGroup({ id, name, order, collapse, maxLoose })` (v1.2, optional on
`DesktopAPI`) declares a dock stack; apps join it with `group: id`. A
stack with `collapse: 'always'` is always one tile; `'auto'` (default)
stacks when the dock is crowded or the group has more than `maxLoose`
(default 4) apps. The desktop registers `system`, `programs` and `debian`
(`maxLoose: 4`; apps with `order` ≥ 60 and no `group` go there). `groups()`
lists them by `order`.

## Network sign-in

The desktop is never gated behind a login. When something needs outbound
network that requires a signed-in user, it calls the single hook:

```ts
import { requireNetworkSignIn } from './net-signin';   // or globalThis.__shiroRequireNetwork
const token = await requireNetworkSignIn({ host: 'example.com', port: 443, reason: 'curl wants to connect' });
if (!token) return -ENETUNREACH;   // the user said "Not now"
```

- **With a saved sign-in**, the hook resolves at once and later visits
  connect silently. The saved sign-in is the GitHub token in localStorage
  `tabcomputer_github_token`, the same one `gh auth login` saves.
- **Without one**, the desktop shows a non-blocking sheet under the menu bar:
  "Connect to the internet — Sign in with GitHub", plus a small "Other ways to
  connect" link (a placeholder for now). Sign-in uses GitHub's device flow
  (`src/github-auth.ts`), and the sheet shows the code with Copy and Open
  GitHub buttons. Concurrent callers share one sheet. After "Not now", the
  hook returns `null` for 60 s instead of asking again.
- **In the classic UI** no handler is registered, so the hook returns `null`
  (or the saved token).
- **A command that needs GitHub** opens the same sheet (`src/github-needed.ts`):
  "Sign in with GitHub to finish" when the tab is not signed in, and "One
  more permission from GitHub" when the sign-in lacks a scope the command
  named. Both open with the focus on "Not now", so a key already on its way
  declines and never starts a sign-in; the terminal gets the focus back when
  the sheet goes. A sheet opened on purpose (Settings, the menu bar) has the
  focus on the sign-in. The command the sheet names is shown as one line of
  at most 60 characters.
- **More permissions are asked for only on GitHub's word.** The sheet opens
  for `gh` and its extensions, and for `git` only when the remote the
  command talked to is an https address on github.com (`gitRemoteIsGitHub`).
  It opens only for the scopes in `SCOPES_ASKED`: `repo`, `public_repo`,
  `repo:status`, `workflow`, `gist`, `read:org`, `write:org`, `admin:org`
  (Classroom 50's `gh student` needs it), `read:user`, `user:email`,
  `read:project`, `project`, `read:packages`, `read:discussion`,
  `notifications`, `codespace`. A failure that names any other scope
  (`delete_repo`, `admin:enterprise`, a key or webhook scope, …) stays a
  failure, with one line: "tabcomputer does not add delete_repo to the GitHub
  sign-in because a command asked. To add it yourself: gh auth refresh -s
  delete_repo".
- **Same-origin requests never call it.** That covers package downloads and
  `/api/*`. `needsSignIn(url)` tells them apart.

Today the hook has one caller: the TCP relay token request (`relayToken` in
`src/kernel/net.ts`). That request goes without a credential first. When the
server answers `401 {"error":"signin_required"}` it is repeated with
`Authorization: Bearer <token>` (the saved sign-in, or the hook's answer), and
later token requests carry it at once until the relay setting changes. A
server that does not require a sign-in never receives the token.

The server enforces sign-in only when `TABCOMPUTER_TCP_REQUIRE_SIGNIN=1` is set.
`POST /tcp/token` then needs a GitHub token that `api.github.com/user`
accepts (checks are cached for 10 minutes); without one it answers
`401 {"error":"signin_required","provider":"github"}`. When the variable is
unset, nothing changes.

**Use my own connection.** Settings → Network → Connection switches the
kernel's sockets from this site's relay to one the user runs: a `ws(s)://`
relay URL and, optionally, its token URL (any relay speaking
docs/NETWORKING.md's protocol; `TABCOMPUTER_TCP_RELAY=1 node server.mjs` with this
site in `TABCOMPUTER_TCP_ORIGINS`). Left empty, the token URL is `/token` next to
the relay URL, which is where server.mjs has it; a relay with nothing there is
used without a token. **Test** checks the relay (the token request,
then a WebSocket open) before it is saved. The choice lives in localStorage
`tabcomputer_relay` (`ownRelay`/`setOwnRelay`/`relayNetConfig` in net-signin.ts), and
boot applies it with `followRelaySetting(kernel)` (src/kernel/net.ts) in both
UIs, at boot and on change. A user's relay gets `credentials: false` (a
NetConfig field, default true): the saved GitHub token is not sent to it, and
a 401 from it doesn't open the sign-in sheet, unless the user ticked "Give
this relay my GitHub sign-in if it asks for one" (`sendSignin`). The sheet's
"Other ways to connect" links here. The terminal UI has no Settings, so a
relay is set in the desktop; it is used in `?ui=terminal` too.

The menu bar's network icon shows `online`, `signed-in`, `needs-sign-in`,
`offline` or `unavailable` (relay off). Clicking it opens a popover with Sign
in / Sign out. Settings → Network shows the same, plus a relay check.

## /dom: the page as files

`/dom` is mounted on the filesystem (a FileSystem virtual provider, so every
builtin sees it) and its event streams are kernel devices (so a blocking
`read(2)` from a WASM or x86 program waits for the next event). Reads and
writes happen synchronously against the live DOM. A trailing newline on
writes is dropped, so `echo` works.

```
/dom/ctl                     write JS to evaluate it; read the last result (JSON for non-strings)
/dom/<id-or-selector>/       the element with that id, else the first match of the CSS selector
    text html outerhtml      textContent / innerHTML (rw), outerHTML (r)
    value                    form value (rw; writing fires input + change)
    tag rect count           tag name, "x y w h", number of matches
    click                    write anything to click it
    attr/<name>              attribute (rw; writing a new name creates it)
    style/<prop>             inline value, else computed (rw; empty write removes)
    children/<n>/…           walk down the tree
    <n>/…                    the nth match of the selector
/dom/events/<type>           one line per event: type t=ms target=tag#id.class key=value…
/dom/windows/ctl             "open <app>" (read: the apps you can open)
/dom/windows/<id>/           desktop windows
    title                    rw
    geometry                 "x y width height" (rw)
    state app kind focused   r
    ctl                      close | move X Y | resize W H | focus | minimize | maximize | zoom | restore | snap left|right | title TEXT
```

Selectors can't contain `/`. URL-encode it as `%2F` (any `%XX` in a
component is decoded). Quote selectors with spaces or `>` for the shell.

**Event streams.** Kernel processes and `cat` at a terminal follow
`/dom/events/<type>` live until Ctrl-C. Other in-page builtins (`grep`,
`cat` into a pipe) get the most recent events (up to 200). Recording for a
type starts the first time anyone looks at it. `window` events are the
desktop's: `window-created`, `window-closed`, `focus-changed` and
`window-changed`. Password fields report `value="(hidden)"`.

Examples:

```sh
ls /dom                                   # ctl events windows html head body, plus element ids
cat /dom/windows/terminal/title           # user@tabcomputer: ~
echo 'move 40 40' > /dom/windows/terminal/ctl
echo 'snap left'  > /dom/windows/terminal/ctl
echo '0 0 900 500' > /dom/windows/terminal/geometry
echo 'open files' > /dom/windows/ctl
for w in /dom/windows/w*; do echo "$w: $(cat $w/title)"; done
cat '/dom/.sd-mb-app/text'                # the focused app's name in the menu bar
echo 'Hello' > '/dom/.sd-wordmark/text'
echo 'document.title' > /dom/ctl; cat /dom/ctl
echo 'navigator.hardwareConcurrency * 2' > /dom/ctl; cat /dom/ctl
cat /dom/events/click                     # live, Ctrl-C to stop
cat /dom/events/window                    # window manager events
grep -c keydown /dom/events/keydown       # recent ones
echo 'red' > /dom/body/style/outline-color
cat /dom/body/children/0/tag
```

Errors come back as errno. A JS exception in `ctl` is EIO, with the
exception message in the shell's error. A bad ctl command is EINVAL, writing
a read-only file is EACCES, and a missing element is ENOENT.

Tests: `tests/tests/shiro-vitest/dom-fs.test.ts`, `desktop-wm.test.ts`.
