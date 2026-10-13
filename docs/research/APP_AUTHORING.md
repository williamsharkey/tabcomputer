# Two ways to make an app

tabcomputer#143. Two tools make a one-file app (docs/APPS.md): the Studio, a
form for a person who does not write code, and app mode in the Code app, for a
person who does. Both sit on the same core (`validateManifest`,
`manifestSentences`, `shareFiles`, `createAppFrame`, `instanceFor`). This page
compares them on the three example apps, made from nothing.

## How it was measured

`tests/browser/app-studio.mjs` makes each app in each tool, to a copied link,
in headless Chrome on an 8 GB Mac, on a local build. It ran at 1280 x 800 and
on a 393 x 852 touch screen, each in light and dark; the counts were the same
in both appearances.

- **Taps** are clicks or taps, a choice in a list counted as two. **Keys** are
  the characters typed. In the Code app that is the whole `app.json` and two
  commands (`app new`, `code`); CodeMirror's closing brackets would save a few.
- **Parts** are the things a person decides: a box of the Studio's form, a key
  of `app.json`.
- **A person** is a model, not a person timed: Card, Moran and Newell's
  keystroke-level model, with 0.28 s a key and 1.1 s a click at a desk, 0.4 s a
  key and 0.8 s a tap on a phone, and 1.35 s to think before each part.
- **Scripted** is the machine's time for the same steps: about 1 s for every
  app in both tools. The machine is not what makes an author wait.

## The table

| App | Tool | Taps | Keys | Parts | A person, desk | A person, phone |
|---|---|---|---|---|---|---|
| jq playground (form, live) | Studio | 14 | 233 | 9 | 93 s | 117 s |
| | Code | 3 | 540 | 22 | 184 s | 248 s |
| Make pictures smaller (files, an option) | Studio | 13 | 302 | 8 | 110 s | 142 s |
| | Code | 3 | 580 | 16 | 187 s | 256 s |
| Expenses (table) | Studio | 24 | 103 | 12 | 71 s | 77 s |
| | Code | 3 | 402 | 14 | 135 s | 182 s |
| Any of the three, started from the site's copy | Studio | 4 | 0 | 0 | 4 s | 3 s |

Each link is the app written after the `#`: 509, 558 and 213 characters from
the Studio, 529, 553 and 228 from the Code app (the Studio leaves out a label
that is the field's own name, the Code app's Expenses folder names its id).

The Studio takes 26 to 52 percent of the Code app's keys, and in the model 51
to 59 percent of its time at a desk and 42 to 55 percent on a phone. On a phone
the gap grows: `app.json` is quotes, braces and colons, which a phone's
keyboard keeps on its second layer.

## Where a first-time author gets stuck

Read from the screenshots in `~/dev/tc-tools/studio-shots/`, as a newcomer
would read them.

**Studio**

- The command. The form cannot know that `convert … -resize` makes pictures
  smaller. A person who does not know a program starts from one of the site's
  apps instead, which is four taps to a link.
- `{in}` and `{out}`. One sentence under the command says what they are, and a
  command without `{in}` gets "run must say where the file goes: {in}" beside it.
- A choice's two halves (what is shown, what goes in the command). The line
  under the box says it: before a colon, after a colon.
- Package names. "imagemagick" is not a word a newcomer has. The box is filled
  in from the command for the programs the site's apps use and a few more
  (`KNOWN_PACKAGES`).
- A field's label starts as its word in braces: `{json}` gives "Json". It reads
  oddly until it is changed.
- A one-letter name has no id, and the problem says "add an id", which the
  form has no box for. (Not fixed.)
- On a phone the app is below the form. Try it scrolls to it; a change typed
  in the form is not seen until the person scrolls down.

**Code app**

- Nothing in the editor says what keys `app.json` has. A misspelt key is
  underlined and the problem lists the known keys, which is how a person
  learns them; the rest is docs/APPS.md.
- JSON itself: a missing comma, a quote. The problem says where the text stops
  being JSON ("a , or a } is expected here").
- The app in the pane follows a save, not the typing. The underline follows the
  typing.
- The share window has no QR code and no Save to a gist.
- On a phone, 400 to 580 keys of JSON on an on-screen keyboard.

## Which to lead with

Lead with the Studio. It makes each of the three apps with about half the keys
or fewer, in about half the time; every choice is a labelled box; and it works
on a phone. Its problems
are the same sentences `app check` prints, so nothing a person learns there is
lost later. Starting from one of the site's apps is the fastest way in, in
either tool.

Keep the Code app's app mode for what the Studio cannot make: an app with a
page of its own or a backend. The Studio already sends such an app there
("Open it in Code").
