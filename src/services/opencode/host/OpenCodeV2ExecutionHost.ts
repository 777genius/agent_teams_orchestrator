import { readSelectedOpenCodeV2ControllerState } from './OpenCodeV2Profile.js'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { resolveOpenCodeV2ExecutionDelivery } from './OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionHash, executionRecord, type ExecutionAuthority, type ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { awaitOpenCodeV2ExecutionReadiness, awaitOpenCodeV2CatalogReadiness } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { canonicalExecutionDirectory, readExecutionBirth, validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type ExecutionGraph, type OwnedNativeProfile, type CatalogExecutionProfile, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { retireExecutionChild, type ExecutionCleanupReceipt } from './OpenCodeV2ExecutionLifecycle.js'
import { assertExecutionPlatformAvailable, launchExecutionPlatform, planExecutionPlatform,
  type ExecutionPlatformLaunch, type ExecutionPlatformMapping } from './OpenCodeV2ExecutionPlatform.js'
import { acquireExecutionProfileOwner } from './OpenCodeV2ExecutionOwner.js'
import { initializeOpenCodeV2ExecutionAuth } from './OpenCodeV2ExecutionAuth.js'
import { closeWindowsExecutionPlan } from './windows/OpenCodeV2WindowsExecution.js'
import { resolveOpenCodeV2DarwinControllerRuntimeClosure } from '../profile/OpenCodeV2ExecutionReceipt.js'

export type { SelectedExecutionProfile, ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
type PrivateEndpoint = Readonly<{ baseUrl: string; password: string; signal: AbortSignal; nativePID: number; fetch?: ExecutionPlatformLaunch['fetch'] }>
const catalogAuthorities = new WeakSet<ExecutionAuthority>()
export function executionAuthorityIsCatalogOnly(authority: ExecutionAuthority): boolean { return catalogAuthorities.has(authority) }
const endpoints = new WeakMap<ExecutionAuthority, PrivateEndpoint>()
const graphs = new WeakMap<ExecutionAuthority, ExecutionGraph>()
const disposers = new WeakMap<ExecutionAuthority, Set<() => Promise<void>>>()
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
  authority: ExecutionAuthority; signal: AbortSignal; close(): Promise<ExecutionCleanupReceipt>
}>

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
  selectedProfile: SelectedExecutionProfile, context: ExecutionContext): Promise<ExecutionLease> {
  return acquireOwnedNativeLease(validatedNative, selectedProfile, context)
}

/** Finite catalog owner has no session/model admission and creates no execution proof. */
export async function acquireOpenCodeV2CatalogLease(native: ValidatedExecutionNative,
  profile: CatalogExecutionProfile, context: ExecutionContext): Promise<ExecutionLease> {
  executionAssert(profile.selection.purpose === 'catalog', 'catalog_profile_required')
  return acquireOwnedNativeLease(native, profile, context)
}

/** Internal preparation performs the real guards/plan without acquiring an owner or starting a server. */
export async function prepareOwnedNativeExecutionPlan(validatedNative: ValidatedExecutionNative,
  selectedProfile: OwnedNativeProfile, context: ExecutionContext, lifetimeSignal?: AbortSignal) {
  // Delivery mode is explicit. No packaged/source fallback and no acquisition effect before this fence.
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  executionAssert(validatedNative.runtimeMode === delivery.runtimeMode, 'v2_execution_delivery_mismatch')
  const native = structuredClone(validatedNative), profile = structuredClone(selectedProfile)
  const check = () => {
    context.signal?.throwIfAborted(); lifetimeSignal?.throwIfAborted()
    executionAssert(Number.isFinite(context.deadline) && Date.now() < context.deadline, 'execution_timeout')
  }
  check()
  assertExecutionPlatformAvailable()
  executionAssert(native.generation === 'v2' && (native.version === '2.0.0' || native.version === '2.0.21') &&
    native.dialect === `v2-${native.version}` && process.versions.bun === '1.3.11', 'execution_identity_mismatch')
  executionAssert([context.teamId, context.runId, context.laneId, context.memberId].every(value => value.length > 0))
  await validateExecutionProfile(profile); check()
  await canonicalExecutionDirectory(profile.directory); check()
  await validateExecutionNative(native); check()
  executionAssert(await realpath(process.execPath) === native.bun.path &&
    await hashOpenCodeFile(native.bun.path) === native.bun.sha256, 'execution_identity_mismatch'); check()
  await validateExecutionGraph(native.version, native.graph); check()
  const entry = delivery.entryPath; check()
  executionAssert(delivery.entrySha256 === native.entrySha256, 'execution_entry_changed'); check()
  const sourceRoot = delivery.root
  const resolutionMounts = await executionResolutionMounts(sourceRoot, native.graph); check()
  const controllerLoaderFiles = new Set<string>()
  const controllerLoaderAliases: { source: string; target: string }[] = []
  if (process.platform === 'darwin') {
    const document = executionRecord(JSON.parse(profile.config.content))
    const graphFiles = new Map(native.graph.files.map(file => [file.path, file.sha256]))
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
  const controllerStateRoots = await readSelectedOpenCodeV2ControllerState(profile, context); check()
  const profileDirectories = [...new Set([profile.root, profile.config.directory, path.dirname(profile.databasePath),
    ...['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
      'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA'].map(key => profile.env[key]!)])]
  const plan = await planExecutionPlatform({ bun: native.bun, entry, cwd: profile.directory, profileDirectories,
    writableRoots: [profile.root, profile.directory, ...controllerStateRoots],
    readOnlyRoots: [sourceRoot, path.dirname(native.bun.path), selectedCliRoot,
      ...native.graph.files.map(file => controllerLoaderFiles.has(file.path) ? file.path : path.dirname(file.path))],
    readOnlyMounts: [...resolutionMounts, ...controllerLoaderAliases],
    protectedRoots: [path.join(profile.root, '.opencode-v2-execution-owner'),
      path.join(path.dirname(profile.databasePath), `.${path.basename(profile.databasePath)}.opencode-v2-execution-owner`)],
    env: { ...profile.env, PWD: profile.directory } })
  try { check() } catch (failure) {
    if (plan.platform === 'win32') await closeWindowsExecutionPlan(plan.concrete).catch(() => undefined)
    throw failure
  }
  return { native, profile, entry, plan }
}

async function acquireOwnedNativeLease(validatedNative: ValidatedExecutionNative,
  selectedProfile: OwnedNativeProfile, context: ExecutionContext): Promise<ExecutionLease> {
  const lifetime = new AbortController()
  const check = () => {
    context.signal?.throwIfAborted(); lifetime.signal.throwIfAborted()
    executionAssert(Number.isFinite(context.deadline) && Date.now() < context.deadline, 'execution_timeout')
  }
  const { native, profile, entry, plan } = await prepareOwnedNativeExecutionPlan(validatedNative, selectedProfile, context, lifetime.signal)
  const nonce = randomUUID(), leaseOwnerId = randomUUID(), password = randomBytes(32).toString('base64url')
  const ownerIdentity = { hostInstanceId: nonce, leaseOwnerId, graphSha256: native.graph.sha256 }
  let owner: Awaited<ReturnType<typeof acquireExecutionProfileOwner>>
  try {
    check()
    owner = await acquireExecutionProfileOwner(profile, ownerIdentity,
      plan.platform === 'win32' ? { windowsPlan: plan.concrete } : undefined)
  } catch (failure) {
    if (plan.platform === 'win32') await closeWindowsExecutionPlan(plan.concrete).catch(() => undefined)
    throw failure
  }
  let launch: ExecutionPlatformLaunch | undefined, child: ExecutionPlatformLaunch['child'] | undefined, authority: ExecutionAuthority | undefined
  let birth: Awaited<ReturnType<typeof readExecutionBirth>> = null
  let mapping: ExecutionPlatformMapping | undefined
  let mappingWork: Promise<ExecutionPlatformMapping> | undefined
  let exited = false, closeWork: Promise<ExecutionCleanupReceipt> | undefined
  let exitResolve: () => void = () => undefined
  const exit = new Promise<void>(resolve => { exitResolve = resolve })
  const close = (): Promise<ExecutionCleanupReceipt> => closeWork ??= (async () => {
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
      readBirth: () => readExecutionBirth(mapping!.bun.hostPID), kill: () => launch!.kill(),
      retireOwnedDescendants: () => launch!.retire() })
    // UNKNOWN never releases the physical profile/database fence.
    await owner.release(receipt)
    if (plan.platform === 'win32') await closeWindowsExecutionPlan(plan.concrete)
    return receipt
  })()
  const abort = () => { lifetime.abort(); void close().catch(() => undefined) }
  try {
    check()
    await owner.beforeSpawn(); check()
    launch = launchExecutionPlatform(plan, nonce, leaseOwnerId, native.bun)
    child = launch.child
    child.once('close', () => { exited = true; lifetime.abort(); exitResolve(); void close().catch(() => undefined) })
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      child!.once('error', () => reject(new Error('execution_host_unavailable')))
      child!.once('close', () => reject(new Error('execution_host_unavailable')))
      child!.on('message', (message: unknown) => {
        try {
          const row = executionRecord(message)
          if (row.nonce === nonce && row.type === 'ready') resolve(row)
          if (row.nonce === nonce && row.type === 'failed') reject(new Error('execution_host_unavailable'))
        } catch { reject(new Error('execution_invalid_response')) }
      })
    })
    void ready.catch(() => undefined)
    context.signal?.addEventListener('abort', abort, { once: true }); check()
    mappingWork = launch.prepare(context.deadline, lifetime.signal)
    mapping = await boundOpenCodeRead(mappingWork, context.deadline - Date.now(), context.signal); check()
    birth = mapping.bun.birth
    executionAssert(!closeWork && !exited, 'execution_identity_mismatch')
    await owner.bindChild(mapping.bun.hostPID, birth, mapping); check()
    await launch.assertLive(); check()
    await launch.start({ password, native, profile }, context.deadline, lifetime.signal); check()
    const row = await boundOpenCodeRead(ready, context.deadline - Date.now(), context.signal); check()
    executionAssert(row.pid === mapping.bun.nativePID && row.leaseOwnerId === leaseOwnerId && row.namespace === mapping.namespace.name && row.pin === native.version && row.graphSha256 === native.graph.sha256 &&
      row.executableSha256 === native.bun.sha256 && row.profileEpoch === profile.epoch &&
      row.selectionSha256 === executionHash(profile.selection) && executionHash(row.birth) === executionHash(birth) &&
      executionHash(await readExecutionBirth(mapping.bun.hostPID)) === executionHash(birth), 'execution_identity_mismatch')
    executionAssert(typeof row.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(row.baseUrl), 'execution_identity_mismatch')
    authority = Object.freeze({ generation: 'v2', pin: native.version, dialect: native.dialect, graphSha256: native.graph.sha256,
      selectedCli: Object.freeze({ path: native.executablePath, sha256: native.executableSha256, version: native.version }),
      // Published child PID and birth use the controller namespace; /info PID stays private.
      child: Object.freeze({ pid: mapping.bun.hostPID, birth: Object.freeze(birth), executablePath: native.bun.path, sha256: native.bun.sha256 }),
      hostInstanceId: nonce, profileEpoch: profile.epoch, profileRoot: profile.root, directory: profile.directory, leaseOwnerId })
    if ('purpose' in profile.selection) catalogAuthorities.add(authority)
    executionAssert(process.platform !== 'win32' || typeof launch.fetch === 'function', 'execution_native_transport_unqualified')
    const endpoint = Object.freeze({ baseUrl: row.baseUrl, password, signal: lifetime.signal, nativePID: mapping.bun.nativePID,
      fetch: launch.fetch })
    endpoints.set(authority, endpoint)
    disposers.set(authority, new Set())
    graphs.set(authority, Object.freeze({ sha256: native.graph.sha256, files: Object.freeze(native.graph.files.map(row => Object.freeze(row))) }))
    if ('purpose' in profile.selection) await awaitOpenCodeV2CatalogReadiness(endpoint, authority, context)
    else {
      await awaitOpenCodeV2CatalogReadiness(endpoint, authority, context)
      await initializeOpenCodeV2ExecutionAuth(authority, profile, context)
      await awaitOpenCodeV2ExecutionReadiness(endpoint, authority, context, profile.selection)
    }
    check()
    executionAssert(!closeWork && !exited, 'execution_host_unavailable')
    return Object.freeze({ authority, signal: lifetime.signal, close })
  } catch (failure) {
    if (!child) {
      // Once spawn is attempted even a synchronous error has no retirement
      // proof. Preserve ownership; only pre-launch cancellation may release.
      try { await owner.abandonBeforeSpawn() } catch { throw new Error('execution_owner_unknown', { cause: failure }) }
      if (plan.platform === 'win32') await closeWindowsExecutionPlan(plan.concrete)
      throw failure
    }
    try { await close() } catch { throw new Error('cleanup_unknown', { cause: failure }) }
    throw failure
  }
}
