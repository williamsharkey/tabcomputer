/* pbench: perf-bench-style microbenchmarks, built static and run under Blink
 * by bench/suites/x86.mjs (and natively, for the reference row). Each mode
 * prints "key=value" lines; times are CLOCK_MONOTONIC in the guest.
 * N = 0 or left out: picked so the run takes about PBENCH_MS (500) ms.
 *   pbench syscall N             N getppid() system calls (perf bench syscall basic)
 *   pbench pipe N                N one-byte round trips between two processes over
 *                                two pipes (perf bench sched pipe): wake-up cost
 *   pbench messaging G F L       hackbench: G groups of F senders and F receivers,
 *                                each sender writes L 100-byte messages to every
 *                                receiver of its group over pipes (perf bench sched messaging -p)
 *   pbench memcpy MB N           N glibc memcpy()s of an MB MiB buffer (pages touched first)
 *   pbench forkexec N            N fork + execv(self, "nop") + waitpid
 *   pbench nop                   exit 0 (forkexec's child)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/wait.h>

static double now_ns(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

static void die(const char *what) { perror(what); exit(1); }

static void result(const char *mode, long ops, double ns) {
  printf("mode=%s\nops=%ld\ntotal_ms=%.3f\nns_per_op=%.1f\n", mode, ops, ns / 1e6, ns / ops);
}

static double bench_syscall(long n) {
  long sum = 0;
  double t0 = now_ns();
  for (long i = 0; i < n; i++) sum += syscall(SYS_getppid);
  double t = now_ns() - t0;
  if (sum == 0) exit(1);
  return t;
}

static double bench_pipe(long n) {
  int a[2], b[2];
  char c = 'x';
  if (pipe(a) || pipe(b)) die("pipe");
  pid_t pid = fork();
  if (pid < 0) die("fork");
  if (pid == 0) {
    for (long i = 0; i < n; i++) {
      if (read(a[0], &c, 1) != 1) _exit(1);
      if (write(b[1], &c, 1) != 1) _exit(1);
    }
    _exit(0);
  }
  double t0 = now_ns();
  for (long i = 0; i < n; i++) {
    if (write(a[1], &c, 1) != 1) die("write");
    if (read(b[0], &c, 1) != 1) die("read");
  }
  double t = now_ns() - t0;
  int st;
  waitpid(pid, &st, 0);
  if (!WIFEXITED(st) || WEXITSTATUS(st)) { fprintf(stderr, "child failed\n"); exit(1); }
  return t;
}

#define MSG 100

static int write_all(int fd, const char *p, size_t n) {
  while (n) { ssize_t w = write(fd, p, n); if (w <= 0) return -1; p += w; n -= w; }
  return 0;
}

static int bench_messaging(int groups, int fds, int loops) {
  int nproc = groups * fds * 2;
  pid_t *pids = calloc(nproc, sizeof *pids);
  int ready[2], go[2];
  if (pipe(ready) || pipe(go)) die("pipe");
  int k = 0;
  double t0 = 0;
  for (int g = 0; g < groups; g++) {
    int (*in)[2] = calloc(fds, sizeof *in);
    for (int r = 0; r < fds; r++) if (pipe(in[r])) die("pipe");
    for (int r = 0; r < fds; r++) {  // receivers: read fds*loops messages from their pipe
      pid_t p = fork();
      if (p < 0) die("fork");
      if (p == 0) {
        char buf[MSG], c = 0;
        close(go[1]); close(ready[0]);
        for (int j = 0; j < fds; j++) close(in[j][1]);
        if (write(ready[1], &c, 1) != 1) _exit(1);
        if (read(go[0], &c, 1) < 0) _exit(1);
        long want = (long)fds * loops * MSG;
        while (want > 0) { ssize_t n = read(in[r][0], buf, want < MSG ? want : MSG); if (n <= 0) _exit(1); want -= n; }
        _exit(0);
      }
      pids[k++] = p;
    }
    for (int s = 0; s < fds; s++) {  // senders: loops rounds, one message to every receiver
      pid_t p = fork();
      if (p < 0) die("fork");
      if (p == 0) {
        char buf[MSG], c = 0;
        memset(buf, 'm', MSG);
        close(go[1]); close(ready[0]);
        for (int j = 0; j < fds; j++) close(in[j][0]);
        if (write(ready[1], &c, 1) != 1) _exit(1);
        if (read(go[0], &c, 1) < 0) _exit(1);
        for (int l = 0; l < loops; l++)
          for (int j = 0; j < fds; j++) if (write_all(in[j][1], buf, MSG)) _exit(1);
        _exit(0);
      }
      pids[k++] = p;
    }
    for (int r = 0; r < fds; r++) { close(in[r][0]); close(in[r][1]); }
    free(in);
  }
  char c;
  for (int i = 0; i < nproc; i++) if (read(ready[0], &c, 1) != 1) die("ready");
  t0 = now_ns();
  close(go[1]);  // EOF on go: everyone starts
  int bad = 0;
  for (int i = 0; i < nproc; i++) { int st; waitpid(pids[i], &st, 0); if (!WIFEXITED(st) || WEXITSTATUS(st)) bad++; }
  double t = now_ns() - t0;
  if (bad) { fprintf(stderr, "%d workers failed\n", bad); return 1; }
  long msgs = (long)groups * fds * fds * loops;
  result("messaging", msgs, t);
  printf("procs=%d\n", nproc);
  return 0;
}

static int bench_memcpy(long mb, long n) {
  size_t sz = (size_t)mb << 20;
  char *src = malloc(sz), *dst = malloc(sz);
  if (!src || !dst) die("malloc");
  memset(src, 1, sz);
  memset(dst, 0, sz);
  memcpy(dst, src, sz);  // warm: page faults and caches out of the timed loop
  double t0 = now_ns();
  for (long i = 0; i < n; i++) { src[i % sz] = (char)i; memcpy(dst, src, sz); }
  double t = now_ns() - t0;
  if (dst[0] != src[0]) return 1;
  result("memcpy", n, t);
  printf("MBps=%.1f\n", (double)sz * n / (1 << 20) / (t / 1e9));
  return 0;
}

static const char *self;
static double bench_forkexec(long n) {
  double t0 = now_ns();
  for (long i = 0; i < n; i++) {
    pid_t p = fork();
    if (p < 0) die("fork");
    if (p == 0) { execl(self, self, "nop", (char *)0); _exit(127); }
    int st;
    if (waitpid(p, &st, 0) != p || !WIFEXITED(st) || WEXITSTATUS(st)) { fprintf(stderr, "child %ld failed (%#x)\n", i, st); exit(1); }
  }
  return now_ns() - t0;
}

/* N given: one run of N. N = 0: double N until a run takes 1/8 of the target
 * (PBENCH_MS, default 500 ms), then one run scaled to the target. */
static int timed(const char *mode, double (*fn)(long), long n) {
  if (!n) {
    double target = (getenv("PBENCH_MS") ? atof(getenv("PBENCH_MS")) : 500) * 1e6, t;
    // each calibration run's per-op cost: shows whether the first calls cost more (warm-up)
    for (n = 1; (t = fn(n)) < target / 8; n *= 2) printf("calib_%ld=%.1f\n", n, t / n);
    printf("calib_%ld=%.1f\n", n, t / n);
    n = (long)(n * target / t) + 1;
  }
  result(mode, n, fn(n));
  return 0;
}

int main(int argc, char **argv) {
  const char *m = argc > 1 ? argv[1] : "";
  long a = argc > 2 ? atol(argv[2]) : 0, b = argc > 3 ? atol(argv[3]) : 0, c = argc > 4 ? atol(argv[4]) : 0;
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (!strcmp(m, "nop")) return 0;
  self = argv[0];
  if (!strcmp(m, "syscall")) return timed("syscall", bench_syscall, a);
  if (!strcmp(m, "pipe")) return timed("pipe", bench_pipe, a);
  if (!strcmp(m, "messaging")) return bench_messaging(a ? a : 1, b ? b : 10, c ? c : 100);
  if (!strcmp(m, "memcpy")) return bench_memcpy(a ? a : 64, b ? b : 10);
  if (!strcmp(m, "forkexec")) return timed("forkexec", bench_forkexec, a);
  fprintf(stderr, "usage: pbench syscall|pipe|messaging|memcpy|forkexec|nop [args]\n");
  return 2;
}
