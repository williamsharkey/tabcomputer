/**
 * Per-socket SO_SNDBUF / SO_RCVBUF (src/kernel/net.ts KSocket): Linux's
 * semantics, doubled and capped at [rw]mem_max (8 MiB here, so a GL client
 * can queue a frame's 2-8 MB texture upload to glshiro in one write), the
 * FORCE options past the max, and the send buffer used for AF_UNIX writes.
 */
import { describe, it, expect } from 'vitest';
import { NetStack, KSocket, SOCK_STREAM, SOCK_DGRAM, SOL_SOCKET, POLLOUT, EAGAIN } from '@shiro/kernel/net';
import {
  MSG_DONTWAIT, SO_SNDBUF, SO_RCVBUF, SO_SNDBUFFORCE, SO_RCVBUFFORCE, WMEM_MAX, RMEM_MAX,
  SOCK_MIN_SNDBUF, SOCK_MIN_RCVBUF, SOCK_BUF_HARD_MAX, EMSGSIZE,
} from '@shiro/kernel/abi';
import { createTestShell } from './helpers';

const stack = () => { const s = new NetStack(); s.configure({ relayUrl: null, tokenUrl: null }); return s; };

describe('SO_SNDBUF / SO_RCVBUF per socket', () => {
  it('doubles what it is given, within the minimum and [rw]mem_max; FORCE goes past the max', async () => {
    const [a, b] = stack().socketpair(SOCK_STREAM) as [KSocket, KSocket];
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(256 * 1024); // the stack's default
    expect(a.setsockopt(SOL_SOCKET, SO_SNDBUF, 4 << 20)).toBe(0);
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(8 << 20);
    expect(b.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(256 * 1024); // per socket
    a.setsockopt(SOL_SOCKET, SO_SNDBUF, 1);
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(SOCK_MIN_SNDBUF);
    a.setsockopt(SOL_SOCKET, SO_SNDBUF, 1 << 30);
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(WMEM_MAX * 2);
    a.setsockopt(SOL_SOCKET, SO_SNDBUF, -1); // (unsigned: the max)
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(WMEM_MAX * 2);
    a.setsockopt(SOL_SOCKET, SO_SNDBUFFORCE, 1 << 30);
    expect(a.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(SOCK_BUF_HARD_MAX);
    a.setsockopt(SOL_SOCKET, SO_RCVBUF, 1 << 30);
    expect(a.getsockopt(SOL_SOCKET, SO_RCVBUF)).toBe(RMEM_MAX * 2);
    a.setsockopt(SOL_SOCKET, SO_RCVBUFFORCE, 100);
    expect(a.getsockopt(SOL_SOCKET, SO_RCVBUF)).toBe(SOCK_MIN_RCVBUF);
    a.setsockopt(SOL_SOCKET, SO_RCVBUF, 65536);
    expect(a.getsockopt(SOL_SOCKET, SO_RCVBUF)).toBe(131072);
    await a.close(); await b.close();
  });

  it("an AF_UNIX stream's writes queue up to the writer's send buffer: an 8 MB upload in one write", async () => {
    const [a, b] = stack().socketpair(SOCK_STREAM) as [KSocket, KSocket];
    const frame = new Uint8Array(8 << 20);
    // the default: 256 KiB, then EAGAIN
    expect(await a.send(frame, MSG_DONTWAIT)).toBe(256 * 1024);
    expect(a.poll(POLLOUT)).toBe(0);
    expect(await a.send(frame, MSG_DONTWAIT)).toBe(-EAGAIN);
    // a blocked writer wakes when the buffer grows
    const blocked = a.send(new Uint8Array(1000));
    a.setsockopt(SOL_SOCKET, SO_SNDBUF, 4 << 20);
    expect(await blocked).toBe(1000);
    expect(a.poll(POLLOUT)).toBe(POLLOUT);
    // drain, then a whole frame goes in one nonblocking write
    const sink = new Uint8Array(1 << 20);
    let got = 0;
    while (got < 256 * 1024 + 1000) got += await b.recv(sink, 0);
    expect(await a.send(frame, MSG_DONTWAIT)).toBe(frame.length);
    expect(a.poll(POLLOUT)).toBe(0);
    await a.close(); await b.close();
  });

  it('AF_UNIX datagrams: a message larger than the send buffer is EMSGSIZE, one that fits a raised buffer goes', async () => {
    const [a, b] = stack().socketpair(SOCK_DGRAM) as [KSocket, KSocket];
    const big = new Uint8Array(1 << 20);
    expect(await a.send(big, MSG_DONTWAIT)).toBe(-EMSGSIZE);
    a.setsockopt(SOL_SOCKET, SO_SNDBUF, 1 << 20);
    expect(await a.send(big, MSG_DONTWAIT)).toBe(big.length);
    expect(await b.recv(new Uint8Array(big.length), 0)).toBe(big.length);
    await a.close(); await b.close();
  });

  it("accept()ed connections start with the listener's sizes (glshiro's side of an X/GL socket)", async () => {
    const st = stack();
    const l = st.socket(1 /* AF_UNIX */, SOCK_STREAM) as KSocket;
    const noUnix = { resolve: () => -95, exists: async () => false, create: async () => -95 };
    expect(await st.bindUnix(l, { family: 1, address: '\0gl-test', port: 0 }, noUnix as never)).toBe(0);
    l.setsockopt(SOL_SOCKET, SO_SNDBUF, 2 << 20);
    l.setsockopt(SOL_SOCKET, SO_RCVBUF, 1 << 20);
    expect(l.listen(4)).toBe(0);
    const c = st.socket(1, SOCK_STREAM) as KSocket;
    expect(await st.connectUnix(c, { family: 1, address: '\0gl-test', port: 0 }, noUnix as never)).toBe(0);
    const s = await l.accept() as KSocket;
    expect(s.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(4 << 20);
    expect(s.getsockopt(SOL_SOCKET, SO_RCVBUF)).toBe(2 << 20);
    expect(c.getsockopt(SOL_SOCKET, SO_SNDBUF)).toBe(256 * 1024);
    await Promise.all([s.close(), c.close(), l.close()]);
  });

  it('/proc/sys/net/core says the limits', async () => {
    const { fs } = await createTestShell();
    expect(await fs.readFile('/proc/sys/net/core/wmem_max', 'utf8')).toBe(`${WMEM_MAX}\n`);
    expect(await fs.readFile('/proc/sys/net/core/rmem_max', 'utf8')).toBe(`${RMEM_MAX}\n`);
    expect(await fs.readFile('/proc/sys/net/core/wmem_default', 'utf8')).toBe('212992\n');
  });
});
