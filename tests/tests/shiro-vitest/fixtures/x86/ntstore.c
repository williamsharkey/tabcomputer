// Non-temporal stores (movntps, movntdq), which glibc's memcpy and memset
// use past the cache size, and which the wasm JIT compiles as aligned
// 16-byte stores: copies through them, glibc's own large memcpy/memset, and
// a misaligned movntdq, which faults (#GP, SIGSEGV) as on x86.
#include <emmintrin.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint64_t hash(const unsigned char *p, size_t n) {
  uint64_t h = 1469598103934665603ull;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
  return h;
}

static sigjmp_buf jb;
static void onsegv(int sig) { siglongjmp(jb, sig); }

int main(void) {
  size_t n = 4 << 20;
  unsigned char *a = aligned_alloc(64, n), *b = aligned_alloc(64, n + 64);
  for (size_t i = 0; i < n; i++) a[i] = (unsigned char)(i * 7 + (i >> 9));
  for (int round = 0; round < 3; round++) {
    for (size_t i = 0; i < n; i += 16) _mm_stream_ps((float *)(b + i), _mm_load_ps((const float *)(a + i)));
    _mm_sfence();
    printf("movntps %016llx\n", (unsigned long long)hash(b, n));
    memset(b, round, n);
    for (size_t i = 0; i < n; i += 16) _mm_stream_si128((__m128i *)(b + i), _mm_load_si128((const __m128i *)(a + i)));
    _mm_sfence();
    printf("movntdq %016llx\n", (unsigned long long)hash(b, n));
    memset(b, 0x5a, n);
    printf("memset %016llx\n", (unsigned long long)hash(b, n));
    memcpy(b + 16, a, n - 16);
    printf("memcpy %016llx\n", (unsigned long long)hash(b, n));
  }
  signal(SIGSEGV, onsegv);
  volatile int faults = 0;
  for (int i = 0; i < 300; i++) {
    if (!sigsetjmp(jb, 1)) _mm_stream_si128((__m128i *)(b + 8), _mm_set1_epi8((char)i));
    else faults++;
  }
  printf("misaligned movntdq faults %d of 300\n", faults);
  return 0;
}
