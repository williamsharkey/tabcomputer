/**
 * Six sessions as src/session-log.ts records them, for link-trim.test.ts
 * (docs/RUN_LINKS.md "link"): what a person typed, where, how each line
 * ended, and the files that changed while it ran. Each has the script
 * `link` must make of it, and the lines a careful person would still take
 * out by hand (`extra`): the measure of how often the rules keep too much.
 */
import type { FileNow, TrimEntry } from '@shiro/link-trim';

const HOME = '/home/user';
const abs = (p: string) => (p.startsWith('/') ? p : p === '~' ? HOME : `${HOME}/${p.replace(/^~\//, '')}`);

export interface Session {
  name: string;
  /** Where the shell is when `link` is typed */
  cwd: string;
  entries: TrimEntry[];
  edits?: { path: string; at: number }[];
  files: Map<string, FileNow>;
  /** The script `link` makes */
  script: string;
  /** Sentences under "not in the link" */
  notInLink?: RegExp[];
  /** Lines kept that a person would take out */
  extra: string[];
}

/** A session's lines, one second apart unless `ms` says how long one ran */
function lines(rows: [line: string, cwd: string, status: number | null, o?: { after?: string; changed?: string[]; more?: number; ms?: number }][]): TrimEntry[] {
  let t = 1_760_000_000_000;
  return rows.map(([line, cwd, status, o = {}]) => {
    const at = t;
    const end = at + (o.ms ?? 300);
    t = end + 1000;
    return { line, cwd: abs(cwd), cwdAfter: abs(o.after ?? cwd), status, at, end: status === null ? 0 : end, changed: (o.changed ?? []).map(abs), more: o.more ?? 0 };
  });
}
const text = (t: string): FileNow => ({ text: t });

const FLASK_APP = `from flask import Flask
app = Flask(__name__)

@app.route("/")
def hello():
    return "Hello from a link"

app.run(port=5000)
`;

const APP_JSX = `export default function App() {
  return <h1>The shop is open</h1>;
}
`;

const LIST_C = `#include <stdlib.h>
#include "list.h"

struct node *push(struct node *head, int value) {
    struct node *n = malloc(sizeof *n);
    n->value = value;
    n->next = head;
    return n;
}
`;

const flask: Session = {
  name: 'a Flask hello',
  cwd: '/home/user/hello',
  entries: lines([
    ['ls', '~', 0],
    ['pip install flask', '~', 0, { changed: ['.local/lib/python3.13/site-packages/flask/__init__.py', '.local/lib/python3.13/site-packages/flask/app.py', '.local/bin/flask'], more: 180, ms: 9000 }],
    ['mkdir hello', '~', 0, { changed: ['hello'] }],
    ['cd hello', '~', 0, { after: 'hello' }],
    ['nano app.py', 'hello', 0, { changed: ['hello/app.py'], ms: 40_000 }],
    ['python3 app.py', 'hello', 1, { ms: 400 }],
    ['nano app.py', 'hello', 0, { changed: ['hello/app.py'], ms: 15_000 }],
    ['cat app.py', 'hello', 0],
    ['python3 app.py', 'hello', 130, { ms: 45_000 }],
    ['history', 'hello', 0],
    ['link', 'hello', null],
  ]),
  files: new Map([[abs('hello/app.py'), text(FLASK_APP)]]),
  script: `pip install flask
mkdir hello
cd ~/hello
cat > app.py <<'EOF'
${FLASK_APP}EOF
python3 app.py
`,
  extra: [],
};

const vite: Session = {
  name: 'a Vite app',
  cwd: '/home/user',
  entries: lines([
    ['npm create vite@latest shop -- --template react', '~', 0, { changed: ['shop', 'shop/package.json', 'shop/index.html', 'shop/src/App.jsx', 'shop/src/main.jsx', 'shop/vite.config.js'], ms: 6000 }],
    ['cd shop', '~', 0, { after: 'shop' }],
    ['ls', 'shop', 0],
    ['npm install', 'shop', 0, { changed: ['shop/node_modules', 'shop/node_modules/vite/package.json', 'shop/package-lock.json'], more: 4100, ms: 22_000 }],
    ['npm run dev', 'shop', 130, { ms: 20_000 }],
    ['code src/App.jsx', 'shop', 0],
    ['git status', 'shop', 128],
    ['npm run build', 'shop', 0, { changed: ['shop/dist', 'shop/dist/index.html', 'shop/dist/assets/index-a1b2.js'], ms: 5000 }],
    ['ls dist', 'shop', 0],
    ['npm run dev', 'shop', null],
    // (a second Terminal, while the dev server runs in the first)
    ['pwd', '~', 0],
    ['link', '~', null],
  ]),
  // the Code app saved the file twice, after `code src/App.jsx`
  edits: [{ path: abs('shop/src/App.jsx'), at: 1_760_000_000_000 + 54_000 }, { path: abs('shop/src/App.jsx'), at: 1_760_000_000_000 + 54_500 }],
  files: new Map([[abs('shop/src/App.jsx'), text(APP_JSX)]]),
  script: `npm create vite@latest shop -- --template react
cd ~/shop
npm install
cat > src/App.jsx <<'EOF'
${APP_JSX}EOF
npm run build
npm run dev
`,
  extra: [],
};

const clab: Session = {
  name: 'a C lab with an edited file',
  cwd: '/home/user/lab3',
  entries: lines([
    ['git clone https://github.com/cs-course/lab3', '~', 0, { changed: ['lab3', 'lab3/Makefile', 'lab3/list.c', 'lab3/list.h', 'lab3/test.c', 'lab3/README.md', 'lab3/.git/HEAD'], more: 30, ms: 3000 }],
    ['cd lab3', '~', 0, { after: 'lab3' }],
    ['cat README.md', 'lab3', 0],
    ['make', 'lab3', 2, { changed: ['lab3/test.o'], ms: 2000 }],
    ['vim list.c', 'lab3', 0, { changed: ['lab3/list.c'], ms: 120_000 }],
    ['make', 'lab3', 0, { changed: ['lab3/list.o', 'lab3/lab3'], ms: 2500 }],
    ['./lab3', 'lab3', 139],
    ['vim list.c', 'lab3', 0, { changed: ['lab3/list.c'], ms: 60_000 }],
    ['make', 'lab3', 0, { changed: ['lab3/list.o', 'lab3/lab3'], ms: 2500 }],
    ['make test', 'lab3', 0, { ms: 1500 }],
    ['./lab3 < input.txt', 'lab3', 0],
    ['git diff', 'lab3', 0],
    ['link', 'lab3', null],
  ]),
  files: new Map([[abs('lab3/list.c'), text(LIST_C)]]),
  script: `git clone https://github.com/cs-course/lab3
cd ~/lab3
cat > list.c <<'EOF'
${LIST_C}EOF
make
`,
  extra: [],
};

const build: Session = {
  name: 'a clone and a build',
  cwd: '/home/user',
  entries: lines([
    ['export CC=clang', '~', 0],
    ['git clone --depth 1 https://github.com/jqlang/jq', '~', 0, { changed: ['jq', 'jq/configure.ac', 'jq/Makefile.am', 'jq/src/main.c'], more: 700, ms: 8000 }],
    ['cd jq', '~', 0, { after: 'jq' }],
    ['git submodule update --init', 'jq', 0, { changed: ['jq/vendor/oniguruma/configure.ac', 'jq/.git/modules/vendor/oniguruma/HEAD'], more: 400, ms: 6000 }],
    ['ls', 'jq', 0],
    ['cd docs && ls && cd ..', 'jq', 0],
    ['autoreconf -i', 'jq', 0, { changed: ['jq/configure', 'jq/Makefile.in', 'jq/aclocal.m4'], more: 20, ms: 30_000 }],
    ['./configure --with-oniguruma=builtin', 'jq', 0, { changed: ['jq/Makefile', 'jq/config.status', 'jq/src/config.h'], more: 8, ms: 60_000 }],
    ['make -j4', 'jq', 0, { changed: ['jq/src/main.o', 'jq/jq'], more: 310, ms: 240_000 }],
    ['./jq --version', 'jq', 0],
    ['sudo make install', 'jq', 0, { changed: ['/usr/local/bin/jq', '/usr/local/lib/libjq.a'], more: 6, ms: 4000 }],
    ['cd ~', 'jq', 0, { after: '~' }],
    ['jq --version', '~', 0],
    ['link', '~', null],
  ]),
  files: new Map(),
  script: `export CC=clang
git clone --depth 1 https://github.com/jqlang/jq
cd ~/jq
git submodule update --init
autoreconf -i
./configure --with-oniguruma=builtin
make -j4
sudo make install
cd ~
`,
  extra: [],
};

const mistakes: Session = {
  name: 'a session full of mistakes',
  cwd: '/home/user/proj',
  entries: lines([
    ['pyhton3 --version', '~', 127],
    ['python3 --version', '~', 0],
    ['pip install reqeusts', '~', 1, { ms: 2000 }],
    ['pip install requests', '~', 0, { changed: ['.local/lib/python3.13/site-packages/requests/__init__.py'], more: 60, ms: 5000 }],
    ['pip install requests', '~', 0, { ms: 900 }],
    ['mkdir proj && cd proj', '~', 0, { after: 'proj', changed: ['proj'] }],
    ['touch main.py', 'proj', 0, { changed: ['proj/main.py'] }],
    ['rm main.py', 'proj', 0, { changed: ['proj/main.py'] }],
    ['cd ..', 'proj', 0, { after: '~' }],
    ['cd porj', '~', 1],
    ['cd proj', '~', 0, { after: 'proj' }],
    ['echo \'print("hi")\' > main.py', 'proj', 0, { changed: ['proj/main.py'] }],
    ['cat main.py', 'proj', 0],
    ['python3 main.py', 'proj', 0],
    ['python3 mian.py', 'proj', 2],
    ['git init', 'proj', 0, { changed: ['proj/.git', 'proj/.git/HEAD', 'proj/.git/config'], more: 12 }],
    ['git add .', 'proj', 0, { changed: ['proj/.git/index', 'proj/.git/objects/ab/cdef'] }],
    ['git comit -m first', 'proj', 1],
    ['git commit -m first', 'proj', 0, { changed: ['proj/.git/COMMIT_EDITMSG', 'proj/.git/refs/heads/main'] }],
    ['ls -la', 'proj', 0],
    ['clear', 'proj', 0],
    ['history', 'proj', 0],
    ['link --help', 'proj', 0],
    ['link', 'proj', null],
  ]),
  files: new Map(),
  script: `pip install requests
mkdir proj && cd proj
echo 'print("hi")' > main.py
git init
git add .
git commit -m first
`,
  // (`touch main.py` and `rm main.py` cancel out, and neither is kept)
  extra: [],
};

const T0 = 1_760_000_000_000;
const binary: Session = {
  name: 'a session with a large binary file',
  cwd: '/home/user/site',
  entries: lines([
    ['mkdir site && cd site', '~', 0, { after: 'site', changed: ['site'] }],
    ['code .', 'site', 0],
    ['curl -LO https://example.org/big/model.bin', 'site', 0, { changed: ['site/model.bin'], ms: 70_000 }],
    ['ls -lh', 'site', 0],
    ['python3 -m http.server 8000', 'site', null],
    ['link', 'site', null],
  ]),
  // saved in the Code app, between `code .` and the download
  edits: [
    { path: abs('site/index.html'), at: T0 + 2200 },
    { path: abs('site/style.css'), at: T0 + 2300 },
    { path: abs('site/photo.jpg'), at: T0 + 2400 },
    { path: abs('site/data.csv'), at: T0 + 2500 },
    { path: abs('site/index.html'), at: T0 + 2550 },
    { path: abs('site/old.txt'), at: T0 + 2560 },
  ],
  files: new Map<string, FileNow>([
    [abs('site/index.html'), text('<!doctype html>\n<link rel="stylesheet" href="style.css">\n<h1>Models</h1>\n<img src="photo.jpg" alt="The lab">\n')],
    [abs('site/style.css'), text('body { font: 16px system-ui; margin: 2rem; }')],
    [abs('site/photo.jpg'), { skip: 'binary', size: 2_300_000 }],
    [abs('site/data.csv'), { skip: 'large', size: 310_000 }],
    [abs('site/old.txt'), { missing: true }],
  ]),
  script: `mkdir site && cd site
cat > index.html <<'EOF'
<!doctype html>
<link rel="stylesheet" href="style.css">
<h1>Models</h1>
<img src="photo.jpg" alt="The lab">
EOF
cat > style.css <<'EOF'
body { font: 16px system-ui; margin: 2rem; }
EOF
curl -LO https://example.org/big/model.bin
python3 -m http.server 8000
`,
  notInLink: [/^~\/site\/photo\.jpg \(2\.3 MB, not text\) is not in the link\./, /^~\/site\/data\.csv \(310 KB, too large for a link\) is not in the link\./],
  extra: [],
};

export const SESSIONS: Session[] = [flask, vite, clab, build, mistakes, binary];
export { HOME };
