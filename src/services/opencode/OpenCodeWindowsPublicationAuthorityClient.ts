import { randomUUID } from 'node:crypto'
import {
  launchOpenCodeNativeAuthority, resolveOpenCodeNativeAuthorityArtifacts,
  verifyOpenCodeNativeAuthorityArtifacts, type OpenCodeNativeAuthorityChild,
} from './OpenCodeNativeAuthorityArtifacts.js'
import { decodeOpenCodeWindowsPublicationReply, OpenCodeWindowsPublicationRejectedError, OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  validOpenCodePublicationLeaf, validOpenCodePublicationMaterializationKey, validOpenCodePublicationRoot,
  validOpenCodePublicationRelativePath,
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
  readonly #cancelled: Promise<void>
  #cancel!: () => void
  #pending = ''; #pendingBytes = 0; #closed = false; #retained = false
  #queue: Promise<void> = Promise.resolve()
  #ownerDeadline: ReturnType<typeof setTimeout> | undefined
  #abort = () => { this.kill() }

  constructor(options: OpenCodeWindowsPublicationAuthorityOptions) {
    if (!Number.isFinite(options.deadline) || options.deadline <= performance.now() || options.signal?.aborted) throw unavailable()
    this.#cancelled = new Promise(resolve => { this.#cancel = resolve })
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
  async recoverAtomic(recoveryName: string, decision: 'commit' | 'rollback'): Promise<boolean> {
    if (!validOpenCodePublicationLeaf(recoveryName)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'RECOVER_ATOMIC', recovery_name: recoveryName,
      decision }) as Record<string, unknown>
    if (typeof value?.recovered !== 'boolean') throw unavailable()
    return value.recovered
  }
  async namespaceStat(relativePath: string): Promise<Readonly<{ volumeSerial: string; fileId: string; size: string; kind: 'file' | 'directory' }>> {
    if (!validOpenCodePublicationRelativePath(relativePath)) throw unavailable()
    const value = await this.#request({ id: randomUUID(), op: 'NS_STAT', path: relativePath }) as Record<string, unknown>
    if (!/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))
      || !/^\d+$/.test(String(value?.size)) || (value?.kind !== 'file' && value?.kind !== 'directory')) throw unavailable()
    return value as { volumeSerial: string; fileId: string; size: string; kind: 'file' | 'directory' }
  }
  async namespaceMkdir(relativePath: string): Promise<void> {
    if (!validOpenCodePublicationRelativePath(relativePath) || relativePath === '.') throw unavailable()
    await this.#request({ id: randomUUID(), op: 'NS_MKDIR', path: relativePath })
  }
  async namespaceOpen(relativePath: string, mode: 'read' | 'readwrite' | 'create_file' | 'directory'):
  Promise<Readonly<{ token: string; volumeSerial: string; fileId: string; size: string; kind: 'file' | 'directory' }>> {
    if (!validOpenCodePublicationRelativePath(relativePath)) throw unavailable()
    const token = randomUUID()
    const value = await this.#request({ id: randomUUID(), op: 'NS_OPEN', path: relativePath, token, mode }) as Record<string, unknown>
    if (typeof value?.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)
      || !/^\d+$/.test(String(value?.volumeSerial)) || !/^\d+$/.test(String(value?.fileId))
      || value.token !== token || !/^\d+$/.test(String(value?.size)) || (value?.kind !== 'file' && value?.kind !== 'directory')) throw unavailable()
    return value as { token: string; volumeSerial: string; fileId: string; size: string; kind: 'file' | 'directory' }
  }
  async namespaceRead(token: string, size: number): Promise<Uint8Array> {
    if (!/^[0-9a-f-]{36}$/.test(token) || !Number.isSafeInteger(size) || size < 0 || size > 1_048_576) throw unavailable()
    const chunks: Uint8Array[] = []; let offset = 0
    while (offset < size) {
      const length = Math.min(32 * 1024, size - offset)
      const value = await this.#request({ id: randomUUID(), op: 'NS_READ', token, offset, length }) as Record<string, unknown>
      if (typeof value?.content_base64 !== 'string') throw unavailable()
      const chunk = Buffer.from(value.content_base64, 'base64')
      if (chunk.byteLength > length || (chunk.byteLength === 0 && offset < size)) throw unavailable()
      chunks.push(chunk); offset += chunk.byteLength
      if (chunk.byteLength < length) break
    }
    return Buffer.concat(chunks)
  }
  async namespaceWrite(token: string, bytes: Uint8Array): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(token) || bytes.byteLength > 1_048_576) throw unavailable()
    let offset = 0
    do {
      const end = Math.min(bytes.byteLength, offset + 32 * 1024)
      const value = await this.#request({ id: randomUUID(), op: 'NS_WRITE', token, offset,
        truncate: offset === 0, content_base64: Buffer.from(bytes.subarray(offset, end)).toString('base64') }) as Record<string, unknown>
      if (String(value?.written) !== String(end)) throw unavailable()
      offset = end
    } while (offset < bytes.byteLength)
  }
  async namespaceSyncHandle(token: string): Promise<void> { await this.#namespaceToken('NS_SYNC_HANDLE', token) }
  async namespaceCloseHandle(token: string): Promise<void> { await this.#namespaceToken('NS_CLOSE_HANDLE', token) }
  async #namespaceToken(op: 'NS_SYNC_HANDLE' | 'NS_CLOSE_HANDLE', token: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(token)) throw unavailable()
    await this.#request({ id: randomUUID(), op, token })
  }
  async namespaceRename(from: string, to: string): Promise<void> {
    if (![from, to].every(validOpenCodePublicationRelativePath) || from === '.' || to === '.') throw unavailable()
    await this.#request({ id: randomUUID(), op: 'NS_RENAME', from, to })
  }
  async namespaceUnlink(relativePath: string, directory: boolean): Promise<void> {
    if (!validOpenCodePublicationRelativePath(relativePath) || relativePath === '.') throw unavailable()
    await this.#request({ id: randomUUID(), op: 'NS_UNLINK', path: relativePath, directory })
  }
  async namespaceSyncDirectory(relativePath = '.'): Promise<void> {
    if (!validOpenCodePublicationRelativePath(relativePath)) throw unavailable()
    await this.#request({ id: randomUUID(), op: 'NS_SYNC_DIRECTORY', path: relativePath })
  }
  async close(): Promise<void> { if (this.#closed) return; try { if (this.#retained) await this.#request({ id: randomUUID(), op: 'CLOSE' }) } catch {} finally { this.kill() } }
  kill(): void { if (this.#closed) return; this.#closed = true; this.#cancel(); if (this.#ownerDeadline) clearTimeout(this.#ownerDeadline); this.#signal?.removeEventListener('abort', this.#abort); try { this.#child.stdin.end() } catch {}; try { this.#child.kill('SIGKILL') } catch {} }

  #armOwnerReaper(): void {
    if (this.#closed || !this.#retained) return
    if (this.#ownerDeadline) clearTimeout(this.#ownerDeadline)
    const remaining = Math.max(1, this.#deadline - performance.now())
    // A live owner retains authority for its complete launch deadline. Owner
    // loss is signalled by AbortSignal; this timer is only the immutable
    // absolute-deadline backstop, never an independent lease.
    this.#ownerDeadline = setTimeout(() => this.kill(), remaining)
    this.#ownerDeadline.unref?.()
  }

  async #request(request: Pending): Promise<unknown> {
    let resolve!: (value: unknown) => void; let reject!: (reason?: unknown) => void
    const result = new Promise<unknown>((yes, no) => { resolve = yes; reject = no })
    const scheduled = this.#queue.then(async () => {
      try { resolve(await this.#executeRequest(request)) } catch (error) { reject(error) }
    })
    this.#queue = scheduled.catch(() => {})
    return result
  }

  async #executeRequest(request: Pending): Promise<unknown> {
    const settlementCommand = request.op === 'MARK_RECOVERY_REQUIRED' || request.op === 'CLOSE'
    if (this.#closed || this.#signal?.aborted || performance.now() >= this.#deadline) throw unavailable()
    const remaining = Math.max(0, this.#deadline - performance.now())
    const wire = { version: 1, ...request, wait_ms: Math.min(0xffff_ffff, Math.ceil(remaining)) } as OpenCodeWindowsPublicationRequest
    const encoded = `${JSON.stringify(wire)}\n`
    if (new TextEncoder().encode(encoded).byteLength > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw unavailable()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      this.#child.stdin.write(encoded)
      const physical = Promise.race([this.#readLine(), this.#child.exited.then(() => { throw unavailable() })])
      const line = await Promise.race([physical, this.#cancelled.then(() => { throw unavailable() }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { this.kill(); reject(unavailable()) }, remaining); timer.unref?.() })])
      const value = decodeOpenCodeWindowsPublicationReply(line, request.id)
      if (!settlementCommand && (this.#signal?.aborted || performance.now() >= this.#deadline)) {
        this.kill(); throw unavailable()
      }
      if (request.op !== 'MARK_RECOVERY_REQUIRED' && request.op !== 'CLOSE') this.#armOwnerReaper()
      return value
    } catch (error) {
      if (error instanceof OpenCodeWindowsPublicationRejectedError && this.#retained
        && request.op.startsWith('NS_')) throw error
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
