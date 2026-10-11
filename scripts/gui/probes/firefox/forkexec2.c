// Firefox's case: a child launched from a secondary thread of a threaded parent (fork/clone/posix_spawn), then exec
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <spawn.h>
#include <pthread.h>
#include <sys/syscall.h>
#include <sys/wait.h>
extern char **environ;
static char *self;
static volatile int spin = 1;
static void *busy(void *a) { (void)a; while (spin) usleep(1000); return 0; }
static void run(const char *mode) {
  pid_t p;
  char *av[] = { self, "child", (char *)mode, 0 };
  if (!strcmp(mode, "posix_spawn")) { if (posix_spawn(&p, "/proc/self/exe", 0, 0, av, environ)) { perror("posix_spawn"); return; } }
  else {
    p = !strcmp(mode, "fork") ? fork() : (pid_t)syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0);
    if (p == 0) { execv("/proc/self/exe", av); _exit(127); }
  }
  printf("%s (thread %ld): parent got pid %d\n", mode, (long)syscall(SYS_gettid), p); fflush(stdout);
  int st; pid_t w = waitpid(p, &st, 0);
  printf("  waitpid(%d) -> %d, status %d\n", p, w, WIFEXITED(st) ? WEXITSTATUS(st) : -1); fflush(stdout);
}
static void *launcher(void *a) { (void)a; run("fork"); run("clone(SIGCHLD)"); run("posix_spawn"); return 0; }
int main(int argc, char **argv) {
  self = argv[0];
  if (argc > 2 && !strcmp(argv[1], "child")) { printf("  exec'd child (%s): getpid=%d getppid=%d\n", argv[2], getpid(), getppid()); fflush(stdout); return 0; }
  pthread_t b1, b2, l;
  pthread_create(&b1, 0, busy, 0); pthread_create(&b2, 0, busy, 0);
  pthread_create(&l, 0, launcher, 0); pthread_join(l, 0);
  spin = 0; pthread_join(b1, 0); pthread_join(b2, 0);
  sleep(1);
  printf("ps after:\n"); fflush(stdout);
  return system("ps -eo pid,ppid,stat,args 2>/dev/null | grep forkexec | grep -v grep") < 0;
}
