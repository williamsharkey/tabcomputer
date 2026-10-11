// Threads mapping files shared and writable, and unmapping them, at once:
// an munmap writes its pages back to the file (a kernel call) while another
// thread's mmap does the same for every mapping. Under Blink 0519 the two
// could each hold what the other waited for (the GIL, the mappings' lock)
// and the process stopped for good (tabcomputer#27: codex's threads did it
// with SQLite's -shm file and /etc/localtime).
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

#define THREADS 4
#define ROUNDS 200

static void *worker(void *arg) {
  long t = (long)arg;
  char name[32];
  int i;
  snprintf(name, sizeof(name), "map%ld", t);
  for (i = 0; i < ROUNDS; ++i) {
    int fd = open(name, O_RDWR);
    unsigned char *p = mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) return (void *)1;
    ++p[i % 8192];
    munmap(p, 8192);
    close(fd);
  }
  return 0;
}

int main(void) {
  pthread_t th[THREADS];
  long t, bad = 0;
  char zero[8192] = {0};
  for (t = 0; t < THREADS; ++t) {
    char name[32];
    int fd;
    snprintf(name, sizeof(name), "map%ld", t);
    fd = open(name, O_RDWR | O_CREAT | O_TRUNC, 0644);
    write(fd, zero, sizeof(zero));
    close(fd);
  }
  for (t = 0; t < THREADS; ++t) pthread_create(&th[t], 0, worker, (void *)t);
  for (t = 0; t < THREADS; ++t) {
    void *r;
    pthread_join(th[t], &r);
    bad += r != 0;
  }
  // every round's byte reached its file
  for (t = 0; t < THREADS; ++t) {
    char name[32];
    unsigned char buf[8192];
    int fd, i, sum = 0;
    snprintf(name, sizeof(name), "map%ld", t);
    fd = open(name, O_RDONLY);
    read(fd, buf, sizeof(buf));
    close(fd);
    for (i = 0; i < 8192; ++i) sum += buf[i];
    if (sum != ROUNDS) ++bad;
  }
  printf("done %ld\n", bad);
  return 0;
}
