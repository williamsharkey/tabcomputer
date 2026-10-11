// Pages faulted in by a read() (Blink runs it without the GIL) and pages
// another thread faults in at the same time each keep their own memory:
// Blink's host page table (TrackHostPage) gave two of them one index
#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#define CHUNK (1 << 20)
#define ROUNDS 24
static volatile int stop;
static long bad_reader, bad_toucher;
static unsigned char pattern[CHUNK];
static void *toucher(void *arg) {
  (void)arg;
  while (!stop) {
    size_t n = 256 * 4096;
    unsigned char *p = mmap(0, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) return 0;
    for (size_t i = 0; i < n; i += 4096) {
      if (p[i + 7]) ++bad_toucher;  // fresh memory is zero
      p[i] = 0xAB, p[i + 7] = (unsigned char)(i >> 12);
    }
    for (size_t i = 0; i < n; i += 4096) {
      if (p[i] != 0xAB || p[i + 7] != (unsigned char)(i >> 12)) ++bad_toucher;
    }
    munmap(p, n);
  }
  return 0;
}
int main(void) {
  for (int i = 0; i < CHUNK; ++i) pattern[i] = (unsigned char)(i * 7 + (i >> 12));
  int fd = open("data.bin", O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, pattern, CHUNK) != CHUNK) return 1;
  pthread_t t;
  pthread_create(&t, 0, toucher, 0);
  for (int r = 0; r < ROUNDS; ++r) {
    unsigned char *b = mmap(0, CHUNK, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (pread(fd, b, CHUNK, 0) != CHUNK) return 2;  // faults in 256 pages without the GIL
    if (memcmp(b, pattern, CHUNK)) ++bad_reader;
    munmap(b, CHUNK);
  }
  stop = 1;
  pthread_join(t, 0);
  printf("reader bad %ld toucher bad %ld\n", bad_reader, bad_toucher);
  unlink("data.bin");
  return 0;
}
