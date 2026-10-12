/* 80-bit long double loads and stores under Blink, whose x87 registers are
 * doubles (Blink patch 0540): fldt rounds to the nearest double, gives
 * infinity past DBL_MAX and a subnormal or zero under DBL_MIN; fstpt writes a
 * subnormal double normalized. Prints the bits, so no libc formatting of
 * floating point is involved: for a load, the double fstpl stores; for a
 * store, the ten bytes fstpt writes. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void load(const char *what, uint16_t se, uint64_t m) {
  unsigned char in[16] = {0};
  uint64_t d;
  memcpy(in, &m, 8);
  memcpy(in + 8, &se, 2);
  __asm__("fninit; fldt %1; fstpl %0" : "=m"(d) : "m"(in));
  printf("load %s %016llx\n", what, (unsigned long long)d);
}

static void store(const char *what, uint64_t bits) {
  unsigned char out[16] = {0};
  uint64_t back;
  __asm__("fninit; fldl %2; fld %%st(0); fstpt %0; fstpl %1" : "=m"(out), "=m"(back) : "m"(bits));
  printf("store %s %04x %016llx%s\n", what, out[8] | out[9] << 8, (unsigned long long)*(uint64_t *)out, back == bits ? "" : " (fstpl differs)");
}

int main(void) {
  load("1", 0x3fff, 0x8000000000000000ull);
  load("1+ulp", 0x3fff, 0x8000000000000001ull);
  load("1-ulp", 0x3ffe, 0xffffffffffffffffull);
  load("2-ulp", 0x3fff, 0xffffffffffffffffull);
  load("-(2-ulp)", 0xbfff, 0xffffffffffffffffull);
  load("tie-even", 0x3fff, 0x8000000000000400ull);
  load("tie-odd", 0x3fff, 0x8000000000000c00ull);
  load("pi", 0x4000, 0xc90fdaa22168c235ull);
  load("DBL_MAX", 0x43fe, 0xfffffffffffff800ull);
  load("DBL_MAX+half", 0x43fe, 0xfffffffffffffc00ull);
  load("1.5*2^1024", 0x43ff, 0xc000000000000000ull);
  load("1.5*2^5000", 0x5387, 0xc000000000000000ull);
  load("LDBL_MAX", 0x7ffe, 0xffffffffffffffffull);
  load("-LDBL_MAX", 0xfffe, 0xffffffffffffffffull);
  load("inf", 0x7fff, 0x8000000000000000ull);
  load("nan", 0x7fff, 0xc000000000000000ull);
  load("DBL_MIN", 0x3c01, 0x8000000000000000ull);
  load("1.5*DBL_MIN/2", 0x3c00, 0xc000000000000000ull);
  load("DBL_TRUE_MIN", 0x3bcd, 0x8000000000000000ull);
  load("1.5*DBL_TRUE_MIN/2", 0x3bcc, 0xc000000000000000ull);
  load("DBL_TRUE_MIN/2", 0x3bcc, 0x8000000000000000ull);
  load("1.5*2^-2000", 0x382f, 0xc000000000000000ull);
  load("LDBL_MIN", 0x0001, 0x8000000000000000ull);
  load("-0", 0x8000, 0);
  store("1", 0x3ff0000000000000ull);
  store("DBL_MAX", 0x7fefffffffffffffull);
  store("DBL_MIN", 0x0010000000000000ull);
  store("DBL_MIN/2", 0x0008000000000000ull);
  store("3*DBL_TRUE_MIN", 0x0000000000000003ull);
  store("-DBL_TRUE_MIN", 0x8000000000000001ull);
  store("inf", 0x7ff0000000000000ull);
  store("-0", 0x8000000000000000ull);
  return 0;
}
