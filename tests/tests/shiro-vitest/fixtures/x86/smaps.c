// /proc/self/smaps and smaps_rollup: a mapping's Size, Rss (pages with
// memory) and Locked (mlock); msync(MS_INVALIDATE) of locked pages is EBUSY
// (LTP mlock05, Open POSIX mlockall_3-6/3-7). The mapping sits between
// PROT_NONE neighbors, so it is a line of its own however Linux merges.
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

static long field(void *addr, const char *file, const char *name) {
  char line[256];
  unsigned long lo, hi;
  long v = -1;
  int in = 0;
  FILE *f = fopen(file, "r");
  while (f && fgets(line, sizeof(line), f)) {
    if (sscanf(line, "%lx-%lx ", &lo, &hi) == 2) {
      in = !addr || lo == (unsigned long)addr;
    } else if (in && !strncmp(line, name, strlen(name)) && line[strlen(name)] == ':') {
      sscanf(line + strlen(name) + 1, "%ld", &v);
    }
  }
  if (f) fclose(f);
  return v;
}

int main(void) {
  size_t n = 1 << 20;
  char *fence = mmap(0, 3 * n, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  char *b = mmap(fence + n, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  memset(b, 1, 8192);
  printf("size %ld rss %ld locked %ld\n", field(b, "/proc/self/smaps", "Size"),
         field(b, "/proc/self/smaps", "Rss"), field(b, "/proc/self/smaps", "Locked"));
  int r = msync(b, 4096, MS_SYNC | MS_INVALIDATE);
  printf("msync %d\n", r);
  mlock(b, n);
  printf("mlocked rss %ld locked %ld rollup %d\n", field(b, "/proc/self/smaps", "Rss"),
         field(b, "/proc/self/smaps", "Locked"), field(0, "/proc/self/smaps_rollup", "Locked") >= 1024);
  r = msync(b, 4096, MS_SYNC | MS_INVALIDATE);
  printf("msync locked %d %d\n", r, r ? errno : 0);
  munlock(b, n);
  printf("munlocked locked %ld msync %d\n", field(b, "/proc/self/smaps", "Locked"),
         msync(b, 4096, MS_SYNC | MS_INVALIDATE));
  return 0;
}
