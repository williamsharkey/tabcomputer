/* fchmodat2(fd, "", mode, AT_EMPTY_PATH) is fchmod(fd), O_PATH descriptors
 * included (Linux 6.6+); systemd 257's fchmod_opath() relies on it, and
 * systemd-sysusers in systemd's postinst failed when it was ENOENT. An empty
 * path without AT_EMPTY_PATH is still ENOENT. Prints one line per case. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void report(const char *what, long r, const char *path) {
  struct stat st;
  stat(path, &st);
  printf("%s %s %o\n", what, r == 0 ? "ok" : errno == ENOENT ? "ENOENT" : "error", st.st_mode & 07777);
}

int main(void) {
  const char *p = "fchmodat2-probe";
  int fd = open(p, O_CREAT | O_RDWR | O_TRUNC, 0600);
  if (fd < 0) { perror("open"); return 2; }
  report("fd", syscall(452, fd, "", 0644, AT_EMPTY_PATH), p);
  int op = open(p, O_PATH);
  report("opath", syscall(452, op, "", 0600, AT_EMPTY_PATH), p);
  report("noflag", syscall(452, fd, "", 0644, 0), p);
  report("named", syscall(452, AT_FDCWD, p, 0640, 0), p);
  unlink(p);
  return 0;
}
