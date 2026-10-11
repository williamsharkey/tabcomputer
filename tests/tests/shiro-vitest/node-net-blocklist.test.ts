import { describe, it, expect } from 'vitest';
import { createNetModule } from '@shiro/node-compat/modules/net-tls';

// net.BlockList / net.SocketAddress (server.mjs's TCP relay filters use
// BlockList.addSubnet; tabcomputer's node had only auto-stubs for them)
const net = createNetModule();
const code = (f: () => unknown) => { try { f(); return 'no error'; } catch (e: any) { return e.code ?? e.name; } };

describe('net.BlockList', () => {
  it('matches addresses, ranges and subnets as in Node\'s documentation', () => {
    const b = new net.BlockList();
    b.addAddress('123.123.123.123');
    b.addRange('10.0.0.1', '10.0.0.10');
    b.addSubnet('8592:757c:efae:4e45::', 64, 'ipv6');
    expect(['123.123.123.123', '10.0.0.3', '222.111.111.222'].map((a) => b.check(a))).toEqual([true, true, false]);
    // IPv4 rules match the IPv4-mapped IPv6 form
    expect(b.check('::ffff:7b7b:7b7b', 'ipv6')).toBe(true);
    expect(b.check('::ffff:123.123.123.123', 'ipv6')).toBe(true);
    expect(b.check('8592:757c:efae:4e45:1::1', 'ipv6')).toBe(true);
    expect(b.check('8592:757c:efae:4e46::1', 'ipv6')).toBe(false);
    expect(b.rules).toEqual(['Subnet: IPv6 8592:757c:efae:4e45::/64', 'Range: IPv4 10.0.0.1-10.0.0.10', 'Address: IPv4 123.123.123.123']);
  });

  it('filters as server.mjs\'s relay lists need (kernel-net.test.ts\'s addresses)', () => {
    const V4: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
    const V6: [string, number][] = [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]];
    const b4 = new net.BlockList(), b6 = new net.BlockList();
    for (const [a, p] of V4) b4.addSubnet(a, p, 'ipv4');
    for (const [a, p] of V6) b6.addSubnet(a, p, 'ipv6');
    const blocked = (ip: string) => (net.isIP(ip) === 6 ? b6.check(ip, 'ipv6') : b4.check(ip, 'ipv4'));
    const open = ['8.8.8.8', '93.184.215.14', '172.66.147.243', '2606:4700::1111'];
    const closed = ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '64:ff9b::808:808', 'fd00:ec2::254'];
    expect(open.map(blocked)).toEqual(open.map(() => false));
    expect(closed.map(blocked)).toEqual(closed.map(() => true));
    // and why it keeps two lists: Node matches IPv4 against ::ffff:0:0/96
    const shared = new net.BlockList();
    shared.addSubnet('::ffff:0:0', 96, 'ipv6');
    expect(shared.check('8.8.8.8', 'ipv4')).toBe(true);
  });

  it('parses IPv6 in its forms, and edge prefixes', () => {
    for (const a of ['::', '::1', '1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:1.2.3.4', '::ffff:1.2.3.4', 'fe80::1%eth0', 'FE80::A']) {
      const l = new net.BlockList();
      l.addAddress(a, 'ipv6');
      expect(l.check(a, 'ipv6'), a).toBe(true);
    }
    const l = new net.BlockList();
    l.addSubnet('1.2.3.4', 32);
    l.addSubnet('2001:db8::', 32, 'ipv6');
    expect([l.check('1.2.3.4'), l.check('1.2.3.5'), l.check('2001:db8::1', 'ipv6'), l.check('2001:db9::1', 'ipv6')]).toEqual([true, false, true, false]);
    // ::/0 covers IPv4 too, through the mapped form (as Node v26 does)
    const all = new net.BlockList();
    all.addSubnet('::', 0, 'ipv6');
    expect([all.check('1.2.3.5'), all.check('::ffff:1.2.3.5', 'ipv6'), all.check('2001:db8::1', 'ipv6')]).toEqual([true, true, true]);
  });

  it('checks arguments as Node does', () => {
    const b = new net.BlockList();
    expect(code(() => b.addSubnet('10.0.0.0', 33))).toBe('ERR_OUT_OF_RANGE');
    expect(code(() => b.addSubnet('::', 129, 'ipv6'))).toBe('ERR_OUT_OF_RANGE');
    expect(code(() => b.addAddress('x'))).toBe('ERR_INVALID_ARG_VALUE');
    expect(code(() => b.addAddress('1.2.3.4', 'ipv5'))).toBe('ERR_INVALID_ARG_VALUE');
    expect(code(() => b.addRange('10.0.0.9', '10.0.0.1'))).toBe('ERR_INVALID_ARG_VALUE');
    expect(code(() => b.check(42 as any))).toBe('ERR_INVALID_ARG_TYPE');
    // a string that isn't an address (or a bad family) is no match, not an error
    b.addSubnet('0.0.0.0', 0);
    expect(['nope', '1.2.3.4.5', '256.1.1.1', '01.2.3.4'].map((a) => b.check(a))).toEqual([false, false, false, false]);
    expect(b.check('1.2.3.4', 'ipv5')).toBe(false);
    expect(net.BlockList.isBlockList(b)).toBe(true);
    expect(net.BlockList.isBlockList({})).toBe(false);
  });
});

describe('net.SocketAddress', () => {
  it('holds an address, port, family and flow label; BlockList takes it', () => {
    const sa = new net.SocketAddress({ address: '::1', family: 'ipv6', port: 443 });
    expect([sa.address, sa.port, sa.family, sa.flowlabel]).toEqual(['::1', 443, 'ipv6', 0]);
    expect(new net.SocketAddress().toJSON()).toEqual({ address: '127.0.0.1', port: 0, family: 'ipv4', flowlabel: 0 });
    expect(code(() => new net.SocketAddress({ address: 'x' }))).toBe('ERR_INVALID_ARG_VALUE');
    expect(code(() => new net.SocketAddress({ port: 70000 }))).toBe('ERR_OUT_OF_RANGE');
    const b = new net.BlockList();
    b.addAddress(sa);
    expect([b.check(new net.SocketAddress({ address: '::1', family: 'ipv6' })), b.check('::1', 'ipv6'), b.check('::2', 'ipv6')]).toEqual([true, true, false]);
  });

  it('parses host:port', () => {
    expect(net.SocketAddress.parse('1.2.3.4:80')?.toJSON()).toEqual({ address: '1.2.3.4', port: 80, family: 'ipv4', flowlabel: 0 });
    expect(net.SocketAddress.parse('[::1]:8080')?.port).toBe(8080);
    expect(net.SocketAddress.parse('nope:1')).toBeUndefined();
    expect(net.SocketAddress.parse('1.2.3.4:99999')).toBeUndefined();
  });
});
