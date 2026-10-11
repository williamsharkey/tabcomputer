// A threaded-code interpreter like JSC's LLInt: each handler does a little
// work and ends in an indirect jump through a table to the next one
// (`jmp *table(,%rax,8)`). Under Blink each handler is its own compiled
// region, so this measures what a region-to-region transfer costs.
// Prints a checksum (same natively and under Blink) and, to stderr, the
// time per dispatch.
#include <stdio.h>
#include <stdint.h>
#include <time.h>
#include <stdlib.h>

static uint8_t prog[4096];

static uint64_t run(long n) {
  static void *ops[4] = {&&op_add, &&op_xor, &&op_mul, &&op_shift};
  uint64_t acc = 1;
  long pc = 0;
  uint8_t op;
#define NEXT()                     \
  do {                             \
    if (--n < 0) return acc;       \
    op = prog[pc++ & 4095];        \
    goto *ops[op & 3];             \
  } while (0)
  NEXT();
op_add:
  acc += pc;
  NEXT();
op_xor:
  acc ^= acc >> 7;
  NEXT();
op_mul:
  acc *= 0x9E3779B97F4A7C15ull;
  NEXT();
op_shift:
  acc = (acc << 3) | (acc >> 61);
  NEXT();
}

int main(int argc, char **argv) {
  long n = argc > 1 ? atol(argv[1]) : 20000000;
  uint32_t x = 12345;
  struct timespec a, b;
  for (int i = 0; i < 4096; ++i) prog[i] = (x = x * 1103515245 + 12345) >> 16;
  run(100000);  // warm up (compile the handlers)
  clock_gettime(CLOCK_MONOTONIC, &a);
  uint64_t r = run(n);
  clock_gettime(CLOCK_MONOTONIC, &b);
  double ns = (b.tv_sec - a.tv_sec) * 1e9 + (b.tv_nsec - a.tv_nsec);
  printf("dispatch %ld: %016llx\n", n, (unsigned long long)r);
  fprintf(stderr, "%.1f ns per dispatch\n", ns / n);
  return 0;
}
