// A MAP_SHARED mapping of a file it may not write through (a read-only fd,
// a memfd sealed with F_SEAL_WRITE) can't be made writable: Linux clears
// VM_MAYWRITE, so mprotect(PROT_WRITE) is EACCES. A private mapping of the
// same file, or a shared one before the seal, can (LTP memfd_create01).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

static int prot_rw(void *p, size_t n) {
  return mprotect(p, n, PROT_READ | PROT_WRITE) ? errno : 0;
}

int main(void) {
  int fd = memfd_create("x", MFD_ALLOW_SEALING);
  ftruncate(fd, 8192);
  char *p = mmap(0, 8192, PROT_READ, MAP_SHARED, fd, 0);
  printf("unsealed %d ", prot_rw(p, 8192));
  munmap(p, 8192);
  fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE);
  p = mmap(0, 8192, PROT_READ, MAP_SHARED, fd, 0);
  printf("sealed %d ", prot_rw(p, 8192));
  printf("one page %d ", prot_rw(p + 4096, 4096));
  printf("read only %d ", mprotect(p, 8192, PROT_READ) ? errno : 0);
  p = mmap(0, 8192, PROT_READ, MAP_PRIVATE, fd, 0);
  printf("private %d ", prot_rw(p, 8192));
  int w = open("file", O_RDWR | O_CREAT | O_TRUNC, 0644);
  write(w, "hello", 5);
  close(w);
  int ro = open("file", O_RDONLY);
  p = mmap(0, 4096, PROT_READ, MAP_SHARED, ro, 0);
  printf("rdonly fd %d\n", p == MAP_FAILED ? -1 : prot_rw(p, 4096));
  return 0;
}
