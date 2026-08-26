import {
  chmodSync,
  closeSync,
  cpSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs'
import type { BigIntStats } from 'fs'
import { createHash } from 'crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { dlopen, FFIType } from 'bun:ffi'

const repositoryRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
process.chdir(repositoryRoot)
const trustedGitExecutable = '/usr/bin/git'
const trustedBunExecutable = realpathSync(process.execPath)
if (!isAbsolute(trustedBunExecutable)) {
  throw new Error('Hosted actual-owner Bun executable is not absolute')
}
const hostedActualOwnerRequiredInputs = [
  'bun.lock',
  'package.json',
  'tsconfig.json',
  'scripts/build.ts',
  'src/entrypoints/hostedActualOwnerAcceptance.ts',
  'scripts/e2e/hosted-actual-owner/contracts.ts',
  'scripts/e2e/hosted-actual-owner/evidence.ts',
  'scripts/e2e/hosted-actual-owner/owner.ts',
  'scripts/e2e/hosted-actual-owner/process-anchor.ts',
  'scripts/e2e/hosted-actual-owner/secure-files.ts',
] as const
const hostedActualOwnerWrapperRelativePath = 'bin/hosted-actual-owner-acceptance'
const hostedActualOwnerLauncherBasename = 'hostedActualOwnerLauncher'
const hostedActualOwnerLaunchPurpose =
  'agent-teams.hosted-actual-owner-acceptance.launch-descriptor/v1'
const hostedActualOwnerBuildRecipePurpose =
  'agent-teams.hosted-actual-owner-acceptance.build-recipe/v1'
const sanitizedBuildEnvironment = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  TZ: 'UTC',
})
const hostedActualOwnerNativeCompilerArgs = Object.freeze([
  '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-ident',
  '-Wl,--build-id=none', '-s',
])
const publicationLibcPath = '/usr/lib/x86_64-linux-gnu/libc.so.6'

function hostedActualOwnerNativeWrapperSource(
  launcherDirectoryRelativePath: string,
  sourceAuthoritySha256: string,
): string {
  if (!/^dist\/local-cli(?:-dev)?$/.test(launcherDirectoryRelativePath)) {
    throw new Error('Hosted actual-owner native launcher directory is invalid')
  }
  if (!/^[0-9a-f]{64}$/.test(sourceAuthoritySha256)) {
    throw new Error('Hosted actual-owner wrapper source authority is invalid')
  }
  return `#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <linux/close_range.h>
#include <limits.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t child_pid = -1;
static const char wrapper_suffix[] = "/bin/hosted-actual-owner-acceptance";
static const char launcher_directory_relative[] = ${JSON.stringify(launcherDirectoryRelativePath)};
static const char launcher_prefix[] = "hostedActualOwnerLauncher-";
static const char source_authority_sha256[] = ${JSON.stringify(sourceAuthoritySha256)};
static const char *const allowed_environment[] = {
  "HOSTED_ACTUAL_OWNER_E2E_ADMISSION_FILE",
  "HOSTED_ACTUAL_OWNER_E2E_HOSTED_CONTROL_CONFIG",
  "HOSTED_ACTUAL_OWNER_E2E_OPENCODE_EXECUTABLE",
  "HOSTED_ACTUAL_OWNER_E2E_OPENCODE_SHA256",
  "HOSTED_ACTUAL_OWNER_E2E_PRODUCT_ROOT",
  "HOSTED_ACTUAL_OWNER_E2E_PRODUCT_PUBLICATION_TIMEOUT_MS",
  "HOSTED_ACTUAL_OWNER_E2E_CONTROL_SOCKET",
  "HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_FILE",
  "HOSTED_ACTUAL_OWNER_E2E_MARKER",
  "HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST",
  "CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH",
  "OPENCODE_BIN_PATH",
};

static int fail(const char *message) {
  const ssize_t message_written = write(STDERR_FILENO, message, strlen(message));
  const ssize_t newline_written = write(STDERR_FILENO, "\\n", 1);
  (void)message_written;
  (void)newline_written;
  return 1;
}

static char *unique_environment_value(const char *key) {
  const size_t length = strlen(key);
  char *match = NULL;
  for (char **entry = environ; *entry != NULL; entry++) {
    if (strncmp(*entry, key, length) == 0 && (*entry)[length] == '=') {
      if (match != NULL) return (char *)(intptr_t)-1;
      match = *entry;
    }
  }
  return match;
}

static int child_environment(
  char **output, size_t capacity, char *closure_environment, char *manifest_environment,
  char *authority_environment
) {
  size_t count = 0;
  output[count++] = "LANG=C";
  output[count++] = "LC_ALL=C";
  output[count++] = "PATH=/usr/bin:/bin";
  output[count++] = "TZ=UTC";
  output[count++] = closure_environment;
  output[count++] = manifest_environment;
  output[count++] = authority_environment;
  for (size_t index = 0;
       index < sizeof(allowed_environment) / sizeof(allowed_environment[0]); index++) {
    char *value = unique_environment_value(allowed_environment[index]);
    if (value == (char *)(intptr_t)-1 || count + 1 >= capacity) return -1;
    if (value != NULL) output[count++] = value;
  }
  output[count] = NULL;
  return 0;
}

static int same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
    left->st_size == right->st_size && left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
    left->st_mtim.tv_nsec == right->st_mtim.tv_nsec &&
    left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
    left->st_ctim.tv_nsec == right->st_ctim.tv_nsec && left->st_mode == right->st_mode &&
    left->st_nlink == right->st_nlink && left->st_uid == right->st_uid;
}

struct sha256_context {
  uint32_t state[8];
  uint64_t bit_length;
  unsigned char block[64];
  size_t block_length;
};

static uint32_t rotate_right(uint32_t value, unsigned int count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(struct sha256_context *context) {
  static const uint32_t constants[64] = {
    0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
    0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
    0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
    0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
    0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
    0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
    0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
    0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U
  };
  uint32_t words[64];
  for (size_t index = 0; index < 16; index++) {
    const size_t offset = index * 4;
    words[index] = ((uint32_t)context->block[offset] << 24) |
      ((uint32_t)context->block[offset + 1] << 16) |
      ((uint32_t)context->block[offset + 2] << 8) | context->block[offset + 3];
  }
  for (size_t index = 16; index < 64; index++) {
    const uint32_t left = rotate_right(words[index - 15], 7) ^
      rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3);
    const uint32_t right = rotate_right(words[index - 2], 17) ^
      rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + left + words[index - 7] + right;
  }
  uint32_t a=context->state[0], b=context->state[1], c=context->state[2], d=context->state[3];
  uint32_t e=context->state[4], f=context->state[5], g=context->state[6], h=context->state[7];
  for (size_t index = 0; index < 64; index++) {
    const uint32_t sum1 = rotate_right(e,6) ^ rotate_right(e,11) ^ rotate_right(e,25);
    const uint32_t choice = (e & f) ^ ((~e) & g);
    const uint32_t temporary1 = h + sum1 + choice + constants[index] + words[index];
    const uint32_t sum0 = rotate_right(a,2) ^ rotate_right(a,13) ^ rotate_right(a,22);
    const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    const uint32_t temporary2 = sum0 + majority;
    h=g; g=f; f=e; e=d+temporary1; d=c; c=b; b=a; a=temporary1+temporary2;
  }
  context->state[0]+=a; context->state[1]+=b; context->state[2]+=c; context->state[3]+=d;
  context->state[4]+=e; context->state[5]+=f; context->state[6]+=g; context->state[7]+=h;
}

static void sha256_update(
  struct sha256_context *context, const unsigned char *bytes, size_t length
) {
  for (size_t index = 0; index < length; index++) {
    context->block[context->block_length++] = bytes[index];
    if (context->block_length == 64) {
      sha256_transform(context);
      context->bit_length += 512;
      context->block_length = 0;
    }
  }
}

static void sha256_final(struct sha256_context *context, unsigned char output[32]) {
  size_t index = context->block_length;
  context->block[index++] = 0x80;
  if (index > 56) {
    while (index < 64) context->block[index++] = 0;
    sha256_transform(context);
    index = 0;
  }
  while (index < 56) context->block[index++] = 0;
  context->bit_length += (uint64_t)context->block_length * 8U;
  for (size_t offset = 0; offset < 8; offset++) {
    context->block[63 - offset] = (unsigned char)(context->bit_length >> (offset * 8));
  }
  sha256_transform(context);
  for (size_t word = 0; word < 8; word++) {
    output[word * 4] = (unsigned char)(context->state[word] >> 24);
    output[word * 4 + 1] = (unsigned char)(context->state[word] >> 16);
    output[word * 4 + 2] = (unsigned char)(context->state[word] >> 8);
    output[word * 4 + 3] = (unsigned char)context->state[word];
  }
}

static int snapshot_sha256_fd(
  int fd, off_t size, mode_t mode, unsigned char output[32]
) {
  if (lseek(fd, 0, SEEK_SET) != 0) return -1;
  const int snapshot = (int)syscall(
    SYS_memfd_create, "hosted-actual-owner-launcher", MFD_CLOEXEC | MFD_ALLOW_SEALING
  );
  if (snapshot < 0 || fchmod(snapshot, mode) != 0) {
    if (snapshot >= 0) close(snapshot);
    return -1;
  }
  struct sha256_context context = {
    .state = { 0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,
      0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U },
    .bit_length = 0, .block = {0}, .block_length = 0
  };
  unsigned char buffer[65536];
  off_t remaining = size;
  while (remaining > 0) {
    const size_t requested = remaining < (off_t)sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
    const ssize_t count = read(fd, buffer, requested);
    if (count <= 0) { close(snapshot); return -1; }
    sha256_update(&context, buffer, (size_t)count);
    size_t written = 0;
    while (written < (size_t)count) {
      const ssize_t result = write(snapshot, buffer + written, (size_t)count - written);
      if (result <= 0) { close(snapshot); return -1; }
      written += (size_t)result;
    }
    remaining -= count;
  }
  sha256_final(&context, output);
  const int seals = F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE;
  if (fcntl(snapshot, F_ADD_SEALS, seals) != 0 ||
      fcntl(snapshot, F_GET_SEALS) != seals || lseek(snapshot, 0, SEEK_SET) != 0) {
    close(snapshot);
    return -1;
  }
  return snapshot;
}

static int hex_nibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  return -1;
}

static int verified_content_addressed_file(
  const char *path, const unsigned char expected[32]
) {
  const int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return -1;
  struct stat before;
  struct stat after;
  unsigned char actual[32];
  if (fstat(fd, &before) != 0 || !S_ISREG(before.st_mode) || before.st_nlink != 1 ||
      before.st_uid != getuid() || before.st_size <= 0 ||
      (before.st_mode & 0777) != 0555) {
    close(fd);
    return -2;
  }
  const int snapshot = snapshot_sha256_fd(fd, before.st_size, 0555, actual);
  if (snapshot < 0) { close(fd); return -3; }
  if (fstat(fd, &after) != 0 || !same_file(&before, &after)) {
    close(snapshot); close(fd);
    return -4;
  }
  if (memcmp(actual, expected, 32) != 0) {
    close(snapshot); close(fd);
    return -5;
  }
  close(fd);
  return snapshot;
}

static int discover_launcher(
  const char *root, char output[PATH_MAX + 1], unsigned char expected[32]
) {
  char directory[PATH_MAX + 1];
  const int directory_length = snprintf(
    directory, sizeof(directory), "%s/%s", root, launcher_directory_relative
  );
  if (directory_length <= 0 || (size_t)directory_length >= sizeof(directory)) return -1;
  DIR *stream = opendir(directory);
  if (stream == NULL) return -1;
  char selected[sizeof(launcher_prefix) + 64];
  selected[0] = '\\0';
  struct dirent *entry;
  while ((entry = readdir(stream)) != NULL) {
    if (strncmp(entry->d_name, launcher_prefix, sizeof(launcher_prefix) - 1) != 0) continue;
    const char *digest = entry->d_name + sizeof(launcher_prefix) - 1;
    if (strlen(digest) != 64) { closedir(stream); return -1; }
    for (size_t index = 0; index < 64; index++) {
      if (hex_nibble(digest[index]) < 0) { closedir(stream); return -1; }
    }
    if (selected[0] != '\\0') { closedir(stream); return -1; }
    memcpy(selected, entry->d_name, sizeof(selected));
  }
  if (closedir(stream) != 0 || selected[0] == '\\0') return -1;
  const char *digest = selected + sizeof(launcher_prefix) - 1;
  for (size_t index = 0; index < 32; index++) {
    expected[index] = (unsigned char)((hex_nibble(digest[index * 2]) << 4) |
      hex_nibble(digest[index * 2 + 1]));
  }
  const int output_length = snprintf(output, PATH_MAX + 1, "%s/%s", directory, selected);
  return output_length > 0 && output_length <= PATH_MAX ? 0 : -1;
}

static void forward_signal(int signal_number) {
  const pid_t pid = (pid_t)child_pid;
  if (pid > 0) (void)kill(-pid, signal_number);
}

static int reset_child_signals(const sigset_t *original_mask) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0 ||
      sigaction(SIGPIPE, &action, NULL) != 0 ||
      sigprocmask(SIG_SETMASK, original_mask, NULL) != 0) return -1;
  return 0;
}

static int restrict_child_descriptors(int launcher_fd) {
  if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) != 0) return -1;
  return fcntl(launcher_fd, F_SETFD, FD_CLOEXEC) == 0 ? 0 : -1;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--runtime-manifest") != 0 || argv[2][0] != '/') {
    const char usage[] =
      "Usage: hosted-actual-owner-acceptance --runtime-manifest /absolute/path\\n";
    const ssize_t usage_written = write(STDERR_FILENO, usage, sizeof(usage) - 1);
    (void)usage_written;
    return 64;
  }
  char executable[PATH_MAX + 1];
  const ssize_t length = readlink("/proc/self/exe", executable, PATH_MAX);
  if (length <= 0 || length > PATH_MAX) {
    return fail("hosted_actual_owner_launch_wrapper_relocated");
  }
  executable[length] = '\\0';
  const size_t suffix_length = sizeof(wrapper_suffix) - 1;
  if ((size_t)length <= suffix_length ||
      strcmp(executable + length - (ssize_t)suffix_length, wrapper_suffix) != 0) {
    return fail("hosted_actual_owner_launch_wrapper_relocated");
  }
  executable[length - (ssize_t)suffix_length] = '\\0';
  char launcher[PATH_MAX + 1];
  unsigned char launcher_sha256[32];
  if (discover_launcher(executable, launcher, launcher_sha256) != 0) {
    return fail("hosted_actual_owner_launch_launcher_relocated");
  }

  const int launcher_fd = verified_content_addressed_file(launcher, launcher_sha256);
  if (launcher_fd == -3) return fail("hosted_actual_owner_launch_launcher_hash_unavailable");
  if (launcher_fd == -5) return fail("hosted_actual_owner_launch_launcher_hash_mismatch");
  if (launcher_fd < 0) return fail("hosted_actual_owner_launch_launcher_replaced");
  char closure_environment[PATH_MAX + 64];
  const int closure_environment_length = snprintf(
    closure_environment, sizeof(closure_environment),
    "HOSTED_ACTUAL_OWNER_CLOSURE_ROOT=%s", executable
  );
  if (closure_environment_length <= 0 ||
      (size_t)closure_environment_length >= sizeof(closure_environment)) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_wrapper_relocated");
  }
  char manifest_environment[PATH_MAX + 64];
  const int manifest_environment_length = snprintf(
    manifest_environment, sizeof(manifest_environment),
    "HOSTED_ACTUAL_OWNER_RUNTIME_MANIFEST_ARG=%s", argv[2]
  );
  if (manifest_environment_length <= 0 ||
      (size_t)manifest_environment_length >= sizeof(manifest_environment)) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_arguments_invalid");
  }
  char authority_environment[128];
  const int authority_environment_length = snprintf(
    authority_environment, sizeof(authority_environment),
    "HOSTED_ACTUAL_OWNER_WRAPPER_AUTHORITY_SHA256=%s", source_authority_sha256
  );
  if (authority_environment_length <= 0 ||
      (size_t)authority_environment_length >= sizeof(authority_environment)) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_wrapper_authority_invalid");
  }

  char *clean_environment[32];
  if (child_environment(clean_environment,
      sizeof(clean_environment) / sizeof(clean_environment[0]), closure_environment,
      manifest_environment, authority_environment) != 0) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_environment_invalid");
  }

  sigset_t blocked;
  sigset_t original_mask;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGINT);
  sigaddset(&blocked, SIGTERM);
  sigaddset(&blocked, SIGHUP);
  if (sigprocmask(SIG_BLOCK, &blocked, &original_mask) != 0) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_signal_setup_failed");
  }
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGINT, &action, NULL) != 0 ||
      sigaction(SIGTERM, &action, NULL) != 0 ||
      sigaction(SIGHUP, &action, NULL) != 0) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_signal_setup_failed");
  }
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_signal_setup_failed");
  }

  const pid_t parent_pid = getpid();
  const pid_t pid = fork();
  if (pid < 0) {
    close(launcher_fd);
    return fail("hosted_actual_owner_launch_child_failed");
  }
  if (pid == 0) {
    if (setpgid(0, 0) != 0 ||
        prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 ||
        getppid() != parent_pid ||
        reset_child_signals(&original_mask) != 0 ||
        restrict_child_descriptors(launcher_fd) != 0) _exit(70);
    char launcher_fd_path[64];
    const int fd_path_length = snprintf(
      launcher_fd_path, sizeof(launcher_fd_path), "/proc/self/fd/%d", launcher_fd
    );
    if (fd_path_length <= 0 || (size_t)fd_path_length >= sizeof(launcher_fd_path)) _exit(70);
    char *const child_argv[] = {
      launcher_fd_path,
      "--hosted-actual-owner-sealed-protocol=v1",
      NULL,
    };
    execve(launcher_fd_path, child_argv, clean_environment);
    _exit(71);
  }

  (void)setpgid(pid, pid);
  child_pid = (sig_atomic_t)pid;
  close(launcher_fd);
  if (sigprocmask(SIG_SETMASK, &original_mask, NULL) != 0) {
    (void)kill(-pid, SIGKILL);
    (void)waitpid(pid, NULL, 0);
    child_pid = -1;
    return fail("hosted_actual_owner_launch_signal_setup_failed");
  }
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(pid, &status, 0);
  } while (waited < 0 && errno == EINTR);
  child_pid = -1;
  if (waited != pid) return fail("hosted_actual_owner_launch_child_failed");
  if (WIFEXITED(status)) {
    const int exit_status = WEXITSTATUS(status);
    if (exit_status == 70 || exit_status == 71) {
      return fail("hosted_actual_owner_launch_child_failed");
    }
    return exit_status;
  }
  if (WIFSIGNALED(status)) {
    const int signal_number = WTERMSIG(status);
    (void)signal(signal_number, SIG_DFL);
    (void)raise(signal_number);
    return 128 + signal_number;
  }
  return fail("hosted_actual_owner_launch_child_failed");
}
`
}

type SourceInputIdentity = Readonly<{
  path: string
  size: string
  mode: string
  sha256: string
}>

type PortableArtifactIdentity = Readonly<{
  relativePath: string
  size: string
  mode: string
  sha256: string
}>

type FixedArtifactIdentity = Readonly<{
  path: string
  device: string
  inode: string
  size: string
  mtimeNs: string
  ctimeNs: string
  mode: string
  linkCount: string
  uid: string
  sha256: string
}>

type BuildRecipeIdentity = Readonly<{
  canonical: string
  sha256: string
}>

type NativeToolchainIdentity = Readonly<{
  compiler: FixedArtifactIdentity
  programs: readonly FixedArtifactIdentity[]
  headers: readonly FixedArtifactIdentity[]
  staticLinkInputs: readonly FixedArtifactIdentity[]
}>

type HostedActualOwnerBuildInputs = Readonly<{
  sourceInputs: readonly SourceInputIdentity[]
  bun: FixedArtifactIdentity
  nativeToolchain: NativeToolchainIdentity
  wrapper: PortableArtifactIdentity
  inputsSha256: string
}>

type HostedActualOwnerLaunchDescriptor = Readonly<{
  schemaVersion: 1
  purpose: typeof hostedActualOwnerLaunchPurpose
  inputsSha256: string
  buildRecipe: BuildRecipeIdentity
  sourceAuthority: ReturnType<typeof sourceAuthority>
  buildInputs: HostedActualOwnerBuildInputs
  wrapper: PortableArtifactIdentity & Readonly<{ role: 'invoked-trust-anchor' }>
  launcher: Readonly<{
    directoryRelativePath: string
    basenamePrefix: 'hostedActualOwnerLauncher-'
    role: 'content-addressed-runtime'
  }>
  closure: readonly string[]
  sourceInputs: readonly SourceInputIdentity[]
}>

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')
const compileTarget = process.env.BUN_COMPILE_TARGET?.trim() || 'bun'

const supportedCompileTargets = new Set([
  'bun',
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-arm64',
  'bun-linux-x64',
  'bun-windows-arm64',
  'bun-windows-x64',
])

if (!supportedCompileTargets.has(compileTarget)) {
  throw new Error(`Unsupported BUN_COMPILE_TARGET: ${compileTarget}`)
}

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BRIDGE_MODE',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

const productionFeatures = ['HOSTED_CONTROL'] as const
const devFullFeatures = [
  ...fullExperimentalFeatures,
  ...productionFeatures,
] as const

function runCommand(cmd: string[]): string | null {
  let proc: ReturnType<typeof Bun.spawnSync>
  try {
    proc = Bun.spawnSync({
      cmd,
      cwd: repositoryRoot,
      env: sanitizedBuildEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return null
  }

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

function sameOpenFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid
}

function repositoryRelativePath(path: string, root = repositoryRoot): string {
  const absolutePath = resolve(root, path)
  const relation = relative(root, absolutePath)
  if (relation === '' || relation === '..' || relation.startsWith(`..${sep}`) ||
    isAbsolute(relation) || resolve(root, relation) !== absolutePath) {
    throw new Error(`Hosted actual-owner build input escaped the repository: ${path}`)
  }
  return relation.split(sep).join('/')
}

function readStableBytes(path: string, label: string, allowRootOwner = false): {
  bytes: Buffer
  stat: BigIntStats
} {
  const absolutePath = resolve(path)
  const linked = lstatSync(absolutePath, { bigint: true })
  const currentUid = process.getuid?.()
  const ownerTrusted = currentUid === undefined || linked.uid === BigInt(currentUid) ||
    allowRootOwner && linked.uid === 0n
  if (!linked.isFile() || linked.isSymbolicLink() || (linked.mode & 0o022n) !== 0n ||
    !ownerTrusted) {
    throw new Error(`Hosted actual-owner ${label} is not trusted`)
  }
  const fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!sameOpenFile(before, linked)) {
      throw new Error(`Hosted actual-owner ${label} changed before it was read`)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (!sameOpenFile(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new Error(`Hosted actual-owner ${label} changed while it was read`)
    }
    return { bytes, stat: after }
  } finally {
    closeSync(fd)
  }
}

function sourceInputIdentity(path: string, root = repositoryRoot): SourceInputIdentity {
  const relativePath = repositoryRelativePath(path, root)
  const snapshot = readStableBytes(
    resolve(root, relativePath), `source input: ${relativePath}`,
  )
  if (snapshot.bytes.byteLength === 0) {
    throw new Error(`Hosted actual-owner source input is empty: ${relativePath}`)
  }
  return Object.freeze({
    path: relativePath,
    size: snapshot.stat.size.toString(),
    mode: (snapshot.stat.mode & 0o777n).toString(8).padStart(3, '0'),
    sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
  })
}

function readHostedActualOwnerSourceInputs(
  metafilePath: string,
  root = repositoryRoot,
): readonly SourceInputIdentity[] {
  const decoded: unknown = JSON.parse(
    readStableBytes(metafilePath, 'build metafile').bytes.toString('utf8'),
  )
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Hosted actual-owner build metafile is invalid')
  }
  const inputs = Reflect.get(decoded, 'inputs')
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new Error('Hosted actual-owner build metafile inputs are invalid')
  }
  const paths = new Set<string>(hostedActualOwnerRequiredInputs)
  for (const inputPath of Object.keys(inputs)) paths.add(repositoryRelativePath(inputPath, root))
  const sourceInputs = [...paths].sort().map(path => sourceInputIdentity(path, root))
  for (const required of hostedActualOwnerRequiredInputs) {
    if (!sourceInputs.some(input => input.path === required)) {
      throw new Error(`Hosted actual-owner closure omitted required source: ${required}`)
    }
  }
  return Object.freeze(sourceInputs)
}

function assertSourceInputsUnchanged(
  expected: readonly SourceInputIdentity[],
  root = repositoryRoot,
): void {
  const current = expected.map(input => sourceInputIdentity(input.path, root))
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error('Hosted actual-owner source inputs changed during build')
  }
}

function gitCommitForSourceInputs(inputs: readonly SourceInputIdentity[]): string | null {
  const topLevel = runCommand([
    trustedGitExecutable, '-C', repositoryRoot, 'rev-parse', '--show-toplevel',
  ])
  const commit = runCommand([
    trustedGitExecutable, '-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD^{commit}',
  ])
  if (!topLevel || realpathSync(topLevel) !== repositoryRoot ||
    !commit || !/^[0-9a-f]{40}$/.test(commit)) return null
  const trackedInputs = inputs.filter(input => !input.path.startsWith('node_modules/'))
  const status = Bun.spawnSync({
    cmd: [
      trustedGitExecutable, '-C', repositoryRoot, 'status', '--porcelain=v1',
      '--untracked-files=all', '--', ...trackedInputs.map(input => input.path),
    ],
    cwd: repositoryRoot,
    env: sanitizedBuildEnvironment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (status.exitCode !== 0 || status.stdout.byteLength !== 0) return null
  for (const input of trackedInputs) {
    const currentBlob = runCommand([
      trustedGitExecutable, '-C', repositoryRoot, 'hash-object', '--', input.path,
    ])
    const committedBlob = runCommand([
      trustedGitExecutable, '-C', repositoryRoot, 'rev-parse', `${commit}:${input.path}`,
    ])
    const committedBytes = Bun.spawnSync({
      cmd: [trustedGitExecutable, '-C', repositoryRoot, 'cat-file', 'blob',
        `${commit}:${input.path}`],
      cwd: repositoryRoot,
      env: sanitizedBuildEnvironment,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (!currentBlob || currentBlob !== committedBlob || committedBytes.exitCode !== 0 ||
      createHash('sha256').update(committedBytes.stdout).digest('hex') !== input.sha256) return null
  }
  return commit
}

function sourceAuthority(inputs: readonly SourceInputIdentity[]): {
  kind: 'git-commit'
  orchestratorRef: string
  inputsSha256: string
} {
  const canonical = JSON.stringify(inputs)
  const commit = gitCommitForSourceInputs(inputs)
  if (!commit) {
    throw new Error('Hosted actual-owner relevant source closure is not a clean Git commit')
  }
  return Object.freeze({
    kind: 'git-commit',
    orchestratorRef: commit,
    inputsSha256: createHash('sha256').update(canonical).digest('hex'),
  })
}

function portableArtifactIdentity(
  path: string,
  relativePath: string,
  label: string,
): PortableArtifactIdentity {
  const snapshot = readStableBytes(path, label)
  if (snapshot.stat.nlink !== 1n) throw new Error(`Hosted actual-owner ${label} is hard-linked`)
  return Object.freeze({
    relativePath,
    size: snapshot.stat.size.toString(),
    mode: (snapshot.stat.mode & 0o777n).toString(8).padStart(3, '0'),
    sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
  })
}

function fixedArtifactIdentity(path: string, label: string): FixedArtifactIdentity {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`Hosted actual-owner ${label} path is not canonical`)
  }
  const snapshot = readStableBytes(path, label, true)
  if (snapshot.stat.nlink !== 1n) throw new Error(`Hosted actual-owner ${label} is hard-linked`)
  return Object.freeze({
    path,
    device: snapshot.stat.dev.toString(),
    inode: snapshot.stat.ino.toString(),
    size: snapshot.stat.size.toString(),
    mtimeNs: snapshot.stat.mtimeNs.toString(),
    ctimeNs: snapshot.stat.ctimeNs.toString(),
    mode: (snapshot.stat.mode & 0o777n).toString(8).padStart(3, '0'),
    linkCount: snapshot.stat.nlink.toString(),
    uid: snapshot.stat.uid.toString(),
    sha256: createHash('sha256').update(snapshot.bytes).digest('hex'),
  })
}

function trustedCCompilerExecutable(): string {
  const compiler = realpathSync('/usr/bin/cc')
  if (!isAbsolute(compiler)) {
    throw new Error('Hosted actual-owner C compiler is not absolute')
  }
  return compiler
}

function compilerProgramPath(compiler: string, name: string): string {
  const printed = runCommand([compiler, `-print-prog-name=${name}`])
  if (!printed || printed.includes('\0')) {
    throw new Error(`Hosted actual-owner compiler program is unavailable: ${name}`)
  }
  const candidate = isAbsolute(printed) ? printed : resolve('/usr/bin', printed)
  return realpathSync(candidate)
}

function makefileDependencies(path: string): readonly string[] {
  const text = readFileSync(path, 'utf8').replace(/\\\r?\n/g, ' ')
  const separator = text.indexOf(':')
  if (separator < 0) throw new Error('Hosted actual-owner compiler dependency file is invalid')
  const values = text.slice(separator + 1).trim().split(/\s+/)
    .map(value => value.replace(/\\ /g, ' '))
    .filter(Boolean)
  return Object.freeze([...new Set(values.filter(value => !value.endsWith('.c'))
    .map(value => realpathSync(value)))].sort())
}

function staticLinkDependencies(path: string): readonly string[] {
  const dependencies = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    for (const match of line.matchAll(/\/(?:[^\s()]+\/)*[^\s()]+\.(?:a|o)(?=[\s()]|$)/g)) {
      if (match[0].startsWith('/tmp/cc') && match[0].endsWith('.o')) continue
      try {
        dependencies.add(realpathSync(match[0]))
      } catch {
        throw new Error(`Hosted actual-owner static link input disappeared: ${match[0]}`)
      }
    }
  }
  if (![...dependencies].some(path => path.endsWith('.a'))) {
    throw new Error('Hosted actual-owner static library closure is empty')
  }
  return Object.freeze([...dependencies].sort())
}

function nativeToolchainIdentity(
  compiler: string,
  dependencyPath: string,
  linkMapPath: string,
): NativeToolchainIdentity {
  const programPaths = ['cc1', 'as', 'collect2', 'ld']
    .map(name => compilerProgramPath(compiler, name))
  return Object.freeze({
    compiler: fixedArtifactIdentity(compiler, 'C compiler'),
    programs: Object.freeze([...new Set(programPaths)].sort().map(
      path => fixedArtifactIdentity(path, `compiler program: ${path}`),
    )),
    headers: Object.freeze(makefileDependencies(dependencyPath).map(
      path => fixedArtifactIdentity(path, `native header: ${path}`),
    )),
    staticLinkInputs: Object.freeze(staticLinkDependencies(linkMapPath).map(
      path => fixedArtifactIdentity(path, `static link input: ${path}`),
    )),
  })
}

function buildInputsIdentity(
  sourceInputs: readonly SourceInputIdentity[],
  bun: FixedArtifactIdentity,
  nativeToolchain: NativeToolchainIdentity,
  wrapper: PortableArtifactIdentity,
): HostedActualOwnerBuildInputs {
  const canonical = JSON.stringify({ sourceInputs, bun, nativeToolchain, wrapper })
  return Object.freeze({
    sourceInputs,
    bun,
    nativeToolchain,
    wrapper,
    inputsSha256: createHash('sha256').update(canonical).digest('hex'),
  })
}

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand([
    trustedGitExecutable, '-C', repositoryRoot, 'rev-parse', '--short=8', 'HEAD',
  ]) ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand([
      trustedGitExecutable, '-C', repositoryRoot, 'log', '--format=%h %s', '-20',
    ]) ??
    'Local development build'
  )
}

const defaultFeatures = dev
  ? ['VOICE_MODE']
  : ['VOICE_MODE', ...productionFeatures]
const featureSet = new Set(defaultFeatures)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of devFullFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of devFullFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
for (const feature of productionFeatures) {
  if (featureSet.has(feature) && featureSet.has('UDS_INBOX')) {
    throw new Error('HOSTED_CONTROL and UDS_INBOX cannot own the same UDS listener')
  }
}
const features = [...featureSet].sort()
if (!compile && featureSet.has('HOSTED_CONTROL') &&
  (process.platform !== 'linux' || process.arch !== 'x64')) {
  throw new Error('Hosted actual-owner production build requires Linux x64 glibc')
}
const buildHostedActualOwner = !compile && process.platform === 'linux' && process.arch === 'x64'

const nativeWrapperPrint = args.find(arg =>
  arg.startsWith('--print-hosted-actual-owner-native-wrapper='))
if (nativeWrapperPrint) {
  const printedValue = nativeWrapperPrint.slice(nativeWrapperPrint.indexOf('=') + 1)
  const [printedLauncherPath, printedAuthority = '0'.repeat(64)] = printedValue.split('|')
  if (!printedLauncherPath || !/^[0-9a-f]{64}$/.test(printedAuthority)) {
    throw new Error('Hosted actual-owner native wrapper print input is invalid')
  }
  const directory = printedLauncherPath.replace(
    /\/hostedActualOwnerLauncher-[0-9a-f]{64}$/, '',
  )
  console.log(hostedActualOwnerNativeWrapperSource(directory, printedAuthority))
  process.exit(0)
}

const committedSourcePrint = args.find(arg =>
  arg.startsWith('--test-print-committed-source-sha256=') ||
  arg.startsWith('--test-print-committed-source-identity='))
if (committedSourcePrint) {
  const requested = committedSourcePrint.slice(committedSourcePrint.indexOf('=') + 1)
  const staging = join(repositoryRoot, `.committed-source-test-${process.pid}`)
  try {
    mkdirSync(staging, { mode: 0o700 })
    const root = materializeCommittedBuildRoot(staging)
    const relativePath = repositoryRelativePath(requested, root)
    const snapshot = readStableBytes(join(root, relativePath), 'committed source test')
    const sha256 = createHash('sha256').update(snapshot.bytes).digest('hex')
    console.log(committedSourcePrint.startsWith('--test-print-committed-source-identity=')
      ? JSON.stringify({
          sha256,
          mode: (snapshot.stat.mode & 0o777n).toString(8).padStart(3, '0'),
        })
      : sha256)
  } finally {
    if (existsSync(staging)) removeEmptyBuildDirectory(staging)
  }
  process.exit(0)
}

const publicationTest = args.find(arg => arg.startsWith('--test-publish-generation='))
if (publicationTest) {
  if (process.env.HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK !== '1') {
    throw new Error('Hosted actual-owner publication test hook is disabled')
  }
  const paths = publicationTest.slice(publicationTest.indexOf('=') + 1).split('|')
  if ((paths.length !== 2 && paths.length !== 4) || paths.some(path => {
    const relation = relative(repositoryRoot, resolve(path))
    return relation === '' || relation === '..' || relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
  })) {
    throw new Error('Hosted actual-owner publication test path escaped repository')
  }
  const publishesOwner = paths.length === 4
  publishBuildGeneration(
    paths[0]!, paths[1]!, publishesOwner ? paths[2]! : null,
    publishesOwner ? paths[3]! : null,
    publishesOwner ? digest => writeSync(process.stdout.fd, `${digest}\n`) : undefined,
  )
  process.exit(0)
}

if (args.includes('--print-build-plan')) {
  console.log(JSON.stringify({
    compile,
    dev,
    features,
    bundleEntrypoints: ['./src/entrypoints/cli.tsx'],
    hostedActualOwnerArtifact: !buildHostedActualOwner
      ? null
      : dev
        ? './dist/local-cli-dev/hostedActualOwnerLauncher-<sha256>'
        : './dist/local-cli/hostedActualOwnerLauncher-<sha256>',
    hostedActualOwnerWrapper: buildHostedActualOwner
      ? `./${hostedActualOwnerWrapperRelativePath}`
      : null,
    hostedActualOwnerOrchestratorRef: null,
    hostedActualOwnerSourceAuthority: buildHostedActualOwner
      ? 'clean-git-plus-exact-source-closure'
      : null,
    repositoryRoot,
  }))
  process.exit(0)
}

const outfile = compile
  ? dev
    ? './dist/cli-dev'
    : './dist/cli'
  : dev
    ? './cli-dev'
    : './cli'
const bundleOutdir = dev ? './dist/local-cli-dev' : './dist/local-cli'
const bundleEntrypoint = `${bundleOutdir}/cli.js`
const hostedActualOwnerOutfile = `./${hostedActualOwnerWrapperRelativePath}`
const buildTime = dev ? new Date().toISOString() : '1970-01-01T00:00:00.000Z'
const version = dev ? getDevVersion(pkg.version) : pkg.version

const outfileDir = dirname(outfile)
if (outfileDir !== '.') {
  mkdirSync(outfileDir, { recursive: true })
}

function patchGeminiCliCoreWasmImports(): void {
  const shellUtilsPath =
    './node_modules/@google/gemini-cli-core/dist/src/utils/shell-utils.js'

  if (!existsSync(shellUtilsPath)) {
    return
  }

  const original = readFileSync(shellUtilsPath, 'utf8')
  const patched = original
    .replaceAll(
      "import('web-tree-sitter/tree-sitter.wasm?binary')",
      "import('web-tree-sitter/tree-sitter.wasm')",
    )
    .replaceAll(
      "import('tree-sitter-bash/tree-sitter-bash.wasm?binary')",
      "import('tree-sitter-bash/tree-sitter-bash.wasm')",
    )

  if (patched !== original) {
    // Bun resolves the package-exported .wasm specifiers, but currently fails
    // on the ?binary suffix that gemini-cli-core expects from esbuild's wasm plugin.
    writeFileSync(shellUtilsPath, patched)
  }
}

patchGeminiCliCoreWasmImports()

const externals = [
  '@ant/*',
  'audio-capture-napi',
  'image-processor-napi',
  'keytar',
  'modifiers-napi',
  'url-handler-napi',
]

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/paoloanzn/claude-code',
  ),
} as const

function hostedActualOwnerBuildRecipe(
  buildInputs: HostedActualOwnerBuildInputs,
): BuildRecipeIdentity {
  const commonDefines = Object.entries(defines).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
  )
  const canonical = JSON.stringify({
    schemaVersion: 1,
    purpose: hostedActualOwnerBuildRecipePurpose,
    invocation: [
      'bun',
      'run',
      'scripts/build.ts',
      ...(dev ? ['--dev'] : []),
      ...[...features].sort().map(feature => `--feature=${feature}`),
    ],
    mode: { compile: false, development: dev },
    features: [...features].sort(),
    defines: {
      common: commonDefines,
      owner: [
        ['process.env.HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256',
          '<derived-build-closure-sha256>'],
        ['process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR', '<signed-build-descriptor>'],
        ['process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE', JSON.stringify('owner')],
      ],
    },
    platform: {
      os: process.platform,
      architecture: process.arch,
      bunVersion: Bun.version,
      target: 'bun',
      format: 'esm',
    },
    bundler: {
      minify: true,
      packages: 'bundle',
      conditions: ['bun'],
      ownerEntrypoint: 'src/entrypoints/hostedActualOwnerAcceptance.ts',
      ownerCompile: true,
      ownerAutoloadDotenv: false,
      ownerAutoloadBunfig: false,
      ownerExecArgv: [],
      sealedOwnerArgv: ['--hosted-actual-owner-sealed-protocol=v1'],
      ownerRelativePath: `${bundleOutdir.slice(2)}/${hostedActualOwnerLauncherBasename}-{sha256}`,
      tsconfig: 'tsconfig.json',
      nativeWrapperCompiler: buildInputs.nativeToolchain.compiler.path,
      nativeWrapperBuildInputsSha256: buildInputs.inputsSha256,
      nativeWrapperCompilerArgs: [...hostedActualOwnerNativeCompilerArgs],
      nativeWrapperClosureCapture: {
        headers: ['-MD', '-MF'],
        staticLinkInputs: '-Wl,-Map=',
      },
      nativeWrapperStatic: true,
      ownerExternal: [],
    },
    environment: Object.entries(sanitizedBuildEnvironment),
  })
  return Object.freeze({
    canonical,
    sha256: createHash('sha256').update(canonical).digest('hex'),
  })
}

function hostedActualOwnerBuildClosureSha256(
  buildInputs: HostedActualOwnerBuildInputs,
  buildRecipe: BuildRecipeIdentity,
  authority: ReturnType<typeof sourceAuthority>,
): string {
  return createHash('sha256').update(JSON.stringify({
    buildInputs,
    buildRecipe,
    sourceAuthority: authority,
  })).digest('hex')
}

function extendBuildArgs(cmd: string[], includeExternals = true): string[] {
  if (includeExternals) {
    for (const external of externals) cmd.push('--external', external)
  }

  for (const feature of features) {
    cmd.push(`--feature=${feature}`)
  }

  for (const [key, value] of Object.entries(defines).sort(
    ([left], [right]) => left < right ? -1 : left > right ? 1 : 0,
  )) {
    cmd.push('--define', `${key}=${value}`)
  }

  return cmd
}

function runBuild(cmd: string[], cwd = repositoryRoot): void {
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: sanitizedBuildEnvironment,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (proc.exitCode !== 0) {
    throw new Error(`Build child failed with exit code ${proc.exitCode ?? 1}: ${cmd.slice(1, 4).join(' ')}`)
  }
}

function runBuildWithFreshMetafile(cmd: string[], cwd: string, metafilePath: string): void {
  if (!isAbsolute(metafilePath)) {
    throw new Error('Hosted actual-owner build metafile path is not absolute')
  }
  unlinkIfPresent(metafilePath)
  runBuild(cmd, cwd)
  if (!existsSync(metafilePath)) {
    throw new Error('Hosted actual-owner build did not produce its metafile')
  }
}

function writeLauncher(launcherPath: string, targetPath: string): void {
  const launcherDir = dirname(resolve(launcherPath))
  const targetRelativePath = relative(launcherDir, resolve(targetPath))
  const launcher = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
TARGET="$SCRIPT_DIR/${targetRelativePath}"

augment_launcher_path() {
  local bun_dir=""
  if [[ -n "\${BUN_INSTALL:-}" ]]; then
    bun_dir="$BUN_INSTALL/bin"
  elif [[ -n "\${HOME:-}" ]]; then
    bun_dir="$HOME/.bun/bin"
  fi

  if [[ -n "$bun_dir" ]]; then
    export PATH="$bun_dir:/opt/homebrew/bin:/usr/local/bin:$PATH"
  else
    export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  fi
}

resolve_bun() {
  if [[ -n "\${BUN_INSTALL:-}" && -x "$BUN_INSTALL/bin/bun" ]]; then
    printf '%s\\n' "$BUN_INSTALL/bin/bun"
    return 0
  fi

  if [[ -x "\${HOME:-}/.bun/bin/bun" ]]; then
    printf '%s\\n' "\${HOME:-}/.bun/bin/bun"
    return 0
  fi

  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi

  for candidate in /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [[ -x "$candidate" ]]; then
      printf '%s\\n' "$candidate"
      return 0
    fi
  done

  echo "Bun runtime was not found. Install Bun or add it to PATH before running this launcher." >&2
  return 127
}

wait_for_target() {
  local attempts=0
  while [[ ! -f "$TARGET" && "$attempts" -lt 50 ]]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done

  if [[ ! -f "$TARGET" ]]; then
    echo "Runtime bundle not found after waiting: $TARGET" >&2
    exit 127
  fi
}

augment_launcher_path
wait_for_target
BUN_BIN="$(resolve_bun)" || exit $?

if [[ "\${1-}" == "runtime" && "\${2-}" == "status" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "--json" ]]; then
      RAW_OUTPUT="$(
        "$BUN_BIN" "$TARGET" "$@" 2> >(cat >&2)
      )"
      RAW_OUTPUT="$RAW_OUTPUT" node <<'EOF'
const raw = process.env.RAW_OUTPUT ?? ''
const start = raw.indexOf('{')
const end = raw.lastIndexOf('}')
if (start < 0 || end <= start) {
  process.stderr.write(raw)
  process.exit(1)
}
const prefix = raw.slice(0, start).trim()
if (prefix.length > 0) {
  process.stderr.write(prefix + '\\n')
}
process.stdout.write(raw.slice(start, end + 1) + '\\n')
EOF
      exit $?
    fi
  done
fi

exec "$BUN_BIN" "$TARGET" "$@"
`

  writeFileSync(launcherPath, launcher)
  chmodSync(launcherPath, 0o755)

  if (process.platform === 'win32') {
    const cmdTargetPath = targetRelativePath.replaceAll('/', '\\')
    const cmdLauncher = `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "TARGET=%SCRIPT_DIR%${cmdTargetPath}"

set "attempts=0"
:wait_for_target
if exist "%TARGET%" goto run_target
if "%attempts%"=="50" goto missing_target
set /a attempts+=1
ping -n 2 127.0.0.1 >nul
goto wait_for_target

:missing_target
echo Runtime bundle not found after waiting: %TARGET% 1>&2
exit /b 127

:run_target
call :augment_launcher_path
bun "%TARGET%" %*
exit /b %ERRORLEVEL%

:augment_launcher_path
if defined BUN_INSTALL if exist "%BUN_INSTALL%\\bin\\bun.exe" set "PATH=%BUN_INSTALL%\\bin;%PATH%"
if exist "%USERPROFILE%\\.bun\\bin\\bun.exe" set "PATH=%USERPROFILE%\\.bun\\bin;%PATH%"
exit /b 0
`
    writeFileSync(`${launcherPath}.cmd`, cmdLauncher)
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }
}

function removeEmptyBuildDirectory(path: string): void {
  if (!existsSync(path)) return
  for (const entry of readdirSync(path)) {
    const child = join(path, entry)
    if (entry === '.committed-source' && lstatSync(child).isDirectory()) {
      rmSync(child, { recursive: true, force: true })
      continue
    }
    if (!lstatSync(child).isFile()) {
      throw new Error(`Refusing to remove non-file build staging entry: ${child}`)
    }
    unlinkSync(child)
  }
  rmdirSync(path)
}

function materializeCommittedBuildRoot(stagingOutdir: string): string {
  const commit = runCommand([
    trustedGitExecutable, '-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD^{commit}',
  ])
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Hosted actual-owner committed build root is unavailable')
  }
  const root = join(stagingOutdir, '.committed-source')
  const archive = join(stagingOutdir, '.committed-source.tar')
  mkdirSync(root, { mode: 0o700 })
  runBuild([trustedGitExecutable, '-C', repositoryRoot, 'archive', '--format=tar',
    `--output=${archive}`, commit])
  runBuild(['/usr/bin/tar', '-xf', archive, '-C', root])
  unlinkSync(archive)
  const sealTree = (directory: string): void => {
    chmodSync(directory, 0o700)
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const linked = lstatSync(path)
      if (linked.isDirectory()) sealTree(path)
      else if (linked.isFile()) chmodSync(path, linked.mode & 0o111 ? 0o700 : 0o600)
    }
  }
  const installedDependencies = join(repositoryRoot, 'node_modules')
  if (existsSync(installedDependencies)) {
    cpSync(installedDependencies, join(root, 'node_modules'), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    })
  }
  sealTree(root)
  return root
}

function withPublicationLock<T>(callback: () => T): T {
  if (process.platform !== 'linux' || process.arch !== 'x64' ||
    realpathSync(publicationLibcPath) !== publicationLibcPath) {
    throw new Error('Hosted actual-owner publication requires Linux x64 glibc')
  }
  const library = dlopen(publicationLibcPath, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  })
  const fd = openSync(repositoryRoot, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    if (library.symbols.flock(fd, 2) !== 0) {
      throw new Error('Hosted actual-owner publication serialization failed')
    }
    return callback()
  } finally {
    try { library.symbols.flock(fd, 8) } finally {
      closeSync(fd)
      library.close()
    }
  }
}

function generationDigest(ownerPath: string, wrapperPath: string): string | null {
  try {
    const owner = readStableBytes(ownerPath, 'published owner artifact')
    const wrapper = readStableBytes(wrapperPath, 'published owner route')
    const ownerSha256 = createHash('sha256').update(owner.bytes).digest('hex')
    const wrapperSha256 = createHash('sha256').update(wrapper.bytes).digest('hex')
    const occurrences = (haystack: Buffer, needle: Buffer): number => {
      let count = 0
      for (let offset = 0; (offset = haystack.indexOf(needle, offset)) >= 0; offset++) count++
      return count
    }
    if (!ownerPath.endsWith(`-${ownerSha256}`) ||
      !owner.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      !wrapper.bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      occurrences(owner.bytes, Buffer.from(wrapperSha256)) < 1 ||
      owner.stat.nlink !== 1n || wrapper.stat.nlink !== 1n ||
      (owner.stat.mode & 0o777n) !== 0o555n || (wrapper.stat.mode & 0o777n) !== 0o555n) {
      return null
    }
    return createHash('sha256').update(JSON.stringify({
      ownerSha256,
      wrapperSha256,
    })).digest('hex')
  } catch {
    return null
  }
}

function publishBuildGeneration(
  stagingOutdir: string,
  finalOutdir: string,
  wrapperStaging: string | null,
  wrapperFinal: string | null,
  reportInstalled?: (digest: string) => void,
): string | null {
  if ((wrapperStaging === null) !== (wrapperFinal === null)) {
    throw new Error('Hosted actual-owner publication paths are incomplete')
  }
  mkdirSync(finalOutdir, { recursive: true })
  const install = (): string | null => {
    const stagedEntries = readdirSync(stagingOutdir).sort()
    const candidateOwnerName = stagedEntries.find(entry =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(entry),
    )
    const candidateDigest = wrapperStaging && candidateOwnerName
      ? generationDigest(join(stagingOutdir, candidateOwnerName), wrapperStaging)
      : null
    const currentOwners = readdirSync(finalOutdir).filter(entry =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(entry),
    )
    const currentDigest = wrapperFinal && currentOwners.length === 1
      ? generationDigest(join(finalOutdir, currentOwners[0]!), wrapperFinal)
      : null
    // An identical concurrent candidate converges on the already-installed pair. A
    // distinct valid candidate must replace it and report its own generation.
    if (candidateDigest && currentDigest === candidateDigest) {
      removeEmptyBuildDirectory(stagingOutdir)
      if (wrapperStaging) unlinkIfPresent(wrapperStaging)
      reportInstalled?.(currentDigest)
      return currentDigest
    }
    if (wrapperStaging && (!candidateOwnerName || !candidateDigest)) {
      throw new Error('Hosted actual-owner candidate artifact is missing')
    }
    for (const entryName of stagedEntries) {
      const sourcePath = join(stagingOutdir, entryName)
      if (!lstatSync(sourcePath).isFile()) {
        throw new Error(`Hosted actual-owner build output is not a file: ${entryName}`)
      }
      renameSync(sourcePath, join(finalOutdir, entryName))
    }
    unlinkIfPresent(join(finalOutdir, 'hostedActualOwnerAcceptance.js'))
    unlinkIfPresent(join(finalOutdir, 'hostedActualOwnerAcceptance.closure.json'))
    if (wrapperStaging && wrapperFinal) {
      renameSync(wrapperStaging, wrapperFinal)
      chmodSync(wrapperFinal, 0o555)
    }
    const publishedOwners = readdirSync(finalOutdir).filter(entry =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(entry),
    )
    for (const entry of publishedOwners) {
      if (entry !== candidateOwnerName) unlinkSync(join(finalOutdir, entry))
    }
    rmdirSync(stagingOutdir)
    if (!candidateOwnerName || !wrapperFinal) return null
    const installedDigest = generationDigest(
      join(finalOutdir, candidateOwnerName), wrapperFinal,
    )
    if (installedDigest !== candidateDigest) {
      throw new Error('Hosted actual-owner published generation verification failed')
    }
    // The synchronous report is the publication linearization point: the exact
    // validated pair remains installed until this callback has completed.
    reportInstalled?.(installedDigest)
    return installedDigest
  }
  // Ordinary CLI bundles are portable. Only the paired Linux x64 actual-owner
  // artifacts cross the platform-specific, serialized publication boundary.
  const published = wrapperStaging === null ? install() : withPublicationLock(install)
  return published
}

if (compile) {
  const cmd = extendBuildArgs([
    trustedBunExecutable,
    'build',
    './src/entrypoints/cli.tsx',
    '--compile',
    '--target',
    compileTarget,
    '--format',
    'esm',
    '--outfile',
    outfile,
    '--minify',
    '--packages',
    'bundle',
    '--conditions',
    'bun',
  ])

  runBuild(cmd)

  if (existsSync(outfile)) {
    chmodSync(outfile, 0o755)
  }

  console.log(`Built ${outfile}`)
} else {
  const stagingOutdir = `${bundleOutdir}.staging-${process.pid}-${Date.now()}`
  const hostedActualOwnerWrapperStaging =
    `${hostedActualOwnerOutfile}.staging-${process.pid}-${Date.now()}`
  let hostedActualOwnerLauncherStaging =
    resolve(stagingOutdir, hostedActualOwnerLauncherBasename)
  const hostedActualOwnerNativeSource =
    `${stagingOutdir}/.${hostedActualOwnerLauncherBasename}.c`
  const hostedActualOwnerNativeDependencies =
    `${stagingOutdir}/.${hostedActualOwnerLauncherBasename}.d`
  const hostedActualOwnerNativeLinkMap =
    `${stagingOutdir}/.${hostedActualOwnerLauncherBasename}.map`
  const hostedActualOwnerMetafile =
    resolve(stagingOutdir, 'hostedActualOwnerAcceptance.meta.json')
  try {
    if (existsSync(stagingOutdir)) removeEmptyBuildDirectory(stagingOutdir)
    unlinkIfPresent(hostedActualOwnerWrapperStaging)
    mkdirSync(stagingOutdir, { recursive: true })
    mkdirSync(dirname(hostedActualOwnerWrapperStaging), { recursive: true })

    const cliBuild = extendBuildArgs([
      trustedBunExecutable,
      'build',
      './src/entrypoints/cli.tsx',
      '--target',
      'bun',
      '--format',
      'esm',
      '--outdir',
      stagingOutdir,
      '--minify',
      '--packages',
      'bundle',
      '--conditions',
      'bun',
    ])
    runBuild(cliBuild)

    if (buildHostedActualOwner) {
      const committedBuildRoot = materializeCommittedBuildRoot(stagingOutdir)
      const trustedBunSnapshot = resolve(stagingOutdir, '.trusted-bun')
      writeFileSync(
        trustedBunSnapshot,
        readStableBytes(trustedBunExecutable, 'Bun executable snapshot', true).bytes,
        { mode: 0o700 },
      )
      const bunIdentity = fixedArtifactIdentity(trustedBunSnapshot, 'Bun executable snapshot')
      const ownerBuild = extendBuildArgs([
        trustedBunSnapshot,
        'build',
        './src/entrypoints/hostedActualOwnerAcceptance.ts',
        '--compile',
        '--no-compile-autoload-dotenv',
        '--no-compile-autoload-bunfig',
        '--compile-exec-argv=',
        '--target',
        'bun',
        '--format',
        'esm',
        '--outfile',
        hostedActualOwnerLauncherStaging,
        '--metafile',
        hostedActualOwnerMetafile,
        '--minify',
        '--packages',
        'bundle',
        '--conditions',
        'bun',
        '--define',
        `process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE=${JSON.stringify('owner')}`,
        '--define',
        `process.env.HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256=${JSON.stringify('0'.repeat(64))}`,
        '--define',
        `process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR=${JSON.stringify('{}')}`,
      ], false)

      runBuildWithFreshMetafile(ownerBuild, committedBuildRoot, hostedActualOwnerMetafile)
      const sourceInputs = readHostedActualOwnerSourceInputs(
        hostedActualOwnerMetafile, committedBuildRoot,
      )
      const authority = sourceAuthority(sourceInputs)
      assertSourceInputsUnchanged(sourceInputs, committedBuildRoot)
      const authoritySha256 = createHash('sha256')
        .update(JSON.stringify(authority)).digest('hex')

      const compiler = trustedCCompilerExecutable()
      writeFileSync(hostedActualOwnerNativeSource,
        hostedActualOwnerNativeWrapperSource(bundleOutdir.slice(2), authoritySha256),
        { mode: 0o600 })
      runBuild([
        compiler, ...hostedActualOwnerNativeCompilerArgs,
        '-MD', '-MF', hostedActualOwnerNativeDependencies,
        `-Wl,-Map=${hostedActualOwnerNativeLinkMap}`,
        hostedActualOwnerNativeSource, '-o', hostedActualOwnerWrapperStaging,
      ])
      const toolchainIdentity = nativeToolchainIdentity(
        compiler, hostedActualOwnerNativeDependencies, hostedActualOwnerNativeLinkMap,
      )
      chmodSync(hostedActualOwnerWrapperStaging, 0o555)
      const wrapperIdentity = portableArtifactIdentity(
        hostedActualOwnerWrapperStaging, hostedActualOwnerWrapperRelativePath, 'wrapper',
      )
      const buildInputs = buildInputsIdentity(
        sourceInputs, bunIdentity, toolchainIdentity, wrapperIdentity,
      )
      const buildRecipe = hostedActualOwnerBuildRecipe(buildInputs)
      const buildClosureSha256 = hostedActualOwnerBuildClosureSha256(
        buildInputs, buildRecipe, authority,
      )
      const launcherAuthority = Object.freeze({
        directoryRelativePath: bundleOutdir.slice(2),
        basenamePrefix: 'hostedActualOwnerLauncher-' as const,
        role: 'content-addressed-runtime' as const,
      })
      const launchDescriptor: HostedActualOwnerLaunchDescriptor = Object.freeze({
        schemaVersion: 1,
        purpose: hostedActualOwnerLaunchPurpose,
        inputsSha256: buildClosureSha256,
        buildRecipe,
        sourceAuthority: authority,
        buildInputs,
        wrapper: Object.freeze({
          ...wrapperIdentity,
          role: 'invoked-trust-anchor' as const,
        }),
        launcher: launcherAuthority,
        closure: Object.freeze([
          launcherAuthority.directoryRelativePath, wrapperIdentity.relativePath,
        ].sort()),
        sourceInputs,
      })
      const descriptorJson = JSON.stringify(launchDescriptor)
      const finalOwnerBuild = ownerBuild.map(argument =>
        argument === `process.env.HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256=${JSON.stringify('0'.repeat(64))}`
          ? `process.env.HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256=${JSON.stringify(buildClosureSha256)}`
          : argument === `process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR=${JSON.stringify('{}')}`
            ? `process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR=${JSON.stringify(descriptorJson)}`
            : argument)
      runBuildWithFreshMetafile(
        finalOwnerBuild, committedBuildRoot, hostedActualOwnerMetafile,
      )
      chmodSync(hostedActualOwnerLauncherStaging, 0o555)
      const finalSourceInputs = readHostedActualOwnerSourceInputs(
        hostedActualOwnerMetafile, committedBuildRoot,
      )
      if (JSON.stringify(finalSourceInputs) !== JSON.stringify(sourceInputs)) {
        throw new Error('Hosted actual-owner committed source closure changed during build')
      }
      const provisionalLauncher = portableArtifactIdentity(
        hostedActualOwnerLauncherStaging, hostedActualOwnerLauncherBasename, 'owner artifact',
      )
      const contentAddressedBasename =
        `${hostedActualOwnerLauncherBasename}-${provisionalLauncher.sha256}`
      const contentAddressedStaging = `${stagingOutdir}/${contentAddressedBasename}`
      renameSync(hostedActualOwnerLauncherStaging, contentAddressedStaging)
      hostedActualOwnerLauncherStaging = contentAddressedStaging
      const launcherRelativePath = `${bundleOutdir.slice(2)}/${contentAddressedBasename}`
      const launcherIdentity = portableArtifactIdentity(
        hostedActualOwnerLauncherStaging, launcherRelativePath, 'launcher',
      )
      const finalToolchainIdentity = nativeToolchainIdentity(
        compiler, hostedActualOwnerNativeDependencies, hostedActualOwnerNativeLinkMap,
      )
      if (JSON.stringify(finalToolchainIdentity) !== JSON.stringify(toolchainIdentity)) {
        throw new Error('Hosted actual-owner native toolchain closure changed during build')
      }
      unlinkIfPresent(hostedActualOwnerNativeSource)
      unlinkIfPresent(hostedActualOwnerNativeDependencies)
      unlinkIfPresent(hostedActualOwnerNativeLinkMap)
      assertSourceInputsUnchanged(sourceInputs, committedBuildRoot)
      const finalBunIdentity = fixedArtifactIdentity(
        trustedBunSnapshot, 'Bun executable snapshot after build',
      )
      if (JSON.stringify(finalBunIdentity) !== JSON.stringify(bunIdentity)) {
        throw new Error('Hosted actual-owner executable closure changed during build')
      }
      const finalLauncherIdentity = portableArtifactIdentity(
        hostedActualOwnerLauncherStaging, launcherRelativePath, 'launcher after wrapper build',
      )
      const finalWrapperIdentity = portableArtifactIdentity(
        hostedActualOwnerWrapperStaging, hostedActualOwnerWrapperRelativePath,
        'wrapper after owner build',
      )
      if (JSON.stringify(finalLauncherIdentity) !== JSON.stringify(launcherIdentity) ||
        JSON.stringify(finalWrapperIdentity) !== JSON.stringify(wrapperIdentity)) {
        throw new Error('Hosted actual-owner authenticated closure changed during build')
      }
      unlinkIfPresent(hostedActualOwnerMetafile)
      unlinkIfPresent(trustedBunSnapshot)
      rmSync(committedBuildRoot, { recursive: true, force: true })
    }

    writeLauncher(outfile, bundleEntrypoint)
    const publishedDigest = publishBuildGeneration(
      stagingOutdir,
      bundleOutdir,
      buildHostedActualOwner ? hostedActualOwnerWrapperStaging : null,
      buildHostedActualOwner ? hostedActualOwnerOutfile : null,
      buildHostedActualOwner
        ? digest => writeSync(
            process.stdout.fd,
            `Built ${outfile} -> ${bundleEntrypoint} and ${hostedActualOwnerOutfile} -> content-addressed owner (${digest})\n`,
          )
        : undefined,
    )
    if (!buildHostedActualOwner) {
      console.log(`Built ${outfile} -> ${bundleEntrypoint}`)
    } else if (!publishedDigest) {
      throw new Error('Hosted actual-owner installed generation was not reported')
    }
  } finally {
    if (existsSync(stagingOutdir)) removeEmptyBuildDirectory(stagingOutdir)
    unlinkIfPresent(hostedActualOwnerWrapperStaging)
  }
}
