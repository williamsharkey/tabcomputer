// What compiled code costs per call/return, per memory access and per
// instruction: small non-inlined functions (C++ code is full of them), a
// loop over memory, and a register-only loop. Prints checksums (the same
// natively and under Blink) and, to stderr, the time of each.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

__attribute__((noinline)) uint64_t leaf(uint64_t x) { return x * 0x9E3779B97F4A7C15ull + 1; }
__attribute__((noinline)) uint64_t mid(uint64_t x) { return leaf(x) ^ (x >> 3); }

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e9 + t.tv_nsec;
}

static uint64_t buf[1 << 16];  // 512 KiB

int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 10000000, i;
  uint64_t a = 1;
  double t;
  for (i = 0; i < 100000; ++i) a = mid(a);  // warm up
  t = now();
  for (i = 0; i < n; ++i) a = mid(a);
  fprintf(stderr, "calls: %.1f ns per mid() (2 calls)\n", (now() - t) / n);
  printf("calls %016llx\n", (unsigned long long)a);
  t = now();
  for (i = 0; i < n; ++i) {
    uint64_t *p = &buf[(i * 40503) & 0xffff];
    *p += a;
    a ^= *p >> 5;
  }
  fprintf(stderr, "memory: %.1f ns per iteration (1 load, 1 store)\n", (now() - t) / n);
  printf("memory %016llx\n", (unsigned long long)a);
  t = now();
  for (i = 0; i < n; ++i) a = (a << 7 | a >> 57) + i;
  fprintf(stderr, "regs: %.1f ns per iteration\n", (now() - t) / n);
  printf("regs %016llx\n", (unsigned long long)a);
  return 0;
}
