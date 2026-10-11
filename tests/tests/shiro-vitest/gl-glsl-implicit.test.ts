/**
 * src/gl/glsl/implicit.ts: desktop GLSL's implicit int→float conversions
 * made explicit for GLSL ES 3.00. (gl-webgl.test.ts compiles the corpus,
 * tabcomputer-implicit.* included, in Chromium.)
 */
import { it, expect } from 'vitest';
import { explicitConversions } from '@shiro/gl/glsl/implicit';

const fx = (body: string, decls = '') => explicitConversions(`${decls}\nvoid main() {\n${body}\n}\n`);
const body = (r: { source: string }) => r.source.slice(r.source.indexOf('void main() {') + 14, r.source.lastIndexOf('}') - 1);

it('converts initializers, assignments, operands and returns', () => {
  expect(body(fx('float x = 1; x = 2; x += i; x *= 3;', 'uniform int i;'))).toBe('float x = float(1); x = float(2); x += float(i); x *= float(3);');
  expect(body(fx('vec3 v = n * 2 + iv;', 'uniform vec3 n; uniform ivec3 iv;'))).toBe('vec3 v = n * float(2) + vec3(iv);');
  expect(body(fx('bool b = f < 1 && i < 2;', 'uniform float f; uniform int i;'))).toBe('bool b = f < float(1) && i < 2;');
  expect(explicitConversions('float h(int i) { return i + 1; }').source).toBe('float h(int i) { return float(i + 1); }');
  expect(body(fx('float t = c ? 1 : 0.5;', 'uniform bool c;'))).toBe('float t = c ? float(1) : 0.5;');
  expect(body(fx('vec2 t = 1.0 / textureSize(s, 0);', 'uniform sampler2D s;'))).toBe('vec2 t = 1.0 / vec2(textureSize(s, 0));');
});

it('converts built-in and user function arguments, and leaves int-only calls alone', () => {
  expect(body(fx('float y = pow(x, 2) + clamp(x, 0, 1) + mix(x, 1.0, 0);', 'uniform float x;'))).toBe('float y = pow(x, float(2)) + clamp(x, float(0), float(1)) + mix(x, 1.0, float(0));');
  expect(body(fx('int k = clamp(i, 0, 3); ivec2 p = ivec2(i) * 2; int m = i % 2;', 'uniform int i;'))).toBe('int k = clamp(i, 0, 3); ivec2 p = ivec2(i) * 2; int m = i % 2;');
  expect(body(fx('vec4 c = textureLod(s, uv, 0) + textureOffset(s, uv, ivec2(1, 0)) + vec4(texelFetch(s, ivec2(0), 0));', 'uniform sampler2D s; in vec2 uv;')))
    .toBe('vec4 c = textureLod(s, uv, float(0)) + textureOffset(s, uv, ivec2(1, 0)) + vec4(texelFetch(s, ivec2(0), 0));');
  const user = 'float f(float a) { return a; }\nint f(int a) { return a; }\nfloat g(vec2 a) { return a.x; }\n';
  expect(body(fx('float r = f(1) + f(1.0) + g(ivec2(1));', user))).toBe('float r = float(f(1)) + f(1.0) + g(vec2(ivec2(1)));');
});

it('converts struct and array constructor arguments, swizzles and indexes by type', () => {
  expect(body(fx('L l = L(vec3(0), 1); float a[2] = float[2](1, 2.0); float z = l.p + m[0].x + iv.x;', 'struct L { vec3 d; float p; }; uniform mat4 m; uniform ivec4 iv;')))
    .toBe('L l = L(vec3(0), float(1)); float a[2] = float[2](float(1), 2.0); float z = l.p + m[0].x + float(iv.x);');
});

it('wraps a whole macro use, or inlines the use when the conversion is inside it', () => {
  expect(body(fx('float a = N; float b = H(a);', '#define N 4\n#define H(x) (x / 2)'))).toBe('float a = float(N); float b = ( a / float(2) );');
  // inactive branches are left as they are
  expect(body(fx('#ifdef NOPE\nfloat a = 1;\n#else\nfloat a = 2;\n#endif', ''))).toBe('#ifdef NOPE\nfloat a = 1;\n#else\nfloat a = float(2);\n#endif');
  expect(body(fx('#if __VERSION__ >= 300 && defined(GL_ES)\nfloat a = 1;\n#endif', ''))).toBe('#if __VERSION__ >= 300 && defined(GL_ES)\nfloat a = float(1);\n#endif');
});

it('keeps comments, layout and blocks, and leaves what it cannot parse unchanged', () => {
  const src = 'layout(std140) uniform B { mat4 mvp; float k; } b;\nlayout(location = 0) out vec4 o; // c\nvoid main() { /* x */ o = vec4(b.k * 2); }\n';
  expect(explicitConversions(src).source).toBe(src.replace('b.k * 2', 'b.k * float(2)'));
  const bad = 'void main() { float x = 1; @ }';
  const r = explicitConversions(bad);
  expect(r.source).toBe(bad);
  expect(r.error).toBeTruthy();
  const es = '#version 300 es\nprecision highp float;\nout vec4 o;\nvoid main() { for (int i = 0; i < 3; i++) { o += vec4(float(i)); } }\n';
  expect(explicitConversions(es)).toEqual({ source: es, changed: 0 });
});
