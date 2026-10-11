/* Fixture for blink-crash.test.ts: the parent waits for a fork child that
   blocks for good (until a test kills its engine), then says how it ended.
   Build: gcc -static -O1 -o crashwait crashwait.c */
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  int p[2];
  if (pipe(p)) return 1;
  pid_t c = fork();
  if (c == 0) {
    char x;
    close(p[1]);
    read(p[0], &x, 1);  /* the parent keeps the write end: never returns */
    _exit(3);
  }
  printf("child %d\n", (int)c);
  fflush(stdout);
  int st;
  if (waitpid(c, &st, 0) != c) return 2;
  if (WIFSIGNALED(st)) printf("child signal %d\n", WTERMSIG(st));
  else printf("child exit %d\n", WEXITSTATUS(st));
  return 0;
}
