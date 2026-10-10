import { prepareLinuxExecutionChild, linuxBirth } from '../services/opencode/host/OpenCodeV2ExecutionLauncher.js'
import { pathToFileURL } from 'node:url'
import { resolveOpenCodeV2ExecutionDelivery } from '../services/opencode/host/OpenCodeV2ExecutionDelivery.js'
import { hashOpenCodeFile } from '../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionHash, executionRecord } from '../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { validateExecutionGraph, validateExecutionNative, validateExecutionProfile,
  type OwnedNativeProfile, type ValidatedExecutionNative } from '../services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { boundOpenCodeRead } from '../services/opencode/transport/OpenCodeBoundedFetch.js'
import type { ServerOptions as FloorOptions } from '@opencode/server-v2-floor/options'
import type { ServerOptions as CurrentOptions } from '@opencode/server/options'

// Dedicated IPC child. The execution DB/profile are retained, including failed acquisition.
const controller = new AbortController()
let prepared: Awaited<ReturnType<typeof prepareLinuxExecutionChild>> | undefined
let preparation: ReturnType<typeof prepareLinuxExecutionChild> | undefined
let leaseOwnerId: string | undefined
let nonce: string | undefined, started = false, closing = false
let startup: Promise<void> | undefined, finalize: (() => Promise<void>) | undefined
let closeWork: Promise<void> | undefined
const startupTimer = setTimeout(() => { void close() }, 30_000)
function close(): Promise<void> {
  return closeWork ??= (async () => {
    closing = true; controller.abort(); clearTimeout(startupTimer)
    let complete = true
    // Acquisition may register a Scope after a suspended import. A timeout cannot earn ACK.
    try { if (startup) await boundOpenCodeRead(startup.catch(() => undefined), 6000) } catch { complete = false }
    try { if (finalize) await boundOpenCodeRead(finalize(), 3000) } catch { complete = false }
    try {
      const birth = await linuxBirth(process.pid)
      executionAssert(complete && birth && nonce && process.send && process.connected, 'cleanup_unknown')
      await boundOpenCodeRead(new Promise<void>((resolve, reject) => {
        process.send!({ type: 'closed', nonce, leaseOwnerId: prepared?.leaseOwnerId, namespace: prepared?.namespace, executableSha256: prepared?.executableSha256, pid: process.pid, birth, scopeClosed: true }, error => error ? reject(error) : resolve())
      }), 500)
      process.disconnect?.(); process.exit(0)
    } catch { process.exit(1) }
  })()
}
process.once('disconnect', () => { void close() })
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
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'execution')
  executionAssert(native.runtimeMode === delivery.runtimeMode && native.entrySha256 === delivery.entrySha256 &&
    native.generation === 'v2' &&
    (native.version === '2.0.0' || native.version === '2.0.21') && native.dialect === `v2-${native.version}` &&
    process.versions.bun === '1.3.11', 'execution_identity_mismatch')
  await validateExecutionProfile(profile); controller.signal.throwIfAborted()
  executionAssert(profile.directory === process.cwd() && process.env.PWD === profile.directory &&
    Object.entries(profile.env).every(([key, value]) => process.env[key] === value), 'execution_profile_changed')
  executionAssert(process.execPath === native.bun.path && await hashOpenCodeFile(process.execPath) === native.bun.sha256 &&
    await hashOpenCodeFile(process.argv[1]!) === native.entrySha256, 'execution_identity_mismatch')
  await validateExecutionNative(native)
  controller.signal.throwIfAborted()
  const graph = await validateExecutionGraph(native.version, native.graph)
  controller.signal.throwIfAborted()
  // Effect and runtime resolve from the same verified official package graph.
  const effect: typeof import('effect') = await import(pathToFileURL(graph.effectPath).href)
  controller.signal.throwIfAborted()
  const runtime: typeof import('@opencode/server/process') = await import(pathToFileURL(graph.modulePath).href)
  controller.signal.throwIfAborted()
  const { Effect, Scope, Exit } = effect
  const scope = await Effect.runPromise(Scope.make())
  finalize = () => Effect.runPromise(Scope.close(scope, Exit.void))
  controller.signal.throwIfAborted()
  const options = {
    hostname: '127.0.0.1', port: 0, password: input.password,
    app: { name: 'agent-teams-execution', version: native.version },
    database: { path: profile.databasePath }, events: { persist: true },
    config: { directory: profile.config.directory, project: !('purpose' in profile.selection), content: profile.config.content },
    models: { fetch: false, snapshot: !profile.models, ...(profile.models ? { file: profile.models.path } : {}) },
    fs: { filewatcher: false, fff: false },
  } satisfies FloorOptions & CurrentOptions
  const server = await Effect.runPromise(runtime.start<never, never>(options).pipe(Effect.provideService(Scope.Scope, scope)), { signal: controller.signal })
  controller.signal.throwIfAborted()
  const birth = await linuxBirth(process.pid)
  controller.signal.throwIfAborted()
  executionAssert(!closing && birth && server.address._tag === 'TcpAddress' && server.address.hostname === '127.0.0.1')
  clearTimeout(startupTimer)
  executionAssert(process.send && process.connected)
  const port = server.address.port
  await boundOpenCodeRead(new Promise<void>((resolve, reject) => {
    process.send!({ type: 'ready', nonce, leaseOwnerId: prepared?.leaseOwnerId, namespace: prepared?.namespace, pid: process.pid, birth, pin: native.version,
      baseUrl: `http://127.0.0.1:${port}`, graphSha256: native.graph.sha256,
      executableSha256: native.bun.sha256, profileEpoch: profile.epoch,
      selectionSha256: executionHash(profile.selection) }, error => error ? reject(error) : resolve())
  }), 1000, controller.signal)
}
process.on('message', message => {
  try {
    const input = executionRecord(message)
    executionAssert(typeof input.nonce === 'string' && /^[a-f0-9-]{36}$/.test(input.nonce))
    if (input.type === 'prepare') {
      executionAssert(!preparation && !started && !closing)
      executionAssert(typeof input.leaseOwnerId === 'string')
      nonce = input.nonce; leaseOwnerId = input.leaseOwnerId
      preparation = prepareLinuxExecutionChild(input)
      void preparation.then(value => { prepared = value }, () => { void close() })
      return
    }
    if (input.type === 'close') {
      if (!started && !closing && nonce === undefined) nonce = input.nonce
      executionAssert(input.nonce === nonce && (leaseOwnerId === undefined || input.leaseOwnerId === leaseOwnerId), 'execution_identity_mismatch'); void close(); return
    }
    executionAssert(preparation && !started && !closing && input.type === 'start' && process.send)
    started = true; nonce = input.nonce
    startup = start(input)
    void startup.catch(() => { if (!closing) process.send?.({ type: 'failed', nonce }); void close() })
  } catch { void close() }
})
