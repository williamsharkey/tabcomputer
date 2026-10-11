/**
 * Remote relay transport: `remote start` over HTTPS for peers that can't do
 * WebRTC (a cloud container behind an HTTPS-only proxy: no UDP, no STUN).
 *
 * Negotiation: a tab that can relay names a mailbox in its offer
 * (`relay: {v: 1, id, salt}`); a peer that wants the relay posts
 * `{answer: {type: 'relay', v: 1}}` to /answer/:code instead of SDP. Both then
 * long-poll the server's mailbox (server.mjs createRemoteRelay) and exchange
 * the same JSON messages the data channel carries.
 *
 * Authentication is the remote code: the mailbox id is only in the offer
 * (fetched by code), and every message is AES-GCM sealed with a key derived
 * from the code (HKDF-SHA256, the offer's salt). The additional data binds
 * direction and sequence number, so the server (or anyone who learns the
 * mailbox id) can't forge, reflect or replay messages.
 *
 * v2 (the offer says which): each channel also has a random epoch, sealed into
 * every message, so a peer that reconnects to the same mailbox (shiro-mcp
 * restarted while the tab stayed up) starts a new sequence the tab accepts,
 * where v1 dropped all its messages as replays and the tab never noticed the
 * old peer had gone (the new one kept the mailbox alive). Epochs already
 * seen stay closed.
 *
 * This file has no imports and is copied verbatim to shiro-mcp/src/relay.ts
 * (remote-relay.test.ts checks they match). Needs fetch and WebCrypto
 * (globalThis.crypto.subtle).
 */

export type RelaySide = 'tab' | 'peer';

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

export async function relayKey(code: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(salt), info: enc.encode('tabcomputer-remote-relay-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
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
  code: string;
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
    this.key = relayKey(opts.code, opts.info.salt);
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
