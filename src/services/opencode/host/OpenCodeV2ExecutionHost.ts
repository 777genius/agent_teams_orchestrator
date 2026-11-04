import { openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { assertSelectedOpenCodeV2ControllerState, deriveSelectedOpenCodeV2ControllerState } from './OpenCodeV2Profile.js'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { realpath } from 'node:fs/promises'
import { resolveOpenCodeV2ExecutionDelivery } from './OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { assertOpenCodeV2Launchable, isOpenCodeV2Identity } from '../compatibility/OpenCodeV2Registry.js'
import { executionAssert, executionHash, executionRecord, openCodeV2ActivationDeadline, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { awaitOpenCodeV2ExecutionReadiness, awaitOpenCodeV2CatalogReadiness } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { canonicalExecutionDirectory, readExecutionBirth, validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type ExecutionGraph, type ExecutionGraphValidation, type OwnedNativeProfile, type CatalogExecutionProfile, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { retireExecutionChild, type ExecutionCleanupReceipt } from './OpenCodeV2ExecutionLifecycle.js'
import { assertExecutionPlatformAvailable, launchExecutionPlatform, planExecutionPlatform,
  type ExecutionPlatformLaunch, type ExecutionPlatformMapping } from './OpenCodeV2ExecutionPlatform.js'
import { acquireExecutionProfileOwner } from './OpenCodeV2ExecutionOwner.js'
import { initializeOpenCodeV2ExecutionAuth } from './OpenCodeV2ExecutionAuth.js'
import { recordOpenCodeV2ProviderFailure, type ExecutionAcquisitionPhase, type ExecutionAcquisitionTiming,
  type ExecutionCleanupExitClass, type ExecutionCleanupPhase, type ExecutionCleanupObservation, type ExecutionCommandObservation } from '../execution/OpenCodeV2Diagnostics.js'

export type { SelectedExecutionProfile, ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
type PrivateEndpointFields = { baseUrl: string; password: string; signal: AbortSignal; nativePID: number; fetch?: typeof globalThis.fetch }
type PrivateEndpoint = Readonly<PrivateEndpointFields>
const catalogAuthorities = new WeakSet<ExecutionAuthority>()
export function executionAuthorityIsCatalogOnly(authority: ExecutionAuthority): boolean { return catalogAuthorities.has(authority) }
const endpoints = new WeakMap<ExecutionAuthority, PrivateEndpointFields>()
const graphs = new WeakMap<ExecutionAuthority, ExecutionGraph>()
const disposers = new WeakMap<ExecutionAuthority, Set<() => Promise<void>>>()
const cleanupObservations = new WeakMap<ExecutionLease, () => ExecutionCleanupObservation | undefined>()
/** Exact acquired lease only. This snapshot is diagnostic and grants no cleanup authority. */
export function readExecutionCleanupObservation(lease: ExecutionLease): ExecutionCleanupObservation | undefined {
  try { return cleanupObservations.get(lease)?.() } catch { return undefined }
}
export type ExecutionLeaseObservation = Readonly<{ acquisition: ExecutionAcquisitionTiming; commands?: ExecutionCommandObservation }>
const leaseObservations = new WeakMap<ExecutionLease, () => ExecutionLeaseObservation>()
/** Exact acquired lease only: its successful acquisition timing and native
 * command channel facts. Diagnostic data; it grants no lease or cleanup authority. */
export function readExecutionLeaseObservation(lease: ExecutionLease): ExecutionLeaseObservation | undefined {
  try { return leaseObservations.get(lease)?.() } catch { return undefined }
}
export function requireExecutionEndpoint(authority: ExecutionAuthority): PrivateEndpoint {
  const endpoint = endpoints.get(authority)
  executionAssert(endpoint && !endpoint.signal.aborted, 'execution_lease_not_owned')
  return endpoint
}
export function requireExecutionGraph(authority: ExecutionAuthority): ExecutionGraph {
  requireExecutionEndpoint(authority)
  const graph = graphs.get(authority)
  executionAssert(graph, 'execution_lease_not_owned')
  return graph
}
export function registerExecutionDisposer(authority: ExecutionAuthority, dispose: () => Promise<void>): () => void {
  requireExecutionEndpoint(authority)
  const rows = disposers.get(authority)
  executionAssert(rows, 'execution_lease_not_owned')
  rows.add(dispose)
  return () => { rows.delete(dispose) }
}
export type ExecutionLease = Readonly<{
  authority: ExecutionAuthority; signal: AbortSignal; close(deadline?: number): Promise<ExecutionCleanupReceipt>
}>
/** A run serializes native and runtime work; child graph reads may overlap. */
export type ExecutionStartupGate = <T>(start: () => Promise<T>, signal?: AbortSignal) => Promise<T>

/** Startup must retain the owner's original cancellation before cleanup runs.
 * The shared read helper keeps its existing generic cancellation contract. */
export async function awaitExecutionHostReady<T>(work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  try { return await boundOpenCodeRead(work, ms, signal) }
  catch (error) {
    if (error instanceof Error && error.message === 'cancelled' && signal?.aborted && signal.reason instanceof Error)
      throw signal.reason
    throw error
  }
}

/** Source execution uses a dedicated official-server child and caller-owned durable data. */
export async function acquireExecutionLease(validatedNative: ValidatedExecutionNative,
  selectedProfile: SelectedExecutionProfile, context: ExecutionContext, startupGate?: ExecutionStartupGate,
  graphValidation?: ExecutionGraphValidation): Promise<ExecutionLease> {
  return acquireOwnedNativeLease(validatedNative, selectedProfile, context, startupGate, graphValidation)
}

/** Finite catalog owner has no session/model admission and creates no execution proof. */
export async function acquireOpenCodeV2CatalogLease(native: ValidatedExecutionNative,
  profile: CatalogExecutionProfile, context: ExecutionContext): Promise<ExecutionLease> {
  executionAssert(profile.selection.purpose === 'catalog', 'catalog_profile_required')
  return acquireOwnedNativeLease(native, profile, context)
}

/** Internal preparation performs the real guards/plan without acquiring an owner or starting a server. */
export async function prepareOwnedNativeExecutionPlan(validatedNative: ValidatedExecutionNative,
  selectedProfile: OwnedNativeProfile, context: ExecutionContext, lifetimeSignal?: AbortSignal, progress?: (phase: ExecutionAcquisitionPhase) => void,
  graphValidation?: ExecutionGraphValidation) {
  // Delivery mode is explicit. No packaged/source fallback and no acquisition effect before this fence.
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution', validatedNative.graph.delivery)
  executionAssert(validatedNative.runtimeMode === delivery.runtimeMode, 'v2_execution_delivery_mismatch')
  executionAssert(validatedNative.runtimeMode !== 'packaged' || validatedNative.graph.delivery, 'v2_execution_delivery_mismatch')
  const native = structuredClone(validatedNative), profile = structuredClone(selectedProfile)
  progress?.('delivery-resolved')
  const check = () => {
    context.signal?.throwIfAborted(); lifetimeSignal?.throwIfAborted()
    executionAssert(Number.isFinite(context.deadline) && Date.now() < context.deadline, 'execution_timeout')
  }
  check()
  assertExecutionPlatformAvailable()
  // Engine admission remains exact and platform-qualified; CLI recognition is independent.
  assertOpenCodeV2Launchable(openCodeV2EngineVersion(native))
  executionAssert(native.generation === 'v2' && isOpenCodeV2Identity(openCodeV2EngineVersion(native), native.dialect) &&
    process.versions.bun === openCodeBunVersion(), 'execution_identity_mismatch')
  executionAssert([context.teamId, context.runId, context.laneId, context.memberId].every(value => value.length > 0))
  await validateExecutionProfile(profile); check()
  await canonicalExecutionDirectory(profile.directory); check(); progress?.('profile-validated')
  await validateExecutionNative(native); check()
  executionAssert(await realpath(process.execPath) === native.bun.path &&
    await hashOpenCodeFile(native.bun.path) === native.bun.sha256, 'execution_identity_mismatch'); check(); progress?.('native-validated')
  const graphSignal = context.signal && lifetimeSignal ? AbortSignal.any([context.signal, lifetimeSignal]) : context.signal ?? lifetimeSignal
  // A run cohort validates one exact receipt once for its concurrently
  // preparing members; every child still validates its own graph.
  if (graphValidation) await graphValidation(openCodeV2EngineVersion(native), native.graph, graphSignal)
  else await validateExecutionGraph(openCodeV2EngineVersion(native), native.graph, undefined, graphSignal)
  check(); progress?.('graph-validated')
  const entry = delivery.entryPath; check()
  executionAssert(delivery.entrySha256 === native.entrySha256, 'execution_entry_changed'); check()
  const controllerStateRoots = await deriveSelectedOpenCodeV2ControllerState(profile, context); check(); progress?.('controller-prepared')
  await assertSelectedOpenCodeV2ControllerState(profile, context, controllerStateRoots); check()
  const plan = await planExecutionPlatform({ bun: native.bun, entry, cwd: profile.directory,
    env: { ...profile.env, PWD: profile.directory } })
  check()
  return { native, profile, entry, plan, controllerStateRoots }
}

async function acquireOwnedNativeLease(validatedNative: ValidatedExecutionNative,
  selectedProfile: OwnedNativeProfile, context: ExecutionContext, startupGate?: ExecutionStartupGate,
  graphValidation?: ExecutionGraphValidation): Promise<ExecutionLease> {
  const lifetime = new AbortController()
  const check = () => {
    context.signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    executionAssert(Number.isFinite(context.deadline) && Date.now() < context.deadline, 'execution_timeout')
  }
  const acquisitionStartedAt = Date.now()
  const history: { phase: ExecutionAcquisitionPhase; elapsedMs: number }[] = [{ phase: 'preparing', elapsedMs: 0 }]
  const mark = (phase: ExecutionAcquisitionPhase) => history.push({ phase,
    elapsedMs: Math.max(history.at(-1)!.elapsedMs, Date.now() - acquisitionStartedAt) })
  const timing = () => ({ elapsedMs: Math.max(history.at(-1)!.elapsedMs, Date.now() - acquisitionStartedAt), history })
  let prepared: Awaited<ReturnType<typeof prepareOwnedNativeExecutionPlan>>
  try { prepared = await prepareOwnedNativeExecutionPlan(validatedNative, selectedProfile, context, lifetime.signal, mark, graphValidation) }
  catch (failure) { await recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, undefined, timing()); throw failure }
  mark('prepared')
  const { native, profile, entry, plan, controllerStateRoots } = prepared
  // The gate cancels sibling acquisitions on a final failure only. Mark the
  // closed startup synthesis on each failure as it crosses the gate, so a
  // transient cold-start class stays retryable underneath the gate.
  const serial = async <T>(work: () => Promise<T>): Promise<T> => startupGate
    ? startupGate(async () => { try { return await work() } catch (error) { throw surfaced(error) } }, context.signal)
    : work()
  let nonce: string | undefined
  const leaseOwnerId = randomUUID(), password = randomBytes(32).toString('base64url')
  let ownerIdentity: { hostInstanceId: string; leaseOwnerId: string; graphSha256: string }
  let owner: Awaited<ReturnType<typeof acquireExecutionProfileOwner>> | undefined
  const prepareOwner = async () => {
    check()
    nonce = randomUUID()
    ownerIdentity = { hostInstanceId: nonce, leaseOwnerId, graphSha256: native.graph.sha256 }
    owner = await acquireExecutionProfileOwner(profile, ownerIdentity)
  }
  let launch: ExecutionPlatformLaunch | undefined, child: ExecutionPlatformLaunch['child'] | undefined, authority: ExecutionAuthority | undefined
  let birth: Awaited<ReturnType<typeof readExecutionBirth>> = null
  let mapping: ExecutionPlatformMapping | undefined
  let mappingWork: Promise<ExecutionPlatformMapping> | undefined
  let exited = false, unboundRetired = false, closeWork: Promise<ExecutionCleanupReceipt> | undefined
  let cleanupPhase: ExecutionCleanupPhase | undefined
  let cleanupExitClass: ExecutionCleanupExitClass | undefined
  let exitResolve: () => void = () => undefined
  const exit = new Promise<void>(resolve => { exitResolve = resolve })
  const close = (deadline?: number): Promise<ExecutionCleanupReceipt> => closeWork ??= (async () => {
    lifetime.abort()
    if (authority) { endpoints.delete(authority); graphs.delete(authority) }
    context.signal?.removeEventListener('abort', abort)
    executionAssert(child, 'cleanup_unknown')
    // Join late pre-start mapping; never send start after lifetime cancellation.
    if (!mapping && mappingWork) {
      try { mapping = await boundOpenCodeRead(mappingWork, 6000); birth = mapping.bun.birth } catch { /* Reap below. */ }
    }
    if (!birth || !mapping || !launch) {
      try { launch?.sendClose() } catch { /* Still attempt exact wrapper retirement. */ }
      try {
        // Without a committed child identity no cleanup receipt can exist. The
        // launch-owned empty-scope retirement is the only proof that may free
        // this owner; anything else retains the physical fence on uncertainty.
        // The read bound must outlive the retirement's own kill-and-empty wait:
        // abandoning an in-flight proof converts a launch failure into a retained
        // fence whose refusal then masks that original failure.
        const proof = await boundOpenCodeRead(launch.retire(), 30000)
        if (owner) { await owner.abandonAfterUnboundSpawn(proof); unboundRetired = true }
      } catch { /* Retain physical owner on uncertainty. */ }
      throw new Error('cleanup_unknown')
    }
    const receipt = await retireExecutionChild({ pid: mapping.bun.hostPID, birth, exited: () => exited,
      acknowledged: () => launch!.acknowledged(),
      disposeTransport: async () => {
        const results = await Promise.allSettled([...(disposers.get(authority!) ?? [])].map(dispose => dispose()))
        if (authority) disposers.delete(authority)
        executionAssert(results.every(result => result.status === 'fulfilled'), 'cleanup_unknown')
      },
      sendClose: () => launch!.sendClose(), waitExit: exit,
      readBirth: () => launch!.readBirth ? launch!.readBirth() : readExecutionBirth(mapping!.bun.hostPID), kill: deadline => launch!.kill(deadline),
      retireOwnedDescendants: deadline => launch!.retire(deadline) }, deadline, phase => { cleanupPhase = phase })
    // UNKNOWN never releases the physical profile/database fence.
    cleanupPhase = 'owner-release'
    await owner!.release(receipt)
    return receipt
  })()
  const abort = () => { lifetime.abort(); void close().catch(() => undefined) }
  // The closed startup synthesis rides the surfaced failure only to classify the
  // transient Windows cold-start class. Raw child stderr bytes stay in the
  // collector and never leave it.
  const surfaced = (error: unknown): unknown => {
    try {
      if (!(error instanceof Error) || 'startup' in error) return error
      const raw = launch?.output?.().stderr
      const startup = raw ? JSON.parse(raw) : undefined
      if (startup && typeof startup === 'object' && !Array.isArray(startup))
        Object.defineProperty(error, 'startup', { value: startup, enumerable: false })
    } catch { /* Diagnostics never mask the original failure. */ }
    return error
  }
  let ready: Promise<Record<string, unknown>>, graphReady: Promise<Record<string, unknown>>
  try {
    await serial(async () => {
      await prepareOwner(); check()
      await owner!.beforeSpawn(); check()
      executionAssert(typeof nonce === 'string', 'execution_identity_mismatch')
      launch = launchExecutionPlatform(plan, nonce, leaseOwnerId, native.bun)
      child = launch.child
      child.once('close', (...closeArgs: unknown[]) => {
        // Diagnostic class of the MAIN exit only: zero means the closed ACK
        // left the child, one that the child withheld it, anything else an
        // abnormal end. No raw code is ever retained.
        const code = closeArgs[0]
        cleanupExitClass = code === 0 ? 'exit_zero' : code === 1 ? 'exit_one' : 'job_terminated'
        exited = true; lifetime.abort(); exitResolve(); void close().catch(() => undefined)
      })
      let graphResolve!: (value: Record<string, unknown>) => void, graphReject!: (error: unknown) => void
      graphReady = new Promise((resolve, reject) => { graphResolve = resolve; graphReject = reject })
      void graphReady.catch(() => undefined)
      ready = new Promise<Record<string, unknown>>((resolve, reject) => {
        child!.once('error', (error: unknown) => { const failure = error instanceof Error ? error : new Error('execution_host_unavailable'); reject(failure); graphReject(failure) })
        child!.once('close', () => { const failure = new Error('execution_host_unavailable'); reject(failure); graphReject(failure) })
        child!.on('message', (message: unknown) => {
          try {
            const row = executionRecord(message)
            if (row.nonce === nonce && row.type === 'ready') resolve(row)
            if (row.nonce === nonce && row.type === 'graph-ready') graphResolve(row)
            if (row.nonce === nonce && row.type === 'failed') { const failure = new Error('execution_host_unavailable'); reject(failure); graphReject(failure) }
          } catch { const failure = new Error('execution_invalid_response'); reject(failure); graphReject(failure) }
        })
      })
      void ready.catch(() => undefined)
      context.signal?.addEventListener('abort', abort, { once: true }); check()
      mark('mapping')
      mappingWork = launch.prepare(context.deadline, lifetime.signal)
      mapping = await boundOpenCodeRead(mappingWork, context.deadline - Date.now(), context.signal); check()
      birth = mapping.bun.birth
      executionAssert(!closeWork && !exited, 'execution_identity_mismatch')
      await owner!.bindChild(mapping.bun.hostPID, birth, mapping); check(); mark('child-bound')
      await launch.assertLive(); check()
      const activationDeadline = openCodeV2ActivationDeadline(context.deadline, acquisitionStartedAt, process.platform)
      await launch.start({ password, native, profile, activationDeadline }, context.deadline, lifetime.signal); check(); mark('start-sent')
    })
    const assertReadyIdentity = (row: Record<string, unknown>) => {
      executionAssert(mapping && !closeWork && !exited, 'execution_identity_mismatch')
      executionAssert(row.pid === mapping.bun.nativePID && row.leaseOwnerId === leaseOwnerId && row.namespace === mapping.namespace.name && row.pin === openCodeV2EngineVersion(native) && row.graphSha256 === native.graph.sha256 &&
        row.executableSha256 === native.bun.sha256 && row.profileEpoch === profile.epoch &&
        row.selectionSha256 === executionHash(profile.selection) && executionHash(row.birth) === executionHash(birth), 'execution_identity_mismatch')
    }
    return await serial(async () => {
      check()
      const row = await awaitExecutionHostReady(ready!, context.deadline - Date.now(), context.signal); check()
      assertReadyIdentity(row); check()
      executionAssert(executionHash(await readExecutionBirth(mapping!.bun.hostPID)) === executionHash(birth), 'execution_identity_mismatch')
      check()
      executionAssert(typeof row.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(row.baseUrl), 'execution_identity_mismatch')
      authority = Object.freeze({ generation: 'v2', pin: openCodeV2EngineVersion(native), dialect: native.dialect, graphSha256: native.graph.sha256,
        selectedCli: Object.freeze({ path: native.executablePath, sha256: native.executableSha256, version: native.version }),
        // Published child PID and birth use the controller namespace; /info PID stays private.
        child: Object.freeze({ pid: mapping.bun.hostPID, birth: Object.freeze(birth), executablePath: native.bun.path, sha256: native.bun.sha256 }),
        hostInstanceId: nonce, profileEpoch: profile.epoch, profileRoot: profile.root, directory: profile.directory, leaseOwnerId })
      if ('purpose' in profile.selection) catalogAuthorities.add(authority)
      const endpoint: PrivateEndpointFields = { baseUrl: row.baseUrl, password, signal: lifetime.signal, nativePID: mapping.bun.nativePID }
      endpoints.set(authority, endpoint)
      disposers.set(authority, new Set())
      graphs.set(authority, Object.freeze({ sha256: native.graph.sha256, files: Object.freeze(native.graph.files.map(row => Object.freeze(row))),
        ...(native.graph.delivery ? { delivery: native.graph.delivery } : {}) }))
      mark('ready')
      await awaitOpenCodeV2CatalogReadiness(endpoint, authority, context); mark('catalog-ready')
      Object.freeze(endpoint)
      if (!('purpose' in profile.selection)) {
        await initializeOpenCodeV2ExecutionAuth(authority, profile, context); mark('auth-ready')
        await awaitOpenCodeV2ExecutionReadiness(endpoint, authority, context, profile.selection); mark('selection-ready')
      }
      check()
      executionAssert(!closeWork && !exited, 'execution_host_unavailable')
      const lease = Object.freeze({ authority, signal: lifetime.signal, close })
      cleanupObservations.set(lease, () => cleanupPhase ? Object.freeze({ phase: cleanupPhase,
        ...(cleanupExitClass ? { exit: cleanupExitClass } : {}),
        closedFrame: launch?.closedObservation ? launch.closedObservation() : launch?.acknowledged() ? 'accepted' as const : 'absent' as const }) : undefined)
      // Successful acquisition timing is otherwise written only on refusal.
      const acquired = timing(), acquisition: ExecutionAcquisitionTiming = Object.freeze({ elapsedMs: acquired.elapsedMs,
        history: Object.freeze(acquired.history.map(entry => Object.freeze({ ...entry }))) })
      leaseObservations.set(lease, () => {
        const commands = launch?.commands?.()
        return Object.freeze({ acquisition, ...(commands ? { commands } : {}) })
      })
      return lease
      })
  } catch (failure) {
    const acquisitionTiming = timing()
    if (!child) {
      await recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, launch?.output?.().stderr, acquisitionTiming)
      // Once spawn is attempted even a synchronous error has no retirement
      // proof. Preserve ownership; only pre-launch cancellation may release.
      try { if (owner) await owner.abandonBeforeSpawn() } catch (ownerFailure) {
        throw new Error('execution_owner_unknown', { cause: ownerFailure })
      }
      throw surfaced(failure)
    }
    try { await close() } catch {
      // Only the attempt that retired its unbound spawn left no owner state
      // behind, so only that failure may surface as a retryable transient.
      const cleanup = new Error('cleanup_unknown', { cause: failure })
      if (unboundRetired) Object.defineProperty(cleanup, 'unboundRetired', { value: true, enumerable: false })
      throw surfaced(cleanup)
    }
    finally {
      // Children publish their finite stage while closing.
      await recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, launch?.output?.().stderr, acquisitionTiming)
    }
    throw surfaced(failure)
  }
}
