// Throughput of the library code thunking (HLE) would replace: zlib's
// deflate/inflate/crc32/adler32, xz decoding, and the string functions.
// Run natively and under Blink to see which ones are worth a thunk.
//   gcc -static -O2 -o codecs codecs.c -lz -llzma
//   codecs [MiB]   (default 4)
#include <lzma.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <zlib.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

static void report(const char *name, double mb, double t, unsigned long check) {
  printf("%-10s %8.1f MB/s  (%lx)\n", name, mb / t, check);
  fflush(stdout);
}

int main(int argc, char **argv) {
  size_t n = (size_t)(argc > 1 ? atoi(argv[1]) : 4) << 20;
  double mb = n / 1048576.0, t;
  unsigned char *src = malloc(n), *dst = malloc(n + n / 2 + 1024), *back = malloc(n);
  uint32_t x = 1;
  // text-like: words from a small vocabulary, compresses ~3-4x
  static const char *words[] = {"the ", "kernel ", "page ", "of ", "a ", "process ", "maps ", "file ", "and ", "returns ", "\n"};
  for (size_t i = 0; i < n;) {
    x = x * 1103515245 + 12345;
    const char *w = words[(x >> 16) % 11];
    for (size_t k = 0; w[k] && i < n; k++) src[i++] = w[k];
  }
  src[n - 1] = 0;

  uLongf zn = n + n / 2 + 1024;
  t = now();
  compress2(dst, &zn, src, n, 6);
  report("deflate", mb, now() - t, zn);
  uLongf bn = n;
  t = now();
  uncompress(back, &bn, dst, zn);
  report("inflate", mb, now() - t, bn == n && !memcmp(back, src, n));

  t = now();
  unsigned long c = crc32(0, src, n);
  report("crc32", mb, now() - t, c);
  t = now();
  c = adler32(1, src, n);
  report("adler32", mb, now() - t, c);

  size_t xn = 0;
  lzma_easy_buffer_encode(1, LZMA_CHECK_CRC64, 0, src, n, dst, &xn, n + n / 2 + 1024);
  uint64_t limit = UINT64_MAX;
  size_t in = 0, out = 0;
  t = now();
  lzma_stream_buffer_decode(&limit, 0, 0, dst, &in, xn, back, &out, n);
  report("xz-decode", mb, now() - t, out == n && !memcmp(back, src, n));

  unsigned long hits = 0;
  t = now();
  for (int r = 0; r < 8; r++) {
    for (unsigned char *p = src, *e = src + n; (p = memchr(p, '\n', e - p)); p++) hits++;
  }
  report("memchr", mb * 8, now() - t, hits);
  t = now();
  size_t len = 0;
  for (int r = 0; r < 8; r++) len += strlen((char *)src + r);
  report("strlen", mb * 8, now() - t, len);
  memcpy(back, src, n);
  t = now();
  int d = 0;
  for (int r = 0; r < 8; r++) d += memcmp(back, src, n);
  report("memcmp", mb * 8, now() - t, d);
  t = now();
  hits = 0;
  for (int r = 0; r < 8; r++) {
    for (char *p = (char *)src; (p = strchr(p, 'q')); p++) hits++;
  }
  report("strchr", mb * 8, now() - t, hits);
  return 0;
}
