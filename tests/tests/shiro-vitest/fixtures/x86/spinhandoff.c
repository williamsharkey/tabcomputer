// Two threads hand a flag back and forth by spinning on it, with no system
// call and no pause instruction in the loops (TBB's arena and Blender's
// workers wait this way). Under Blink only one guest thread runs at a time
// (the GIL), so each round needs the spinning thread to give the GIL up:
// compiled code held it for seconds per round (a hang in Blender's startup).
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static _Atomic int turn;
static int rounds;

static void *other(void *arg) {
  (void)arg;
  for (int i = 0; i < rounds; i++) {
    while (atomic_load_explicit(&turn, memory_order_acquire) != 1) {
    }
    atomic_store_explicit(&turn, 0, memory_order_release);
  }
  return 0;
}

int main(int argc, char **argv) {
  pthread_t t;
  struct timespec a, b;
  rounds = argc > 1 ? atoi(argv[1]) : 200;
  clock_gettime(CLOCK_MONOTONIC, &a);
  pthread_create(&t, 0, other, 0);
  for (int i = 0; i < rounds; i++) {
    atomic_store_explicit(&turn, 1, memory_order_release);
    while (atomic_load_explicit(&turn, memory_order_acquire) != 0) {
    }
  }
  pthread_join(t, 0);
  clock_gettime(CLOCK_MONOTONIC, &b);
  printf("%d rounds\n", rounds);
  fprintf(stderr, "%.1f ms per round\n", ((b.tv_sec - a.tv_sec) * 1e3 + (b.tv_nsec - a.tv_nsec) / 1e6) / rounds);
  return 0;
}
