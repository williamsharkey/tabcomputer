// fallocate and memfd seals as Linux has them (LTP memfd_create01,
// fallocate*): mode 0 extends a file, KEEP_SIZE doesn't, PUNCH_HOLE zeros
// (and needs KEEP_SIZE), F_SEAL_GROW refuses growing. F_SEAL_WRITE is EBUSY
// while a shared mapping may write the memfd, and an O_TRUNC open through
// /proc/self/fd of an F_SEAL_SHRINK'd one is EPERM.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static long size(int fd) {
  struct stat st;
  return fstat(fd, &st) ? -1 : (long)st.st_size;
}

static int err(int r) { return r < 0 ? errno : 0; }

int main(void) {
  char path[64], c = 0;
  int fd = open("file", O_RDWR | O_CREAT | O_TRUNC, 0644);
  write(fd, "xxxxxxxx", 8);
  int r = err(fallocate(fd, 0, 0, 100));
  printf("grow %d %ld ", r, size(fd));
  r = err(fallocate(fd, FALLOC_FL_KEEP_SIZE, 0, 1000));
  printf("keep %d %ld ", r, size(fd));
  printf("punch %d ", err(fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 2, 4)));
  pread(fd, &c, 1, 3);
  printf("%d %ld ", c, size(fd));
  printf("no keep %d bad %d ", err(fallocate(fd, FALLOC_FL_PUNCH_HOLE, 0, 1)), err(fallocate(fd, 0, 0, 0)));
  int ro = open("file", O_RDONLY);
  printf("rdonly %d\n", err(fallocate(ro, 0, 0, 200)));

  int m = memfd_create("m", MFD_ALLOW_SEALING);
  ftruncate(m, 8192);
  char *p = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, m, 0);
  printf("mapped %d ", err(fcntl(m, F_ADD_SEALS, F_SEAL_WRITE)));
  printf("shrink %d ", err(fcntl(m, F_ADD_SEALS, F_SEAL_SHRINK)));
  munmap(p, 8192);
  p = mmap(0, 8192, PROT_READ, MAP_PRIVATE, m, 0);
  printf("private %d ", err(fcntl(m, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW)));
  printf("seals %d ", fcntl(m, F_GET_SEALS));
  printf("grow %d ", err(fallocate(m, 0, 0, 16384)));
  printf("punch %d ", err(fallocate(m, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, 0, 4096)));
  snprintf(path, sizeof(path), "/proc/self/fd/%d", m);
  r = err(open(path, O_RDWR | O_TRUNC));
  printf("trunc %d size %ld\n", r, size(m));
  return 0;
}
