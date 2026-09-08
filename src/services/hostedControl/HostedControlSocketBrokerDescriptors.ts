import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { closeSync, fstatSync } from 'node:fs'

// Broker-only descriptor operations. Do not import the native bootstrap reader:
// its Linux-only role/ownership contracts are different from this private FD3.
const darwin = process.platform === 'darwin'
const supported = darwin || process.platform === 'linux'
const native = supported ? dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, darwin ? FFIType.u32 : FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  send: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
  shutdown: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
} as const) : null
const errnoPointer = !supported ? null : darwin
  ? dlopen('/usr/lib/libSystem.B.dylib', { __error: { args: [], returns: FFIType.ptr } } as const).symbols.__error
  : dlopen('libc.so.6', { __errno_location: { args: [], returns: FFIType.ptr } } as const).symbols.__errno_location
const DONTWAIT = darwin ? 0x80 : 0x40
const AGAIN = darwin ? 35 : 11
const SOL_SOCKET = darwin ? 0xffff : 1

function requireNative(): NonNullable<typeof native> {
  if (!native) throw new Error('Hosted control broker kernel identity is unsupported')
  return native
}
function errno(): number {
  // Read thread-local errno immediately after the failed syscall.
  return read.i32(errnoPointer!()!)
}
function ioResult(n: number): number {
  if (n >= 0) return n
  const error = errno()
  if (error === AGAIN || error === 4) return -1 // EAGAIN/EWOULDBLOCK, EINTR
  throw new Error(`Hosted control broker descriptor I/O failed (${error})`)
}
function beforeDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new Error('Hosted control broker descriptor deadline')
}
async function retry(deadline: number): Promise<void> {
  beforeDeadline(deadline)
  await new Promise<void>(resolve => setTimeout(resolve, 2))
}

/** Bun 1.3.11 does not drive inherited socketpairs through net.Socket({fd}).
 * Like InheritedConnectionV2, receive directly with MSG_DONTWAIT. No runtime
 * wrapper, pathname reopen, flag mutation, or blocking worker owns this FD.
 * EOF is mandatory even after a complete frame; all waits share one deadline. */
export async function readSocketBrokerDescriptor(fd: number, bytes: Buffer, deadline: number): Promise<number> {
  try {
    const libc = requireNative()
    if (!fstatSync(fd).isSocket()) throw new Error('Private channel unavailable')
    let length = 0
    for (;;) {
      beforeDeadline(deadline)
      const available = bytes.subarray(length)
      const n = ioResult(Number(libc.symbols.recv(fd, ptr(available), available.length, DONTWAIT)))
      if (n === 0) return length
      if (n > 0) {
        length += n
        // Caller allocates maximum+1, so this detects overflow without a
        // zero-length recv being mistaken for EOF.
        if (length === bytes.length) throw new Error('Oversized private batch')
      } else await retry(deadline)
    }
  } finally {
    // FD3 is exclusively transferred to this one-use reader; never also wrap
    // it in a Socket whose later finalizer could close a reused descriptor.
    try { closeSync(fd) } catch {}
  }
}

/** Bind the nonce route to this broker's kernel listener credentials BEFORE
 * sending any nonce bytes. A same-UID proxy can relay bytes and FIN to a retained
 * alias or preconnected original, but cannot relay SO_PEERCRED/LOCAL_PEERPID.
 * The separate exact-listener receipt disambiguates this process's A and B.
 * The raw probe avoids undocumented Bun net.Socket descriptor extraction. */
export async function proveSocketBrokerSelfPeer(
  path: string, nonce: Buffer, deadline: number, accepted: Promise<void>,
): Promise<void> {
  const libc = requireNative()
  const encoded = Buffer.from(path)
  if (encoded.length >= (darwin ? 104 : 108) || path.includes('\0')) throw new Error('Invalid broker probe path')
  const address = Buffer.alloc(2 + encoded.length + 1)
  if (darwin) { address[0] = address.length; address[1] = 1 } // sockaddr_un: sun_len, AF_UNIX
  else new Uint16Array(address.buffer, address.byteOffset, 1)[0] = 1
  encoded.copy(address, 2)
  const fd = libc.symbols.socket(1, 1, 0) // AF_UNIX, SOCK_STREAM
  if (fd < 0) throw new Error('Broker probe socket unavailable')
  try {
    const flags = libc.symbols.fcntl(fd, 3, 0) // F_GETFL
    const descriptorFlags = libc.symbols.fcntl(fd, 1, 0) // F_GETFD
    if (flags < 0 || descriptorFlags < 0 ||
      libc.symbols.fcntl(fd, 4, flags | (darwin ? 4 : 0x800)) !== 0 ||
      libc.symbols.fcntl(fd, 2, descriptorFlags | 1) !== 0) throw new Error('Broker probe flags unavailable')
    if (darwin) {
      const one = new Int32Array([1])
      if (libc.symbols.setsockopt(fd, SOL_SOCKET, 0x1022, ptr(one), 4) !== 0) {
        throw new Error('Broker probe SIGPIPE protection unavailable') // SO_NOSIGPIPE
      }
    }
    beforeDeadline(deadline)
    if (libc.symbols.connect(fd, ptr(address), address.length) !== 0) {
      const error = errno()
      if (error !== (darwin ? 36 : 115)) throw new Error('Broker probe connect failed') // EINPROGRESS
      const pollfd = new Int32Array([fd, 0])
      new Int16Array(pollfd.buffer, 4, 2)[0] = 4 // POLLOUT; native struct pollfd layout
      for (;;) {
        beforeDeadline(deadline)
        const result = ioResult(libc.symbols.poll(ptr(pollfd), 1, 0))
        if (result > 0) {
          const status = new Int32Array(1), size = new Uint32Array([4])
          if (libc.symbols.getsockopt(fd, SOL_SOCKET, darwin ? 0x1007 : 4, ptr(status), ptr(size)) !== 0 ||
            size[0] !== 4 || status[0] !== 0) throw new Error('Broker probe connect failed') // SO_ERROR
          break
        }
        await retry(deadline)
      }
    }
    const credentials = new Int32Array(darwin ? 1 : 3)
    const size = new Uint32Array([credentials.byteLength])
    // Linux ucred.pid is captured from the listening process. Darwin exposes
    // the equivalent kernel peer PID at SOL_LOCAL/LOCAL_PEERPID. No UID-only or
    // nonce-only fallback is permitted on missing/unsupported credentials.
    if (libc.symbols.getsockopt(fd, darwin ? 0 : SOL_SOCKET, darwin ? 2 : 17,
      ptr(credentials), ptr(size)) !== 0 || size[0] !== credentials.byteLength || credentials[0] !== process.pid) {
      throw new Error('Broker probe is connected to a foreign listener')
    }
    let offset = 0
    while (offset < nonce.length) {
      beforeDeadline(deadline)
      const remaining = nonce.subarray(offset)
      const n = ioResult(Number(libc.symbols.send(fd, ptr(remaining), remaining.length,
        DONTWAIT | (darwin ? 0 : 0x4000)))) // MSG_NOSIGNAL on Linux
      if (n === 0) throw new Error('Broker probe short write')
      if (n > 0) offset += n
      else await retry(deadline)
    }
    if (libc.symbols.shutdown(fd, 1) !== 0) throw new Error('Broker probe FIN failed')
    await accepted
  } finally { closeSync(fd) }
}
