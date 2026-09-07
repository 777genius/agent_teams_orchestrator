#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <poll.h>

static void force_group(int sig) {
  (void)sig;
  kill(-getpid(), SIGKILL);
  _exit(137);
}
static void terminate_group(int sig) {
  signal(sig, SIG_IGN);
  kill(-getpid(), sig);
  signal(SIGALRM, force_group);
  alarm(1);
}

int main(int argc, char **argv) {
  const char *path = getenv("CURSOR_OWNER_SOCKET");
  const char *token = getenv("CURSOR_OWNER_TOKEN");
  if (argc < 2 || !path || !token) return 125;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return 125;
  struct sockaddr_un addr = {0};
  addr.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(addr.sun_path)) return 125;
  strcpy(addr.sun_path, path);
  struct timeval timeout = {3, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) return 125;
  char registration[256];
  int size = snprintf(registration, sizeof(registration), "%s %d %d\n", token, getpid(), getppid());
  if (write(fd, registration, size) != size) return 125;
  // Before GO, still in the native root group: Stop covers even unregistered gates.
  char release[3];
  if (recv(fd, release, sizeof(release), MSG_WAITALL) != 3 || memcmp(release, "GO\n", 3)) return 125;
  unsetenv("CURSOR_OWNER_SOCKET");
  unsetenv("CURSOR_OWNER_TOKEN");
  if (setsid() < 0) return 125;
  signal(SIGTERM, terminate_group);
  signal(SIGINT, terminate_group);
  signal(SIGHUP, terminate_group);
  signal(SIGPIPE, SIG_IGN);
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    close(fd);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);
    execvp(argv[1], &argv[1]);
    _exit(errno == ENOENT ? 127 : 126);
  }
  // Keep the control socket and the group leader alive until command completion.
  int status;
  for (;;) {
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) break;
    if (result < 0 && errno != EINTR) return 125;
    struct pollfd watch = {fd, POLLIN | POLLHUP, 0};
    if (poll(&watch, 1, 50) > 0 && watch.revents) {
      // Owner death is a fail-closed whole-group stop, including TERM-ignoring helpers.
      kill(-getpid(), SIGKILL);
      return 125;
    }
  }
  // The group remains owned while orphan grandchildren are cleaned by the owner.
  if (write(fd, "DONE\n", 5) != 5) { kill(-getpid(), SIGKILL); return 125; }
  // The owner has a 2.2s TERM/KILL budget plus bounded identity scans.
  timeout.tv_sec = 10;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  char completed[5];
  if (recv(fd, completed, sizeof(completed), MSG_WAITALL) != 5 || memcmp(completed, "EXIT\n", 5)) {
    kill(-getpid(), SIGKILL);
    return 125;
  }
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    kill(getpid(), sig);
    return 128 + sig;
  }
  return WEXITSTATUS(status);
}
