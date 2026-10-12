/* Extended attributes on a system whose files have none (issue #107): a list
 * is empty, a get is ENODATA, a set or a remove is ENOTSUP, after the checks
 * Linux makes of the fd, the name and the path. Blink answered ENOSYS, which
 * Python's shutil.copy2 (python3 -m venv) doesn't forgive. Prints one line
 * per call: its result, or the errno's name. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static const char *name(long r) {
  static char b[32];
  if (r >= 0) { snprintf(b, sizeof b, "%ld", r); return b; }
  switch (errno) {
    case ENOSYS: return "ENOSYS";
    case ENOTSUP: return "ENOTSUP";
    case ENODATA: return "ENODATA";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EBADF: return "EBADF";
    case EFAULT: return "EFAULT";
    case ERANGE: return "ERANGE";
    case EINVAL: return "EINVAL";
    case E2BIG: return "E2BIG";
    default: snprintf(b, sizeof b, "errno %d", errno); return b;
  }
}
#define P(what, call) printf("%s %s\n", what, name(call))

int main(void) {
  char buf[256], big[300];
  const char *f = "xattr-probe", *l = "xattr-link", *dl = "xattr-dangling", *no = "xattr-missing";
  int fd = open(f, O_CREAT | O_RDWR | O_TRUNC, 0600), op, bad = 99;
  if (fd < 0) { perror("open"); return 2; }
  if (symlink(f, l) || symlink(no, dl)) { perror("symlink"); return 2; }
  op = open(f, O_PATH);
  memset(big, 'a', sizeof big);
  big[299] = 0;

  P("listxattr", syscall(SYS_listxattr, f, buf, sizeof buf));
  P("listxattr size 0", syscall(SYS_listxattr, f, NULL, 0));
  P("llistxattr", syscall(SYS_llistxattr, l, buf, sizeof buf));
  P("flistxattr", syscall(SYS_flistxattr, fd, buf, sizeof buf));
  P("listxattr dir", syscall(SYS_listxattr, ".", buf, sizeof buf));
  P("getxattr", syscall(SYS_getxattr, f, "user.x", buf, sizeof buf));
  P("lgetxattr", syscall(SYS_lgetxattr, l, "security.selinux", buf, sizeof buf));
  P("fgetxattr", syscall(SYS_fgetxattr, fd, "system.posix_acl_access", buf, sizeof buf));
  P("setxattr", syscall(SYS_setxattr, f, "user.x", "v", 1, 0));
  P("lsetxattr", syscall(SYS_lsetxattr, l, "user.x", "v", 1, 0));
  P("fsetxattr", syscall(SYS_fsetxattr, fd, "user.x", "v", 1, 0));
  P("removexattr", syscall(SYS_removexattr, f, "user.x"));
  P("lremovexattr", syscall(SYS_lremovexattr, l, "user.x"));
  P("fremovexattr", syscall(SYS_fremovexattr, fd, "user.x"));

  P("listxattr missing", syscall(SYS_listxattr, no, buf, sizeof buf));
  P("getxattr missing", syscall(SYS_getxattr, no, "user.x", buf, sizeof buf));
  P("setxattr missing", syscall(SYS_setxattr, no, "user.x", "v", 1, 0));
  P("removexattr missing", syscall(SYS_removexattr, no, "user.x"));
  P("listxattr empty path", syscall(SYS_listxattr, "", buf, sizeof buf));
  P("listxattr under a file", syscall(SYS_listxattr, "xattr-probe/x", buf, sizeof buf));
  P("listxattr dangling", syscall(SYS_listxattr, dl, buf, sizeof buf));
  P("llistxattr dangling", syscall(SYS_llistxattr, dl, buf, sizeof buf));
  P("getxattr dangling", syscall(SYS_getxattr, dl, "user.x", buf, sizeof buf));
  P("lgetxattr dangling", syscall(SYS_lgetxattr, dl, "user.x", buf, sizeof buf));

  P("flistxattr bad fd", syscall(SYS_flistxattr, bad, buf, sizeof buf));
  P("fgetxattr bad fd", syscall(SYS_fgetxattr, bad, "user.x", buf, sizeof buf));
  P("fsetxattr bad fd", syscall(SYS_fsetxattr, bad, "user.x", "v", 1, 0));
  P("fremovexattr bad fd", syscall(SYS_fremovexattr, bad, "user.x"));
  P("flistxattr O_PATH", syscall(SYS_flistxattr, op, buf, sizeof buf));
  P("fgetxattr O_PATH", syscall(SYS_fgetxattr, op, "user.x", buf, sizeof buf));

  P("getxattr empty name", syscall(SYS_getxattr, f, "", buf, sizeof buf));
  P("getxattr long name", syscall(SYS_getxattr, f, big, buf, sizeof buf));
  P("getxattr bad name", syscall(SYS_getxattr, f, (char *)-1, buf, sizeof buf));
  P("setxattr bad flags", syscall(SYS_setxattr, f, "user.x", "v", 1, 4));
  P("setxattr too big", syscall(SYS_setxattr, f, "user.x", "v", 65537, 0));
  P("listxattr null path", syscall(SYS_listxattr, NULL, buf, sizeof buf));

  unlink(l);
  unlink(dl);
  unlink(f);
  return 0;
}
