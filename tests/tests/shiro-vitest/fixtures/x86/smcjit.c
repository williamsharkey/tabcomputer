// Fixture for x86-smc.test.ts: code that is rewritten while Blink's wasm JIT
// holds a compiled copy of it (vendor/blink patch 0553, code on writable
// pages). Each case checks itself, prints "<case> ok" and exits 0, or prints
// what it got and exits 1.
// Build: gcc -static -O1 -mno-red-zone -pthread -o smcjit smcjit.c
//   ./smcjit overwrite   a hot function in an RWX page is overwritten and called again
//   ./smcjit patchimm    an immediate inside a hot loop is patched by a function the loop calls
//   ./smcjit codedata    code and the data it writes on one page, then the code is rewritten
//   ./smcjit straddle    an instruction across two pages, patched by one store across them
//   ./smcjit wx          mprotect RW -> RX -> RW cycles, and RWX -> RX -> RWX
//   ./smcjit refill      a code buffer filled, run, and refilled with other code
//   ./smcjit thread      a second thread rewrites what the first is running
//   ./smcjit sysread     read() and pread() put new code in the page
//   ./smcjit madvise     MADV_DONTNEED zeroes a page of compiled code
//   ./smcjit fuzz [n]    random rewrites and calls against a model
//   ./smcjit bench [n]   times a loop in an RWX page (not a test)
#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

typedef int (*fn_t)(int);

#define RWX (PROT_READ | PROT_WRITE | PROT_EXEC)

static unsigned char *page_rwx(size_t n) {
  unsigned char *p = mmap(0, n, RWX, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) {
    perror("mmap");
    exit(2);
  }
  return p;
}

// mov $imm32, %eax; add %edi, %eax; ret   (8 bytes; the immediate at +1)
static void emit(unsigned char *p, int imm) {
  p[0] = 0xb8;
  memcpy(p + 1, &imm, 4);
  p[5] = 0x01;
  p[6] = 0xf8;
  p[7] = 0xc3;
}

// hot enough to be compiled: the callee's entry is a branch target
static __attribute__((noinline)) long hot(fn_t f, int n) {
  long s = 0;
  for (int i = 0; i < n; ++i) s += f(i & 7);
  return s;
}

// what hot() returns for a function that adds `imm`
static long want(int imm, int n) {
  long s = 0;
  for (int i = 0; i < n; ++i) s += imm + (i & 7);
  return s;
}

static int check(const char *what, long got, long exp) {
  if (got == exp) return 0;
  printf("%s: got %ld, expected %ld\n", what, got, exp);
  return 1;
}

static int overwrite(void) {
  int bad = 0;
  unsigned char *p = page_rwx(4096);
  for (int round = 0; round < 12; ++round) {
    emit(p + 64, 1000 * (round + 1));
    bad |= check("overwrite", hot((fn_t)(p + 64), 20000), want(1000 * (round + 1), 20000));
  }
  // only the immediate, one byte at a time
  for (int round = 0; round < 12; ++round) {
    int imm = 77000 + round * 257;
    for (int i = 0; i < 4; ++i) ((volatile unsigned char *)p)[64 + 1 + i] = imm >> (i * 8);
    bad |= check("overwrite bytes", hot((fn_t)(p + 64), 20000), want(imm, 20000));
  }
  if (!bad) puts("overwrite ok");
  return bad;
}

// The loop below lives in an RWX page and calls `cb` every 1024 passes; cb
// adds one to the loop's own immediate.
//   push rbx; push r12; push r13; push r14; push r15
//   mov rbx, rdi; mov r12, rsi; mov r13, rdx; xor r14d, r14d
// loop:
//   add r14, imm32
//   test ebx, 0x3ff
//   jnz skip
//   mov rdi, r13
//   call r12
// skip:
//   dec rbx
//   jnz loop
//   mov rax, r14; pop r15; pop r14; pop r13; pop r12; pop rbx; ret
#define LOOP_IMM 24
static const unsigned char kLoop[] = {
    0x53, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57,        // pushes
    0x48, 0x89, 0xfb, 0x49, 0x89, 0xf4, 0x49, 0x89, 0xd5,        // movs
    0x45, 0x31, 0xf6,                                            // xor r14d, r14d
    0x49, 0x81, 0xc6, 0, 0, 0, 0,                                // add r14, imm32 (imm at +24)
    0xf7, 0xc3, 0xff, 0x03, 0x00, 0x00,                          // test ebx, 0x3ff
    0x75, 0x06,                                                  // jnz skip
    0x4c, 0x89, 0xef,                                            // mov rdi, r13
    0x41, 0xff, 0xd4,                                            // call r12
    0x48, 0xff, 0xcb,                                            // dec rbx
    0x75, 0xe6,                                                  // jnz loop
    0x4c, 0x89, 0xf0,                                            // mov rax, r14
    0x41, 0x5f, 0x41, 0x5e, 0x41, 0x5d, 0x41, 0x5c, 0x5b, 0xc3,  // pops, ret
};

static __attribute__((noinline)) void bump(void *imm) {
  int v;
  memcpy(&v, imm, 4);
  ++v;
  memcpy(imm, &v, 4);
}

static int patchimm(void) {
  unsigned char *p = page_rwx(4096);
  long (*loop)(long, void (*)(void *), void *) = (void *)(p + 256);
  long n = 400000, exp = 0, got;
  int imm = 5;
  memcpy(p + 256, kLoop, sizeof(kLoop));
  memcpy(p + 256 + LOOP_IMM, &imm, 4);
  for (long i = n; i > 0; --i) {
    exp += imm;
    if (!(i & 0x3ff)) ++imm;
  }
  got = loop(n, bump, p + 256 + LOOP_IMM);
  if (check("patchimm", got, exp)) return 1;
  puts("patchimm ok");
  return 0;
}

static int codedata(void) {
  int bad = 0;
  unsigned char *p = page_rwx(4096);
  // the counter far from the code (another 64-byte piece), then right behind it
  for (int near = 0; near < 2; ++near) {
    unsigned char *f = p + (near ? 512 : 128);
    long *ctr = (long *)(near ? f + 24 : p + 2048);
    for (int round = 0; round < 3; ++round) {
      int step = 1 + round * 3;
      int disp = (int)((unsigned char *)ctr - (f + 12));
      // mov $step, %eax ; add %rax, ctr(%rip) ; mov ctr(%rip), %rax ; ret
      f[0] = 0xb8;
      memcpy(f + 1, &step, 4);
      f[5] = 0x48, f[6] = 0x01, f[7] = 0x05;
      memcpy(f + 8, &disp, 4);
      disp = (int)((unsigned char *)ctr - (f + 19));
      f[12] = 0x48, f[13] = 0x8b, f[14] = 0x05;
      memcpy(f + 15, &disp, 4);
      f[19] = 0xc3;
      *ctr = 0;
      long last = 0;
      for (int i = 0; i < 30000; ++i) last = ((long (*)(void))f)();
      bad |= check(near ? "codedata near" : "codedata far", last, 30000L * step);
      bad |= check(near ? "codedata near ctr" : "codedata far ctr", *ctr, 30000L * step);
    }
  }
  if (!bad) puts("codedata ok");
  return bad;
}

static __attribute__((noinline)) void store32(void *p, int v) {
  memcpy(p, &v, 4);
}
static __attribute__((noinline)) void store64(void *p, uint64_t v) {
  memcpy(p, &v, 8);
}

static int straddle(void) {
  int bad = 0;
  unsigned char *p = page_rwx(8192);
  // mov $imm, %eax at 4094: the opcode in the first page, the immediate
  // across the boundary (4095..4098)
  unsigned char *f = p + 4094;
  emit(f, 0);
  for (int round = 0; round < 10; ++round) {
    int imm = 100000 + round * 0x01010101;
    store32(p + 4095, imm);  // one store, two pages
    bad |= check("straddle imm", hot((fn_t)f, 20000), want(imm, 20000));
  }
  // a function wholly in the second page, rewritten by an 8-byte store that
  // starts in the first: nops at 4093..4095, the function at 4096
  memset(p + 4080, 0x90, 16);
  unsigned char *g = p + 4096;
  for (int round = 0; round < 10; ++round) {
    int imm = 500 + round * 77777;
    unsigned char code[8] = {0x90, 0x90, 0x90, 0xb8};
    uint64_t w;
    memcpy(code + 4, &imm, 4);
    memcpy(&w, code, 8);
    g[5] = 0x01, g[6] = 0xf8, g[7] = 0xc3;
    store64(p + 4093, w);  // nop nop nop | mov $imm, %eax
    bad |= check("straddle store", hot((fn_t)g, 20000), want(imm, 20000));
  }
  // entered in the first page, falling through into the second
  memset(p + 4000, 0x90, 96);
  for (int round = 0; round < 6; ++round) {
    int imm = 9000 + round;
    emit(p + 4096 + 8, imm);
    memset(p + 4096, 0x90, 8);
    bad |= check("straddle fallthrough", hot((fn_t)(p + 4000), 20000), want(imm, 20000));
  }
  if (!bad) puts("straddle ok");
  return bad;
}

static int wx(void) {
  int bad = 0;
  unsigned char *p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  for (int round = 0; round < 12; ++round) {
    int imm = 3000 + round * 11;
    emit(p + 32, imm);
    mprotect(p, 4096, PROT_READ | PROT_EXEC);
    bad |= check("wx rw/rx", hot((fn_t)(p + 32), 20000), want(imm, 20000));
    mprotect(p, 4096, PROT_READ | PROT_WRITE);
  }
  unsigned char *q = page_rwx(4096);
  for (int round = 0; round < 12; ++round) {
    int imm = 8000 + round * 13;
    emit(q + 32, imm);
    bad |= check("wx rwx", hot((fn_t)(q + 32), 20000), want(imm, 20000));
    mprotect(q, 4096, PROT_READ | PROT_EXEC);
    bad |= check("wx rwx->rx", hot((fn_t)(q + 32), 20000), want(imm, 20000));
    mprotect(q, 4096, RWX);
    emit(q + 32, imm + 1);
    bad |= check("wx rx->rwx", hot((fn_t)(q + 32), 20000), want(imm + 1, 20000));
  }
  if (!bad) puts("wx ok");
  return bad;
}

static unsigned rnd_state = 12345;
static unsigned rnd(void) {
  rnd_state = rnd_state * 1664525u + 1013904223u;
  return rnd_state >> 8;
}

// a code buffer filled with small functions at changing offsets, run, and
// filled again, as a JIT does when it flushes its cache
static int refill(void) {
  enum { N = 96, SIZE = 16384 };
  int bad = 0;
  unsigned char *p = page_rwx(SIZE), *tmp = malloc(SIZE);
  for (int round = 0; round < 8 && !bad; ++round) {
    int off[N], imm[N], at = rnd() % 40;
    memset(tmp, 0xcc, SIZE);
    for (int i = 0; i < N; ++i) {
      int pad = rnd() % 24;
      memset(tmp + at, 0x90, pad);
      off[i] = at;
      imm[i] = (int)(rnd() % 1000000);
      emit(tmp + at + pad, imm[i]);
      at += pad + 8 + rnd() % 120;
    }
    if (round & 1) {
      memcpy(p, tmp, SIZE);
    } else {
      for (int i = 0; i < SIZE; ++i) ((volatile unsigned char *)p)[i] = tmp[i];
    }
    for (int pass = 0; pass < 2; ++pass) {
      for (int i = 0; i < N; ++i) {
        bad |= check("refill", hot((fn_t)(p + off[i]), 600), want(imm[i], 600));
      }
    }
  }
  free(tmp);
  if (!bad) puts("refill ok");
  return bad;
}

static unsigned char *g_code;
static atomic_int g_stage, g_ack, g_version;
static atomic_long g_calls;
static atomic_int g_bad;

static void *runner(void *arg) {
  fn_t f = (fn_t)g_code;
  int seen = 0;
  (void)arg;
  for (;;) {
    int stage = atomic_load(&g_stage);
    if (stage < 0) break;
    if (stage & 1) {  // the writer wants the code to itself
      atomic_store(&g_ack, stage);
      while (atomic_load(&g_stage) == stage) {
      }
      continue;
    }
    for (int i = 0; i < 512; ++i) {
      int v = f(0);
      if (v < seen) atomic_store(&g_bad, 1);  // an older version came back
      seen = v;
    }
    atomic_fetch_add(&g_calls, 512);
    // the version published before this batch began must be visible by now
    if (seen < atomic_load(&g_version) - 1) atomic_store(&g_bad, 2);
  }
  return 0;
}

static void wait_calls(long more) {
  long from = atomic_load(&g_calls);
  while (atomic_load(&g_calls) - from < more) usleep(200);
}

static int thread_case(void) {
  pthread_t t;
  int bad = 0, v = 1;
  g_code = page_rwx(4096);
  emit(g_code, v);
  atomic_store(&g_version, v);
  pthread_create(&t, 0, runner, 0);
  wait_calls(4096);
  // rewrites while the runner is parked
  for (int round = 0; round < 20; ++round) {
    int stage = round * 2 + 1;
    atomic_store(&g_stage, stage);
    while (atomic_load(&g_ack) != stage) usleep(100);
    emit(g_code, ++v);
    atomic_store(&g_version, v);
    atomic_store(&g_stage, stage + 1);
    wait_calls(2048);
  }
  // the immediate patched with one aligned-enough store while the runner
  // is calling the function
  for (int round = 0; round < 200; ++round) {
    store32(g_code + 1, ++v);
    atomic_store(&g_version, v);
    wait_calls(1024);
  }
  wait_calls(4096);
  atomic_store(&g_stage, -1);
  pthread_join(t, 0);
  bad |= check("thread last", hot((fn_t)g_code, 20000), want(v, 20000));
  if (atomic_load(&g_bad)) {
    printf("thread: the runner saw stale code (%d)\n", atomic_load(&g_bad));
    bad = 1;
  }
  if (!bad) puts("thread ok");
  return bad;
}

static int sysread(void) {
  int bad = 0, fds[2];
  unsigned char *p = page_rwx(4096), code[8];
  char name[] = "/tmp/smcjit-XXXXXX";
  int fd = mkstemp(name);
  if (pipe(fds) || fd < 0) {
    perror("pipe/mkstemp");
    return 1;
  }
  unlink(name);
  emit(p + 16, 1);
  bad |= check("sysread first", hot((fn_t)(p + 16), 20000), want(1, 20000));
  for (int round = 0; round < 8; ++round) {
    int imm = 4000 + round;
    emit(code, imm);
    if (round & 1) {
      if (pwrite(fd, code, 8, 0) != 8 || pread(fd, p + 16, 8, 0) != 8) bad = 1;
    } else {
      if (write(fds[1], code, 8) != 8 || read(fds[0], p + 16, 8) != 8) bad = 1;
    }
    bad |= check(round & 1 ? "sysread pread" : "sysread read", hot((fn_t)(p + 16), 20000), want(imm, 20000));
  }
  if (!bad) puts("sysread ok");
  return bad;
}

static __attribute__((noinline)) long call_rax(void *fn, long rax) {
  long r;
  __asm__ volatile("call *%%rcx" : "=a"(r) : "c"(fn), "a"(rax) : "rdx", "rsi", "rdi", "r8", "r9", "r10", "r11", "memory", "cc");
  return r;
}

static int madvise_case(void) {
  int bad = 0;
  static unsigned char scratch[16];
  unsigned char *p = page_rwx(8192);
  long s = 0;
  // mov $7, %eax; ret
  p[0] = 0xb8, p[1] = 7, p[2] = 0, p[3] = 0, p[4] = 0, p[5] = 0xc3;
  // the second page: mov $9, %eax; ret
  p[4096] = 0xb8, p[4097] = 9, p[4098] = 0, p[4099] = 0, p[4100] = 0, p[4101] = 0xc3;
  for (int i = 0; i < 20000; ++i) s += call_rax(p, (long)scratch);
  bad |= check("madvise before", s, 7 * 20000L);
  if (madvise(p, 4096, MADV_DONTNEED)) perror("madvise");
  // the page is zeros now: 2048 times `add %al, (%rax)`, then the second page
  s = 0;
  for (int i = 0; i < 300; ++i) s += call_rax(p, (long)scratch);
  bad |= check("madvise after", s, 9 * 300L);
  if (!bad) puts("madvise ok");
  return bad;
}

// Random rewrites and calls against a model. Slots overlap 64-byte pieces
// with their neighbours and move inside their own space; writes go a byte
// at a time, as one store, or through memcpy; some only touch the gaps.
static int fuzz(int ops) {
  enum { SLOTS = 48, SPACE = 160, PAGES = 2 };
  unsigned char *p = page_rwx(PAGES * 4096);
  int imm[SLOTS], pos[SLOTS], bad = 0;
  unsigned long sum = 0;
  memset(p, 0xcc, PAGES * 4096);
  for (int i = 0; i < SLOTS; ++i) {
    pos[i] = rnd() % (SPACE - 8);
    imm[i] = (int)rnd();
    emit(p + i * SPACE + pos[i], imm[i]);
  }
  for (int op = 0; op < ops && !bad; ++op) {
    int k = rnd() % SLOTS, how = rnd() % 10;
    unsigned char *base = p + k * SPACE;
    if (how < 5) {
      int n = how < 2 ? 1 + rnd() % 8 : 250 + rnd() % 400;
      long got = hot((fn_t)(base + pos[k]), n);
      if (got != want(imm[k], n)) {
        printf("fuzz: op %d slot %d at %p: got %ld, expected %ld\n", op, k, (void *)(base + pos[k]), got, want(imm[k], n));
        bad = 1;
      }
      sum = sum * 31 + (unsigned long)got;
    } else if (how < 7) {  // a new immediate in place
      imm[k] = (int)rnd();
      if (how == 5) {
        store32(base + pos[k] + 1, imm[k]);
      } else {
        for (int i = 0; i < 4; ++i) ((volatile unsigned char *)base)[pos[k] + 1 + i] = imm[k] >> (i * 8);
      }
    } else if (how < 9) {  // the function moves inside its slot
      unsigned char tmp[SPACE];
      memset(tmp, 0xcc, SPACE);
      pos[k] = rnd() % (SPACE - 8);
      imm[k] = (int)rnd();
      emit(tmp + pos[k], imm[k]);
      if (how == 7) {
        memcpy(base, tmp, SPACE);
      } else {
        for (int i = 0; i < SPACE; ++i) ((volatile unsigned char *)base)[i] = tmp[i];
      }
    } else {  // a write that only touches the bytes around the function
      int at = rnd() % SPACE;
      if (at < pos[k] || at >= pos[k] + 8) ((volatile unsigned char *)base)[at] = rnd();
    }
  }
  if (!bad) printf("fuzz ok %lx\n", sum);
  return bad;
}

// How fast code in an RWX page runs: `n` passes of a small loop, in ms.
//   xor eax, eax; xor ecx, ecx
// loop:
//   mov rdx, rcx; imul rdx, rcx; add rax, rdx
//   mov rsi, rax; shr rsi, 3; xor rax, rsi
//   inc rcx; cmp rcx, rdi; jb loop
//   ret
static int bench(long n) {
  static const unsigned char kBench[] = {
      0x31, 0xc0, 0x31, 0xc9, 0x48, 0x89, 0xca, 0x48, 0x0f, 0xaf, 0xd1, 0x48, 0x01, 0xd0, 0x48, 0x89,
      0xc6, 0x48, 0xc1, 0xee, 0x03, 0x48, 0x31, 0xf0, 0x48, 0xff, 0xc1, 0x48, 0x39, 0xf9, 0x72, 0xe4, 0xc3,
  };
  unsigned char *p = page_rwx(4096);
  struct timespec a, b;
  unsigned long r, x = 0;
  memcpy(p + 64, kBench, sizeof(kBench));
  clock_gettime(CLOCK_MONOTONIC, &a);
  r = ((unsigned long (*)(long))(p + 64))(n);
  clock_gettime(CLOCK_MONOTONIC, &b);
  for (long i = 0; i < n; ++i) x += i * i, x ^= x >> 3;
  printf("bench %ld passes %.1f ms %s\n", n, (b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6, r == x ? "ok" : "WRONG");
  return r != x;
}

int main(int argc, char **argv) {
  const char *what = argc > 1 ? argv[1] : "";
  setvbuf(stdout, 0, _IOLBF, 0);
  if (!strcmp(what, "overwrite")) return overwrite();
  if (!strcmp(what, "patchimm")) return patchimm();
  if (!strcmp(what, "codedata")) return codedata();
  if (!strcmp(what, "straddle")) return straddle();
  if (!strcmp(what, "wx")) return wx();
  if (!strcmp(what, "refill")) return refill();
  if (!strcmp(what, "thread")) return thread_case();
  if (!strcmp(what, "sysread")) return sysread();
  if (!strcmp(what, "madvise")) return madvise_case();
  if (!strcmp(what, "fuzz")) return fuzz(argc > 2 ? atoi(argv[2]) : 6000);
  if (!strcmp(what, "bench")) return bench(argc > 2 ? atol(argv[2]) : 20000000);
  fprintf(stderr, "usage: smcjit overwrite|patchimm|codedata|straddle|wx|refill|thread|sysread|madvise|fuzz [n]\n");
  return 2;
}
