import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

// Execute the actual private child bodies: the native DLL refuses a second
// held anchor for one physical object, and a prepare-time refusal must leave
// the child through a closed startup cause rather than a raw message.
const controlSource = () => readFile(path.resolve(import.meta.dir, './OpenCodeV2WindowsChildControl.ts'), 'utf8')

function composedBody(source: string): string {
  const assertBody = source.slice(source.indexOf('function assert('), source.indexOf('export type WindowsChildControl'))
  const stateBody = source.slice(source.indexOf('function record('), source.indexOf('export function windowsExecutionSelfBirth'))
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${assertBody}\nlet realpathReceiptId, realpathInstallation, realpathClose, preparing = false;\n${stateBody.replaceAll('export ', '')}`)
}

const anchorsReceipt = (nonce: string, anchors: readonly Record<string, unknown>[]) => ({
  nonce, receiptId: `windows-anchors:4242:${process.pid}:133000000000000000`, anchors,
})

test('one physical object never reaches the native DLL as two held anchors', async () => {
  const body = composedBody(await controlSource())
  const scope = {
    path,
    Object, String, Number, BigInt, Date, Promise, Error, structuredClone,
    authenticatedPrepares: new WeakMap(),
    windowsExecutionChildControl: () => ({ send: async () => {}, events: { on() {} } }),
  }
  const built = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return childRealpathSelection;`)(scope) as
    (input: Record<string, unknown>, birth: Record<string, unknown>) => { anchors: readonly { dosPath: string }[] }
  const sameObject = { volumeSerial: '7', fileId: 'a'.repeat(32) }
  const receipt = anchorsReceipt('TEST-nonce', [
    { kind: 'readOnly', admittedPath: 'C:\\alpha', dosPath: 'C:\\alpha', ntPath: '\\Device\\HarddiskVolume3\\alpha', ...sameObject },
    { kind: 'writable', admittedPath: 'C:\\beta', dosPath: 'C:\\beta', ntPath: '\\Device\\HarddiskVolume3\\beta', fileId: 'b'.repeat(32), volumeSerial: '7' },
    // Distinct kind and spelling, same physical object as the first anchor.
    { kind: 'metadata', admittedPath: 'C:\\ALPHA', dosPath: 'C:\\ALPHA', ntPath: '\\Device\\HarddiskVolume3\\alpha', ...sameObject },
  ])
  const selection = built({
    nonce: 'TEST-nonce',
    supervisor: { nativePID: 4242 },
    realpathAnchors: receipt,
    realpathDll: { nonce: 'TEST-nonce', receiptId: `windows-dll:4242:${process.pid}:133000000000000000`, held: true,
      path: 'C:\\TEST\\native-realpath-TEST-nonce\\opencode-v2-windows-realpath.dll', sha256: 'c'.repeat(64),
      fileId: 'd'.repeat(32), volumeSerial: '7' },
  }, { format: 'windows-filetime', value: '133000000000000000', bootId: null })
  // Both spellings of the object collapse to one anchor; the distinct object stays.
  expect(selection.anchors.map(anchor => anchor.dosPath)).toEqual(['C:\\alpha', 'C:\\beta'])
})

test('a prepare-time realpath refusal reports a closed startup cause', async () => {
  const source = await controlSource()
  const body = composedBody(source)
  const nonce = '11111111-1111-4111-8111-111111111111', lease = '22222222-2222-4222-8222-222222222222'
  const previous = [process.env.OPENCODE_V2_WINDOWS_NONCE, process.env.OPENCODE_V2_WINDOWS_LEASE]
  process.env.OPENCODE_V2_WINDOWS_NONCE = nonce
  process.env.OPENCODE_V2_WINDOWS_LEASE = lease
  try {
    const scope = {
      path,
      Object, String, Number, BigInt, Date, Promise, Error, structuredClone,
      authenticatedPrepares: new WeakMap<object, Record<string, unknown>>(),
      windowsExecutionChildControl: () => ({ send: async () => {} }),
    }
    const built = new Function('scope', `const {${Object.keys(scope).join(',')}}=scope;${body};return prepareWindowsExecutionChild;`)(scope) as
      (value: unknown) => Promise<unknown>
    const value = {
      type: 'prepare', nonce, leaseOwnerId: lease, namespace: `windows-job:${nonce}`,
      executableSha256: 'f'.repeat(64),
      birth: { format: 'windows-filetime', value: '133000000000000000', bootId: null },
      supervisor: { nativePID: 4242 },
      realpathAnchors: anchorsReceipt(nonce, [
        { kind: 'readOnly', admittedPath: 'C:\\alpha', dosPath: 'C:\\alpha', ntPath: '\\Device\\HarddiskVolume3\\alpha',
          volumeSerial: '7', fileId: 'a'.repeat(32) },
      ]),
      realpathDll: { nonce, receiptId: `windows-dll:4242:${process.pid}:133000000000000000`, held: true,
        path: 'C:\\TEST\\native-realpath-' + nonce + '\\opencode-v2-windows-realpath.dll', sha256: 'c'.repeat(64),
        fileId: 'd'.repeat(32), volumeSerial: '7' },
    }
    scope.authenticatedPrepares.set(value, structuredClone(value))
    let rejection: unknown
    try { await built(value) } catch (error) { rejection = error }
    expect(rejection).toBeDefined()
    // The producer must fail through the closed startup vocabulary, never raw.
    expect(['execution_realpath_unavailable', 'execution_realpath_install_failed'])
      .toContain((rejection as Error).message)
    // And the actual reporter must keep that message as its closed cause.
    const report = await readFile(path.resolve(import.meta.dir, '../../../../entrypoints/opencodeV2ExecutionServer.ts'), 'utf8')
    const start = report.indexOf('function reportStartupFailure('), end = report.indexOf('\n// A source graph', start)
    expect(start >= 0 && end > start).toBe(true)
    let emitted = ''
    const context = {
      Error, Date, runtimeReady: false, startupFailureReported: false, startupStage: 'waiting-for-prepare',
      startupStartedAt: Date.now() - 41, startupHistory: [{ stage: 'waiting-for-prepare', elapsedMs: 0 }],
      environmentMismatchKeys: [], executionProfileGuards: [], readExecutionGraphFailure: () => undefined,
      graphProgress: undefined,
      process: { stderr: { write: (line: string) => { emitted += line } } },
      original: rejection as Error,
    }
    runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(report.slice(start, end)) + "\nreportStartupFailure('failed', original)", context)
    const startup = JSON.parse(emitted)
    expect(startup.cause).toBe((rejection as Error).message)
    expect(startup.errno).toBe((rejection as { code?: string }).code)
    expect(emitted).not.toContain('windows_realpath_')
  } finally {
    const restore = (name: string, value: string | undefined) =>
      value === undefined ? delete process.env[name] : (process.env[name] = value)
    restore('OPENCODE_V2_WINDOWS_NONCE', previous[0])
    restore('OPENCODE_V2_WINDOWS_LEASE', previous[1])
  }
})
