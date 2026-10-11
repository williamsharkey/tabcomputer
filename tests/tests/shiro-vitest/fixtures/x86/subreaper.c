// PR_SET_CHILD_SUBREAPER: an orphaned grandchild is reparented to the
// subreaper (not init), which waits for it and gets its SIGCHLD; a fork
// child doesn't inherit the flag. All of it in a fork child, whose waitpid
// restarts after an SA_RESTART SIGCHLD handler as its parent's does (it came
// back EINTR: LTP prctl03).
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int got;
static void onchld(int sig) { got++; }

static void test(void) {
  int p[2], st, v = -1, pp = getpid();
  signal(SIGCHLD, onchld);  // (SA_RESTART)
  printf("set %d\n", prctl(PR_SET_CHILD_SUBREAPER, 1));
  fflush(stdout);
  pipe(p);
  pid_t a = fork();
  if (!a) {
    if (!fork()) {
      char x;
      close(p[1]);
      read(p[0], &x, 1);
      printf("grandchild reparented %d\n", getppid() == pp);
      exit(0);
    }
    prctl(PR_GET_CHILD_SUBREAPER, &v);
    printf("child flag %d\n", v);
    exit(0);
  }
  close(p[0]);
  int r = waitpid(a, 0, 0);
  printf("waitpid %d\n", r == a);
  fflush(stdout);
  write(p[1], "x", 1);
  r = wait(&st);
  printf("wait %d sigchld %d\n", r > 0, got);
  prctl(PR_GET_CHILD_SUBREAPER, &v);
  printf("flag %d\n", v);
}

int main(void) {
  int st;
  pid_t t = fork();
  if (!t) {
    test();
    exit(0);
  }
  waitpid(t, &st, 0);
  return 0;
}
