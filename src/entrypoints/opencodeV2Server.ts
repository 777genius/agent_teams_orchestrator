import { openCodeV2ServerLoopbackUrl } from '../services/opencode/host/OpenCodeV2ServerAddress.js'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { ServerOptions as FloorOptions } from '@opencode/server-v2-floor/options'
import type { ServerOptions as CurrentOptions } from '@opencode/server/options'
import { hashOpenCodeFile } from '../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import { verifyOpenCodeV2ServerGraph } from '../services/opencode/host/OpenCodeV2ServerGraph.js'
import { openCodeV2ReadOverrides } from '../services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead, openCodeReadAssert } from '../services/opencode/transport/OpenCodeBoundedFetch.js'
import { readRecord } from '../services/opencode/catalog/OpenCodeV2ReadStatus.js'

// Separate process only. Credentials and the acquisition nonce arrive over private IPC.
let started = false, closing = false, nonce: string | undefined
const controller = new AbortController()
let startup: Promise<void> | undefined
let finalize: (() => Promise<void>) | undefined
let closeWork: Promise<void> | undefined
const startupTimer = setTimeout(() => { void close() }, 30_000)
function close(): Promise<void> {
  return closeWork ??= (async () => {
    closing = true
    clearTimeout(startupTimer)
    controller.abort()
    try {
      // A scope may be registered during an awaited import/Scope.make. Join that
      // acquisition before finalizing; a timeout never earns a successful ACK.
      if (startup) await boundOpenCodeRead(startup.catch(() => undefined), 4000)
      if (finalize) await boundOpenCodeRead(finalize(), 3000)
      await boundOpenCodeRead(new Promise<void>((resolve, reject) => {
        if (!nonce || !process.send || !process.connected) { reject(new Error('cleanup_unknown')); return }
        process.send({ type: 'closed', nonce }, error => error ? reject(error) : resolve())
      }), 500)
      process.disconnect?.()
      process.exit(0)
    } catch { process.exit(1) }
  })()
}
process.once('disconnect', () => { void close() })
process.once('SIGTERM', () => { void close() })

async function start(input: Record<string, unknown>): Promise<void> {
  openCodeReadAssert(input.pin === '2.0.0' || input.pin === '2.0.32')
  openCodeReadAssert(typeof input.password === 'string' && input.password.length === 43)
  openCodeReadAssert(typeof input.root === 'string' && path.isAbsolute(input.root))
  const root = await realpath(input.root)
  controller.signal.throwIfAborted()
  openCodeReadAssert(root === process.cwd() && root === input.root && process.env.HOME === path.join(root, 'home'))
  const graph = await verifyOpenCodeV2ServerGraph(input.pin)
  controller.signal.throwIfAborted()
  const executableSha256 = await hashOpenCodeFile(process.execPath)
  controller.signal.throwIfAborted()
  openCodeReadAssert(graph.moduleSha256 === input.moduleSha256 && executableSha256 === input.executableSha256, 'identity_mismatch')
  // Resolve Effect from the selected official server graph; it remains child-local.
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
    app: { name: 'agent-teams-read', version: input.pin },
    database: { path: path.join(root, 'data', 'read.sqlite') },
    config: { directory: path.join(root, 'config'), project: true, content: JSON.stringify(openCodeV2ReadOverrides) },
    models: { fetch: false, snapshot: true }, events: { persist: false },
    fs: { filewatcher: false, fff: false },
  } satisfies FloorOptions & CurrentOptions
  const server = await Effect.runPromise(runtime.start<never, never>(options).pipe(Effect.provideService(Scope.Scope, scope)), { signal: controller.signal })
  controller.signal.throwIfAborted()
  openCodeReadAssert(!closing)
  const baseUrl = openCodeV2ServerLoopbackUrl(input.pin, server.address)
  clearTimeout(startupTimer)
  process.send?.({ type: 'ready', nonce, pid: process.pid, version: input.pin,
    baseUrl, moduleSha256: graph.moduleSha256, executableSha256 })
}
process.on('message', message => {
  try {
    const input = readRecord(message)
    openCodeReadAssert(typeof input.nonce === 'string' && /^[a-f0-9-]{36}$/.test(input.nonce))
    if (input.type === 'close') {
      // Closing an unused private child is a complete acquisition transition.
      if (!started && !closing && nonce === undefined) nonce = input.nonce
      openCodeReadAssert(input.nonce === nonce, 'identity_mismatch')
      void close()
      return
    }
    openCodeReadAssert(!started && input.type === 'start' && process.send && !closing)
    started = true
    nonce = input.nonce
    startup = start(input)
    void startup.catch(() => {
      if (!closing) process.send?.({ type: 'failed', nonce })
      void close()
    })
  } catch { void close() }
})
