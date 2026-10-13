// Fixture for x86-engine.test.ts: one checksum per SSE/SSE2/SSE3/SSSE3
// instruction form over a fixed set of operands (special floats, saturating
// integers, shift counts past the width), for comparing an emulator with a
// real x86 (tabcomputer#150's wider check). Each instruction runs as
// `op %xmm1, %xmm0` (or `op (%rsi), %xmm0`, `op $imm, ...`, to or from a
// general register, or for its flags) with xmm0 = A and xmm1 = B; all 128
// bits of xmm0 and rax go into the checksum, so the lanes an instruction
// must leave alone count too.
// Build: gcc -static -O1 -o ssediff ssediff.c
//   ./ssediff          "name checksum" per instruction
//   ./ssediff NAME     that instruction's result for each operand pair
// fixtures/x86/ssediff.expected is this program's output on x86-64 hardware
// semantics (macOS x86-64 build under Rosetta 2).
#include <stdint.h>
#include <stdio.h>
#include <string.h>

struct Out {
  uint64_t lo, hi, rax;
};
typedef void fn_t(const void *a, const void *b, struct Out *out);

#define BODY(name, body)                                                          \
  fn_t t_##name __asm__("ssediff_" #name);                                        \
  __asm__(".text\n.globl ssediff_" #name "\nssediff_" #name ":\n"                 \
          "movdqu (%rdi), %xmm0\nmovdqu (%rsi), %xmm1\nmovq (%rsi), %rcx\nxorl %eax, %eax\n" \
          body "\nmovdqu %xmm0, (%rdx)\nmovq %rax, 16(%rdx)\nret\n");
#define RR(mn) BODY(mn##_rr, #mn " %xmm1, %xmm0")
#define RM(mn) BODY(mn##_rm, #mn " (%rsi), %xmm0")
#define RRM(mn) RR(mn) RM(mn)
#define RRI(mn, imm) BODY(mn##_##imm, #mn " $" #imm ", %xmm1, %xmm0")
#define SHI(mn, imm) BODY(mn##_i##imm, #mn " $" #imm ", %xmm0")
#define XG32(mn) BODY(mn##_g32, #mn " %xmm1, %eax")
#define XG64(mn) BODY(mn##_g64, #mn " %xmm1, %rax")
#define GX32(mn) BODY(mn##_x32, #mn " %ecx, %xmm0")
#define GX64(mn) BODY(mn##_x64, #mn " %rcx, %xmm0")
#define FLAGS(mn) BODY(mn##_fl, #mn " %xmm1, %xmm0\npushfq\npopq %rax\nandl $0x8d5, %eax")

#define TESTS(F2, F3, FS)                                                                              \
  /* SSE, packed and scalar single */                                                                  \
  F2(RRM, addps) F2(RRM, subps) F2(RRM, mulps) F2(RRM, divps) F2(RRM, minps) F2(RRM, maxps)            \
  F2(RRM, sqrtps) F2(RRM, andps) F2(RRM, andnps) F2(RRM, orps) F2(RRM, xorps)                          \
  F2(RRM, unpcklps) F2(RRM, unpckhps) F2(RR, movaps) F2(RRM, movups) F2(RR, movhlps) F2(RR, movlhps)   \
  F2(RRM, addss) F2(RRM, subss) F2(RRM, mulss) F2(RRM, divss) F2(RRM, minss) F2(RRM, maxss)            \
  F2(RRM, sqrtss) F2(RRM, movss) F2(RRM, cvtss2sd) F2(RRM, cvtps2pd) F2(RRM, cvtdq2ps)                 \
  F2(RRM, cvtps2dq) F2(RRM, cvttps2dq) F2(RM, movlps) F2(RM, movhps)                                   \
  F3(RRI, cmpps, 0) F3(RRI, cmpps, 1) F3(RRI, cmpps, 2) F3(RRI, cmpps, 3) F3(RRI, cmpps, 4)            \
  F3(RRI, cmpps, 5) F3(RRI, cmpps, 6) F3(RRI, cmpps, 7) F3(RRI, cmpss, 1) F3(RRI, cmpss, 3)            \
  F3(RRI, cmpss, 6) F3(RRI, shufps, 0x1b) F3(RRI, shufps, 0xe4) F3(RRI, shufps, 0x4e)                  \
  /* SSE2, packed and scalar double */                                                                 \
  F2(RRM, addpd) F2(RRM, subpd) F2(RRM, mulpd) F2(RRM, divpd) F2(RRM, minpd) F2(RRM, maxpd)            \
  F2(RRM, sqrtpd) F2(RRM, andpd) F2(RRM, andnpd) F2(RRM, orpd) F2(RRM, xorpd)                          \
  F2(RRM, unpcklpd) F2(RRM, unpckhpd) F2(RR, movapd) F2(RRM, movupd)                                   \
  F2(RRM, addsd) F2(RRM, subsd) F2(RRM, mulsd) F2(RRM, divsd) F2(RRM, minsd) F2(RRM, maxsd)            \
  F2(RRM, sqrtsd) F2(RRM, movsd) F2(RRM, cvtsd2ss) F2(RRM, cvtpd2ps) F2(RRM, cvtdq2pd)                 \
  F2(RRM, cvtpd2dq) F2(RRM, cvttpd2dq) F2(RM, movlpd) F2(RM, movhpd)                                   \
  F3(RRI, cmppd, 0) F3(RRI, cmppd, 1) F3(RRI, cmppd, 2) F3(RRI, cmppd, 3) F3(RRI, cmppd, 4)            \
  F3(RRI, cmppd, 5) F3(RRI, cmppd, 6) F3(RRI, cmppd, 7) F3(RRI, cmpsd, 0) F3(RRI, cmpsd, 2)            \
  F3(RRI, cmpsd, 5) F3(RRI, shufpd, 1) F3(RRI, shufpd, 2)                                              \
  /* SSE2 integer */                                                                                   \
  F2(RR, movdqa) F2(RRM, movdqu) F2(RRM, movq)                                                         \
  F2(RRM, paddb) F2(RRM, paddw) F2(RRM, paddd) F2(RRM, paddq) F2(RRM, paddsb) F2(RRM, paddsw)          \
  F2(RRM, paddusb) F2(RRM, paddusw) F2(RRM, psubb) F2(RRM, psubw) F2(RRM, psubd) F2(RRM, psubq)        \
  F2(RRM, psubsb) F2(RRM, psubsw) F2(RRM, psubusb) F2(RRM, psubusw) F2(RRM, pmullw) F2(RRM, pmulhw)    \
  F2(RRM, pmulhuw) F2(RRM, pmuludq) F2(RRM, pmaddwd) F2(RRM, pand) F2(RRM, pandn) F2(RRM, por)         \
  F2(RRM, pxor) F2(RRM, pcmpeqb) F2(RRM, pcmpeqw) F2(RRM, pcmpeqd) F2(RRM, pcmpgtb) F2(RRM, pcmpgtw)   \
  F2(RRM, pcmpgtd) F2(RRM, pminub) F2(RRM, pmaxub) F2(RRM, pminsw) F2(RRM, pmaxsw) F2(RRM, pavgb)      \
  F2(RRM, pavgw) F2(RRM, psadbw) F2(RRM, packsswb) F2(RRM, packssdw) F2(RRM, packuswb)                 \
  F2(RRM, punpcklbw) F2(RRM, punpcklwd) F2(RRM, punpckldq) F2(RRM, punpcklqdq)                         \
  F2(RRM, punpckhbw) F2(RRM, punpckhwd) F2(RRM, punpckhdq) F2(RRM, punpckhqdq)                         \
  F2(RRM, psllw) F2(RRM, pslld) F2(RRM, psllq) F2(RRM, psrlw) F2(RRM, psrld) F2(RRM, psrlq)            \
  F2(RRM, psraw) F2(RRM, psrad)                                                                        \
  F3(RRI, pshufd, 0x1b) F3(RRI, pshufd, 0x4e) F3(RRI, pshuflw, 0x1b) F3(RRI, pshuflw, 0x93)            \
  F3(RRI, pshufhw, 0x1b) F3(RRI, pshufhw, 0x93)                                                        \
  FS(psllw, 0) FS(psllw, 5) FS(psllw, 15) FS(psllw, 16) FS(pslld, 7) FS(pslld, 31) FS(pslld, 32)       \
  FS(psllq, 9) FS(psllq, 63) FS(psllq, 64) FS(psrlw, 5) FS(psrlw, 16) FS(psrld, 7) FS(psrld, 32)       \
  FS(psrlq, 9) FS(psrlq, 64) FS(psraw, 5) FS(psraw, 15) FS(psraw, 16) FS(psrad, 7) FS(psrad, 31)       \
  FS(psrad, 32) FS(pslldq, 0) FS(pslldq, 3) FS(pslldq, 15) FS(pslldq, 16) FS(psrldq, 3)                \
  FS(psrldq, 15) FS(psrldq, 16)                                                                        \
  /* SSE3 and SSSE3 */                                                                                 \
  F2(RRM, addsubps) F2(RRM, addsubpd) F2(RRM, haddps) F2(RRM, haddpd) F2(RRM, hsubps) F2(RRM, hsubpd)  \
  F2(RRM, movsldup) F2(RRM, movshdup) F2(RRM, movddup) F2(RM, lddqu)                                   \
  F2(RRM, pshufb) F2(RRM, phaddw) F2(RRM, phaddd) F2(RRM, phaddsw) F2(RRM, phsubw) F2(RRM, phsubd)     \
  F2(RRM, phsubsw) F2(RRM, pmaddubsw) F2(RRM, pmulhrsw) F2(RRM, psignb) F2(RRM, psignw)                \
  F2(RRM, psignd) F2(RRM, pabsb) F2(RRM, pabsw) F2(RRM, pabsd)                                         \
  F3(RRI, palignr, 0) F3(RRI, palignr, 5) F3(RRI, palignr, 16) F3(RRI, palignr, 21) F3(RRI, palignr, 32) \
  /* to and from the general registers, and flags */                                                   \
  F2(XG32, cvtsd2si) F2(XG64, cvtsd2si) F2(XG32, cvttsd2si) F2(XG64, cvttsd2si)                        \
  F2(XG32, cvtss2si) F2(XG64, cvtss2si) F2(XG32, cvttss2si) F2(XG64, cvttss2si)                        \
  F2(XG32, movd) F2(XG64, movq) F2(XG32, pmovmskb) F2(XG32, movmskps) F2(XG32, movmskpd)               \
  F2(GX32, cvtsi2sd) F2(GX64, cvtsi2sdq) F2(GX32, cvtsi2ss) F2(GX64, cvtsi2ssq) F2(GX32, movd)         \
  F2(GX64, movq)                                                                                       \
  F2(FLAGS, comisd) F2(FLAGS, ucomisd) F2(FLAGS, comiss) F2(FLAGS, ucomiss)

#define D2(form, mn) form(mn)
#define D3(form, mn, imm) form(mn, imm)
#define DS(mn, imm) SHI(mn, imm)
TESTS(D2, D3, DS)
// (pextrw and pinsrw take a general register: written out)
BODY(pextrw_3, "pextrw $3, %xmm1, %eax")
BODY(pextrw_6, "pextrw $6, %xmm1, %eax")
BODY(pinsrw_2, "pinsrw $2, %ecx, %xmm0")
BODY(pinsrw_7, "pinsrw $7, %ecx, %xmm0")

struct Test {
  const char *name;
  fn_t *fn;
};
#define E_RR(mn) {#mn " xmm", t_##mn##_rr},
#define E_RM(mn) {#mn " mem", t_##mn##_rm},
#define E_RRM(mn) E_RR(mn) E_RM(mn)
#define E_XG32(mn) {#mn " to r32", t_##mn##_g32},
#define E_XG64(mn) {#mn " to r64", t_##mn##_g64},
#define E_GX32(mn) {#mn " from r32", t_##mn##_x32},
#define E_GX64(mn) {#mn " from r64", t_##mn##_x64},
#define E_FLAGS(mn) {#mn " flags", t_##mn##_fl},
#define E2(form, mn) E_##form(mn)
#define E3(form, mn, imm) {#mn " " #imm, t_##mn##_##imm},
#define ES(mn, imm) {#mn " imm " #imm, t_##mn##_i##imm},
static const struct Test kTests[] = {
    TESTS(E2, E3, ES)
    {"pextrw 3", t_pextrw_3}, {"pextrw 6", t_pextrw_6}, {"pinsrw 2", t_pinsrw_2}, {"pinsrw 7", t_pinsrw_7},
};

// operand pairs: A (xmm0) and B (xmm1, the memory operand, and rcx)
static const uint64_t kPairs[][4] __attribute__((aligned(16))) = {
    {0x3ff8000000000000ull, 0xc002000000000000ull, 0x3fe8000000000000ull, 0x4008000000000000ull},  // doubles
    {0x7ff8000000000000ull, 0x7ff0000000000000ull, 0x8000000000000000ull, 0x0000000000000001ull},  // a NaN, an infinity, -0, the smallest subnormal
    {0x800000003fc00000ull, 0x7f61b1e67f800000ull, 0x0000000040200000ull, 0x7f61b1e6ff800000ull},  // floats, with -0 and infinities
    {0x7fffffff80000000ull, 0x00000001ffffffffull, 0x8000000000000001ull, 0xffff00000000ffffull},  // integer edges
    {0x81fe010200ff7f80ull, 0xdeadbeef7f7f8080ull, 0x112233440180ff7full, 0x0102030480808080ull},  // byte edges
    {0x7fe1ccf385ebc8a0ull, 0xffe1ccf385ebc8a0ull, 0x7fe1ccf385ebc8a0ull, 0x00000000000007e8ull},  // doubles at the top and the bottom of the range
    {0x3f8000007fc00000ull, 0x00000001bf800000ull, 0x7fc000003f800000ull, 0x0000000140000000ull},  // floats with NaNs
    {0x0123456789abcdefull, 0xfedcba9876543210ull, 0x0000000000000003ull, 0x0000000000000000ull},  // a shift count of 3
    {0xf123456789abcdefull, 0x8edcba9876543210ull, 0x0000000000000028ull, 0x0000000000000001ull},  // a shift count of 40
    {0x41dfffffffc00000ull, 0xc1e0000000000000ull, 0x43e0000000000000ull, 0x4f0000004effffffull},  // doubles and floats at the integer limits
    {0x4004000000000000ull, 0xbff8000000000000ull, 0x400c000000000000ull, 0x3fe0000000000000ull},  // doubles halfway between integers
    {0x3f000000bfc00000ull, 0x40200000c0600000ull, 0xbf00000040a00000ull, 0x3fc000003f000000ull},  // floats halfway between integers
};
#define NPAIRS (sizeof(kPairs) / sizeof(kPairs[0]))

int main(int argc, char **argv) {
  for (unsigned t = 0; t < sizeof(kTests) / sizeof(kTests[0]); ++t) {
    uint64_t h = 0xcbf29ce484222325ull;
    int show = argc > 1 && !strcmp(argv[1], kTests[t].name);
    for (unsigned p = 0; p < NPAIRS; ++p) {
      struct Out o = {0, 0, 0};
      kTests[t].fn(&kPairs[p][0], &kPairs[p][2], &o);
      const uint64_t v[3] = {o.lo, o.hi, o.rax};
      for (int i = 0; i < 3; ++i) {
        for (int b = 0; b < 8; ++b) h = (h ^ ((v[i] >> (b * 8)) & 255)) * 0x100000001b3ull;
      }
      if (show) printf("  pair %2u: xmm0 %016llx %016llx  rax %016llx\n", p, (unsigned long long)o.hi, (unsigned long long)o.lo, (unsigned long long)o.rax);
    }
    if (argc < 2 || show) printf("%s %016llx\n", kTests[t].name, (unsigned long long)h);
  }
  return 0;
}
