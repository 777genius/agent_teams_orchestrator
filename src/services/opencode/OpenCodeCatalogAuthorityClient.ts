import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  decodeAuthorityReply,
  OPENCODE_CATALOG_MAX_ENVELOPE_BYTES,
  OPENCODE_CATALOG_MAX_WIRE_BYTES,
  type OpenCodeCatalogAuthorityIdentity,
  type OpenCodeCatalogAuthorityRequest,
  type OpenCodeCatalogBeginReply,
  type OpenCodeCatalogBindReply,
  type OpenCodeCatalogFinalizeReply,
  type OpenCodeCatalogResolveReply,
} from './OpenCodeCatalogAuthorityProtocol.js'

const COMMIT_RESOLVE_RESERVE_MS = 250

export class OpenCodeCatalogCommitUncertainError extends Error {
  constructor() {
    super('catalog authority commit outcome is uncertain')
    this.name = 'OpenCodeCatalogCommitUncertainError'
  }
}

type Child = Readonly<{
  pid: number
  stdin: { write(value: string): number; end(): void }
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: NodeJS.Signals | number): void
  unref(): void
}>

export type OpenCodeCatalogAuthorityLaunch = (input: Readonly<{
  cacheHome: string
  launcherPath: string
  workerPath: string
}>) => Child

export type OpenCodeCatalogAuthorityClientOptions = Readonly<{
  deadline: number
  signal: AbortSignal
  cacheHome?: string
  launch?: OpenCodeCatalogAuthorityLaunch
  launcherPath?: string
  workerPath?: string
}>

function cacheHome(): string {
  const explicit = process.env.CLAUDE_MULTIMODEL_CACHE_HOME
  if (explicit !== undefined) {
    if (!path.isAbsolute(explicit)) throw new Error('catalog cache home must be absolute')
    return explicit
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'claude-multimodel-nodejs', 'Cache')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'claude-multimodel-nodejs')
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
    'claude-multimodel-nodejs')
}

function artifactName(base: string): string {
  return `${base}${process.platform === 'win32' ? '.exe' : ''}`
}

function resolveArtifacts(options: OpenCodeCatalogAuthorityClientOptions): {
  launcherPath: string; workerPath: string
} {
  if (options.launcherPath && options.workerPath) {
    return { launcherPath: options.launcherPath, workerPath: options.workerPath }
  }
  const bunHostedBundle = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
  const packaged = bunHostedBundle ? import.meta.dir : path.dirname(process.execPath)
  const sourceRoot = path.resolve(import.meta.dir, '../../..')
  const debug = (crate: string, binary: string) => path.join(sourceRoot, 'native', crate,
    'target', 'debug', artifactName(binary))
  const launcherName = artifactName('opencode-catalog-launcher')
  const workerName = artifactName('opencode-catalog-authority')
  const sourceRuntime = import.meta.url.endsWith('.ts')
  return {
    launcherPath: options.launcherPath ?? (sourceRuntime
      ? debug('opencode-catalog-launcher', 'opencode-catalog-launcher')
      : path.join(packaged, launcherName)),
    workerPath: options.workerPath ?? (sourceRuntime
      ? debug('opencode-catalog-authority', 'opencode-catalog-authority')
      : path.join(packaged, workerName)),
  }
}

function verifyRegularOwnedArtifact(filePath: string): void {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const held = fstatSync(fd, { bigint: true })
    const named = lstatSync(filePath, { bigint: true })
    if (!held.isFile() || !named.isFile() || named.isSymbolicLink()
      || held.dev !== named.dev || held.ino !== named.ino
      || (typeof process.getuid === 'function' && held.uid !== BigInt(process.getuid()))
      // Windows mode bits are synthesized as 0666 even when the containing
      // release ACL is not writable. The native launcher supplies the real
      // delete/write-denying same-object check there.
      || (process.platform !== 'win32' && (held.mode & 0o022n) !== 0n)) {
      throw new Error('untrusted native catalog artifact')
    }
  } finally { closeSync(fd) }
}

function productionLaunch(input: Readonly<{ cacheHome: string; launcherPath: string; workerPath: string }>): Child {
  // The launcher opens and retains the worker with no-follow and executes that
  // exact object (execveat/fexecve, or a delete-denying Windows handle + job).
  // Bun only names the small launcher; it never names the authority worker.
  return Bun.spawn({
    cmd: [input.launcherPath, input.workerPath, input.cacheHome],
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  }) as unknown as Child
}

export class OpenCodeCatalogAuthorityClient {
  readonly #child: Child
  readonly #deadline: number
  readonly #signal: AbortSignal
  readonly #options: OpenCodeCatalogAuthorityClientOptions
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #decoder = new TextDecoder()
  #pending = ''
  #pendingBytes = 0
  #closed = false
  #committed = false

  constructor(options: OpenCodeCatalogAuthorityClientOptions) {
    if (!Number.isFinite(options.deadline) || options.signal.aborted) throw new Error('expired authority attempt')
    this.#deadline = options.deadline
    this.#signal = options.signal
    this.#options = options
    const artifacts = resolveArtifacts(options)
    if (!options.launch) {
      verifyRegularOwnedArtifact(artifacts.launcherPath)
      verifyRegularOwnedArtifact(artifacts.workerPath)
    }
    this.#child = (options.launch ?? productionLaunch)({
      cacheHome: options.cacheHome ?? cacheHome(), ...artifacts,
    })
    this.#child.unref()
    this.#reader = this.#child.stdout.getReader()
    options.signal.addEventListener('abort', () => this.kill(), { once: true })
  }

  get committed(): boolean { return this.#committed }

  async beginAttempt(startedAt: number, scopeHash: string): Promise<OpenCodeCatalogBeginReply> {
    const value = await this.#request({ id: randomUUID(), op: 'BEGIN_ATTEMPT',
      started_at: startedAt, scope_hash: scopeHash }) as Partial<OpenCodeCatalogBeginReply>
    if (!Number.isSafeInteger(value.generation) || (value.generation ?? 0) < 1
      || !/^sha256:[0-9a-f]{64}$/.test(String(value.attemptIdentity))) throw new Error('invalid begin reply')
    return value as OpenCodeCatalogBeginReply
  }

  async bindAndRead(generation: number, attemptIdentity: `sha256:${string}`,
    identity: OpenCodeCatalogAuthorityIdentity): Promise<OpenCodeCatalogBindReply> {
    const value = await this.#request({ id: randomUUID(), op: 'BIND_AND_READ', generation,
      attempt_identity: attemptIdentity, identity }) as Partial<OpenCodeCatalogBindReply>
    if (value.previousEnvelope !== null && typeof value.previousEnvelope !== 'string') {
      throw new Error('invalid bind reply')
    }
    return value as OpenCodeCatalogBindReply
  }

  async finalize(generation: number, attemptIdentity: `sha256:${string}`,
    identity: OpenCodeCatalogAuthorityIdentity, envelopeJson: string,
    observedAt: number, expiresAt: number): Promise<OpenCodeCatalogFinalizeReply> {
    if (new TextEncoder().encode(envelopeJson).byteLength > OPENCODE_CATALOG_MAX_ENVELOPE_BYTES) {
      throw new Error('catalog envelope too large')
    }
    let value: Partial<OpenCodeCatalogFinalizeReply>
    try {
      value = await this.#request({ id: randomUUID(), op: 'FINALIZE', generation,
        attempt_identity: attemptIdentity, identity, envelope_json: envelopeJson,
        observed_at: observedAt, expires_at: expiresAt },
      Math.max(performance.now(), this.#deadline - COMMIT_RESOLVE_RESERVE_MS)) as Partial<OpenCodeCatalogFinalizeReply>
    } catch (finalizeError) {
      if (finalizeError instanceof Error
        && finalizeError.message.startsWith('catalog authority rejected ')) throw finalizeError
      // The worker may have durably committed and then died before stdout was
      // flushed.  Resolve through a fresh verified worker using the durable
      // attempt/generation key; never guess from the old cached envelope.
      this.kill()
      if (this.#signal.aborted || performance.now() >= this.#deadline) {
        throw new OpenCodeCatalogCommitUncertainError()
      }
      let recovery: OpenCodeCatalogAuthorityClient | null = null
      try {
        recovery = new OpenCodeCatalogAuthorityClient({ ...this.#options,
          deadline: this.#deadline, signal: this.#signal })
        const resolved = await recovery.resolve(generation, attemptIdentity, identity)
        if (!resolved.resolved) throw new OpenCodeCatalogCommitUncertainError()
        if (!resolved.committed) throw finalizeError
        if (resolved.envelopeJson !== envelopeJson) throw new OpenCodeCatalogCommitUncertainError()
        value = { committed: true, generation }
      } catch (resolveError) {
        if (resolveError === finalizeError) throw resolveError
        if (resolveError instanceof OpenCodeCatalogCommitUncertainError) throw resolveError
        throw new OpenCodeCatalogCommitUncertainError()
      } finally { await recovery?.close() }
    }
    if (value.committed !== true || value.generation !== generation) throw new Error('invalid finalize reply')
    // From this acknowledgement onward caller time/cancellation and profile
    // cleanup are observations only; they cannot revoke the committed result.
    this.#committed = true
    return value as OpenCodeCatalogFinalizeReply
  }

  async resolve(generation: number, attemptIdentity: `sha256:${string}`,
    identity: OpenCodeCatalogAuthorityIdentity): Promise<OpenCodeCatalogResolveReply> {
    const value = await this.#request({ id: randomUUID(), op: 'RESOLVE', generation,
      attempt_identity: attemptIdentity, identity }) as Partial<OpenCodeCatalogResolveReply>
    if (typeof value.resolved !== 'boolean' || value.generation !== generation
      || (value.resolved && typeof value.committed !== 'boolean')
      || (!value.resolved && (value.committed !== undefined || value.envelopeJson !== undefined))
      || (value.committed === true && typeof value.envelopeJson !== 'string')
      || (value.committed === false && value.envelopeJson !== undefined)) {
      throw new Error('invalid resolve reply')
    }
    return value as OpenCodeCatalogResolveReply
  }

  async close(): Promise<void> {
    if (this.#closed) return
    try {
      if (!this.#signal.aborted && performance.now() < this.#deadline) {
        await this.#request({ id: randomUUID(), op: 'CLOSE' })
      }
    } catch { /* cleanup never changes an acknowledged commit */ }
    this.kill()
  }

  kill(): void {
    if (this.#closed) return
    this.#closed = true
    try { this.#child.stdin.end() } catch {}
    try { this.#child.kill('SIGKILL') } catch {}
    if (process.platform !== 'win32') {
      // The native launcher makes the attempt a process group before exec.
      try { process.kill(-this.#child.pid, 'SIGKILL') } catch {}
    }
  }

  async #request(request: OpenCodeCatalogAuthorityRequest,
    requestDeadline = this.#deadline): Promise<unknown> {
    if (this.#closed || this.#signal.aborted || performance.now() >= this.#deadline) {
      this.kill(); throw new Error('catalog authority deadline')
    }
    const encoded = `${JSON.stringify(request)}\n`
    if (new TextEncoder().encode(encoded).byteLength > OPENCODE_CATALOG_MAX_WIRE_BYTES + 1) {
      throw new Error('catalog authority request too large')
    }
    this.#child.stdin.write(encoded)
    const remaining = Math.max(0, requestDeadline - performance.now())
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { this.kill(); reject(new Error('catalog authority deadline')) }, remaining)
      timer.unref?.()
    })
    try {
      const line = await Promise.race([this.#readLine(), timeout])
      const reply = decodeAuthorityReply(line, request.id)
      if (!reply.ok) throw new Error(`catalog authority rejected ${reply.error}`)
      return reply.value
    } finally { if (timer) clearTimeout(timer) }
  }

  async #readLine(): Promise<string> {
    for (;;) {
      const newline = this.#pending.indexOf('\n')
      if (newline >= 0) {
        const line = this.#pending.slice(0, newline)
        this.#pending = this.#pending.slice(newline + 1)
        this.#pendingBytes = new TextEncoder().encode(this.#pending).byteLength
        return line
      }
      const chunk = await this.#reader.read()
      if (chunk.done) throw new Error('catalog authority exited')
      this.#pendingBytes += chunk.value.byteLength
      if (this.#pendingBytes > OPENCODE_CATALOG_MAX_WIRE_BYTES + 1) {
        throw new Error('catalog authority reply too large')
      }
      this.#pending += this.#decoder.decode(chunk.value, { stream: true })
    }
  }
}
