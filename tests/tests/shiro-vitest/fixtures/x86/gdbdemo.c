// The program gdb.test.ts debugs: a breakpoint in add() (arguments 3 and 4,
// the global `counter`), a fault in crash(), a read that waits, and a loop
// that only an interrupt ends.
#include <stdio.h>
#include <string.h>
#include <unistd.h>

volatile int counter = 41;

__attribute__((noinline)) int add(int a, int b) {
  int sum = a + b;
  counter += sum;
  return sum;
}

__attribute__((noinline)) void crash(int *p) {
  *p = 1;
}

int main(int argc, char **argv) {
  int x = add(3, 4);
  if (argc > 1 && !strcmp(argv[1], "segv")) crash(0);
  if (argc > 1 && !strcmp(argv[1], "wait")) {
    char c;
    write(1, "waiting\n", 8);
    while (read(0, &c, 1) == 1 && c != 'q') {
    }
    write(1, "woke\n", 5);
  }
  if (argc > 1 && !strcmp(argv[1], "spin")) {
    write(1, "spinning\n", 9);
    for (;;) counter++;
  }
  printf("x=%d counter=%d\n", x, counter);
  return x;
}
