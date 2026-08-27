import { dlopen, FFIType, ptr } from 'bun:ffi'

import { validOpenCodePublicationLeaf, validOpenCodePublicationRoot } from './OpenCodeWindowsPublicationAuthorityProtocol.js'
import { openCodeMonotonicNow } from './OpenCodeRuntimeDeadline.js'

type Handle = bigint
type Identity = Readonly<{ volumeSerial: bigint; fileId: bigint; size: bigint; directory: boolean }>
type OpenOptions = Readonly<{ deadline?: number; signal?: AbortSignal }>

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
const STATUS_NO_SUCH_FILE = -0x3fff_fff1
const STATUS_OBJECT_NAME_NOT_FOUND = -0x3fff_ffcc
const STATUS_OBJECT_PATH_NOT_FOUND = -0x3fff_ffc6
const FILE_DEVICE_DISK = 7
const FILE_REMOVABLE_MEDIA = 0x0000_0001
const FILE_REMOTE_DEVICE = 0x0000_0010

let kernel32: ReturnType<typeof dlopen> | undefined
let ntdll: ReturnType<typeof dlopen> | undefined
function win32(): any {
  kernel32 ??= dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    GetFileInformationByHandleEx: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    GetVolumeInformationByHandleW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
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
    NtQueryInformationFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    NtQueryVolumeInformationFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
  } as any)
  return ntdll.symbols as any
}

function wide(value: string): Buffer { return Buffer.from(`${value}\0`, 'utf16le') }
function rejected(): Error { return new Error('OpenCode passive Windows authority is unavailable [redacted]') }
function missing(): Error {
  return Object.assign(new Error('OpenCode passive Windows publication is unavailable [redacted]'), {
    code: 'ENOENT',
  })
}
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
  if (status === STATUS_NO_SUCH_FILE || status === STATUS_OBJECT_NAME_NOT_FOUND
    || status === STATUS_OBJECT_PATH_NOT_FOUND) throw missing()
  if (status < 0) throw rejected()
  const handle = result.readBigUInt64LE(0)
  if (handle === INVALID_HANDLE || handle === 0n) throw rejected()
  return handle
}

function identity(handle: Handle): Identity {
  // FileIdInfo is volume-qualified and carries the complete FILE_ID_128 on
  // both x64 and ARM64. FileBasicInformation (class 4) attests the object
  // behind the same handle; no pathname is consulted after the open.
  const fileIdInfo = Buffer.alloc(24)
  if (!win32().GetFileInformationByHandleEx(handle, 18, ptr(fileIdInfo), fileIdInfo.byteLength)) throw rejected()
  const basic = Buffer.alloc(40)
  const io = Buffer.alloc(16)
  if (Number(nt().NtQueryInformationFile(handle, ptr(io), ptr(basic), basic.byteLength, 4)) < 0) throw rejected()
  const attributes = basic.readUInt32LE(32)
  const standard = Buffer.alloc(24)
  if (Number(nt().NtQueryInformationFile(handle, ptr(io), ptr(standard), standard.byteLength, 5)) < 0) throw rejected()
  const size = standard.readBigUInt64LE(8)
  const fileId = fileIdInfo.readBigUInt64LE(8) | (fileIdInfo.readBigUInt64LE(16) << 64n)
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || fileId === 0n) throw rejected()
  return { volumeSerial: fileIdInfo.readBigUInt64LE(0), fileId, size,
    directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 }
}

function verifyFixedNtfs(handle: Handle): void {
  const filesystem = Buffer.alloc(64)
  if (!win32().GetVolumeInformationByHandleW(handle, null, 0, null, null, null, ptr(filesystem), 32)) throw rejected()
  if (filesystem.toString('utf16le').split('\0', 1)[0] !== 'NTFS') throw rejected()
  const device = Buffer.alloc(8)
  const io = Buffer.alloc(16)
  if (Number(nt().NtQueryVolumeInformationFile(handle, ptr(io), ptr(device), device.byteLength, 4)) < 0
    || device.readUInt32LE(0) !== FILE_DEVICE_DISK
    || (device.readUInt32LE(4) & (FILE_REMOVABLE_MEDIA | FILE_REMOTE_DEVICE)) !== 0) throw rejected()
}

type PassiveNativeContract = Readonly<{
  openAbsolute(target: string): Handle
  openRelative(parent: Handle, name: string, directory: boolean): Handle
  identity(handle: Handle): Identity
  verifyFixedNtfs(handle: Handle): void
  close(handle: Handle): void
}>

const nativeContract: PassiveNativeContract = {
  openAbsolute, openRelative, identity, verifyFixedNtfs, close: closeHandle,
}

function guard(options: OpenOptions): void {
  if (options.signal?.aborted || options.deadline !== undefined
    && (!Number.isFinite(options.deadline) || openCodeMonotonicNow() >= options.deadline)) throw rejected()
}

type RetainedComponent = Readonly<{ handle: Handle; value: Identity }>
type RetainedRoot = Readonly<{
  root: Handle
  rootIdentity: Identity
  volume: Handle
  volumeIdentity: Identity
  components: readonly RetainedComponent[]
}>

/** Retain the volume first, then resolve exactly one no-follow component at a time. */
function retainRoot(contract: PassiveNativeContract, rootPath: string, options: OpenOptions): RetainedRoot {
  guard(options)
  const volume = contract.openAbsolute(rootPath.slice(0, 3))
  let current = volume
  const retainedComponents: RetainedComponent[] = []
  try {
    const volumeIdentity = contract.identity(volume)
    if (!volumeIdentity.directory) throw rejected()
    contract.verifyFixedNtfs(volume)
    guard(options)
    const pathComponents = rootPath.slice(3).split('\\').filter(Boolean)
    for (const component of pathComponents) {
      const child = contract.openRelative(current, component, true)
      current = child
      const value = contract.identity(current)
      if (!value.directory || value.volumeSerial !== volumeIdentity.volumeSerial) throw rejected()
      retainedComponents.push({ handle: current, value })
      guard(options)
    }
    const rootIdentity = current === volume ? volumeIdentity : contract.identity(current)
    return { root: current, rootIdentity, volume, volumeIdentity, components: retainedComponents }
  } catch (error) {
    if (current !== volume && !retainedComponents.some(component => component.handle === current)) {
      contract.close(current)
    }
    for (const component of retainedComponents.reverse()) contract.close(component.handle)
    contract.close(volume)
    throw error
  }
}

/** Linux-safe native-contract seam; production always supplies the private FFI contract. */
export function testRetainWindowsPassiveRoot(
  contract: PassiveNativeContract, rootPath: string, options: OpenOptions = {},
): RetainedRoot {
  if (!validOpenCodePublicationRoot(rootPath)) throw rejected()
  return retainRoot(contract, rootPath, options)
}

/** In-process, zero-write Windows lease. Child access is relative to retained handles. */
export class OpenCodeWindowsPassiveReadAuthority {
  readonly #root: Handle
  readonly #rootIdentity: Identity
  readonly #volume: Handle | null
  readonly #volumeIdentity: Identity
  readonly #components: readonly RetainedComponent[]
  readonly #options: OpenOptions
  readonly #pins: Handle[] = []
  #closed = false

  private constructor(
    root: Handle, rootIdentity: Identity, volumeIdentity: Identity, options: OpenOptions,
    volume: Handle | null = null, components: readonly RetainedComponent[] = [],
  ) {
    this.#root = root; this.#rootIdentity = rootIdentity; this.#volumeIdentity = volumeIdentity
    this.#options = options; this.#volume = volume
    this.#components = components
  }

  static open(rootPath: string, options: OpenOptions = {}): OpenCodeWindowsPassiveReadAuthority {
    if (!validOpenCodePublicationRoot(rootPath)) throw rejected()
    const retained = retainRoot(nativeContract, rootPath, options)
    return new OpenCodeWindowsPassiveReadAuthority(
      retained.root, retained.rootIdentity, retained.volumeIdentity, options,
      retained.volume === retained.root ? null : retained.volume,
      retained.components,
    )
  }

  stableIdentity(): Readonly<{ dev: bigint; ino: bigint }> {
    return { dev: this.#rootIdentity.volumeSerial, ino: this.#rootIdentity.fileId }
  }

  validate(): void {
    guard(this.#options)
    if (this.#closed) throw rejected()
    if (this.#volume) {
      const volume = identity(this.#volume)
      if (!volume.directory || volume.volumeSerial !== this.#volumeIdentity.volumeSerial
        || volume.fileId !== this.#volumeIdentity.fileId) throw rejected()
    }
    for (const component of this.#components) {
      const current = identity(component.handle)
      if (!current.directory || current.volumeSerial !== component.value.volumeSerial
        || current.fileId !== component.value.fileId) throw rejected()
    }
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
      return new OpenCodeWindowsPassiveReadAuthority(child, childIdentity, this.#volumeIdentity, this.#options)
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

  async readBounded(
    name: string,
    maximumBytes: number,
    signal?: AbortSignal,
    afterIdentityCaptured?: () => void | Promise<void>,
  ): Promise<Uint8Array | null> {
    guard(this.#options)
    if (signal?.aborted || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw rejected()
    const pinned = this.#pinRegular(name)
    if (pinned.value.size > BigInt(maximumBytes)) return null
    await afterIdentityCaptured?.()
    guard(this.#options)
    if (signal?.aborted) throw rejected()
    const bytes = Buffer.alloc(maximumBytes + 1)
    const count = Buffer.alloc(4)
    if (!win32().ReadFile(pinned.handle, ptr(bytes), bytes.byteLength, ptr(count), null)) throw rejected()
    const bytesRead = count.readUInt32LE(0)
    guard(this.#options)
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
      guard(this.#options)
      restart = false
      if (status === STATUS_NO_MORE_FILES) break
      if (status < 0) throw rejected()
      const used = Number(io.readBigUInt64LE(8))
      let offset = 0
      while (offset + 94 <= used) {
        guard(this.#options)
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
    if (this.#components.length === 0) closeHandle(this.#root)
    else for (const component of [...this.#components].reverse()) closeHandle(component.handle)
    if (this.#volume) closeHandle(this.#volume)
  }
}
