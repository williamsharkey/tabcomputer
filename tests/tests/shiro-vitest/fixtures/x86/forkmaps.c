// A process with many private file mappings forks and execs over and over
// (ldconfig and dracut-install after a big apt install; debian's forkmaps).
// Each fork copies the mapped pages, and the parent and its same-instance
// child allocated host pages at once: their index table (g_hostpages) gave
// two pages one index, and a child's page table resolved to the parent's
// live page. Blink aborted ("pt & PAGE_V") around fork 60 with 984 files.
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int n = argc > 1 ? atoi(argv[1]) : 984, forks = argc > 2 ? atoi(argv[2]) : 100;
  char name[32], buf[8192];
  if (argc > 1 && argv[1][0] == 't') return 0;  // the exec'd child: /bin/true
  for (int i = 0; i < (int)sizeof(buf); i++) buf[i] = i;
  for (int i = 0; i < n; i++) {
    snprintf(name, sizeof(name), "m%d", i);
    int fd = open(name, O_RDWR | O_CREAT | O_TRUNC, 0644);
    for (int k = 0; k < 8; k++) write(fd, buf, sizeof(buf));
    if (mmap(0, 65536, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED) {
      perror("mmap");
      return 1;
    }
    close(fd);
  }
  for (int i = 0; i < forks; i++) {
    int st;
    pid_t p = fork();
    if (!p) {
      execl("/proc/self/exe", "prog", "true", (char *)0);
      _exit(127);
    }
    if (waitpid(p, &st, 0) != p || st) {
      printf("fork %d status %x\n", i, st);
      return 1;
    }
  }
  printf("ok %d %d\n", n, forks);
  return 0;
}
