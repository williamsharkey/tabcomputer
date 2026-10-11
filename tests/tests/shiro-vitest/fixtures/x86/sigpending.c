// RLIMIT_SIGPENDING: with the limit at 0, tgkill of a real-time signal to
// another thread of the process is EAGAIN; a standard signal, or the
// default limit, queue as before (LTP tgkill02).
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

static volatile int tid, done;

static void *thread(void *arg) {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGRTMIN);
  sigaddset(&set, SIGUSR1);
  pthread_sigmask(SIG_BLOCK, &set, 0);
  tid = syscall(SYS_gettid);
  while (!done) usleep(1000);
  return 0;
}

static int send(int sig) {
  return syscall(SYS_tgkill, getpid(), tid, sig) ? errno : 0;
}

int main(void) {
  pthread_t t;
  struct rlimit old, zero = {0, 0};
  getrlimit(RLIMIT_SIGPENDING, &old);
  pthread_create(&t, 0, thread, 0);
  while (!tid) usleep(1000);
  printf("default %d ", send(SIGRTMIN));
  setrlimit(RLIMIT_SIGPENDING, &zero);
  printf("zero rt %d ", send(SIGRTMIN + 1));
  printf("zero standard %d\n", send(SIGUSR1));
  done = 1;
  pthread_join(t, 0);
  return 0;
}
