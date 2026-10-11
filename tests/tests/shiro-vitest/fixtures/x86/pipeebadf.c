// A blocking read of a pipe's write end, or write to its read end, is
// EBADF at once: the kernel's readiness wait took the write end's "not
// ready" for a read to wait out (LTP pipe03 hung).
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
  int fd[2];
  char c = 'x';
  pipe(fd);
  int w = write(fd[0], "A", 1), we = errno;
  int r = read(fd[1], &c, 1), re = errno;
  printf("write read end %d %d read write end %d %d\n", w, we, r, re);
  return 0;
}
