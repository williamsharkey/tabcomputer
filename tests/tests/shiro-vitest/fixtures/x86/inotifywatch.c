// A guest watching a directory with inotify (Blink 0517) hears its own
// changes and those made outside it: it blocks in read() until the page
// writes a file (the shell, an editor), as a watcher (vite, tail -f) would.
// An unlinked file still open is heard through its fd (LTP inotify12).
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/inotify.h>
#include <unistd.h>

static void show(int in) {
  char b[4096];
  int n = read(in, b, sizeof(b));
  for (int o = 0; o < n;) {
    struct inotify_event *e = (struct inotify_event *)(b + o);
    printf("mask %x name %s\n", e->mask, e->len ? e->name : "-");
    o += sizeof(*e) + e->len;
  }
  fflush(stdout);
}

int main(void) {
  int in = inotify_init1(0);
  if (inotify_add_watch(in, "watched", IN_CREATE | IN_MODIFY | IN_CLOSE_WRITE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO) < 0) { perror("watch"); return 1; }
  int fd = open("watched/mine", O_CREAT | O_WRONLY, 0644);
  write(fd, "x", 1);
  close(fd);
  show(in);
  rename("watched/mine", "watched/moved");
  show(in);
  printf("waiting\n");
  fflush(stdout);
  show(in);  // the page writes watched/outside
  fd = open("watched/moved", O_WRONLY);
  unlink("watched/moved");
  write(fd, "y", 1);
  show(in);
  close(fd);
  return 0;
}
