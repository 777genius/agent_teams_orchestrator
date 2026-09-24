#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

#ifndef OPENCODE_PATH
#define OPENCODE_PATH "/usr/local/bin/opencode"
#endif

#define HANDOFF_TIMEOUT_MS 5000
#define NAME_PREFIX "fd3-"
#define NAME_HEX_LENGTH 32

extern char **environ;

static void fail(const char *reason) {
  fprintf(stderr, "hosted-fd3-bootstrap:%s\n", reason);
  _exit(1);
}

static int64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) fail("clock");
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void wait_readable(int fd) {
  const int64_t deadline = monotonic_ms() + HANDOFF_TIMEOUT_MS;
  for (;;) {
    int64_t remaining = deadline - monotonic_ms();
    if (remaining <= 0) fail("timeout");
    struct pollfd target = { .fd = fd, .events = POLLIN };
    int result = poll(&target, 1, remaining > INT_MAX ? INT_MAX : (int)remaining);
    if (result < 0 && errno == EINTR) continue;
    if (result == 0) fail("timeout");
    if (target.revents & POLLIN) return;
    if (result < 0 || (target.revents & (POLLERR | POLLHUP | POLLNVAL))) fail("handoff-unavailable");
  }
}

static void validate_name(const char *name) {
  if (strlen(name) != sizeof(NAME_PREFIX) - 1 + NAME_HEX_LENGTH ||
      strncmp(name, NAME_PREFIX, sizeof(NAME_PREFIX) - 1) != 0) fail("name");
  for (size_t i = sizeof(NAME_PREFIX) - 1; name[i]; ++i) {
    if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) fail("name");
  }
}

static uid_t parse_uid(const char *text) {
  if (!*text) fail("uid");
  for (const char *cursor = text; *cursor; ++cursor) {
    if (*cursor < '0' || *cursor > '9') fail("uid");
  }
  errno = 0;
  char *end = NULL;
  unsigned long parsed = strtoul(text, &end, 10);
  if (errno || *end || parsed > UINT_MAX) fail("uid");
  return (uid_t)parsed;
}

static void verify_sender(int connection, uid_t expected_uid) {
  struct ucred peer;
  socklen_t peer_length = sizeof(peer);
  if (getsockopt(connection, SOL_SOCKET, SO_PEERCRED, &peer, &peer_length) != 0 ||
      peer_length != sizeof(peer) || peer.uid != expected_uid) fail("sender-credential");

  int peer_pidfd = -1;
  socklen_t pidfd_length = sizeof(peer_pidfd);
  if (getsockopt(connection, SOL_SOCKET, SO_PEERPIDFD, &peer_pidfd, &pidfd_length) != 0 ||
      pidfd_length != sizeof(peer_pidfd) || peer_pidfd < 0) fail("sender-pidfd");
  struct pollfd target = { .fd = peer_pidfd, .events = POLLIN };
  int state = poll(&target, 1, 0);
  close(peer_pidfd);
  if (state != 0) fail("sender-exited");
}

static int receive_one_socket(int connection) {
  char marker = 0;
  struct iovec data = { .iov_base = &marker, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int) * 2)] = {0};
  struct msghdr message = {
    .msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control, .msg_controllen = sizeof(control),
  };
  ssize_t count = recvmsg(connection, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
  if (count != 1 || marker != 'F' || (message.msg_flags & (MSG_CTRUNC | MSG_TRUNC))) fail("handoff-frame");
  struct cmsghdr *rights = CMSG_FIRSTHDR(&message);
  if (!rights || rights->cmsg_level != SOL_SOCKET || rights->cmsg_type != SCM_RIGHTS ||
      rights->cmsg_len != CMSG_LEN(sizeof(int)) || CMSG_NXTHDR(&message, rights)) fail("handoff-rights");
  int received;
  memcpy(&received, CMSG_DATA(rights), sizeof(received));
  struct stat stat;
  int type = -1;
  int domain = -1;
  int accepting = -1;
  socklen_t length = sizeof(int);
  struct sockaddr_un remote;
  socklen_t remote_length = sizeof(remote);
  if (received < 0 || fstat(received, &stat) != 0 || !S_ISSOCK(stat.st_mode) ||
      getsockopt(received, SOL_SOCKET, SO_TYPE, &type, &length) != 0 || type != SOCK_STREAM ||
      getsockopt(received, SOL_SOCKET, SO_DOMAIN, &domain, &length) != 0 || domain != AF_UNIX ||
      getsockopt(received, SOL_SOCKET, SO_ACCEPTCONN, &accepting, &length) != 0 || accepting != 0 ||
      getpeername(received, (struct sockaddr *)&remote, &remote_length) != 0 ||
      remote.sun_family != AF_UNIX) fail("handoff-socket");
  return received;
}

static void require_sender_eof(int connection) {
  wait_readable(connection);
  char extra = 0;
  struct iovec data = { .iov_base = &extra, .iov_len = 1 };
  char control[CMSG_SPACE(sizeof(int) * 2)] = {0};
  struct msghdr message = {
    .msg_iov = &data, .msg_iovlen = 1,
    .msg_control = control, .msg_controllen = sizeof(control),
  };
  ssize_t count = recvmsg(connection, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
  /* On SOCK_STREAM, zero means shutdown, never a zero-length record. */
  if (count != 0 || (message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)) ||
      message.msg_controllen != 0 || CMSG_FIRSTHDR(&message) != NULL) {
    fail("handoff-extra-frame");
  }
}

int main(int argc, char **argv) {
  if (argc != 5 || strcmp(argv[1], "--socket-name") != 0 ||
      strcmp(argv[3], "--sender-uid") != 0) fail("arguments");
  validate_name(argv[2]);
  uid_t expected_uid = parse_uid(argv[4]);

  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) fail("listener");
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  memcpy(address.sun_path + 1, argv[2], strlen(argv[2]));
  socklen_t address_length = offsetof(struct sockaddr_un, sun_path) + 1 + strlen(argv[2]);
  if (bind(listener, (struct sockaddr *)&address, address_length) != 0 ||
      listen(listener, 1) != 0) fail("listener");
  wait_readable(listener);
  int connection = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
  close(listener);  /* The abstract name cannot accept a second peer. */
  if (connection < 0) fail("accept");
  verify_sender(connection, expected_uid);
  wait_readable(connection);
  int received = receive_one_socket(connection);
  require_sender_eof(connection);
  close(connection);

  if (received != 3 && dup2(received, 3) != 3) fail("fd3");
  if (received != 3) close(received);
  int flags = fcntl(3, F_GETFD);
  if (flags < 0 || fcntl(3, F_SETFD, flags & ~FD_CLOEXEC) != 0) fail("fd3");
  if (syscall(SYS_close_range, 4U, ~0U, 0U) != 0) fail("close-range");

  char *const command[] = {
    (char *)"opencode", (char *)"serve", (char *)"--hostname", (char *)"0.0.0.0",
    (char *)"--port", (char *)"4096", NULL,
  };
  execve(OPENCODE_PATH, command, environ);
  fail("exec");
}
