// System time: a loop of system calls shows up in tms_stime and ru_stime,
// and a reaped child's in tms_cstime (LTP times03). User time stays the
// rest of the CPU time.
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/times.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void calls(void) {
  struct timespec t0, t;
  clock_gettime(CLOCK_MONOTONIC, &t0);
  do {
    for (int i = 0; i < 100; i++) syscall(SYS_getppid);
    clock_gettime(CLOCK_MONOTONIC, &t);
  } while ((t.tv_sec - t0.tv_sec) * 1000 + (t.tv_nsec - t0.tv_nsec) / 1000000 < 300);
}

int main(void) {
  struct tms a, b;
  struct rusage ru;
  times(&a);
  calls();
  times(&b);
  getrusage(RUSAGE_SELF, &ru);
  printf("stime %d rusage %d ", b.tms_stime > a.tms_stime, ru.ru_stime.tv_sec > 0 || ru.ru_stime.tv_usec > 0);
  fflush(stdout);
  pid_t p = fork();
  if (!p) {
    calls();
    exit(0);
  }
  waitpid(p, 0, 0);
  times(&b);
  printf("cstime %d\n", b.tms_cstime > 0);
  return 0;
}
