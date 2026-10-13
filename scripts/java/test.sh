#!/bin/bash
# Javad against the real javac: the same sequence of edits and compiles in two
# directories, one compiled by `javac`, one by a single warm Javad. Messages,
# exit statuses and class files (byte for byte) must be equal after every step.
# The steps are the ones a kept compiler context could get wrong: a class file
# that was rebuilt, deleted, or belongs to another directory.
#   JAVA_HOME=/path/to/jdk-21 scripts/java/test.sh
# Exits 1 if a step differs. Builds public/java/javad.jar first.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BIN="${JAVA_HOME:+$JAVA_HOME/bin/}"
"$HERE/build.sh" > /dev/null || exit 1
JAR="$ROOT/public/java/javad.jar"
T="$(mktemp -d)"
T="$(cd "$T" && pwd -P)"
X="--add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED --add-exports jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED --add-exports jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED"
# The option tabcomputer starts the real javac with (src/java-defaults.ts), which Javad sets itself
REAL="-XDstringConcat=inline"
mkdir -p "$T/ref" "$T/dut" "$T/state"
"${BIN}java" $X -cp "$JAR" Javad "$T/state" 600 > "$T/javad.log" 2>&1 &
trap '"${BIN}java" -cp "$JAR" JavadClient "$T/state" q / > /dev/null 2>&1; rm -rf "$T"' EXIT
for i in $(seq 1 300); do [ -f "$T/state/port" ] && break; sleep 0.1; done
[ -f "$T/state/port" ] || { echo "Javad did not start"; cat "$T/javad.log"; exit 1; }

fail=0; steps=0; pooled=0
# both NAME 'shell text'   run in both directories (edits)
both() { (cd "$T/ref" && eval "$1"); (cd "$T/dut" && eval "$1"); }
# jc [-C subdir] ARGS...   javac ARGS in both, compared
jc() {
  local sub=.
  if [ "${1:-}" = "-C" ]; then sub="$2"; shift 2; fi
  steps=$((steps + 1))
  (cd "$T/ref/$sub" && "${BIN}javac" $REAL "$@" > "$T/ref.out" 2>&1; echo "exit $?" >> "$T/ref.out")
  "${BIN}java" -cp "$JAR" JavadClient "$T/state" c "$T/dut/$sub" "$@" 2>&1 | grep -v '^\[exit [0-9]* in ' > "$T/dut.out"
  local st=${PIPESTATUS[0]}
  if [ "$st" = 127 ]; then # not Javad's: what the tab's client does then
    (cd "$T/dut/$sub" && "${BIN}javac" $REAL "$@" > "$T/dut.out" 2>&1; echo "exit $?" >> "$T/dut.out")
  else
    pooled=$((pooled + 1)); echo "exit $st" >> "$T/dut.out"
  fi
  (cd "$T/ref" && find . -name '*.class' | LC_ALL=C sort | xargs shasum 2>/dev/null) > "$T/ref.sum"
  (cd "$T/dut" && find . -name '*.class' | LC_ALL=C sort | xargs shasum 2>/dev/null) > "$T/dut.sum"
  if ! diff "$T/ref.out" "$T/dut.out" > "$T/diff.out" || ! diff "$T/ref.sum" "$T/dut.sum" >> "$T/diff.out"; then
    fail=$((fail + 1)); echo "DIFFERS: javac $* (in $sub)"; sed 's/^/    /' "$T/diff.out"
  fi
}

both 'printf "import java.util.ArrayList;\npublic class Bank {\n  private final ArrayList<Integer> a = new ArrayList<>();\n  void add(int x) { a.add(x); }\n  long total() { long s = 0; for (int x : a) s += x; return s; }\n  public static void main(String[] args) { Bank b = new Bank(); b.add(2); System.out.println(b.total()); }\n}\n" > Bank.java'
jc Bank.java
jc Bank.java
both 'printf "public class Cat { public static void main(String[] a) { int n = 3; String s = \"n=\" + n + \" x=\" + 1.5 + a.length + new Object(); s += n; System.out.println(s + \"!\"); } }\n" > Cat.java'
jc Cat.java
jc -XDstringConcat=indyWithConstants Cat.java
both 'printf "class Bad { int x = ; }\n" > Bad.java'
jc Bad.java
jc Bad.java Bank.java
# a class found as source on the class path
both 'printf "public class Helper { static int one() { return 1; } }\n" > Helper.java; printf "public class Main { public static void main(String[] a) { System.out.println(Helper.one()); } }\n" > Main.java'
jc Main.java
# the helper rebuilt with a new method, then used
both 'sleep 1; printf "public class Helper { static int one() { return 1; } static int two() { return 2; } }\n" > Helper.java'
jc Helper.java
both 'printf "public class Main { public static void main(String[] a) { System.out.println(Helper.two()); } }\n" > Main.java'
jc Main.java
# the method removed in the source only: javac prefers the newer source
both 'sleep 1; printf "public class Helper { static int one() { return 1; } }\n" > Helper.java'
jc Main.java
# the helper gone
both 'rm -f Helper.java Helper.class'
jc Main.java
both 'printf "public class Helper { static String two() { return \"2\"; } }\n" > Helper.java'
jc Main.java
# another directory with its own Helper and Main
both 'mkdir -p other; printf "public class Helper { static double two() { return 2.5; } }\n" > other/Helper.java; printf "public class Main { public static void main(String[] a) { double d = Helper.two(); int i = Helper.two(); } }\n" > other/Main.java'
jc -C other Main.java
both 'printf "public class Main { public static void main(String[] a) { double d = Helper.two(); System.out.println(d); } }\n" > other/Main.java'
jc -C other Main.java
jc Main.java
jc other/Main.java
jc -cp other Main.java
# packages, -d, relative paths
both 'mkdir -p src/pkg out; printf "package pkg;\npublic class A { public static int f() { return 1; } public record R(int x) {} public enum E { P, Q } }\n" > src/pkg/A.java; printf "import pkg.A;\npublic class UseA { interface I { int g(); } int x = A.f(); A.R r = new A.R(3); I i = () -> r.x() + A.E.Q.ordinal(); }\n" > src/UseA.java'
jc -d out -sourcepath src src/UseA.java
jc -d out -cp out src/UseA.java
jc -d nodir src/UseA.java
jc -C src UseA.java
jc -C src -d ../out pkg/A.java UseA.java
# warnings and notes
both 'printf "import java.util.*;\npublic class Un { public static void main(String[] a) { List l = new ArrayList(); l.add(1); new Date(1, 2, 3); System.out.println(l); } }\n" > Un.java'
jc Un.java
jc -Xlint:unchecked Un.java
jc -Xlint:all -Werror Un.java
jc -deprecation -g Un.java
jc -nowarn -encoding UTF-8 Un.java
# what a first-year program gets wrong
both 'printf "import java.util.Scanner;\npublic class In {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt()\n    String s = n;\n    System.out.println(undefined + s.lenght());\n  }\n}\n" > In.java'
jc In.java
both 'printf "import java.util.Scanner;\npublic class In {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    int n = in.nextInt();\n    String s = n;\n    System.out.println(undefined + s.lenght());\n    return 1;\n  }\n  int f() { }\n}\n" > In.java'
jc In.java
both 'printf "public class Wrong { }\nclass Two { }\n" > Name.java; printf "public class Name { Two t; }\n" > Dup.java'
jc Name.java
jc Dup.java
jc Name.java Dup.java
both 'printf "public class Name { Two t; }\nclass Two { }\n" > Name.java; printf "class Two { int other; }\n" > Dup.java'
jc Name.java Dup.java
jc Name.java
# a class of the user's named like a JDK one, then the JDK one again
both 'printf "public class String { }\n" > String.java; printf "public class S1 { String s = new String(); int n = s.length(); }\n" > S1.java'
jc String.java S1.java
both 'rm -f String.java String.class'
jc S1.java
both 'printf "package java.lang;\npublic class Mine { }\n" > Mine.java'
jc Mine.java
jc Bank.java
# not Javad's: the real javac answers
jc -version
jc
jc --release 17 Bank.java
jc NoSuchFile.java
jc Bank.jav

[ -s "$T/javad.log" ] && { echo "Javad's log:"; head -30 "$T/javad.log"; }
echo "$steps steps, $pooled compiled by Javad, $fail differ"
[ "$fail" = 0 ]
