import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseHostedActualOwnerNativePublication } from '../../entrypoints/hostedActualOwnerAcceptance.js'

import {
  HostedActualOwnerNativeWriter,
  HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES,
  attestHostedActualOwnerWalOperationEnvelope,
  hostedActualOwnerStartToken,
  type HostedActualOwnerClock,
  type HostedActualOwnerReplacementLineage,
} from './HostedActualOwnerNativeWriter.js'
import type { HostedApprovalOwnerWalOperationEnvelope } from './HostedApprovalOwnerWal.js'
import {
  createOwnerProvenanceNodeOperations,
  createOwnerWalPublicationProducerFromEnvironment,
  type OwnerProvenanceOperations,
  type OwnerWalImageCustodian,
  type OwnerWalPublicationProducer,
  type BoundWalPublication,
  type PreviousWalImage,
  type RetainedWalImage,
} from './HostedApprovalOwnerProvenance.js'

export const HOSTED_ACTUAL_OWNER_CORPUS_FILE = 'hosted-actual-owner-publications.v1.ndjson'
export const HOSTED_ACTUAL_OWNER_LINEAGE_FILE = 'hosted-actual-owner-lineage.v1.json'
const CUSTODY_DIRECTORY = '.hosted-actual-owner-custody'

export type HostedActualOwnerCaptureFileOperations = Readonly<{
  open(path: string, flags: number, mode: number): number
  write(fd: number, bytes: Uint8Array, offset: number): number
  sync(fd: number): void
  close(fd: number): void
}>

const nodeFiles: HostedActualOwnerCaptureFileOperations = {
  open: openSync,
  write: (fd, bytes, offset) => writeSync(fd, bytes, offset, bytes.byteLength - offset),
  sync: fsyncSync,
  close: closeSync,
}

/** Explicit live-capture inputs admitted by Main before any capture resource opens. */
export type HostedActualOwnerCaptureConfiguration = Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  modulePath: string
  ownerGeneration: string
  provenanceOperations?: OwnerProvenanceOperations
  fileOperations?: HostedActualOwnerCaptureFileOperations
}>

type StagedCustody = {
  previous: PreviousWalImage
  next: RetainedWalImage
  paths: Array<{ path: string; image: RetainedWalImage }>
}

/** One process-owned producer/custody/corpus lifetime shared by every Owner WAL. */
export class HostedActualOwnerCaptureSession {
  readonly producer: OwnerWalPublicationProducer
  readonly #writer: HostedActualOwnerNativeWriter
  readonly #files: HostedActualOwnerCaptureFileOperations
  readonly #corpusFd: number
  readonly #lineagePath: string
  readonly #walPath: string
  readonly #ownerGeneration: string
  readonly #staged = new Map<string, StagedCustody>()
  #operationTail: Promise<void> = Promise.resolve()
  #tail: Promise<void> = Promise.resolve()
  #closed = false
  #closePromise: Promise<void> | null = null
  #poison: Error | null = null
  #collectProducerCleanupFailures = false
  readonly #producerCleanupFailures: unknown[] = []
  #lineage: HostedActualOwnerReplacementLineage | null = null
  #prior: { ownerStartToken: string; ownerGeneration: string } | null

  static open(input: Readonly<{
    canonicalTeamRoot: string
    walPath: string
    configuration: HostedActualOwnerCaptureConfiguration
  }>): HostedActualOwnerCaptureSession | null {
    validatePaths(input.canonicalTeamRoot, input.walPath, input.configuration.modulePath)
    if (input.configuration.environment.CLAUDE_TEAM_PRODUCER_PROVENANCE_V2 === undefined) return null
    return new HostedActualOwnerCaptureSession(input)
  }

  private constructor(input: Readonly<{
    canonicalTeamRoot: string
    walPath: string
    configuration: HostedActualOwnerCaptureConfiguration
  }>) {
    this.#files = input.configuration.fileOperations ?? nodeFiles
    this.#walPath = input.walPath
    this.#ownerGeneration = input.configuration.ownerGeneration
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(this.#ownerGeneration)) {
      throw new TypeError('hosted_actual_owner_generation_invalid')
    }
    const custodyRoot = join(input.canonicalTeamRoot, CUSTODY_DIRECTORY)
    mkdirSync(custodyRoot, { recursive: true, mode: 0o700 })
    const custodyStat = lstatSync(custodyRoot)
    if (!custodyStat.isDirectory() || custodyStat.isSymbolicLink() || (custodyStat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && custodyStat.uid !== process.getuid())) {
      throw new Error('hosted_actual_owner_custody_directory_unsafe')
    }
    this.#lineagePath = join(input.canonicalTeamRoot, HOSTED_ACTUAL_OWNER_LINEAGE_FILE)
    const corpusPath = join(input.canonicalTeamRoot, HOSTED_ACTUAL_OWNER_CORPUS_FILE)
    this.#prior = readPriorLineage(this.#lineagePath, corpusPath)
    if (!this.#prior && existsSync(this.#walPath)) {
      throw new Error('hosted_actual_owner_initial_lineage_unproven')
    }
    const custodian: OwnerWalImageCustodian = { prepare: (previous, next) => {
      this.#assertHealthy()
      const key = randomUUID().replaceAll('-', '')
      const paths: Array<{ path: string; image: RetainedWalImage }> = []
      try {
        if (previous.kind === 'retained') paths.push({ path: stageImage(custodyRoot, `${key}.p`, previous.image, this.#files), image: previous.image })
        paths.push({ path: stageImage(custodyRoot, `${key}.n`, next, this.#files), image: next })
      } catch (error) { return this.#fail(error) }
      const staged = { previous, next, paths }
      return Object.freeze({ bind: (emission: { emissionNonce: string }) => {
        this.#assertHealthy()
        for (const item of paths) verifyStagedImage(item.path, item.image)
        this.#staged.set(emission.emissionNonce, staged)
        return Object.freeze({ previous, next })
      } })
    } }
    const provenance = input.configuration.provenanceOperations ?? createOwnerProvenanceNodeOperations()
    const producer = createOwnerWalPublicationProducerFromEnvironment({
      environment: input.configuration.environment,
      modulePath: input.configuration.modulePath,
      operations: {
        identity: modulePath => provenance.identity(modulePath),
        descriptor: fd => provenance.descriptor(fd),
        nonce: () => provenance.nonce(),
        write: (fd, bytes, offset) => provenance.write(fd, bytes, offset),
        sync: fd => {
          try { provenance.sync(fd) } catch (error) {
            if (this.#collectProducerCleanupFailures) this.#producerCleanupFailures.push(error)
            throw error
          }
        },
        close: fd => {
          try { provenance.close(fd) } catch (error) {
            if (this.#collectProducerCleanupFailures) this.#producerCleanupFailures.push(error)
            throw error
          }
        },
      },
      imageCustodian: custodian,
      onPoison: error => { this.#poison ??= error },
    })
    if (!producer) throw new Error('hosted_actual_owner_capture_configuration_missing')
    this.producer = producer
    let corpusFd: number
    try { corpusFd = this.#files.open(corpusPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) {
      try { producer.close() } catch { /* corpus-open failure remains authoritative */ }
      throw error
    }
    this.#corpusFd = corpusFd
    const stat = fstatSync(this.#corpusFd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
      try { this.#files.close(this.#corpusFd) } finally { producer.close() }
      throw new Error('hosted_actual_owner_corpus_unsafe')
    }
    this.#writer = new HostedActualOwnerNativeWriter({ append: bytes => {
      assertCorpusLinked(corpusPath, this.#corpusFd)
      writeAll(this.#corpusFd, bytes, this.#files)
      this.#files.sync(this.#corpusFd)
      assertCorpusLinked(corpusPath, this.#corpusFd)
    } })
  }

  begin(): HostedActualOwnerClock { this.#assertHealthy(); return clock() }

  /** Serializes WAL replacement through corpus acceptance for every Store in this capture session. */
  async serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#operationTail
    let release!: () => void
    this.#operationTail = new Promise(resolve => { release = resolve })
    await prior
    try { this.#assertHealthy(); return await operation() } finally { release() }
  }

  async accept<T>(envelope: HostedApprovalOwnerWalOperationEnvelope<T>, operationContext?: unknown): Promise<void> {
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise(resolve => { release = resolve })
    await prior
    try {
      this.#assertHealthy()
      if (!operationContext || typeof operationContext !== 'object' ||
        !('monotonicNs' in operationContext) || !('wallTimeIso' in operationContext)) {
        this.#fail(new TypeError('hosted_actual_owner_operation_clock_missing'))
      }
      const requestClock = operationContext as HostedActualOwnerClock
      const completions = attestHostedActualOwnerWalOperationEnvelope(envelope)
      const resultClock = clock()
      for (const completion of completions) {
        const publication = completion.result.publication
        const staged = this.#staged.get(publication.emission.emissionNonce)
        if (!staged) this.#fail(new Error('hosted_actual_owner_custody_missing'))
        const owner = this.#owner(publication)
        // Sync seals the emitted FD9 prefix, not FD9 itself; the descriptor is
        // process-owned and remains open until session teardown.
        if (!this.producer.syncSegment) this.#fail(new Error('hosted_actual_owner_segment_sync_unavailable'))
        this.producer.syncSegment()
        const syncClock = clock()
        const sealClock = clock()
        this.#writer.write({ operationCompletion: completion, owner, requestClock, resultClock,
          lifecycle: { sync: { status: 'durable', clock: syncClock }, seal: { status: 'sealed', clock: sealClock },
            revocation: { status: 'not-revoked', clock: clock(), reason: null } } })
        this.#staged.delete(publication.emission.emissionNonce)
        for (const item of staged!.paths) { try { unlinkSync(item.path) } catch { /* corpus now owns both images */ } }
      }
    } catch (error) { this.#fail(error) } finally { release() }
  }

  close(): Promise<void> { return this.#closePromise ??= this.#close() }

  async #close(): Promise<void> {
    await this.#operationTail
    await this.#tail
    this.#closed = true
    const errors: unknown[] = []
    try { this.#writer.seal() } catch (error) { errors.push(error) }
    this.#collectProducerCleanupFailures = true
    try { this.producer.close() } catch (error) { errors.push(error) }
    finally { this.#collectProducerCleanupFailures = false }
    errors.push(...this.#producerCleanupFailures)
    try { this.#files.sync(this.#corpusFd) } catch (error) { errors.push(error) }
    try { this.#files.close(this.#corpusFd) } catch (error) { errors.push(error) }
    if (errors.length) {
      const failure = new AggregateError(errors, 'hosted_actual_owner_capture_close_failed')
      this.#poison ??= failure
      try { this.producer.poison(failure.message) } catch { /* retained failure is authoritative */ }
      throw failure
    }
  }

  isHealthy(): boolean { return !this.#closed && !this.#poison && this.producer.isHealthy() }

  #owner(publication: BoundWalPublication): HostedActualOwnerReplacementLineage {
    const producer = publication.emission.producer
    const ownerStartToken = hostedActualOwnerStartToken({ pid: producer.pid, startTicks: producer.startTicks,
      exeDev: producer.exeDev, exeIno: producer.exeIno, exeSha256: producer.exeSha256 })
    if (!this.#lineage) {
      this.#lineage = Object.freeze({ ownerStartToken, ownerGeneration: this.#ownerGeneration,
        predecessorOwnerStartToken: this.#prior?.ownerStartToken ?? null,
        predecessorOwnerGeneration: this.#prior?.ownerGeneration ?? null,
        replacementReason: this.#prior ? 'process-replacement' : 'initial' })
      persistLineage(this.#lineagePath, ownerStartToken, this.#ownerGeneration)
    }
    if (this.#lineage.ownerStartToken !== ownerStartToken) this.#fail(new Error('hosted_actual_owner_producer_identity_changed'))
    return this.#lineage
  }

  #assertHealthy(): void {
    if (this.#poison) throw this.#poison
    if (this.#closed || !this.producer.isHealthy()) throw new Error('hosted_actual_owner_capture_unavailable')
  }

  #fail(error: unknown): never {
    const failure = error instanceof Error ? error : new Error('hosted_actual_owner_capture_failed')
    this.#poison ??= failure
    try { this.producer?.poison(failure.message) } catch { /* retained failure is authoritative */ }
    throw this.#poison
  }
}

function clock(): HostedActualOwnerClock {
  return Object.freeze({ wallTimeIso: new Date().toISOString(), monotonicNs: process.hrtime.bigint().toString() })
}

function validatePaths(root: string, walPath: string, modulePath: string): void {
  if (![root, walPath, modulePath].every(path => isAbsolute(path) && !path.includes('\0'))) {
    throw new TypeError('hosted_actual_owner_capture_path_invalid')
  }
  const rel = relative(resolve(root), resolve(walPath))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new TypeError('hosted_actual_owner_wal_outside_team_root')
}

function stageImage(root: string, name: string, image: RetainedWalImage, files: HostedActualOwnerCaptureFileOperations): string {
  const path = join(root, name)
  const fd = files.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeAll(fd, image.bytes, files); files.sync(fd) } finally { files.close(fd) }
  const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return path
}

function writeAll(fd: number, bytes: Uint8Array, files: HostedActualOwnerCaptureFileOperations): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = files.write(fd, bytes, offset)
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw new Error('hosted_actual_owner_short_write')
    }
    offset += written
  }
}

function readPriorLineage(path: string, corpusPath: string): { ownerStartToken: string; ownerGeneration: string } | null {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
    throw new TypeError('hosted_actual_owner_predecessor_lineage_unsafe')
  }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (Object.keys(value).join(',') !== 'ownerStartToken,ownerGeneration' ||
    typeof value.ownerStartToken !== 'string' || !/^owner-start_[0-9a-f]{64}$/u.test(value.ownerStartToken) ||
    typeof value.ownerGeneration !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.ownerGeneration)) {
    throw new TypeError('hosted_actual_owner_predecessor_lineage_invalid')
  }
  const prior = value as { ownerStartToken: string; ownerGeneration: string }
  if (!existsSync(corpusPath)) throw new TypeError('hosted_actual_owner_predecessor_corpus_missing')
  const corpusStat = lstatSync(corpusPath)
  if (!corpusStat.isFile() || corpusStat.isSymbolicLink() || corpusStat.nlink !== 1 ||
    (corpusStat.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && corpusStat.uid !== process.getuid())) {
    throw new TypeError('hosted_actual_owner_predecessor_corpus_unsafe')
  }
  let last: ReturnType<typeof parseHostedActualOwnerNativePublication>
  try { last = parseHostedActualOwnerNativePublication(Buffer.from(`${readLastCorpusLine(corpusPath, corpusStat.size)}\n`)) }
  catch { throw new TypeError('hosted_actual_owner_predecessor_corpus_invalid') }
  const owner = last.owner
  if (owner?.ownerStartToken !== prior.ownerStartToken || owner.ownerGeneration !== prior.ownerGeneration) {
    throw new TypeError('hosted_actual_owner_predecessor_lineage_mismatch')
  }
  return prior
}

function verifyStagedImage(path: string, image: RetainedWalImage): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error('hosted_actual_owner_custody_identity_failed')
  }
  const bytes = readFileSync(path)
  if (bytes.byteLength !== image.byteSize ||
    createHash('sha256').update(bytes).digest('hex') !== image.sha256 ||
    !bytes.equals(Buffer.from(image.bytes))) throw new Error('hosted_actual_owner_custody_verification_failed')
}

function assertCorpusLinked(path: string, fd: number): void {
  const opened = fstatSync(fd)
  const linked = lstatSync(path)
  if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink() || opened.nlink !== 1 || linked.nlink !== 1 ||
    opened.dev !== linked.dev || opened.ino !== linked.ino || (opened.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && (opened.uid !== process.getuid() || linked.uid !== process.getuid()))) {
    throw new Error('hosted_actual_owner_corpus_identity_changed')
  }
}

function persistLineage(path: string, ownerStartToken: string, ownerGeneration: string): void {
  const temp = join(dirname(path), `.${HOSTED_ACTUAL_OWNER_LINEAGE_FILE}.${process.pid}.${randomUUID()}.tmp`)
  const bytes = Buffer.from(`${JSON.stringify({ ownerStartToken, ownerGeneration })}\n`)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written < 1) throw new Error('hosted_actual_owner_lineage_short_write')
      offset += written
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temp, path)
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
}

function readLastCorpusLine(path: string, size: number): string {
  if (!Number.isSafeInteger(size) || size < 3) throw new Error('hosted_actual_owner_predecessor_corpus_empty')
  const length = Math.min(size, HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES + 2)
  const buffer = Buffer.alloc(length)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (readSync(fd, buffer, 0, length, size - length) !== length) throw new Error('hosted_actual_owner_predecessor_corpus_short_read')
  } finally { closeSync(fd) }
  if (buffer.at(-1) !== 0x0a) throw new Error('hosted_actual_owner_predecessor_corpus_unsealed')
  const previous = buffer.lastIndexOf(0x0a, buffer.length - 2)
  if (size > length && previous < 0) throw new Error('hosted_actual_owner_predecessor_record_too_large')
  const line = buffer.subarray(previous + 1, buffer.length - 1)
  if (line.byteLength < 2 || line.byteLength > HOSTED_ACTUAL_OWNER_MAX_RECORD_BYTES) {
    throw new Error('hosted_actual_owner_predecessor_record_bounds')
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(line)
}
