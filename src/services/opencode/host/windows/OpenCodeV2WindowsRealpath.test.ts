import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Execute the actual private openNative body with the FFI boundary replaced:
// a real-time AV scan can transiently deny the helper DLL at LoadLibrary, and
// the bounded retry must absorb exactly that class without hiding real errors.
describe('windows realpath native open', () => {
  const selection = { dllPath: 'C:\\TEST\\realpath-helper.dll', expectedPid: 42, expectedCreationFiletime: 42n,
    anchors: [{ dosPath: 'C:\\TEST', ntPath: '\\??\\C:\\TEST', volumeSerial: 7n,
      fileId: '0123456789abcdef0123456789abcdef' }] }
  async function openNativeWith(mode: { transientFailures: number } | { persistentError: Error }) {
    const source = await readFile(path.resolve(import.meta.dir, './OpenCodeV2WindowsRealpath.ts'), 'utf8')
    const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(
      source.indexOf('function openNative('), source.indexOf('type Surface')))
    let calls = 0, closed = 0
    const library = { symbols: { RP_OpenV1: (...args: unknown[]) => {
      (args[4] as Buffer).writeBigUInt64LE(42n, 0); return 0 },
      RP_ResolveV1: () => 0, RP_CloseV1: () => 0 }, close: () => { closed++ } }
    const ffi = { FFIType: { u32: 1, u64: 2, ptr: 3, i32: 4 }, ptr: (value: Buffer) => value,
      dlopen: () => {
        calls++
        if ('persistentError' in mode) throw mode.persistentError
        if (calls <= mode.transientFailures) throw new Error('TEST-av-load-denied')
        return library
      } }
    const scope = {
      require: (id: string) => { expect(id).toBe('bun:ffi'); return ffi },
      utf16: (value: string) => Buffer.from(value + '\0', 'utf16le'),
      pointerAddress: () => 8n, ANCHOR_SIZE: 48, ERROR_SIZE: 32, errorFacts: () => ({}),
      initializationError: (facts: Record<string, unknown>) => Object.assign(new Error('windows_realpath_initialization_failed'), facts),
    }
    const openNative = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return openNative;`)(scope) as
      (selection: unknown) => { library: unknown; context: bigint }
    try { return { value: openNative(selection) as unknown, error: undefined as unknown, calls, closed } }
    catch (error) { return { value: undefined as unknown, error, calls, closed } }
  }
  test('transient LoadLibrary denial is retried and the original failure is rethrown', async () => {
    const recovered = await openNativeWith({ transientFailures: 2 })
    expect(recovered.error).toBeUndefined()
    expect(recovered.calls).toBe(3)
    expect((recovered.value as { context: bigint }).context).toBe(42n)
    const persistent = new Error('TEST-dll-missing')
    const failed = await openNativeWith({ persistentError: persistent })
    expect(failed.calls).toBe(3)
    expect(failed.error).toBe(persistent)
    expect(failed.closed).toBe(0) // A failed load owns no library handle to close.
  })
})
