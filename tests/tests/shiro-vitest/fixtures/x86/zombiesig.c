// Fork children that pause() with a handler, signal each, and reap none:
// every one wakes and exits (a zombie, Z). A same-instance fork child's
// signal came to Blink as a message to the worker's main thread, which its
// parent, busy on direct channels, held: the third child on slept through
// its kill() (LTP pause01 hung on its fifth). Blink 0537 has waits ask the
// kernel for their signals.
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static void h(int s) {}
int main(void) {
  pid_t kids[4];
  for (int i = 0; i < 4; i++) {
    int p[2]; char x;
    pipe(p);
    if (!(kids[i] = fork())) { signal(SIGUSR1, h); write(p[1], "x", 1); pause(); _exit(0); }
    read(p[0], &x, 1);
    usleep(100000);  // (in pause by now)
    kill(kids[i], SIGUSR1);
  }
  sleep(1);
  for (int i = 0; i < 4; i++) {
    char path[64], b[256] = "?) ?"; FILE *f;
    snprintf(path, sizeof(path), "/proc/%d/stat", kids[i]);
    if ((f = fopen(path, "r"))) { fgets(b, sizeof(b), f); fclose(f); }
    printf("%c", strchr(b, ')')[2]);
  }
  printf("\n");
  return 0;
}
