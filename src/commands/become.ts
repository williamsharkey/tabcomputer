// become.ts - App mode: make Shiro "become" a served app full-screen
// Usage: become [port] [slug] [--start CMD]   — activate app mode
//        unbecome                             — return to terminal
//
// The app's page is a real document at /__preview/<tab>/<port>/ where service
// workers work (as in a Preview window: its fetches carry bytes both ways and
// its links navigate by themselves), else a srcdoc copy. --start names the
// command that starts the app's own server (`node server.js 4780`), run again
// in the directory `become` was typed in when the tab is reloaded; without it a
// reload can only bring back a static `serve DIR`.

import { Command, CommandContext } from './index';
import { getActiveServers, injectIframeScripts } from './serve';
import { iframeServer } from '../iframe-server';
import { previewUrl } from '../preview-sw-host';

const STORAGE_KEY = 'tabcomputer-become';

export interface BecomeConfig {
  directory: string;
  port: number;
  slug: string;
  title: string;
  /** The command that starts the app's server, and where to run it (a reload runs it again) */
  start?: string;
  cwd?: string;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Bring the app's server back after a reload: its own start command when
 * `become --start` recorded one, else a static `serve` of its directory.
 * `run` executes a shell line; a server that stays in the foreground never
 * returns, so the port coming up is what counts. False: nothing is listening.
 */
export async function startBecomeServer(config: BecomeConfig, run: (cmd: string) => Promise<number>, waitMs = 20_000): Promise<boolean> {
  if (iframeServer.isPortInUse(config.port)) return true;
  if (!config.start) return (await run(`serve ${shq(config.directory)} ${config.port}`)) === 0;
  let exited = false;
  void run(`cd ${shq(config.cwd || config.directory)} && ${config.start}`).then(() => { exited = true; }, () => { exited = true; });
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => { off(); clearInterval(poll); clearTimeout(timer); resolve(ok); };
    const off = iframeServer.onPortChange((p, up) => { if (p === config.port && up) done(true); });
    // (the command ending without a listener is a failure: stop waiting)
    const poll = setInterval(() => { if (iframeServer.isPortInUse(config.port)) done(true); else if (exited) done(false); }, 100);
    const timer = setTimeout(() => done(iframeServer.isPortInUse(config.port)), waitMs);
  });
}

/** Read become config from localStorage (synchronous) */
export function getBecomeConfig(): BecomeConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/** Activate become mode: hide terminal, show full-screen app iframe */
export async function activateBecomeMode(config: BecomeConfig): Promise<void> {
  // Save config
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));

  // Add class to body to hide terminal/vkeys via CSS
  document.body.classList.add('become-active');

  // Create full-screen container
  let container = document.getElementById('become-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'become-container';
    document.body.appendChild(container);
  }

  // Create iframe
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'width:100%;height:100%;border:none';
  container.innerHTML = '';
  container.appendChild(iframe);

  // A real document where service workers work: bytes both ways, its own navigation
  const swUrl = await previewUrl(config.port, '/').catch(() => null);
  if (swUrl) {
    iframe.setAttribute('data-preview-sw', '');
    iframe.setAttribute('data-virtual-port', String(config.port));
    iframe.src = swUrl;
    history.pushState({}, '', '/' + config.slug);
    document.title = config.title || config.slug;
    return;
  }

  // Fetch content from the virtual server
  iframeServer.ensureResourceProxy();
  try {
    const response = await iframeServer.fetch(config.port, '/');
    let html: string;
    if (typeof response.body === 'string') {
      html = response.body;
    } else if (response.body instanceof Uint8Array) {
      html = new TextDecoder().decode(response.body);
    } else {
      html = '<!DOCTYPE html><html><body></body></html>';
    }
    html = injectIframeScripts(html, config.port);
    iframe.srcdoc = html;
  } catch (err) {
    iframe.srcdoc = `<html><body style="color:#fff;background:#1a1a2e;font-family:monospace;padding:2em">
      <h2>Failed to load app</h2>
      <p>${err instanceof Error ? err.message : 'Unknown error'}</p>
      <p>Run <code>__tabcomputer.unbecome()</code> in browser console to return to terminal.</p>
    </body></html>`;
  }

  // Set up navigation message handler
  const navHandler = async (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    if (event.data?.type === 'virtual-navigate' && event.data?.port === config.port) {
      const newPath = event.data.path;
      try {
        const navResponse = await iframeServer.fetch(config.port, newPath);
        let navHtml = typeof navResponse.body === 'string'
          ? navResponse.body
          : navResponse.body instanceof Uint8Array
            ? new TextDecoder().decode(navResponse.body)
            : '';
        navHtml = injectIframeScripts(navHtml, config.port);
        iframe.srcdoc = navHtml;
      } catch {}
    }

  };
  window.addEventListener('message', navHandler);
  (container as any)._navCleanup = () => window.removeEventListener('message', navHandler);

  // Update URL and title
  history.pushState({}, '', '/' + config.slug);
  document.title = config.title || config.slug;
}

/** Deactivate become mode: return to terminal */
export function deactivateBecomeMode(): void {
  // Remove container
  const container = document.getElementById('become-container');
  if (container) {
    (container as any)._navCleanup?.();
    container.remove();
  }

  // Clear config
  localStorage.removeItem(STORAGE_KEY);

  // Show terminal/vkeys
  document.body.classList.remove('become-active');

  // Reset URL and title
  history.pushState({}, '', '/');
  document.title = window.location.hostname || 'shiro';

  // Focus terminal
  const shiro = (window as any).__tabcomputer;
  if (shiro?.terminal?.term) {
    shiro.terminal.term.focus();
  }
}

export const becomeCmd: Command = {
  name: 'become',
  description: 'Enter app mode — full-screen served app',
  async exec(ctx: CommandContext): Promise<number> {
    const args = ctx.args;
    const servers = getActiveServers();

    let port: number;
    let slug: string | undefined;
    // --start CMD: how to start the app's server again after a reload
    let start: string | undefined;
    const at = args.indexOf('--start');
    if (at >= 0) {
      start = args.slice(at + 1).join(' ').trim();
      args.splice(at);
      if (!start) { ctx.stderr = 'become: --start needs the command that starts the server\n'; return 1; }
    }

    if (args.length === 0) {
      // No args: use the only active server
      const ports = iframeServer.list().map((s) => s.port);
      if (ports.length === 0) {
        ctx.stderr = 'become: no active servers. Run "serve <dir> <port>" first.\n';
        return 1;
      }
      if (ports.length > 1) {
        ctx.stderr = 'become: multiple servers running. Specify port: become <port> [slug]\n';
        for (const p of ports) ctx.stderr += `  :${p} ${servers.get(p)?.directory || ''}\n`;
        return 1;
      }
      port = ports[0];
    } else {
      port = parseInt(args[0]);
      if (isNaN(port)) {
        ctx.stderr = `become: invalid port: ${args[0]}\n`;
        return 1;
      }
      slug = args[1];
    }

    if (!iframeServer.isPortInUse(port)) {
      ctx.stderr = `become: no server on port ${port}\n`;
      return 1;
    }

    const serverInfo = servers.get(port);
    // A server `serve` didn't start (node, a guest program): the app's directory is where become was typed
    const directory = serverInfo?.directory || (start ? ctx.cwd : '/tmp');

    // Derive slug from directory basename if not provided
    if (!slug) {
      slug = directory.split('/').filter(Boolean).pop() || 'app';
    }

    const config: BecomeConfig = {
      directory,
      port,
      slug,
      title: slug.charAt(0).toUpperCase() + slug.slice(1),
      ...(start ? { start, cwd: ctx.cwd } : {}),
    };

    await activateBecomeMode(config);
    ctx.stdout = `Became "${config.slug}" — full-screen app mode\n`;
    if (!serverInfo && !start) ctx.stdout += `Note: the server on ${port} was not started by serve; a reload cannot restart it. Use: become ${port} ${slug} --start 'COMMAND'\n`;
    ctx.stdout += `Run __tabcomputer.unbecome() in browser console to return.\n`;
    return 0;
  },
};

export const unbecomeCmd: Command = {
  name: 'unbecome',
  description: 'Exit app mode — return to terminal',
  async exec(ctx: CommandContext): Promise<number> {
    if (!getBecomeConfig()) {
      ctx.stderr = 'unbecome: not in app mode\n';
      return 1;
    }
    deactivateBecomeMode();
    ctx.stdout = 'Returned to terminal\n';
    return 0;
  },
};
