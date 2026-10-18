/**
 * Taking a GUI app's snapshot while the app runs on (tabcomputer#142).
 *
 * The engine writes the process's image, the page checks that no X byte moved
 * while it did, and then looks at the descriptors and packs everything, while
 * the process goes on. An X request it sends in that time (a caret's blink) is
 * not in its image. When it was kept with the image's requests anyway, the
 * replay put the server's sequence number ahead of the restored process's, and
 * Xlib aborted at the first event it read ("Unknown sequence number while
 * processing queue"): the restored L3afpad that ended at once with SIGABRT.
 *
 * Here the engine and the X server are stand-ins: the process's image is a
 * few bytes, and the display's session answers with a server that has atoms
 * and a clock. The request the app sends late arrives as the snapshot asks for
 * that session, which is after the check and before the requests are packed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createTestShell } from './helpers';

const late = { hook: null as null | (() => void) };
vi.mock('@shiro/x11/session', () => ({
  getXSession: async () => {
    late.hook?.();
    return { server: { atomNames: () => ['PRIMARY'], time: () => 1234 } };
  },
}));

describe('GUI snapshots: taking one while the app runs on', () => {
  it('keeps only the X requests of the image, with the sequence number they end at, when the app sends more as the snapshot is packed', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { installNet, netStackOf } = await import('@shiro/kernel/net');
    const S = await import('@shiro/gui/snapshot');
    await S.dropAllSnapshots();
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    installNet(kernel);
    const pair = netStackOf(kernel)!.socketpair();
    if (typeof pair === 'number') throw new Error('no socketpair');
    const [guest] = pair;
    // (how the snapshot finds the X connection among the descriptors)
    guest.remote = { family: 1, address: '/tmp/.X11-unix/X0', port: 0 };
    let end!: () => void;
    const proc = kernel.spawn({ path: '/usr/bin/l3afpad', argv: ['l3afpad'], fds: { 3: guest }, run: () => new Promise<number>((r) => { end = () => r(0); }) });
    await new Promise((r) => setTimeout(r, 0));
    proc.data.engineCheckpoint = async () => ({ rc: 0, why: '', image: new Uint8Array([1, 2, 3, 4]).buffer });

    // The display's record of the connection: 3 requests so far (12 bytes), all answered
    const client = { seq: 3, sent: 96, closed: false };
    const rec = { pid: proc.pid, index: 200, chunks: [new Uint8Array(8).fill(1), new Uint8Array(4).fill(2)], bytes: 12, limit: 1 << 20, over: false, connections: 1, client };
    // ... and as the snapshot is finished, the caret blinks: one more request reaches the display
    late.hook = () => {
      late.hook = null;
      rec.chunks.push(new Uint8Array(8).fill(3));
      rec.bytes += 8;
      client.seq += 1;
      client.sent += 32;
    };
    const r = await S.takeSnapshot(kernel, 'l3afpad', proc, rec as never, 'key', { argv: ['l3afpad'], env: {}, cwd: '/home/user', output: null });
    expect(r.why).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(late.hook).toBeNull();   // (the late request did come in while it was taken)
    expect(rec.bytes).toBe(20);

    const stored = await S.loadSnapshot('l3afpad');
    expect(stored).not.toBeNull();
    const requests = new Uint8Array(await S.gunzip(new Uint8Array(stored!.x)));
    // the image's requests, not the one sent after it; the server's sequence number after them
    expect([...requests]).toEqual([...new Uint8Array(8).fill(1), ...new Uint8Array(4).fill(2)]);
    expect(stored!.meta.x.bytes).toBe(12);
    expect(stored!.meta.x.seq).toBe(3);
    expect(stored!.meta.sizes.x).toBe(12);
    expect(stored!.meta.v).toBe(S.VERSION);

    end();
    await proc.wait();
    await S.dropAllSnapshots();
  });
});
