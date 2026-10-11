/**
 * net.BlockList and net.SocketAddress, as Node has them (server.mjs's TCP
 * relay builds its address filters with BlockList.addSubnet; without these the
 * module's auto-stubs left `new net.BlockList()` with no methods).
 *
 * Every address is a 128-bit number in IPv6 space, an IPv4 one as its
 * IPv4-mapped form (::ffff:a.b.c.d), and every rule a range there. So, as in
 * Node, an IPv4 rule matches the IPv4-mapped IPv6 address too, and an IPv6 rule
 * covering ::ffff:0:0/96 matches IPv4 addresses.
 */

type Family = 'ipv4' | 'ipv6';

const MAPPED = 0xffffn << 32n;
const MAX128 = (1n << 128n) - 1n;

function invalid(name: string, value: unknown): TypeError {
  const e = new TypeError(`The argument '${name}' is invalid. Received ${typeof value === 'string' ? `'${value}'` : String(value)}`);
  (e as any).code = 'ERR_INVALID_ARG_VALUE';
  return e;
}

function outOfRange(name: string, range: string, value: unknown): RangeError {
  const e = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`);
  (e as any).code = 'ERR_OUT_OF_RANGE';
  return e;
}

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(p);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input.replace(/%[^%]*$/, ''); // a zone (fe80::1%eth0) doesn't change the address
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.split('::').length > 2) return null;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = parseV4(v4[1]);
    if (n === null || !(s.endsWith(':' + v4[1]))) return null;
    tail = [Number(n >> 16n), Number(n & 0xffffn)];
    s = s.slice(0, -v4[1].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const a = groups(head), b = rest === undefined ? [] : groups(rest);
  if ([...a, ...b].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const words = [...a, ...b].map((g) => parseInt(g, 16));
  const total = words.length + tail.length;
  if (rest === undefined ? total !== 8 : total > 7) return null;
  // (without '::' total is 8, so nothing is filled in)
  const all = [...a.map((g) => parseInt(g, 16)), ...Array(8 - total).fill(0), ...b.map((g) => parseInt(g, 16)), ...tail];
  let n = 0n;
  for (const w of all) n = (n << 16n) | BigInt(w);
  return n;
}

/** An address of `family` as a 128-bit number (IPv4 mapped into ::ffff:0:0/96), or null. */
export function ipToBig(address: string, family: Family): bigint | null {
  if (family === 'ipv4') {
    const n = parseV4(address);
    return n === null ? null : MAPPED | n;
  }
  return parseV6(address);
}

function familyOf(type: unknown): Family {
  const t = type === undefined ? 'ipv4' : String(type).toLowerCase();
  if (t !== 'ipv4' && t !== 'ipv6') throw invalid('type', type);
  return t;
}

const label = (f: Family) => (f === 'ipv4' ? 'IPv4' : 'IPv6');

export class SocketAddress {
  #address: string;
  #port: number;
  #family: Family;
  #flowlabel: number;
  constructor(options: { address?: string; port?: number; family?: string; flowlabel?: number } = {}) {
    if (options === null || typeof options !== 'object') throw invalid('options', options);
    const family = familyOf(options.family);
    const address = options.address ?? (family === 'ipv4' ? '127.0.0.1' : '::');
    if (typeof address !== 'string' || ipToBig(address, family) === null) throw invalid('options.address', address);
    const port = options.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw outOfRange('options.port', '>= 0 && <= 65535', port);
    const flowlabel = options.flowlabel ?? 0;
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xfffff) throw outOfRange('options.flowlabel', '>= 0 && <= 1048575', flowlabel);
    this.#address = address;
    this.#port = port;
    this.#family = family;
    this.#flowlabel = flowlabel;
  }
  get address() { return this.#address; }
  get port() { return this.#port; }
  get family() { return this.#family; }
  get flowlabel() { return this.#flowlabel; }
  toJSON() { return { address: this.#address, port: this.#port, family: this.#family, flowlabel: this.#flowlabel }; }
  static isSocketAddress(value: unknown): value is SocketAddress { return value instanceof SocketAddress; }
  /** 'host:port' or '[v6]:port' → a SocketAddress, undefined if it doesn't parse */
  static parse(input: string): SocketAddress | undefined {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(String(input)) ?? /^([^:]+)(?::(\d+))?$/.exec(String(input));
    if (!m) return undefined;
    const family: Family = m[1].includes(':') ? 'ipv6' : 'ipv4';
    try { return new SocketAddress({ address: m[1], family, port: m[2] === undefined ? 0 : Number(m[2]) }); } catch { return undefined; }
  }
}

interface Rule { lo: bigint; hi: bigint; text: string }

/** An address argument (a string with `type`, or a SocketAddress) as [its number, its family, as written]. */
function addressArg(name: string, address: unknown, type: unknown): [bigint, Family, string] {
  if (address instanceof SocketAddress) return [ipToBig(address.address, address.family)!, address.family, address.address];
  if (typeof address !== 'string') throw invalid(name, address);
  const family = familyOf(type);
  const n = ipToBig(address, family);
  if (n === null) throw invalid(name, address);
  return [n, family, address];
}

export class BlockList {
  #rules: Rule[] = [];

  addAddress(address: string | SocketAddress, type?: string): void {
    const [n, family, text] = addressArg('address', address, type);
    this.#rules.unshift({ lo: n, hi: n, text: `Address: ${label(family)} ${text}` });
  }

  addRange(start: string | SocketAddress, end: string | SocketAddress, type?: string): void {
    const [lo, f1, t1] = addressArg('start', start, type);
    const [hi, f2, t2] = addressArg('end', end, type);
    if (f1 !== f2) throw invalid('end', end);
    if (lo > hi) throw invalid('start', t1); // (Node: "must come before end")
    this.#rules.unshift({ lo, hi, text: `Range: ${label(f1)} ${t1}-${t2}` });
  }

  addSubnet(net: string | SocketAddress, prefix: number, type?: string): void {
    const [n, family, text] = addressArg('net', net, type);
    const bits = family === 'ipv4' ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw outOfRange('prefix', `>= 0 && <= ${bits}`, prefix);
    const host = BigInt(bits - prefix); // (an IPv4 subnet is a subnet of ::ffff:0:0/96)
    const lo = (n >> host) << host;
    const hi = lo | ((1n << host) - 1n);
    this.#rules.unshift({ lo, hi: hi & MAX128, text: `Subnet: ${label(family)} ${text}/${prefix}` });
  }

  check(address: string | SocketAddress, type?: string): boolean {
    if (!(address instanceof SocketAddress) && typeof address !== 'string') {
      const e = new TypeError(`The "address" argument must be of type string. Received ${typeof address}`);
      (e as any).code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    let n: bigint;
    // As Node: an address (or type) that doesn't parse is no match, not an error
    try { [n] = addressArg('address', address, type); } catch { return false; }
    return this.#rules.some((r) => n >= r.lo && n <= r.hi);
  }

  get rules(): string[] { return this.#rules.map((r) => r.text); }

  static isBlockList(value: unknown): value is BlockList { return value instanceof BlockList; }
}
