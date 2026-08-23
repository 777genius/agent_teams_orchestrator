import { dlopen, FFIType, ptr, read } from 'bun:ffi'

import { validOpenCodePublicationLeaf, validOpenCodePublicationRoot } from './OpenCodeWindowsPublicationAuthorityProtocol.js'

type Handle = bigint
type Identity = Readonly<{ volumeSerial: bigint; fileId: bigint; size: bigint; directory: boolean }>

const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn
const FILE_ATTRIBUTE_DIRECTORY = 0x10
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
const OPEN_EXISTING = 3
const FILE_SHARE_READ = 1
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000
const FILE_READ_DATA = 0x0001
const FILE_LIST_DIRECTORY = 0x0001
const FILE_READ_ATTRIBUTES = 0x0080
const SYNCHRONIZE = 0x0010_0000
const OBJ_CASE_INSENSITIVE = 0x40
const FILE_DIRECTORY_FILE = 0x0000_0001
const FILE_SYNCHRONOUS_IO_NONALERT = 0x0000_0020
const FILE_NON_DIRECTORY_FILE = 0x0000_0040
const FILE_OPEN_REPARSE_POINT = 0x0020_0000
const FILE_BOTH_DIRECTORY_INFORMATION = 3
const STATUS_NO_MORE_FILES = -0x7fff_fffa

let kernel32: ReturnType<typeof dlopen> | undefined
let ntdll: ReturnType<typeof dlopen> | undefined
function win32(): any {
  kernel32 ??= dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
    GetVolumeInformationW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  } as any)
  return kernel32.symbols as any
}
function nt(): any {
  ntdll ??= dlopen('ntdll.dll', {
    NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32,
      FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    NtQueryDirectoryFile: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr,
      FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.bool, FFIType.ptr, FFIType.bool], returns: FFIType.i32 },
  } as any)
  return ntdll.symbols as any
}

function wide(value: string): Buffer { return Buffer.from(`${value}\0`, 'utf16le') }
function rejected(): Error { return new Error('OpenCode passive Windows authority is unavailable [redacted]') }
function address(buffer: Buffer): bigint { return BigInt(ptr(buffer) as unknown as number) }
function closeHandle(handle: Handle): void { try { win32().CloseHandle(handle) } catch {} }

function openAbsolute(target: string): Handle {
  const handle = BigInt(win32().CreateFileW(ptr(wide(target)), 0x8000_0000, FILE_SHARE_READ, null,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, 0n))
  if (handle === INVALID_HANDLE || handle === 0n) throw rejected()
  return handle
}

/** Opens a single validated leaf beneath the retained parent handle. No pathname is reopened. */
function openRelative(parent: Handle, name: string, directory: boolean): Handle {
  const nameBytes = Buffer.from(name, 'utf16le')
  const unicode = Buffer.alloc(16)
  unicode.writeUInt16LE(nameBytes.byteLength, 0)
  unicode.writeUInt16LE(nameBytes.byteLength, 2)
  unicode.writeBigUInt64LE(address(nameBytes), 8)
  const attributes = Buffer.alloc(48)
  attributes.writeUInt32LE(attributes.byteLength, 0)
  attributes.writeBigUInt64LE(parent, 8)
  attributes.writeBigUInt64LE(address(unicode), 16)
  attributes.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24)
  const result = Buffer.alloc(8)
  const io = Buffer.alloc(16)
  const access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | (directory ? FILE_LIST_DIRECTORY : FILE_READ_DATA)
  const options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
    | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE)
  const status = Number(nt().NtCreateFile(ptr(result), access, ptr(attributes), ptr(io), null, 0,
    FILE_SHARE_READ, 1, options, null, 0))
  if (status < 0) throw rejected()
  const handle = result.readBigUInt64LE(0)
  if (handle === INVALID_HANDLE || handle === 0n) throw rejected()
  return handle
}

function identity(handle: Handle): Identity {
  const info = Buffer.alloc(52)
  if (!win32().GetFileInformationByHandle(handle, ptr(info))) throw rejected()
  const attributes = read.u32(ptr(info), 0)
  const size = (BigInt(read.u32(ptr(info), 32)) << 32n) | BigInt(read.u32(ptr(info), 36))
  const fileId = (BigInt(read.u32(ptr(info), 44)) << 32n) | BigInt(read.u32(ptr(info), 48))
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || fileId === 0n) throw rejected()
  return { volumeSerial: BigInt(read.u32(ptr(info), 28)), fileId, size,
    directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 }
}

function verifyFixedNtfs(rootPath: string): void {
  const drive = wide(`${rootPath.slice(0, 3)}`)
  if (win32().GetDriveTypeW(ptr(drive)) !== 3) throw rejected()
  const filesystem = Buffer.alloc(64)
  if (!win32().GetVolumeInformationW(ptr(drive), null, 0, null, null, null, ptr(filesystem), 32)) throw rejected()
  if (filesystem.toString('utf16le').split('\0', 1)[0] !== 'NTFS') throw rejected()
}

/** In-process, zero-write Windows lease. Child access is relative to retained handles. */
export class OpenCodeWindowsPassiveReadAuthority {
  readonly #root: Handle
  readonly #rootIdentity: Identity
  readonly #pins: Handle[] = []
  #closed = false

  private constructor(root: Handle, rootIdentity: Identity) { this.#root = root; this.#rootIdentity = rootIdentity }

  static open(rootPath: string): OpenCodeWindowsPassiveReadAuthority {
    if (!validOpenCodePublicationRoot(rootPath)) throw rejected()
    verifyFixedNtfs(rootPath)
    const root = openAbsolute(rootPath)
    try {
      const rootIdentity = identity(root)
      if (!rootIdentity.directory) throw rejected()
      return new OpenCodeWindowsPassiveReadAuthority(root, rootIdentity)
    } catch (error) { closeHandle(root); throw error }
  }

  stableIdentity(): Readonly<{ dev: bigint; ino: bigint }> {
    return { dev: this.#rootIdentity.volumeSerial, ino: this.#rootIdentity.fileId }
  }

  validate(): void {
    if (this.#closed) throw rejected()
    const current = identity(this.#root)
    if (!current.directory || current.volumeSerial !== this.#rootIdentity.volumeSerial
      || current.fileId !== this.#rootIdentity.fileId) throw rejected()
  }

  openChild(name: string): OpenCodeWindowsPassiveReadAuthority {
    if (!validOpenCodePublicationLeaf(name)) throw rejected()
    this.validate()
    const child = openRelative(this.#root, name, true)
    try {
      const childIdentity = identity(child)
      if (!childIdentity.directory || childIdentity.volumeSerial !== this.#rootIdentity.volumeSerial) throw rejected()
      return new OpenCodeWindowsPassiveReadAuthority(child, childIdentity)
    } catch (error) { closeHandle(child); throw error }
  }

  #pinRegular(name: string): Readonly<{ handle: Handle; value: Identity }> {
    if (!validOpenCodePublicationLeaf(name)) throw rejected()
    this.validate()
    const retained = openRelative(this.#root, name, false)
    try {
      const value = identity(retained)
      if (value.directory || value.volumeSerial !== this.#rootIdentity.volumeSerial) throw rejected()
      this.#pins.push(retained)
      return { handle: retained, value }
    } catch (error) { closeHandle(retained); throw error }
  }

  pinRegular(name: string): Identity { return this.#pinRegular(name).value }

  async readBounded(name: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (signal?.aborted || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw rejected()
    const pinned = this.#pinRegular(name)
    if (pinned.value.size > BigInt(maximumBytes)) return null
    const bytes = Buffer.alloc(maximumBytes + 1)
    const count = Buffer.alloc(4)
    if (!win32().ReadFile(pinned.handle, ptr(bytes), bytes.byteLength, ptr(count), null)) throw rejected()
    const bytesRead = count.readUInt32LE(0)
    if (bytesRead > maximumBytes || signal?.aborted) return null
    const after = identity(pinned.handle)
    if (after.size !== pinned.value.size || after.fileId !== pinned.value.fileId
      || after.volumeSerial !== pinned.value.volumeSerial) throw rejected()
    this.validate()
    return bytes.subarray(0, bytesRead)
  }

  childNames(): readonly string[] {
    this.validate()
    const names: string[] = []
    let restart = true
    for (;;) {
      const output = Buffer.alloc(64 * 1024)
      const io = Buffer.alloc(16)
      const status = Number(nt().NtQueryDirectoryFile(this.#root, 0n, null, null, ptr(io), ptr(output),
        output.byteLength, FILE_BOTH_DIRECTORY_INFORMATION, false, null, restart))
      restart = false
      if (status === STATUS_NO_MORE_FILES) break
      if (status < 0) throw rejected()
      const used = Number(io.readBigUInt64LE(8))
      let offset = 0
      while (offset + 94 <= used) {
        const next = output.readUInt32LE(offset)
        const length = output.readUInt32LE(offset + 60)
        if ((length & 1) !== 0 || offset + 94 + length > used) throw rejected()
        const name = output.toString('utf16le', offset + 94, offset + 94 + length)
        if (name !== '.' && name !== '..') names.push(name)
        if (next === 0) break
        if (next < 94 || offset + next > used) throw rejected()
        offset += next
      }
    }
    this.validate()
    return names
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const handle of this.#pins.splice(0)) closeHandle(handle)
    closeHandle(this.#root)
  }
}
