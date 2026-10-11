// pidfds: pidfd_open, PIDFD_GET_INFO (the pid; the wait status once it
// has been reaped, if asked for, else ESRCH), pidfd_send_signal, poll
// readable at exit, waitid(P_PIDFD), and ENOTTY for PIDFD_GET_INFO on
// another kind of fd (LTP ioctl_pidfd01; tokio waits on pidfds).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

struct info {
  uint64_t mask, cgroupid;
  uint32_t pid, tgid, ppid, ruid, rgid, euid, egid, suid, sgid, fsuid, fsgid;
  int32_t exit_code;
  uint32_t coredump_mask, spare;
};
#define GET_INFO _IOWR(0xFF, 11, struct info)

int main(void) {
  struct info in;
  siginfo_t si;
  pid_t p = fork();
  if (!p) {
    pause();
    exit(3);
  }
  int fd = syscall(SYS_pidfd_open, p, 0);
  memset(&in, 0, sizeof(in));
  in.mask = 8;
  int r = ioctl(fd, GET_INFO, &in);
  printf("running %d pid %d ppid %d ", r, in.pid == (uint32_t)p, in.ppid == (uint32_t)getpid());
  struct pollfd pf = {fd, POLLIN, 0};
  printf("poll %d ", poll(&pf, 1, 0));
  printf("signal %d ", (int)syscall(SYS_pidfd_send_signal, fd, SIGTERM, 0, 0));
  pf.revents = 0;
  printf("poll %d ", poll(&pf, 1, 5000));
  memset(&in, 0, sizeof(in));
  in.mask = 8;
  r = ioctl(fd, GET_INFO, &in);
  printf("exited %d exit %d status %d\n", r, !!(in.mask & 8), WTERMSIG(in.exit_code));
  memset(&si, 0, sizeof(si));
  r = waitid(P_PIDFD, fd, &si, WEXITED);
  printf("waitid %d pid %d code %d ", r, si.si_pid == p, si.si_code == CLD_KILLED);
  memset(&in, 0, sizeof(in));
  r = ioctl(fd, GET_INFO, &in);
  printf("reaped no mask %d %d ", r, errno);
  memset(&in, 0, sizeof(in));
  in.mask = 8;
  r = ioctl(fd, GET_INFO, &in);
  printf("reaped %d exit %d status %d ", r, !!(in.mask & 8), WTERMSIG(in.exit_code));
  int file = open("/proc/self/exe", O_RDONLY);
  r = ioctl(file, GET_INFO, &in);
  printf("file %d %d\n", r, errno);
  return 0;
}
