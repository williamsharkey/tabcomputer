# Blink: instructions that computed wrongly, and how they were found

2026-10-13, branch unix/blink-miscompute, Blink patches 0554–0557. For
tabcomputer#150 (Debian's tesseract read the first lines of a clean page as
nonsense) and the wider check it asked for.

**Result.** Eleven faults in the emulator's x87 and SSE2 instructions, all
in Blink's own handlers (the JIT has no x87 code and calls these). The
issue's page now reads right, numpy's "invalid value encountered" warnings
are gone, and two fixtures check every x87 form and 378 SSE forms against
x86-64 itself.

## The cause of #150

`tesseract p.png -` with the JIT off (`BLINK_WJIT=0`) gave the same wrong
text, so it was an instruction, not a miscompile. Cropping the page showed
that a text line alone read right and two lines together lost one: the
fault was in finding lines, not in reading them. tesseract's own debug
output (`-c textord_debug_xheights=1` and friends), run natively and in the
engine and compared, first differed in the heights of the blobs above each
row's baseline: one blob 82 pixels high where there are thirteen of 22 to
31.

The baseline is a quadratic fitted in `long double` (`QLSQ::fit`,
ccstruct/quadlsq.cpp). A copy of that function in C gave the same `a` and
`b` in `long double` and in `double`, and a constant term of 0.99 where it
is 120.3. Its last line, `c = (sigy - a * sigxx - b * sigx) / n`, compiles
to `fsubp %st, %st(2)` (bytes DE EA), and Blink's handler for DE E8+i wrote
its result to st(1) whatever i was. With i = 1 that is right, and i = 1 is
what compilers emit until three or more `long double` values are live.
Debian's libtesseract has the encoding three times (st(2), st(6), st(7)),
all in that function. With the baseline a hundred pixels off, a row's
blobs fell outside it and the row was dropped or merged with the next.

## What was wrong

| | Instruction | Was | Patch |
|---|---|---|---|
| 1 | `fsubp %st,%st(i)` (DE E8+i) | the result went to st(1) for every i | 0554 |
| 2 | `fdiv`/`fdivr %st,%st(i)` (DC F8+i, DC F0+i) | each did the other's division | 0554 |
| 3 | `fucompp` (DA E9) | SIGILL | 0554 |
| 4 | `fist`, `fistp`, `fisttp` of a value that doesn't fit | a saturated number (1e10 as INT_MAX; -1 in 16 bits), not the integer indefinite; no IE | 0554, 0557 |
| 5 | `fxam` of a subnormal double | "denormal"; in a register it is a normal number | 0554 |
| 6 | `cvttpd2dq` and `cvtpd2dq` (66/F2 0F E6) | each did the other's: a vectorized `(int)x` on doubles rounded to nearest | 0555 |
| 7 | `cvttpd2dq`, `cvtpd2dq`, `cvtpd2ps` | the destination's upper 64 bits were left as they were, not zeroed | 0555 |
| 8 | x87 `fsub` with one infinite operand | inf - 1 was -inf and 1 - inf was inf; x / -0 took the dividend's sign alone; invalid operations gave NaNs of various signs | 0556 |
| 9 | `fxsave` / `fxrstor` | the x87 tags came back with registers 4 to 7 "in use" | 0557 |
| 10 | `fucom`, `fucomp`, `fucompp`, `fucomi`, `fucomip` with a quiet NaN | raised IE (only `fcom` and its kind do) | 0557 |
| 11 | `fprem`, `fprem1` with a negative quotient | C0, C3 and C1 from its two's complement, not its magnitude | 0557 |

Number 9 is the one with reach. ld.so runs `fxsave` and `fxrstor` around the
first call of each library function, so in any dynamically linked program
the next x87 code whose push landed on one of those four registers got a
stack overflow: IE and SF in the status word, with the right values. gcc's
inline `fmod` (`fld; fld; fprem`) and libm's `long double` code are such
code, and numpy reads the flags after each loop. That is where "invalid
value encountered in remainder" (and in cast, multiply, reduce, exp2, log10
for `long double`) came from: #110 item 6.

## The reference: Rosetta

There is no x86 machine here and no way to run a Linux binary on one. But a
Mac runs x86-64 macOS programs under Rosetta 2, which implements the
instructions faithfully (the x87 at 80 bits, SSE with x86's NaN rules). So
a fixture that is plain C with inline assembly is built twice, for x86-64
macOS and for x86-64 Linux (clang and musl), and run under Rosetta and
under Blink.

- `fixtures/x86/x87ops.c` (`x87-ops.test.ts`) checks itself against the
  Intel manual's definitions: every register form of add, mul, sub, subr,
  div and divr (D8, DC, DE with each of st(0)..st(7)), the memory forms
  (float, double, int, short), with infinities, zeros and a NaN; the
  compares; `fild`/`fist`/`fistp`/`fisttp` under each rounding mode; the
  stack instructions; a `long double` least squares after tesseract's;
  `fcmovcc`, `ftst`, `fxam`, `fprem`, `fxtract`, the constants, the
  transcendentals within 64 ulp of libm; the exception flags after
  ordinary instructions and the tags across `fxsave`/`fxrstor`. Operands
  are exact in a double, so the answers are the same on a real x87 and in
  Blink, whose registers are doubles. It passes under Rosetta, which is
  how the model was checked, and found numbers 1–5 and 8–11.
- `fixtures/x86/ssediff.c` (`sse-diff.test.ts`) prints a checksum per
  SSE/SSE2/SSE3/SSSE3 instruction form: 378 of them (register and memory
  operands, immediates, to and from general registers, flags) over twelve
  operand pairs with special floats, saturating integers and shift counts
  past the width. All 128 bits of the destination count. Its output under
  Rosetta is `ssediff.expected`. 358 forms agreed before patch 0555 and
  364 after (the 14 left are the NaN sign below); it found numbers 6 and 7.

## The wider check: real programs against the Mac's own

Debian's programs under Blink (vitest's kernel, with the toolchain and
package layers from the mirror; Ghostscript in the tab), the Mac's
programs natively, the same inputs. The versions differ, so equal means
equal within what the versions explain.

| Program | Compared | Result |
|---|---|---|
| tesseract 5.5.0 (Mac: 5.5.2), five pages: the issue's, an invoice in Helvetica, prose in Times rotated 1.5°, code in Courier, the invoice at 60% | text, and each word's box within 2 px | four pages identical in text and in all 147 boxes; on the Courier page one line differs (`i <n; itt` against `i < ny itt`: both misread `i < n; i++`), 23 of 24 boxes equal |
| ImageMagick 7.1.1 Q16 (Mac: 7.1.2 Q16-HDRI), 13 commands: resize, blur and threshold, rotate, swirl, HSL modulate, sharpen, morphology, draw (circle, bezier), distort, gamma, JPEG | pixels (`magick compare`) and `%[fx:mean]` statistics | statistics identical to six digits; 9 results within 0.1% RMSE and two JPEGs within 0.4%; a JPEG of the same pixels is bit-identical to the Mac's encoder's; sharpen followed by resize (as PNG and as JPEG) differs by 2.4% RMSE, 0.4% and 0.7% once the Mac clamps after the sharpen as a non-HDRI build does |
| numpy 2.2.4 on Debian's python3 (Mac: 2.0.2), 41 checks: casts, rounding, sums, matmul, solve, SVD, FFT, exp/log/sin, sort, integer ops, histogram, the random generator, `long double`, complex | values to 9 digits, integers exactly | 39 identical; two float32 results differ in the last digits (a dot product's order of summation, and float32 `sqrt + exp`); no warning, where there were 7 |
| Ghostscript 10.05.1 (Mac: 10.07), a page with curves, dashes, an axial and a radial shading, a rotated fan, text in two fonts and numbers printed by the interpreter | pixels at 72 dpi | 24 of 120,000 pixels differ by more than 2%, on the shadings' edges |

## What is still different from an x86

- **The sign of a NaN that an SSE operation makes** (inf - inf, 0/0, the
  root of a negative number) is the host CPU's: negative on an x86 host, as
  x86 itself makes it; positive on an ARM host. glibc's printf shows it
  (`-nan` on x86, `nan` here), and x86-engine.test.ts's "scalar SSE double
  ops ... as native" fails for it on an ARM Mac (its checksum is x86's under
  Rosetta). The x87 handlers now make x86's on
  every host (patch 0556). Doing the same for SSE means a check after each
  add, sub, mul, div and sqrt, in the handlers and in the JIT's inline code
  (scalar and packed), and it must be done on the bits: LLVM is free to take
  one NaN for another, and did, in the first attempt at `fsqrt`. Not done.
  `sse-diff.test.ts` allows it for the seven instructions it shows in, on a
  host that isn't x64, and nothing else.
- **SSE exception flags.** MXCSR's status bits are never set: `0.0 / 0.0`
  raises no FE_INVALID and nothing raises FE_INEXACT. x87 sets IE, ZE and
  the stack fault; not PE, OE or UE.
- **x87 precision.** The registers are doubles (53 bits, not 64), so
  `long double` arithmetic is double arithmetic, and `fldt`/`fstpt` convert
  (patch 0540).
- **Which NaN is passed on** when both operands are NaNs follows the host.

## Checks

`x87-ops.test.ts`, `sse-diff.test.ts` and `x87-ldbl.test.ts` pass (JIT on
and off); on Build 1020's engine the x87 fixture prints wrong register
forms and dies of fucompp's SIGILL. `x86-smc` (23), `gdb` (17), `toolchain-layers` (12),
`x86-exec-threads`, `x86-phase3`, `blink-crash`, `blink-embryo` and
`blink-wjkeep` pass; `x86-engine.test.ts` has the same 14 failures on this
Mac as Build 1020's engine (fixtures built with clang and musl, an ARM
host). In headless Chrome on a local build, the issue's two commands print
the five lines.
