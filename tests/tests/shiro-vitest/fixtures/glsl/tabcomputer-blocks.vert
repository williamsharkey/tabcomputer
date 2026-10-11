#version 330
// Interface blocks between stages, as Blender 3.x's generated shaders use
// them (written for this corpus, MIT like the rest of tabcomputer).
layout(location = 0) in vec3 pos;
layout(location = 1) in vec4 color;
uniform mat4 ModelViewProjectionMatrix;

out VertexOut_Iface {
  smooth vec4 finalColor;
  flat int selected;
  vec2 corners[2];
} interp;

out Extra_Iface_ {
  noperspective float lineDist;
  float _roughness;
};

void main() {
  interp.finalColor = color;
  interp.selected = gl_VertexID & 1;
  interp.corners[0] = pos.xy;
  interp.corners[1] = pos.yx;
  lineDist = pos.z;
  _roughness = 0.5;
  gl_Position = ModelViewProjectionMatrix * vec4(pos, 1.0);
}
