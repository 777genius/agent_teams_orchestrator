import { randomUUID } from 'node:crypto'
import {
  launchOpenCodeNativeAuthority, resolveOpenCodeNativeAuthorityArtifacts,
  verifyOpenCodeNativeAuthorityArtifacts, type OpenCodeNativeAuthorityChild,
} from './OpenCodeNativeAuthorityArtifacts.js'
import { decodeOpenCodeWindowsPublicationReply, OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  validOpenCodePublicationLeaf, validOpenCodePublicationRoot,
  type OpenCodeWindowsPublicationRequest } from './OpenCodeWindowsPublicationAuthorityProtocol.js'

type PendingRequest<T extends OpenCodeWindowsPublicationRequest = OpenCodeWindowsPublicationRequest> =
  T extends OpenCodeWindowsPublicationRequest ? Omit<T, 'version' | 'wait_ms'> : never
type Pending = PendingRequest
export type OpenCodeWindowsPublicationAuthorityFactory = (options: OpenCodeWindowsPublicationAuthorityOptions) => OpenCodeWindowsPublicationAuthorityClient
export type OpenCodeWindowsPublicationAuthorityOptions = Readonly<{
  deadline: number; signal?: AbortSignal; launcherPath?: string; workerPath?: string
  launch?: (input: Readonly<{ launcherPath: string; workerPath: string; argument: string }>) => OpenCodeNativeAuthorityChild
}>

const unavailable = () => new Error('OpenCode Windows publication authority is unavailable [redacted]')

export class OpenCodeWindowsPublicationAuthorityClient {
  readonly #child: OpenCodeNativeAuthorityChild
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #deadline: number
  readonly #signal?: AbortSignal
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #pending = ''; #pendingBytes = 0; #closed = false; #retained = false
  #abort = () => this.kill()

  constructor(options: OpenCodeWindowsPublicationAuthorityOptions) {
    if (!Number.isFinite(options.deadline) || options.deadline <= performance.now() || options.signal?.aborted) throw unavailable()
    const artifacts = resolveOpenCodeNativeAuthorityArtifacts(options)
    if (!options.launch) verifyOpenCodeNativeAuthorityArtifacts(artifacts)
    this.#child = (options.launch ?? launchOpenCodeNativeAuthority)({ ...artifacts, argument: '--windows-publication-authority-v1' })
    this.#child.unref(); this.#reader = this.#child.stdout.getReader(); this.#deadline = options.deadline; this.#signal = options.signal
    options.signal?.addEventListener('abort', this.#abort, { once: true })
  }

  async openRoot(rootPath: string, createMissing: boolean, durableAncestors: boolean): Promise<Readonly<{ volumeSerial: string; fileId: string; createdPaths: string[] }>> {
    if (!validOpenCodePublicationRoot(rootPath)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'OPEN_ROOT', root_path: rootPath, create_missing: createMissing, durable_ancestors: durableAncestors }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))
      || !Array.isArray(value?.createdPaths) || !value.createdPaths.every(v => typeof v === 'string')) throw unavailable()
    this.#retained = true
    this.#signal?.removeEventListener('abort', this.#abort)
    return value as { volumeSerial: string; fileId: string; createdPaths: string[] }
  }
  async validateRoot(): Promise<void> { await this.#request({ id: randomUUID(), op: 'VALIDATE_ROOT' }) }
  async syncRoot(): Promise<void> { await this.#request({ id: randomUUID(), op: 'SYNC_ROOT' }) }
  async pinRegular(name: string, denyWrites = false): Promise<Readonly<{ volumeSerial: string; fileId: string; size: string }>> {
    if (!validOpenCodePublicationLeaf(name)) throw unavailable()
    const value = await this.#request({ id: randomUUID(),
      op: denyWrites ? 'PIN_REGULAR_READONLY' : 'PIN_REGULAR', name }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId)) || !/^\d+$/.test(String(value?.size))) throw unavailable()
    return value as { volumeSerial: string; fileId: string; size: string }
  }
  async close(): Promise<void> { if (this.#closed) return; try { if (this.#retained) await this.#request({ id: randomUUID(), op: 'CLOSE' }) } catch {} finally { this.kill() } }
  kill(): void { if (this.#closed) return; this.#closed = true; this.#signal?.removeEventListener('abort', this.#abort); try { this.#child.stdin.end() } catch {}; try { this.#child.kill('SIGKILL') } catch {} }

  async #request(request: Pending): Promise<unknown> {
    if (this.#closed || (!this.#retained && this.#signal?.aborted) || performance.now() >= this.#deadline) { this.kill(); throw unavailable() }
    const remaining = Math.max(0, this.#deadline - performance.now())
    const wire = { version: 1, ...request, wait_ms: Math.min(0xffff_ffff, Math.ceil(remaining)) } as OpenCodeWindowsPublicationRequest
    const encoded = `${JSON.stringify(wire)}\n`
    if (new TextEncoder().encode(encoded).byteLength > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw unavailable()
    this.#child.stdin.write(encoded)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const line = await Promise.race([this.#readLine(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), remaining); timer.unref?.() }), this.#child.exited.then(() => { throw unavailable() })])
      return decodeOpenCodeWindowsPublicationReply(line, request.id)
    } catch { this.kill(); throw unavailable() } finally { if (timer) clearTimeout(timer) }
  }
  async #readLine(): Promise<string> {
    for (;;) {
      const newline = this.#pending.indexOf('\n')
      if (newline >= 0) { const line = this.#pending.slice(0, newline); this.#pending = this.#pending.slice(newline + 1); this.#pendingBytes = new TextEncoder().encode(this.#pending).byteLength; return line }
      const next = await this.#reader.read(); if (next.done) throw unavailable()
      this.#pendingBytes += next.value.byteLength; if (this.#pendingBytes > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw unavailable()
      try { this.#pending += this.#decoder.decode(next.value, { stream: true }) } catch { throw unavailable() }
    }
  }
}
