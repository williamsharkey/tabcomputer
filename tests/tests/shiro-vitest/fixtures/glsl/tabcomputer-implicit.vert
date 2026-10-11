#version 120
// Desktop GLSL's implicit int→float conversions, as drivers accept them
// (written for this corpus, MIT like the rest of tabcomputer).
#define SCALE 2
#define HALF(x) (x / 2)
uniform int count;
uniform ivec2 grid;
varying vec2 uv;
varying float shade;

float ramp(float x) { return x * 3; }

void main() {
  float k = 1;
  vec2 cell = grid * 0.5;
  uv = gl_MultiTexCoord0.xy * SCALE + cell / grid;
  shade = ramp(count) + HALF(k) + pow(k, 2) + clamp(k, 0, 1) + (count > 0 ? 1 : 0.5);
  vec4 p = gl_Vertex;
  p.xy *= 2;
  p.z += count;
  gl_Position = gl_ModelViewProjectionMatrix * p;
}
