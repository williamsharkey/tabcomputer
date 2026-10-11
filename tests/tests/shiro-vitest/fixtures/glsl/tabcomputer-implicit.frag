#version 130
// Desktop GLSL's implicit int→float conversions in a fragment shader
// (written for this corpus, MIT like the rest of tabcomputer).
uniform sampler2D tex;
uniform int levels;
in vec2 uv;
in float shade;
out vec4 color;

struct Light { vec3 dir; float power; };

float quantize(float v, int n) { return floor(v * n) / n; }

void main() {
  Light l = Light(vec3(0, 0, 1), 1);
  ivec2 size = textureSize(tex, 0);
  vec2 texel = 1.0 / size;
  vec4 c = textureLod(tex, uv + texel, 0);
  float q = quantize(c.r, levels);
  float m = mix(q, shade, 0) + max(q, 0) + mod(gl_FragCoord.x, 4) + smoothstep(0, 1, q);
  if (m < 1) m = 1;
  for (int i = 0; i < levels; i++) m -= i;
  color = vec4(c.rgb * l.power * m, 1);
}
