// lock add/or/and/sub/xor, lock inc/dec, xadd and cmpxchg to memory, which
// the wasm JIT compiles as wasm atomics: their values and flags (AF too) at
// every width (a hash, the same natively, JIT on and off), threads hammering one
// counter of each kind, and misaligned operands (the interpreter's).
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t h = 1469598103934665603ull;
static void mix(uint64_t v) { h = (h ^ v) * 1099511628211ull; }

#define FLAGS(insn, w, mem, src)                                               \
  ({                                                                           \
    uint64_t f_;                                                               \
    asm volatile("lock " insn w " %2,%0\n\tpushfq\n\tpopq %1"                  \
                 : "+m"(mem), "=r"(f_)                                         \
                 : "ir"(src)                                                   \
                 : "cc");                                                      \
    f_ & 0x8d5;                                                                \
  })

static void widths(uint64_t a, uint64_t b) {
  static uint8_t m8;
  static uint16_t m16;
  static uint32_t m32;
  static uint64_t m64;
  uint8_t b8 = b;
  uint16_t b16 = b;
  uint32_t b32 = b;
  uint64_t f, r;
#define ALL(insn)                                                              \
  m8 = a, f = FLAGS(insn, "b", m8, b8), mix(m8), mix(f);                       \
  m16 = a, f = FLAGS(insn, "w", m16, b16), mix(m16), mix(f);                   \
  m32 = a, f = FLAGS(insn, "l", m32, b32), mix(m32), mix(f);                   \
  m64 = a, f = FLAGS(insn, "q", m64, (int64_t)(int32_t)b), mix(m64), mix(f);
  ALL("add") ALL("sub") ALL("and") ALL("or") ALL("xor")
  // inc/dec (CF untouched: set it first)
  m32 = a;
  asm volatile("stc\n\tlock incl %0\n\tpushfq\n\tpopq %1" : "+m"(m32), "=r"(f) :: "cc");
  mix(m32), mix(f & 0x8d5);
  m16 = a;
  asm volatile("clc\n\tlock decw %0\n\tpushfq\n\tpopq %1" : "+m"(m16), "=r"(f) :: "cc");
  mix(m16), mix(f & 0x8d5);
  m8 = a;
  asm volatile("lock decb %0\n\tsetz %b1\n\tmovzbl %b1,%k1" : "+m"(m8), "=q"(f) :: "cc");
  mix(m8), mix(f);
  m64 = a;
  asm volatile("lock incq %0\n\tsetz %b1\n\tmovzbl %b1,%k1" : "+m"(m64), "=q"(f) :: "cc");
  mix(m64), mix(f);
  // (not atomic, but the same AF rule as inc: the interpreter's)
  m16 = a;
  asm volatile("negw %0\n\tpushfq\n\tpopq %1" : "+m"(m16), "=r"(f) :: "cc");
  mix(m16), mix(f & 0x8d5);
  r = b;
  asm volatile("incq %0\n\tpushfq\n\tpopq %1" : "+r"(r), "=r"(f) :: "cc");
  mix(r), mix(f & 0x8d5);
  // xadd: the register gets the old value
  m32 = a, r = b;
  asm volatile("lock xaddl %k1,%0\n\tpushfq\n\tpopq %2" : "+m"(m32), "+r"(r), "=r"(f) :: "cc");
  mix(m32), mix(r), mix(f & 0x8d5);
  m8 = a, r = b;
  asm volatile("xaddb %b1,%0\n\tpushfq\n\tpopq %2" : "+m"(m8), "+q"(r), "=r"(f) :: "cc");
  mix(m8), mix(r), mix(f & 0x8d5);
  // cmpxchg: a match stores, a mismatch loads the accumulator
  for (int k = 0; k < 2; k++) {
    uint64_t acc = k ? a : b;
    m64 = a, r = acc;
    asm volatile("lock cmpxchgq %3,%0\n\tpushfq\n\tpopq %2" : "+m"(m64), "+a"(r), "=r"(f) : "r"(b ^ 0x55) : "cc");
    mix(m64), mix(r), mix(f & 0x8d5);
    m16 = a, r = acc | 0xabcd0000;
    asm volatile("lock cmpxchgw %w3,%0\n\tpushfq\n\tpopq %2" : "+m"(m16), "+a"(r), "=r"(f) : "r"(b) : "cc");
    mix(m16), mix(r), mix(f & 0x8d5);
    m8 = a, r = acc | 0xff00;
    asm volatile("cmpxchgb %b3,%0\n\tpushfq\n\tpopq %2" : "+m"(m8), "+a"(r), "=r"(f) : "q"(b) : "cc");
    mix(m8), mix(r), mix(f & 0x8d5);
    m32 = a, r = acc | 0x1234567800000000ull;  // a 32-bit mismatch zero-extends
    asm volatile("cmpxchgl %k3,%0\n\tpushfq\n\tpopq %2" : "+m"(m32), "+a"(r), "=r"(f) : "r"(b) : "cc");
    mix(m32), mix(r), mix(f & 0x8d5);
  }
}

#define N 20000
static uint64_t c_add, c_xadd, c_cas;
static uint32_t c_inc;
static uint16_t c_w;
static uint8_t c_b;
static uint32_t c_or;

static void *worker(void *p) {
  int id = (int)(intptr_t)p;
  for (int i = 0; i < N; i++) {
    asm volatile("lock addq $3,%0" : "+m"(c_add));
    asm volatile("lock incl %0" : "+m"(c_inc));
    asm volatile("lock addw $1,%0" : "+m"(c_w));
    asm volatile("lock subb $1,%0" : "+m"(c_b));
    uint64_t one = 1;
    asm volatile("lock xaddq %1,%0" : "+m"(c_xadd), "+r"(one));
    uint64_t old = __atomic_load_n(&c_cas, __ATOMIC_RELAXED);
    while (!__atomic_compare_exchange_n(&c_cas, &old, old + 2, 0, __ATOMIC_SEQ_CST, __ATOMIC_RELAXED)) {
    }
    if (i == id * 7) asm volatile("lock orl %1,%0" : "+m"(c_or) : "r"(1u << id));
  }
  return 0;
}

int main(void) {
  static const uint64_t v[] = {0, 1, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000,
                               0xffffffff, 0x7fffffffffffffffull, 0x8000000000000000ull, ~0ull,
                               0x123456789abcdef0ull, 0x5555aaaa5555aaaaull};
  int n = sizeof(v) / sizeof(*v);
  for (int r = 0; r < 20; r++)
    for (int i = 0; i < n; i++)
      for (int j = 0; j < n; j++) widths(v[i] + r, v[j] * (r + 1));
  printf("atomics %016llx\n", (unsigned long long)h);
  pthread_t t[4];
  for (int i = 0; i < 4; i++) pthread_create(&t[i], 0, worker, (void *)(intptr_t)i);
  for (int i = 0; i < 4; i++) pthread_join(t[i], 0);
  printf("add %llu inc %u w %u b %u xadd %llu cas %llu or %x\n", (unsigned long long)c_add, c_inc, c_w, c_b,
         (unsigned long long)c_xadd, (unsigned long long)c_cas, c_or);
  // misaligned: inside a cache line, across one, and across a page
  char *p = aligned_alloc(4096, 8192);
  memset(p, 0, 8192);
  uint64_t sum = 0;
  for (int i = 0; i < 1000; i++) {
    for (int off = 1; off < 8; off++) {
      asm volatile("lock addl $5,%0" : "+m"(*(uint32_t *)(p + 8 + off)));
      asm volatile("lock incq %0" : "+m"(*(uint64_t *)(p + 64 - off)));
      uint64_t o = 2;
      asm volatile("lock xaddq %1,%0" : "+m"(*(uint64_t *)(p + 4096 - off)), "+r"(o));
      sum += o;
    }
  }
  uint64_t s2 = 0;
  for (int i = 0; i < 8192; i++) s2 = s2 * 31 + (uint8_t)p[i];
  printf("misaligned %llu %016llx\n", (unsigned long long)sum, (unsigned long long)s2);
  return 0;
}
