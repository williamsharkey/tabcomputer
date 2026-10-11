// /proc/self/maps shows a mapping as Linux does: 's' for MAP_SHARED, on a
// line of its own beside a private neighbor with the same protection, and
// "-w" for PROT_WRITE without PROT_READ (x86 reads the page all the same).
// LTP mmap04 remaps the second page of a two-page map and looks for it.
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

static const char *perms(void *addr) {
  static char found[8];
  char line[512], want[32];
  FILE *f = fopen("/proc/self/maps", "r");
  snprintf(want, sizeof(want), "%08" PRIxPTR "-", (uintptr_t)addr);
  strcpy(found, "none");
  while (f && fgets(line, sizeof(line), f)) {
    if (!strncmp(line, want, strlen(want))) sscanf(strchr(line, ' ') + 1, "%4s", found);
  }
  if (f) fclose(f);
  return found;
}

static void one(int prot, int flags) {
  char *a = mmap(0, 8192, PROT_NONE, MAP_ANONYMOUS | ((flags & MAP_SHARED) ? MAP_PRIVATE : MAP_SHARED), -1, 0);
  char *b = mmap(a + 4096, 4096, prot, MAP_ANONYMOUS | MAP_FIXED | flags, -1, 0);
  printf("%s ", perms(b));
  munmap(a, 8192);
}

int main(void) {
  one(PROT_NONE, MAP_PRIVATE);
  one(PROT_NONE, MAP_SHARED);
  one(PROT_WRITE, MAP_PRIVATE);
  one(PROT_WRITE | PROT_EXEC, MAP_SHARED);
  one(PROT_READ | PROT_WRITE, MAP_SHARED);
  char *c = mmap(0, 4096, PROT_READ, MAP_ANONYMOUS | MAP_PRIVATE, -1, 0);
  mprotect(c, 4096, PROT_WRITE);
  printf("%s ", perms(c));
  mprotect(c, 4096, PROT_READ | PROT_WRITE);
  printf("%s\n", perms(c));
  return 0;
}
