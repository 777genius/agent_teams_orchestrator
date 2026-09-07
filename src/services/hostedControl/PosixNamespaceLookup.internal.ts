import { dlopen, FFIType, ptr, read } from 'bun:ffi'

const path = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
const libc = process.platform === 'win32' ? null : dlopen(path, {
  fstatat: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
} as const)
const errnoLibc = process.platform === 'win32' ? null : process.platform === 'darwin'
  ? dlopen(path, { __error: { args: [], returns: FFIType.ptr } } as const)
  : dlopen(path, { __errno_location: { args: [], returns: FFIType.ptr } } as const)

export class PosixNamespaceLookupError extends Error {
  constructor(readonly errno: number, child: string) { super(`POSIX namespace lookup failed: ${child} (errno ${errno})`) }
}

// Internal syscall boundary, shared by WAL predecessor acquisition and custody.
// Tests replace this call, never the existence decision or predecessor witness.
export const posixNamespaceLookup = {
  fstatat(fd: number, child: string): { result: number; errno: number } {
    if (!libc || !errnoLibc) throw new Error('POSIX namespace lookup unavailable')
    const errnoPointer = '__error' in errnoLibc.symbols
      ? errnoLibc.symbols.__error() : errnoLibc.symbols.__errno_location()
    if (!errnoPointer) throw new Error('POSIX namespace errno unavailable')
    const encoded = Buffer.from(`${child}\0`); const stat = Buffer.alloc(512)
    const result = libc.symbols.fstatat(fd, ptr(encoded), ptr(stat), process.platform === 'darwin' ? 0x0020 : 0x0100)
    // Read thread-local errno immediately, with no intervening libc call.
    return { result, errno: result < 0 ? read.i32(errnoPointer) : 0 }
  },
}
export function existsInPosixDirectory(fd: number, child: string): boolean {
  const { result, errno } = posixNamespaceLookup.fstatat(fd, child)
  if (result === 0) return true
  if (result === -1 && errno === 2) return false // ENOENT on Linux and Darwin
  throw new PosixNamespaceLookupError(errno, child)
}
