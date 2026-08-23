import { randomUUID } from 'node:crypto'
import {
  launchOpenCodeNativeAuthority, resolveOpenCodeNativeAuthorityArtifacts,
  verifyOpenCodeNativeAuthorityArtifacts, type OpenCodeNativeAuthorityChild,
} from './OpenCodeNativeAuthorityArtifacts.js'
import { decodeOpenCodeWindowsPublicationReply, OpenCodeWindowsPublicationRejectedError, OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  validOpenCodePublicationLeaf, validOpenCodePublicationMaterializationKey, validOpenCodePublicationRoot,
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
  #deadline: number
  readonly #signal?: AbortSignal
  readonly #decoder = new TextDecoder('utf-8', { fatal: true })
  #pending = ''; #pendingBytes = 0; #closed = false; #retained = false
  #physicalSettlement: Promise<unknown> = Promise.resolve()
  #ownerDeadline: ReturnType<typeof setTimeout> | undefined
  #abort = () => { void this.#cancelAfterSettlement() }

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
    // A lost owner cannot strand a no-delete-sharing NTFS lease forever.
    this.#armOwnerReaper()
    return value as { volumeSerial: string; fileId: string; createdPaths: string[] }
  }
  async validateRoot(): Promise<void> { await this.#request({ id: randomUUID(), op: 'VALIDATE_ROOT' }) }
  async syncRoot(): Promise<void> { await this.#request({ id: randomUUID(), op: 'SYNC_ROOT' }) }
  async pinRegular(name: string, denyWrites = false, parentKey = '.'): Promise<Readonly<{ volumeSerial: string; fileId: string; size: string }>> {
    if (!validOpenCodePublicationLeaf(name) || (parentKey !== '.' && !validOpenCodePublicationMaterializationKey(parentKey))) throw unavailable()
    const value = await this.#request({ id: randomUUID(),
      op: denyWrites ? 'PIN_REGULAR_READONLY' : 'PIN_REGULAR', parent_key: parentKey, name }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId)) || !/^\d+$/.test(String(value?.size))) throw unavailable()
    return value as { volumeSerial: string; fileId: string; size: string }
  }
  async openChildDirectory(parentKey: string, key: string, name: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    if ((parentKey !== '.' && !validOpenCodePublicationMaterializationKey(parentKey))
      || !validOpenCodePublicationMaterializationKey(key) || !validOpenCodePublicationLeaf(name)
      || key !== (parentKey === '.' ? name : `${parentKey}/${name}`)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'OPEN_CHILD_DIRECTORY', parent_key: parentKey, key, name }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))) throw unavailable()
    return value as { volumeSerial: string; fileId: string }
  }
  async createDirectory(name: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    if (!validOpenCodePublicationLeaf(name)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'CREATE_DIRECTORY', name }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))) throw unavailable()
    return value as { volumeSerial: string; fileId: string }
  }
  async createChildDirectory(parentKey: string, key: string, name: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    return this.#createChild('CREATE_CHILD_DIRECTORY', parentKey, key, name)
  }
  async createChildFile(parentKey: string, key: string, name: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    return this.#createChild('CREATE_CHILD_FILE', parentKey, key, name)
  }
  async #createChild(op: 'CREATE_CHILD_DIRECTORY' | 'CREATE_CHILD_FILE', parentKey: string, key: string,
    name: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    if (!validOpenCodePublicationMaterializationKey(parentKey)
      || !validOpenCodePublicationMaterializationKey(key)
      || !validOpenCodePublicationLeaf(name) || key !== `${parentKey}/${name}`) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op, parent_key: parentKey, key, name }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))) throw unavailable()
    return value as { volumeSerial: string; fileId: string }
  }
  async writeChildFile(key: string, offset: number, content: Uint8Array, finish: boolean): Promise<number> {
    if (!validOpenCodePublicationMaterializationKey(key) || !Number.isSafeInteger(offset) || offset < 0
      || content.byteLength > 44 * 1024) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'WRITE_CHILD_FILE', key, offset,
      content_base64: Buffer.from(content).toString('base64'), finish }) as Record<string, unknown>
    const written = offset + content.byteLength
    if (String(value?.written) !== String(written) || value?.finished !== finish) throw unavailable()
    return written
  }
  async renameDirectory(from: string, to: string): Promise<Readonly<{ volumeSerial: string; fileId: string }>> {
    if (!validOpenCodePublicationLeaf(from) || !validOpenCodePublicationLeaf(to)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'RENAME_DIRECTORY', from, to }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))) throw unavailable()
    return value as { volumeSerial: string; fileId: string }
  }
  async rollbackDirectory(rootKey: string): Promise<void> {
    if (!validOpenCodePublicationLeaf(rootKey)) throw unavailable()
    await this.#request({ id: randomUUID(), op: 'ROLLBACK_DIRECTORY', root_key: rootKey })
  }
  async prepareAtomic(finalName: string, temporaryName: string, backupName: string,
    quarantineName: string, recoveryName: string, content: Uint8Array,
    expectedPrior: string | null | undefined = undefined): Promise<Readonly<{ volumeSerial: string; fileId: string; size: string }>> {
    if (![finalName, temporaryName, backupName, quarantineName, recoveryName].every(validOpenCodePublicationLeaf)
      || content.byteLength > 44 * 1024) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'PREPARE_ATOMIC', final_name: finalName,
      temporary_name: temporaryName, backup_name: backupName, quarantine_name: quarantineName,
      recovery_name: recoveryName,
      expected_prior: expectedPrior === undefined ? 'any' : expectedPrior === null ? 'absent' : expectedPrior,
      content_base64: Buffer.from(content).toString('base64') }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))
      || String(value?.size) !== String(content.byteLength)) throw unavailable()
    return value as { volumeSerial: string; fileId: string; size: string }
  }
  async commitAtomic(): Promise<void> { await this.#request({ id: randomUUID(), op: 'COMMIT_ATOMIC' }) }
  async rollbackAtomic(): Promise<void> { await this.#request({ id: randomUUID(), op: 'ROLLBACK_ATOMIC' }) }
  async close(): Promise<void> { if (this.#closed) return; try { if (this.#retained) await this.#request({ id: randomUUID(), op: 'CLOSE' }) } catch {} finally { this.kill() } }
  kill(): void { if (this.#closed) return; this.#closed = true; if (this.#ownerDeadline) clearTimeout(this.#ownerDeadline); this.#signal?.removeEventListener('abort', this.#abort); try { this.#child.stdin.end() } catch {}; try { this.#child.kill('SIGKILL') } catch {} }

  #armOwnerReaper(): void {
    if (this.#closed || !this.#retained) return
    if (this.#ownerDeadline) clearTimeout(this.#ownerDeadline)
    const remaining = Math.max(1, this.#deadline - performance.now())
    const beforeAbsoluteDeadline = Math.max(1, remaining - Math.min(10_000, Math.max(100, remaining / 10)))
    this.#ownerDeadline = setTimeout(
      () => { void this.#markRecoveryAndKill() },
      Math.min(90_000, beforeAbsoluteDeadline),
    )
    this.#ownerDeadline.unref?.()
  }
  async #markRecoveryAndKill(): Promise<void> {
    if (this.#closed) return
    try { await this.#request({ id: randomUUID(), op: 'MARK_RECOVERY_REQUIRED' }) } catch {}
    finally { this.kill() }
  }

  async #cancelAfterSettlement(): Promise<void> {
    // Abort never tears a native mutation out from under its retained NTFS
    // handles.  First observe physical command settlement, then publish the
    // recovery marker through the same authority, and only then terminate it.
    await this.#physicalSettlement.catch(() => undefined)
    if (this.#closed) return
    if (this.#retained) await this.#markRecoveryAndKill()
    else this.kill()
  }

  async #request(request: Pending): Promise<unknown> {
    const settlementCommand = request.op === 'MARK_RECOVERY_REQUIRED' || request.op === 'CLOSE'
    if (this.#closed || (!settlementCommand && this.#signal?.aborted) || performance.now() >= this.#deadline) {
      if (!this.#retained) this.kill()
      throw unavailable()
    }
    const remaining = Math.max(0, this.#deadline - performance.now())
    const wire = { version: 1, ...request, wait_ms: Math.min(0xffff_ffff, Math.ceil(remaining)) } as OpenCodeWindowsPublicationRequest
    const encoded = `${JSON.stringify(wire)}\n`
    if (new TextEncoder().encode(encoded).byteLength > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw unavailable()
    this.#child.stdin.write(encoded)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const physical = Promise.race([this.#readLine(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), remaining); timer.unref?.() }), this.#child.exited.then(() => { throw unavailable() })])
      this.#physicalSettlement = physical
      const line = await physical
      const value = decodeOpenCodeWindowsPublicationReply(line, request.id)
      if (request.op !== 'MARK_RECOVERY_REQUIRED' && request.op !== 'CLOSE') this.#armOwnerReaper()
      return value
    } catch (error) {
      if (error instanceof OpenCodeWindowsPublicationRejectedError && this.#retained) throw unavailable()
      this.kill(); throw unavailable()
    } finally { if (timer) clearTimeout(timer) }
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
