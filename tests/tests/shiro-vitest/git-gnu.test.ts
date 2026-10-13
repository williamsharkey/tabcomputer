/**
 * The built-in git against git 2.43 on agent-style sessions: each expected
 * output is what the real git printed for the same commands on the same
 * files, with fixed identities and dates (tests/git-cases-prelude.sh; the
 * full list is tests/git-cases.txt, run by gnu-tools-diff.test.ts with
 * GNU_DIFF_CASES/GNU_DIFF_PRELUDE).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

/** gnu-tools-diff.test.ts's files: the commits' hashes are git's for these */
const FILES: Record<string, string> = {
  'a.txt': 'banana\napple\ncherry\napple\n10\n9\n-3\n2.5\nApple\n',
  'b.csv': 'name,age,city\nalice,30,NYC\nbob,25,LA\ncarol,35,NYC\ndave,,SF\n',
  'src/main.ts': 'import { x } from "./lib";\nconsole.log(x);\n// TODO: fix\n',
  'src/lib.ts': 'export const x = 1;\n// TODO later\n',
  'src/sub/deep.js': 'function f() {\n  return 42;\n}\n',
  'src/sub/notes.md': '# Title\n\nSome text.\n',
  'log.txt': '2024-01-01 INFO start\n2024-01-01 ERROR boom\n2024-01-02 WARN slow\n2024-01-02 ERROR bang\n2024-01-03 INFO done\n',
  'sp ace.txt': 'x y z\n',
  'tabs.tsv': 'k1\tv1\tz\nk2\tv2\tz\nk3\t\tz\n',
  'nums.txt': '3\n1\n2\n10\n1e3\n0x10\n 5\n',
  'ver.txt': 'v1.10.0\nv1.2.0\nv1.9.3\nv2.0.0-rc1\nv2.0.0\n',
  'h.txt': '1K\n2M\n512\n3G\n10K\n',
  'crlf.txt': 'one\r\ntwo\r\n',
  'noeol.txt': 'last line no newline',
  'pkg.json': '{"name":"x","version":"1.2.3","scripts":{"test":"vitest"}}\n',
};
const PRELUDE = readFileSync(new URL('../../git-cases-prelude.sh', import.meta.url), 'utf8');

/** [commands, git's output] */
const CASES: [string, string][] = [
  ["r; git log --oneline; echo 4 >> a.txt; echo n > n.txt; git status",
    "a72aee8 init\nOn branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n\tmodified:   a.txt\n\nUntracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n\tn.txt\n\nno changes added to commit (use \"git add\" and/or \"git commit -a\")\n"],
  ["r; echo 4 >> a.txt; git commit -m two; echo $?",
    "On branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n\tmodified:   a.txt\n\nno changes added to commit (use \"git add\" and/or \"git commit -a\")\n1\n"],
  ["r; echo 4 >> a.txt; git commit -am two",
    "[main 66e3289] two\n 1 file changed, 1 insertion(+)\n"],
  ["r; echo 4 >> a.txt; git diff",
    "diff --git a/a.txt b/a.txt\nindex 71537ef..0eb9685 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -7,3 +7,4 @@ apple\n -3\n 2.5\n Apple\n+4\n"],
  ["r; git rm -q b.csv; git mv a.txt z.txt; git status -s",
    "D  b.csv\nR  a.txt -> z.txt\n"],
  ["r; echo x >> a.txt; git restore a.txt; echo y >> b.csv; git add b.csv; git restore --staged b.csv; git status -s",
    " M b.csv\n"],
  ["r; echo x >> a.txt; git commit -qam two; git reset --hard HEAD~1; git log --oneline",
    "HEAD is now at a72aee8 init\na72aee8 init\n"],
  ["r; echo u > u; mkdir e; echo e > e/f; git clean -n; git clean -fd",
    "Would remove u\nRemoving e/\nRemoving u\n"],
  ["r; git checkout -qb f; echo f >> a.txt; git commit -qam f; git checkout -q main; echo m >> a.txt; git commit -qam m; git merge f; git status -s; tail -5 a.txt",
    "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\nUU a.txt\n<<<<<<< HEAD\nm\n=======\nf\n>>>>>>> f\n"],
  ["r; git checkout -qb f; echo f >> a.txt; git commit -qam f; git checkout -q main; echo m >> a.txt; git commit -qam m; git merge f >/dev/null; echo resolved > a.txt; git add a.txt; git commit -q --no-edit; git log --oneline --graph",
    "*   a74f081 Merge branch 'f'\n|\\  \n| * eb357c4 f\n* | 36a3d3d m\n|/  \n* a72aee8 init\n"],
  ["r; echo x >> a.txt; git stash; git stash list; git stash show; git stash pop",
    "Saved working directory and index state WIP on main: a72aee8 init\nstash@{0}: WIP on main: a72aee8 init\n a.txt | 1 +\n 1 file changed, 1 insertion(+)\nOn branch main\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n  (use \"git restore <file>...\" to discard changes in working directory)\n\tmodified:   a.txt\n\nno changes added to commit (use \"git add\" and/or \"git commit -a\")\nDropped refs/stash@{0} (e058f8d2a7653a4c33c01a3e90a9f46bd1159fd8)\n"],
  ["r; echo 4 >> a.txt; GIT_AUTHOR_NAME=Bo git commit -qam four; git blame a.txt | tail -2",
    "^a72aee8 (Ann 2023-11-14 22:13:20 +0000  9) Apple\n5404ad5b (Bo  2023-11-14 22:13:20 +0000 10) 4\n"],
  ["r; git tag -a v1 -m rel; echo x >> a.txt; git commit -qam two; git describe",
    "v1-1-g232fb47\n"],
  ["printf '*.log\\n' > .gitignore; r; echo l > x.log; git check-ignore -v x.log; git add x.log; echo $?",
    ".gitignore:1:*.log\tx.log\n1\n"],
  ["r; for i in 1 2 3; do echo $i > b.csv; git add b.csv; git commit -qm c$i; done; git log --oneline | wc -l",
    "4\n"],
  // tabcomputer#88: describe prefers an annotated tag; log --graph draws a lane that crosses another
  ["r; git tag v1; git tag -a v2 -m two; echo x >> a.txt; git commit -qam two; git describe --tags; git describe",
    "v2-1-g232fb47\nv2-1-g232fb47\n"],
  ["r; git tag -a v2 -m two; git tag v1; git describe --tags; git describe --tags --long",
    "v2\nv2-0-ga72aee8\n"],
  ["r; git tag -a va -m a; GIT_COMMITTER_DATE='1700000100 +0000' git tag -a vb -m b; git describe; git describe --tags",
    "vb\nvb\n"],
  ["r; git tag v2; git tag v1; git describe --tags",
    "v1\n"],
  ["c() { export GIT_COMMITTER_DATE=\"$2 +0000\"; echo \"$1\" >> \"$3\"; git commit -qam \"$1\"; }; r; git checkout -qb feat; c feat1 1700000090 a.txt; git checkout -q main; c main2 1700000010 h.txt; git checkout -qb side; c side1 1700000080 b.csv; git checkout -q main; c main3 1700000100 h.txt; git log --graph --oneline --all",
    "* a6cc006 main3\n| * 05a131f feat1\n| | * f426789 side1\n| |/  \n|/|   \n* | 6862f1d main2\n|/  \n* a72aee8 init\n"],
  ["c() { export GIT_COMMITTER_DATE=\"$2 +0000\"; echo \"$1\" >> \"$3\"; git commit -qam \"$1\"; }; r; git checkout -qb fa; c a1 1700000090 a.txt; git checkout -q main; c m2 1700000010 h.txt; git checkout -qb fb; c b1 1700000080 b.csv; git checkout -q main; c m3 1700000020 h.txt; git checkout -qb side; c side1 1700000070 nums.txt; git checkout -q main; c m4 1700000100 h.txt; git log --graph --all --format=%s",
    "* m4\n| * a1\n| | * b1\n| | | * side1\n| |_|/  \n|/| |   \n* | | m3\n| |/  \n|/|   \n* | m2\n|/  \n* init\n"],
  ["c() { export GIT_COMMITTER_DATE=\"$2 +0000\"; echo \"$1\" >> \"$3\"; git commit -qam \"$1\"; }; r; git checkout -qb fa; c a1 1700000090 a.txt; git checkout -q main; c m2 1700000010 h.txt; git checkout -qb fb; c b1 1700000080 b.csv; git checkout -q main; c m3 1700000020 h.txt; git checkout -qb fc; c c1 1700000075 ver.txt; git checkout -q main; c m4 1700000030 h.txt; git checkout -qb side; c side1 1700000070 nums.txt; git checkout -q main; c m5 1700000100 h.txt; git log --graph --all --format=%s",
    "* m5\n| * a1\n| | * b1\n| | | * c1\n| | | | * side1\n| |_|_|/  \n|/| | |   \n* | | | m4\n| |_|/  \n|/| |   \n* | | m3\n| |/  \n|/|   \n* | m2\n|/  \n* init\n"],
  // tabcomputer#87: diff, show, log and blame follow a renamed file
  ["r; git mv a.txt k2.txt; git commit -qm mv; git blame k2.txt | head -3",
    "^a72aee8 a.txt (Ann 2023-11-14 22:13:20 +0000 1) banana\n^a72aee8 a.txt (Ann 2023-11-14 22:13:20 +0000 2) apple\n^a72aee8 a.txt (Ann 2023-11-14 22:13:20 +0000 3) cherry\n"],
  ["r; git mv a.txt k2.txt; git commit -qm mv; git diff --stat HEAD~1; git diff --name-status HEAD~1; git diff --numstat HEAD~1; git diff --name-only HEAD~1; git diff --shortstat HEAD~1; git diff HEAD~1",
    " a.txt => k2.txt | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\nR100\ta.txt\tk2.txt\n0\t0\ta.txt => k2.txt\nk2.txt\n 1 file changed, 0 insertions(+), 0 deletions(-)\ndiff --git a/a.txt b/k2.txt\nsimilarity index 100%\nrename from a.txt\nrename to k2.txt\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; git commit -qam mv; git diff HEAD~1; git diff --stat HEAD~1; git diff --name-status HEAD~1; git diff --numstat HEAD~1",
    "diff --git a/a.txt b/k2.txt\nsimilarity index 89%\nrename from a.txt\nrename to k2.txt\nindex 71537ef..2205eeb 100644\n--- a/a.txt\n+++ b/k2.txt\n@@ -7,3 +7,4 @@ apple\n -3\n 2.5\n Apple\n+more\n a.txt => k2.txt | 1 +\n 1 file changed, 1 insertion(+)\nR089\ta.txt\tk2.txt\n1\t0\ta.txt => k2.txt\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; git commit -qam mv; git show --stat --format=%s; git log --name-status --format=%s -1; git show --format=%s | head -6",
    "mv\n\n a.txt => k2.txt | 1 +\n 1 file changed, 1 insertion(+)\nmv\n\nR089\ta.txt\tk2.txt\nmv\n\ndiff --git a/a.txt b/k2.txt\nsimilarity index 89%\nrename from a.txt\nrename to k2.txt\n"],
  ["r; git mv src/lib.ts src/util.ts; git mv src/sub/deep.js src/deep.js; git mv b.csv src/sub/b.csv; git commit -qm mv; git diff --stat HEAD~1; git diff --numstat HEAD~1; git diff --name-status HEAD~1",
    " src/{sub => }/deep.js   | 0\n b.csv => src/sub/b.csv  | 0\n src/{lib.ts => util.ts} | 0\n 3 files changed, 0 insertions(+), 0 deletions(-)\n0\t0\tsrc/{sub => }/deep.js\n0\t0\tb.csv => src/sub/b.csv\n0\t0\tsrc/{lib.ts => util.ts}\nR100\tsrc/sub/deep.js\tsrc/deep.js\nR100\tb.csv\tsrc/sub/b.csv\nR100\tsrc/lib.ts\tsrc/util.ts\n"],
  ["r; git mv a.txt k2.txt; git commit -qm mv; git diff --no-renames --name-status HEAD~1; git diff --no-renames --stat HEAD~1",
    "D\ta.txt\nA\tk2.txt\n a.txt  | 9 ---------\n k2.txt | 9 +++++++++\n 2 files changed, 9 insertions(+), 9 deletions(-)\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; git commit -qam mv; git diff -M95% --name-status HEAD~1; git diff -M80% --name-status HEAD~1; git diff --find-renames=95 --name-status HEAD~1",
    "D\ta.txt\nA\tk2.txt\nR089\ta.txt\tk2.txt\nD\ta.txt\nA\tk2.txt\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; GIT_AUTHOR_NAME=Bo git commit -qam mv; git blame k2.txt | tail -3; git blame -s k2.txt | tail -2; git blame --porcelain k2.txt | head -14; git blame --porcelain k2.txt | tail -13",
    "^a72aee8 a.txt  (Ann 2023-11-14 22:13:20 +0000  8) 2.5\n^a72aee8 a.txt  (Ann 2023-11-14 22:13:20 +0000  9) Apple\n47ae26ec k2.txt (Bo  2023-11-14 22:13:20 +0000 10) more\n^a72aee8 a.txt   9) Apple\n47ae26ec k2.txt 10) more\na72aee80be4e8f51cf3872442f38a11d3130afa7 1 1 9\nauthor Ann\nauthor-mail <ann@example.com>\nauthor-time 1700000000\nauthor-tz +0000\ncommitter Ann\ncommitter-mail <ann@example.com>\ncommitter-time 1700000000\ncommitter-tz +0000\nsummary init\nboundary\nfilename a.txt\n\tbanana\na72aee80be4e8f51cf3872442f38a11d3130afa7 2 2\n47ae26ece902481093b370f1bd79ac16b25c27da 10 10 1\nauthor Bo\nauthor-mail <ann@example.com>\nauthor-time 1700000000\nauthor-tz +0000\ncommitter Ann\ncommitter-mail <ann@example.com>\ncommitter-time 1700000000\ncommitter-tz +0000\nsummary mv\nprevious a72aee80be4e8f51cf3872442f38a11d3130afa7 a.txt\nfilename k2.txt\n\tmore\n"],
  ["r; git mv a.txt k2.txt; git commit -m mv",
    "[main 3080c1d] mv\n 1 file changed, 0 insertions(+), 0 deletions(-)\n rename a.txt => k2.txt (100%)\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; git add -A; git commit -m mv",
    "[main 72df315] mv\n 1 file changed, 1 insertion(+)\n rename a.txt => k2.txt (89%)\n"],
  ["r; git mv a.txt k2.txt; git diff --cached --stat; git diff --cached --name-status; git diff --cached | head -5",
    " a.txt => k2.txt | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\nR100\ta.txt\tk2.txt\ndiff --git a/a.txt b/k2.txt\nsimilarity index 100%\nrename from a.txt\nrename to k2.txt\n"],
  ["r; git rm -q a.txt; echo zzz > new.txt; git add new.txt; git commit -qm x; git diff --name-status HEAD~1",
    "D\ta.txt\nA\tnew.txt\n"],
  ["r; git mv a.txt x1.txt; cp x1.txt x2.txt; git add x2.txt; git commit -qm x; git diff --name-status HEAD~1",
    "R100\ta.txt\tx1.txt\nA\tx2.txt\n"],
  ["r; git mv log.txt l2.txt; git mv nums.txt n2.txt; echo 99 >> n2.txt; git commit -qam mv; git diff --name-status HEAD~1; git diff --stat HEAD~1",
    "R100\tlog.txt\tl2.txt\nR087\tnums.txt\tn2.txt\n log.txt => l2.txt  | 0\n nums.txt => n2.txt | 1 +\n 2 files changed, 1 insertion(+)\n"],
  ["r; git mv a.txt k2.txt; git commit -qm mv; echo late >> k2.txt; git commit -qam late; git mv k2.txt k3.txt; git commit -qm mv2; git blame k3.txt | tail -3; git diff --name-status HEAD~3; git diff --stat HEAD~3",
    "^a72aee8 a.txt  (Ann 2023-11-14 22:13:20 +0000  8) 2.5\n^a72aee8 a.txt  (Ann 2023-11-14 22:13:20 +0000  9) Apple\n35f22935 k2.txt (Ann 2023-11-14 22:13:20 +0000 10) late\nR089\ta.txt\tk3.txt\n a.txt => k3.txt | 1 +\n 1 file changed, 1 insertion(+)\n"],
  ["r; git mv a.txt k2.txt; git commit -qm mv; git diff -z --name-status HEAD~1 | tr '\\0' '@'; echo; git diff -z --numstat HEAD~1 | tr '\\0' '@'; echo",
    "R100@a.txt@k2.txt@\n0\t0\t@a.txt@k2.txt@\n"],
  ["r; git mv a.txt k2.txt; git commit -qm mv; git checkout -qb o HEAD~1; git checkout -q main; git diff --name-status o main; git diff --name-status main o; git diff --name-status o..main -- k2.txt",
    "R100\ta.txt\tk2.txt\nR100\tk2.txt\ta.txt\nA\tk2.txt\n"],
  ["r; printf 'a\\nb\\nc\\nd\\ne\\nf\\ng\\nh\\n' > big.txt; git add big.txt; git commit -qm big; git mv big.txt big2.txt; printf 'a\\nb\\nc\\nd\\nX\\nY\\nZ\\nW\\n' > big2.txt; git commit -qam half; git diff --name-status HEAD~1; printf 'a\\nb\\nc\\nd\\ne\\nY\\nZ\\nW\\n' > big2.txt; git commit -qam more; git diff --name-status HEAD~2; git diff HEAD~2 | head -5",
    "R050\tbig.txt\tbig2.txt\nR062\tbig.txt\tbig2.txt\ndiff --git a/big.txt b/big2.txt\nsimilarity index 62%\nrename from big.txt\nrename to big2.txt\nindex 71ac1b5..61eb1a8 100644\n"],
  ["r; git mv a.txt k2.txt; echo more >> k2.txt; git stash -q 2>/dev/null; git stash show",
    " a.txt => k2.txt | 1 +\n 1 file changed, 1 insertion(+)\n"],
];

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

describe('the built-in git prints what git prints', () => {
  CASES.forEach(([cmd, want], k) => {
    it(cmd, async () => {
      const d = `/tmp/gitgnu${k}`;
      for (const [p, c] of Object.entries(FILES)) {
        await fs.mkdir(`${d}/${p}`.replace(/\/[^/]*$/, ''), { recursive: true } as any).catch(() => {});
        await fs.writeFile(`${d}/${p}`, c);
      }
      let out = '';
      await shell.execute(`cd ${d} && ${PRELUDE}${cmd}`, (s) => { out += s; }, () => {});
      expect(out.replace(/\r\n/g, '\n')).toBe(want);
    });
  });
});
