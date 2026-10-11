// A process that keeps many private file mappings, then forks and execs
// over and over (debian's repro: dracut-install, ldconfig and dpkg
// maintainer scripts aborted on "pt & PAGE_V" or hung after enough forks).
//   forkmaps FILES KIB FORKS   (makes FILES files of KIB KiB in ./fm)
// Each child execs this program again with "child", which exits 0.
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "child")) return 0;
  int files = argc > 1 ? atoi(argv[1]) : 300;
  int kib = argc > 2 ? atoi(argv[2]) : 88;
  int forks = argc > 3 ? atoi(argv[3]) : 400;
  char path[64], *buf = calloc(1, kib * 1024);
  long sum = 0;
  mkdir("fm", 0755);
  for (int i = 0; i < files; i++) {
    snprintf(path, sizeof path, "fm/%d", i);
    int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
    memset(buf, i, kib * 1024);
    if (fd < 0 || write(fd, buf, kib * 1024) != kib * 1024) { perror(path); return 1; }
    unsigned char *p = mmap(0, kib * 1024, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    for (long o = 0; o < kib * 1024; o += 4096) sum += p[o];
  }
  printf("%d files mapped\n", files);
  fflush(stdout);
  for (int i = 0; i < forks; i++) {
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return 1; }
    if (!pid) {
      execl("/proc/self/exe", argv[0], "child", (char *)0);
      execl(argv[0], argv[0], "child", (char *)0);
      _exit(127);
    }
    int st;
    if (waitpid(pid, &st, 0) != pid || !WIFEXITED(st) || WEXITSTATUS(st)) {
      printf("fork %d: child status %x\n", i, st);
      return 1;
    }
    if (getenv("FORKMAPS_PROGRESS") && (i + 1) % 25 == 0) printf("%d forks\n", i + 1), fflush(stdout);
  }
  printf("%d forks done %ld\n", forks, sum);
  return 0;
}
