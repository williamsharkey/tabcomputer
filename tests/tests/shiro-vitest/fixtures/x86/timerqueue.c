// A timer's signal is queued once: expiries while it is still pending are
// its overruns, not more signals (Linux keeps one sigqueue entry per timer).
// Here a SIGEV_THREAD_ID timer's thread blocks the signal and takes it only
// after 30 expiries, while the main thread leaves it unblocked (glibc's
// SIGEV_THREAD helper and the program's own thread). Blink had queued a
// signal for each, so a slow helper ran the function once per expiry, long
// after the timer stopped (Open POSIX fork_18-1 under load).
#define _GNU_SOURCE
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void *target(void *arg) {
  sigset_t set;
  struct sigevent se;
  struct itimerspec its;
  struct timespec zero = {0, 0};
  siginfo_t si;
  timer_t t;
  int taken = 0, overrun = 0, more = 0, sig = SIGRTMIN;
  sigemptyset(&set);
  sigaddset(&set, sig);
  pthread_sigmask(SIG_BLOCK, &set, 0);
  memset(&se, 0, sizeof(se));
  se.sigev_notify = SIGEV_THREAD_ID;
  se.sigev_signo = sig;
  se._sigev_un._tid = syscall(SYS_gettid);
  if (timer_create(CLOCK_MONOTONIC, &se, &t)) { perror("timer_create"); return 0; }
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = its.it_interval.tv_nsec = 10 * 1000 * 1000;
  timer_settime(t, 0, &its, 0);
  usleep(300 * 1000);
  // (taken while the timer runs: Linux 6.13 drops the pending signal of a
  // timer disarmed since)
  if (sigtimedwait(&set, &si, &zero) == sig) taken = 1, overrun = si.si_overrun;
  // what is queued right behind it: nothing, or the one expiry since
  while (sigtimedwait(&set, &si, &zero) == sig) ++more;
  memset(&its, 0, sizeof(its));
  timer_settime(t, 0, &its, 0);
  printf("taken %d overruns %s queued behind %s\n", taken, overrun >= 10 ? "many" : "few", more <= 1 ? "0 or 1" : "more");
  timer_delete(t);
  return 0;
}

int main(void) {
  pthread_t th;
  pthread_create(&th, 0, target, 0);
  pthread_join(th, 0);
  return 0;
}
