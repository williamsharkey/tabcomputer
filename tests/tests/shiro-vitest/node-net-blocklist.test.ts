/**
 * node-compat's net.BlockList against node's own, rule for rule (native Claude
 * Code's bundle builds one at load time: `addSubnet("127.0.0.0", 8, "ipv4")`).
 */
import { describe, it, expect } from 'vitest';
import { BlockList, SocketAddress, createNetModule } from '@shiro/node-compat/modules/net-tls';

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

// From the earlier unix/tab-net-blocklist branch: IPv6 forms (zone IDs included),
// argument checks and net.SocketAddress, each compared with node's own where it has it

const ourNet = createNetModule({} as any);
/** What a call gives: its JSON, or the error's code */
const outcome = (f: () => unknown) => { try { return 'ok ' + JSON.stringify(f()); } catch (e: any) { return 'throws ' + (e.code ?? e.name); } };

describe('net.BlockList: IPv6 forms, server.mjs relay lists, argument checks', () => {
  it('takes IPv6 in its forms, zone IDs included, and edge prefixes', () => {
    for (const B of [BlockList, realNet.BlockList]) {
      for (const a of ['::', '::1', '1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:1.2.3.4', '::ffff:1.2.3.4', 'fe80::1%eth0', 'FE80::A']) {
        const l = new B();
        l.addAddress(a, 'ipv6');
        expect(l.check(a, 'ipv6'), `${B === BlockList ? 'ours' : 'node'} ${a}`).toBe(true);
      }
    }
    const edges = (B: any) => {
      const l = new B();
      l.addSubnet('1.2.3.4', 32);
      l.addSubnet('2001:db8::', 32, 'ipv6');
      const all = new B();
      all.addSubnet('::', 0, 'ipv6');
      return [l.check('1.2.3.4'), l.check('1.2.3.5'), l.check('2001:db8::1', 'ipv6'), l.check('2001:db9::1', 'ipv6'),
        all.check('1.2.3.5'), all.check('::ffff:1.2.3.5', 'ipv6'), all.check('2001:db8::1', 'ipv6')];
    };
    expect(edges(BlockList)).toEqual(edges(realNet.BlockList));
    expect(ourNet.isIP('fe80::1%eth0')).toBe(realNet.isIP('fe80::1%eth0'));
    expect(ourNet.isIPv6('fe80::1%eth0')).toBe(realNet.isIPv6('fe80::1%eth0'));
  });

  it('filters as server.mjs\'s relay lists need (kernel-net.test.ts\'s addresses)', () => {
    const V4: [string, number][] = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]];
    const V6: [string, number][] = [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]];
    const lists = (B: any) => {
      const b4 = new B(), b6 = new B();
      for (const [a, p] of V4) b4.addSubnet(a, p, 'ipv4');
      for (const [a, p] of V6) b6.addSubnet(a, p, 'ipv6');
      return (ip: string) => (realNet.isIP(ip) === 6 ? b6.check(ip, 'ipv6') : b4.check(ip, 'ipv4'));
    };
    const ours = lists(BlockList), theirs = lists(realNet.BlockList);
    const open = ['8.8.8.8', '93.184.215.14', '172.66.147.243', '2606:4700::1111'];
    const closed = ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '64:ff9b::808:808', 'fd00:ec2::254'];
    expect(open.map(ours)).toEqual(open.map(() => false));
    expect(closed.map(ours)).toEqual(closed.map(() => true));
    for (const ip of [...open, ...closed]) expect(ours(ip), ip).toBe(theirs(ip));
  });

  it('checks its arguments as node does: wrong types throw, a string that is no address is no match', () => {
    const calls: [string, (b: any) => unknown][] = [
      ['addSubnet /33', (b) => b.addSubnet('10.0.0.0', 33)],
      ['addSubnet v6 /129', (b) => b.addSubnet('::', 129, 'ipv6')],
      ['addAddress x', (b) => b.addAddress('x')],
      ['addAddress ipv5', (b) => b.addAddress('1.2.3.4', 'ipv5')],
      ['addRange backwards', (b) => b.addRange('10.0.0.9', '10.0.0.1')],
      ['check(42)', (b) => b.check(42)],
      ['addAddress(42)', (b) => b.addAddress(42)],
      ['check nope', (b) => b.check('nope')],
      ['check 1.2.3.4.5', (b) => b.check('1.2.3.4.5')],
      ['check 256.1.1.1', (b) => b.check('256.1.1.1')],
      ['check 01.2.3.4', (b) => b.check('01.2.3.4')],
      ['check family ipv5', (b) => b.check('1.2.3.4', 'ipv5')],
    ];
    const ours = new BlockList(), theirs = new realNet.BlockList();
    ours.addSubnet('0.0.0.0', 0);
    theirs.addSubnet('0.0.0.0', 0);
    for (const [name, call] of calls) expect(outcome(() => call(ours)), name).toBe(outcome(() => call(theirs)));
    expect(BlockList.isBlockList(ours)).toBe(true);
    expect(BlockList.isBlockList({})).toBe(false);
  });
});

describe('net.SocketAddress', () => {
  const N = realNet.SocketAddress;
  it('holds an address, port, family and flow label, and checks them as node does', () => {
    const sa = new SocketAddress({ address: '::1', family: 'ipv6', port: 443 });
    expect([sa.address, sa.port, sa.family, sa.flowlabel]).toEqual(['::1', 443, 'ipv6', 0]);
    expect(ourNet.SocketAddress).toBe(SocketAddress);
    const cases: any[] = [
      undefined, { address: '::1', family: 'ipv6', port: 443 }, { address: '1.2.3.4', port: 8080 }, { family: 'ipv6' },
      { address: 'x' }, { port: 70000 }, { port: -1 }, { address: '1.2.3.4', family: 'ipv5' }, { address: '::1' },
      { address: 42 }, { flowlabel: -1 },
    ];
    for (const c of cases) {
      expect(outcome(() => new SocketAddress(c).toJSON()), JSON.stringify(c)).toBe(outcome(() => new N(c).toJSON()));
    }
    expect(SocketAddress.isSocketAddress(sa)).toBe(true);
    expect(SocketAddress.isSocketAddress({ address: '::1' })).toBe(false);
  });

  it('is an address BlockList takes', () => {
    const run = (S: any, B: any) => {
      const b = new B();
      b.addAddress(new S({ address: '::1', family: 'ipv6' }));
      return [b.check(new S({ address: '::1', family: 'ipv6' })), b.check('::1', 'ipv6'), b.check('::2', 'ipv6'), b.rules];
    };
    expect(run(SocketAddress, BlockList)).toEqual(run(N, realNet.BlockList));
  });

  it('parses host:port', () => {
    expect(SocketAddress.parse('1.2.3.4:8080')?.toJSON()).toEqual({ address: '1.2.3.4', port: 8080, family: 'ipv4', flowlabel: 0 });
    expect(SocketAddress.parse('[::1]:8080')?.toJSON()).toEqual({ address: '::1', port: 8080, family: 'ipv6', flowlabel: 0 });
    expect(SocketAddress.parse('nope:1')).toBeUndefined();
    expect(SocketAddress.parse('1.2.3.4:99999')).toBeUndefined();
    // node's own, where this node has it (v22.13, v23.4): the same answers, :80 included
    if (typeof N.parse === 'function') {
      for (const s of ['1.2.3.4:8080', '1.2.3.4:80', '1.2.3.4', '[::1]:8080', '[fe80::1]:1', 'nope:1', '1.2.3.4:99999', '[::1', '']) {
        expect(SocketAddress.parse(s)?.toJSON(), s).toEqual(N.parse(s)?.toJSON());
      }
    }
  });
});
