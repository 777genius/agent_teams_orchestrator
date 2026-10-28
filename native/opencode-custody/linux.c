#define _GNU_SOURCE
/* One retained native child, one image, no PID-based action interface. */
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define LIMIT 256000U
#define CONTROL_LIMIT 16384U
#define MAX_FIELDS 1536U
static unsigned char packet[LIMIT + 1];
static char *fields[MAX_FIELDS];
static pid_t native_pid = -1;
static int process_fd = -1, image_fd = -1, dead = 0;
static int native_status = 0;
static int root_exited = 0;
static struct stat image_stat;
static char native_birth[32], epoch[65];
static char *image_path;
static char boot_id[40];

static void fail(void) { _exit(112); }
static int full_read(int fd, void *data, size_t n) {
  unsigned char *p = data;
  while (n) { ssize_t k = read(fd, p, n); if (k <= 0) return 0; p += k; n -= (size_t)k; }
  return 1;
}
static int full_write(int fd, const void *data, size_t n) {
  const unsigned char *p = data;
  while (n) { ssize_t k = write(fd, p, n); if (k <= 0) return 0; p += k; n -= (size_t)k; }
  return 1;
}
static unsigned read_fields(int fd, unsigned ceiling) {
  uint32_t length;
  if (!full_read(fd, &length, 4)) return 0;
  unsigned n = ntohl(length);
  if (!n || n > ceiling || !full_read(fd, packet, n)) return 0;
  unsigned count = 0, offset = 0;
  while (offset < n) {
    if (count == MAX_FIELDS || offset + 4 > n) return 0;
    uint32_t encoded; memcpy(&encoded, packet + offset, 4); offset += 4;
    unsigned size = ntohl(encoded);
    if (size > n - offset || memchr(packet + offset, 0, size)) return 0;
    /* Move fields into independent buffers: a terminator must not overwrite the next length. */
    fields[count] = malloc((size_t)size + 1);
    if (!fields[count]) fail();
    memcpy(fields[count], packet + offset, size); fields[count][size] = 0;
    count++; offset += size;
  }
  return count;
}
static void free_fields(unsigned count) { for (unsigned i = 0; i < count; i++) free(fields[i]); }
static int reply(int fd, const char *data) {
  uint32_t n = htonl((uint32_t)strlen(data));
  return full_write(fd, &n, 4) && full_write(fd, data, strlen(data));
}
static unsigned long long number(const char *s) {
  if (!*s || strlen(s) > 20) fail();
  char *end; errno = 0; unsigned long long value = strtoull(s, &end, 10);
  if (errno || *end || *s == '-' || *s == '+') fail();
  return value;
}
static int birth(pid_t pid, char out[32]) {
  char file[64], buffer[4096]; snprintf(file, sizeof(file), "/proc/%d/stat", pid);
  int fd = open(file, O_RDONLY | O_CLOEXEC); if (fd < 0) return 0;
  ssize_t n = read(fd, buffer, sizeof(buffer) - 1); close(fd);
  if (n <= 0 || n == (ssize_t)sizeof(buffer) - 1) return 0;
  buffer[n] = 0; char *p = strrchr(buffer, ')'); if (!p || p[1] != ' ') return 0;
  p += 2;
  for (unsigned field = 3; field < 22; field++) { p = strchr(p, ' '); if (!p) return 0; p++; }
  char *end = strchr(p, ' '); if (!end || end - p <= 0 || end - p >= 32) return 0;
  memcpy(out, p, (size_t)(end - p)); out[end - p] = 0; return 1;
}
static int same_object(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size;
}
static int executable_object(pid_t pid, const struct stat *expected) {
  char file[64]; struct stat current;
  snprintf(file, sizeof(file), "/proc/%d/exe", pid);
  return stat(file, &current) == 0 && same_object(&current, expected);
}
static int image_safe(const struct stat *s) {
  return S_ISREG(s->st_mode) && s->st_uid == getuid() && s->st_nlink == 1 && (s->st_mode & 0777) == 0500;
}
/* All descendants of this one creation reparent to this subreaper. Each action
 * uses a held pidfd while the original direct child is still unreaped. */
static int drain_descendants(void) {
  struct timespec start; if (clock_gettime(CLOCK_MONOTONIC, &start)) return 0;
  for (;;) {
    char file[96], bytes[32768]; snprintf(file, sizeof(file), "/proc/self/task/%d/children", getpid());
    int fd = open(file, O_RDONLY | O_CLOEXEC); if (fd < 0) return 0;
    ssize_t n = read(fd, bytes, sizeof(bytes) - 1); close(fd);
    if (n < 0 || n == (ssize_t)sizeof(bytes) - 1) return 0;
    bytes[n] = 0; char *p = bytes; unsigned count = 0;
    while (*p) {
      while (*p == ' ' || *p == '\n') p++;
      if (!*p) break;
      char *end; long candidate = strtol(p, &end, 10);
      if (end == p || candidate <= 0 || candidate > 2147483647L || ++count > 4096) return 0;
      p = end;
      int held = (int)syscall(SYS_pidfd_open, (pid_t)candidate, 0);
      if (held < 0) return 0;
      if (syscall(SYS_pidfd_send_signal, held, SIGKILL, NULL, 0) < 0 && errno != ESRCH) { close(held); return 0; }
      close(held);
      int status; pid_t reaped = waitpid((pid_t)candidate, &status, WNOHANG);
      if (reaped < 0) return 0;
    }
    if (!count) return 1;
    struct timespec now; if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec - start.tv_sec >= 3) return 0;
    struct timespec pause = { .tv_nsec = 10000000 }; nanosleep(&pause, NULL);
  }
}
static int observe_exit(void) {
  if (dead) return 1;
  if (!root_exited) {
    int status; pid_t result = waitpid(native_pid, &status, WNOHANG);
    if (result == native_pid) { root_exited = 1; native_status = status; }
  }
  if (root_exited && drain_descendants()) {
    dead = 1;
    char receipt[256];
    int length = snprintf(receipt, sizeof(receipt), "{\"protocol\":1,\"epoch\":\"%s\",\"pid\":%d,\"birth\":\"%s\",\"status\":%d}\n", epoch, native_pid, native_birth, native_status);
    if (length > 0 && length < (int)sizeof(receipt)) {
      (void)full_write(5, receipt, (size_t)length); (void)fsync(5);
    }
  }
  return dead;
}
static int verify_child(void) {
  char current[32]; struct stat image, named;
  return !observe_exit() && !root_exited && fstat(image_fd, &image) == 0 && image_safe(&image) &&
    lstat(image_path, &named) == 0 && image_safe(&named) && same_object(&named, &image_stat) &&
    same_object(&image, &image_stat) && birth(native_pid, current) &&
    !strcmp(current, native_birth) && executable_object(native_pid, &image_stat);
}
static int wait_exit(unsigned milliseconds) {
  struct pollfd item = { .fd = process_fd, .events = POLLIN };
  if (poll(&item, 1, (int)milliseconds) < 0 && errno != EINTR) return 0;
  return observe_exit();
}
static int stop_exact(void) {
  if (observe_exit()) return 1;
  if (!verify_child()) return 0;
  if (syscall(SYS_pidfd_send_signal, process_fd, SIGTERM, NULL, 0) < 0 && errno != ESRCH) return 0;
  if (wait_exit(750)) return 1;
  if (syscall(SYS_pidfd_send_signal, process_fd, SIGKILL, NULL, 0) < 0 && errno != ESRCH) return 0;
  return wait_exit(2500);
}
static unsigned socket_inodes(unsigned long long *out, int *descriptors) {
  char directory[64]; snprintf(directory, sizeof(directory), "/proc/%d/fd", native_pid);
  DIR *dir = opendir(directory); if (!dir) return 0;
  unsigned count = 0, seen = 0; struct dirent *entry;
  while ((entry = readdir(dir))) {
    if (++seen > 4096) { count = 0; break; }
    char file[320], target[96]; snprintf(file, sizeof(file), "%s/%s", directory, entry->d_name);
    ssize_t n = readlink(file, target, sizeof(target) - 1); if (n < 0) continue;
    target[n] = 0; unsigned long long inode; char tail;
    if (sscanf(target, "socket:[%llu]%c", &inode, &tail) == 1) {
      char *end; long descriptor = strtol(entry->d_name, &end, 10);
      if (*end || descriptor < 0 || descriptor > 2147483647L) { count = 0; break; }
      out[count] = inode; descriptors[count++] = (int)descriptor;
    }
  }
  closedir(dir); return count;
}
static int owns(unsigned long long inode, const unsigned long long *inodes, unsigned count) {
  for (unsigned i = 0; i < count; i++) if (inodes[i] == inode) return 1;
  return 0;
}
static int deferred_listener(unsigned long long inode, const unsigned long long *inodes, const int *descriptors, unsigned count) {
  for (unsigned i = 0; i < count; i++) if (inodes[i] == inode) {
    int held = (int)syscall(SYS_pidfd_getfd, process_fd, descriptors[i], 0);
    if (held < 0) return 0;
    struct stat object; int seconds = 0; socklen_t size = sizeof(seconds);
    int valid = fstat(held, &object) == 0 && (unsigned long long)object.st_ino == inode &&
      getsockopt(held, IPPROTO_TCP, TCP_DEFER_ACCEPT, &seconds, &size) == 0 && seconds > 0;
    close(held); return valid;
  }
  return 0;
}
/* Both sides use literal IPv4 loopback. Never infer ownership from a port alone. */
static int verify_peer(unsigned client_port, unsigned server_port) {
  if (!verify_child() || !client_port || client_port > 65535 || !server_port || server_port > 65535) return 0;
  unsigned long long inodes[4096]; int descriptors[4096]; unsigned count = socket_inodes(inodes, descriptors);
  if (!count) return 0;
  FILE *file = fopen("/proc/net/tcp", "re"); if (!file) return 0;
  char line[512]; unsigned listeners = 0, owned_listener = 0, peer = 0, deferred = 0, embryonic = 0, lines = 0;
  unsigned long long owned_listener_inode = 0;
  while (fgets(line, sizeof(line), file)) {
    if (++lines > 65536) { listeners = 0; break; }
    unsigned local_ip, local_port, remote_ip, remote_port, state;
    unsigned long long inode;
    if (sscanf(line, " %*u: %x:%x %x:%x %x %*s %*s %*s %*u %*u %llu",
      &local_ip, &local_port, &remote_ip, &remote_port, &state, &inode) != 6) continue;
    if (local_port != server_port) continue;
    if (state == 10) {
      listeners++;
      if (local_ip == 0x0100007f && owns(inode, inodes, count)) {
        owned_listener++;
        owned_listener_inode = inode;
      }
    }
    if (local_ip == 0x0100007f && remote_ip == 0x0100007f && remote_port == client_port &&
        state == 1 && owns(inode, inodes, count)) peer++;
    if (local_ip == 0x0100007f && remote_ip == 0x0100007f && remote_port == client_port && state == 3 && inode == 0) embryonic++;
  }
  fclose(file);
  if (peer == 0 && embryonic == 1 && listeners == 1 && owned_listener == 1)
    deferred = (unsigned)deferred_listener(owned_listener_inode, inodes, descriptors, count);
  /* An IPv6 wildcard listener can also own IPv4 traffic. Refuse ambiguity. */
  file = fopen("/proc/net/tcp6", "re");
  if (!file) return 0;
  while (fgets(line, sizeof(line), file)) {
    char local[33], remote[33]; unsigned lp, rp, state;
    if (sscanf(line, " %*u: %32[0-9A-Fa-f]:%x %32[0-9A-Fa-f]:%x %x", local, &lp, remote, &rp, &state) == 5 && lp == server_port && state == 10) listeners++;
  }
  fclose(file);
  /* SYN_RECV/inode zero is admitted only with a held duplicate of the exact
   * owned listener proving TCP_DEFER_ACCEPT. Unknown/denied socket duplication
   * never widens this to arbitrary zero-inode or SYN rows. */
  return listeners == 1 && owned_listener == 1 &&
    ((peer == 1 && embryonic == 0) || (peer == 0 && embryonic == 1 && deferred)) && verify_child();
}
static int control_socket(const char *name, int server) {
  if (strlen(name) != 64 || strspn(name, "0123456789abcdef") != 64) fail();
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  int n = snprintf(address.sun_path + 1, sizeof(address.sun_path) - 1, "agent-teams-opencode-%s", name);
  if (n < 0 || n >= (int)sizeof(address.sun_path) - 1) fail();
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | (server ? 0 : SOCK_NONBLOCK), 0); if (fd < 0) fail();
  socklen_t size = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + (size_t)n);
  if (server) {
    if (bind(fd, (struct sockaddr *)&address, size)) fail();
  } else {
    if (connect(fd, (struct sockaddr *)&address, size)) {
      if (errno != EINPROGRESS) fail();
      struct pollfd ready = { .fd = fd, .events = POLLOUT };
      int error = 0; socklen_t error_size = sizeof(error);
      if (poll(&ready, 1, 5000) <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &error_size) || error) fail();
    }
    int flags = fcntl(fd, F_GETFL); if (flags < 0 || fcntl(fd, F_SETFL, flags & ~O_NONBLOCK)) fail();
    struct timeval timeout = { .tv_sec = 5 };
    if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout))) fail();
  }
  if (server && listen(fd, 4)) fail();
  return fd;
}
static void hello(void) {
  struct stat image; char started[32], output[320];
  int boot = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
  if (boot < 0) fail();
  ssize_t bytes = read(boot, boot_id, sizeof(boot_id) - 1); close(boot);
  if (bytes != 37 || boot_id[36] != '\n') fail();
  boot_id[36] = 0;
  if (stat("/proc/self/exe", &image) || !birth(getpid(), started)) fail();
  snprintf(output, sizeof(output), "{\"protocol\":1,\"pid\":%d,\"birth\":\"%s\",\"dev\":\"%llu\",\"ino\":\"%llu\",\"bootId\":\"%s\"}",
    getpid(), started, (unsigned long long)image.st_dev, (unsigned long long)image.st_ino, boot_id);
  if (!reply(STDOUT_FILENO, output)) fail();
}
static void launch(unsigned count, int measurement) {
  /* launch, epoch, image, cwd, persistent, dev, ino, argc, argv..., envc, env... */
  if (count < 10 || strlen(fields[1]) != 64) fail();
  memcpy(epoch, fields[1], 65);
  int listener = control_socket(epoch, 1);
  image_fd = open(fields[2], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (image_fd < 0 || fstat(image_fd, &image_stat) || !image_safe(&image_stat) ||
      image_stat.st_dev != (dev_t)number(fields[5]) || image_stat.st_ino != (ino_t)number(fields[6])) fail();
  image_path = strdup(fields[2]); if (!image_path) fail();
  unsigned long long argument_count = number(fields[7]);
  if (!argument_count || argument_count > 256 || argument_count + 9 > count) fail();
  unsigned argc = (unsigned)argument_count;
  unsigned long long environment_count = number(fields[8 + argc]);
  if (environment_count > 1024 || argc + environment_count + 9 != count) fail();
  unsigned envc = (unsigned)environment_count;
  char *argv[257], *env[1025];
  for (unsigned i = 0; i < argc; i++) argv[i] = fields[8 + i];
  argv[argc] = NULL;
  if (strcmp(argv[0], image_path)) fail();
  for (unsigned i = 0; i < envc; i++) env[i] = fields[9 + argc + i];
  env[envc] = NULL;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) fail();
  int exec_error[2]; if (pipe2(exec_error, O_CLOEXEC)) fail();
  native_pid = fork(); if (native_pid < 0) fail();
  if (!native_pid) {
    close(exec_error[0]);
    int input = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (input < 0 || chdir(fields[3]) || dup2(input, 0) < 0 || dup2(3, 1) < 0 || dup2(4, 2) < 0) _exit(112);
    close(input); close(listener); close(3); close(4); close(5);
    fexecve(image_fd, argv, env);
    int failure = errno; (void)full_write(exec_error[1], &failure, sizeof(failure)); _exit(112);
  }
  close(exec_error[1]);
  close(3); close(4);
  process_fd = (int)syscall(SYS_pidfd_open, native_pid, 0);
  if (process_fd < 0) { /* The unreaped original child still owns this number. */ kill(native_pid, SIGKILL); waitpid(native_pid, NULL, 0); fail(); }
  if (!birth(native_pid, native_birth)) { (void)syscall(SYS_pidfd_send_signal, process_fd, SIGKILL, NULL, 0); waitpid(native_pid, NULL, 0); fail(); }
  int failure; ssize_t error_size = read(exec_error[0], &failure, sizeof(failure)); close(exec_error[0]);
  if (error_size != 0) { stop_exact(); fail(); }
  if (measurement) {
    int closed = wait_exit(5000);
    if (!closed) { (void)syscall(SYS_pidfd_send_signal, process_fd, SIGKILL, NULL, 0); closed = wait_exit(2500); }
    char measured[96]; snprintf(measured, sizeof(measured), "{\"protocol\":1,\"closed\":%s,\"status\":%d}", closed ? "true" : "false", native_status);
    if (closed) {
      close(listener); close(process_fd); close(image_fd); free_fields(count);
      if (!reply(STDOUT_FILENO, measured)) fail();
      return;
    }
    (void)reply(STDOUT_FILENO, measured); /* Uncertain probe stays captured below. */
  } else if (!verify_child()) { stop_exact(); fail(); }
  char started[32], output[256]; if (!birth(getpid(), started)) fail();
  snprintf(output, sizeof(output), "{\"protocol\":1,\"pid\":%d,\"birth\":\"%s\",\"custodianPid\":%d,\"custodianBirth\":\"%s\"}", native_pid, native_birth, getpid(), started);
  if (!measurement && !reply(STDOUT_FILENO, output)) { stop_exact(); fail(); }
  int persistent = !measurement && !strcmp(fields[4], "persistent"); free_fields(count);
  struct pollfd ready[2] = {{ .fd = listener, .events = POLLIN }, { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP }};
  while (!observe_exit()) {
    if (poll(ready, 2, 100) < 0 && errno != EINTR) { stop_exact(); break; }
    if (ready[1].fd >= 0 && ready[1].revents) { ready[1].fd = -1; if (!persistent) { stop_exact(); break; } }
    if (!(ready[0].revents & POLLIN)) continue;
    int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC); if (client < 0) continue;
    struct timeval timeout = { .tv_sec = 5 }; setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    struct ucred peer; socklen_t size = sizeof(peer);
    unsigned command = 0;
    if (!getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &size) && peer.uid == getuid()) command = read_fields(client, CONTROL_LIMIT);
    int ok = 0;
    if (command >= 3 && !strcmp(fields[1], epoch) && strlen(fields[2]) == 64 && strspn(fields[2], "0123456789abcdef") == 64) {
      if (!strcmp(fields[0], "peer") && command == 5) ok = verify_peer((unsigned)number(fields[3]), (unsigned)number(fields[4]));
      if (!strcmp(fields[0], "inspect") && command == 3) ok = verify_child();
      if (!strcmp(fields[0], "stop") && command == 3) ok = stop_exact();
    }
    char response[384];
    if (command >= 3 && strlen(fields[2]) == 64 && strspn(fields[2], "0123456789abcdef") == 64) {
      snprintf(response, sizeof(response), "{\"protocol\":1,\"epoch\":\"%s\",\"nonce\":\"%s\",\"pid\":%d,\"birth\":\"%s\",\"ok\":%s}", epoch, fields[2], native_pid, native_birth, ok ? "true" : "false");
      (void)reply(client, response);
    }
    close(client); free_fields(command);
  }
  close(listener); close(process_fd); close(image_fd);
}
static void control(unsigned count) {
  /* control, custodian PID/birth, helper dev/ino, epoch, nonce, action, ... */
  if (count < 8 || count > 10) fail();
  pid_t pid = (pid_t)number(fields[1]);
  int held = (int)syscall(SYS_pidfd_open, pid, 0); if (held < 0) fail();
  struct stat expected = {0}, observed; char name[64], started[32];
  snprintf(name, sizeof(name), "/proc/%d/exe", pid);
  expected.st_dev = (dev_t)number(fields[3]); expected.st_ino = (ino_t)number(fields[4]);
  if (!birth(pid, started) || strcmp(started, fields[2]) || stat(name, &observed) || observed.st_dev != expected.st_dev || observed.st_ino != expected.st_ino) fail();
  int client = control_socket(fields[5], 0);
  struct ucred peer; socklen_t size = sizeof(peer);
  if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.pid != pid || peer.uid != getuid() || !birth(pid, started) || strcmp(started, fields[2])) fail();
  unsigned char encoded[CONTROL_LIMIT]; unsigned length = 0;
  unsigned indexes[5] = {7, 5, 6, 8, 9};
  for (unsigned i = 0; i < count - 5; i++) {
    unsigned n = (unsigned)strlen(fields[indexes[i]]); uint32_t wire = htonl(n);
    if (length + 4 + n > sizeof(encoded)) fail();
    memcpy(encoded + length, &wire, 4); length += 4; memcpy(encoded + length, fields[indexes[i]], n); length += n;
  }
  uint32_t wire = htonl(length);
  if (!full_write(client, &wire, 4) || !full_write(client, encoded, length)) fail();
  uint32_t response; if (!full_read(client, &response, 4)) fail();
  unsigned n = ntohl(response); if (!n || n > CONTROL_LIMIT || !full_read(client, packet, n)) fail();
  packet[n] = 0; if (!reply(STDOUT_FILENO, (char *)packet)) fail();
  close(client); close(held); free_fields(count);
}
int main(void) {
  signal(SIGPIPE, SIG_IGN); hello();
  unsigned count = read_fields(STDIN_FILENO, LIMIT); if (!count) fail();
  if (!strcmp(fields[0], "launch")) launch(count, 0);
  else if (!strcmp(fields[0], "measure")) launch(count, 1);
  else if (!strcmp(fields[0], "control")) control(count);
  else fail();
  return native_pid > 0 && WIFEXITED(native_status) ? WEXITSTATUS(native_status) : 0;
}
