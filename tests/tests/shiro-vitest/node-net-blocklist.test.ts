/**
 * node-compat's net.BlockList against node's own, rule for rule (native Claude
 * Code's bundle builds one at load time: `addSubnet("127.0.0.0", 8, "ipv4")`).
 */
import { describe, it, expect } from 'vitest';
import { BlockList } from '@shiro/node-compat/modules/net-tls';

// The real module (the test config polyfills node:net for the browser code)
const realNet = (process as any).getBuiltinModule('net');

describe('net.BlockList', () => {
  const build = (B: any) => {
    const b = new B();
    b.addSubnet('127.0.0.0', 8, 'ipv4');
    b.addAddress('::1', 'ipv6');
    b.addAddress('10.1.2.3');
    b.addRange('192.168.0.10', '192.168.0.20', 'ipv4');
    b.addSubnet('fd00::', 8, 'ipv6');
    return b;
  };
  const probes: [string, string][] = [
    ['127.0.0.1', 'ipv4'], ['127.255.255.254', 'ipv4'], ['128.0.0.1', 'ipv4'], ['10.1.2.3', 'ipv4'], ['10.1.2.4', 'ipv4'],
    ['192.168.0.10', 'ipv4'], ['192.168.0.15', 'ipv4'], ['192.168.0.21', 'ipv4'],
    ['::1', 'ipv6'], ['::2', 'ipv6'], ['fd12::1', 'ipv6'], ['fe80::1', 'ipv6'],
    ['::ffff:127.0.0.1', 'ipv6'], ['::ffff:10.1.2.3', 'ipv6'], ['::ffff:8.8.8.8', 'ipv6'],
    ['not-an-ip', 'ipv4'], ['::1', 'IPv6'],
  ];

  it('answers check() as node does, IPv4-mapped IPv6 included', () => {
    const ours = build(BlockList), theirs = build(realNet.BlockList);
    for (const [a, f] of probes) expect(ours.check(a, f), `${a} ${f}`).toBe(theirs.check(a, f));
  });

  it('lists its rules as node does, newest first', () => {
    expect(build(BlockList).rules).toEqual(build(realNet.BlockList).rules);
  });

  it('refuses what node refuses', () => {
    const b = new BlockList();
    expect(() => b.addSubnet('127.0.0.0', 33, 'ipv4')).toThrow();
    expect(() => b.addAddress('300.1.1.1', 'ipv4')).toThrow();
    expect(() => b.addRange('10.0.0.9', '10.0.0.1', 'ipv4')).toThrow();
    expect(() => b.addAddress('1.2.3.4', 'ipx')).toThrow();
  });
});
