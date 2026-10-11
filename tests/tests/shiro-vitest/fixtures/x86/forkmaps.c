// A writable MAP_SHARED file mapping of one same-instance process mustn't
// change another's memory at the same address when that one forks: the
// parent's private page there stayed shared with its new child, which then
// wrote into the parent's memory
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  int go[2], ready[2];
  char b;
  if (pipe(go) || pipe(ready)) return 1;
  // where the sibling maps its file: a fixed address both use
  char *at = (char *)0x7e0000000000;
  pid_t sib = fork();
  if (sib == 0) {
    int fd = open("shared.dat", O_RDWR | O_CREAT | O_TRUNC, 0644);
    if (fd < 0 || ftruncate(fd, 8192)) _exit(2);
    char *p = mmap(at, 8192, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_FIXED, fd, 0);
    if (p != at) _exit(3);
    p[0] = 'S';
    write(ready[1], "r", 1);
    read(go[0], &b, 1);  // keep the mapping until the parent is done
    _exit(0);
  }
  read(ready[0], &b, 1);
  // the parent's own private memory at the same address
  char *q = mmap(at, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
  if (q != at) return 4;
  q[0] = 'P';  // touched
  // q[4096] untouched (reserved)
  pid_t kid = fork();
  if (kid == 0) {
    q[0] = 'K';
    q[4096] = 'K';
    _exit(0);
  }
  waitpid(kid, 0, 0);
  printf("touched %c untouched %d\n", q[0], q[4096]);
  write(go[1], "g", 1);
  waitpid(sib, 0, 0);
  return 0;
}
