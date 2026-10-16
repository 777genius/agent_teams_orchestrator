/** Child-local Windows realpath fallback. Root owns selection custody and DLL delivery. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type Callable = (...args: any[]) => any
type NativeLibrary = { symbols: Record<string, Callable>; close(): void }

export type WindowsRealpathSelection = Readonly<{
  dllPath: string
  expectedPid: number
  expectedCreationFiletime: bigint
  anchors: readonly Readonly<{ dosPath: string; ntPath: string; volumeSerial: bigint; fileId: string }>[]
}>
export type WindowsRealpathInstallation = Readonly<{ uninstall(): void }>

type Encoding = { kind: 'default' } | { kind: 'buffer' } | { kind: 'encoding'; encoding: BufferEncoding } | { kind: 'unsupported' }
type Diagnostics = Readonly<{ status: number; operation: number; win32: number }>
type Installation = {
  readonly native: NativeLibrary
  readonly anchors: WindowsRealpathSelection['anchors']
  readonly context: bigint
  readonly scratch: Readonly<{ output: Buffer; count: Buffer; error: Buffer }>
  active: boolean
  retiring: boolean
  state: 'installed' | 'retired' | 'unknown'
  closeError?: Diagnostics
}

export type WindowsRealpathFailure = Readonly<{ status: number; operation: number; win32: number; anchorCount: number; matchingAnchorIndex: number }>
const originalRealpathFailures = new WeakMap<Error, WindowsRealpathFailure>()
export function readWindowsRealpathFailure(error: unknown): WindowsRealpathFailure | undefined {
  return error instanceof Error ? originalRealpathFailures.get(error) : undefined
}
export function projectWindowsRealpathFailure(status: number, operation: number, win32: number,
  anchors: WindowsRealpathSelection['anchors'], routed: string): WindowsRealpathFailure | undefined {
  if (!Number.isSafeInteger(status) || status < 1 || status > 4 || !Number.isSafeInteger(operation) || operation < 0 || operation > 25 ||
      !Number.isSafeInteger(win32) || win32 < 0 || win32 > 0xffffffff || anchors.length > 4096) return undefined
  const matchingAnchorIndex = anchors.findIndex(anchor => {
    const relative = path.win32.relative(anchor.dosPath, routed)
    return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
  })
  return Object.freeze({ status, operation, win32, anchorCount: anchors.length, matchingAnchorIndex })
}
function retainNativeRealpathFailure(error: unknown, install: Installation, routed: string, status: number, bytes: Buffer) {
  if (!(error instanceof Error)) return
  const facts = errorFacts(bytes), projected = projectWindowsRealpathFailure(status, facts.operation, facts.win32, install.anchors, routed)
  if (projected) originalRealpathFailures.set(error, projected)
}

const MAX_CHARS = 32767
const OUTPUT_CAPACITY = 32768
const ANCHOR_SIZE = 56
const ERROR_SIZE = 8
const FILE_ID = /^[0-9a-f]{32}$/
const UINT64_MAX = (1n << 64n) - 1n

let attempted = false
let active: Installation | undefined
let retainedError: Error | undefined

const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CHARS && !value.includes('\0')
const uint64 = (value: unknown): value is bigint =>
  typeof value === 'bigint' && value >= 0n && value <= UINT64_MAX

function validateSelection(value: WindowsRealpathSelection): void {
  if (!value || typeof value !== 'object' || !bounded(value.dllPath) ||
      !Number.isSafeInteger(value.expectedPid) || value.expectedPid <= 0 || value.expectedPid > 0xffffffff ||
      !uint64(value.expectedCreationFiletime) || !Array.isArray(value.anchors) ||
      value.anchors.length < 1 || value.anchors.length > 4096) {
    throw new Error('windows_realpath_selection_invalid')
  }
  for (const anchor of value.anchors) {
    if (!anchor || typeof anchor !== 'object' || !bounded(anchor.dosPath) || !bounded(anchor.ntPath) ||
        !uint64(anchor.volumeSerial) || typeof anchor.fileId !== 'string' || !FILE_ID.test(anchor.fileId)) {
      throw new Error('windows_realpath_selection_invalid')
    }
  }
}

function pointerAddress(pointer: unknown): bigint {
  if (typeof pointer === 'bigint') return pointer
  if (typeof pointer === 'number' && Number.isSafeInteger(pointer) && pointer >= 0) return BigInt(pointer)
  const primitive = (pointer as { [Symbol.toPrimitive]?: unknown })?.[Symbol.toPrimitive]
  if (typeof primitive !== 'function') throw new Error('windows_realpath_pointer_conversion_failed')
  const converted = Reflect.apply(primitive, pointer, ['default'])
  if (typeof converted === 'bigint') return converted
  if (typeof converted === 'number' && Number.isSafeInteger(converted) && converted >= 0) return BigInt(converted)
  throw new Error('windows_realpath_pointer_conversion_failed')
}

const utf16 = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le')
const errorFacts = (buffer: Buffer): { operation: number; win32: number } =>
  ({ operation: buffer.readUInt32LE(0), win32: buffer.readUInt32LE(4) })
const initializationError = (value: Diagnostics): Error =>
  new Error(`windows_realpath_initialization_failed status=${value.status} operation=${value.operation} win32=${value.win32}`)

function isPermissionError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    ((error as { code?: unknown }).code === 'EPERM' || (error as { code?: unknown }).code === 'EACCES')
}

function route(value: string, cwd: string | undefined): string | undefined {
  if (/^[A-Za-z]:[\\/]/.test(value)) return value
  if (value.startsWith('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || !cwd ||
      !/^[A-Za-z]:[\\/]/.test(cwd)) return undefined
  return `${cwd.replace(/[\\/]+$/, '')}\\${value}`
}

function inputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) {
    for (const byte of value) if (byte > 0x7f || byte === 0) return undefined
    return value.toString('ascii')
  }
  if (value instanceof URL && value.protocol === 'file:') {
    try { return fileURLToPath(value) } catch { return undefined }
  }
  return undefined
}

function captureEncoding(value: unknown): Encoding {
  if (value === undefined) return { kind: 'default' }
  if (typeof value === 'string') {
    if (value === 'buffer') return { kind: 'buffer' }
    return Buffer.isEncoding(value) ? { kind: 'encoding', encoding: value as BufferEncoding } : { kind: 'unsupported' }
  }
  if (value === null || typeof value !== 'object') return { kind: 'unsupported' }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'encoding')
  if (!descriptor) return Reflect.has(value, 'encoding') ? { kind: 'unsupported' } : { kind: 'default' }
  return 'value' in descriptor ? captureEncoding(descriptor.value) : { kind: 'unsupported' }
}

function encode(path: string, encoding: Encoding): string | Buffer {
  const bytes = Buffer.from(path, 'utf8')
  return encoding.kind === 'buffer' ? bytes : bytes.toString(encoding.kind === 'encoding' ? encoding.encoding : 'utf8')
}

function validBoundedUtf16(buffer: Buffer, chars: number): boolean {
  if (chars < 1 || chars > MAX_CHARS || chars * 2 + 2 > buffer.length ||
      buffer.readUInt16LE(chars * 2) !== 0) return false
  for (let index = 0; index < chars; ++index) {
    const code = buffer.readUInt16LE(index * 2)
    if (code === 0) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= chars) return false
      const next = buffer.readUInt16LE((index + 1) * 2)
      if (next < 0xdc00 || next > 0xdfff) return false
      ++index
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function resolveNative(
  install: Installation,
  input: unknown,
  invocationCwd: string | undefined,
  encoding: Encoding,
  originalError: unknown,
): { handled: true; value: string | Buffer } | { handled: false } {
  if (!install.active || encoding.kind === 'unsupported') return { handled: false }
  const text = inputText(input)
  const routed = text === undefined ? undefined : route(text, invocationCwd)
  if (routed === undefined || routed.length < 1 || routed.length > MAX_CHARS || routed.includes('\0')) return { handled: false }
  try {
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    const inputBuffer = utf16(routed)
    // This non-callback FFI call and decoding are synchronous. Keep its bounded
    // scratch with this installation; no view escapes before the next call.
    const { output: outputBuffer, count: countBuffer, error: errorBuffer } = install.scratch
    outputBuffer.fill(0); countBuffer.fill(0); errorBuffer.fill(0)
    const status = install.native.symbols.RP_ResolveV1(
      install.context,
      ffi.ptr(inputBuffer),
      routed.length,
      ffi.ptr(outputBuffer),
      OUTPUT_CAPACITY,
      ffi.ptr(countBuffer),
      ffi.ptr(errorBuffer),
    )
    if (status !== 0) { retainNativeRealpathFailure(originalError, install, routed, status, errorBuffer); return { handled: false } }
    const count = countBuffer.readUInt32LE(0)
    if (!validBoundedUtf16(outputBuffer, count)) return { handled: false }
    return { handled: true, value: encode(outputBuffer.subarray(0, count * 2).toString('utf16le'), encoding) }
  } catch {
    return { handled: false }
  }
}

function fallback(
  originalError: unknown,
  args: readonly unknown[],
  invocationCwd: string | undefined,
  callbackStyle: boolean,
): { handled: true; value: string | Buffer } | { handled: false } {
  if (!active?.active || !isPermissionError(originalError)) return { handled: false }
  const encoding = captureEncoding(callbackStyle && args.length < 3 ? undefined : args[1])
  return resolveNative(active, args[0], invocationCwd, encoding, originalError)
}

function callbackFallback(args: readonly unknown[], invocationCwd: string | undefined): Callable {
  const user = args[args.length - 1] as Callable
  return function wrappedCallback(this: unknown, ...callbackArgs: unknown[]): unknown {
    const result = fallback(callbackArgs[0], args, invocationCwd, true)
    return Reflect.apply(user, this, result.handled ? [null, result.value] : callbackArgs)
  }
}

function callCallback(original: Callable, receiver: unknown, args: readonly unknown[]): unknown {
  const index = args.length - 1
  if (typeof args[index] !== 'function') return Reflect.apply(original, receiver, args)
  const invocationCwd = captureCwd()
  const callArgs = args.slice()
  callArgs[index] = callbackFallback(args, invocationCwd)
  return Reflect.apply(original, receiver, callArgs)
}

function captureCwd(): string | undefined {
  try { return process.cwd() } catch { return undefined }
}

function callSync(original: Callable, receiver: unknown, args: readonly unknown[]): unknown {
  const invocationCwd = captureCwd()
  try {
    return Reflect.apply(original, receiver, args)
  } catch (error) {
    const result = fallback(error, args, invocationCwd, false)
    if (result.handled) return result.value
    throw error
  }
}

function callPromise(original: Callable, receiver: unknown, args: readonly unknown[]): Promise<unknown> {
  const invocationCwd = captureCwd()
  return Promise.resolve(Reflect.apply(original, receiver, args)).catch((error: unknown) => {
    const result = fallback(error, args, invocationCwd, false)
    if (result.handled) return result.value
    throw error
  })
}

function wrapper(original: Callable, mode: 'sync' | 'callback' | 'promise'): Callable {
  if (mode === 'sync') return function realpathSync(this: unknown, ...args: unknown[]) { return callSync(original, this, args) }
  if (mode === 'callback') return function realpath(this: unknown, ...args: unknown[]) { return callCallback(original, this, args) }
  return function realpathPromises(this: unknown, ...args: unknown[]) { return callPromise(original, this, args) }
}

function setNative(value: Callable, native: Callable): void {
  Object.defineProperty(value, 'native', { value: native, configurable: true, enumerable: false, writable: false })
}

function openNative(selection: WindowsRealpathSelection): { library: NativeLibrary; context: bigint } {
  const ffi = require('bun:ffi') as typeof import('bun:ffi')
  const FFIType = ffi.FFIType
  const library = ffi.dlopen(selection.dllPath, {
    RP_OpenV1: { args: [FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    RP_ResolveV1: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    RP_CloseV1: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  }) as unknown as NativeLibrary
  const anchors = Buffer.alloc(selection.anchors.length * ANCHOR_SIZE)
  const retained: Buffer[] = []
  try {
    selection.anchors.forEach((anchor, index) => {
      const dos = utf16(anchor.dosPath), nt = utf16(anchor.ntPath)
      retained.push(dos, nt)
      const at = index * ANCHOR_SIZE
      anchors.writeBigUInt64LE(pointerAddress(ffi.ptr(dos)), at)
      anchors.writeUInt32LE(anchor.dosPath.length, at + 8)
      anchors.writeBigUInt64LE(pointerAddress(ffi.ptr(nt)), at + 16)
      anchors.writeUInt32LE(anchor.ntPath.length, at + 24)
      anchors.writeBigUInt64LE(anchor.volumeSerial, at + 32)
      Buffer.from(anchor.fileId, 'hex').copy(anchors, at + 40)
    })
    const contextBuffer = Buffer.alloc(8), errorBuffer = Buffer.alloc(ERROR_SIZE)
    const status = library.symbols.RP_OpenV1(
      selection.expectedPid,
      selection.expectedCreationFiletime,
      ffi.ptr(anchors),
      selection.anchors.length,
      ffi.ptr(contextBuffer),
      ffi.ptr(errorBuffer),
    )
    if (status !== 0) throw initializationError({ status, ...errorFacts(errorBuffer) })
    const context = contextBuffer.readBigUInt64LE(0)
    if (context === 0n) throw initializationError({ status: 4, operation: 7, win32: 11 })
    return { library, context }
  } catch (error) {
    try { library.close() } catch { /* preserve the original initialization error */ }
    throw error
  } finally {
    retained.length = 0
  }
}

type Surface = {
  object: Record<string, unknown>
  key: string
  descriptor: PropertyDescriptor
  original: Callable
  originalNative?: Callable
  replacement: Callable
}

function surfaces(): Surface[] {
  const fs = require('node:fs') as Record<string, any>
  const promises = require('node:fs/promises') as Record<string, any>
  const callbackNative = fs.realpath.native as Callable
  const syncNative = fs.realpathSync.native as Callable
  const callback = wrapper(fs.realpath as Callable, 'callback')
  const callbackNativeWrapper = wrapper(callbackNative, 'callback')
  const sync = wrapper(fs.realpathSync as Callable, 'sync')
  const syncNativeWrapper = wrapper(syncNative, 'sync')
  const promise = wrapper(promises.realpath as Callable, 'promise')
  setNative(callback, callbackNativeWrapper)
  setNative(sync, syncNativeWrapper)
  return [
    { object: fs, key: 'realpath', descriptor: Object.getOwnPropertyDescriptor(fs, 'realpath')!, original: fs.realpath, originalNative: callbackNative, replacement: callback },
    { object: fs, key: 'realpathSync', descriptor: Object.getOwnPropertyDescriptor(fs, 'realpathSync')!, original: fs.realpathSync, originalNative: syncNative, replacement: sync },
    { object: promises, key: 'realpath', descriptor: Object.getOwnPropertyDescriptor(promises, 'realpath')!, original: promises.realpath, replacement: promise },
  ]
}

function syncExports(): void {
  const module = require('node:module') as { syncBuiltinESMExports?: () => void }
  module.syncBuiltinESMExports?.()
}

function restore(items: readonly Surface[]): void {
  for (const item of items) Object.defineProperty(item.object, item.key, item.descriptor)
  syncExports()
}

function closeNative(library: NativeLibrary, context: bigint): Diagnostics {
  const ffi = require('bun:ffi') as typeof import('bun:ffi')
  const errorBuffer = Buffer.alloc(ERROR_SIZE)
  let status = 4
  try { status = library.symbols.RP_CloseV1(context, ffi.ptr(errorBuffer)) } catch { status = 4 }
  const facts = errorFacts(errorBuffer)
  if (status !== 0) return { status, ...facts }
  try { library.close() } catch { return { status: 4, operation: 24, win32: 11 } }
  return { status: 0, operation: 0, win32: 0 }
}

export function installWindowsRealpathFallback(selection: WindowsRealpathSelection): WindowsRealpathInstallation {
  if (attempted) throw retainedError ?? new Error('windows_realpath_already_initialized')
  attempted = true
  try {
    if (process.platform !== 'win32') throw new Error('windows_realpath_platform_unsupported')
    validateSelection(selection)
    if (selection.expectedPid !== process.pid) throw new Error('windows_realpath_selection_invalid')
    const scratch = { output: Buffer.alloc(OUTPUT_CAPACITY * 2), count: Buffer.alloc(4), error: Buffer.alloc(ERROR_SIZE) }
    const native = openNative(selection)
    let items: Surface[] = []
    try {
      items = surfaces()
      for (const item of items) Object.defineProperty(item.object, item.key, { ...item.descriptor, value: item.replacement })
      syncExports()
    } catch (error) {
      try { restore(items) } catch { /* retain the installation error */ }
      try { closeNative(native.library, native.context) } catch { /* retain */ }
      throw error
    }
    active = { anchors: selection.anchors, native: native.library, context: native.context, scratch,
      active: true, retiring: false, state: 'installed' }
    return Object.freeze({
      uninstall(): void {
        const current = active
        if (!current) {
          if (retainedError) throw retainedError
          return
        }
        if (current.retiring) return
        current.retiring = true
        current.active = false
        active = undefined
        try {
          restore(items)
          const closed = closeNative(current.native, current.context)
          if (closed.status !== 0) {
            current.state = 'unknown'
            current.closeError = closed
            throw initializationError(closed)
          }
          current.state = 'retired'
        } catch (error) {
          current.state = 'unknown'
          retainedError = error instanceof Error ? error : new Error('windows_realpath_uninstall_unknown')
          throw retainedError
        }
      },
    })
  } catch (error) {
    retainedError = error instanceof Error ? error : new Error('windows_realpath_initialization_failed')
    throw retainedError
  }
}
