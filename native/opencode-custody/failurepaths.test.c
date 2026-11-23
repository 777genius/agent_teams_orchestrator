/* Finite pure-helper regressions. No native child, vendor, provider or PID action. */
#define main opencode_custody_entry
#include "linux.c"
#undef main
#include <assert.h>
#include <sys/time.h>

static volatile sig_atomic_t interruptions;
static void interrupt_wait(int signal_number) { (void)signal_number; interruptions++; }
static long long monotonic_ms(void) {
  struct timespec now; assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return now.tv_sec * 1000LL + now.tv_nsec / 1000000LL;
}
static void require_closed(int fd) { errno = 0; assert(fcntl(fd, F_GETFD) == -1 && errno == EBADF); }
static int descriptor_count(void) {
  DIR *directory = opendir("/proc/self/fd"); assert(directory);
  int count = 0; struct dirent *entry;
  while ((entry = readdir(directory))) if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) count++;
  closedir(directory); return count;
}
static void malformed(const unsigned char *body, unsigned size) {
  int channel[2]; assert(pipe2(channel, O_CLOEXEC) == 0);
  uint32_t length = htonl(size);
  assert(full_write(channel[1], &length, 4) && full_write(channel[1], body, size)); close(channel[1]);
  assert(read_fields(channel[0], CONTROL_LIMIT) == 0); close(channel[0]);
  for (unsigned i = 0; i < MAX_FIELDS; i++) assert(fields[i] == NULL);
}
/* Execute the real helper's child path with deterministic adversarial FD
 * allocations. This ELF re-execs itself; no provider or external process. */
static void exercise_fd_layout(unsigned layout) {
  int report[2]; assert(pipe2(report, O_CLOEXEC) == 0);
  pid_t child = fork(); assert(child >= 0);
  if (child == 0) {
    int error_write = fcntl(report[1], F_DUPFD_CLOEXEC, 50);
    if (error_write < 50) _exit(113);
    close(report[0]); close(report[1]);
    for (int fd = 3; fd < 32; fd++) close(fd);
    int output = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (output != 3 || dup2(output, 4) != 4) _exit(114);
    int listener = -1;
    if (layout == 0) { /* Image owns 5; originally closed before fexecve. */
      image_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      if (image_fd != 5 || listener != 6) _exit(115);
    } else if (layout == 1) { /* Listener owns 5. */
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      image_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
      if (listener != 5 || image_fd != 6) _exit(116);
    } else if (layout == 2) { /* Exec-error pipe owns 5. */
      if (dup2(error_write, 5) != 5 || fcntl(5, F_SETFD, FD_CLOEXEC)) _exit(117);
      close(error_write); error_write = 5;
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      image_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
      if (listener != 6 || image_fd != 7) _exit(118);
    } else if (layout == 3) { /* /dev/null stdin allocation reuses 5. */
      int vacancy = open("/dev/null", O_RDONLY | O_CLOEXEC);
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      image_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
      if (vacancy != 5 || listener != 6 || image_fd != 7) _exit(119);
      close(vacancy);
    } else if (layout == 4) { /* The inherited receipt owns 5. */
      int receipt = open("/dev/null", O_WRONLY | O_CLOEXEC);
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      image_fd = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
      if (receipt != 5 || listener != 6 || image_fd != 7) _exit(120);
    } else { /* Failed exec still reports errno over FD 5. */
      if (dup2(error_write, 5) != 5 || fcntl(5, F_SETFD, FD_CLOEXEC)) _exit(122);
      close(error_write); error_write = 5;
      listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
      image_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
      if (listener != 6 || image_fd != 7) _exit(123);
    }
    char *const argv[] = { "/proc/self/exe", "--fd-exec-probe", NULL };
    char *const env[] = { "PATH=/usr/bin:/bin", NULL };
    exec_private_child(listener, -1, error_write, "/", argv, env);
  }
  close(report[1]);
  int exec_errno = 0;
  ssize_t received = read(report[0], &exec_errno, sizeof(exec_errno));
  close(report[0]);
  int status = 0; assert(waitpid(child, &status, 0) == child);
  if (layout == 5) {
    assert(received == (ssize_t)sizeof(exec_errno) && (exec_errno == EACCES || exec_errno == ENOEXEC));
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 112);
  } else {
    assert(received == 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }
}

/* Actual measure transport may inherit fd 3 but no fd 4. Preserve the
 * ignored stderr contract without allowing the listener to take fd 4. */
static void exercise_missing_stderr_channel(int measurement) {
  pid_t child = fork(); assert(child >= 0);
  if (child == 0) {
    for (int fd = 3; fd < 32; fd++) close(fd);
    if (open("/dev/null", O_WRONLY | O_CLOEXEC) != 3) _exit(124);
    prepare_launch_channels(measurement);
    if (!measurement) _exit(125); /* A real launch must fail closed. */
    int flags = fcntl(4, F_GETFD);
    if (flags < 0 || !(flags & FD_CLOEXEC)) _exit(126);
    int listener = open("/dev/null", O_RDONLY | O_CLOEXEC);
    int image = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    if (listener != 5 || image != 6 || inherited_fd5 != -1) _exit(127);
    _exit(0);
  }
  int status = 0; assert(waitpid(child, &status, 0) == child);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == (measurement ? 0 : 112));
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--fd-exec-probe") == 0) {
    // The native image never receives the helper's transport, receipt or
    // executable descriptors; only standard streams survive exec.
    for (int fd = 3; fd < 64; fd++) { errno = 0; if (fcntl(fd, F_GETFD) != -1 || errno != EBADF) return 121; }
    return 0;
  }
  for (unsigned layout = 0; layout < 6; layout++) exercise_fd_layout(layout);
  exercise_missing_stderr_channel(1);
  exercise_missing_stderr_channel(0);
  int before = descriptor_count();
  // A valid allocated first field followed by truncated length, overflow or NUL.
  const unsigned char truncated[] = {0, 0, 0, 3, 'o', 'n', 'e', 0, 0};
  const unsigned char overflow[] = {0, 0, 0, 3, 'o', 'n', 'e', 0, 0, 0, 9, 'x'};
  const unsigned char nul[] = {0, 0, 0, 3, 'o', 'n', 'e', 0, 0, 0, 2, 0, 'x'};
  for (unsigned i = 0; i < 1000; i++) {
    malformed(truncated, sizeof(truncated)); malformed(overflow, sizeof(overflow)); malformed(nul, sizeof(nul));
  }
  unsigned char excess[(MAX_FIELDS + 1) * 4] = {0}; malformed(excess, sizeof(excess));
  int channel[2];
  assert(pipe2(channel, O_CLOEXEC) == 0); close(channel[1]);
  assert(await_exec_result(channel[0], 40) == 1); require_closed(channel[0]);
  assert(pipe2(channel, O_CLOEXEC) == 0);
  const unsigned char failure = 1; assert(full_write(channel[1], &failure, 1)); close(channel[1]);
  assert(await_exec_result(channel[0], 40) == 0); require_closed(channel[0]);
  assert(pipe2(channel, O_CLOEXEC) == 0);
  long long start = monotonic_ms();
  assert(await_exec_result(channel[0], 40) == 0);
  assert(monotonic_ms() - start >= 35 && monotonic_ms() - start < 500);
  require_closed(channel[0]); close(channel[1]);
  // Repeated EINTR may not restart the absolute deadline or leak its pipe FD.
  struct sigaction handler = {0}; handler.sa_handler = interrupt_wait;
  sigemptyset(&handler.sa_mask); assert(sigaction(SIGALRM, &handler, NULL) == 0);
  struct itimerval timer = { .it_interval = { .tv_usec = 5000 }, .it_value = { .tv_usec = 5000 } };
  assert(pipe2(channel, O_CLOEXEC) == 0); assert(setitimer(ITIMER_REAL, &timer, NULL) == 0);
  start = monotonic_ms(); assert(await_exec_result(channel[0], 40) == 0);
  long long elapsed = monotonic_ms() - start;
  struct itimerval stopped = {0}; assert(setitimer(ITIMER_REAL, &stopped, NULL) == 0);
  assert(interruptions > 0 && elapsed >= 35 && elapsed < 500);
  require_closed(channel[0]); close(channel[1]);
  assert(descriptor_count() == before);
  // Terminal resource closure releases only this fixture's explicitly owned FDs.
  int seed = open("/dev/null", O_RDONLY | O_CLOEXEC); assert(seed >= 0);
  int listener = fcntl(seed, F_DUPFD_CLOEXEC, 10); assert(listener >= 10);
  image_fd = fcntl(seed, F_DUPFD_CLOEXEC, 10); assert(image_fd >= 10);
  process_fd = fcntl(seed, F_DUPFD_CLOEXEC, 10); assert(process_fd >= 10);
  assert(dup2(seed, 5) == 5); close(seed); inherited_fd5 = 5;
  int image = image_fd, process = process_fd;
  image_path = strdup("TEST-only-owned-image"); assert(image_path);
  close_launch_resources(listener);
  require_closed(listener); require_closed(image); require_closed(process); require_closed(5);
  assert(image_fd == -1 && process_fd == -1 && image_path == NULL);
  assert(descriptor_count() == before);
  puts("TEST native helper finite failure paths passed"); return 0;
}
