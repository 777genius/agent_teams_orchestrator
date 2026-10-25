import { openCodeV2ServerLoopbackUrl } from '../services/opencode/host/OpenCodeV2ServerAddress.js'
import { readExecutionGraphFailure } from '../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { openCodeBunVersion } from '../constants/openCodeBunVersion.js'
import { prepareExecutionPlatformChild, readExecutionPlatformBirth } from '../services/opencode/host/OpenCodeV2ExecutionPlatform.js'
import { pathToFileURL } from 'node:url'
import { resolveOpenCodeV2ExecutionDelivery } from '../services/opencode/host/OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { assertOpenCodeV2Launchable, isOpenCodeV2Identity } from '../services/opencode/compatibility/OpenCodeV2Registry.js'
import { executionAssert, executionHash, executionRecord, openCodeV2RunInitializationMs } from '../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { assertExecutionProfile, executionProfileGuards, validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type ExecutionGraphProgress, type OwnedNativeProfile, type ValidatedExecutionNative } from '../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { boundOpenCodeRead } from '../services/opencode/transport/OpenCodeBoundedFetch.js'
import { openCodeV2ExecutionCloseAckReserveMs, runOpenCodeV2ExecutionCloseSequence } from '../services/opencode/execution/OpenCodeV2ExecutionClose.js'
import { importOpenCodeV2SelectedOAuth } from '../services/opencode/host/OpenCodeV2ExecutionOAuth.js'
import type { CurrentServerOptions as CurrentOptions, FloorServerOptions as FloorOptions } from '../services/opencode/compatibility/OpenCodeV2WireTypes.js'

// Dedicated IPC child of the owner on every platform. The execution DB/profile are
// retained, including failed acquisition.
const childControl = {
  events: process,
  connected: () => !!process.send && process.connected === true,
  send: (value: Readonly<Record<string, unknown>>, _deadline?: number) => new Promise<void>((resolve, reject) => {
    executionAssert(process.send && process.connected, 'execution_identity_mismatch')
    process.send!(value, error => error ? reject(error) : resolve())
  }),
  disconnect: () => process.disconnect?.(),
}
const controller = new AbortController()
let prepared: Awaited<ReturnType<typeof prepareExecutionPlatformChild>> | undefined
let preparation: ReturnType<typeof prepareExecutionPlatformChild> | undefined
let leaseOwnerId: string | undefined
let nonce: string | undefined, started = false, closing = false
let startup: Promise<void> | undefined, finalize: (() => Promise<void>) | undefined
let closeWork: Promise<void> | undefined
const startupStartedAt = Date.now()
let startupStage = 'waiting-for-prepare'
const startupHistory = [{ stage: startupStage, elapsedMs: 0 }]
let graphProgress: ExecutionGraphProgress | undefined
let runtimeReady = false, startupFailureReported = false
let environmentMismatchKeys: string[] = []
function enterStartupStage(stage: string): void {
  startupStage = stage
  startupHistory.push({ stage, elapsedMs: Math.max(startupHistory.at(-1)!.elapsedMs, Date.now() - startupStartedAt) })
}
function reportStartupFailure(reason: 'timeout' | 'failed', error?: unknown): void {
  if (runtimeReady || startupFailureReported) return
  startupFailureReported = true
  const causes = ['execution_contract_invalid', 'execution_identity_mismatch', 'execution_entry_changed',
    'v2_compiled_runtime_unsupported', 'v2_execution_layout_unsupported', 'execution_profile_changed',
    'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing',
    'execution_identity_mismatch', 'execution_realpath_unavailable',
    'execution_timeout', 'execution_cancelled', 'opencode_v2_version_out_of_range', 'opencode_v2_version_unqualified',
    'opencode_v2_graph_unavailable']
  const cause = error instanceof Error && causes.includes(error.message) ? error.message : undefined
  const detail = error instanceof Error ? error as Error & { code?: unknown; syscall?: unknown; profileGuard?: unknown } : undefined
  const errno = ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS'].find(value => value === detail?.code)
  const operation = ['realpath', 'open', 'read', 'lstat', 'stat'].find(value => value === detail?.syscall)
  const errorName = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError'].find(value => value === detail?.name)
  const profileGuard = executionProfileGuards.find(value => value === detail?.profileGuard)
  // Fixed stages, closed cause codes and elapsed time; no credentials or payloads.
  process.stderr.write(JSON.stringify({ event: 'opencode-v2-startup', reason, stage: startupStage, ...(cause ? { cause } : {}), ...(errno ? { errno } : {}), ...(operation ? { operation } : {}), ...(errorName ? { errorName } : {}), ...(profileGuard ? { profileGuard } : {}), ...(environmentMismatchKeys.length ? { environmentMismatchKeys } : {}),
    elapsedMs: Math.max(startupHistory.at(-1)!.elapsedMs, Date.now() - startupStartedAt), history: startupHistory, ...(graphProgress ? { graph: graphProgress } : {}), ...(readExecutionGraphFailure(error) ? { graphFailure: readExecutionGraphFailure(error) } : {}) }) + '\n')
}
// A source graph can legitimately take more than 30 seconds under concurrent
// startup. The owner still enforces its original shared initialization deadline;
// the start request replaces this local watchdog with that absolute deadline.
let startupTimer = setTimeout(() => { reportStartupFailure('timeout'); void close() }, process.platform === 'win32' ? 120_000 : 60_000)
function close(): Promise<void> {
  return closeWork ??= (async () => {
    if (!runtimeReady) reportStartupFailure('failed')
    closing = true; controller.abort(); clearTimeout(startupTimer)
    const acknowledged = await runOpenCodeV2ExecutionCloseSequence({
      startup, finalize,
      acknowledge: async () => {
        const birth = await readExecutionPlatformBirth(process.pid)
        executionAssert(birth && nonce && childControl.connected(), 'cleanup_unknown')
        const frame = { type: 'closed', nonce, leaseOwnerId: prepared?.leaseOwnerId,
          namespace: prepared?.namespace, executableSha256: prepared?.executableSha256, pid: process.pid,
          birth, scopeClosed: true }
        await childControl.send(frame, Date.now() + openCodeV2ExecutionCloseAckReserveMs)
      },
    })
    // The IPC send callback has confirmed the closed ACK before this process exits.
    if (acknowledged) { childControl.disconnect(); process.exit(0) } else process.exit(1)
  })()
}
childControl.events.on('error', (error: unknown) => { reportStartupFailure('failed', error); void close() })
childControl.events.once('disconnect', () => { void close() })
process.once('SIGTERM', () => { void close() })

async function start(input: Record<string, unknown>): Promise<void> {
  if (preparation) prepared = await preparation
  executionAssert(prepared && input.nonce === prepared.nonce && input.leaseOwnerId === prepared.leaseOwnerId &&
    input.namespace === prepared.namespace, 'execution_identity_mismatch')
  controller.signal.throwIfAborted()
  executionAssert(typeof input.password === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.password))
  executionRecord(input.native); executionRecord(input.profile)
  const native = input.native as ValidatedExecutionNative
  const profile = input.profile as OwnedNativeProfile
  let activationDeadline: number | undefined
  if (input.activationDeadline !== undefined) {
    // The owner's absolute initialization deadline replaces the local startup watchdog.
    executionAssert(Number.isSafeInteger(input.activationDeadline) &&
      Number(input.activationDeadline) > Date.now() && Number(input.activationDeadline) <= startupStartedAt + openCodeV2RunInitializationMs(process.platform), 'execution_identity_mismatch')
    activationDeadline = Number(input.activationDeadline)
    clearTimeout(startupTimer)
    startupTimer = setTimeout(() => { reportStartupFailure('timeout'); void close() }, activationDeadline - Date.now())
  }
  enterStartupStage('delivery-resolution')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  assertOpenCodeV2Launchable(native.version)
  executionAssert(native.runtimeMode === delivery.runtimeMode && native.entrySha256 === delivery.entrySha256 &&
    native.generation === 'v2' && isOpenCodeV2Identity(native.version, native.dialect) &&
    process.versions.bun === openCodeBunVersion(), 'execution_identity_mismatch')
  enterStartupStage('profile-validation')
  await validateExecutionProfile(profile); controller.signal.throwIfAborted()
  assertExecutionProfile(profile.directory === process.cwd(), 'process_cwd')
  assertExecutionProfile(process.env.PWD === profile.directory, 'process_pwd')
  const knownKeys = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'OPENCODE_CONFIG_DIR', 'AGENT_TEAMS_MCP_CLAUDE_DIR', 'OPENSSL_CONF']
  environmentMismatchKeys = [...new Set(Object.entries(profile.env).filter(([key, value]) => process.env[key] !== value)
    .map(([key]) => knownKeys.includes(key) ? key : 'other'))]
  assertExecutionProfile(environmentMismatchKeys.length === 0, 'process_environment')
  executionAssert(process.execPath === native.bun.path && await hashOpenCodeFile(process.execPath) === native.bun.sha256 &&
    await hashOpenCodeFile(process.argv[1]!) === native.entrySha256, 'execution_identity_mismatch')
  enterStartupStage('native-validation')
  await validateExecutionNative(native)
  controller.signal.throwIfAborted()
  enterStartupStage('graph-validation')
  const graph = await validateExecutionGraph(native.version, native.graph, value => { graphProgress = value }, controller.signal)
  controller.signal.throwIfAborted()
  const options = {
    hostname: '127.0.0.1', port: 0, password: input.password,
    app: { name: 'agent-teams-execution', version: native.version },
    database: { path: profile.databasePath }, events: { persist: true },
    config: { directory: profile.config.directory, project: !('purpose' in profile.selection), content: profile.config.content },
    models: { fetch: false, snapshot: !profile.models, ...(profile.models ? { file: profile.models.path } : {}) },
    fs: { filewatcher: false, fff: false },
  } satisfies FloorOptions & CurrentOptions
  let baseUrl: string
  {
    // Effect and runtime resolve from the same verified official package graph.
    enterStartupStage('effect-import')
    const effect: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
    controller.signal.throwIfAborted()
    enterStartupStage('selected-oauth-import')
    await importOpenCodeV2SelectedOAuth(profile, native.graph, graph.modulePath, effect, controller.signal)
    controller.signal.throwIfAborted()
    enterStartupStage('runtime-import')
    const runtime: typeof import('@opencode/server/process') = await import(pathToFileURL(graph.modulePath).href)
    controller.signal.throwIfAborted()
    const { Effect, Scope, Exit } = effect
    enterStartupStage('scope-acquisition')
    const scope = await Effect.runPromise(Scope.make())
    finalize = () => Effect.runPromise(Scope.close(scope, Exit.void))
    controller.signal.throwIfAborted()
    enterStartupStage('server-start')
    const server = await Effect.runPromise(runtime.start<never, never>(options).pipe(Effect.provideService(Scope.Scope, scope)), { signal: controller.signal })
    baseUrl = openCodeV2ServerLoopbackUrl(native.version, server.address)
  }
  controller.signal.throwIfAborted()
  enterStartupStage('ready-identity')
  const birth = await readExecutionPlatformBirth(process.pid)
  controller.signal.throwIfAborted()
  executionAssert(!closing && birth && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(baseUrl))
  clearTimeout(startupTimer)
  executionAssert(childControl.connected())
  await boundOpenCodeRead(childControl.send({ type: 'ready', nonce, leaseOwnerId: prepared?.leaseOwnerId,
    namespace: prepared?.namespace, pid: process.pid, birth, pin: native.version,
    baseUrl, graphSha256: native.graph.sha256,
    executableSha256: native.bun.sha256, profileEpoch: profile.epoch,
    selectionSha256: executionHash(profile.selection) }), 1000, controller.signal)
  runtimeReady = true
}
childControl.events.on('message', (message: unknown) => {
  try {
    const input = executionRecord(message)
    executionAssert(typeof input.nonce === 'string' && /^[a-f0-9-]{36}$/.test(input.nonce))
    if (input.type === 'prepare') {
      executionAssert(!preparation && !started && !closing)
      executionAssert(typeof input.leaseOwnerId === 'string')
      nonce = input.nonce; leaseOwnerId = input.leaseOwnerId
      preparation = prepareExecutionPlatformChild(input)
      void preparation.then(value => { prepared = value }, error => { reportStartupFailure('failed', error); void close() })
      return
    }
    if (input.type === 'close') {
      if (!started && !closing && nonce === undefined) nonce = input.nonce
      executionAssert(input.nonce === nonce && (leaseOwnerId === undefined || input.leaseOwnerId === leaseOwnerId), 'execution_identity_mismatch'); void close(); return
    }
    executionAssert(preparation && !started && !closing && input.type === 'start' && childControl.connected())
    started = true; nonce = input.nonce
    startup = start(input)
    void startup.catch(error => { if (!closing) reportStartupFailure('failed', error); if (!closing) void childControl.send({ type: 'failed', nonce, leaseOwnerId }).catch(() => undefined); void close() })
  } catch (error) { reportStartupFailure('failed', error); void close() }
})
