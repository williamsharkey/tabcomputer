#version 330
// 1D array textures, as Blender's UDIM tile map uses one (written for this
// corpus, MIT like the rest of tabcomputer).
uniform sampler1DArray map;
uniform isampler1DArray ids;
in vec2 uv;
out vec4 color;

bool tile_lookup(vec2 co, out vec4 info) {
  int tile = int(floor(co.x));
  float layer = texelFetch(map, ivec2(tile, 0), 0).x;
  info = texelFetch(map, ivec2(tile, 1), 0);
  return layer >= 0.0;
}

void main() {
  vec4 info;
  bool ok = tile_lookup(uv * 4.0, info);
  vec4 smooth_ = texture(map, vec2(uv.x, 1.0)) + textureLod(map, vec2(uv.y, 0.0), 0.0);
  ivec2 size = textureSize(map, 0);
  color = (ok ? info : vec4(0.0)) + smooth_ * float(texelFetch(ids, ivec2(0, 0), 0).x + size.x);
}
