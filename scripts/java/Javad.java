import java.io.*;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import com.sun.tools.javac.api.BasicJavacTask;
import com.sun.tools.javac.api.ClientCodeWrapper;
import com.sun.tools.javac.api.JavacTaskPool;
import com.sun.tools.javac.api.JavacTool;
import com.sun.tools.javac.code.ClassFinder;
import com.sun.tools.javac.code.Flags;
import com.sun.tools.javac.code.Symbol;
import com.sun.tools.javac.code.Symtab;
import com.sun.tools.javac.util.Context;
import com.sun.tools.javac.util.Log;

/**
 * tabcomputer's warm Java compiler (docs/research/JAVA_SPEED.md). Starting a
 * JVM and loading javac takes most of a minute in the x86 emulator; this JVM
 * stays up, so later compiles only compile. src/commands/java.ts is the
 * client (the `javac` command); scripts/java/build.sh builds public/java/javad.jar.
 *
 *   java --add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED (and .code, .util) \
 *        -cp javad.jar Javad STATE_DIR [IDLE_SECONDS]
 *
 * It listens on a loopback port and writes the number to STATE_DIR/port once
 * javac is loaded and has compiled a first file. A request is one connection:
 *
 *   byte op    'c' compile, 'p' ping, 'q' quit;
 *              measurement only: 'm' javac with a new context, 'e' ECJ, 'r' run a class here
 *   UTF cwd, UTF classpath ("" = none set), int n, UTF arg * n
 *   for 'r', the client's stdin as frames: int len, bytes; len 0 ends it
 *
 * The reply is frames: byte 1 (stdout) or 2 (stderr), int len, bytes; then
 * byte 0, int exit status. Status 127 from 'c' means "not a command line this
 * takes": the client runs the real javac.
 */
public class Javad {
  static volatile long lastUse = System.currentTimeMillis();
  static final java.util.concurrent.atomic.AtomicInteger busy = new java.util.concurrent.atomic.AtomicInteger();

  public static void main(String[] a) throws Exception {
    Path state = Paths.get(a[0]);
    long idleMs = (a.length > 1 ? Long.parseLong(a[1]) : 1800) * 1000L;
    Files.createDirectories(state);
    ServerSocket ss = new ServerSocket(0, 16, InetAddress.getByAddress(new byte[] {127, 0, 0, 1}));
    warm(state);
    Path tmp = state.resolve("port.tmp");
    Files.write(tmp, (ss.getLocalPort() + "\n").getBytes(StandardCharsets.US_ASCII));
    Files.move(tmp, state.resolve("port"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    Thread idle = new Thread(() -> {
      for (;;) {
        try { Thread.sleep(5000); } catch (InterruptedException e) { return; }
        if (busy.get() == 0 && System.currentTimeMillis() - lastUse > idleMs) quit(state);
      }
    });
    idle.setDaemon(true);
    idle.start();
    for (;;) {
      Socket s = ss.accept();
      new Thread(() -> serve(s, state)).start();
    }
  }

  static void quit(Path state) {
    try { Files.deleteIfExists(state.resolve("port")); } catch (IOException e) { }
    // exit, not halt: with -XX:+AutoCreateSharedArchive the JVM writes its class archive now
    System.exit(0);
  }

  /** Load javac and compile once, so the first request is already warm. */
  static void warm(Path state) {
    try {
      Path dir = Files.createDirectories(state.resolve("warm"));
      Path src = dir.resolve("Warm.java");
      Files.write(src, ("import java.util.ArrayList;\nimport java.util.Scanner;\npublic class Warm {\n  private final ArrayList<Integer> xs = new ArrayList<>();\n"
          + "  int sum() { int s = 0; for (int x : xs) s += x; return s; }\n"
          + "  public static void main(String[] args) {\n    Warm w = new Warm();\n    for (int i = 0; i < 10; i++) w.xs.add(i);\n"
          + "    String s = \"sum \" + w.sum() + \" \" + Math.sqrt(2.0);\n    System.out.println(s.toUpperCase());\n"
          + "    Scanner in = new Scanner(System.in);\n    if (args.length > 3 && in.hasNextInt()) System.out.printf(\"%d%n\", in.nextInt());\n  }\n}\n").getBytes(StandardCharsets.UTF_8));
      DataOutputStream sink = new DataOutputStream(new ByteArrayOutputStream());
      for (int i = 0; i < 2; i++) compile(dir.toString(), "", List.of(src.toString()), sink);
    } catch (Throwable e) { }
  }

  static final Set<String> PATH_OPTS = new HashSet<>(Arrays.asList("-d", "-s", "-h"));
  static final Set<String> PATHLIST_OPTS = new HashSet<>(Arrays.asList("-cp", "-classpath", "--class-path", "-sourcepath", "--source-path",
      "-p", "--module-path", "--processor-path", "-processorpath", "--module-source-path", "--processor-module-path", "--upgrade-module-path", "--system"));

  static String abs(String cwd, String p) {
    if (p.isEmpty() || p.startsWith("/")) return p;
    return Paths.get(cwd, p).normalize().toString();
  }

  static String absList(String cwd, String list) {
    String[] parts = list.split(":", -1);
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < parts.length; i++) {
      if (i > 0) b.append(':');
      b.append(parts[i].isEmpty() ? cwd : abs(cwd, parts[i]));
    }
    return b.toString();
  }

  static List<Path> paths(String cwd, String list) {
    List<Path> out = new ArrayList<>();
    for (String p : absList(cwd, list).split(":")) out.add(Paths.get(p));
    return out;
  }

  static final JavacTaskPool POOL = new JavacTaskPool(3);
  static final JavacTool TOOL = JavacTool.create();
  static final StandardJavaFileManager FM = TOOL.getStandardFileManager(null, null, null);

  /**
   * javac ARGS as run in `cwd`. Returns javac's exit status, or 127 for a command line this
   * does not take.
   *
   * The compiler's context (its symbol table, with java.lang and java.util already read)
   * is kept between compiles in a JavacTaskPool, as jshell does: a one-file compile in a
   * warm JVM then runs about a twentieth of the bytecodes. A context is reused for equal
   * options only, so the paths that change with the directory (-cp, -d) are set on the
   * file manager instead of being passed as options. scripts/java/test.sh compares this
   * with the real javac over a sequence of edits.
   */
  static synchronized int compile(String cwd, String classpath, List<String> args, DataOutputStream out) throws IOException {
    List<String> opts = new ArrayList<>(), files = new ArrayList<>();
    String cp = classpath.isEmpty() ? "." : classpath, dir = null;
    // "a" + b compiled to StringBuilder calls, not an invokedynamic call: the first
    // concatenation of each shape otherwise makes the JVM spin classes at run time,
    // 1.4 s of a small program's 3 under the emulator (src/java-defaults.ts does the
    // same for the real javac, so both write the same class files)
    String concat = "-XDstringConcat=inline";
    StringWriter w = new StringWriter();
    int[] count = new int[2];
    boolean ok;
    // One file manager for every compile, as the pool expects (a kept context's class
    // finder goes on using the file manager it was made with); its paths are set each time.
    StandardJavaFileManager fm = FM;
    try {
      for (int i = 0; i < args.size(); i++) {
        String x = args.get(i);
        if (x.startsWith("@") || x.startsWith("-J") || x.isEmpty()) return 127;
        if (!x.startsWith("-")) { if (!x.endsWith(".java")) return 127; files.add(abs(cwd, x)); continue; }
        if (x.startsWith("--class-path=")) { cp = x.substring(13); continue; }
        if (x.startsWith("-XDstringConcat=")) { concat = x; continue; }
        if (FLAGS.contains(x) || x.startsWith("-Xlint") || x.startsWith("-g:") || x.startsWith("-Xdiags:")) { opts.add(x); continue; }
        // anything else (-version, --release, modules, processors, a typo): the real javac
        if (!VALUE_OPTS.contains(x) || i + 1 >= args.size()) return 127;
        String v = args.get(++i);
        if (x.equals("-d")) dir = abs(cwd, v);
        else if (x.equals("-encoding") || x.equals("-Xmaxerrs") || x.equals("-Xmaxwarns")) { opts.add(x); opts.add(v); }
        else cp = v;
      }
      if (files.isEmpty()) return 127;
      opts.add(concat);
      for (String f : files) {
        // javac's own message for a missing file; a module declaration is not for a kept context
        if (!Files.isRegularFile(Paths.get(f)) || f.endsWith("/module-info.java")) return 127;
      }
      List<Path> cps = paths(cwd, cp);
      // directories only: an archive's index would be kept, and the jar may be rebuilt
      for (Path p : cps) if (Files.exists(p) && !Files.isDirectory(p)) return 127;
      if (dir != null && !Files.isDirectory(Paths.get(dir))) {
        if (Files.exists(Paths.get(dir))) return 127;
        Files.createDirectories(Paths.get(dir)); // as javac does
      }
      fm.flush(); // no listing or file content from the last compile
      fm.setLocationFromPaths(StandardLocation.CLASS_PATH, cps);
      // (null, through the File form: no output directory, so classes go beside their sources.
      // The source path is never set: once set it can't be unset, and javac then stops
      // looking for sources on the class path. -sourcepath goes to the real javac.)
      if (dir != null) fm.setLocationFromPaths(StandardLocation.CLASS_OUTPUT, List.of(Paths.get(dir)));
      else fm.setLocation(StandardLocation.CLASS_OUTPUT, null);
      // The pool's log needs a listener; this one writes what javac's own log would
      Log[] log = new Log[1];
      DiagnosticListener<JavaFileObject> listener = d -> {
        if (d.getKind() == Diagnostic.Kind.ERROR) count[0]++;
        else if (d.getKind() == Diagnostic.Kind.WARNING || d.getKind() == Diagnostic.Kind.MANDATORY_WARNING) count[1]++;
        w.write(d instanceof ClientCodeWrapper.DiagnosticSourceUnwrapper u && log[0] != null
            ? log[0].getDiagnosticFormatter().format(u.d, Locale.getDefault()) : d.toString());
        w.write('\n');
      };
      ok = POOL.getTask(w, fm, listener, opts, null, fm.getJavaFileObjectsFromStrings(files), task -> {
        Context ctx = ((BasicJavacTask) task).getContext();
        log[0] = Log.instance(ctx);
        try { return task.call(); } finally { forgetUserClasses(ctx); }
      });
    } catch (RuntimeException | Error e) {
      e.printStackTrace(); // this JVM's log; the real javac compiles it
      return 127;
    }
    if (count[0] > 0) w.write(count[0] + (count[0] == 1 ? " error\n" : " errors\n"));
    if (count[1] > 0) w.write(count[1] + (count[1] == 1 ? " warning\n" : " warnings\n"));
    // messages name files the way the user did
    String text = w.toString().replace(cwd.endsWith("/") ? cwd : cwd + "/", "");
    new Frames(out, 2).write(text.getBytes(StandardCharsets.UTF_8));
    return ok ? 0 : 1;
  }

  /** Options with no value that a kept context takes (and -Xlint..., -g:..., -Xdiags:...). */
  static final Set<String> FLAGS = new HashSet<>(Arrays.asList("-g", "-nowarn", "-deprecation", "-Werror", "-parameters", "-proc:none"));
  /** Options with a value that it takes. */
  static final Set<String> VALUE_OPTS = new HashSet<>(Arrays.asList("-cp", "-classpath", "--class-path", "-d", "-encoding", "-Xmaxerrs", "-Xmaxwarns"));

  /**
   * The pool keeps a context's whole symbol table and drops only the classes of the files
   * just compiled. This drops the rest of what came from the user's directories: every
   * class of the unnamed module (read from a .class file, or from a .java file found on
   * the class path), and what its packages hold. The next compile reads the directories
   * again, so a class file that was rebuilt, deleted or is in another directory is seen
   * as it is now. Only the JDK's own classes stay.
   */
  static void forgetUserClasses(Context ctx) {
    Symtab syms = Symtab.instance(ctx);
    ClassFinder finder = ClassFinder.instance(ctx);
    List<Symbol.ClassSymbol> drop = new ArrayList<>();
    for (Symbol.ClassSymbol c : syms.getAllClasses()) {
      Symbol.ModuleSymbol m = c.packge().modle;
      if (m == syms.unnamedModule || m == syms.noModule || m == null) drop.add(c);
    }
    for (Symbol.ClassSymbol c : drop) syms.removeClass(c.packge().modle, c.flatname);
    for (Symbol s : syms.unnamedModule.enclosedPackages) {
      Symbol.PackageSymbol p = (Symbol.PackageSymbol) s;
      if (p.modle != syms.unnamedModule) continue; // the root package is on the list too
      p.members_field = null;
      p.package_info = null;
      p.sourcefile = null;
      if (p != syms.unnamedModule.unnamedPackage) p.flags_field &= ~Flags.EXISTS;
      p.completer = finder.getCompleter();
    }
  }

  /** javac's arguments as they mean in `cwd`, for the measurement ops: this JVM's own directory is somewhere else. */
  static List<String> plainArgs(String cwd, String classpath, List<String> args) {
    List<String> out = new ArrayList<>();
    boolean cp = false;
    for (int i = 0; i < args.size(); i++) {
      String x = args.get(i);
      if (PATH_OPTS.contains(x) && i + 1 < args.size()) { out.add(x); out.add(abs(cwd, args.get(++i))); continue; }
      if (PATHLIST_OPTS.contains(x) && i + 1 < args.size()) {
        if (x.equals("-cp") || x.equals("-classpath") || x.equals("--class-path")) cp = true;
        out.add(x); out.add(absList(cwd, args.get(++i))); continue;
      }
      out.add(!x.startsWith("-") && x.endsWith(".java") ? abs(cwd, x) : x);
    }
    if (!cp) { out.add(0, absList(cwd, classpath.isEmpty() ? "." : classpath)); out.add(0, "-cp"); }
    return out;
  }

  /** An OutputStream that sends each write as a frame. */
  static final class Frames extends OutputStream {
    final DataOutputStream out; final int kind;
    Frames(DataOutputStream out, int kind) { this.out = out; this.kind = kind; }
    @Override public void write(int b) throws IOException { write(new byte[] {(byte) b}, 0, 1); }
    @Override public void write(byte[] b, int off, int len) throws IOException {
      if (len <= 0) return;
      synchronized (out) { out.writeByte(kind); out.writeInt(len); out.write(b, off, len); out.flush(); }
    }
  }

  /** The client's stdin frames as a stream. */
  static final class FrameIn extends InputStream {
    final DataInputStream in; int left = 0; boolean eof = false;
    FrameIn(DataInputStream in) { this.in = in; }
    @Override public int read() throws IOException { byte[] b = new byte[1]; return read(b, 0, 1) < 0 ? -1 : b[0] & 255; }
    @Override public synchronized int read(byte[] b, int off, int len) throws IOException {
      if (eof) return -1;
      if (left == 0) {
        try { left = in.readInt(); } catch (IOException e) { left = 0; }
        if (left <= 0) { eof = true; return -1; }
      }
      int n = in.read(b, off, Math.min(len, left));
      if (n < 0) { eof = true; return -1; }
      left -= n;
      return n;
    }
  }

  static final class Exit extends SecurityException { final int code; Exit(int code) { super("exit"); this.code = code; } }

  static final Object RUN = new Object();

  static void serve(Socket s, Path state) {
    busy.incrementAndGet();
    try (Socket sock = s) {
      sock.setTcpNoDelay(true);
      DataInputStream in = new DataInputStream(new BufferedInputStream(sock.getInputStream()));
      DataOutputStream out = new DataOutputStream(new BufferedOutputStream(sock.getOutputStream()));
      int op = in.readUnsignedByte();
      String cwd = Paths.get(in.readUTF()).normalize().toString(), classpath = in.readUTF();
      int n = in.readInt();
      List<String> args = new ArrayList<>();
      for (int i = 0; i < n; i++) args.add(in.readUTF());
      int status;
      if (op == 'p') status = 0;
      else if (op == 'q') { done(out, 0); quit(state); return; }
      else if (op == 'c') status = compile(cwd, classpath, args, out);
      else if (op == 'm') { // javac with a new context each time
        StringWriter w = new StringWriter();
        status = com.sun.tools.javac.Main.compile(plainArgs(cwd, classpath, args).toArray(new String[0]), new PrintWriter(w));
        new Frames(out, 2).write(w.toString().replace(cwd + "/", "").getBytes(StandardCharsets.UTF_8));
      } else if (op == 'e') { // ECJ, when ecj.jar is on the class path
        List<String> eargs = plainArgs(cwd, classpath, args);
        eargs.add(0, "-21");
        StringWriter w = new StringWriter();
        Object ok = Class.forName("org.eclipse.jdt.core.compiler.batch.BatchCompiler")
            .getMethod("compile", String[].class, PrintWriter.class, PrintWriter.class, Class.forName("org.eclipse.jdt.core.compiler.CompilationProgress"))
            .invoke(null, eargs.toArray(new String[0]), new PrintWriter(w), new PrintWriter(w), null);
        new Frames(out, 2).write(w.toString().replace(cwd + "/", "").getBytes(StandardCharsets.UTF_8));
        status = Boolean.TRUE.equals(ok) ? 0 : 1;
      } else if (op == 'r') {
        synchronized (RUN) { status = run(cwd, classpath, args, in, out); }
      } else status = 2;
      done(out, status);
    } catch (Throwable e) {
      // the client went away, or sent something else: nothing to answer
    } finally {
      busy.decrementAndGet();
      lastUse = System.currentTimeMillis();
    }
  }

  static void done(DataOutputStream out, int status) throws IOException {
    synchronized (out) { out.writeByte(0); out.writeInt(status); out.flush(); }
  }

  /**
   * `java -cp CP Main args...` in this JVM (args[0] is the class). Measurement only:
   * a program that loops can't be stopped here, so tabcomputer runs programs in a JVM of their own.
   */
  @SuppressWarnings({"deprecation", "removal"})
  static int run(String cwd, String classpath, List<String> args, DataInputStream in, DataOutputStream out) {
    PrintStream so = System.out, se = System.err;
    InputStream si = System.in;
    PrintStream o = new PrintStream(new Frames(out, 1), true), e = new PrintStream(new Frames(out, 2), true);
    try {
      List<URL> urls = new ArrayList<>();
      for (Path p : paths(cwd, classpath.isEmpty() ? "." : classpath)) urls.add(p.toUri().toURL());
      URLClassLoader cl = new URLClassLoader(urls.toArray(new URL[0]), ClassLoader.getPlatformClassLoader());
      System.setOut(o); System.setErr(e); System.setIn(new FrameIn(in));
      try {
        System.setSecurityManager(new SecurityManager() {
          @Override public void checkExit(int code) { throw new Exit(code); }
          @Override public void checkPermission(java.security.Permission p) { }
        });
      } catch (Throwable t) { }
      Class<?> c = Class.forName(args.get(0), true, cl);
      Method m = c.getMethod("main", String[].class);
      m.setAccessible(true);
      m.invoke(null, (Object) args.subList(1, args.size()).toArray(new String[0]));
      return 0;
    } catch (InvocationTargetException t) {
      Throwable x = t.getCause();
      if (x instanceof Exit) return ((Exit) x).code;
      e.print("Exception in thread \"main\" ");
      x.printStackTrace(e);
      return 1;
    } catch (ClassNotFoundException t) {
      e.println("Error: Could not find or load main class " + args.get(0));
      return 1;
    } catch (Throwable t) {
      e.println("Error: " + t);
      return 1;
    } finally {
      o.flush(); e.flush();
      try { System.setSecurityManager(null); } catch (Throwable t) { }
      System.setOut(so); System.setErr(se); System.setIn(si);
    }
  }
}
