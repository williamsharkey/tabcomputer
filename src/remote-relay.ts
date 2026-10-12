/**
 * `remote start`: the code, the signaling it seals, and the HTTPS relay
 * transport for peers that can't do WebRTC (a cloud container behind an
 * HTTPS-only proxy: no UDP, no STUN).
 *
 * The code has two parts, `<id>#<secret>` (protocol 3):
 *   - the id (`fluffy-cloud-shimutako`) is the rendezvous: it is what the
 *     server is given, in POST /offer and in the /offer/:id and /answer/:id
 *     paths. It is not a secret;
 *   - the secret (130 random bits, base32) never leaves the two ends. It keys
 *     everything: the offer and the answer are AES-GCM sealed with a key
 *     derived from it before they are posted (so the server can neither read
 *     the SDP nor swap in DTLS fingerprints of its own to sit in the middle of
 *     the WebRTC connection), and so is every relay message.
 * The separator is `#` on purpose: a client from before protocol 3 builds
 * `/offer/<code>` as a URL, and a URL's fragment is never sent, so even an
 * old client cannot hand the secret to the server.
 *
 * Why two parts and not a PAKE over a short code: the code travels by
 * clipboard, not by voice, so it can carry enough entropy that the sealed
 * offer is not guessable offline; a PAKE (SPAKE2, OPAQUE) would need curve
 * arithmetic WebCrypto doesn't offer, in three clients, and one more round
 * trip through the server.
 *
 * Signaling (server.mjs createSignaling; every body says `v: 3`):
 *   POST /offer            {v, id, sealed, relay?: {id}}   the tab registers
 *   GET  /offer/:id?v=3    {v, sealed, relay?}             the peer fetches
 *   POST /answer/:id       {v, sealed}                     the peer answers
 *   GET  /answer/:id       {v, sealed} | {waiting} | {expired}
 * `sealed` opens to {offer, candidates, relay?: {v, id, salt}} or
 * {answer, candidates}. A server or a client from before protocol 3 is
 * refused with RemoteProtocolError: nothing here ever falls back to sending
 * the code.
 *
 * The relay: a tab that can relay names a mailbox in its (sealed) offer; a
 * peer that wants it answers `{type: 'relay', v}` instead of SDP. Both then
 * long-poll the server's mailbox (server.mjs createRemoteRelay) and exchange
 * the same JSON messages the data channel carries, each AES-GCM sealed with
 * a key derived from the secret and the offer's salt (HKDF-SHA256; the salt
 * is new for every offer, so a tab never accepts an earlier offer's
 * messages). The additional data binds direction and sequence number, so
 * the server (or anyone who learns the mailbox id) can't forge, reflect or
 * replay messages.
 *
 * v2 envelopes: each channel also has a random epoch, sealed into every
 * message, so a peer that reconnects to the same mailbox (shiro-mcp restarted
 * while the tab stayed up) starts a new sequence the tab accepts. Epochs
 * already seen stay closed.
 *
 * This file has no imports and is copied verbatim to shiro-mcp/src/relay.ts
 * (remote-relay.test.ts checks they match). Needs fetch and WebCrypto
 * (globalThis.crypto.subtle).
 */

export type RelaySide = 'tab' | 'peer';

/** A relay mailbox, named by the tab in its (sealed) offer */
export interface RelayInfo { v: 1 | 2; id: string; salt: string }

export const RELAY_WAIT_MS = 25_000;
/** The other side hasn't polled for this long: it's gone */
export const RELAY_PEER_GONE_MS = 60_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh mailbox id and salt for an offer. */
export function newRelayInfo(): RelayInfo {
  return { v: 2, id: hex(crypto.getRandomValues(new Uint8Array(16))), salt: b64(crypto.getRandomValues(new Uint8Array(16))) };
}

/** The key relay messages are sealed with: from the code's secret and the offer's salt. */
export async function relayKey(secret: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: enc.encode('tabcomputer-remote-relay-v3') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ── The code and the sealed signaling (protocol 3) ──

export const REMOTE_PROTOCOL = 3;

/** A remote code's two parts: what the server is told, and what it never is */
export interface RemoteCode { id: string; secret: string }

/** This end and the other don't speak the same remote protocol. Never answered by sending the code. */
export class RemoteProtocolError extends Error {
  constructor(message: string) { super(message); this.name = 'RemoteProtocolError'; }
}

const CODE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/;
const CODE_SECRET_RE = /^[a-z2-7]{26,64}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A fresh secret part: 130 random bits as 26 base32 characters. */
export function newRemoteSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(17));
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5 && out.length < 26) { out += B32[(acc >> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function formatRemoteCode(id: string, secret: string): string { return `${id}#${secret}`; }

/** Split a code into its parts. Throws RemoteProtocolError for a code from before protocol 3 (no secret part). */
export function parseRemoteCode(code: string): RemoteCode {
  const text = String(code ?? '').trim();
  const at = text.indexOf('#');
  if (at < 0) {
    throw new RemoteProtocolError(CODE_ID_RE.test(text)
      ? 'This remote code has no secret part: it comes from an older tabcomputer, whose codes the server could read. Reload that tab and run `remote start` again; the new code looks like words#letters.'
      : 'Not a remote code (expected words#letters, as `remote start` copies it).');
  }
  const id = text.slice(0, at), secret = text.slice(at + 1);
  if (!CODE_ID_RE.test(id) || id.length > 80 || !CODE_SECRET_RE.test(secret)) throw new RemoteProtocolError('Not a remote code (expected words#letters, as `remote start` copies it). Quote it in a shell: the # must arrive.');
  return { id, secret };
}

async function signalKey(code: RemoteCode): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(code.secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tabcomputer-remote-signal-v3'), info: enc.encode(code.id) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Seal an offer or an answer for the server to hold: base64(iv || ciphertext), bound to its kind and the id. */
export async function sealSignal(code: RemoteCode, kind: 'offer' | 'answer', value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${kind}:${code.id}`) }, await signalKey(code), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

/** Open what sealSignal made; throws when it wasn't sealed with this code's secret (or was altered). */
export async function openSignal(code: RemoteCode, kind: 'offer' | 'answer', sealed: string): Promise<any> {
  try {
    const raw = unb64(sealed);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(`${kind}:${code.id}`) }, await signalKey(code), raw.subarray(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    throw new Error(`the ${kind} does not open with this code's secret part (a mistyped code, or it was altered on the way)`);
  }
}

const OLD_SERVER = 'This signaling server speaks an older remote protocol, which needs the whole code. The code was not sent to it; the server has to be updated first.';
const OLD_PEER = 'This server no longer takes remote codes it could read (remote protocol 3). Reload the tab, or update shiro-mcp (git pull, npm run build), and use a new code.';
const jsonHeaders = { 'Content-Type': 'application/json' };
type Fetch = typeof fetch;

async function refusal(res: Response): Promise<never> {
  const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
  if (res.status === 426 || body?.error === 'upgrade_required') throw new RemoteProtocolError(body?.message || OLD_PEER);
  // A server from before protocol 3 wants {code, offer} / {answer}
  if (res.status === 400 && /Missing code or offer/i.test(body?.error || '')) throw new RemoteProtocolError(OLD_SERVER);
  throw new Error(`Signaling server error: ${res.status}`);
}

export interface OfferPayload { offer: unknown; candidates: unknown[]; relay?: RelayInfo | null }
export interface AnswerPayload { answer: any; candidates: unknown[] }

/** The tab: register an offer under the code's id. The server gets the id and a sealed blob (and the mailbox id to open). */
export async function registerOffer(base: string, code: RemoteCode, payload: OfferPayload, f: Fetch = (...a) => fetch(...a)): Promise<void> {
  const relay = payload.relay ? { v: payload.relay.v, id: payload.relay.id, salt: payload.relay.salt } : null;
  const sealed = await sealSignal(code, 'offer', { offer: payload.offer, candidates: payload.candidates, ...(relay ? { relay } : {}) });
  const res = await f(`${base}/offer`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ v: REMOTE_PROTOCOL, id: code.id, sealed, ...(relay ? { relay: { id: relay.id } } : {}) }),
  });
  if (!res.ok) await refusal(res);
  const body = await res.json().catch(() => null) as { v?: number } | null;
  // An old server answers {ok: true} to anything with a code; it never got one, but say so
  if (body?.v !== REMOTE_PROTOCOL) throw new RemoteProtocolError(OLD_SERVER);
}

/** The peer: fetch and open the offer registered under the code's id; null when there is none. */
export async function fetchOffer(base: string, code: RemoteCode, f: Fetch = (...a) => fetch(...a)): Promise<OfferPayload | null> {
  const res = await f(`${base}/offer/${code.id}?v=${REMOTE_PROTOCOL}`);
  if (res.status === 404) return null;
  if (!res.ok) await refusal(res);
  const body = await res.json() as { v?: number; sealed?: unknown };
  if (body.v !== REMOTE_PROTOCOL || typeof body.sealed !== 'string') throw new RemoteProtocolError(OLD_SERVER);
  const opened = await openSignal(code, 'offer', body.sealed);
  return { offer: opened.offer, candidates: opened.candidates || [], relay: opened.relay || null };
}

/** The peer: answer (SDP, or {type: 'relay', v}), sealed. */
export async function sendAnswer(base: string, code: RemoteCode, payload: AnswerPayload, f: Fetch = (...a) => fetch(...a)): Promise<void> {
  const sealed = await sealSignal(code, 'answer', payload);
  const res = await f(`${base}/answer/${code.id}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ v: REMOTE_PROTOCOL, sealed }) });
  if (!res.ok) await refusal(res);
}

/**
 * The tab: poll for the answer. `bad` is an answer that doesn't open with the
 * secret (someone who knows only the id, or a peer with a mistyped code).
 */
export async function fetchAnswer(base: string, code: RemoteCode, f: Fetch = (...a) => fetch(...a)): Promise<{ waiting: true } | { expired: true } | { bad: string } | AnswerPayload> {
  const res = await f(`${base}/answer/${code.id}?v=${REMOTE_PROTOCOL}`);
  if (res.status === 404) return { expired: true };
  if (!res.ok) await refusal(res);
  const body = await res.json() as { v?: number; sealed?: unknown; waiting?: boolean; expired?: boolean; answer?: unknown };
  if (body.expired) return { expired: true };
  if (body.waiting) return { waiting: true };
  if (body.v !== REMOTE_PROTOCOL || typeof body.sealed !== 'string') throw new RemoteProtocolError(OLD_SERVER);
  try {
    const opened = await openSignal(code, 'answer', body.sealed);
    return { answer: opened.answer, candidates: opened.candidates || [] };
  } catch (e: any) { return { bad: e?.message || 'unreadable answer' }; }
}

/** What a message's additional data binds: direction, epoch (v2) and sequence */
const aad = (from: RelaySide, epoch: string, seq: number) => enc.encode(epoch ? `${from}:${epoch}:${seq}` : `${from}:${seq}`);

/** Seal one message sent by `from`: "seq.base64(iv || ciphertext)", or "epoch:seq.…" (v2). */
export async function sealMessage(key: CryptoKey, from: RelaySide, seq: number, text: string, epoch = ''): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(from, epoch, seq) }, key, enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return `${epoch ? epoch + ':' : ''}${seq}.${b64(out)}`;
}

/**
 * Open a message sent by `from`; throws if it was tampered with, replayed or
 * misdirected. `lastSeq` is the last sequence number taken (per epoch when a
 * function: Infinity closes an epoch).
 */
export async function openMessage(key: CryptoKey, from: RelaySide, envelope: string, lastSeq: number | ((epoch: string) => number)): Promise<{ epoch: string; seq: number; text: string }> {
  const dot = envelope.indexOf('.');
  const head = dot > 0 ? envelope.slice(0, dot) : '';
  const colon = head.indexOf(':');
  const epoch = colon >= 0 ? head.slice(0, colon) : '';
  const seq = Number(colon >= 0 ? head.slice(colon + 1) : head);
  const last = typeof lastSeq === 'function' ? lastSeq(epoch) : lastSeq;
  if (dot < 1 || (colon >= 0 && !/^[0-9a-f]{1,32}$/.test(epoch)) || !Number.isSafeInteger(seq) || seq <= last) throw new Error('relay: bad or replayed sequence');
  const raw = unb64(envelope.slice(dot + 1));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: aad(from, epoch, seq) }, key, raw.subarray(12));
  return { epoch, seq, text: dec.decode(pt) };
}

export interface RelayChannelOptions {
  base: string;             // signaling origin, e.g. https://tabcomputer.com
  info: RelayInfo;
  /** The secret part of the remote code (never the whole code, never sent) */
  secret: string;
  as: RelaySide;
  fetch?: typeof fetch;
  waitMs?: number;
  peerGoneMs?: number;
  log?: (msg: string) => void;
}

/**
 * The relay as a data channel: readyState, send(), close(), onopen,
 * onmessage({data}), onclose. Messages arrive in order; sends are batched.
 */
export class RelayChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  private key: Promise<CryptoKey>;
  private other: RelaySide;
  private sendSeq = 0;
  private recvSeq = 0;
  /** This channel's epoch (v2; '' in v1), and the other side's current and past ones */
  private sendEpoch: string;
  private recvEpoch: string | null = null;
  private closedEpochs = new Set<string>();
  private outbox: Promise<string>[] = [];
  private flushing = false;
  private abort = new AbortController();
  private started = Date.now();
  private peerSeen = false;
  private opts: Required<Omit<RelayChannelOptions, 'log'>> & { log?: (msg: string) => void };

  constructor(opts: RelayChannelOptions) {
    this.opts = { fetch: (...a) => fetch(...a), waitMs: RELAY_WAIT_MS, peerGoneMs: RELAY_PEER_GONE_MS, ...opts };
    this.other = opts.as === 'tab' ? 'peer' : 'tab';
    this.sendEpoch = opts.info.v >= 2 ? hex(crypto.getRandomValues(new Uint8Array(4))) : '';
    this.key = relayKey(opts.secret, opts.info.salt);
    this.key.then(() => {
      if (this.readyState !== 'connecting') return;
      this.readyState = 'open';
      this.onopen?.();
      this.pollLoop();
    }, () => this.close());
  }

  private url(op: 'send' | 'recv', extra = ''): string {
    return `${this.opts.base}/relay/${this.opts.info.id}/${op}?as=${this.opts.as}${extra}`;
  }

  send(text: string): void {
    if (this.readyState !== 'open') throw new Error('relay channel is not open');
    const seq = ++this.sendSeq;
    this.outbox.push(this.key.then((k) => sealMessage(k, this.opts.as, seq, text, this.sendEpoch)));
    if (!this.flushing) this.flush();
  }

  private async flush(): Promise<void> {
    this.flushing = true;
    let failures = 0;
    try {
      while (this.outbox.length && this.readyState === 'open') {
        const batch = this.outbox.splice(0);
        const msgs = await Promise.all(batch);
        for (;;) {
          try {
            const res = await this.opts.fetch(this.url('send'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ msgs }), signal: this.abort.signal,
            });
            if (res.status === 404 || res.status === 410) return this.close();
            if (!res.ok) throw new Error(`relay send ${res.status}`);
            failures = 0;
            break;
          } catch (e: any) {
            if (this.readyState !== 'open') return;
            if (++failures > 8) { this.opts.log?.(`relay send failed: ${e?.message}`); return this.close(); }
            await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** failures, 8000)));
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async pollLoop(): Promise<void> {
    let lastOk = Date.now();
    while (this.readyState === 'open') {
      try {
        const res = await this.opts.fetch(this.url('recv', `&wait=${this.opts.waitMs}`), { signal: this.abort.signal, cache: 'no-store' } as RequestInit);
        if (res.status === 404 || res.status === 410) return this.close();
        if (!res.ok) throw new Error(`relay recv ${res.status}`);
        const { msgs, peerSeenMs } = await res.json() as { msgs: string[]; peerSeenMs: number | null };
        lastOk = Date.now();
        if (peerSeenMs !== null && peerSeenMs < this.opts.peerGoneMs) this.peerSeen = true;
        const gone = peerSeenMs === null
          ? Date.now() - this.started > this.opts.peerGoneMs
          : peerSeenMs > this.opts.peerGoneMs;
        const key = await this.key;
        for (const m of msgs) {
          try {
            const { epoch, seq, text } = await openMessage(key, this.other, m,
              (e) => (e === this.recvEpoch ? this.recvSeq : this.closedEpochs.has(e) ? Infinity : 0));
            // An authentic message from a new epoch: the other side reconnected; its old epoch is closed
            if (epoch !== this.recvEpoch) {
              if (this.recvEpoch !== null) this.closedEpochs.add(this.recvEpoch);
              this.recvEpoch = epoch;
            }
            this.recvSeq = seq;
            if (this.readyState === 'open') this.onmessage?.({ data: text });
          } catch (e: any) {
            this.opts.log?.(`relay: dropped a message (${e?.message || 'failed to open'})`);
          }
        }
        if (gone) return this.close();
      } catch (e: any) {
        if (this.readyState !== 'open') return;
        if (Date.now() - lastOk > this.opts.peerGoneMs) { this.opts.log?.(`relay unreachable: ${e?.message}`); return this.close(); }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** Whether the other side has polled the mailbox yet */
  get connected(): boolean { return this.peerSeen; }

  close(): void {
    if (this.readyState === 'closed' || this.readyState === 'closing') return;
    this.readyState = 'closing';
    this.abort.abort();
    this.readyState = 'closed';
    this.onclose?.();
  }
}
