// timer_getoverrun in a timer's signal handler is that signal's overruns,
// though the timer has fired since: an absolute start billions of 1 ns
// intervals ago reads DELAYTIMER_MAX (LTP timer_settime03), as does the
// handler's si_overrun; after timer_settime it reads 0.
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static timer_t timer;
static volatile int called, overrun, info_overrun;

static void handler(int sig, siginfo_t *si, void *uc) {
  struct itimerspec off;
  if (called) return;
  overrun = timer_getoverrun(timer);
  info_overrun = si->si_overrun;
  memset(&off, 0, sizeof(off));
  timer_settime(timer, 0, &off, 0);
  called = 1;
}

int main(void) {
  struct sigaction sa;
  struct sigevent sev;
  struct itimerspec its;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = handler;
  sa.sa_flags = SA_SIGINFO;
  sigaction(SIGUSR1, &sa, 0);
  memset(&sev, 0, sizeof(sev));
  sev.sigev_notify = SIGEV_SIGNAL;
  sev.sigev_signo = SIGUSR1;
  timer_create(CLOCK_REALTIME, &sev, &timer);
  memset(&its, 0, sizeof(its));
  clock_gettime(CLOCK_REALTIME, &its.it_value);
  its.it_value.tv_sec -= 10;
  its.it_interval.tv_nsec = 1;
  timer_settime(timer, TIMER_ABSTIME, &its, 0);
  while (!called) {
  }
  printf("overrun max %d si_overrun max %d after settime %d\n", overrun == INT_MAX, info_overrun == INT_MAX,
         timer_getoverrun(timer));
  return 0;
}
