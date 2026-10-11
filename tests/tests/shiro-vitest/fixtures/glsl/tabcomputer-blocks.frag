#version 330
// Interface blocks between stages (written for this corpus, MIT like the rest of tabcomputer).
in VertexOut_Iface {
  smooth vec4 finalColor;
  flat int selected;
  vec2 corners[2];
} interp;

in Extra_Iface_ {
  noperspective float lineDist;
  float _roughness;
};

layout(location = 0) out vec4 fragColor;

void main() {
  float d = length(interp.corners[0] - interp.corners[1]) + lineDist + _roughness;
  fragColor = interp.selected == 1 ? vec4(1.0, 0.5, 0.0, 1.0) : interp.finalColor * d;
}
