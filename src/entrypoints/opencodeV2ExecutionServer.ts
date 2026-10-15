import { openCodeBunVersion } from '../constants/openCodeBunVersion.js'
import { windowsExecutionChildControl } from '../services/opencode/host/windows/OpenCodeV2WindowsChildControl.js'
import { prepareExecutionPlatformChild, readExecutionPlatformBirth } from '../services/opencode/host/OpenCodeV2ExecutionPlatform.js'
import { pathToFileURL } from 'node:url'
import { resolveOpenCodeV2ExecutionDelivery } from '../services/opencode/host/OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionHash, executionRecord } from '../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { assertExecutionProfile, executionProfileGuards, validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type ExecutionGraphProgress, type OwnedNativeProfile, type ValidatedExecutionNative } from '../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { boundOpenCodeRead } from '../services/opencode/transport/OpenCodeBoundedFetch.js'
import { importOpenCodeV2SelectedOAuth } from '../services/opencode/host/OpenCodeV2ExecutionOAuth.js'
import type { ServerOptions as FloorOptions } from '@opencode/server-v2-floor/options'
import type { ServerOptions as CurrentOptions } from '@opencode/server/options'

// Dedicated IPC child. The execution DB/profile are retained, including failed acquisition.
// Native Windows uses an authenticated named pipe; POSIX keeps its inherited
// process IPC. The official runtime sees no process-global transport overrides.
const childControl = process.platform === 'win32' ? windowsExecutionChildControl() : {
  events: process,
  connected: () => !!process.send && process.connected === true,
  send: (value: Readonly<Record<string, unknown>>) => new Promise<void>((resolve, reject) => {
    executionAssert(process.send && process.connected, 'execution_containment_identity_mismatch')
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
    'execution_containment_identity_mismatch', 'execution_timeout', 'execution_cancelled']
  const cause = error instanceof Error && causes.includes(error.message) ? error.message : undefined
  const detail = error instanceof Error ? error as Error & { code?: unknown; syscall?: unknown; profileGuard?: unknown } : undefined
  const errno = ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS'].find(value => value === detail?.code)
  const operation = ['realpath', 'open', 'read', 'lstat', 'stat'].find(value => value === detail?.syscall)
  const errorName = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError'].find(value => value === detail?.name)
  const profileGuard = executionProfileGuards.find(value => value === detail?.profileGuard)
  // Fixed stages, closed cause codes and elapsed time; no credentials or payloads.
  process.stderr.write(JSON.stringify({ event: 'opencode-v2-startup', reason, stage: startupStage, ...(cause ? { cause } : {}), ...(errno ? { errno } : {}), ...(operation ? { operation } : {}), ...(errorName ? { errorName } : {}), ...(profileGuard ? { profileGuard } : {}), ...(environmentMismatchKeys.length ? { environmentMismatchKeys } : {}),
    elapsedMs: Math.max(startupHistory.at(-1)!.elapsedMs, Date.now() - startupStartedAt), history: startupHistory, ...(graphProgress ? { graph: graphProgress } : {}) }) + '\n')
}
// A source graph can legitimately take more than 30 seconds under concurrent
// startup. The owner still enforces its original shared initialization deadline.
const startupTimer = setTimeout(() => { reportStartupFailure('timeout'); void close() }, 60_000)
function close(): Promise<void> {
  return closeWork ??= (async () => {
    if (!runtimeReady) reportStartupFailure('failed')
    closing = true; controller.abort(); clearTimeout(startupTimer)
    let complete = true
    // Acquisition may register a Scope after a suspended import. A timeout cannot earn ACK.
    try { if (startup) await boundOpenCodeRead(startup.catch(() => undefined), 6000) } catch { complete = false }
    try { if (finalize) await boundOpenCodeRead(finalize(), 3000) } catch { complete = false }
    try {
      const birth = await readExecutionPlatformBirth(process.pid)
      executionAssert(complete && birth && nonce && childControl.connected(), 'cleanup_unknown')
      await boundOpenCodeRead(childControl.send({ type: 'closed', nonce, leaseOwnerId: prepared?.leaseOwnerId,
        namespace: prepared?.namespace, executableSha256: prepared?.executableSha256, pid: process.pid,
        birth, scopeClosed: true }), 500)
      childControl.disconnect(); process.exit(0)
    } catch { process.exit(1) }
  })()
}
childControl.events.once('disconnect', () => { void close() })
process.once('SIGTERM', () => { void close() })

async function start(input: Record<string, unknown>): Promise<void> {
  if (preparation) prepared = await preparation
  executionAssert(prepared && input.nonce === prepared.nonce && input.leaseOwnerId === prepared.leaseOwnerId &&
    input.namespace === prepared.namespace, 'execution_containment_identity_mismatch')
  controller.signal.throwIfAborted()
  executionAssert(typeof input.password === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.password))
  executionRecord(input.native); executionRecord(input.profile)
  const native = input.native as ValidatedExecutionNative
  const profile = input.profile as OwnedNativeProfile
  enterStartupStage('delivery-resolution')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  executionAssert(native.runtimeMode === delivery.runtimeMode && native.entrySha256 === delivery.entrySha256 &&
    native.generation === 'v2' &&
    (native.version === '2.0.0' || native.version === '2.0.21') && native.dialect === `v2-${native.version}` &&
    process.versions.bun === openCodeBunVersion(), 'execution_identity_mismatch')
  enterStartupStage('profile-validation')
  await validateExecutionProfile(profile); controller.signal.throwIfAborted()
  // AppContainer reroutes its temporary/local-data environment at creation.
  // Rebind only these observed OS overrides to the authenticated private profile
  // before importing the official runtime; every environment check still runs.
  if (process.platform === 'win32') for (const key of ['TMP', 'TEMP', 'LOCALAPPDATA', 'PATH'] as const) {
    const value = profile.env[key]
    assertExecutionProfile(typeof value === 'string', 'process_environment')
    process.env[key] = value
  }
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
  if (process.platform === 'win32') {
    enterStartupStage('runtime-import')
    const { loadOpenCodeV2WindowsRuntime } = await import('../services/opencode/host/windows/OpenCodeV2WindowsRuntime.js')
    const { windowsExecutionCommandPort } = await import('../services/opencode/host/windows/OpenCodeV2WindowsCommand.js')
    const { bindWindowsExecutionHttp } = await import('../services/opencode/host/windows/OpenCodeV2WindowsHTTP.js')
    const runtime = await loadOpenCodeV2WindowsRuntime(native.version, graph.moduleSha256,
      windowsExecutionCommandPort(), profile)
    controller.signal.throwIfAborted()
    enterStartupStage('server-start')
    const server = await runtime.start(options, controller.signal)
    // Register ownership before binding so a failed bridge bind still closes
    // the acquired official server, without acknowledging partial cleanup.
    finalize = server.close
    const bridge = bindWindowsExecutionHttp(server.baseUrl, controller.signal)
    finalize = async () => { try { await bridge.close() } finally { await server.close() } }
    baseUrl = server.baseUrl
  } else {
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
    executionAssert(server.address._tag === 'TcpAddress' && server.address.hostname === '127.0.0.1')
    baseUrl = `http://127.0.0.1:${server.address.port}`
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
    if (process.platform === 'win32' && (input.type === 'windowsHTTP' || input.type === 'commandResult')) return
    if (input.type === 'prepare') {
      executionAssert(!preparation && !started && !closing)
      executionAssert(typeof input.leaseOwnerId === 'string')
      nonce = input.nonce; leaseOwnerId = input.leaseOwnerId
      preparation = prepareExecutionPlatformChild(input)
      void preparation.then(value => { prepared = value }, () => { void close() })
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
