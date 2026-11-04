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
int main(void) {
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
  assert(dup2(seed, 5) == 5); close(seed);
  int image = image_fd, process = process_fd;
  image_path = strdup("TEST-only-owned-image"); assert(image_path);
  close_launch_resources(listener);
  require_closed(listener); require_closed(image); require_closed(process); require_closed(5);
  assert(image_fd == -1 && process_fd == -1 && image_path == NULL);
  assert(descriptor_count() == before);
  puts("TEST native helper finite failure paths passed"); return 0;
}
