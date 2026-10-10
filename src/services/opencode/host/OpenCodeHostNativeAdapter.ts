import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { readProcessStartTimeMs } from '../../../utils/processKill.js'
import type { OpenCodeClientRequestContext } from '../OpenCodeClientRequestContext.js'
import { hashOpenCodeFile, type OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'
import { createOpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { boundOpenCodeRead, openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'
import { readRecord } from '../catalog/OpenCodeV2ReadStatus.js'
import { verifyOpenCodeV2ServerGraph } from './OpenCodeV2ServerGraph.js'
import { resolveOpenCodeV2ChildEntry } from './OpenCodeV2ChildEntry.js'

export type OpenCodeV2EndpointAuthority = {
  native: OpenCodeV2NativeIdentity; baseUrl: string; pid: number; processBirth: number
  directory: string; instanceId: string; authorization: string
}
const owned = new WeakSet<OpenCodeV2EndpointAuthority>()
export function assertOpenCodeV2EndpointAuthority(authority: OpenCodeV2EndpointAuthority): void {
  openCodeReadAssert(owned.has(authority), 'identity_mismatch')
}

/** One ephemeral catalog lease. No shared listener adoption, persistent registry or V1 host changes. */
export async function acquireOpenCodeV2ReadHost(native: OpenCodeV2NativeIdentity, directory: string,
  context: OpenCodeClientRequestContext = {}) {
  const deadline = Date.now() + Math.min(30_000, context.remainingMs?.() ?? 30_000)
  const check = () => {
    context.signal?.throwIfAborted()
    openCodeReadAssert(Date.now() < deadline && (context.remainingMs?.() ?? 1) > 0, 'timeout')
  }
  check()
  // Resolve delivery mode before package inspection. A compiled CLI is fenced,
  // rather than spawning its own executable as if it were a Bun interpreter.
  const entry = await resolveOpenCodeV2ChildEntry()
  check()
  const canonicalDirectory = await realpath(directory)
  check()
  openCodeReadAssert(canonicalDirectory === directory, 'identity_mismatch')
  const nativeSha256 = await hashOpenCodeFile(native.executablePath)
  check()
  openCodeReadAssert(nativeSha256 === native.executableSha256, 'identity_mismatch')
  const graph = await verifyOpenCodeV2ServerGraph(native.version)
  check()
  const roots = await createOpenCodeV2ReadRoots()
  const nonce = randomUUID(), password = randomBytes(32).toString('base64url')
  let child: ReturnType<typeof spawn> | undefined, birth: number | null = null
  let birthWork: Promise<number | null> | undefined
  let exited = false, acknowledged = false, closeWork: Promise<void> | undefined
  let authority: OpenCodeV2EndpointAuthority | undefined
  let resolveExit: () => void = () => undefined
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const close = (): Promise<void> => closeWork ??= (async () => {
    if (authority) owned.delete(authority)
    if (!child) { await roots.remove(); return }
    if (!exited && child.connected) { try { child.send({ type: 'close', nonce }) } catch { /* Revalidate birth below. */ } }
    try { await boundOpenCodeRead(exit, 8500) }
    catch {
      // This is our captured spawn only; no PID-only fallback or adopted host.
      if (birthWork) birth = await boundOpenCodeRead(birthWork, 1000)
      if (!exited && child.pid && birth !== null && await readProcessStartTimeMs(child.pid) === birth) child.kill('SIGKILL')
      await boundOpenCodeRead(exit, 2000)
    }
    // A failed spawn owns no runtime. A killed live child without a nonce ACK
    // cannot prove its scope/descendant cleanup, even when the leader is gone.
    openCodeReadAssert(exited && (!child.pid || acknowledged), 'cleanup_unknown')
    if (birthWork) await boundOpenCodeRead(birthWork, 6000)
    await roots.remove()
  })()
  const abort = () => { void close().catch(() => undefined) }
  try {
    check()
    const executable = await realpath(process.execPath)
    check()
    const executableSha256 = await hashOpenCodeFile(executable)
    check()
    child = spawn(executable, [entry], { cwd: roots.root, env: roots.env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    child.once('close', () => { exited = true; resolveExit() })
    child.on('message', message => {
      try { const row = readRecord(message); if (row.type === 'closed' && row.nonce === nonce) acknowledged = true }
      catch { /* Unknown messages grant no close authority. */ }
    })
    const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
      child!.once('error', () => reject(new Error('host_unavailable')))
      child!.once('close', () => reject(new Error('host_unavailable')))
      child!.on('message', message => {
        try {
          const row = readRecord(message)
          if (row.type === 'ready' && row.nonce === nonce) resolve(row)
          else if (row.type === 'failed' && row.nonce === nonce) reject(new Error('host_unavailable'))
        } catch { reject(new Error('invalid_response')) }
      })
    })
    void ready.catch(() => undefined)
    context.signal?.addEventListener('abort', abort, { once: true })
    check()
    openCodeReadAssert(child.pid, 'host_unavailable')
    birthWork = readProcessStartTimeMs(child.pid)
    birth = await boundOpenCodeRead(birthWork, deadline - Date.now(), context.signal)
    check()
    openCodeReadAssert(!closeWork && !exited && birth !== null, 'identity_mismatch')
    child.send({ type: 'start', nonce, pin: native.version, root: roots.root, password,
      executableSha256, moduleSha256: graph.moduleSha256 })
    const row = await boundOpenCodeRead(ready, deadline - Date.now(), context.signal)
    check()
    const currentBirth = await readProcessStartTimeMs(child.pid)
    check()
    openCodeReadAssert(!closeWork && !exited && row.pid === child.pid && row.version === native.version &&
      row.moduleSha256 === graph.moduleSha256 && row.executableSha256 === executableSha256 &&
      currentBirth === birth, 'identity_mismatch')
    openCodeReadAssert(typeof row.baseUrl === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(row.baseUrl), 'identity_mismatch')
    authority = Object.freeze({ native: Object.freeze({ ...native }), baseUrl: row.baseUrl, pid: child.pid, processBirth: birth,
      directory, instanceId: nonce, authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') })
    owned.add(authority)
    return { authority, close: async () => {
      context.signal?.removeEventListener('abort', abort)
      await close()
    } }
  } catch (failure) {
    context.signal?.removeEventListener('abort', abort)
    try { await close() } catch { throw new Error('cleanup_unknown', { cause: failure }) }
    throw failure
  }
}
