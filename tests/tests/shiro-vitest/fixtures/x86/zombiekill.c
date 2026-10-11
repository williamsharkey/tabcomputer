// kill() reaches each same-instance fork child while its earlier siblings
// are unreaped zombies (LTP pause01: the 5th child never woke and the
// parent waited forever). Each child waits in pause() for SIGUSR1, then
// exits; every child shows Z in /proc/PID/stat a second later.
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void h(int s) { (void)s; }

int main(void) {
  pid_t kids[6];
  for (int i = 0; i < 6; i++) {
    int p[2];
    char x;
    pipe(p);
    if (!(kids[i] = fork())) {
      signal(SIGUSR1, h);
      write(p[1], "x", 1);
      pause();
      _exit(0);
    }
    read(p[0], &x, 1);
    usleep(100000);
    kill(kids[i], SIGUSR1);
  }
  sleep(1);
  for (int i = 0; i < 6; i++) {
    char path[64], b[256] = "?) ?";
    FILE *f;
    snprintf(path, sizeof(path), "/proc/%d/stat", kids[i]);
    if ((f = fopen(path, "r"))) {
      fgets(b, sizeof(b), f);
      fclose(f);
    }
    printf("%c", strchr(b, ')')[2]);
  }
  printf("\n");
  return 0;
}
