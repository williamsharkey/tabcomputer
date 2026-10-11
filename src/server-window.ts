/**
 * Server Window - macOS-style window wrapper for iframe content
 *
 * Creates a draggable, resizable window with traffic light controls
 * and a title bar showing the server info.
 */

import { smartCopyProcess } from './utils/copy-utils';

export interface ServerWindowOptions {
  port?: number;
  path?: string;
  directory?: string;
  width?: string;
  height?: string;
  container?: HTMLElement;
  mode?: 'iframe' | 'terminal';
  title?: string;
  onClose?: () => void;
  onBecome?: (port: number) => void;
  /**
   * On the desktop: the app the window belongs to, so the menu bar names it
   * while it's focused (`appName`, registered when the desktop doesn't know
   * the id). Default: one per title.
   */
  appId?: string;
  appName?: string;
  /** On the desktop: the command line that opens this window again after a reload (session restore), and where */
  restore?: { cmd: string; cwd: string };
}

/** A command line that runs `name args` again (session restore): each argument shell-quoted */
export function commandLine(name: string, args: string[]): string {
  return [name, ...args].map((a) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) && !a.startsWith('~') ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The part of the desktop's window manager (src/desktop/wm.ts) a server window uses */
interface DesktopWM {
  createWindow(o: Record<string, unknown>): DesktopWin;
  app(id?: string): unknown;
  registerApp(a: { id: string; name: string; dock?: boolean; launch: () => DesktopWin | null }): void;
  visibleOrder(): DesktopWin[];
}
interface DesktopWin {
  readonly element: HTMLElement; readonly appId?: string; readonly titlebarExtra: HTMLElement | null;
  setTitle(t: string): void; close(force?: boolean): boolean; minimize(): void; zoom(): void; focus(): void;
  on(ev: 'close', cb: () => void): () => void;
}
const desktopWM = (): DesktopWM | null => (globalThis as { __shiroDesktop?: DesktopWM }).__shiroDesktop ?? null;

const emPx = (v: string, dflt: number) => { const m = /^([\d.]+)em$/.exec(v); return m ? Math.round(parseFloat(m[1]) * 16) : dflt; };

/**
 * A server window as a desktop window (when the desktop is up): the same
 * content (an iframe, or a terminal div that can split with one), in a window
 * the window manager stacks and focuses, so the menu bar follows it.
 */
function desktopServerWindow(wm: DesktopWM, options: ServerWindowOptions, titleText: string): ServerWindow {
  const { port, path = '/', width = '32em', height = '22em', mode = 'iframe', onClose } = options;
  const appId = options.appId ?? 'server-window';
  if (!wm.app(appId)) {
    wm.registerApp({ id: appId, name: options.appName ?? titleText, dock: false, launch: () => wm.visibleOrder().find((w) => w.appId === appId) ?? null });
  }
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;background:#1a1a2e';
  let contentDiv: HTMLDivElement | null = null;
  const iframe = document.createElement('iframe');
  if (mode === 'terminal') {
    contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'flex:1;overflow:hidden;display:flex;background:#1a1a2e;min-height:0';
    iframe.style.cssText = 'display:none;border:none;border-left:1px solid #333;background:#fff';
    body.appendChild(contentDiv);
  } else {
    iframe.style.cssText = 'border:none;width:100%;flex:1;background:#0a0a1a;display:block;min-height:0';
    if (port != null) iframe.setAttribute('data-virtual-port', String(port));
    iframe.setAttribute('data-virtual-path', path);
    body.appendChild(iframe);
  }
  const win = wm.createWindow({
    appId, title: titleText, width: emPx(width, 512), height: emPx(height, 352), minWidth: 300, minHeight: 160,
    content: { kind: 'dom', element: body },
  });
  win.element.setAttribute('data-server-window', port != null ? String(port) : (options.title || 'terminal'));
  if (options.restore) (win as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = options.restore;
  let closed = false;
  win.on('close', () => { if (closed) return; closed = true; onClose?.(); });
  // findServerWindow / closeAllServerWindows close it through the window manager
  (win.element as any)._close = () => win.close(true);
  const button = (label: string, act: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sd-btn';
    b.textContent = label;
    b.style.cssText = 'height:22px;padding:0 9px;margin-left:6px;font-size:11px';
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); act(); });
    win.titlebarExtra?.appendChild(b);
  };
  if (mode === 'iframe' && port != null && options.onBecome) button('Become', () => options.onBecome!(port!));
  let split = false;
  return {
    element: win.element as HTMLDivElement,
    iframe,
    contentDiv,
    close: () => { win.close(true); },
    minimize: () => win.minimize(),
    maximize: () => win.zoom(),
    setTitle: (t: string) => win.setTitle(t),
    updateIframe: (html: string) => { iframe.srcdoc = html; },
    setTerminal: mode === 'terminal' ? (wt) => {
      button('Paste', async () => {
        try { const text = await navigator.clipboard.readText(); if (text) wt.term.paste(text); } catch { const text = prompt('Paste text:'); if (text) wt.term.paste(text); }
      });
      button('Copy', async () => {
        const selection = wt.term.getSelection?.();
        try { await navigator.clipboard.writeText(selection || smartCopyProcess(wt.getBufferContent())); } catch {}
      });
    } : undefined,
    showSplit: mode === 'terminal' ? (html: string, splitPort: number) => {
      if (split) return;
      split = true;
      body.style.flexDirection = 'row';
      contentDiv!.style.minWidth = '0';
      iframe.style.display = 'block';
      iframe.style.flex = '1';
      iframe.style.minWidth = '0';
      iframe.setAttribute('data-virtual-port', String(splitPort));
      iframe.srcdoc = html;
      body.appendChild(iframe);
    } : undefined,
  };
}

export interface ServerWindow {
  element: HTMLDivElement;
  iframe: HTMLIFrameElement;
  contentDiv: HTMLDivElement | null;
  close: () => void;
  minimize: () => void;
  maximize: () => void;
  setTitle: (title: string) => void;
  updateIframe: (html: string) => void;
  setTerminal?: (wt: import('./window-terminal').WindowTerminal) => void;
  /** Split a terminal-mode window: terminal on left, iframe on right */
  showSplit?: (html: string, port: number) => void;
}

export function createServerWindow(options: ServerWindowOptions): ServerWindow {
  const { port, path = '/', directory, width = '32em', height = '22em', container = document.body, mode = 'iframe', onClose } = options;

  // Build title
  const titleText = options.title
    ? options.title
    : directory
      ? `${directory}:${port}${path}`
      : port != null ? `localhost:${port}${path}` : 'terminal';

  // On the desktop: a desktop window (the classic UI keeps the floating one below)
  const wm = desktopWM();
  if (wm && container === document.body) return desktopServerWindow(wm, options, titleText);

  // Calculate responsive positioning
  // If viewport can't contain the window with 10% margin on each side, constrain it
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 0.1; // 10% margin on each side
  const maxWidth = vw * (1 - margin * 2); // 80% of viewport

  // Convert em width to pixels (assume 16px base font)
  const emMatch = width.match(/^([\d.]+)em$/);
  const requestedWidth = emMatch ? parseFloat(emMatch[1]) * 16 : 512;

  // Determine actual width and positioning
  const needsConstrain = requestedWidth > maxWidth;
  const actualWidth = needsConstrain ? `${maxWidth}px` : width;
  const horizontalPos = needsConstrain
    ? { left: `${vw * margin}px`, right: 'auto' }
    : { right: '20px', left: 'auto' };

  // Main wrapper
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-server-window', port != null ? String(port) : (options.title || 'terminal'));
  const S = wrapper.style;
  S.position = 'fixed';
  S.bottom = '20px';
  S.left = horizontalPos.left;
  S.right = horizontalPos.right;
  S.width = actualWidth;
  S.height = height;
  S.zIndex = '2147483647';
  S.borderRadius = '8px';
  S.overflow = 'hidden';
  S.boxShadow = 'rgb(255 255 255 / 15%) 0px 0px 20px 6px';
  S.fontFamily = '-apple-system,BlinkMacSystemFont,sans-serif';
  S.display = 'flex';
  S.flexDirection = 'column';
  S.background = '#1a1a2e';

  // Title bar
  const titleBar = document.createElement('div');
  const T = titleBar.style;
  T.background = '#1a1a2e';
  T.height = '32px';
  T.display = 'flex';
  T.alignItems = 'center';
  T.padding = '0 10px';
  T.cursor = 'grab';
  T.userSelect = 'none';
  T.flexShrink = '0';

  // Traffic light container
  const dots = document.createElement('div');
  dots.style.display = 'flex';
  dots.style.gap = '6px';

  // Helper to add both click and touch handlers (mobile Safari needs touchend)
  const onTap = (el: HTMLElement, handler: () => void) => {
    el.onclick = (e) => { e.stopPropagation(); handler(); };
    el.ontouchend = (e) => { e.preventDefault(); e.stopPropagation(); handler(); };
  };

  // Traffic light dot factory
  const makeDot = (color: string, hoverIcon: string) => {
    const dot = document.createElement('div');
    dot.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};cursor:pointer;position:relative;margin:auto 0`;
    const icon = document.createElement('span');
    icon.textContent = hoverIcon;
    icon.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:9px;line-height:1;color:#333;opacity:0;pointer-events:none;transition:opacity 0.12s';
    dot.appendChild(icon);
    dot.onmouseenter = () => { icon.style.opacity = '0.8'; };
    dot.onmouseleave = () => { icon.style.opacity = '0'; };
    return dot;
  };

  // Close button (red) — dot icon
  const closeBtn = makeDot('#ff5f57', '\u00b7');

  // Minimize button (yellow) — minus icon
  const miniBtn = makeDot('#febc2e', '\u2013');
  let minimized = false;
  let savedH = 0;

  // Maximize button (green) — expand icon
  const maxBtn = makeDot('#27c93f', '\u25e3');
  let maximized = false;
  let savedState = { width: '', height: '', top: '', left: '', bottom: '', right: '', borderRadius: '' };

  // Wire up button handlers with touch support
  onTap(closeBtn, () => {
    onClose?.();
    (wrapper as any)._cleanup?.();
    wrapper.remove();
  });

  onTap(miniBtn, () => {
    minimized = !minimized;
    if (minimized) {
      savedH = wrapper.offsetHeight;
      contentElement.style.display = 'none';
      resizeHandle.style.display = 'none';
      wrapper.style.height = '32px';
    } else {
      contentElement.style.display = mode === 'terminal' ? 'flex' : 'block';
      resizeHandle.style.display = 'block';
      wrapper.style.height = savedH + 'px';
    }
  });

  onTap(maxBtn, () => {
    if (maximized) {
      // Restore
      wrapper.style.width = savedState.width;
      wrapper.style.height = savedState.height;
      wrapper.style.top = savedState.top;
      wrapper.style.left = savedState.left;
      wrapper.style.bottom = savedState.bottom;
      wrapper.style.right = savedState.right;
      wrapper.style.borderRadius = savedState.borderRadius;
      resizeHandle.style.display = 'block';
    } else {
      // Maximize
      savedState = {
        width: wrapper.style.width,
        height: wrapper.style.height,
        top: wrapper.style.top,
        left: wrapper.style.left,
        bottom: wrapper.style.bottom,
        right: wrapper.style.right,
        borderRadius: wrapper.style.borderRadius,
      };
      wrapper.style.width = '100vw';
      wrapper.style.height = '100vh';
      wrapper.style.top = '0';
      wrapper.style.left = '0';
      wrapper.style.bottom = 'auto';
      wrapper.style.right = 'auto';
      wrapper.style.borderRadius = '0';
      resizeHandle.style.display = 'none';
    }
    maximized = !maximized;
  });

  dots.appendChild(closeBtn);
  dots.appendChild(miniBtn);
  dots.appendChild(maxBtn);

  // Become button (only for iframe-mode windows with a port and onBecome callback)
  if (mode === 'iframe' && port != null && options.onBecome) {
    const becomeBtn = makeDot('#af52de', '\u2b1a');
    becomeBtn.title = 'Become — full-screen app mode';
    onTap(becomeBtn, () => options.onBecome!(port!));
    dots.appendChild(becomeBtn);
  }

  // Title
  const title = document.createElement('span');
  title.textContent = titleText;
  title.style.cssText = 'color:#8888cc;font-size:13px;font-weight:600;margin-left:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

  titleBar.appendChild(dots);
  titleBar.appendChild(title);

  // Copy/Paste buttons for terminal-mode windows
  let copyBtn: HTMLButtonElement | null = null;
  let pasteBtn: HTMLButtonElement | null = null;
  if (mode === 'terminal') {
    const btnStyle = `
      height:22px;padding:0 8px;border-radius:11px;border:1px solid #3d3d5c;
      background:#1a1a2e;color:#8888cc;font-size:11px;cursor:pointer;
      font-family:-apple-system,BlinkMacSystemFont,sans-serif;
      user-select:none;-webkit-user-select:none;
      transition:background 0.1s,transform 0.1s;margin-left:4px;
    `.replace(/\n\s*/g, '');

    pasteBtn = document.createElement('button');
    pasteBtn.textContent = 'Paste';
    pasteBtn.style.cssText = btnStyle;

    copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.style.cssText = btnStyle;

    // Active press feedback
    for (const btn of [pasteBtn, copyBtn]) {
      btn.addEventListener('pointerdown', () => { btn.style.transform = 'scale(0.95)'; });
      btn.addEventListener('pointerup', () => { btn.style.transform = ''; });
      btn.addEventListener('pointerleave', () => { btn.style.transform = ''; });
    }

    titleBar.appendChild(pasteBtn);
    titleBar.appendChild(copyBtn);
  }

  // Content area: iframe or terminal div
  let iframe: HTMLIFrameElement;
  let contentDiv: HTMLDivElement | null = null;
  let contentElement: HTMLElement;

  // Container for split layout (terminal + iframe side by side)
  let splitContainer: HTMLDivElement | null = null;

  if (mode === 'terminal') {
    contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'flex:1;overflow:hidden;display:flex;background:#1a1a2e';
    contentElement = contentDiv;
    // Create iframe (hidden until showSplit is called)
    iframe = document.createElement('iframe');
    iframe.style.cssText = 'display:none;border:none;border-left:1px solid #333;background:#fff';
  } else {
    iframe = document.createElement('iframe');
    iframe.style.cssText = 'border:none;width:100%;flex:1;background:#0a0a1a;visibility:visible;opacity:1;display:block';
    if (port != null) iframe.setAttribute('data-virtual-port', String(port));
    iframe.setAttribute('data-virtual-path', path);
    contentElement = iframe;
  }

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.style.cssText = 'position:absolute;bottom:0;right:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,#555 50%)';

  wrapper.appendChild(titleBar);
  wrapper.appendChild(contentElement);
  wrapper.appendChild(resizeHandle);

  // Click-to-focus: bring window to front
  wrapper.onmousedown = () => { wrapper.style.zIndex = String(Date.now() % 2147483647); };

  // Dragging
  let dx = 0, dy = 0, sx = 0, sy = 0, dragging = false;
  titleBar.onmousedown = (e) => {
    if (maximized) return; // Don't drag when maximized
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left;
    dy = r.top;
    titleBar.style.cursor = 'grabbing';
    e.preventDefault();
  };

  // Touch dragging for mobile
  titleBar.ontouchstart = (e) => {
    if (maximized) return;
    dragging = true;
    const touch = e.touches[0];
    sx = touch.clientX;
    sy = touch.clientY;
    const r = wrapper.getBoundingClientRect();
    dx = r.left;
    dy = r.top;
    e.preventDefault();
  };

  // Resizing
  let resizing = false;
  resizeHandle.onmousedown = (e) => {
    resizing = true;
    e.preventDefault();
    e.stopPropagation();
  };

  resizeHandle.ontouchstart = (e) => {
    resizing = true;
    e.preventDefault();
    e.stopPropagation();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragging) {
      wrapper.style.left = (dx + e.clientX - sx) + 'px';
      wrapper.style.top = (dy + e.clientY - sy) + 'px';
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';
    }
    if (resizing) {
      const rr = wrapper.getBoundingClientRect();
      const nw = Math.max(300, e.clientX - rr.left);
      const nh = Math.max(200, e.clientY - rr.top);
      wrapper.style.width = nw + 'px';
      wrapper.style.height = nh + 'px';
      savedH = nh;
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (dragging) {
      wrapper.style.left = (dx + touch.clientX - sx) + 'px';
      wrapper.style.top = (dy + touch.clientY - sy) + 'px';
      wrapper.style.right = 'auto';
      wrapper.style.bottom = 'auto';
    }
    if (resizing) {
      const rr = wrapper.getBoundingClientRect();
      const nw = Math.max(300, touch.clientX - rr.left);
      const nh = Math.max(200, touch.clientY - rr.top);
      wrapper.style.width = nw + 'px';
      wrapper.style.height = nh + 'px';
      savedH = nh;
    }
  };

  const onEnd = () => {
    dragging = false;
    resizing = false;
    titleBar.style.cursor = 'grab';
  };

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onEnd);

  // Store cleanup handlers
  (wrapper as any)._cleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onEnd);
  };

  container.appendChild(wrapper);

  return {
    element: wrapper,
    iframe,
    contentDiv,
    close: () => {
      onClose?.();
      (wrapper as any)._cleanup?.();
      wrapper.remove();
    },
    minimize: () => miniBtn.click(),
    maximize: () => maxBtn.click(),
    setTitle: (newTitle: string) => {
      title.textContent = newTitle;
    },
    updateIframe: (html: string) => {
      iframe.srcdoc = html;
    },
    setTerminal: mode === 'terminal' ? (wt) => {
      if (copyBtn) {
        onTap(copyBtn, async () => {
          const selection = wt.term.getSelection?.();
          const content = selection || smartCopyProcess(wt.getBufferContent());
          try { await navigator.clipboard.writeText(content); } catch {}
        });
      }
      if (pasteBtn) {
        onTap(pasteBtn, async () => {
          try {
            const text = await navigator.clipboard.readText();
            if (text) wt.term.paste(text);
          } catch {
            const text = prompt('Paste text:');
            if (text) wt.term.paste(text);
          }
        });
      }
    } : undefined,
    showSplit: mode === 'terminal' ? (html: string, splitPort: number) => {
      if (splitContainer) return; // already split
      // Wrap contentDiv + iframe in a flex row
      splitContainer = document.createElement('div');
      splitContainer.style.cssText = 'flex:1;display:flex;overflow:hidden';
      // Terminal gets 50%
      contentDiv!.style.flex = '1';
      contentDiv!.style.minWidth = '0';
      // Iframe gets 50%
      iframe.style.display = 'block';
      iframe.style.flex = '1';
      iframe.style.minWidth = '0';
      iframe.setAttribute('data-virtual-port', String(splitPort));
      iframe.srcdoc = html;
      // Re-parent
      wrapper.insertBefore(splitContainer, resizeHandle);
      splitContainer.appendChild(contentDiv!);
      splitContainer.appendChild(iframe);
      contentElement.remove(); // remove old direct child (same as contentDiv, now re-parented)
    } : undefined,
  };
}

/**
 * Find an existing server window by port
 */
export function findServerWindow(port: number): ServerWindow | null {
  const el = document.querySelector(`[data-server-window="${port}"]`) as HTMLDivElement | null;
  if (!el) return null;

  const iframe = el.querySelector('iframe') as HTMLIFrameElement;
  return {
    element: el,
    iframe,
    contentDiv: null,
    close: () => {
      if ((el as any)._close) { (el as any)._close(); return; }
      (el as any)._cleanup?.();
      el.remove();
    },
    minimize: () => {},
    maximize: () => {},
    setTitle: () => {},
    updateIframe: (html: string) => {
      iframe.srcdoc = html;
    },
  };
}

/**
 * Close all server windows
 */
export function closeAllServerWindows(): void {
  document.querySelectorAll('[data-server-window]').forEach(el => {
    if ((el as any)._close) { (el as any)._close(); return; }
    (el as any)._cleanup?.();
    el.remove();
  });
}
