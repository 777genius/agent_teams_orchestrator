#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  const char *expected[] = {"opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"};
  if (argc != 6) return 2;
  for (int i = 0; i < 6; ++i) if (strcmp(argv[i], expected[i]) != 0) return 3;
  struct stat stat;
  if (fstat(3, &stat) || !S_ISSOCK(stat.st_mode)) return 4;
  if (fcntl(3, F_GETFD) & FD_CLOEXEC) return 5;
  if (fcntl(4, F_GETFD) >= 0 || errno != EBADF) return 6;
  if (write(3, "FD3_OK", 6) != 6) return 7;
#ifdef WAIT_AFTER_MARKER_SECONDS
  sleep(WAIT_AFTER_MARKER_SECONDS);
#endif
  return 0;
}
