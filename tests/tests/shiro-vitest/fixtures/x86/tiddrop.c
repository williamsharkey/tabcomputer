// A SIGEV_THREAD_ID timer's thread exits with the timer still armed: Linux
// drops the expiries (no thread to take them), and the process lives on.
// Blink passed them to the process, whose other threads don't block
// SIGRTMIN, and its default action killed it.
#define _GNU_SOURCE
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void *target(void *arg) {
  struct sigevent se;
  struct itimerspec its;
  sigset_t set;
  timer_t *t = arg;
  sigemptyset(&set);
  sigaddset(&set, SIGRTMIN);
  pthread_sigmask(SIG_BLOCK, &set, 0);
  memset(&se, 0, sizeof(se));
  se.sigev_notify = SIGEV_THREAD_ID;
  se.sigev_signo = SIGRTMIN;
  se._sigev_un._tid = syscall(SYS_gettid);
  timer_create(CLOCK_MONOTONIC, &se, t);
  memset(&its, 0, sizeof(its));
  its.it_value.tv_nsec = its.it_interval.tv_nsec = 5 * 1000 * 1000;
  timer_settime(*t, 0, &its, 0);
  usleep(20 * 1000);
  return 0;  // (the timer stays armed)
}

int main(void) {
  pthread_t th;
  timer_t t;
  pthread_create(&th, 0, target, &t);
  pthread_join(th, 0);
  usleep(200 * 1000);
  printf("alive\n");
  timer_delete(t);
  return 0;
}
