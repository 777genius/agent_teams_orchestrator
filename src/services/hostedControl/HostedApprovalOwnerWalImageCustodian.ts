import { closeSync, constants, fstatSync, fsyncSync, lstatSync, readdirSync, readSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

import { PinnedPosixDirectory } from './PinnedPosixDirectory.internal.js'
import {
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, retainedWalImage,
  type BoundOwnerEmission, type OwnerWalImageCustodian, type PreviousWalImage, type RetainedWalImage,
} from './HostedApprovalOwnerProvenance.js'

const MAX_IMAGE = 32 * 1024 * 1024
const MAX_METADATA = 16 * 1024
const MAX_STAGES = 4096
const MAX_TOTAL = 256 * 1024 * 1024
const HASH = /^[0-9a-f]{64}$/u
const DECIMAL = /^(?:0|[1-9]\d*)$/u

type ImageMetadata = Pick<RetainedWalImage, 'byteSize' | 'sha256'>
type PreviousMetadata = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'retained'; image: ImageMetadata }>
/** Storage projection of the existing P1 image and BoundOwnerEmission contracts.
 * File names are derived from stage, never supplied by metadata. No qualification. */
type Binding = Readonly<{ previous: PreviousMetadata; next: ImageMetadata; emission: BoundOwnerEmission }>
export type OwnerWalImageReceipt = Readonly<{ stage: number; bindingSha256: string; emission: BoundOwnerEmission }>
export type OwnerWalImageIo = Readonly<{
  write: (fd: number, bytes: Uint8Array, offset: number, length: number, position: number) => number
  sync: typeof fsyncSync
  rename: (directory: PinnedPosixDirectory, from: string, to: string) => void
}>
const reservation = Symbol('owner-wal-image-directory')
const diskIo: OwnerWalImageIo = { write: writeSync, sync: fsyncSync, rename: (directory, from, to) => directory.rename(from, to) }

/** One admitted Linux Owner generation, one exclusively reserved directory.
 * Construction is async only because the existing pinned-directory factory is.
 * prepare/bind and all their durability edges are synchronous. */
export async function createDiskOwnerWalImageCustodian(directory: string,
  options: Readonly<{ maxBytes?: number; maxStages?: number; io?: OwnerWalImageIo }> = {},
): Promise<DiskOwnerWalImageCustodian> {
  const maxBytes = options.maxBytes ?? MAX_TOTAL
  const maxStages = options.maxStages ?? MAX_STAGES
  requireImage(Number.isSafeInteger(maxBytes) && maxBytes >= 2 && maxBytes <= MAX_TOTAL, 'byte-budget')
  requireImage(Number.isSafeInteger(maxStages) && maxStages >= 1 && maxStages <= MAX_STAGES, 'stage-budget')
  const parent = await openDirectory(directory)
  try {
    requireImage(readdirSync(`/proc/self/fd/${parent.fd}`).length === 0, 'directory-not-empty')
    // Permanent O_EXCL reservation: no restart can resume a crashed writer or
    // reinterpret its staged images. Never remove another generation's files.
    const fd = parent.createExclusive('owner-wal-images.reservation')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    fsyncSync(parent.fd)
    parent.assertLinked()
    // Persist the owned directory's link as well as its children. Its containing
    // admission root must already exist durably; this is not recursive mkdir.
    const container = await openDirectory(dirname(directory))
    try {
      const linked = container.openChild(basename(directory), constants.O_RDONLY | constants.O_DIRECTORY)
      try {
        const stat = fstatSync(linked)
        requireImage(stat.dev === parent.identity.dev && stat.ino === parent.identity.ino, 'directory-replaced')
        fsyncSync(container.fd)
        container.assertLinked()
        parent.assertLinked()
      } finally { closeSync(linked) }
    } finally { closeSync(container.fd) }
    return new DiskOwnerWalImageCustodian(reservation, parent, maxBytes, maxStages, options.io ?? diskIo)
  } catch (error) { closeSync(parent.fd); throw error }
}

export class DiskOwnerWalImageCustodian implements OwnerWalImageCustodian {
  #fatal: Error | null = null
  #closed = false
  #stages = 0
  #bytes = 0
  #lastEmission: BoundOwnerEmission | null = null
  readonly #nonces = new Set<string>()
  readonly #receipts: OwnerWalImageReceipt[] = []
  /** Use the factory; the directory must already be reserved by this generation. */
  constructor(token: typeof reservation, private readonly directory: PinnedPosixDirectory, private readonly maxBytes: number,
    private readonly maxStages: number, private readonly io: OwnerWalImageIo) { requireImage(token === reservation, 'factory-required') }

  isHealthy(): boolean {
    try { this.#guard(() => undefined); return true } catch { return false }
  }
  /** Only bindings whose file AND directory sync returned successfully appear here.
   * Retain these with the actual successful publication results, not by disk scan. */
  receipts(): readonly OwnerWalImageReceipt[] {
    return this.#guard(() => Object.freeze(this.#receipts.map(receipt => freeze(structuredClone(receipt)))))
  }

  prepare(previous: PreviousWalImage, next: RetainedWalImage) {
    return this.#guard(() => {
      const p = copyPrevious(previous)
      const n = copyImage(next)
      const size = n.byteSize + (p.kind === 'retained' ? p.image.byteSize : 0) + 2 * MAX_METADATA
      requireImage(this.#stages < this.maxStages && this.#bytes + size <= this.maxBytes, 'retention-budget')
      const stage = ++this.#stages
      this.#bytes += size
      const prefix = `stage-${stage}`
      const metadata = { previous: previousMetadata(p), next: imageMetadata(n) }
      // The explicit absence discriminator comes only from the fenced WAL's
      // snapshot. A missing P file never becomes an absence witness.
      this.#write(`${prefix}.stage`, json(metadata))
      if (p.kind === 'retained') this.#write(`${prefix}.previous`, p.image.bytes)
      this.#write(`${prefix}.next`, n.bytes)
      this.io.sync(this.directory.fd)
      this.#checkImages(prefix, p, n)
      let used = false
      return Object.freeze({ bind: (input: BoundOwnerEmission) => this.#guard(() => {
        requireImage(!used, 'stage-replay'); used = true
        const emission = copyEmission(input)
        if (this.#lastEmission) {
          requireImage(isDeepStrictEqual(emission.producer, this.#lastEmission.producer) &&
            isDeepStrictEqual(emission.activation, this.#lastEmission.activation) &&
            isDeepStrictEqual(emission.descriptor, this.#lastEmission.descriptor) &&
            emission.sequence > this.#lastEmission.sequence, 'emission-substitution-or-replay')
        }
        requireImage(!this.#nonces.has(emission.emissionNonce), 'emission-nonce-replay')
        // An operation can legitimately produce multiple WAL mutations. Only
        // emission nonces and sequences are single use, not operation nonces.
        this.#nonces.add(emission.emissionNonce)
        this.#checkImages(prefix, p, n)
        requireImage(readFile(this.directory, `${prefix}.stage`, MAX_METADATA).equals(json(metadata)), 'stage-substitution')
        const binding: Binding = { ...metadata, emission }
        const bytes = json(binding)
        requireImage(bytes.length <= MAX_METADATA, 'binding-size')
        this.#write(`${prefix}.binding.tmp`, bytes)
        this.directory.assertLinked()
        requireImage(!this.directory.exists(`${prefix}.binding`), 'binding-collision')
        this.io.rename(this.directory, `${prefix}.binding.tmp`, `${prefix}.binding`)
        this.io.sync(this.directory.fd)
        this.directory.assertLinked()
        requireImage(readFile(this.directory, `${prefix}.binding`, MAX_METADATA).equals(bytes), 'binding-substitution')
        this.#checkImages(prefix, p, n)
        const receipt = freeze({ stage, bindingSha256: hash(bytes), emission })
        // No write-ahead success: this line is after every fallible disk edge.
        this.#receipts.push(receipt)
        this.#lastEmission = emission
        return Object.freeze({ previous: p, next: n, receipt })
      }) })
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    closeSync(this.directory.fd)
  }
  #check(): void {
    if (this.#fatal !== null) throw this.#fatal
    requireImage(!this.#closed, 'closed')
    this.directory.assertLinked()
  }
  #guard<T>(operation: () => T): T {
    try { this.#check(); return operation() } catch (error) {
      this.#fatal ??= error instanceof Error ? error : new Error('owner-wal-images-io-failure', { cause: error })
      throw this.#fatal
    }
  }
  #write(name: string, bytes: Uint8Array): void {
    this.directory.assertLinked()
    const fd = this.directory.createExclusive(name)
    try {
      let offset = 0
      while (offset < bytes.byteLength) {
        const written = this.io.write(fd, bytes, offset, bytes.byteLength - offset, offset)
        requireImage(Number.isSafeInteger(written) && written > 0 && written <= bytes.byteLength - offset, 'short-write')
        offset += written
      }
      this.io.sync(fd)
      requireImage(readFile(this.directory, name, Math.max(MAX_METADATA, bytes.byteLength)).equals(Buffer.from(bytes)), 'write-substitution')
    } finally { closeSync(fd) }
  }
  #checkImages(prefix: string, p: PreviousWalImage, n: RetainedWalImage): void {
    this.directory.assertLinked()
    requireImage(readFile(this.directory, `${prefix}.next`, MAX_IMAGE).equals(Buffer.from(n.bytes)), 'next-substitution')
    if (p.kind === 'retained') requireImage(readFile(this.directory, `${prefix}.previous`, MAX_IMAGE).equals(Buffer.from(p.image.bytes)), 'previous-substitution')
    else requireImage(!this.directory.exists(`${prefix}.previous`), 'absence-substitution')
  }
}

/** Read-only reload of a specifically retained successful receipt. This returns
 * P1 input bytes, NOT VerifiedOwnerPublication. The caller must independently
 * seal custody and join the complete native capture and operation witness.
 * Neither .stage nor a discovered .binding file can supply a receipt. */
export async function readDiskOwnerWalImages(directory: string, input: OwnerWalImageReceipt): Promise<Readonly<{
  previous: PreviousWalImage; next: RetainedWalImage; emission: BoundOwnerEmission
}>> {
  const receipt = structuredClone(input)
  requireImage(Number.isSafeInteger(receipt.stage) && receipt.stage >= 1 && receipt.stage <= MAX_STAGES && HASH.test(receipt.bindingSha256), 'receipt')
  const emission = copyEmission(receipt.emission)
  const parent = await openDirectory(directory)
  try {
    const prefix = `stage-${receipt.stage}`
    const bytes = readFile(parent, `${prefix}.binding`, MAX_METADATA)
    requireImage(hash(bytes) === receipt.bindingSha256, 'binding-digest')
    const binding = JSON.parse(bytes.toString('utf8')) as Binding
    requireImage(isDeepStrictEqual(binding.emission, emission), 'binding-emission')
    const n = copyImage({ ...binding.next, bytes: readFile(parent, `${prefix}.next`, MAX_IMAGE) })
    const p: PreviousWalImage = binding.previous.kind === 'retained'
      ? { kind: 'retained', image: copyImage({ ...binding.previous.image, bytes: readFile(parent, `${prefix}.previous`, MAX_IMAGE) }) }
      : { kind: 'absent' }
    requireImage(binding.previous.kind === 'retained' || binding.previous.kind === 'absent', 'predecessor-kind')
    if (p.kind === 'absent') requireImage(!parent.exists(`${prefix}.previous`), 'absence-substitution')
    const metadata = { previous: previousMetadata(p), next: imageMetadata(n) }
    // Exact serialization also rejects duplicate/unknown keys and altered shape.
    requireImage(bytes.equals(json({ ...metadata, emission: binding.emission })), 'binding-shape')
    requireImage(readFile(parent, `${prefix}.stage`, MAX_METADATA).equals(json(metadata)), 'stage-substitution')
    parent.assertLinked()
    return Object.freeze({ previous: freeze(p), next: n, emission })
  } finally { closeSync(parent.fd) }
}

async function openDirectory(path: string): Promise<PinnedPosixDirectory> {
  // This MVP uses the same Linux *at primitives as the WAL. Do not quietly use
  // mknodat on Darwin, where regular-node creation needs the WAL spawn adapter.
  requireImage(process.platform === 'linux', 'linux-required')
  requireImage(isAbsolute(path) && resolve(path) === path && !path.includes('\0'), 'directory-path')
  let current = ''
  for (const part of path.split(sep).filter(Boolean)) {
    current += `/${part}`
    const stat = lstatSync(current)
    requireImage(stat.isDirectory() && !stat.isSymbolicLink(), 'directory-symlink')
  }
  return PinnedPosixDirectory.open(path)
}
function readFile(parent: PinnedPosixDirectory, name: string, maximum: number): Buffer {
  parent.assertLinked()
  const fd = parent.openChild(name, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    requireImage(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
      stat.uid === process.getuid?.() && stat.size <= maximum, 'unsafe-file')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      requireImage(count > 0, 'short-read'); offset += count
    }
    const linkedFd = parent.openChild(name, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const linked = fstatSync(linkedFd)
      requireImage(linked.dev === stat.dev && linked.ino === stat.ino && linked.size === stat.size, 'file-replaced')
    } finally { closeSync(linkedFd) }
    parent.assertLinked()
    return bytes
  } finally { closeSync(fd) }
}
function copyImage(input: RetainedWalImage): RetainedWalImage {
  const bytes = input.bytes
  requireImage(bytes instanceof Uint8Array && !(bytes.buffer instanceof SharedArrayBuffer), 'image-buffer')
  const owned = retainedWalImage(bytes)
  requireImage(owned.byteSize === input.byteSize && owned.sha256 === input.sha256, 'image-metadata')
  return owned
}
function copyPrevious(input: PreviousWalImage): PreviousWalImage {
  requireImage(input.kind === 'absent' || input.kind === 'retained', 'predecessor-kind')
  return input.kind === 'absent' ? Object.freeze({ kind: 'absent' }) : Object.freeze({ kind: 'retained', image: copyImage(input.image) })
}
function copyEmission(input: BoundOwnerEmission): BoundOwnerEmission {
  const e = structuredClone(input)
  exactKeys(e, ['stream', 'producer', 'activation', 'descriptor', 'operationNonce', 'emissionNonce', 'sequence', 'lineSha256'])
  const p = e.producer; const a = e.activation; const d = e.descriptor
  exactKeys(p, ['role', 'implementationId', 'artifactManifestSha256', 'moduleSha256', 'exeSha256', 'pid', 'startTicks', 'exeDev', 'exeIno'])
  exactKeys(a, ['controllerNonce', 'runId', 'stackManifestSha256'])
  exactKeys(d, ['fd', 'device', 'inode'])
  requireImage(e.stream === 'ownerWalTimeline' && p.role === 'owner' && p.implementationId === HOSTED_OWNER_PROVENANCE_IMPLEMENTATION &&
    [p.artifactManifestSha256, p.moduleSha256, p.exeSha256, a.controllerNonce, a.stackManifestSha256,
      e.operationNonce, e.emissionNonce, e.lineSha256].every(value => typeof value === 'string' && HASH.test(value)) &&
    [p.startTicks, p.exeDev, p.exeIno, d.device, d.inode].every(value => typeof value === 'string' && DECIMAL.test(value)) &&
    d.fd === 9 && Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(e.sequence) && e.sequence > 0 &&
    typeof a.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(a.runId), 'emission')
  requireImage(json(e).length <= MAX_METADATA / 2, 'emission-size')
  return freeze(e)
}
function imageMetadata(image: RetainedWalImage): ImageMetadata { return { byteSize: image.byteSize, sha256: image.sha256 } }
function previousMetadata(previous: PreviousWalImage): PreviousMetadata {
  return previous.kind === 'absent' ? { kind: 'absent' } : { kind: 'retained', image: imageMetadata(previous.image) }
}
function json(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`) }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function requireImage(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(`owner-wal-images-${code}`) }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function exactKeys(value: object, keys: readonly string[]): void {
  requireImage(value && typeof value === 'object' && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)), 'metadata-keys')
}
