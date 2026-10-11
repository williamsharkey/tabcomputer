# GLSL corpus

Unmodified shaders from real programs, for `gl-glsl.test.ts` (src/gl/glsl/translate.ts).
The test compiles each translation as GLSL ES 3.00 and links the pairs.

| Prefix | Source | License | Dialect |
|---|---|---|---|
| `mesa-` | Mesa demos `src/glsl/` (Orange Book shaders by 3Dlabs, Brian Paul's demos) | MIT / 3Dlabs BSD-style | GLSL 1.10/1.20, compatibility built-ins |
| `glmark2-` | glmark2 `data/shaders/` | GPL-3.0 | GLSL 1.00/1.10 with explicit attributes |
| `stk-` | SuperTuxKart `data/shaders/` | GPL-3.0 | GLSL 1.30+; the game puts `#version` in front (the test uses 330) |
| `openscad-` | OpenSCAD `shaders/` | GPL-2.0 | GLSL 1.20 |
| `krita-` | Krita `krita/data/shaders/` (master, 2026-10) | GPL-3.0-or-later | GLSL 1.50 core; Krita puts `#version` and its feature defines in front (the test uses 150 core, HIGHQ_SCALING for highq_downscale) |
| `tabcomputer-` | written for this corpus | MIT | desktop GLSL 1.20/1.30 with implicit int→float conversions (src/gl/glsl/implicit.ts) |

Left out: glmark2 shaders with `$NAME$` placeholders the benchmark fills in,
and SuperTuxKart shaders that need its `#stk_include` files and uniform-block
preamble.
