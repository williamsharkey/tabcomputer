/**
 * The getaddrinfo that pkg's WASI programs link (scripts/pkgbuild/compat/wasi-sock.c),
 * compiled natively: its address logic is plain C over the standard headers, with
 * the kernel's resolve call stubbed. tabcomputer#64: a NULL node with no family
 * answered :: before 0.0.0.0, so python's http.server (built without IPv6, taking
 * the first answer) failed with "bind(): bad family".
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../../scripts/pkgbuild/compat/wasi-sock.c');

/** service_port … freeaddrinfo: the address part of the shim, as it ships */
function addrinfoPart(): string {
  const c = readFileSync(SRC, 'utf8');
  const start = c.indexOf('static int service_port(');
  const end = c.indexOf('const char *gai_strerror(');
  if (start < 0 || end < start) throw new Error('wasi-sock.c: service_port … gai_strerror not found');
  return c.slice(start, end);
}

const HARNESS = (part: string) => `#define _GNU_SOURCE
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
typedef struct { uint8_t bytes[18]; } wasix_addr_ip;
/* The kernel's resolver (src/wasi/wasi-guest.ts resolveHost): v6.test has both families, v6 first */
static int32_t __shiro_resolve(const char *host, uint32_t len, int32_t port, wasix_addr_ip *addrs, uint32_t n, uint32_t *count) {
  (void)port; (void)n;
  *count = 0;
  if (len != 7 || memcmp(host, "v6.test", 7)) return ENOENT;
  memset(addrs, 0, 2 * sizeof *addrs);
  addrs[0].bytes[0] = 2; addrs[0].bytes[2 + 15] = 7;                       /* ::7 */
  addrs[1].bytes[0] = 1; addrs[1].bytes[2] = 10; addrs[1].bytes[5] = 7;    /* 10.0.0.7 */
  *count = 2;
  return 0;
}
#define getaddrinfo shiro_getaddrinfo
#define freeaddrinfo shiro_freeaddrinfo
${part}
static void show(const char *label, const char *node, int family, int flags) {
  struct addrinfo hints = { 0 }, *res = 0;
  hints.ai_family = family; hints.ai_flags = flags; hints.ai_socktype = SOCK_STREAM;
  int e = shiro_getaddrinfo(node, "8000", &hints, &res);
  printf("%s:", label);
  if (e) { printf(" error\\n"); return; }
  for (struct addrinfo *a = res; a; a = a->ai_next) {
    char buf[64];
    const void *ip = a->ai_family == AF_INET6 ? (const void *)&((struct sockaddr_in6 *)a->ai_addr)->sin6_addr : (const void *)&((struct sockaddr_in *)a->ai_addr)->sin_addr;
    inet_ntop(a->ai_family, ip, buf, sizeof buf);
    printf(" %s", buf);
  }
  printf("\\n");
  shiro_freeaddrinfo(res);
}
int main(void) {
  show("passive", NULL, AF_UNSPEC, AI_PASSIVE);
  show("loopback", NULL, AF_UNSPEC, 0);
  show("passive-inet", NULL, AF_INET, AI_PASSIVE);
  show("passive-inet6", NULL, AF_INET6, AI_PASSIVE);
  show("numeric", "127.0.0.1", AF_UNSPEC, 0);
  show("numeric6-as-inet", "::1", AF_INET, 0);
  show("resolved", "v6.test", AF_UNSPEC, 0);
  show("resolved-inet", "v6.test", AF_INET, 0);
  show("resolved-inet6", "v6.test", AF_INET6, 0);
  return 0;
}
`;

// Compiled at load, so skipIf knows whether a compiler was found (as agent-shell.test.ts)
let out = '';
let haveCc = false;
{
  const dir = mkdtempSync(path.join(tmpdir(), 'shiro-gai-'));
  const c = path.join(dir, 'gai.c'), exe = path.join(dir, 'gai');
  writeFileSync(c, HARNESS(addrinfoPart()));
  for (const cc of ['cc', 'gcc', 'clang']) {
    try {
      execFileSync(cc, ['-O1', '-w', '-o', exe, c], { stdio: 'pipe', timeout: 120_000 });
      haveCc = true;
      break;
    } catch { /* not this compiler */ }
  }
  if (haveCc) out = execFileSync(exe, { encoding: 'utf8', timeout: 30_000 });
}

describe('compat getaddrinfo (wasi-sock.c, #64)', () => {
  const line = (label: string) => out.split('\n').find((l) => l.startsWith(label + ':'))?.slice(label.length + 1).trim();

  it.skipIf(!haveCc)('a NULL node with no family: IPv4 first (passive 0.0.0.0, else 127.0.0.1)', () => {
    expect(line('passive')).toBe('0.0.0.0 ::');
    expect(line('loopback')).toBe('127.0.0.1 ::1');
  });

  it.skipIf(!haveCc)("the hints' family is honored", () => {
    expect(line('passive-inet')).toBe('0.0.0.0');
    expect(line('passive-inet6')).toBe('::');
    expect(line('numeric')).toBe('127.0.0.1');
    expect(line('numeric6-as-inet')).toBe('error');
    expect(line('resolved-inet')).toBe('10.0.0.7');
    expect(line('resolved-inet6')).toBe('::7');
  });

  it.skipIf(!haveCc)("a resolved name keeps the resolver's order", () => {
    expect(line('resolved')).toBe('::7 10.0.0.7');
  });
});
