/* eslint-disable custom-rules/no-process-exit -- Finite TEST controller exits only after durable evidence; never signals the native host. */
import { constants, writeSync } from 'node:fs'
import { coldFailureCodes, coldErrnoCodes, coldProgressPrefix, type ColdProgress, type ColdProgressPhase } from '../OpenCodeNativeColdDiagnostics.js'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { OpenCodeHostManager } from '../../OpenCodeHostManager.js'
import { OpenCodeClientFactory } from '../../OpenCodeClientFactory.js'
import type { OpenCodePreparedProfile } from '../../types.js'
import { nativeCustodyForRequest, nativeHelperFailureDiagnostic, type NativeCustodyReference } from '../OpenCodeNativeCustody.js'
import { nativeAuthorityPath, nativeExitConfirmed, readNativeAuthority } from '../OpenCodeNativeAuthority.js'

export type ColdInput = {
  schemaVersion: 1; caseId: string; version: '1.16.0' | '1.18.34'; hostKey: string
  dataRoot: string; evidence: string; binary: string; helper: string; profile: OpenCodePreparedProfile
}
export type PublicEpoch = {
  epoch: string; bootId: string; nativePid: number; nativeBirth: string; custodianPid: number; custodianBirth: string
  scopeDigest: string; imageSha256: string; helperSha256: string; measuredVersion: string; baseUrl: string
}
export type ReadyReceipt = { schemaVersion: 1; caseId: string; controllerPid: number; epoch: PublicEpoch; sessionId: string }
type ColdFailurePhase = 'source-binding' | 'sentinel-start' | 'sentinel-before' | 'A-exit' | 'A-validate' |
  'B-exit' | 'B-validate' | 'closure' | 'controller-input' | 'controller-public-receipt' |
  'controller-admission' | 'controller-config' | 'controller-session-create' | 'controller-ready-receipt' |
  'controller-session-read' | 'controller-stop' | 'controller-receipt' | 'sentinel-close' | 'native-same-path'
function progress(input: ColdInput, role: ColdProgress['role'], phase: ColdProgressPhase, error?: unknown): void {
  // One small synchronous write distinguishes evidence fsync tail from JS exit.
  // Failure to write telemetry cannot alter the custody/test outcome.
  const diagnostic = error === undefined ? { errorClass: 'none', code: 'none' } : failureDiagnostic(controllerPhase, error)
  try { writeSync(2, `${coldProgressPrefix}${JSON.stringify({ protocol: 1, caseId: input.caseId, role, phase,
    errorClass: diagnostic.errorClass, code: diagnostic.code })}\n`) } catch { /* Diagnostic only. */ }
}
let controllerPhase: ColdFailurePhase = 'controller-input'
export function failureDiagnostic(phase: ColdFailurePhase, error: unknown): { phase: ColdFailurePhase; errorClass: string; code: string; nativeHelper?: ReturnType<typeof nativeHelperFailureDiagnostic> } {
  let errorClass = 'other', code = 'other'
  // Inspect descriptors only: neither code/message getters nor custom error
  // serialization may expose a path, configuration, provider output or token.
  try {
    if (error !== null && typeof error === 'object') {
      const prototype = Object.getPrototypeOf(error)
      for (const [candidate, label] of [[TypeError.prototype, 'TypeError'], [SyntaxError.prototype, 'SyntaxError'],
        [RangeError.prototype, 'RangeError'], [Error.prototype, 'Error']] as const) {
        if (prototype === candidate) { errorClass = label; break }
      }
      const ownData = (key: string): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(error, key)
        return descriptor && 'value' in descriptor ? descriptor.value : undefined
      }
      const ownCode = ownData('code')
      if (typeof ownCode === 'string' && ownCode.length <= 64 &&
        (coldErrnoCodes.has(ownCode) || coldFailureCodes.has(ownCode))) code = ownCode
      else {
        const ownMessage = ownData('message')
        // Native/test errors carry fixed phase codes as their message. Only an
        // exact reviewed constant may be emitted, never a raw message or stack.
        if (typeof ownMessage === 'string' && coldFailureCodes.has(ownMessage)) code = ownMessage
      }
    }
  } catch { /* Exotic/proxy errors remain bounded unknown diagnostics. */ }
  return { phase, errorClass, code, nativeHelper: nativeHelperFailureDiagnostic(error) }
}
export function fact(value: unknown, code = 'TEST_cold_contract'): asserts value { if (!value) throw new Error(code) }
export function publicEpoch(reference: NativeCustodyReference): PublicEpoch {
  return { epoch: reference.epoch, bootId: reference.bootId, nativePid: reference.nativePid, nativeBirth: reference.nativeBirth,
    custodianPid: reference.custodianPid, custodianBirth: reference.custodianBirth, scopeDigest: reference.scopeDigest,
    imageSha256: reference.images.imageIdentity.sha256, helperSha256: reference.images.helperIdentity.sha256,
    measuredVersion: reference.measuredVersion, baseUrl: reference.baseUrl }
}
export async function readPrivateJson<T>(file: string, expectedIdentity?: { dev: string; ino: string }): Promise<T> {
  const info = await lstat(file, { bigint: true })
  fact(info.isFile() && !info.isSymbolicLink() && info.uid === BigInt(process.getuid!()) &&
    (info.mode & 0o777n) === 0o600n && info.size > 0n && info.size <= 256000n)
  if (info.nlink !== 1n) throw Object.assign(new Error('TEST_cold_publication_incomplete'), { code: 'EINPROGRESS' })
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const held = await handle.stat({ bigint: true })
    fact(held.dev === info.dev && held.ino === info.ino)
    if (expectedIdentity) fact(String(held.dev) === expectedIdentity.dev && String(held.ino) === expectedIdentity.ino)
    return JSON.parse(await handle.readFile('utf8')) as T
  } finally { await handle.close() }
}
/** Fresh case directories + exclusive files make every attempt visible, never overwritten. */
export async function evidence(input: ColdInput, name: string, value: unknown,
  failure?: { phase: ColdFailurePhase; error: unknown }): Promise<void> {
  fact(/^[A-Za-z0-9-]+\.json$/.test(name))
  const payload = failure ? { ...value as Record<string, unknown>, failure: failureDiagnostic(failure.phase, failure.error) } : value
  const bytes = Buffer.from(JSON.stringify(payload))
  fact(bytes.length <= 32768)
  const file = path.join(input.evidence, name)
  const pending = `${file}.pending`
  const handle = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await link(pending, file)
  await unlink(pending)
  const directory = await open(input.evidence, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

async function run(input: ColdInput, role: 'A' | 'B'): Promise<void> {
  // B does not consult the installer or launch a replacement. Only the durable
  // prepared profile, registry and original native custodian can admit it.
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = input.dataRoot
  if (role === 'A') {
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = input.binary
    process.env.CLAUDE_MULTIMODEL_OPENCODE_CUSTODY_HELPER = input.helper
    delete process.env.OPENCODE_BIN_PATH
  }
  controllerPhase = 'controller-public-receipt'
  const serialized = role === 'B' ? await readPrivateJson<ReadyReceipt>(path.join(input.evidence, 'A-ready.json')) : undefined
  if (serialized) {
    let refused = false
    try { await new OpenCodeClientFactory().create(serialized.epoch.baseUrl, undefined, serialized).getConfig() }
    catch (error) { refused = error instanceof Error && error.message === 'native_custody_unavailable' }
    fact(refused) // A public JSON receipt cannot grant B an HTTP capability.
  }
  const manager = new OpenCodeHostManager()
  controllerPhase = 'controller-admission'
  await evidence(input, `${role}-admission-intent.json`, { schemaVersion: 1, role, caseId: input.caseId })
  const host = await manager.ensureHost({ hostKey: input.hostKey, preparedProfile: input.profile,
    ...(role === 'B' ? { existingOnly: true } : { hostLifetime: 'persistent' as const }),
    resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
  const custody = nativeCustodyForRequest(host, host.baseUrl)
  fact(custody.reference.measuredVersion === input.version && host.version === input.version)
  const captured = publicEpoch(custody.reference)
  const authorityFile = nativeAuthorityPath(input.profile.profileRootPath, input.hostKey)
  const before = await readNativeAuthority(authorityFile)
  fact(before.phase === 'published' && !await nativeExitConfirmed(before))
  const prior = serialized
  if (prior) fact(prior.caseId === input.caseId && prior.controllerPid !== process.pid &&
    JSON.stringify(prior.epoch) === JSON.stringify(captured))
  const client = new OpenCodeClientFactory().create(host.baseUrl, undefined, host)
  controllerPhase = 'controller-config'
  const config = await client.getConfig()
  const expected = `Bearer TEST-cold-${input.caseId}`
  const observed = (config as { mcp?: { fixture?: { headers?: { Authorization?: string } } } }).mcp?.fixture?.headers?.Authorization
  fact(observed === expected)
  const witness = createHash('sha256').update(expected).digest('hex')
  if (role === 'A') {
    controllerPhase = 'controller-session-create'
    // Exactly one safe mutation, no model/provider request and no retry after an
    // uncertain outcome. A-ready exists only after the native response is read.
    await evidence(input, 'A-session-create-intent.json', { schemaVersion: 1, caseId: input.caseId })
    const session = await client.createSession({ title: `TEST-cold-${input.caseId}` })
    fact(typeof session.id === 'string' && session.id.length > 0 && session.id.length <= 256)
    await custody.verify()
    controllerPhase = 'controller-ready-receipt'
    progress(input, role, 'ready-write-start')
    await evidence(input, 'A-ready.json', { schemaVersion: 1, caseId: input.caseId, controllerPid: process.pid,
      epoch: captured, sessionId: session.id, configWitnessSha256: witness,
      termination: 'deliberate-js-exit-after-flush-without-host-dispose' })
    progress(input, role, 'ready-write-complete')
    return // The entrypoint exits this JS controller, never manager.disposeHost().
  }
  fact(prior)
  controllerPhase = 'controller-session-read'
  const session = await client.getSession(prior.sessionId)
  fact(session.id === prior.sessionId)
  await evidence(input, 'B-recovered.json', { schemaVersion: 1, caseId: input.caseId, controllerPid: process.pid,
    epoch: captured, sessionRead: true, configWitnessSha256: witness, authorityPhase: before.phase,
    nativeExitAlreadyPresent: false })
  // Persist intent before the sole Stop. No catch may retry it after uncertainty.
  controllerPhase = 'controller-stop'
  await evidence(input, 'B-stop-intent.json', { schemaVersion: 1, caseId: input.caseId, epoch: captured.epoch })
  fact(await manager.disposeHost(input.hostKey))
  await manager.drainPendingLifecycleCleanups()
  controllerPhase = 'controller-receipt'
  const after = await readNativeAuthority(authorityFile)
  fact(after.phase === 'dead' && after.images.epoch === captured.epoch && await nativeExitConfirmed(after))
  const exit = await readPrivateJson<{ protocol: number; epoch: string; pid: number; birth: string; status: number }>(
    after.images.exitReceipt.file, after.images.exitReceipt)
  fact(exit.protocol === 1 && exit.epoch === captured.epoch && exit.pid === captured.nativePid && exit.birth === captured.nativeBirth)
  await evidence(input, 'B-stopped.json', { schemaVersion: 1, caseId: input.caseId, epoch: captured,
    authorityPhase: after.phase, nativeExitConfirmed: true,
    exitReceipt: { protocol: exit.protocol, epoch: exit.epoch, pid: exit.pid, birth: exit.birth, status: exit.status },
    exitReceiptIdentity: { dev: after.images.exitReceipt.dev, ino: after.images.exitReceipt.ino },
    treeProof: 'captured-custodian-exit-FD-receipt; no independent tree census claimed' })
}

async function sentinel(input: ColdInput): Promise<void> {
  controllerPhase = 'sentinel-start'
  const server = createServer((request, response) => {
    response.setHeader('connection', 'close')
    if (request.method !== 'GET' || request.url !== '/TEST-sentinel') { response.writeHead(404); response.end(); return }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ caseId: input.caseId }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); fact(address && typeof address !== 'string')
  await evidence(input, 'sentinel-ready.json', { schemaVersion: 1, caseId: input.caseId, controllerPid: process.pid, port: address.port })
  // The parent owns this exact stdin pipe. EOF is a finite shutdown handoff too.
  let packet = ''
  controllerPhase = 'sentinel-close'
  for await (const chunk of process.stdin) {
    packet += String(chunk); fact(packet.length <= 1024)
    if (packet.includes('\n')) break
  }
  fact(packet.trim() === `close:${input.caseId}`)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await evidence(input, 'sentinel-closed.json', { schemaVersion: 1, caseId: input.caseId, controllerPid: process.pid })
}

if (import.meta.main) {
  let input: ColdInput | undefined
  const role = process.argv[2]
  try {
    fact(process.platform === 'linux' && ['A', 'B', 'sentinel'].includes(role))
    input = await readPrivateJson<ColdInput>(process.argv[3])
    fact(input.schemaVersion === 1 && /^TEST-cold-[a-f0-9]{16}$/.test(input.caseId) && path.isAbsolute(input.evidence))
    if (role === 'sentinel') await sentinel(input)
    else await run(input, role as 'A' | 'B')
    progress(input, role as ColdProgress['role'], 'role-run-returned')
    // This proves OS controller exit, not native/helper/tree death. All evidence
    // and native HTTP bodies above have completed before the deliberate exit.
    progress(input, role as ColdProgress['role'], 'exit-requested')
    process.exit(0)
  } catch (error) {
    if (input && ['A', 'B', 'sentinel'].includes(role)) progress(input, role as ColdProgress['role'], 'caught-error', error)
    if (input) await evidence(input, `${role}-failed.json`, { schemaVersion: 1, caseId: input.caseId,
      phase: role === 'A' ? 'A-effect-unknown' : role === 'B' ? 'B-effect-unknown' : 'sentinel-incomplete', preserve: true },
      { phase: controllerPhase, error }).catch(() => undefined)
    process.exit(1)
  }
}
