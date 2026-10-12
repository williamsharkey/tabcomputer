#!/usr/bin/env node
/**
 * Shiro MCP Server
 *
 * Connect Claude Code to Shiro browser OS via WebRTC.
 * No local server needed - direct peer-to-peer connection.
 *
 * Usage:
 *   npx shiro-mcp           # Run as MCP server
 *   npx shiro-mcp --install # Add to Claude Code config
 *
 * Then use the connect tool with a code from 'remote start' in Shiro.
 */

import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { createSocket } from "dgram";
import { lookup } from "dns/promises";
import { randomFillSync, webcrypto } from "crypto";
import {
  RelayChannel, parseRemoteCode, fetchOffer, sendAnswer, RemoteProtocolError,
  type RelayInfo, type RemoteCode, type OfferPayload,
} from "./relay.js";
import { collectProfile, profileToTrace } from "./trace.js";

// WebCrypto for the relay on Node 18 (global from Node 19)
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

// Handle --install flag before loading WebRTC (which is slow)
if (process.argv.includes("--install") || process.argv.includes("install")) {
  const mcpEntry = {
    shiro: {
      command: "npx",
      args: ["-y", "shiro-mcp"]
    }
  };

  // Config file locations for different Claude products
  const configPaths = [
    { path: join(homedir(), ".claude.json"), name: "Claude Code CLI" },
    { path: join(homedir(), ".claude", "claude_desktop_config.json"), name: "Claude Code CLI (alt)" },
    { path: join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"), name: "Claude Desktop (macOS)" },
    { path: join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json"), name: "Claude Desktop (Windows)" },
  ];

  let installed = false;

  for (const { path: configPath, name } of configPaths) {
    if (!configPath) continue;

    try {
      let config: any = {};

      if (existsSync(configPath)) {
        const content = readFileSync(configPath, "utf-8");
        config = JSON.parse(content);
      } else {
        // Create config file if it doesn't exist (for primary Claude Code config)
        if (configPath.endsWith(".claude.json")) {
          mkdirSync(dirname(configPath), { recursive: true });
        } else {
          continue; // Skip non-existent paths for other products
        }
      }

      // Add or update mcpServers
      config.mcpServers = { ...config.mcpServers, ...mcpEntry };

      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
      console.log(`✓ Added shiro to ${name}`);
      console.log(`  ${configPath}`);
      installed = true;
    } catch (e) {
      // Skip files we can't read/write
    }
  }

  if (installed) {
    console.log("\n✓ Installation complete!");
    console.log("\nNext steps:");
    console.log("  1. Restart Claude Code");
    console.log("  2. In Shiro browser, run: remote start");
    console.log("  3. Use the shiro:connect tool with the code");
    console.log("\nLearn more: https://shiro.computer/mcp.html");
  } else {
    console.log("No Claude config files found.");
    console.log("\nManual installation:");
    console.log("Add this to your Claude config (~/.claude.json or similar):\n");
    console.log(JSON.stringify({ mcpServers: mcpEntry }, null, 2));
  }

  process.exit(0);
}

// WebRTC for Node.js using node-datachannel
import { PeerConnection } from "node-datachannel";

const SIGNALING_URL = process.env.TABCOMPUTER_SIGNALING_URL || "https://shiro.computer";

// auto: WebRTC when UDP reaches a STUN server, else the tab's HTTPS relay (and
// the relay after a WebRTC connection fails). webrtc / relay: only that one.
const TRANSPORT = (process.env.TABCOMPUTER_TRANSPORT || "auto").toLowerCase();

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node 22.21+, 24+)
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  console.error("[shiro-mcp] HTTPS_PROXY is set but Node's fetch won't use it; run with NODE_USE_ENV_PROXY=1");
}

/** Does UDP reach a STUN server? (One binding request; no answer in time = no.) */
async function udpWorks(timeoutMs = 2500): Promise<boolean> {
  let address: string;
  try { ({ address } = await lookup("stun.l.google.com", { family: 4 })); } catch { return false; }
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const done = (ok: boolean) => { clearTimeout(timer); try { sock.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.on("message", () => done(true));
    sock.on("error", () => done(false));
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);      // Binding Request
    req.writeUInt32BE(0x2112a442, 4);  // magic cookie
    randomFillSync(req, 8, 12);        // transaction id
    sock.send(req, 19302, address, (err) => { if (err) done(false); });
  });
}

// MCP Protocol types
interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// Connection state
interface RemoteConnection {
  code: string;
  pc: any;
  dc: any;
  transport: "webrtc" | "relay";
  status: "connecting" | "connected" | "disconnected";
  pendingRequests: Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>;
  requestCounter: number;
}

let activeConnection: RemoteConnection | null = null;

// Console error tracking - accumulates errors pushed from Shiro
let consoleErrors: Array<{ timestamp: number; message: string; source?: string; line?: number }> = [];

// User messages from Shiro panel - accumulate and include in next tool response
let userMessages: Array<{ timestamp: number; message: string }> = [];

// Tool definitions
// Store the last used code for reconnection
let lastCode: string | null = null;

const TOOLS = [
  {
    name: "connect",
    description: "Connect to a Shiro browser OS instance via WebRTC. Get a connection code by running 'remote start' in the Shiro terminal.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Connection code from 'remote start', all of it: words, '#', then letters (e.g., 'fluffy-cloud-shimutako#abcdefghijklmnopqrstuvwxyz'). The part after # is a secret that is never sent to the server." }
      },
      required: ["code"]
    }
  },
  {
    name: "reconnect",
    description: "Reconnect to Shiro after the browser page reloads. Uses the last connection code. The browser side must run 'remote start' again after reload.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "disconnect",
    description: "Disconnect from Shiro and clear the saved connection code.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "status",
    description: "Check connection status. Returns { connected: boolean, code?: string, status?: 'connecting'|'connected'|'disconnected' }",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "exec",
    description: `Execute a shell command in Shiro browser OS. Returns { type: "exec_result", stdout, stderr, exitCode }.

Shiro provides 140+ commands including standard Unix tools plus:
- hc: DOM navigation (hc live, hc look, hc q <sel>, hc @N to click)
- serve: Virtual HTTP servers (serve <dir> [port], serve stop <port>)
- image: Filesystem snapshots (image save/load/list/delete)
- npm/node: Install packages and run JavaScript
- console: View browser console (console -e for errors)

Supports pipes (|), redirects (>, >>), &&, ||, and variables.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command (e.g., 'ls -la', 'hc live && hc look', 'cat file.txt | grep pattern')" }
      },
      required: ["command"]
    }
  },
  {
    name: "read",
    description: `Read a file from Shiro's virtual filesystem. Returns { type: "read_result", path, content }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path (e.g., '/home/user/app.js', '/tmp/data.json')" }
      },
      required: ["path"]
    }
  },
  {
    name: "write",
    description: `Write a file to Shiro's virtual filesystem. Returns { type: "write_result", path, ok: boolean }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path to write" },
        content: { type: "string", description: "File content (text)" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list",
    description: `List directory contents. Returns { type: "list_result", path, entries: string[] }.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (e.g., '/', '/home/user')" }
      },
      required: ["path"]
    }
  },
  {
    name: "eval",
    description: `Execute JavaScript in the browser context. Returns { type: "eval_result", result }.

IMPORTANT: Use JSON.stringify() for objects, otherwise they return as "[object Object]".`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript expression. Wrap objects in JSON.stringify()." }
      },
      required: ["code"]
    }
  },
  {
    name: "console",
    description: `Search the Shiro page's console log. Shiro records every console message from page load into a bounded buffer (newest 3000 entries, repeats collapsed), so this works no matter when you connected. previous: true searches the log saved by the page load before this one (e.g. before a crash or reload).

Returns newest-last entries { seq, t, level, text, count } plus matched/truncated counts. Defaults to 100 entries and 64 KB of text; raise limit/maxBytes if you need more.`,
    inputSchema: {
      type: "object",
      properties: {
        grep: { type: "string", description: "Case-insensitive regex the message must match" },
        level: { type: "string", description: "Comma list of levels: error,warn,log,info,debug" },
        since: { type: "number", description: "Only entries at/after this ms epoch; negative = that many ms ago (e.g. -600000 for the last 10 minutes)" },
        limit: { type: "number", description: "Max entries (newest kept). Default 100, max 5000" },
        maxBytes: { type: "number", description: "Max characters of message text. Default 65536, max 200000" },
        previous: { type: "boolean", description: "Search the previous page load's saved log instead" }
      }
    }
  },
  {
    name: "diag",
    description: `Why is the tabcomputer page slow or frozen? Returns the main-thread watchdog's view, recorded from page load: event-loop lag (last, max and average over 1 min), long tasks (count and ms over 1 min and since load), JS heap and a 20-minute heap series, shell commands in flight (innermost first, with run time), the process table, unsaved filesystem writes, and recent events: lag/stall (with the commands running then), longtask/loaf (with the script when known), cmd/cmd-end, wedge (the previous load froze and was closed or reloaded; previousWedge has the snapshot a worker saved during the freeze).

A frozen page can't answer until it recovers; if this times out, retry after a reload with previous: true to read what the last load recorded.`,
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Newest events returned. Default 200, max 1500" },
        since: { type: "number", description: "Only events at/after this ms epoch; negative = that many ms ago" },
        kind: { type: "string", description: "Comma list of kinds: lag,stall,longtask,loaf,cmd,cmd-end,wedge,note" },
        previous: { type: "boolean", description: "Events saved by the previous page load instead" },
        kernel: { type: "boolean", description: "Include kernel processes (default true): per process state, syscalls in progress ([nr, args…] oldest first, x86-64 numbers) and their age, kernelMs, engine sleeps, signals, threads; per fd: sockets (state, rxLen queued unread, rxEof, shutdowns, soError, relay WebSocket readyState/bufferedAmount/unacked) and pipes (readers, writers, bytes, waiters); plus open named pipes (fifos)" },
        procGrep: { type: "string", description: "Only kernel processes whose command line matches this regex (e.g. 'claude|node')" },
        procLimit: { type: "number", description: "Max kernel processes. Default 100" }
      }
    }
  },
  {
    name: "abort",
    description: `Kill switch: abort the tabcomputer page's foreground commands, like Ctrl-C in every terminal (in-page shell commands are aborted; the kernel's foreground process groups get SIGINT). Over the HTTPS relay the watchdog worker takes this request, so it works while the page is frozen: it raises a shared abort flag that the page checks at its yield points (shell function calls, source, loops; the x86 runner). A page stuck in one JavaScript loop with no yield point can't be stopped this way; reload it (the next load offers safe mode).`,
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "profile",
    description: `Live profile of the tabcomputer page (src/live-profile.ts), e.g. native Claude Code's startup or keystrokes. action:
- start: begin a capture (durationMs default 60000, max 600000; sampleMs default 100; procGrep: kernel processes to sample, e.g. 'claude'; label). It records long tasks and long animation frames (slowest script), input Event Timing and per keydown the time until a terminal echoed output (key classes only, never values), terminal output bytes, per process and syscall number the calls answered at once vs async with their total and max ms, and every sampleMs: event-loop lag, heap, the shell line in flight, and per kernel process the calls in progress and their age, syscall/kernel-ms deltas, threads in a call, Blink's engine lock (holder, waiters, acquires).
- mark: note a moment (text), e.g. before typing.
- stop / status: end it (it also ends by itself) / show it; both return a summary.
- collect: read the whole capture; with out: a local path, writes the JSON there and a Chrome/Perfetto trace next to it (<out>.trace.json), and returns only the summary and paths.
- read: one slice (part: tasks|inputs|samples|marks|syscalls|procs, offset).`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "start | mark | stop | status | collect | read" },
        durationMs: { type: "number" }, sampleMs: { type: "number" }, procGrep: { type: "string" }, label: { type: "string" },
        text: { type: "string", description: "mark text" },
        out: { type: "string", description: "collect: local file for the JSON (trace at <out>.trace.json)" },
        part: { type: "string" }, offset: { type: "number" }
      },
      required: ["action"]
    }
  },
  {
    name: "errors",
    description: "Get and clear pending console errors from Shiro browser. Errors accumulate passively and show as pendingErrors count in exec results.",
    inputSchema: {
      type: "object",
      properties: {
        clear: { type: "boolean", description: "Clear errors after fetching (default: true)" }
      }
    }
  }
];

async function sendCommand(cmd: object): Promise<any> {
  if (!activeConnection || activeConnection.status !== "connected" || !activeConnection.dc) {
    throw new Error("Not connected to Shiro");
  }

  const requestId = `req-${++activeConnection.requestCounter}`;
  const message = JSON.stringify({ ...cmd, requestId });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeConnection?.pendingRequests.delete(requestId);
      reject(new Error("Request timed out"));
    }, 30000);

    activeConnection!.pendingRequests.set(requestId, {
      resolve: (v) => { clearTimeout(timeout); resolve(v); },
      reject: (e) => { clearTimeout(timeout); reject(e); }
    });

    // node-datachannel uses sendMessage
    activeConnection!.dc!.sendMessage(message);
  });
}

/**
 * Attempt to reconnect after disconnect (e.g., page reload on Shiro side).
 * Polls for a new offer with the same code.
 */
let reconnectActive = false;

async function attemptReconnect(code: string) {
  // Prevent multiple reconnect loops from racing
  if (reconnectActive) {
    console.error("[shiro-mcp] Reconnect already in progress, skipping");
    return;
  }
  reconnectActive = true;

  const maxAttempts = 60; // 5 minutes at 5-second intervals
  let attempt = 0;

  const reconnect = async () => {
    // Stop if user manually disconnected or connected to different code
    if (activeConnection && activeConnection.code !== code) {
      console.error("[shiro-mcp] Reconnect cancelled - different connection active");
      reconnectActive = false;
      return;
    }

    attempt++;
    if (attempt > maxAttempts) {
      console.error("[shiro-mcp] Reconnect timeout - giving up");
      activeConnection = null;
      reconnectActive = false;
      return;
    }

    console.error(`[shiro-mcp] Reconnect attempt ${attempt}/${maxAttempts}...`);

    try {
      // Check if a new offer is available
      if (await fetchOffer(SIGNALING_URL, parseRemoteCode(code))) {
        // Clean up old connection without triggering another reconnect
        if (activeConnection) {
          try { activeConnection.dc?.close(); } catch {}
          try { activeConnection.pc?.close(); } catch {}
          activeConnection = null;
        }
        // Try to connect with the new offer
        await connectShiro(code);
        console.error("[shiro-mcp] Reconnected successfully!");
        reconnectActive = false;
        return;
      }
    } catch (e) {
      // Ignore errors, keep trying
    }

    // Try again in 5 seconds
    setTimeout(reconnect, 5000);
  };

  // Wait a bit before first attempt (give Shiro time to re-register)
  setTimeout(reconnect, 2000);
}

/** A message from the tab, over either transport */
function handleIncoming(connection: RemoteConnection, msg: string | Buffer) {
  try {
    const data = typeof msg === "string" ? msg : msg.toString();
    const response = JSON.parse(data);

    // Handle console error notifications pushed from Shiro (no requestId)
    if (response.type === "console_error") {
      consoleErrors.push({
        timestamp: Date.now(),
        message: response.message,
        source: response.source,
        line: response.line
      });
      return;
    }

    // Handle user messages from the Shiro panel input
    if (response.type === "user_message") {
      userMessages.push({
        timestamp: Date.now(),
        message: response.message
      });
      return;
    }

    // Ignore hello_ack (no requestId expected)
    if (response.type === "hello_ack") return;

    const { requestId, ...result } = response;

    if (requestId && connection.pendingRequests.has(requestId)) {
      const { resolve, reject } = connection.pendingRequests.get(requestId)!;
      connection.pendingRequests.delete(requestId);

      if (result.type === "error") {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    }
  } catch (e) {
    console.error("[shiro-mcp] Parse error:", e);
  }
}

async function connectShiro(code: string): Promise<string> {
  // Clean up existing connection if any
  if (activeConnection) {
    console.error(`[shiro-mcp] Disconnecting previous session (${activeConnection.code.split("#")[0]})`);
    try {
      if (activeConnection.dc) activeConnection.dc.close();
      activeConnection.pc?.close();
    } catch {
      // Ignore close errors
    }
    activeConnection = null;
  }

  // The code is <id>#<secret>: only the id goes to the signaling server (and into logs);
  // a code without a secret part is from an older tabcomputer and is refused here
  const parts = parseRemoteCode(code);

  // Save code for future reconnects
  lastCode = code;

  console.error(`[shiro-mcp] Connecting: ${parts.id}`);

  const offerData = await fetchOffer(SIGNALING_URL, parts);
  if (!offerData) {
    throw new Error(`Code not found: ${parts.id} (is \`remote start\` still running in the tab, on ${SIGNALING_URL}?)`);
  }

  let mode = TRANSPORT;
  if (mode === "auto") {
    mode = offerData.relay && !(await udpWorks()) ? "relay" : "webrtc";
    if (mode === "relay") console.error("[shiro-mcp] No UDP here (STUN unreachable); using the HTTPS relay");
  }
  if (mode === "relay") {
    if (!offerData.relay) throw new Error("This tab doesn't offer the HTTPS relay (update tabcomputer, or `remote start --relay`)");
    return connectRelay(code, offerData.relay);
  }
  try {
    return await connectWebRTC(code, offerData);
  } catch (e) {
    if (TRANSPORT !== "auto" || !offerData.relay) throw e;
    // The tab registers the code again once its side of WebRTC fails; answer
    // that new offer with the relay
    console.error(`[shiro-mcp] WebRTC failed (${(e as Error).message}); trying the HTTPS relay`);
    try { (activeConnection as RemoteConnection | null)?.pc?.close(); } catch {}
    activeConnection = null;
    const next = await waitForNewOffer(parts, offerData.relay.id, 60000);
    if (!next?.relay) throw e;
    return connectRelay(code, next.relay);
  }
}

/** Wait for the tab to register `code` again with a different relay mailbox */
async function waitForNewOffer(parts: RemoteCode, oldId: string, timeoutMs: number): Promise<OfferPayload | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const data = await fetchOffer(SIGNALING_URL, parts);
      if (data?.relay && data.relay.id !== oldId) return data;
    } catch (e) { if (e instanceof RemoteProtocolError) throw e; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/** Talk to the tab through the signaling server's HTTPS mailbox (src/remote-relay.ts) */
async function connectRelay(code: string, info: RelayInfo): Promise<string> {
  const parts = parseRemoteCode(code);
  // v2 (per-connection epochs) when the tab offers it, so a restarted shiro-mcp can rejoin a live tab
  await sendAnswer(SIGNALING_URL, parts, { answer: { type: "relay", v: info.v === 2 ? 2 : 1 }, candidates: [] });

  const relay = new RelayChannel({ base: SIGNALING_URL, info, secret: parts.secret, as: "peer", log: (m) => console.error(`[shiro-mcp] ${m}`) });
  const connection: RemoteConnection = {
    code,
    pc: null,
    // node-datachannel's shape; an intentional close doesn't start a reconnect
    dc: { sendMessage: (m: string) => relay.send(m), close: () => { relay.onclose = null; relay.close(); } },
    transport: "relay",
    status: "connecting",
    pendingRequests: new Map(),
    requestCounter: 0
  };
  activeConnection = connection;
  relay.onmessage = (ev) => handleIncoming(connection, ev.data);
  relay.onclose = () => {
    console.error("[shiro-mcp] Disconnected (relay)");
    connection.status = "disconnected";
    for (const p of connection.pendingRequests.values()) p.reject(new Error("Disconnected"));
    connection.pendingRequests.clear();
    attemptReconnect(connection.code);
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay timed out")), 30000);
    relay.onopen = () => { clearTimeout(timer); resolve(); };
  });
  connection.status = "connected";
  relay.send(JSON.stringify({ type: "hello", name: "shiro-mcp" }));
  // The tab starts polling within its answer poll interval (5 s); a ping
  // confirms it is there before tools are used
  await sendCommand({ type: "ping" }).catch(() => {
    throw new Error("The tab didn't answer over the relay (is the page frozen, or an older tabcomputer?)");
  });
  console.error("[shiro-mcp] Connected over the HTTPS relay");
  return `Connected to Shiro (${parts.id}, HTTPS relay)`;
}

async function connectWebRTC(code: string, offerData: OfferPayload): Promise<string> {
  const parts = parseRemoteCode(code);
  const offer = offerData.offer as { sdp: string; type: any };
  const candidates = offerData.candidates as { candidate?: string; sdpMid?: string }[];

  // node-datachannel PeerConnection
  const pc = new PeerConnection("shiro-mcp", {
    iceServers: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]
  });

  const connection: RemoteConnection = {
    code,
    pc,
    dc: null,
    transport: "webrtc",
    status: "connecting",
    pendingRequests: new Map(),
    requestCounter: 0
  };

  activeConnection = connection;

  const iceCandidates: any[] = [];

  // node-datachannel uses callback-based events
  pc.onLocalCandidate((candidate: string, mid: string) => {
    iceCandidates.push({ candidate, sdpMid: mid });
  });

  pc.onDataChannel((dc: any) => {
    connection.dc = dc;

    dc.onOpen(() => {
      console.error("[shiro-mcp] Connected!");
      connection.status = "connected";
      // Identify ourselves to the Shiro panel
      dc.sendMessage(JSON.stringify({ type: 'hello', name: 'shiro-mcp' }));
    });

    dc.onClosed(() => {
      console.error("[shiro-mcp] Disconnected");
      connection.status = "disconnected";
      // Start auto-reconnect loop
      attemptReconnect(connection.code);
    });

    dc.onMessage((msg: string | Buffer) => handleIncoming(connection, msg));
  });

  // Set remote description (the offer from Shiro)
  pc.setRemoteDescription(offer.sdp, offer.type);

  // Add remote ICE candidates
  for (const candidate of candidates) {
    if (candidate.candidate) {
      pc.addRemoteCandidate(candidate.candidate, candidate.sdpMid || "0");
    }
  }

  // Wait for ICE gathering to complete
  await new Promise<void>((resolve) => {
    pc.onGatheringStateChange((state: string) => {
      if (state === "complete") resolve();
    });
    setTimeout(resolve, 5000);
  });

  // Get our answer
  const localDesc = pc.localDescription();
  if (!localDesc) {
    throw new Error("Failed to create local description");
  }

  // Sealed with the code's secret: the server can't read it or put its own in its place
  await sendAnswer(SIGNALING_URL, parts, { answer: { type: localDesc.type, sdp: localDesc.sdp }, candidates: iceCandidates });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(check); reject(new Error("Connection timed out")); }, 30000);
    const check = setInterval(() => {
      if (connection.status === "connected") {
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  return `Connected to Shiro (${parts.id}, WebRTC)`;
}

function disconnectShiro(): string {
  if (!activeConnection) return "Not connected";
  try {
    if (activeConnection.dc) activeConnection.dc.close();
    activeConnection.pc?.close();
  } catch {
    // Ignore close errors
  }
  activeConnection = null;
  return "Disconnected";
}

/** Drain any pending user messages and attach them to a tool result */
function attachUserMessages(result: any) {
  if (userMessages.length > 0) {
    result.userMessages = userMessages.map(m => m.message);
    userMessages = [];
  }
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "connect":
      return await connectShiro(args.code as string);

    case "reconnect": {
      if (!lastCode) {
        throw new Error("No previous connection. Use 'connect' with a code first.");
      }
      // Retry with backoff - Shiro may take time to re-register after reload
      const maxAttempts = 5;
      const delays = [1500, 2000, 3000, 4000, 5000];

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        console.error(`[shiro-mcp] Reconnect attempt ${attempt + 1}/${maxAttempts}...`);
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));

        try {
          // Check if offer exists
          if (await fetchOffer(SIGNALING_URL, parseRemoteCode(lastCode))) {
            return await connectShiro(lastCode);
          }
          console.error("[shiro-mcp] Offer not ready yet");
        } catch (e: any) {
          if (e instanceof RemoteProtocolError) throw e;
          console.error(`[shiro-mcp] Attempt failed: ${e.message}`);
        }
      }
      throw new Error("Reconnect failed after 5 attempts. Is Shiro still running?");
    }

    case "disconnect":
      lastCode = null; // Clear saved code on explicit disconnect
      return disconnectShiro();

    case "status":
      if (!activeConnection) {
        return { connected: false, lastCode: lastCode ? lastCode.split("#")[0] : undefined };
      }
      return {
        connected: activeConnection.status === "connected",
        // the id part only: the secret stays out of tool results
        code: activeConnection.code.split("#")[0],
        status: activeConnection.status,
        transport: activeConnection.transport
      };

    case "exec": {
      const result: any = await sendCommand({ type: "exec", command: args.command });
      if (consoleErrors.length > 0) {
        result.pendingErrors = consoleErrors.length;
      }
      attachUserMessages(result);
      return result;
    }

    case "errors": {
      const errors = [...consoleErrors];
      const shouldClear = args.clear !== false;
      if (shouldClear) consoleErrors = [];
      return { type: "console_errors", count: errors.length, errors, cleared: shouldClear };
    }

    case "read": {
      const result: any = await sendCommand({ type: "read", path: args.path });
      if (result.content) {
        result.content = Buffer.from(result.content, "base64").toString("utf-8");
      }
      attachUserMessages(result);
      return result;
    }

    case "write": {
      const result: any = await sendCommand({ type: "write", path: args.path, content: Buffer.from(args.content as string).toString("base64") });
      attachUserMessages(result);
      return result;
    }

    case "list": {
      const result: any = await sendCommand({ type: "list", path: args.path });
      attachUserMessages(result);
      return result;
    }

    case "console": {
      const result: any = await sendCommand({ type: "console", grep: args.grep, level: args.level, since: args.since, limit: args.limit, maxBytes: args.maxBytes, previous: args.previous });
      attachUserMessages(result);
      return result;
    }

    case "abort": {
      return await sendCommand({ type: "abort" });
    }

    case "profile": {
      const action = String(args.action || "status");
      if (action === "collect") {
        const p = await collectProfile((req) => sendCommand(req));
        if (!p.meta) return { type: "profile_result", meta: null };
        const out = typeof args.out === "string" ? args.out : "";
        if (out) {
          writeFileSync(out, JSON.stringify(p));
          writeFileSync(`${out}.trace.json`, JSON.stringify(profileToTrace(p)));
          const st: any = await sendCommand({ type: "profile", action: "status" });
          return { type: "profile_result", meta: p.meta, summary: st.summary, out, trace: `${out}.trace.json` };
        }
        return { type: "profile_result", ...p };
      }
      return await sendCommand({ type: "profile", action, durationMs: args.durationMs, sampleMs: args.sampleMs, procGrep: args.procGrep,
        label: args.label, text: args.text, part: args.part, offset: args.offset });
    }

    case "diag": {
      const result: any = await sendCommand({ type: "diag", limit: args.limit, since: args.since, kind: args.kind, previous: args.previous,
        kernel: args.kernel, procGrep: args.procGrep, procLimit: args.procLimit });
      attachUserMessages(result);
      return result;
    }

    case "eval": {
      const result: any = await sendCommand({ type: "eval", code: args.code });
      attachUserMessages(result);
      return result;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleRequest(request: MCPRequest): Promise<MCPResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "shiro", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
        const result = await handleTool(name, args || {});
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
        };
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }
  } catch (error: any) {
    return { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } };
  }
}

// Main
const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  try {
    const request = JSON.parse(line) as MCPRequest;
    const response = await handleRequest(request);
    console.log(JSON.stringify(response));
  } catch (error: any) {
    console.log(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${error.message}` }
    }));
  }
});

process.on("SIGINT", () => { disconnectShiro(); process.exit(0); });
process.on("SIGTERM", () => { disconnectShiro(); process.exit(0); });

console.error("[shiro-mcp] Ready - use 'connect' tool with code from 'remote start' in Shiro");
