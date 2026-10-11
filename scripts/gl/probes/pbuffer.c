/*
 * GLX pbuffer probe for libGLX_tabcomputer (docs/research/GL.md), the way
 * Qt and Krita use one for offscreen GL: an FBConfig with GLX_PBUFFER_BIT,
 * glXCreatePbuffer, a context made current on it, a clear, glReadPixels,
 * glXQueryDrawable, glXDestroyPbuffer. Prints one line per step.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <X11/Xlib.h>

typedef struct __GLXFBConfigRec *GLXFBConfig;
typedef void *GLXContext;
typedef unsigned long GLXPbuffer;
#define GLX_DRAWABLE_TYPE 0x8010
#define GLX_PBUFFER_BIT 0x4
#define GLX_RENDER_TYPE 0x8011
#define GLX_RGBA_BIT 0x1
#define GLX_RGBA_TYPE 0x8014
#define GLX_RED_SIZE 8
#define GLX_PBUFFER_WIDTH 0x8041
#define GLX_PBUFFER_HEIGHT 0x8040
#define GLX_WIDTH 0x801D
#define GLX_HEIGHT 0x801E
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401

int main(void) {
  void *gl = dlopen("libGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!gl) { fprintf(stderr, "no libGL.so.1: %s\n", dlerror()); return 1; }
#define F(ret, name, ...) ret (*name)(__VA_ARGS__) = (ret (*)(__VA_ARGS__))dlsym(gl, #name)
  F(GLXFBConfig *, glXChooseFBConfig, Display *, int, const int *, int *);
  F(GLXPbuffer, glXCreatePbuffer, Display *, GLXFBConfig, const int *);
  F(void, glXDestroyPbuffer, Display *, GLXPbuffer);
  F(GLXContext, glXCreateNewContext, Display *, GLXFBConfig, int, GLXContext, int);
  F(int, glXMakeContextCurrent, Display *, unsigned long, unsigned long, GLXContext);
  F(void, glXQueryDrawable, Display *, unsigned long, int, unsigned *);
  F(void, glClearColor, float, float, float, float);
  F(void, glClear, unsigned);
  F(void, glReadPixels, int, int, int, int, unsigned, unsigned, void *);
  Display *dpy = XOpenDisplay(NULL);
  if (!dpy) { fprintf(stderr, "no display\n"); return 1; }
  int want[] = { GLX_DRAWABLE_TYPE, GLX_PBUFFER_BIT, GLX_RENDER_TYPE, GLX_RGBA_BIT, GLX_RED_SIZE, 8, 0 };
  int n = 0;
  GLXFBConfig *cfg = glXChooseFBConfig(dpy, DefaultScreen(dpy), want, &n);
  printf("fbconfigs %d\n", n);
  if (!n) return 1;
  int size[] = { GLX_PBUFFER_WIDTH, 64, GLX_PBUFFER_HEIGHT, 32, 0 };
  GLXPbuffer pb = glXCreatePbuffer(dpy, cfg[0], size);
  printf("pbuffer %s\n", pb ? "created" : "failed");
  if (!pb) return 1;
  unsigned w = 0, h = 0;
  glXQueryDrawable(dpy, pb, GLX_WIDTH, &w);
  glXQueryDrawable(dpy, pb, GLX_HEIGHT, &h);
  printf("size %ux%u\n", w, h);
  GLXContext ctx = glXCreateNewContext(dpy, cfg[0], GLX_RGBA_TYPE, NULL, 1);
  printf("current %d\n", glXMakeContextCurrent(dpy, pb, pb, ctx));
  glClearColor(1.f, 0.f, 0.f, 1.f);
  glClear(GL_COLOR_BUFFER_BIT);
  unsigned char px[4] = { 0 };
  glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
  printf("pixel %u %u %u %u\n", px[0], px[1], px[2], px[3]);
  glXMakeContextCurrent(dpy, 0, 0, NULL);
  glXDestroyPbuffer(dpy, pb);
  printf("destroyed\n");
  XCloseDisplay(dpy);
  return 0;
}
