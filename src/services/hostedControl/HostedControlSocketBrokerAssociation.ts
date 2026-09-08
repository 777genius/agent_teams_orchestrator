import { closeSync, fstatSync, openSync, statfsSync, type Stats } from 'node:fs'

/** Linux open(2) O_PATH + procfs magic links provide effective inode custody:
 * /proc/self/fd/N resolves the held kernel path, NOT the text of readlink(N).
 * symlink(7), "Magic links", explicitly documents that this survives unlink.
 * Constants are from local asm-generic/fcntl.h and linux/magic.h. No guessed
 * Darwin equivalent, pathname/nonce-only fallback, or u32 inode truncation.
 */
export function requireSocketBrokerAssociation(): void {
  if (process.platform !== 'linux' || statfsSync('/proc/self/fd').type !== 0x9fa0) {
    throw new Error('Hosted control broker inode custody requires Linux procfs O_PATH')
  }
}

/** Hold the observed filesystem socket through connect, exact-listener nonce
 * receipt, and bound emission. Connecting to this procfs magic link operates
 * on THIS inode even when an adversary restores a different listener at path.
 * fstat is the full filesystem identity; this is not fstat of an AF_UNIX socket
 * descriptor (which would describe sockfs instead). The caller owns close. */
export function pinSocketBrokerPath(path: string, expected: Stats): { fd: number; probePath: string } {
  requireSocketBrokerAssociation()
  const fd = openSync(path, 0x200000 | 0x20000 | 0x80000) // O_PATH|O_NOFOLLOW|O_CLOEXEC
  try {
    const held = fstatSync(fd)
    if (!held.isSocket() || held.dev !== expected.dev || held.ino !== expected.ino ||
      held.mode !== expected.mode || held.uid !== expected.uid || held.gid !== expected.gid ||
      !Number.isSafeInteger(held.dev) || !Number.isSafeInteger(held.ino)) {
      throw new Error('Hosted control broker inode changed before custody')
    }
    return { fd, probePath: `/proc/self/fd/${fd}` }
  } catch (error) { closeSync(fd); throw error }
}
