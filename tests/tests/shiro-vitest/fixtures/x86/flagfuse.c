// A flag producer, an instruction that writes no flags, then a flag
// consumer. The wasm JIT fuses cmp+setcc (the consumer recomputes the
// condition from the producer's operands, kept in locals), and movd and
// scalar SSE arithmetic used those locals as scratch: the consumer saw the
// wrong flags. Firefox's parser picked PreDecrement for `++i` (gui's
// repro, `cmpb; mov; movd; setne` in GeneralParser::unaryExpr).
// Each line prints how many of n calls gave a different result than the
// plain C comparison (0 natively, JIT on and off).
#include <stdio.h>
#include <stdlib.h>

#define V(name, body)                                                         \
  __attribute__((noinline)) static int name(unsigned char tt, int r11) {      \
    int r;                                                                    \
    volatile unsigned char slot[8];                                           \
    slot[3] = tt;                                                             \
    asm volatile(body "\n\tmovzbl %%r12b,%0"                                  \
                 : "=r"(r)                                                    \
                 : "r"(&slot[3]), "r"(r11)                                    \
                 : "cc", "r12", "rsi", "xmm6", "xmm7", "memory", "rax");      \
    return r;                                                                 \
  }

V(full, "xor %%r12d,%%r12d\n\tcmpb $6,(%1)\n\tmov $0x20,%%esi\n\tmovd %2,%%xmm6\n\tsetne %%r12b")
V(no_movd, "xor %%r12d,%%r12d\n\tcmpb $6,(%1)\n\tmov $0x20,%%esi\n\tsetne %%r12b")
V(movd_only, "cmpb $6,(%1)\n\tmovd %2,%%xmm6\n\tsetne %%r12b")
V(movd_reg, "movzbl (%1),%%eax\n\txor %%r12d,%%r12d\n\tcmp $6,%%al\n\tmovd %2,%%xmm6\n\tsetne %%r12b")
V(jne_movd, "xor %%r12d,%%r12d\n\tcmpb $6,(%1)\n\tmovd %2,%%xmm6\n\tjne 1f\n\tmov $7,%%r12d\n1:")
V(movq_out, "cmpb $6,(%1)\n\tmovq %%xmm6,%%rsi\n\tsetne %%r12b")
V(movq_xx, "cmpb $6,(%1)\n\tmovq %%xmm7,%%xmm6\n\tsetne %%r12b")
V(addsd, "cvtsi2sd %2,%%xmm6\n\tcvtsi2sd %2,%%xmm7\n\tcmpb $6,(%1)\n\taddsd %%xmm7,%%xmm6\n\tsetne %%r12b")
V(minss, "cvtsi2ss %2,%%xmm6\n\tcvtsi2ss %2,%%xmm7\n\tcmpb $6,(%1)\n\tminss %%xmm7,%%xmm6\n\tsetne %%r12b")
V(sqrtsd, "cvtsi2sd %2,%%xmm7\n\tcmpb $6,(%1)\n\tsqrtsd %%xmm7,%%xmm6\n\tsetne %%r12b")

typedef int (*F)(unsigned char, int);
static const struct {
  const char *n;
  F f;
  int ne;  // 1: setne; 2: jne over a mov $7
} T[] = {{"full", full, 1},         {"no_movd", no_movd, 1}, {"movd_only", movd_only, 1},
         {"movd_reg", movd_reg, 1}, {"jne_movd", jne_movd, 2}, {"movq_out", movq_out, 1},
         {"movq_xx", movq_xx, 1},   {"addsd", addsd, 1},     {"minss", minss, 1},
         {"sqrtsd", sqrtsd, 1}};

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 2000;
  for (unsigned t = 0; t < sizeof T / sizeof *T; t++) {
    int bad = 0;
    for (int i = 0; i < n; i++) {
      unsigned char tt = (i & 1) ? 6 : 7;
      int k = T[t].f(tt, i), eq = tt == 6;
      int want = T[t].ne == 1 ? !eq : (eq ? 7 : 0);
      bad += k != want;
    }
    printf("%-10s %d of %d wrong\n", T[t].n, bad, n);
  }
  return 0;
}
