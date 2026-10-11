// mmap's checks as Linux orders them (Blink 0519): a bad fd is EBADF even
// with no length (LTP mmap08); no length is EINVAL before the fd's access
// mode is EACCES (mmap06); a fixed address past user space is ENOMEM
// (mmap15); MAP_SHARED_VALIDATE with an unknown flag is EOPNOTSUPP (mmap20);
// MAP_32BIT maps below 2 GiB, and more than it can hold is ENOMEM (mmap23/24).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

static int err(void *p) { return p == MAP_FAILED ? errno : 0; }

int main(void) {
  int ro = open("ma.tmp", O_RDONLY | O_CREAT, 0644), closed = open("ma2.tmp", O_RDWR | O_CREAT, 0644);
  close(closed);
  printf("bad fd no length %d\n", err(mmap(0, 0, PROT_WRITE, MAP_SHARED, closed, 0)));
  printf("no length %d\n", err(mmap(0, 0, PROT_READ | PROT_WRITE, MAP_SHARED, ro, 0)));
  printf("read-only shared write %d\n", err(mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, ro, 0)));
  printf("high fixed %d\n", err(mmap((void *)0xa000000000000000UL, 4096, PROT_READ, MAP_SHARED | MAP_FIXED, ro, 0)));
  printf("validate %d\n", err(mmap(0, 4096, PROT_READ, MAP_SHARED_VALIDATE | (1 << 10), ro, 0)));
  char *p = mmap(0, 32 << 20, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0);
  printf("32bit below 2G %d\n", p != MAP_FAILED && (unsigned long)p + (32 << 20) <= 0x80000000UL);
  printf("32bit 2G %d\n", err(mmap(0, 2UL << 30, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_32BIT, -1, 0)));
  unlink("ma.tmp");
  unlink("ma2.tmp");
  return 0;
}
