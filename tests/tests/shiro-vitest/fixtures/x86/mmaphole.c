// mmap(0) never returns a range that overlaps a mapping (Blink patch 0552).
// What glibc's malloc arenas and HotSpot do: reserve 128 MiB, trim it to a
// 64 MiB boundary, use the start. Blink puts a large mmap(0) 1 GiB above
// the break; when that address is not on a 2 MiB boundary, the trim leaves
// a hole just short of 64 MiB below the heap, at an unaligned address.
// Blink's search for a free range counted a missing page-table entry as
// free from its start, so it placed the next 64 MiB reservation that did
// not fit lower down in that hole, over the heap's first pages
// (tabcomputer#122: java -Xint exited 139).
//   gcc -static -O1 -o mmaphole mmaphole.c
#define _DEFAULT_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define ALIGN (64ul << 20)
#define RESERVE (PROT_NONE), (MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE)

int main(void) {
  // the break 0x4c000 past a 2 MiB boundary, as it was in the JVM
  uintptr_t brk0 = (uintptr_t)sbrk(0);
  sbrk((0x4c000 - brk0) & ((2ul << 20) - 1));
  // (a page first: with nothing mapped, 128 MiB fit below the break, on a boundary)
  char *page = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  char *raw = mmap(0, 2 * ALIGN, RESERVE, -1, 0);
  if (page == MAP_FAILED || raw == MAP_FAILED) { puts("mmap failed"); return 1; }
  char *heap = (char *)(((uintptr_t)raw + ALIGN - 1) & ~(ALIGN - 1));
  if (heap > raw) munmap(raw, heap - raw);
  munmap(heap + ALIGN, raw + 2 * ALIGN - (heap + ALIGN));
  mprotect(heap, 0x21000, PROT_READ | PROT_WRITE);
  memset(heap, 0x5a, 0x21000);

  // 64 MiB reservations, kept, until one is placed above the heap
  int overlap = 0, above = 0;
  for (int i = 0; i < 16 && !overlap && !above; i++) {
    char *p = mmap(0, ALIGN, RESERVE, -1, 0);
    if (p == MAP_FAILED) break;
    overlap = p < heap + ALIGN && heap < p + ALIGN;
    above = p >= heap + ALIGN;
  }
  int intact = 1;
  if (!overlap) for (int i = 0; i < 0x21000; i += 4096) if (heap[i] != 0x5a) intact = 0;
  printf("overlap %d, heap intact %d\n", overlap, !overlap && intact);
  return overlap || !intact;
}
