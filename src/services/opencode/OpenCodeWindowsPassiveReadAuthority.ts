import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { constants as fsConstants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

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

let kernel32: ReturnType<typeof dlopen> | undefined
function symbols(): any {
  kernel32 ??= dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
    GetVolumeInformationW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
  } as any)
  return kernel32.symbols as any
}

function wide(value: string): Buffer { return Buffer.from(`${value}\0`, 'utf16le') }
function rejected(): Error { return new Error('OpenCode passive Windows authority is unavailable [redacted]') }

function openRetained(target: string, directory: boolean): Handle {
  const handle = BigInt(symbols().CreateFileW(ptr(wide(target)), 0x8000_0000, FILE_SHARE_READ, null,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), 0n))
  if (handle === INVALID_HANDLE || handle === 0n) throw rejected()
  return handle
}

function identity(handle: Handle): Identity {
  const info = Buffer.alloc(52)
  if (!symbols().GetFileInformationByHandle(handle, ptr(info))) throw rejected()
  const attributes = read.u32(ptr(info), 0)
  const size = (BigInt(read.u32(ptr(info), 32)) << 32n) | BigInt(read.u32(ptr(info), 36))
  const fileId = (BigInt(read.u32(ptr(info), 44)) << 32n) | BigInt(read.u32(ptr(info), 48))
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || fileId === 0n) throw rejected()
  return { volumeSerial: BigInt(read.u32(ptr(info), 28)), fileId, size,
    directory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 }
}

function verifyFixedNtfs(rootPath: string): void {
  const drive = wide(`${rootPath.slice(0, 3)}`)
  if (symbols().GetDriveTypeW(ptr(drive)) !== 3) throw rejected()
  const filesystem = Buffer.alloc(64)
  if (!symbols().GetVolumeInformationW(ptr(drive), null, 0, null, null, null, ptr(filesystem), 32)) throw rejected()
  const name = filesystem.toString('utf16le').split('\0', 1)[0]
  if (name !== 'NTFS') throw rejected()
}

/** In-process, read-only Windows lease. It loads a system DLL but never starts a process. */
export class OpenCodeWindowsPassiveReadAuthority {
  readonly #rootPath: string
  readonly #root: Handle
  readonly #rootIdentity: Identity
  readonly #pins: Handle[] = []
  #closed = false

  private constructor(rootPath: string, root: Handle, rootIdentity: Identity) {
    this.#rootPath = rootPath; this.#root = root; this.#rootIdentity = rootIdentity
  }

  static open(rootPath: string): OpenCodeWindowsPassiveReadAuthority {
    if (!validOpenCodePublicationRoot(rootPath)) throw rejected()
    verifyFixedNtfs(rootPath)
    const root = openRetained(rootPath, true)
    try {
      const rootIdentity = identity(root)
      if (!rootIdentity.directory) throw rejected()
      return new OpenCodeWindowsPassiveReadAuthority(rootPath, root, rootIdentity)
    } catch (error) { try { symbols().CloseHandle(root) } catch {}; throw error }
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
    return OpenCodeWindowsPassiveReadAuthority.open(path.win32.join(this.#rootPath, name))
  }

  pinRegular(name: string): Identity {
    if (!validOpenCodePublicationLeaf(name)) throw rejected()
    this.validate()
    const retained = openRetained(path.win32.join(this.#rootPath, name), false)
    try {
      const value = identity(retained)
      if (value.directory) throw rejected()
      this.#pins.push(retained)
      return value
    } catch (error) { try { symbols().CloseHandle(retained) } catch {}; throw error }
  }

  async readBounded(name: string, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (signal?.aborted) throw rejected()
    const expected = this.pinRegular(name)
    if (expected.size > BigInt(maximumBytes)) return null
    let handle: FileHandle | undefined
    try {
      handle = await open(path.win32.join(this.#rootPath, name), fsConstants.O_RDONLY)
      const bytes = Buffer.alloc(maximumBytes + 1)
      const result = await handle.read(bytes, 0, bytes.length, 0)
      if (result.bytesRead > maximumBytes || signal?.aborted) return null
      this.validate()
      return bytes.subarray(0, result.bytesRead)
    } finally { await handle?.close().catch(() => undefined) }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const handle of this.#pins.splice(0)) try { symbols().CloseHandle(handle) } catch {}
    try { symbols().CloseHandle(this.#root) } catch {}
  }
}
