import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs'

type LinuxSymbols = {
  openat(parent: number, name: unknown, flags: number, mode: number): number
  renameat(fromParent: number, from: unknown, toParent: number, to: unknown): number
}

type LinuxApi = {
  library: unknown
  symbols: LinuxSymbols
  pointer(value: Buffer): unknown
  errno(): number
}

let linuxApiPromise: Promise<LinuxApi> | null = null

function closeOnExecFlag(): number {
  if (typeof constants.O_CLOEXEC === 'number' && constants.O_CLOEXEC !== 0) {
    return constants.O_CLOEXEC
  }
  // Bun omits this export. Linux asm-generic/fcntl.h defines it as 02000000.
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return 0o2000000
  }
  throw new Error('Linux O_CLOEXEC is required for canonical team descriptor custody')
}

async function linuxApi(): Promise<LinuxApi> {
  if (process.platform !== 'linux') {
    throw new Error('Canonical team dirfd custody is only available on Linux')
  }
  linuxApiPromise ??= import('bun:ffi').then(({ dlopen, FFIType, ptr, read }) => {
    const library = dlopen('libc.so.6', {
      // libc openat is variadic, but Linux consumes its fourth argument only
      // with O_CREAT/O_TMPFILE. Declare and always pass that complete ABI
      // shape so exclusive creation returns the newly-created file descriptor
      // in the same syscall; zero is harmless for non-creating calls.
      openat: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
        returns: FFIType.i32,
      },
      renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    } as const)
    const symbols = library.symbols as unknown as LinuxSymbols & { __errno_location(): unknown }
    return {
      library,
      symbols,
      pointer: ptr,
      errno: () => read.i32(
        symbols.__errno_location() as Parameters<typeof read.i32>[0],
      ),
    }
  })
  return linuxApiPromise
}

function component(value: string): Buffer {
  if (!value || value === '.' || value === '..' || value.includes('/') ||
    value.includes('\\') || value.includes('\0')) {
    throw new Error('Unsafe canonical team directory child name')
  }
  return Buffer.from(`${value}\0`)
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export type CanonicalOwnedFile = {
  readonly fd?: number
  readonly identity: Stats
}

class CanonicalHeldDirectory {
  constructor(
    private readonly api: LinuxApi,
    readonly fd: number,
  ) {
    if (!fstatSync(fd).isDirectory()) throw new Error('Canonical root is not a directory')
  }

  createFile(name: string, contents: string): CanonicalOwnedFile {
    const encoded = component(name)
    const fd = this.api.symbols.openat(
      this.fd,
      this.api.pointer(encoded),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0) | closeOnExecFlag(),
      0o600,
    )
    if (fd < 0) throw new Error(`Canonical team file create failed: ${name}`)
    try {
      const identity = fstatSync(fd)
      if (!identity.isFile()) throw new Error(`Canonical team child is not a regular file: ${name}`)
      writeFileSync(fd, contents)
      fsyncSync(fd)
      return { fd, identity }
    } catch (error) {
      // Retain the entry: its basename may now identify another writer's file.
      // Closing our descriptor is safe; conditional unlink is not available.
      closeSync(fd)
      throw error
    }
  }

  readFile(name: string): { text: string; identity: Stats } | null {
    const encoded = component(name)
    const fd = this.api.symbols.openat(
      this.fd,
      this.api.pointer(encoded),
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
        (constants.O_NOFOLLOW ?? 0) | closeOnExecFlag(),
      0,
    )
    if (fd < 0) {
      if (this.api.errno() === 2) return null
      throw new Error(`Canonical team file open failed: ${name}`)
    }
    try {
      const identity = fstatSync(fd)
      if (!identity.isFile()) throw new Error(`Canonical team child is not a regular file: ${name}`)
      const text = readFileSync(fd, 'utf8')
      const currentFd = this.api.symbols.openat(
        this.fd,
        this.api.pointer(encoded),
        constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
          (constants.O_NOFOLLOW ?? 0) | closeOnExecFlag(),
        0,
      )
      if (currentFd < 0) throw new Error(`Canonical team file was replaced while reading: ${name}`)
      try {
        if (!sameIdentity(identity, fstatSync(currentFd))) {
          throw new Error(`Canonical team file was replaced while reading: ${name}`)
        }
      } finally {
        closeSync(currentFd)
      }
      return { text, identity }
    } finally {
      closeSync(fd)
    }
  }

}

export class CanonicalTeamDirectory {
  private constructor(private readonly api: LinuxApi, readonly fd: number) {}

  static async fromRootFd(fd: number): Promise<CanonicalTeamDirectory> {
    const api = await linuxApi()
    const identity = fstatSync(fd)
    if (!identity.isDirectory()) throw new Error('Canonical team root fd is not a directory')
    return new CanonicalTeamDirectory(api, fd)
  }

  readFile(name: string): { text: string; identity: Stats } | null {
    const root = new CanonicalHeldDirectory(this.api, this.fd)
    return root.readFile(name)
  }

  createFile(name: string, contents: string): CanonicalOwnedFile {
    const root = new CanonicalHeldDirectory(this.api, this.fd)
    return root.createFile(name, contents)
  }

  rename(from: string, to: string): void {
    if (this.api.symbols.renameat(
      this.fd, this.api.pointer(component(from)), this.fd, this.api.pointer(component(to)),
    ) !== 0) throw new Error(`Canonical team rename failed: ${from}`)
  }

  namedFileIs(name: string, owned: CanonicalOwnedFile): boolean {
    const encoded = component(name)
    const fd = this.api.symbols.openat(
      this.fd,
      this.api.pointer(encoded),
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) |
        (constants.O_NOFOLLOW ?? 0) | closeOnExecFlag(),
      0,
    )
    if (fd < 0) return false
    try {
      const current = fstatSync(fd)
      return current.isFile() && sameIdentity(owned.identity, current)
    } finally {
      closeSync(fd)
    }
  }

}
