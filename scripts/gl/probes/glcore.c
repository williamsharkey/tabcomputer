/*
 * GL 3.3 core probe for libGLX_tabcomputer (docs/research/GL.md, stage 4), the
 * parts Blender's GPU module uses first: a 3.3 core context
 * (glXCreateContextAttribsARB), shaders with in/out interface blocks and a
 * uniform block, the uniform block queries, an instanced draw with a vertex
 * attribute divisor, primitive restart, glReadPixels. Prints one line per
 * check; tests/browser/gl-apps.mjs --app glcore runs it in the page.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <X11/Xlib.h>

typedef struct __GLXFBConfigRec *GLXFBConfig;
typedef void *GLXContext;
typedef unsigned long GLXPbuffer;
#define GLX_DRAWABLE_TYPE 0x8010
#define GLX_PBUFFER_BIT 0x4
#define GLX_RENDER_TYPE 0x8011
#define GLX_RGBA_BIT 0x1
#define GLX_RED_SIZE 8
#define GLX_PBUFFER_WIDTH 0x8041
#define GLX_PBUFFER_HEIGHT 0x8040
#define GLX_CONTEXT_MAJOR_VERSION_ARB 0x2091
#define GLX_CONTEXT_MINOR_VERSION_ARB 0x2092
#define GLX_CONTEXT_PROFILE_MASK_ARB 0x9126
#define GLX_CONTEXT_CORE_PROFILE_BIT_ARB 0x1
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT 0x1403
#define GL_FLOAT 0x1406
#define GL_TRIANGLES 0x4
#define GL_TRIANGLE_STRIP 0x5
#define GL_ARRAY_BUFFER 0x8892
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_UNIFORM_BUFFER 0x8A11
#define GL_STATIC_DRAW 0x88E4
#define GL_VERTEX_SHADER 0x8B31
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_ACTIVE_UNIFORM_BLOCKS 0x8A36
#define GL_UNIFORM_BLOCK_DATA_SIZE 0x8A40
#define GL_UNIFORM_BLOCK_NAME_LENGTH 0x8A41
#define GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS 0x8A42
#define GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES 0x8A43
#define GL_UNIFORM_BLOCK_INDEX 0x8A3A
#define GL_PRIMITIVE_RESTART 0x8F9D
#define GL_VERSION 0x1F02

static const char *vs =
  "#version 330 core\n"
  "layout(location = 0) in vec2 pos;\n"
  "layout(location = 1) in vec2 offset;\n" /* per instance */
  "layout(std140) uniform Tint { vec4 color; float scale; } tint;\n"
  "out VertexOut { flat vec4 color; vec2 uv; } vout;\n"
  "void main() {\n"
  "  vout.color = tint.color;\n"
  "  vout.uv = pos;\n"
  "  gl_Position = vec4(pos * tint.scale + offset, 0.0, 1.0);\n"
  "}\n";
static const char *fs =
  "#version 330 core\n"
  "in VertexOut { flat vec4 color; vec2 uv; } vin;\n"
  "out vec4 frag;\n"
  "void main() { frag = vin.color + vec4(0.0 * vin.uv, 0.0, 0.0); }\n";

int main(void) {
  void *gl = dlopen("libGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!gl) { fprintf(stderr, "no libGL.so.1: %s\n", dlerror()); return 1; }
#define F(ret, name, ...) ret (*name)(__VA_ARGS__) = (ret (*)(__VA_ARGS__))dlsym(gl, #name)
#define P(ret, name, ...) ret (*name)(__VA_ARGS__) = (ret (*)(__VA_ARGS__))glXGetProcAddress((const unsigned char *)#name)
  F(void *, glXGetProcAddress, const unsigned char *);
  F(GLXFBConfig *, glXChooseFBConfig, Display *, int, const int *, int *);
  F(GLXPbuffer, glXCreatePbuffer, Display *, GLXFBConfig, const int *);
  F(int, glXMakeContextCurrent, Display *, unsigned long, unsigned long, GLXContext);
  P(GLXContext, glXCreateContextAttribsARB, Display *, GLXFBConfig, GLXContext, int, const int *);
  P(const char *, glGetString, unsigned);
  P(void, glClearColor, float, float, float, float);
  P(void, glClear, unsigned);
  P(void, glViewport, int, int, int, int);
  P(void, glReadPixels, int, int, int, int, unsigned, unsigned, void *);
  P(unsigned, glCreateShader, unsigned);
  P(void, glShaderSource, unsigned, int, const char *const *, const int *);
  P(void, glCompileShader, unsigned);
  P(void, glGetShaderiv, unsigned, unsigned, int *);
  P(void, glGetShaderInfoLog, unsigned, int, int *, char *);
  P(unsigned, glCreateProgram, void);
  P(void, glAttachShader, unsigned, unsigned);
  P(void, glLinkProgram, unsigned);
  P(void, glGetProgramiv, unsigned, unsigned, int *);
  P(void, glGetProgramInfoLog, unsigned, int, int *, char *);
  P(void, glUseProgram, unsigned);
  P(unsigned, glGetUniformBlockIndex, unsigned, const char *);
  P(void, glGetActiveUniformBlockiv, unsigned, unsigned, unsigned, int *);
  P(void, glGetActiveUniformBlockName, unsigned, unsigned, int, int *, char *);
  P(void, glGetActiveUniformsiv, unsigned, int, const unsigned *, unsigned, int *);
  P(void, glGetActiveUniformName, unsigned, unsigned, int, int *, char *);
  P(void, glGetUniformIndices, unsigned, int, const char *const *, unsigned *);
  P(void, glUniformBlockBinding, unsigned, unsigned, unsigned);
  P(void, glGenBuffers, int, unsigned *);
  P(void, glBindBuffer, unsigned, unsigned);
  P(void, glBufferData, unsigned, long, const void *, unsigned);
  P(void, glBindBufferBase, unsigned, unsigned, unsigned);
  P(void, glGenVertexArrays, int, unsigned *);
  P(void, glBindVertexArray, unsigned);
  P(void, glEnableVertexAttribArray, unsigned);
  P(void, glVertexAttribPointer, unsigned, int, unsigned, unsigned char, int, const void *);
  P(void, glVertexAttribDivisor, unsigned, unsigned);
  P(void, glDrawElementsInstanced, unsigned, int, unsigned, const void *, int);
  P(void, glEnable, unsigned);
  P(void, glPrimitiveRestartIndex, unsigned);
  P(void, glFinish, void);
  P(unsigned, glGetError, void);

  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "no display\n"); return 1; }
  int want[] = { GLX_DRAWABLE_TYPE, GLX_PBUFFER_BIT, GLX_RENDER_TYPE, GLX_RGBA_BIT, GLX_RED_SIZE, 8, 0 };
  int n = 0;
  GLXFBConfig *cfg = glXChooseFBConfig(dpy, DefaultScreen(dpy), want, &n);
  if (!n || !glXCreateContextAttribsARB) { printf("no fbconfig or glXCreateContextAttribsARB\n"); return 1; }
  int size[] = { GLX_PBUFFER_WIDTH, 32, GLX_PBUFFER_HEIGHT, 32, 0 };
  GLXPbuffer pb = glXCreatePbuffer(dpy, cfg[0], size);
  int attrs[] = { GLX_CONTEXT_MAJOR_VERSION_ARB, 3, GLX_CONTEXT_MINOR_VERSION_ARB, 3, GLX_CONTEXT_PROFILE_MASK_ARB, GLX_CONTEXT_CORE_PROFILE_BIT_ARB, 0 };
  GLXContext ctx = glXCreateContextAttribsARB(dpy, cfg[0], NULL, 1, attrs);
  printf("core context %s, current %d\n", ctx ? "created" : "refused", glXMakeContextCurrent(dpy, pb, pb, ctx));
  if (!ctx) return 1;
  printf("version %s\n", glGetString(GL_VERSION));

  unsigned sh[2] = { glCreateShader(GL_VERTEX_SHADER), glCreateShader(GL_FRAGMENT_SHADER) };
  const char *src[2] = { vs, fs };
  char log[1024];
  for (int i = 0; i < 2; i++) {
    glShaderSource(sh[i], 1, &src[i], NULL);
    glCompileShader(sh[i]);
    int ok = 0; glGetShaderiv(sh[i], GL_COMPILE_STATUS, &ok);
    if (!ok) { glGetShaderInfoLog(sh[i], sizeof log, NULL, log); printf("compile %d failed: %s\n", i, log); return 1; }
  }
  unsigned prog = glCreateProgram();
  glAttachShader(prog, sh[0]); glAttachShader(prog, sh[1]);
  glLinkProgram(prog);
  int linked = 0; glGetProgramiv(prog, GL_LINK_STATUS, &linked);
  if (!linked) { glGetProgramInfoLog(prog, sizeof log, NULL, log); printf("link failed: %s\n", log); return 1; }
  printf("linked\n");

  int nblocks = 0; glGetProgramiv(prog, GL_ACTIVE_UNIFORM_BLOCKS, &nblocks);
  unsigned bi = glGetUniformBlockIndex(prog, "Tint");
  int namelen = 0, datasize = 0, nu = 0, idx[4] = { -1, -1, -1, -1 };
  char bname[64] = "";
  glGetActiveUniformBlockiv(prog, bi, GL_UNIFORM_BLOCK_NAME_LENGTH, &namelen);
  glGetActiveUniformBlockiv(prog, bi, GL_UNIFORM_BLOCK_DATA_SIZE, &datasize);
  glGetActiveUniformBlockiv(prog, bi, GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS, &nu);
  glGetActiveUniformBlockiv(prog, bi, GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES, idx);
  glGetActiveUniformBlockName(prog, bi, sizeof bname, NULL, bname);
  printf("blocks %d: %s index %u, name length %d, %d bytes, %d uniforms\n", nblocks, bname, bi, namelen, datasize, nu);
  for (int i = 0; i < nu && i < 4; i++) {
    char un[64] = ""; int blk = -2;
    unsigned ui = (unsigned)idx[i];
    glGetActiveUniformName(prog, ui, sizeof un, NULL, un);
    glGetActiveUniformsiv(prog, 1, &ui, GL_UNIFORM_BLOCK_INDEX, &blk);
    printf("block uniform %s in block %d\n", un, blk);
  }
  const char *names[2] = { "Tint.scale", "nothing" };
  unsigned found[2] = { 0, 0 };
  glGetUniformIndices(prog, 2, names, found);
  printf("uniform indices %s %s\n", found[0] != 0xffffffffu ? "found" : "missing", found[1] == 0xffffffffu ? "missing" : "found");

  /* the uniform block: color (0, 1, 0, 1), scale 0.5 */
  float ubo[8] = { 0, 1, 0, 1, 0.5f, 0, 0, 0 };
  unsigned b[4], vao;
  glGenBuffers(4, b);
  glBindBuffer(GL_UNIFORM_BUFFER, b[0]); glBufferData(GL_UNIFORM_BUFFER, sizeof ubo, ubo, GL_STATIC_DRAW);
  glUniformBlockBinding(prog, bi, 2);
  glBindBufferBase(GL_UNIFORM_BUFFER, 2, b[0]);
  glGenVertexArrays(1, &vao); glBindVertexArray(vao);
  /* a quad, drawn as two strips joined by a restart index; two instances side by side */
  float quad[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
  float offsets[] = { -0.5f, 0, 0.5f, 0 };
  unsigned short index[] = { 0, 1, 2, 0xffff, 1, 3, 2 };
  glBindBuffer(GL_ARRAY_BUFFER, b[1]); glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, 0);
  glBindBuffer(GL_ARRAY_BUFFER, b[2]); glBufferData(GL_ARRAY_BUFFER, sizeof offsets, offsets, GL_STATIC_DRAW);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1, 2, GL_FLOAT, 0, 0, 0); glVertexAttribDivisor(1, 1);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, b[3]); glBufferData(GL_ELEMENT_ARRAY_BUFFER, sizeof index, index, GL_STATIC_DRAW);
  glEnable(GL_PRIMITIVE_RESTART); glPrimitiveRestartIndex(0xffff);
  glViewport(0, 0, 32, 32);
  glClearColor(1, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT);
  glUseProgram(prog);
  glDrawElementsInstanced(GL_TRIANGLE_STRIP, 7, GL_UNSIGNED_SHORT, 0, 2);
  glFinish();
  /* each instance covers a 16x16 square: x 0..15 and 16..31 (scale 0.5, offsets ±0.5), y 8..23 */
  unsigned char px[3][4];
  glReadPixels(4, 16, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px[0]);
  glReadPixels(28, 16, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px[1]);
  glReadPixels(16, 2, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px[2]);
  printf("instance 0 %u %u %u, instance 1 %u %u %u, outside %u %u %u\n", px[0][0], px[0][1], px[0][2], px[1][0], px[1][1], px[1][2], px[2][0], px[2][1], px[2][2]);
  printf("error 0x%x\n", glGetError());
  return 0;
}
