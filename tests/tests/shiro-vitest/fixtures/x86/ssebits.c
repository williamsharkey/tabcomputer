// andps/andnps/orps (0F 54-56, no prefix) and their 66 forms andpd/andnpd/
// orpd, register and memory operands, which the wasm JIT compiles as
// v128 and/andnot/or; a misaligned memory operand faults (#GP) as on x86.
// Prints hashes of the results (the same natively, JIT on and off).
#include <emmintrin.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>

static uint64_t h = 1469598103934665603ull;
static void mix(__m128i v) {
  uint64_t w[2];
  _mm_storeu_si128((__m128i *)w, v);
  h = (h ^ w[0]) * 1099511628211ull;
  h = (h ^ w[1]) * 1099511628211ull;
}

static sigjmp_buf jb;
static void onsegv(int sig) { siglongjmp(jb, sig); }

int main(void) {
  static __attribute__((aligned(16))) unsigned char buf[64];
  __m128 a = _mm_castsi128_ps(_mm_set_epi32(0x12345678, -1, 0, 0x0f0f0f0f));
  for (int i = 0; i < 3000; i++) {
    __m128 b = _mm_castsi128_ps(_mm_set_epi32(i * 77, ~i, i << 13, i ^ 0x5a5a5a5a));
    __m128d c = _mm_castps_pd(b), d = _mm_castps_pd(a);
    mix(_mm_castps_si128(_mm_and_ps(a, b)));
    mix(_mm_castps_si128(_mm_andnot_ps(a, b)));
    mix(_mm_castps_si128(_mm_or_ps(a, b)));
    mix(_mm_castpd_si128(_mm_and_pd(d, c)));
    mix(_mm_castpd_si128(_mm_andnot_pd(d, c)));
    mix(_mm_castpd_si128(_mm_or_pd(d, c)));
    _mm_store_ps((float *)buf, b);
    __m128 m = a;
    asm volatile("andps %1,%0" : "+x"(m) : "m"(*(const __m128 *)buf));
    mix(_mm_castps_si128(m));
    asm volatile("andnps %1,%0" : "+x"(m) : "m"(*(const __m128 *)buf));
    mix(_mm_castps_si128(m));
    asm volatile("orpd %1,%0" : "+x"(m) : "m"(*(const __m128 *)buf));
    mix(_mm_castps_si128(m));
    a = _mm_castsi128_ps(_mm_add_epi32(_mm_castps_si128(a), _mm_set1_epi32(0x01010101)));
  }
  printf("ssebits %016llx\n", (unsigned long long)h);
  signal(SIGSEGV, onsegv);
  volatile int faults = 0;
  for (int i = 0; i < 300; i++) {
    __m128 m = a;
    if (!sigsetjmp(jb, 1)) asm volatile("orps %1,%0" : "+x"(m) : "m"(*(const __m128 *)(buf + 4)));
    else faults++;
  }
  printf("misaligned orps faults %d of 300\n", faults);
  return 0;
}
