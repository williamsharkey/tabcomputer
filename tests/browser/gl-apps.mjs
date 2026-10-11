// GL apps in the page (docs/research/GL.md): glxgears, Neverball or OpenSCAD's GUI
// through Blink, libGLX_tabcomputer, glshiro and WebGL2, into an Xshiro window on
// the desktop. Prints the app's frame rate and glshiro's command rate and checks
// the window's pixels and XGetImage of it; then stops animation frames (what a
// hidden tab does) and checks the app stops rendering. OpenSCAD draws on demand:
// its view is dragged instead, and the frames that answer are counted.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   GL_PROBE_ROOT=DIR node tests/browser/gl-apps.mjs [URL] [--app glxgears|neverball|openscad|glcore] [--seconds N] [--profile N] [--json FILE]
//
// GL_PROBE_ROOT is an x86-64 rootfs with the app (mesa-utils' glxgears,
// neverball and its data, or openscad), libglvnd (libGL.so.1, libGLX.so.0,
// libGLdispatch.so.0) and their libraries, without Mesa's vendor library: see
// tests/tests/shiro-vitest/gl-guest.test.ts. The page gets libGLX_tabcomputer
// itself (src/gl/setup.ts). Chromium runs WebGL2 on SwiftShader here, so the
// rates are a CPU renderer's. Exits 1 on failure.
//
// Diagnostics: GL_CMD replaces the app's command (TABCOMPUTER_GL_DEBUG=1..3,
// SHIRO_BLINK_PROFILE=FILE, LD_DEBUG=files go in front of it); GL_VERBOSE=1
// prints the app's output; GL_OPS=1 (2: all) counts the commands per frame
// while dragging, by opcode; GL_DRAG_STEPS sets the drag's length (60);
// GL_FETCH=from:to[,from:to] copies files out of the page at the end;
// GL_SHOT names the screenshot.
import { createRequire } from 'node:module';
import { readdirSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) { try { ({ chromium } = require(m)); break; } catch { /* next */ } }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const seconds = Number(opt('--seconds') ?? 12);
const APPS = {
  glxgears: { cmd: '/usr/bin/glxgears.x86_64-linux-gnu', title: /gears/i, gears: true, files: {} },
  neverball: {
    cmd: 'HOME=/tmp/nb SDL_AUDIODRIVER=dummy /usr/games/neverball', title: /neverball/i, gears: false,
    files: { '/tmp/nb/.neverball/neverballrc': `fullscreen 0\nwidth ${process.env.NB_W ?? 640}\nheight ${process.env.NB_H ?? 480}\n` },
  },
  // GL 3.3 core in the page (scripts/gl/probes/glcore.c): runs to its end, then its lines are checked
  glcore: {
    cmd: '/usr/bin/glcore', title: null, files: {},
    expect: [/core context created, current 1/, /version 3\.3/, /^linked$/m, /blocks 1: Tint index 0, name length 5, (20|32) bytes, 2 uniforms/,
      /block uniform Tint\.color in block 0/, /block uniform Tint\.scale in block 0/, /uniform indices found missing/,
      /instance 0 0 255 0, instance 1 0 255 0, outside 255 0 0/, /error 0x0/],
  },
  // OpenSCAD's GUI (Qt 5, a QOpenGLWidget in the main window): SCAD_ROOT-style rootfs as GL_PROBE_ROOT
  openscad: {
    cmd: 'HOME=/tmp/scad QT_QPA_PLATFORM=xcb QT_XCB_GL_INTEGRATION=xcb_glx /usr/bin/openscad /tmp/scad/t.scad', title: /openscad/i, gears: false,
    // it draws when something changes: frames are counted while the view is dragged (rotated), at this place in the window
    drag: [0.39, 0.3],
    files: { '/tmp/scad/t.scad': 'difference() { cube(10, center = true); sphere(6.5); }\ntranslate([12, 0, 0]) cylinder(h = 8, r = 3);\n' },
  },
};
const appName = opt('--app') ?? 'glxgears';
const app = APPS[appName];
if (!app) { console.error(`no app ${appName}: ${Object.keys(APPS).join(', ')}`); process.exit(2); }
const jsonOut = opt('--json');
const profileSeconds = Number(opt('--profile') ?? 0); // also: the page's busiest functions over N seconds
const url = args[0] ?? 'http://localhost:5299/';
const root = process.env.GL_PROBE_ROOT;
if (!root) { console.error('GL_PROBE_ROOT is not set'); process.exit(2); }
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** The rootfs as [path, base64 | {link}] without docs, locales and gconv */
function collect(host, guest, out) {
  for (const n of readdirSync(host)) {
    const h = join(host, n), g = `${guest}/${n}`;
    if (/^\/(lib|lib64|bin)$/.test(g)) continue; // usrmerge links: the page has its own
    if (/^\/usr\/share\/(man|doc|locale|info|lintian|bug)|\/gconv$/.test(g)) continue;
    const st = lstatSync(h);
    if (st.isSymbolicLink()) out.push([g, { link: readlinkSync(h) }]);
    else if (st.isDirectory()) collect(h, g, out);
    else out.push([g, readFileSync(h).toString('base64'), st.mode & 0o777]);
  }
  return out;
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
// GL_OPS=1: count the commands (and their bytes) in the batches posted to glshiro's Workers, by opcode
const OP_NAMES = [...readFileSync(new URL('../../src/gl/gen/ops.ts', import.meta.url), 'utf8').matchAll(/^\s*\[(?:"([^"]*)"|'([^']*)'),/gm)].map((m) => m[1] ?? m[2]);
if (process.env.GL_OPS) {
  await page.addInitScript(() => {
    const counts = window.__glOps = new Map();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) {
      if (m?.type === 'batch' && window.__glOpsOn) try {
        const dv = new DataView(m.buf);
        for (let off = 0; off + 12 <= m.buf.byteLength;) {
          const end = off + dv.getUint32(off + 8, true);
          for (let p = off + 12; p + 4 <= end;) {
            const h = dv.getUint32(p, true);
            let words = h >>> 16;
            if (!words) words = dv.getUint32(p + 4, true);
            if (words < 1) break;
            const c = counts.get(h & 0xffff) ?? [0, 0];
            c[0]++; c[1] += words * 4;
            counts.set(h & 0xffff, c);
            p += words * 4;
          }
          if (end <= off) break;
          off = end;
        }
      } catch (e) { window.__glOpsError = String(e); }
      return post.call(this, m, t);
    };
  });
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (/glshiro|GL|worker/i.test(m.text())) errors.push(`console: ${m.text()}`); });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const result = {};
/**
 * GL_WORKER_PROFILE=PREFIX: V8 CPU profiles of the page's dedicated workers (Blink's among them) while the
 * view is dragged: PREFIX-<n>.cpuprofile each (Chrome DevTools format), and each worker's top functions by
 * self time printed.
 */
async function startWorkerProfiles(prefix) {
  const cdp = await browser.newBrowserCDPSession();
  const pending = new Map();
  let id = 0;
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const call = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method, params }) }).catch(reject);
  });
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sessions = [];
  for (const t of targetInfos.filter((x) => x.type === 'worker')) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
    try {
      await call(sessionId, 'Profiler.enable');
      await call(sessionId, 'Profiler.setSamplingInterval', { interval: 500 });
      await call(sessionId, 'Profiler.start');
      sessions.push({ t, sessionId });
    } catch (e) { console.log(`worker profile ${t.title}: ${e.message}`); }
  }
  return async () => {
    let n = 0;
    for (const { t, sessionId } of sessions) {
      const { profile } = await call(sessionId, 'Profiler.stop');
      const file = `${prefix}-${n++}.cpuprofile`;
      writeFileSync(file, JSON.stringify(profile));
      const self = new Map();
      const byId = new Map(profile.nodes.map((x) => [x.id, x]));
      profile.samples.forEach((sid, i) => {
        const f = byId.get(sid).callFrame;
        const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
      });
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      const idle = (self.get('(idle) :0') ?? 0) / total;
      if (idle > 0.95) continue;
      console.log(`worker ${t.title || t.url} → ${file} (self time %, ${(100 * idle).toFixed(0)}% idle):\n${[...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, us]) => `  ${(100 * us / total).toFixed(1)}%  ${k}`).join('\n')}`);
    }
    await cdp.detach();
  };
}

/** CPU profile of the page's main thread: start now, report the busiest functions (self time) when the returned function is called. */
async function startProfile() {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  return async () => {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = profile.timeDeltas;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
    });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    result.profile = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => [k, +(100 * us / total).toFixed(1)]);
    console.log(`main thread over ${((Date.now() - t0) / 1000).toFixed(1)} s (self time %):\n${result.profile.map(([k, p]) => `  ${p}%  ${k}`).join('\n')}`);
  };
}

try {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.kernel && window.__tabcomputer.desktop, null, { timeout: 90_000 });
  check(await page.evaluate(() => !!new OffscreenCanvas(1, 1).getContext('webgl2')), 'the page has WebGL2');

  // the rootfs, a few files per call; /lib and /lib64 as real directories (the page's may exist)
  const files = collect(root, '', []).map(([p, d, m]) => [p.replace(/^\/(lib|lib64|bin)\//, '/usr/$1/'), d, m]);
  const t0 = Date.now();
  for (let i = 0; i < files.length; i += 40) {
    await page.evaluate(async (batch) => {
      const fs = window.__tabcomputer.fs;
      for (const [p, d, mode] of batch) {
        await fs.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', { recursive: true }).catch(() => {});
        if (typeof d === 'object') { await fs.symlink(d.link, p).catch(() => {}); continue; }
        await fs.writeFile(p, Uint8Array.from(atob(d), (c) => c.charCodeAt(0)), { mode });
      }
    }, files.slice(i, i + 40));
  }
  await page.evaluate(async (files) => {
    const fs = window.__tabcomputer.fs;
    for (const [p, text] of Object.entries(files)) { await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true }); await fs.writeFile(p, text); }
    await fs.mkdir('/lib64', { recursive: true }).catch(() => {});
    if (!(await fs.exists('/lib64/ld-linux-x86-64.so.2'))) await fs.writeFile('/lib64/ld-linux-x86-64.so.2', await fs.readFile('/usr/lib64/ld-linux-x86-64.so.2'), { mode: 0o755 });
  }, app.files);
  console.log(`rootfs: ${files.length} files in ${Date.now() - t0} ms`);

  // the app from a shell, in the background; its output collects in the page
  await page.evaluate((cmd) => {
    window.__glOut = '';
    const s = window.__tabcomputer.shell.fork();
    s.cwd = '/';
    window.__glDone = s.execute(cmd, (x) => { window.__glOut += x; }, (x) => { window.__glOut += x; });
  }, process.env.GL_CMD ?? app.cmd);
  if (app.expect) {
    // a probe: no window, its output is the result
    const status = await page.evaluate(() => window.__glDone);
    const out = await page.evaluate(() => window.__glOut);
    console.log(`${appName} (status ${status}):\n${out}`);
    check(status === 0, `${appName} exits 0`);
    for (const re of app.expect) check(re.test(out), `${appName} says ${re.source}`);
    throw Object.assign(new Error('probe done'), { probeDone: true });
  }
  const tStart = Date.now();
  const title = app.title.source;
  await page.waitForFunction((t) => window.__tabcomputer.desktop.windows().some((w) => new RegExp(t, 'i').test(w.title) && w.surface) || /Error/.test(window.__glOut), title, { timeout: 300_000 });
  result.windowMs = Date.now() - tStart;
  console.log(`${appName} window after ${result.windowMs} ms`);
  check(await page.evaluate(() => window.__tabcomputer.gl()?.clients.size === 1), 'glshiro has one GL client');
  const stats = () => page.evaluate(() => { const c = [...window.__tabcomputer.gl().clients][0]; return { frames: c?.frames() ?? 0, commands: c?.commands() ?? 0, bytes: c?.bytes?.() ?? 0, busyMs: c?.busyMs?.() ?? 0, t: performance.now() }; });
  await page.waitForTimeout(2000);
  const a = await stats();
  await page.waitForTimeout(seconds * 1000);
  const b = await stats();
  const dt = (b.t - a.t) / 1000;
  result.fps = (b.frames - a.frames) / dt;
  result.commandsPerSecond = (b.commands - a.commands) / dt;
  const out = await page.evaluate(() => window.__glOut);
  result.appSays = [...out.matchAll(/= ([\d.]+) FPS/g)].map((m) => Number(m[1]));
  console.log(`glshiro: ${result.fps.toFixed(1)} frames/s, ${Math.round(result.commandsPerSecond)} commands/s${result.appSays.length ? `; ${appName} says ${result.appSays.join(', ')} FPS` : ''}`);
  if (app.drag) {
    // an app that draws on demand: wait for its first frame (OpenSCAD's first preview takes seconds),
    // then drag across its GL view and count the frames that answer
    await page.waitForFunction(() => [...window.__tabcomputer.gl().clients][0]?.frames() > 0, null, { timeout: 180_000, polling: 250 });
    await page.waitForTimeout(1000);
    const box = await page.evaluate(() => { const r = document.querySelector('canvas[data-gl-surface]').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    const x0 = box.x + box.w * app.drag[0], y0 = box.y + box.h * app.drag[1];
    await page.evaluate(() => { window.__glOpsOn = true; });
    const stopProfile = profileSeconds ? await startProfile() : null;
    const stopWorkers = process.env.GL_WORKER_PROFILE ? await startWorkerProfiles(process.env.GL_WORKER_PROFILE) : null;
    const d0 = await stats();
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const steps = Number(process.env.GL_DRAG_STEPS ?? 60);
    for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + 80 * Math.sin(i / 10), y0 + 30 * Math.sin(i / 7)); await page.waitForTimeout(50); }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const d1 = await stats();
    await stopProfile?.();
    await stopWorkers?.();
    result.dragFps = (d1.frames - d0.frames) / ((d1.t - d0.t) / 1000);
    result.dragFrames = d1.frames - d0.frames;
    const per = (k) => Math.round((d1[k] - d0[k]) / Math.max(1, result.dragFrames));
    console.log(`dragging the view: ${result.dragFrames} frames, ${result.dragFps.toFixed(1)} frames/s (${steps} moves over ${((d1.t - d0.t) / 1000).toFixed(1)} s), ${per('commands')} commands, ${per('bytes')} bytes and ${per('busyMs')} ms in the executor per frame`);
    check(result.dragFrames >= 5, 'the view redraws while dragged');
    if (process.env.GL_OPS) {
      const ops = await page.evaluate(() => [...window.__glOps]);
      console.log(`op counting: ${await page.evaluate(() => window.__glOpsError ?? 'ok')}`);
      ops.sort((a, b) => b[1][1] - a[1][1]);
      console.log(`commands per frame while dragging, by bytes:\n${ops.slice(0, Number(process.env.GL_OPS) > 1 ? 400 : 20).map(([op, [n, b]]) => `  ${OP_NAMES[op] ?? op}: ${(n / result.dragFrames).toFixed(0)} calls, ${(b / result.dragFrames / 1024).toFixed(0)} KB`).join('\n')}`);
      ops.sort((a, b) => b[1][0] - a[1][0]);
      console.log(`by calls: ${ops.slice(0, 15).map(([op, [n]]) => `${OP_NAMES[op] ?? op} ${(n / result.dragFrames).toFixed(0)}`).join(', ')}`);
    }
  } else check(result.fps > 5, 'frames keep coming');
  if (profileSeconds && !app.drag) {
    const stop = await startProfile();
    await page.waitForTimeout(profileSeconds * 1000);
    await stop();
  }

  // glxgears: red, green and blue gears on black; any app: more than a few colors
  const colors = await page.evaluate((t) => {
    const w = window.__tabcomputer.desktop.windows().find((w) => new RegExp(t, 'i').test(w.title) && w.surface);
    // frames go to the window's GL surface (a bitmaprenderer canvas over it) when glshiro runs in a Worker
    const gl = [...document.querySelectorAll('canvas[data-gl-surface]')].find((x) => x.width > 1 && x.isConnected);
    let c = w.surface.canvas;
    if (gl) {
      c = document.createElement('canvas');
      c.width = gl.width; c.height = gl.height;
      c.getContext('2d').drawImage(gl, 0, 0);
    }
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const n = { red: 0, green: 0, blue: 0 };
    const distinct = new Set();
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (distinct.size < 1000) distinct.add((r << 16) | (g << 8) | b);
      if (r > 100 && g < 60 && b < 60) n.red++; else if (g > 100 && r < 60 && b < 60) n.green++; else if (b > 100 && r < 60 && g < 60) n.blue++;
    }
    // glxgears clears to black: the frame covers the whole window
    const at = (x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
    return { ...n, colors: distinct.size, glSurface: !!gl, size: [c.width, c.height], corners: [at(1, 1), at(c.width - 2, 1), at(1, c.height - 2), at(c.width - 2, c.height - 2)] };
  }, title);
  console.log(`window pixels: ${JSON.stringify(colors)}`);
  if (app.gears) {
    check(colors.corners.every((p) => p.every((v) => v < 30)), 'the frame fills the window');
    check(colors.red > 100 && colors.green > 100 && colors.blue > 100, 'the window shows red, green and blue gears');
  } else check(colors.colors > 50, 'the window shows a rendered scene');
  // XGetImage of the GL window: the server reads the frame back from its surface (server.glFrame)
  if (colors.glSurface) {
    const img = await page.evaluate(() => {
      const { server } = window.__shiroX;
      const xid = Number(document.querySelector('canvas[data-gl-surface]').dataset.glSurface);
      const f = server.glFrame(server.winOrNull(xid));
      if (!f) return null;
      const n = { red: 0, green: 0, blue: 0, colors: new Set() };
      for (let i = 0; i < f.data.length; i += 4) {
        const [r, g, b] = [f.data[i], f.data[i + 1], f.data[i + 2]];
        if (n.colors.size < 1000) n.colors.add((r << 16) | (g << 8) | b);
        if (r > 100 && g < 60 && b < 60) n.red++; else if (g > 100 && r < 60 && b < 60) n.green++; else if (b > 100 && r < 60 && g < 60) n.blue++;
      }
      return { size: [f.width, f.height], red: n.red, green: n.green, blue: n.blue, colors: n.colors.size };
    });
    console.log(`XGetImage's frame: ${JSON.stringify(img)}`);
    check(!!img && img.size[0] === colors.size[0] && img.size[1] === colors.size[1], 'XGetImage reads the GL frame back from the surface');
    if (img && app.gears) check(img.red > 100 && img.green > 100 && img.blue > 100, 'XGetImage shows the gears');
    else if (img) check(img.colors > 50, 'XGetImage shows the scene');
  }
  await page.screenshot({ path: process.env.GL_SHOT ?? `/tmp/gl-${appName}.png` });

  // no animation frames (a hidden tab): the app stops at its swap within a few frames
  // like a hidden tab: callbacks wait, and run once frames come back (animating apps only)
  if (!app.drag) {
  await page.evaluate(() => { window.__raf = window.requestAnimationFrame; window.__held = []; window.requestAnimationFrame = (cb) => { window.__held.push(cb); return 0; }; });
  await page.waitForTimeout(1000);
  const h1 = await stats();
  await page.waitForTimeout(3000);
  const h2 = await stats();
  result.hiddenFrames = h2.frames - h1.frames;
  console.log(`without animation frames: ${result.hiddenFrames} frames in 3 s`);
  check(result.hiddenFrames <= 3, 'no frames pile up without animation frames');
  await page.evaluate(() => { window.requestAnimationFrame = window.__raf; for (const cb of window.__held) window.__raf(cb); });
  await page.waitForTimeout(2000);
  const r1 = await stats();
  await page.waitForTimeout(2000);
  const r2 = await stats();
  check(r2.frames - r1.frames > 5, 'frames resume with animation frames');
  }
} catch (e) {
  if (!e.probeDone) {
  console.log(`FAIL ${e.message}`);
  failed++;
  await page.screenshot({ path: process.env.GL_SHOT ?? `/tmp/gl-${appName}.png` }).catch(() => {});
  }
} finally {
  if (errors.length) console.log(`page errors: ${[...new Set(errors)].slice(0, 60).join(' | ')}`);
  const out = await page.evaluate(() => window.__glOut).catch(() => '');
  if (process.env.GL_FETCH) { // copy a file out of the page (a guest profile, say)
    for (const pair of process.env.GL_FETCH.split(',')) {
      const [from, to] = pair.split(':');
      const b64 = await page.evaluate(async (f) => { const d = await window.__tabcomputer.fs.readFile(f); let s = ''; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000)); return btoa(s); }, from).catch((e) => { console.log(`GL_FETCH ${from}: ${e.message}`); return ''; });
      if (b64) writeFileSync(to, Buffer.from(b64, 'base64'));
    }
  }
  if (failed || process.env.GL_VERBOSE) {
    console.log(`${appName} output:\n${out}`);
    const diag = await page.evaluate(async () => ({
      glx: window.__shiroX ? window.__shiroX.server.extensions.has('GLX') : 'no X session',
      vendorLibrary: await window.__tabcomputer.fs.exists('/usr/lib/x86_64-linux-gnu/libGLX_tabcomputer.so.0'),
      glshiro: window.__tabcomputer.gl() ? window.__tabcomputer.gl().connections : 'not running',
      glSurfaces: [...document.querySelectorAll('canvas[data-gl-surface]')].map((c) => `${c.dataset.glSurface} ${c.width}x${c.height} ${c.isConnected ? '' : 'detached'} ${getComputedStyle(c).display}`),
    })).catch((e) => e.message);
    console.log(`diagnostics: ${JSON.stringify(diag)}`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));
  await browser.close();
}
process.exit(failed ? 1 : 0);
