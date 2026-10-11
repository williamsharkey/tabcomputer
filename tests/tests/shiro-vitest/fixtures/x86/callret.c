// Calls and returns the wasm JIT may compile inside one region (a callee in
// its caller's region, its ret going straight back): recursion, one callee
// called from two sites, a longjmp out of nested calls, a callee that
// returns somewhere else than its caller (it rewrites its return address),
// and calls through a pointer. The output is the same natively and under
// Blink with the JIT on or off.
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline)) static uint64_t fib(int n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

__attribute__((noinline)) static uint64_t twice(uint64_t x) { return x * 2 + 1; }

__attribute__((noinline)) static uint64_t two_sites(int i) {
  uint64_t a = twice(i);
  uint64_t b = twice(a ^ 0x55);
  return a + (b << 1);
}

static jmp_buf jb;
__attribute__((noinline)) static void deep(int n, int bail) {
  if (n == bail) longjmp(jb, n);
  if (n > 0) deep(n - 1, bail);
}

// detour returns to `elsewhere` instead of its caller (it replaces the
// return address on the stack); elsewhere's ret then leaves call_detour
// through call_detour's own return address, skipping the ud2
extern uint64_t call_detour(uint64_t);
__asm__(
    ".text\n"
    "call_detour:\n"
    "  call detour\n"
    "  ud2\n"
    "detour:\n"
    "  lea 1(%rdi), %rax\n"
    "  lea elsewhere(%rip), %rcx\n"
    "  mov %rcx, (%rsp)\n"
    "  ret\n"
    "elsewhere:\n"
    "  imul $3, %rax, %rax\n"
    "  ret\n");

__attribute__((noinline)) static uint64_t add1(uint64_t x) { return x + 1; }
__attribute__((noinline)) static uint64_t mul3(uint64_t x) { return x * 3; }
static uint64_t (*volatile fns[2])(uint64_t) = {add1, mul3};

int main(int argc, char **argv) {
  int rounds = argc > 1 ? atoi(argv[1]) : 2000, i;
  uint64_t s = 0;
  for (i = 0; i < rounds; ++i) s += fib(12 + (i & 3));
  printf("fib %llu\n", (unsigned long long)s);
  for (s = 0, i = 0; i < rounds * 10; ++i) s = s * 31 + two_sites(i);
  printf("two_sites %016llx\n", (unsigned long long)s);
  for (s = 0, i = 0; i < rounds; ++i) {
    int r = setjmp(jb);
    if (!r) deep(40, i % 37);
    s += r;
  }
  printf("longjmp %llu\n", (unsigned long long)s);
  for (s = 0, i = 0; i < rounds * 10; ++i) s = s * 7 + call_detour(i);
  printf("detour %016llx\n", (unsigned long long)s);
  for (s = 1, i = 0; i < rounds * 10; ++i) s = fns[i & 1](s) ^ i;
  printf("pointers %016llx\n", (unsigned long long)s);
  return 0;
}
