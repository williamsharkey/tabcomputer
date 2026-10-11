// A file's MAP_SHARED mapping and reads of the file, as Linux (Blink 0518):
// read() of a regular file returns all it asks for, past Blink's 1 MiB chunk
// (LTP mmap21); mremap grows a shared mapping and the pages it gains are the
// file's, written back by msync (mremap01); what a mapping's last page holds
// past the file's end never reaches the file (mmap01).
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
  long pg = sysconf(_SC_PAGESIZE), big = 3L << 20, i, bad = -1;
  char *buf = malloc(2 * big);
  struct stat st;
  int fd = open("mf.tmp", O_CREAT | O_RDWR | O_TRUNC, 0644);
  // grow a shared mapping of a 3 MiB file to 6 MiB, write all of it
  ftruncate(fd, big);
  char *p = mmap(0, big, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  ftruncate(fd, 2 * big);
  p = mremap(p, big, 2 * big, MREMAP_MAYMOVE);
  for (i = 0; i < 2 * big; i++) p[i] = (char)(i * 7);
  msync(p, 2 * big, MS_SYNC);
  lseek(fd, 0, SEEK_SET);
  long n = read(fd, buf, 2 * big);
  for (i = 0; i < n; i++) if (buf[i] != (char)(i * 7)) { bad = i; break; }
  printf("read %ld of %ld, first wrong %ld\n", n, 2 * big, bad);
  munmap(p, 2 * big);
  // 12 bytes, a page mapped: bytes written past the end stay in the mapping
  ftruncate(fd, 0);
  pwrite(fd, "twelve bytes", 12, 0);
  p = mmap(0, pg, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  memcpy(p + 12, "XYZ", 3);
  msync(p, pg, MS_SYNC);
  munmap(p, pg);
  fstat(fd, &st);
  printf("size %ld\n", (long)st.st_size);
  close(fd);
  unlink("mf.tmp");
  return 0;
}
