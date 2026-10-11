// Does a forked child keep its pid across execve? (Firefox's child launch: fork/clone, then exec)
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sched.h>
#include <sys/syscall.h>
#include <sys/wait.h>
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "child")) { printf("  exec'd child: getpid=%d getppid=%d\n", getpid(), getppid()); fflush(stdout); return 0; }
  const char *modes[] = { "fork", "vfork", "clone(SIGCHLD)" };
  for (int m = 0; m < 3; m++) {
    pid_t p;
    if (m == 0) p = fork();
    else if (m == 1) p = vfork();
    else p = syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0);
    if (p == 0) { char *a[] = { argv[0], "child", 0 }; execv("/proc/self/exe", a); execv(argv[0], a); _exit(127); }
    printf("%s: parent got pid %d\n", modes[m], p); fflush(stdout);
    int st; pid_t w = waitpid(p, &st, 0);
    printf("  waitpid(%d) -> %d, status %d\n", p, w, WIFEXITED(st) ? WEXITSTATUS(st) : -1); fflush(stdout);
  }
  return 0;
}
