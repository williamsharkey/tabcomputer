// execve from a process with other threads (Bun's process.execve, used by
// Claude Code's renderer switch): Linux ends the other threads, and the new
// image starts with one. Threads here: one blocked in read() (like Bun's
// stdin reader), two sleeping in a loop.
#define _GNU_SOURCE
#include <dirent.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int p[2];
static void *blocker(void *a) { char c; (void)a; (void)!read(p[0], &c, 1); return 0; }
static void *spinner(void *a) { (void)a; for (;;) usleep(1000); return 0; }

static int tasks(void) {
  DIR *d = opendir("/proc/self/task");
  if (!d) return -1;
  int n = 0;
  struct dirent *e;
  while ((e = readdir(d))) if (e->d_name[0] != '.') n++;
  closedir(d);
  return n;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "after")) { printf("after exec tasks=%d\n", tasks()); return 0; }
  (void)!pipe(p);
#ifndef NOTHREADS
  pthread_t t;
  pthread_create(&t, 0, blocker, 0);
  pthread_create(&t, 0, spinner, 0);
  pthread_create(&t, 0, spinner, 0);
#endif
  usleep(100000);
  printf("before exec tasks=%d\n", tasks());
  fflush(stdout);
  char *args[] = { argv[0], "after", 0 };
  execv(argc > 1 ? argv[1] : argv[0], args);
  perror("execv");
  return 1;
}
