import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { assertSelectedOpenCodeV2ControllerState, deriveSelectedOpenCodeV2ControllerState } from './OpenCodeV2Profile.js'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { lstat, realpath } from 'node:fs/promises'
import { resolveOpenCodeV2ExecutionDelivery } from './OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionHash, executionRecord, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { awaitOpenCodeV2ExecutionReadiness, awaitOpenCodeV2CatalogReadiness } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { canonicalExecutionDirectory, readExecutionBirth, validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type ExecutionGraph, type ExecutionGraphValidation, type OwnedNativeProfile, type CatalogExecutionProfile, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { retireExecutionChild, type ExecutionCleanupReceipt } from './OpenCodeV2ExecutionLifecycle.js'
import { assertExecutionPlatformAvailable, launchExecutionPlatform, planExecutionPlatform,
  type ExecutionPlatformLaunch, type ExecutionPlatformMapping } from './OpenCodeV2ExecutionPlatform.js'
import { acquireExecutionProfileOwner } from './OpenCodeV2ExecutionOwner.js'
import { initializeOpenCodeV2ExecutionAuth } from './OpenCodeV2ExecutionAuth.js'
import { readOpenCodeV2SelectedAuth } from './OpenCodeV2ExecutionOAuth.js'
import { attachWindowsRunMemberCohort, bindWindowsExecutionSelectedConfig, closeWindowsExecutionPlan, consumeWindowsExecutionLaunchNonce, ownerFilesystemForWindowsPlan, preflightWindowsMemberExecution,
  type WindowsSelectedAuthMetadata } from './windows/OpenCodeV2WindowsExecution.js'
import { selectWindowsRunMemberPreflightForPlan } from '../bridge/OpenCodeV2RunControl.js'
import { resolveOpenCodeV2DarwinControllerRuntimeClosure } from '../profile/OpenCodeV2ExecutionReceipt.js'
import { recordOpenCodeV2ProviderFailure, retainOpenCodeV2CatalogServerFailure, executionNativeRetirementPhases, type ExecutionAcquisitionPhase, type ExecutionAcquisitionTiming,
  readExecutionNativeRootObservation, type ExecutionNativeRootObservation,
  type ExecutionCleanupPhase, type ExecutionCleanupObservation, type ExecutionCommandObservation, type ExecutionNativeRetirementPhase } from '../execution/OpenCodeV2Diagnostics.js'
import { readOpenCodeV2ServerFailure, type OpenCodeV2ServerFailure } from '../execution/OpenCodeV2ServerFailure.js'

export type { SelectedExecutionProfile, ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
type PrivateEndpointFields = { baseUrl: string; password: string; signal: AbortSignal; nativePID: number; fetch?: ExecutionPlatformLaunch['fetch']; selectedAuth?: WindowsSelectedAuthMetadata }
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

/** Keep package aliases at their lexical locations and mount their canonical
 * targets read-only. Canonical file directories alone omit node_modules links. */
async function executionResolutionMounts(sourceRoot: string, graph: ExecutionGraph) {
  const candidates = new Set<string>()
  for (const start of new Set([sourceRoot, ...graph.files.map(file => path.dirname(file.path))])) {
    for (let directory = start; ; directory = path.dirname(directory)) {
      candidates.add(path.join(directory, 'node_modules'))
      if (path.dirname(directory) === directory) break
    }
  }
  const mounts: Readonly<{ source: string; target: string }>[] = []
  for (const target of candidates) {
    let source: string
    try { source = await realpath(target) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    executionAssert((await lstat(source)).isDirectory(), 'execution_graph_dependency_missing')
    mounts.push(Object.freeze({ source, target }))
  }
  return Object.freeze(mounts)
}

/** Source execution uses a dedicated official-server child and caller-owned durable data. */
export async function acquireExecutionLease(validatedNative: ValidatedExecutionNative,
  selectedProfile: SelectedExecutionProfile, context: ExecutionContext, startupGate?: ExecutionStartupGate,
  graphValidation?: ExecutionGraphValidation): Promise<ExecutionLease> {
  return retryTransientWindowsLaunch(() => acquireOwnedNativeLease(validatedNative, selectedProfile, context, startupGate, graphValidation))
}

/** Finite catalog owner has no session/model admission and creates no execution proof. */
export async function acquireOpenCodeV2CatalogLease(native: ValidatedExecutionNative,
  profile: CatalogExecutionProfile, context: ExecutionContext): Promise<ExecutionLease> {
  executionAssert(profile.selection.purpose === 'catalog', 'catalog_profile_required')
  return retryTransientWindowsLaunch(() => acquireOwnedNativeLease(native, profile, context))
}

/** Internal preparation performs the real guards/plan without acquiring an owner or starting a server. */
export async function prepareOwnedNativeExecutionPlan(validatedNative: ValidatedExecutionNative,
  selectedProfile: OwnedNativeProfile, context: ExecutionContext, lifetimeSignal?: AbortSignal, progress?: (phase: ExecutionAcquisitionPhase) => void,
  graphValidation?: ExecutionGraphValidation) {
  // Delivery mode is explicit. No packaged/source fallback and no acquisition effect before this fence.
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  executionAssert(validatedNative.runtimeMode === delivery.runtimeMode, 'v2_execution_delivery_mismatch')
  const native = structuredClone(validatedNative), profile = structuredClone(selectedProfile)
  progress?.('delivery-resolved')
  const check = () => {
    context.signal?.throwIfAborted(); lifetimeSignal?.throwIfAborted()
    executionAssert(Number.isFinite(context.deadline) && Date.now() < context.deadline, 'execution_timeout')
  }
  check()
  assertExecutionPlatformAvailable()
  executionAssert(native.generation === 'v2' && (native.version === '2.0.0' || native.version === '2.0.32') &&
    native.dialect === `v2-${native.version}` && process.versions.bun === openCodeBunVersion(), 'execution_identity_mismatch')
  executionAssert([context.teamId, context.runId, context.laneId, context.memberId].every(value => value.length > 0))
  await validateExecutionProfile(profile); check()
  await canonicalExecutionDirectory(profile.directory); check(); progress?.('profile-validated')
  await validateExecutionNative(native); check()
  executionAssert(await realpath(process.execPath) === native.bun.path &&
    await hashOpenCodeFile(native.bun.path) === native.bun.sha256, 'execution_identity_mismatch'); check(); progress?.('native-validated')
  const graphSignal = context.signal && lifetimeSignal ? AbortSignal.any([context.signal, lifetimeSignal]) : context.signal ?? lifetimeSignal
  // A run cohort validates one exact receipt once for its concurrently
  // preparing members; every child still validates its own graph.
  if (graphValidation) await graphValidation(native.version, native.graph, graphSignal)
  else await validateExecutionGraph(native.version, native.graph, undefined, graphSignal)
  check(); progress?.('graph-validated')
  const entry = delivery.entryPath; check()
  executionAssert(delivery.entrySha256 === native.entrySha256, 'execution_entry_changed'); check()
  const sourceRoot = delivery.root
  // Source carries its own module/alias boundary. Windows needs only that
  // measured subtree, rather than recursive access to checkout/build history.
  const contentRoot = process.platform === 'win32' && delivery.runtimeMode === 'source'
    ? path.join(sourceRoot, 'src') : sourceRoot
  const resolutionMounts = await executionResolutionMounts(sourceRoot, native.graph); check(); progress?.('resolution-prepared')
  const controllerLoaderFiles = new Set<string>()
  const controllerLoaderAliases: { source: string; target: string }[] = []
  if (process.platform === 'darwin') {
    const document = executionRecord(JSON.parse(profile.config.content))
    const graphFiles = new Map(native.graph.files.map(file => [file.path, file.sha256]))
    if (native.taskNode) {
      const closure = await resolveOpenCodeV2DarwinControllerRuntimeClosure(native.taskNode.path); check()
      executionAssert(graphFiles.get(native.taskNode.path) === native.taskNode.sha256, 'controller_runtime_changed')
      for (const file of closure.files) {
        executionAssert(graphFiles.get(file.path) === file.sha256, 'controller_runtime_changed')
        controllerLoaderFiles.add(file.path)
      }
      controllerLoaderAliases.push(...closure.aliases)
    }
    if (document.mcp !== undefined) {
      const servers = executionRecord(executionRecord(document.mcp).servers)
      for (const value of Object.values(servers)) {
        const server = executionRecord(value)
        if (server.type !== 'local' || server.disabled === true) continue
        executionAssert(Array.isArray(server.command) && typeof server.command[0] === 'string', 'controller_runtime_missing')
        const closure = await resolveOpenCodeV2DarwinControllerRuntimeClosure(server.command[0]); check()
        for (const file of closure.files) {
          executionAssert(graphFiles.get(file.path) === file.sha256, 'controller_runtime_changed')
          controllerLoaderFiles.add(file.path)
        }
        controllerLoaderAliases.push(...closure.aliases)
      }
    }
  }
  const selectedCliRoot = await realpath(path.dirname(path.dirname(native.executablePath))); check()
  const controllerStateRoots = await deriveSelectedOpenCodeV2ControllerState(profile, context); check(); progress?.('controller-prepared')
  // Windows physical controller qualification is ordered after the one plan,
  // selected-profile qualification and member preflight. POSIX remains eager.
  if (process.platform !== 'win32') { await assertSelectedOpenCodeV2ControllerState(profile, context, controllerStateRoots); check() }
  const profileDirectories = [...new Set([profile.root, profile.config.directory, path.dirname(profile.databasePath),
    ...['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA'].map(key => profile.env[key]!)])]
  const plan = await planExecutionPlatform({ bun: native.bun, entry, cwd: profile.directory, profileDirectories,
    writableRoots: [profile.root, profile.directory, ...controllerStateRoots],
    readOnlyRoots: [contentRoot, path.dirname(native.bun.path), selectedCliRoot,
      ...native.graph.files.map(file => controllerLoaderFiles.has(file.path) ? file.path : path.dirname(file.path))],
    readOnlyMounts: [...resolutionMounts, ...controllerLoaderAliases],
    protectedRoots: [path.join(profile.root, '.opencode-v2-execution-owner'),
      path.join(path.dirname(profile.databasePath), `.${path.basename(profile.databasePath)}.opencode-v2-execution-owner`)],
    env: { ...profile.env, PWD: profile.directory } })
  try { check() } catch (failure) {
    if (plan.platform === 'win32') await closeWindowsExecutionPlan(plan.concrete).catch(() => undefined)
    throw failure
  }
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
  const gatedWindows = plan.platform === 'win32' && !!startupGate
  const serial = async <T>(work: () => Promise<T>): Promise<T> => startupGate ? startupGate(work, context.signal) : work()
  let nonce: string | undefined
  const leaseOwnerId = randomUUID(), password = randomBytes(32).toString('base64url')
  let ownerIdentity: { hostInstanceId: string; leaseOwnerId: string; graphSha256: string }
  let owner: Awaited<ReturnType<typeof acquireExecutionProfileOwner>> | undefined
  let windowsFilesystem: ReturnType<typeof ownerFilesystemForWindowsPlan> | undefined
  let selectedAuth: WindowsSelectedAuthMetadata | undefined
  const retainedRoots: Array<Readonly<{ assertOwned(): Promise<void>; close(): Promise<void> }>> = []
  const closeRetainedRoots = async () => {
    const results = await Promise.allSettled(retainedRoots.splice(0).map(root => root.close()))
    if (results.some(result => result.status === 'rejected')) throw new Error('cleanup_unknown')
  }
  let planClosed = false
  const closePlanOnce = async () => {
    if (plan.platform === 'win32' && !planClosed) {
      planClosed = true; await closeWindowsExecutionPlan(plan.concrete)
    }
  }
  const prepareOwner = async () => {
    check()
    if (plan.platform === 'win32') {
      windowsFilesystem = ownerFilesystemForWindowsPlan(plan.concrete)
      const memberPreflight = !('purpose' in profile.selection)
        ? await selectWindowsRunMemberPreflightForPlan(plan.concrete, context, profile as SelectedExecutionProfile) : null
      if (memberPreflight) {
        // The sealed cohort is joined on this plan broker before selected
        // profile custody: an earlier member launch has already granted its
        // package SIDs on these same profile paths.
        await attachWindowsRunMemberCohort(plan.concrete, memberPreflight, context.deadline, context.signal)
        check()
      }
      await windowsFilesystem.validateSelectedProfile(profile.root, profile.databasePath, context.deadline, context.signal, profile.directory)
      check()
      if (memberPreflight) {
        await preflightWindowsMemberExecution(plan.concrete, memberPreflight, context.deadline, context.signal)
        check()
      }
      for (const root of controllerStateRoots) {
        const held = await windowsFilesystem.openDirectory(root, context.deadline, context.signal)
        retainedRoots.push(held)
        await held.assertOwned(context.deadline, context.signal)
        check()
      }
      nonce = consumeWindowsExecutionLaunchNonce(plan.concrete)
    } else {
      nonce = randomUUID()
    }
    executionAssert(typeof nonce === 'string', 'execution_identity_mismatch')
    ownerIdentity = { hostInstanceId: nonce, leaseOwnerId, graphSha256: native.graph.sha256 }
    owner = await acquireExecutionProfileOwner(profile, ownerIdentity,
      plan.platform === 'win32' ? { windowsPlan: plan.concrete } : undefined)
  }
  let launch: ExecutionPlatformLaunch | undefined, child: ExecutionPlatformLaunch['child'] | undefined, authority: ExecutionAuthority | undefined
  let birth: Awaited<ReturnType<typeof readExecutionBirth>> = null
  let mapping: ExecutionPlatformMapping | undefined
  let serverFailure: OpenCodeV2ServerFailure | undefined
  let mappingWork: Promise<ExecutionPlatformMapping> | undefined
  let exited = false, closeWork: Promise<ExecutionCleanupReceipt> | undefined
  let cleanupPhase: ExecutionCleanupPhase | undefined, nativeCleanupPhase: ExecutionNativeRetirementPhase | undefined
  let nativeCleanupRoot: ExecutionNativeRootObservation | undefined
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
      try { if (launch) await boundOpenCodeRead(launch.retire(), 7000) } catch { /* Retain physical owner on uncertainty. */ }
      await closeRetainedRoots().catch(() => undefined)
      await closePlanOnce().catch(() => undefined)
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
    cleanupPhase = 'retained-roots'
    await closeRetainedRoots()
    cleanupPhase = 'plan-close'
    await closePlanOnce()
    executionAssert(process.platform !== 'win32' || deadline === undefined || Date.now() < deadline, 'execution_timeout')
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
      // Native owner acquisition has already retained the selected profile and
      // both physical fences. Bind the fixed managed config before marking a
      // launch attempt, so known pre-launch failures still use normal abandonment.
      if (plan.platform === 'win32') {
        await bindWindowsExecutionSelectedConfig(plan.concrete, profile, context.teamId, context.deadline, context.signal)
        check()
        if (!('purpose' in profile.selection) && profile.authSha256 !== undefined) {
          // This is the initial SelectedAuth qualification. It uses the live
          // private plan broker's cached selection and local fixed auth bytes,
          // before any owner spawn or provider/catalog connection.
          selectedAuth = windowsFilesystem!.selectedAuthMetadata()
          await readOpenCodeV2SelectedAuth(profile, selectedAuth, context.deadline, context.signal)
          check()
        }
      }
      await owner!.beforeSpawn(); check()
      executionAssert(typeof nonce === 'string', 'execution_identity_mismatch')
      launch = launchExecutionPlatform(plan, nonce, leaseOwnerId, native.bun, context.deadline)
      child = launch.child
      child.on('serverFailure', (message: unknown) => {
        // This event is diagnostic only. Recheck the original held child;
        // malformed metadata must neither execute getters nor refuse readiness.
        try {
          const data = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !types.isProxy(value)
            ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
          const observedBirth = data(message, 'birth')
          if (!serverFailure && plan.platform === 'win32' && mapping && data(message, 'nonce') === nonce &&
            data(message, 'leaseOwnerId') === leaseOwnerId && data(message, 'namespace') === mapping.namespace.name &&
            data(message, 'pid') === mapping.bun.nativePID && data(observedBirth, 'format') === mapping.bun.birth.format &&
            data(observedBirth, 'value') === mapping.bun.birth.value && data(observedBirth, 'bootId') === mapping.bun.birth.bootId)
            serverFailure = readOpenCodeV2ServerFailure(data(message, 'serverFailure'))
        } catch { /* Untrusted observations never alter acquisition. */ }
      })
      child.on('retireProgress', (phase: unknown) => {
        nativeCleanupPhase = executionNativeRetirementPhases.find(value => value === phase)
        nativeCleanupRoot = undefined
      })
      child.on('retireRootProgress', (root: unknown) => { nativeCleanupRoot = readExecutionNativeRootObservation(root) })
      child.once('close', () => { exited = true; lifetime.abort(); exitResolve(); void close().catch(() => undefined) })
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
      await launch.start({ password, native, profile, activationDeadline: context.deadline, ...(gatedWindows ? { deferRuntime: true } : {}) }, context.deadline, lifetime.signal); check(); mark('start-sent')
    })
    const assertReadyIdentity = (row: Record<string, unknown>) => {
      executionAssert(mapping && !closeWork && !exited, 'execution_identity_mismatch')
      executionAssert(row.pid === mapping.bun.nativePID && row.leaseOwnerId === leaseOwnerId && row.namespace === mapping.namespace.name && row.pin === native.version && row.graphSha256 === native.graph.sha256 &&
        row.executableSha256 === native.bun.sha256 && row.profileEpoch === profile.epoch &&
        row.selectionSha256 === executionHash(profile.selection) && executionHash(row.birth) === executionHash(birth), 'execution_identity_mismatch')
    }
    if (gatedWindows) {
      // Only the authenticated child's complete graph validation runs without
      // a ticket. It cannot import/start the runtime until the next ticket.
      const graph = await awaitExecutionHostReady(graphReady!, context.deadline - Date.now(), context.signal); check()
      assertReadyIdentity(graph); check()
    }
    return await serial(async () => {
      check()
      if (gatedWindows) {
        executionAssert(launch?.activate && !closeWork && !exited, 'execution_identity_mismatch')
        await awaitExecutionHostReady(launch.activate(context.deadline, lifetime.signal), context.deadline - Date.now(), context.signal); check()
      }
      const row = await awaitExecutionHostReady(ready!, context.deadline - Date.now(), context.signal); check()
      assertReadyIdentity(row); check()
      // Windows rechecks the original held MAIN HANDLE and exact native mapping
      // inside this ticket. A new PID-lookup helper adds no identity authority.
      if (plan.platform === 'win32') {
        await awaitExecutionHostReady(launch!.assertLive(), context.deadline - Date.now(), context.signal)
      } else executionAssert(executionHash(await readExecutionBirth(mapping!.bun.hostPID)) === executionHash(birth), 'execution_identity_mismatch')
      check()
      executionAssert(typeof row.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(row.baseUrl), 'execution_identity_mismatch')
      authority = Object.freeze({ generation: 'v2', pin: native.version, dialect: native.dialect, graphSha256: native.graph.sha256,
        selectedCli: Object.freeze({ path: native.executablePath, sha256: native.executableSha256, version: native.version }),
        // Published child PID and birth use the controller namespace; /info PID stays private.
        child: Object.freeze({ pid: mapping.bun.hostPID, birth: Object.freeze(birth), executablePath: native.bun.path, sha256: native.bun.sha256 }),
        hostInstanceId: nonce, profileEpoch: profile.epoch, profileRoot: profile.root, directory: profile.directory, leaseOwnerId })
      if ('purpose' in profile.selection) catalogAuthorities.add(authority)
      executionAssert(process.platform !== 'win32' || typeof launch.fetch === 'function', 'execution_native_transport_unqualified')
      const endpoint: PrivateEndpointFields = { baseUrl: row.baseUrl, password, signal: lifetime.signal, nativePID: mapping.bun.nativePID,
        fetch: launch.fetch }
      endpoints.set(authority, endpoint)
      disposers.set(authority, new Set())
      graphs.set(authority, Object.freeze({ sha256: native.graph.sha256, files: Object.freeze(native.graph.files.map(row => Object.freeze(row))) }))
      mark('ready')
      await awaitOpenCodeV2CatalogReadiness(endpoint, authority, context); mark('catalog-ready')
      if (selectedAuth) {
        const observed = await selectedAuth.read(context.deadline, context.signal)
        executionAssert(observed.sha256 === profile.authSha256, 'execution_selected_auth_changed')
        endpoint.selectedAuth = selectedAuth
      }
      Object.freeze(endpoint)
      if (!('purpose' in profile.selection)) {
        await initializeOpenCodeV2ExecutionAuth(authority, profile, context); mark('auth-ready')
        await awaitOpenCodeV2ExecutionReadiness(endpoint, authority, context, profile.selection); mark('selection-ready')
      }
      check()
      executionAssert(!closeWork && !exited, 'execution_host_unavailable')
      const lease = Object.freeze({ authority, signal: lifetime.signal, close })
      cleanupObservations.set(lease, () => cleanupPhase ? Object.freeze({ phase: cleanupPhase,
        ...((cleanupPhase === 'kernel-retirement' || cleanupPhase === 'force-kill') && nativeCleanupPhase
          ? { nativePhase: nativeCleanupPhase,
            ...(nativeCleanupPhase === 'retire_grants_roots' && nativeCleanupRoot ? { nativeRoot: nativeCleanupRoot } : {}) } : {}) }) : undefined)
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
    retainOpenCodeV2CatalogServerFailure(failure, serverFailure)
    const acquisitionTiming = timing()
    if (!child) {
      await recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, launch?.output?.().stderr, acquisitionTiming)
      // Once spawn is attempted even a synchronous error has no retirement
      // proof. Preserve ownership; only pre-launch cancellation may release.
      try { if (owner) await owner.abandonBeforeSpawn() } catch (ownerFailure) {
        await closeRetainedRoots().catch(() => undefined); await closePlanOnce().catch(() => undefined)
        // An uncertain physical owner is never a retryable surface: no startup
        // observation is attached, so the retry gate stays closed here.
        throw new Error('execution_owner_unknown', { cause: ownerFailure })
      }
      await closeRetainedRoots().catch(() => undefined)
      await closePlanOnce().catch(() => undefined)
      throw surfaced(failure)
    }
    // Begin finite failure persistence before potentially unresolved retirement.
    // Do not delay physical cleanup on diagnostic I/O.
    const earlyDiagnostic = process.platform === 'win32'
      ? recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, launch?.output?.().stderr, acquisitionTiming)
      : undefined
    try { await close() } catch { throw surfaced(new Error('cleanup_unknown', { cause: failure })) }
    finally {
      if (earlyDiagnostic) await earlyDiagnostic
      // Unix children publish their finite stage while closing. Windows retains
      // the native phase measured before potentially unresolved retirement.
      else await recordOpenCodeV2ProviderFailure('execution-host-startup', failure, true, launch?.output?.().stderr, acquisitionTiming)
    }
    throw surfaced(failure)
  }
}

/** A cold Windows runner may hold freshly delivered bytes under a transient AV
 * scan: the held MAIN exits 1 with an access-denied stderr classification before
 * its module load completes. Only this closed class is ever retried — the last
 * launch stage stays before 'windows-assert', so the prepare handshake never
 * finished and no owner/nonce/plan state outlived the failed attempt. */
function isTransientWindowsLaunchFailure(error: unknown): boolean {
  try {
    if (!(error instanceof Error)) return false
    const startup = (error as Error & { startup?: unknown }).startup
    if (!startup || typeof startup !== 'object' || Array.isArray(startup)) return false
    const record = startup as Record<string, unknown>
    return record.event === 'opencode-v2-startup' && record.reason === 'failed' &&
      record.nativeExitCode === 1 && record.nativeStderrKind === 'access_denied' &&
      typeof record.stage === 'string' && record.stage !== 'windows-assert'
  } catch { return false }
}
/** Every retry is a complete acquisition: a fresh plan broker, native run state,
 * owner record and launch nonce, so the one-shot launch bindings are never
 * replayed. A persistent failure is surfaced unchanged after its first
 * occurrence; after three transient attempts the original failure stands. */
async function retryTransientWindowsLaunch<T>(work: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined, failure: unknown
  for (let attempt = 0; attempt < 3 && result === undefined; attempt++) {
    try { result = { value: await work() } }
    catch (error) {
      failure = error
      if (attempt < 2 && isTransientWindowsLaunchFailure(error))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      else break
    }
  }
  if (result === undefined) throw failure
  return result.value
}
