// Fixture for x86-engine.test.ts: the x87 instructions against a model of what
// the Intel manual says each does (tabcomputer#150: `fsubp %st,%st(2)` wrote
// its result to st(1), and `fdiv`/`fdivr %st,%st(i)` were each other; Debian's
// tesseract lost text lines to the first, in a `long double` least squares).
// Build: gcc -static -O1 -o x87ops x87ops.c -lm
// Every operand and result is exact in a double, so the model is plain C
// arithmetic and the answers are the same on an x87 with 64-bit significands
// (a real CPU, Rosetta) and in Blink, whose x87 registers are doubles.
// Prints one line per group, "x87ops ok" at the end and exits 0; a wrong
// result prints the instruction's bytes, what it gave and what was expected.
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int bad;

static void fail(const char *what, int b0, int b1, int k, double got, double want) {
  if (bad++ < 40) printf("%s %02x %02x: st(%d) = %.17g, expected %.17g\n", what, b0, b1, k, got, want);
}

static int same(double a, double b) {
  return (isnan(a) && isnan(b)) || (a == b && signbit(a) == signbit(b));
}

// ---------------------------------------------------------------------------
// 1. Register forms: D8 (st0 = st0 op st(i)), DC (st(i) = ...), DE (the same,
//    then pop), for add, mul, sub, subr, div, divr and every i.
//    Each function loads in[0..7] into st0..st7, runs the two bytes and
//    stores what is on the stack to out[].

#define LOAD8 "fninit\nfldl 56(%rdi)\nfldl 48(%rdi)\nfldl 40(%rdi)\nfldl 32(%rdi)\nfldl 24(%rdi)\nfldl 16(%rdi)\nfldl 8(%rdi)\nfldl (%rdi)\n"
#define STORE7 "fstpl (%rsi)\nfstpl 8(%rsi)\nfstpl 16(%rsi)\nfstpl 24(%rsi)\nfstpl 32(%rsi)\nfstpl 40(%rsi)\nfstpl 48(%rsi)\n"
#define STR_(x) #x
#define STR(x) STR_(x)
#define REGFN(g, base, i, tail)                                                        \
  void f_##g##_##base##_##i(const double *, double *) __asm__("x87f_" #g "_" #base "_" #i); \
  __asm__(".text\n.globl x87f_" #g "_" #base "_" #i "\nx87f_" #g "_" #base "_" #i ":\n" LOAD8 \
          ".byte 0x" #g ", 0x" #base "+" #i "\n" STORE7 tail "ret\n");
#define REG8(g, base, i) REGFN(g, base, i, "fstpl 56(%rsi)\n")
#define REG7(g, base, i) REGFN(g, base, i, "")
#define ALL_I(M, g, base) M(g, base, 0) M(g, base, 1) M(g, base, 2) M(g, base, 3) M(g, base, 4) M(g, base, 5) M(g, base, 6) M(g, base, 7)
#define ALL_OPS(M, g) ALL_I(M, g, C0) ALL_I(M, g, C8) ALL_I(M, g, E0) ALL_I(M, g, E8) ALL_I(M, g, F0) ALL_I(M, g, F8)
ALL_OPS(REG8, D8)
ALL_OPS(REG8, DC)
ALL_OPS(REG7, DE)

struct RegCase {
  void (*fn)(const double *, double *);
  int g, base, i;
};
#define ENT(g, base, i) {f_##g##_##base##_##i, 0x##g, 0x##base, i},
static const struct RegCase kReg[] = {ALL_OPS(ENT, D8) ALL_OPS(ENT, DC) ALL_OPS(ENT, DE)};

// what the manual says: a is st0, b is st(i)
static double arith(int base, double a, double b) {
  switch (base) {
    case 0xC0: return a + b;
    case 0xC8: return a * b;
    case 0xE0: return a - b;  // D8: fsub;  DC, DE: fsubr(p) st(i) = st0 - st(i)
    case 0xE8: return b - a;  // D8: fsubr; DC, DE: fsub(p)  st(i) = st(i) - st0
    case 0xF0: return a / b;  // D8: fdiv;  DC, DE: fdivr(p) st(i) = st0 / st(i)
    default: return b / a;    // D8: fdivr; DC, DE: fdiv(p)  st(i) = st(i) / st0
  }
}

static void regforms(void) {
  static const double in[8] = {2, -4, 0.25, 8, -0.5, 16, 64, -1};  // (powers of two: every result is exact)
  int before = bad;
  for (unsigned c = 0; c < sizeof(kReg) / sizeof(kReg[0]); ++c) {
    const struct RegCase *t = &kReg[c];
    double st[8], out[8] = {0}, r;
    int n = 8;
    memcpy(st, in, sizeof(st));
    r = arith(t->base, st[0], st[t->i]);
    if (t->g == 0xD8) {
      st[0] = r;
    } else {
      st[t->i] = r;
      if (t->g == 0xDE) memmove(st, st + 1, 7 * sizeof(double)), n = 7;
    }
    t->fn(in, out);
    for (int k = 0; k < n; ++k) {
      if (!same(out[k], st[k])) fail("register form", t->g, t->base + t->i, k, out[k], st[k]);
    }
  }
  printf("register forms: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 2. Memory forms: st0 = st0 op m for a float (D8), a double (DC), an int
//    (DA) and a short (DE). /4 is sub, /5 subr (m - st0), /6 div, /7 divr.

#define MEMFN(g, r)                                                                   \
  void m_##g##_##r(const double *, double *, const void *) __asm__("x87m_" #g "_" #r); \
  __asm__(".text\n.globl x87m_" #g "_" #r "\nx87m_" #g "_" #r ":\nfninit\nfldl (%rdi)\n" \
          ".byte 0x" #g ", (" #r "<<3)|2\nfstpl (%rsi)\nret\n");
#define MEM_OPS(g) MEMFN(g, 0) MEMFN(g, 1) MEMFN(g, 4) MEMFN(g, 5) MEMFN(g, 6) MEMFN(g, 7)
MEM_OPS(D8)
MEM_OPS(DC)
MEM_OPS(DA)
MEM_OPS(DE)
struct MemCase {
  void (*fn)(const double *, double *, const void *);
  int g, r;
};
#define MENT(g, r) {m_##g##_##r, 0x##g, r},
#define MEM_ENTS(g) MENT(g, 0) MENT(g, 1) MENT(g, 4) MENT(g, 5) MENT(g, 6) MENT(g, 7)
static const struct MemCase kMem[] = {MEM_ENTS(D8) MEM_ENTS(DC) MEM_ENTS(DA) MEM_ENTS(DE)};

static void memforms(void) {
  static const double st0s[] = {16, -0.5, 64};
  static const double ms[] = {4, -8, 0.5, 2};
  int before = bad;
  for (unsigned c = 0; c < sizeof(kMem) / sizeof(kMem[0]); ++c) {
    for (unsigned a = 0; a < 3; ++a) {
      for (unsigned b = 0; b < 4; ++b) {
        const struct MemCase *t = &kMem[c];
        double x = st0s[a], y = ms[b], got = 0, want;
        float f = (float)y;
        int32_t i32 = (int32_t)y;
        int16_t i16 = (int16_t)y;
        const void *p = t->g == 0xD8 ? (void *)&f : t->g == 0xDC ? (void *)&y : t->g == 0xDA ? (void *)&i32 : (void *)&i16;
        if (t->g == 0xDA || t->g == 0xDE) y = i32;  // (0.5 is 0 as an integer: skip the divisions by it)
        if (y == 0 && t->r >= 6) continue;
        want = t->r == 0 ? x + y : t->r == 1 ? x * y : t->r == 4 ? x - y : t->r == 5 ? y - x : t->r == 6 ? x / y : y / x;
        t->fn(&x, &got, p);
        if (!same(got, want)) fail("memory form", t->g, t->r << 3, 0, got, want);
      }
    }
  }
  printf("memory forms: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 3. Compares. st0 = a, st1 = b. The status word's C3 C2 C0 for the fcom
//    family, ZF PF CF for the fcomi family: 000 above, 001 below, 100 equal,
//    111 unordered.

#define CMPFN(name, code)                                                    \
  int c_##name(const double *, const double *) __asm__("x87c_" #name);       \
  __asm__(".text\n.globl x87c_" #name "\nx87c_" #name ":\nfninit\nfldl (%rsi)\nfldl (%rdi)\n" code "ret\n");
#define SW "fnstsw %ax\nshrl $8, %eax\nandl $0x45, %eax\n"
#define FL "lahf\nshrl $8, %eax\nandl $0x45, %eax\n"
CMPFN(fcom, ".byte 0xD8, 0xD1\n" SW "fstp %st(0)\nfstp %st(0)\n")
CMPFN(fcomp, ".byte 0xD8, 0xD9\n" SW "fstp %st(0)\n")
CMPFN(fcompp, ".byte 0xDE, 0xD9\n" SW)
CMPFN(fucom, ".byte 0xDD, 0xE1\n" SW "fstp %st(0)\nfstp %st(0)\n")
CMPFN(fucomp, ".byte 0xDD, 0xE9\n" SW "fstp %st(0)\n")
CMPFN(fucompp, ".byte 0xDA, 0xE9\n" SW)
CMPFN(fcomi, ".byte 0xDB, 0xF1\n" FL "fstp %st(0)\nfstp %st(0)\n")
CMPFN(fcomip, ".byte 0xDF, 0xF1\n" FL "fstp %st(0)\n")
CMPFN(fucomi, ".byte 0xDB, 0xE9\n" FL "fstp %st(0)\nfstp %st(0)\n")
CMPFN(fucomip, ".byte 0xDF, 0xE9\n" FL "fstp %st(0)\n")
CMPFN(fcoml, "fstp %st(1)\n.byte 0xDC, 0x16\n" SW "fstp %st(0)\n")   // fcoml (%rsi)
CMPFN(fcompl, "fstp %st(1)\n.byte 0xDC, 0x1E\n" SW)                  // fcompl (%rsi)

static void compares(void) {
  static const struct { const char *name; int (*fn)(const double *, const double *); } k[] = {
      {"fcom", c_fcom}, {"fcomp", c_fcomp}, {"fcompp", c_fcompp}, {"fucom", c_fucom}, {"fucomp", c_fucomp}, {"fucompp", c_fucompp},
      {"fcomi", c_fcomi}, {"fcomip", c_fcomip}, {"fucomi", c_fucomi}, {"fucomip", c_fucomip}, {"fcoml", c_fcoml}, {"fcompl", c_fcompl}};
  static const double v[] = {-2, -0.0, 0.0, 1, 1.5, 1e300, NAN};
  int before = bad;
  for (unsigned c = 0; c < sizeof(k) / sizeof(k[0]); ++c) {
    for (unsigned a = 0; a < 7; ++a) {
      for (unsigned b = 0; b < 7; ++b) {
        double x = v[a], y = v[b];
        int want = isnan(x) || isnan(y) ? 0x45 : x > y ? 0 : x < y ? 1 : 0x40;
        int got = k[c].fn(&x, &y);
        if (got != want && bad++ < 40) printf("%s(%g, %g): flags %#x, expected %#x\n", k[c].name, x, y, got, want);
      }
    }
  }
  printf("compares: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 4. Integers in and out: fild, and fist/fistp/fisttp under each rounding mode.

#define INTFN(name, code)                                                         \
  void i_##name(const void *, void *, const uint16_t *) __asm__("x87i_" #name);   \
  __asm__(".text\n.globl x87i_" #name "\nx87i_" #name ":\nfninit\nfldcw (%rdx)\n" code "ret\n");
INTFN(fild16, "filds (%rdi)\nfstpl (%rsi)\n")
INTFN(fild32, "fildl (%rdi)\nfstpl (%rsi)\n")
INTFN(fild64, "fildll (%rdi)\nfstpl (%rsi)\n")
INTFN(fist16, "fldl (%rdi)\nfists (%rsi)\nfstp %st(0)\n")
INTFN(fist32, "fldl (%rdi)\nfistl (%rsi)\nfstp %st(0)\n")
INTFN(fistp16, "fldl (%rdi)\nfistps (%rsi)\n")
INTFN(fistp32, "fldl (%rdi)\nfistpl (%rsi)\n")
INTFN(fistp64, "fldl (%rdi)\nfistpll (%rsi)\n")
INTFN(fisttp16, "fldl (%rdi)\nfisttps (%rsi)\n")
INTFN(fisttp32, "fldl (%rdi)\nfisttpl (%rsi)\n")
INTFN(fisttp64, "fldl (%rdi)\nfisttpll (%rsi)\n")
INTFN(frndint, "fldl (%rdi)\nfrndint\nfstpl (%rsi)\n")

static double roundmode(double x, int rc) {
  switch (rc) {
    case 0: return nearbyint(x);  // (the C default mode is to nearest even)
    case 1: return floor(x);
    case 2: return ceil(x);
    default: return trunc(x);
  }
}

static void integers(void) {
  static const double v[] = {0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.25, -2.75, 7, -7, 32767, -32768, 100000.5, -100000.5, 2147483647, 0.0, -0.0};
  static const int64_t iv[] = {0, 1, -1, 32767, -32768, 2147483647, -2147483647 - 1, 1ll << 40, -(1ll << 52), (1ll << 53) - 1};
  int before = bad;
  uint16_t cw = 0x37f;
  for (unsigned a = 0; a < sizeof(iv) / sizeof(iv[0]); ++a) {
    double got;
    int16_t s = (int16_t)iv[a];
    int32_t l = (int32_t)iv[a];
    i_fild16(&s, &got, &cw);
    if (got != (double)s && bad++ < 40) printf("fild16 %d: %.17g\n", s, got);
    i_fild32(&l, &got, &cw);
    if (got != (double)l && bad++ < 40) printf("fild32 %d: %.17g\n", l, got);
    i_fild64(&iv[a], &got, &cw);
    if (got != (double)iv[a] && bad++ < 40) printf("fild64 %lld: %.17g\n", (long long)iv[a], got);
  }
  for (int rc = 0; rc < 4; ++rc) {
    cw = 0x37f | rc << 10;
    for (unsigned a = 0; a < sizeof(v) / sizeof(v[0]); ++a) {
      double x = v[a], r = roundmode(x, rc), t = trunc(x), g;
      int16_t s;
      int32_t l;
      int64_t q;
      i_frndint(&x, &g, &cw);
      if (!same(g, r) && bad++ < 40) printf("frndint(%g) rc=%d: %.17g, expected %.17g\n", x, rc, g, r);
#define CHECK(name, var, want, lim)                                                                       \
  var = 77;                                                                                               \
  i_##name(&x, &var, &cw);                                                                                \
  if (fabs(want) < lim && (double)var != want && bad++ < 40) printf(#name "(%g) rc=%d: %lld, expected %g\n", x, rc, (long long)var, want);
      CHECK(fist16, s, r, 32768.0)
      CHECK(fistp16, s, r, 32768.0)
      CHECK(fisttp16, s, t, 32768.0)
      CHECK(fist32, l, r, 2147483648.0)
      CHECK(fistp32, l, r, 2147483648.0)
      CHECK(fisttp32, l, t, 2147483648.0)
      CHECK(fistp64, q, r, 9e18)
      CHECK(fisttp64, q, t, 9e18)
    }
  }
  // out of range: the integer indefinite
  {
    double x = 1e10;
    int16_t s = 0;
    int32_t l = 0;
    cw = 0x37f;
    i_fistp16(&x, &s, &cw);
    i_fistp32(&x, &l, &cw);
    if ((s != INT16_MIN || l != INT32_MIN) && bad++ < 40) printf("fistp of 1e10: %d %d\n", s, l);
  }
  printf("integers: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 5. The stack: fxch, fld st(i), fst st(i), fstp st(i), and the one-operand
//    instructions.

#define STKFN(name, code, tail) \
  void s_##name(const double *, double *) __asm__("x87s_" #name); \
  __asm__(".text\n.globl x87s_" #name "\nx87s_" #name ":\n" LOAD8 code STORE7 tail "ret\n");
STKFN(fxch3, "fxch %st(3)\n", "fstpl 56(%rsi)\n")
STKFN(fxch7, "fxch %st(7)\n", "fstpl 56(%rsi)\n")
STKFN(fst5, "fst %st(5)\n", "fstpl 56(%rsi)\n")
STKFN(fstp5, "fstp %st(5)\n", "")
STKFN(fstp0, "fstp %st(0)\n", "")
STKFN(fld4, "fstp %st(0)\nfld %st(4)\n", "fstpl 56(%rsi)\n")
STKFN(fchs, "fchs\n", "fstpl 56(%rsi)\n")
STKFN(fabs, "fxch %st(4)\nfabs\n", "fstpl 56(%rsi)\n")
STKFN(fsqrt, "fxch %st(6)\nfsqrt\n", "fstpl 56(%rsi)\n")
STKFN(fld1, "fstp %st(0)\nfld1\n", "fstpl 56(%rsi)\n")
STKFN(fldz, "fstp %st(0)\nfldz\n", "fstpl 56(%rsi)\n")
STKFN(fscale, "fxch %st(2)\nfscale\n", "fstpl 56(%rsi)\n")  // st0 = 0.25 * 2^(st1 = -4)

static void stack(void) {
  static const double in[8] = {2, -4, 0.25, 8, -0.5, 16, 64, -1};  // (powers of two: every result is exact)
  static const struct { const char *name; void (*fn)(const double *, double *); double want[8]; } k[] = {
      {"fxch st(3)", s_fxch3, {8, -4, 0.25, 2, -0.5, 16, 64, -1}},
      {"fxch st(7)", s_fxch7, {-1, -4, 0.25, 8, -0.5, 16, 64, 2}},
      {"fst st(5)", s_fst5, {2, -4, 0.25, 8, -0.5, 2, 64, -1}},
      {"fstp st(5)", s_fstp5, {-4, 0.25, 8, -0.5, 2, 64, -1, 0}},
      {"fstp st(0)", s_fstp0, {-4, 0.25, 8, -0.5, 16, 64, -1, 0}},
      {"fld st(4)", s_fld4, {16, -4, 0.25, 8, -0.5, 16, 64, -1}},
      {"fchs", s_fchs, {-2, -4, 0.25, 8, -0.5, 16, 64, -1}},
      {"fabs", s_fabs, {0.5, -4, 0.25, 8, 2, 16, 64, -1}},
      {"fsqrt", s_fsqrt, {8, -4, 0.25, 8, -0.5, 16, 2, -1}},
      {"fld1", s_fld1, {1, -4, 0.25, 8, -0.5, 16, 64, -1}},
      {"fldz", s_fldz, {0, -4, 0.25, 8, -0.5, 16, 64, -1}},
      {"fscale", s_fscale, {0.015625, -4, 2, 8, -0.5, 16, 64, -1}},
  };
  int before = bad;
  for (unsigned c = 0; c < sizeof(k) / sizeof(k[0]); ++c) {
    double out[8] = {0};
    k[c].fn(in, out);
    for (int i = 0; i < 8; ++i) {
      if (!same(out[i], k[c].want[i]) && bad++ < 40) printf("%s: st(%d) = %.17g, expected %.17g\n", k[c].name, i, out[i], k[c].want[i]);
    }
  }
  printf("stack: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 6. What the compiler makes of long double: a quadratic least squares
//    after tesseract's QLSQ (ccstruct/quadlsq.cpp), where #150 showed: its
//    last line, c = (sigy - a * sigxx - b * sigx) / n, compiles to fsubp into
//    st(2). Points on y = 3x^2 - 2x + 5 and y = 7x - 9 at small x: every sum
//    and product is an exact integer.

struct Qlsq {
  int n;
  long double a, b, c, sigx, sigy, sigxx, sigxy, sigxxx, sigxxy, sigxxxx;
};

static __attribute__((noinline)) void qadd(struct Qlsq *q, double x, double y) {
  q->n++;
  q->sigx += x;
  q->sigy += y;
  q->sigxx += x * x;
  q->sigxy += x * y;
  q->sigxxx += (long double)x * x * x;
  q->sigxxy += (long double)x * x * y;
  q->sigxxxx += (long double)x * x * x * x;
}

static __attribute__((noinline)) void qfit(struct Qlsq *q, int degree) {
  const long double kMinVariance = 1.0L / 1024;
  int n = q->n;
  long double x_variance = q->sigxx * n - q->sigx * q->sigx;
  if (x_variance < kMinVariance * n * n || degree < 1 || n < 2) {
    q->a = q->b = 0.0;
    q->c = n >= 1 && degree >= 0 ? q->sigy / n : 0.0;
    return;
  }
  long double top96 = 0.0, bottom96 = 0.0;
  long double cubevar = q->sigxxx * n - q->sigxx * q->sigx;
  long double covariance = q->sigxy * n - q->sigx * q->sigy;
  if (n >= 4 && degree >= 2) {
    top96 = cubevar * covariance;
    top96 += x_variance * (q->sigxx * q->sigy - q->sigxxy * n);
    bottom96 = cubevar * cubevar;
    bottom96 -= x_variance * (q->sigxxxx * n - q->sigxx * q->sigxx);
    q->a = bottom96 <= -kMinVariance * n * n * n * n ? top96 / bottom96 : 0.0;
  } else {
    q->a = 0.0;
  }
  q->b = (covariance - cubevar * q->a) / x_variance;
  q->c = (q->sigy - q->a * q->sigxx - q->b * q->sigx) / n;
}

static void longdouble(void) {
  int before = bad;
  for (int degree = 1; degree <= 2; ++degree) {
    struct Qlsq q;
    memset(&q, 0, sizeof(q));
    for (int x = -3; x <= 4; ++x) qadd(&q, x, degree == 2 ? 3 * x * x - 2 * x + 5 : 7 * x - 9);
    qfit(&q, degree);
    double a = q.a, b = q.b, c = q.c;
    double wa = degree == 2 ? 3 : 0, wb = degree == 2 ? -2 : 7, wc = degree == 2 ? 5 : -9;
    if ((a != wa || b != wb || c != wc) && bad++ < 40) printf("least squares, degree %d: a=%.17g b=%.17g c=%.17g, expected %g %g %g\n", degree, a, b, c, wa, wb, wc);
  }
  // the first text line of the page in #150: its baseline is near y = 120
  {
    static const int pts[][2] = {{64, 120}, {93, 119}, {118, 119}, {145, 120}, {174, 120}, {207, 119}, {239, 120},
                                 {270, 120}, {278, 120}, {303, 119}, {330, 120}, {343, 119}, {368, 120}, {390, 115}};
    struct Qlsq q;
    memset(&q, 0, sizeof(q));
    for (unsigned i = 0; i < sizeof(pts) / sizeof(pts[0]); ++i) qadd(&q, pts[i][0], pts[i][1]);
    qfit(&q, 2);
    double y = (double)((q.a * 200 + q.b) * 200 + q.c);
    if (!(y > 117 && y < 122) && bad++ < 40) printf("the baseline of #150 at x=200: %.6g, expected about 120\n", y);
  }
  printf("long double: %s\n", bad == before ? "ok" : "WRONG");
}

// ---------------------------------------------------------------------------
// 7. The rest: fcmovcc, ftst, fxam, fprem and fprem1, fxtract, the constants,
//    and the transcendental instructions (those within 64 ulp of libm: the
//    last bits differ between an x87 and a double implementation).

// fcmovcc st, st(1) after `cmp %esi, %edi` (unsigned) or with PF from `test`
#define CMOVFN(name, b0, b1)                                              \
  void v_##name(const double *, double *, unsigned, unsigned) __asm__("x87v_" #name); \
  __asm__(".text\n.globl x87v_" #name "\nx87v_" #name ":\nfninit\nfldl 8(%rdi)\nfldl (%rdi)\n" \
          "cmpl %ecx, %edx\n.byte " #b0 ", " #b1 "\nfstpl (%rsi)\nfstp %st(0)\nret\n");
CMOVFN(fcmovb, 0xDA, 0xC1)
CMOVFN(fcmove, 0xDA, 0xC9)
CMOVFN(fcmovbe, 0xDA, 0xD1)
CMOVFN(fcmovnb, 0xDB, 0xC1)
CMOVFN(fcmovne, 0xDB, 0xC9)
CMOVFN(fcmovnbe, 0xDB, 0xD1)
// PF: `test %dl, %dl` sets it for a byte of even parity
#define CMOVPFN(name, b0, b1)                                             \
  void v_##name(const double *, double *, unsigned, unsigned) __asm__("x87v_" #name); \
  __asm__(".text\n.globl x87v_" #name "\nx87v_" #name ":\nfninit\nfldl 8(%rdi)\nfldl (%rdi)\n" \
          "testb %dl, %dl\n.byte " #b0 ", " #b1 "\nfstpl (%rsi)\nfstp %st(0)\nret\n");
CMOVPFN(fcmovu, 0xDA, 0xD9)
CMOVPFN(fcmovnu, 0xDB, 0xD9)

#define ONEFN(name, code)                                            \
  int o_##name(const double *, double *) __asm__("x87o_" #name);     \
  __asm__(".text\n.globl x87o_" #name "\nx87o_" #name ":\nfninit\n" code "ret\n");
#define SWALL "fnstsw %ax\nshrl $8, %eax\nandl $0x47, %eax\n"
ONEFN(ftst, "fldl (%rdi)\nftst\n" SWALL "fstp %st(0)\n")
ONEFN(fxam, "fldl (%rdi)\nfxam\n" SWALL "fstp %st(0)\n")
ONEFN(fxam_empty, "fxam\n" SWALL)
ONEFN(fprem, "fldl 8(%rdi)\nfldl (%rdi)\nfprem\nfstpl (%rsi)\nfstp %st(0)\n")
ONEFN(fprem1, "fldl 8(%rdi)\nfldl (%rdi)\nfprem1\nfstpl (%rsi)\nfstp %st(0)\n")
ONEFN(fxtract, "fldl (%rdi)\nfxtract\nfstpl (%rsi)\nfstpl 8(%rsi)\n")
ONEFN(consts, "fld1\nfstpl (%rsi)\nfldl2t\nfstpl 8(%rsi)\nfldl2e\nfstpl 16(%rsi)\nfldpi\nfstpl 24(%rsi)\nfldlg2\nfstpl 32(%rsi)\nfldln2\nfstpl 40(%rsi)\nfldz\nfstpl 48(%rsi)\n")
ONEFN(fsin, "fldl (%rdi)\nfsin\nfstpl (%rsi)\n")
ONEFN(fcos, "fldl (%rdi)\nfcos\nfstpl (%rsi)\n")
ONEFN(fsincos, "fldl (%rdi)\nfsincos\nfstpl 8(%rsi)\nfstpl (%rsi)\n")
ONEFN(fptan, "fldl (%rdi)\nfptan\nfstpl 8(%rsi)\nfstpl (%rsi)\n")
ONEFN(fpatan, "fldl (%rdi)\nfldl 8(%rdi)\nfpatan\nfstpl (%rsi)\n")       // atan2(in[0], in[1])
ONEFN(fyl2x, "fldl 8(%rdi)\nfldl (%rdi)\nfyl2x\nfstpl (%rsi)\n")         // in[1] * log2(in[0])
ONEFN(fyl2xp1, "fldl 8(%rdi)\nfldl (%rdi)\nfyl2xp1\nfstpl (%rsi)\n")     // in[1] * log2(in[0] + 1)
ONEFN(f2xm1, "fldl (%rdi)\nf2xm1\nfstpl (%rsi)\n")
ONEFN(fsqrt, "fldl (%rdi)\nfsqrt\nfstpl (%rsi)\n")

static int within(double got, double want, int ulps) {
  if (same(got, want)) return 1;
  return fabs(got - want) <= ulps * fabs(nextafter(want, INFINITY) - want);
}
#define near(got, want) within(got, want, 64)  // (Rosetta's fyl2xp1 is 6 ulp from libm's)

static void rest(void) {
  int before = bad;
  // fcmovcc: st0 = 1, st1 = 2
  {
    static const struct { const char *name; void (*fn)(const double *, double *, unsigned, unsigned); int kind; } k[] = {
        {"fcmovb", v_fcmovb, 0}, {"fcmove", v_fcmove, 1}, {"fcmovbe", v_fcmovbe, 2}, {"fcmovnb", v_fcmovnb, 3},
        {"fcmovne", v_fcmovne, 4}, {"fcmovnbe", v_fcmovnbe, 5}, {"fcmovu", v_fcmovu, 6}, {"fcmovnu", v_fcmovnu, 7}};
    static const unsigned pairs[][2] = {{1, 2}, {2, 2}, {3, 2}, {0, 0xffffffffu}};
    static const double in[2] = {1, 2};
    for (unsigned c = 0; c < 8; ++c) {
      for (unsigned p = 0; p < 4; ++p) {
        unsigned a = pairs[p][0], b = pairs[p][1];
        int parity = !(__builtin_popcount(a & 255) & 1), take;
        double got = 0;
        switch (k[c].kind) {
          case 0: take = a < b; break;
          case 1: take = a == b; break;
          case 2: take = a <= b; break;
          case 3: take = a >= b; break;
          case 4: take = a != b; break;
          case 5: take = a > b; break;
          case 6: take = parity; break;
          default: take = !parity; break;
        }
        k[c].fn(in, &got, a, b);
        if (got != (take ? 2 : 1) && bad++ < 40) printf("%s with %u, %u: st0 = %g, expected %d\n", k[c].name, a, b, got, take ? 2 : 1);
      }
    }
  }
  // ftst: C3 C2 C0 as a compare with 0. fxam: C3 C2 C1 C0 = the class and the sign.
  {
    static const double v[] = {-1.5, -0.0, 0.0, 2, NAN, INFINITY, -INFINITY, 4.9e-324};
    for (unsigned a = 0; a < sizeof(v) / sizeof(v[0]); ++a) {
      double x = v[a], out[2];
      int want = isnan(x) ? 0x45 : x > 0 ? 0 : x < 0 ? 1 : 0x40;
      int got = o_ftst(&x, out) & 0x45;
      if (got != want && bad++ < 40) printf("ftst(%g): %#x, expected %#x\n", x, got, want);
      // C0 = 1, C1 = 2, C2 = 4, C3 = 0x40: NaN 001, normal 010, infinity 011, zero 100
      // (a subnormal double is a normal number in a register: it has 15 bits of exponent)
      want = (isnan(x) ? 1 : isinf(x) ? 5 : x == 0 ? 0x40 : 4) | (signbit(x) ? 2 : 0);
      got = o_fxam(&x, out);
      if (got != want && bad++ < 40) printf("fxam(%g): %#x, expected %#x\n", x, got, want);
    }
    double x = 0, out[2];
    int got = o_fxam_empty(&x, out) & 0x45;
    if (got != 0x41 && bad++ < 40) printf("fxam of an empty register: %#x, expected 0x41\n", got);
  }
  // fprem truncates the quotient, fprem1 rounds it to nearest even
  {
    static const double v[][4] = {{17, 5, 2, 2}, {-17, 5, -2, -2}, {14, 4, 2, -2}, {10, 4, 2, 2}, {7.5, 2, 1.5, -0.5}, {1, 8, 1, 1}, {-9, -4, -1, -1}};
    for (unsigned a = 0; a < sizeof(v) / sizeof(v[0]); ++a) {
      double got = 0;
      o_fprem(v[a], &got);
      if (!same(got, v[a][2]) && bad++ < 40) printf("fprem(%g, %g) = %.17g, expected %g\n", v[a][0], v[a][1], got, v[a][2]);
      o_fprem1(v[a], &got);
      if (!same(got, v[a][3]) && bad++ < 40) printf("fprem1(%g, %g) = %.17g, expected %g\n", v[a][0], v[a][1], got, v[a][3]);
    }
  }
  // fxtract: the significand in [1, 2) and the exponent
  {
    static const double v[][3] = {{8, 1, 3}, {0.75, 1.5, -1}, {-20, -1.25, 4}, {1, 1, 0}};
    for (unsigned a = 0; a < sizeof(v) / sizeof(v[0]); ++a) {
      double out[2] = {0, 0};
      o_fxtract(v[a], out);
      if ((!same(out[0], v[a][1]) || !same(out[1], v[a][2])) && bad++ < 40) printf("fxtract(%g) = %g * 2^%g, expected %g * 2^%g\n", v[a][0], out[0], out[1], v[a][1], v[a][2]);
    }
  }
  // the constants, as the nearest doubles
  {
    static const double want[7] = {1, 3.3219280948873622, 1.4426950408889634, 3.1415926535897931, 0.3010299956639812, 0.69314718055994529, 0};
    static const char *const name[7] = {"fld1", "fldl2t", "fldl2e", "fldpi", "fldlg2", "fldln2", "fldz"};
    double x = 0, out[7] = {9, 9, 9, 9, 9, 9, 9};
    o_consts(&x, out);
    for (int i = 0; i < 7; ++i) {
      if (!within(out[i], want[i], 1) && bad++ < 40) printf("%s = %.17g, expected %.17g\n", name[i], out[i], want[i]);
    }
  }
  // transcendentals, against libm
  {
    static const double v[] = {0.1, 0.5, 1, 2.5, -0.75};
    for (unsigned a = 0; a < sizeof(v) / sizeof(v[0]); ++a) {
      double x = v[a], in[2], out[2];
#define T1(name, expr)                                                                                        \
  out[0] = out[1] = 0;                                                                                        \
  o_##name(in, out);                                                                                          \
  if (!near(out[0], expr) && bad++ < 40) printf(#name "(%g) = %.17g, expected %.17g\n", x, out[0], (double)(expr));
      in[0] = x, in[1] = 3;
      T1(fsin, sin(x))
      T1(fcos, cos(x))
      T1(fsincos, sin(x))
      if (!near(out[1], cos(x)) && bad++ < 40) printf("fsincos(%g): cos = %.17g, expected %.17g\n", x, out[1], cos(x));
      T1(fptan, tan(x))
      if (out[1] != 1 && bad++ < 40) printf("fptan(%g) pushed %.17g, expected 1\n", x, out[1]);
      T1(fpatan, atan2(x, 3))
      if (x > 0) {
        T1(fyl2x, 3 * log2(x))
        T1(fsqrt, sqrt(x))
      }
      if (fabs(x) < 0.29) {
        T1(fyl2xp1, 3 * log2(x + 1))
      }
      if (fabs(x) <= 1) {
        T1(f2xm1, exp2(x) - 1)
      }
    }
  }
  printf("the rest: %s\n", bad == before ? "ok" : "WRONG");
}

int main(void) {
  regforms();
  memforms();
  compares();
  integers();
  stack();
  longdouble();
  rest();
  if (!bad) puts("x87ops ok");
  return !!bad;
}
