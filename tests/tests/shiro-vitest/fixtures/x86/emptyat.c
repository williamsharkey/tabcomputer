// An empty path in the *at calls, as Linux 6.x answers: ENOENT unless the
// call takes AT_EMPTY_PATH and it is set, which means dirfd itself (O_PATH
// fds included): fchownat, faccessat2 (which also refuses unknown flags),
// fstatat, statx, utimensat (a NULL path is the fd without the flag).
// fchmodat2 is fchmodat2.c's. The audit after tabcomputer#54.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
static int e(long r) { return r < 0 ? errno : 0; }
int main(void) {
  int fd = open("f", O_RDWR | O_CREAT, 0644), op = open("f", O_PATH), d = open(".", O_RDONLY | O_DIRECTORY);
  struct stat st;
  static char sx[512];
  struct timespec ts[2] = {{1, 0}, {2, 0}};
  printf("fchmodat %d\n", e(syscall(SYS_fchmodat, fd, "", 0600, 0)));
  printf("fchownat %d %d %d\n", e(fchownat(fd, "", -1, -1, AT_EMPTY_PATH)), e(fchownat(op, "", -1, -1, AT_EMPTY_PATH)), e(fchownat(fd, "", -1, -1, 0)));
  printf("faccessat2 %d %d %d %d\n", e(syscall(439, fd, "", R_OK, AT_EMPTY_PATH)), e(syscall(439, op, "", R_OK, AT_EMPTY_PATH)), e(syscall(439, fd, "", R_OK, 0)), e(syscall(439, d, "f", R_OK, AT_EACCESS)));
  printf("faccessat2 badflag %d\n", e(syscall(439, d, "f", R_OK, 0x4)));
  printf("fstatat %d %d %d\n", e(fstatat(fd, "", &st, AT_EMPTY_PATH)), e(fstatat(op, "", &st, AT_EMPTY_PATH)), e(fstatat(fd, "", &st, 0)));
  printf("statx %d %d\n", e(syscall(SYS_statx, op, "", AT_EMPTY_PATH, 0x7ff, sx)), e(syscall(SYS_statx, fd, "", 0, 0x7ff, sx)));
  printf("utimensat null %d empty %d emptyflag %d opath %d\n", e(syscall(SYS_utimensat, fd, 0, ts, 0)), e(syscall(SYS_utimensat, fd, "", ts, 0)), e(syscall(SYS_utimensat, fd, "", ts, AT_EMPTY_PATH)), e(syscall(SYS_utimensat, op, "", ts, AT_EMPTY_PATH)));
  fstat(fd, &st);
  printf("mtime %ld\n", (long)st.st_mtim.tv_sec);
  printf("mknodat %d unlinkat %d mkdirat %d\n", e(mknodat(d, "", S_IFIFO | 0644, 0)), e(unlinkat(d, "", 0)), e(mkdirat(d, "", 0755)));
  printf("readlinkat %d\n", e(readlinkat(fd, "", (char[8]){0}, 8)));
  printf("openat %d\n", e(openat(d, "", O_RDONLY)));
  return 0;
}
