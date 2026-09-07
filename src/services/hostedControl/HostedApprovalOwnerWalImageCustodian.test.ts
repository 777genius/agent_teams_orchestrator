import { PosixNamespaceLookupError, posixNamespaceLookup } from './PosixNamespaceLookup.internal.js'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createDiskOwnerWalImageCustodian, readDiskOwnerWalImages,
  type OwnerWalImageIo,
} from './HostedApprovalOwnerWalImageCustodian.js'
import {
  createOwnerProvenanceNodeOperations, createOwnerWalPublicationProducerFromEnvironment,
  abandonOwnerWalPublication,
  HOSTED_OWNER_PROVENANCE_CONTRACT, HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, retainedWalImage,
  type BoundOwnerEmission, type OwnerWalImageCustodian, type OwnerWalMutationIntent, type OwnerWalPublicationProducer,
} from './HostedApprovalOwnerProvenance.js'
import { HostedApprovalOwnerPublicationError, HostedApprovalOwnerWal, type HostedApprovalOwnerState } from './HostedApprovalOwnerWal.js'
import { HostedApprovalOwnerStore } from './HostedApprovalOwnerStore.js'
import type { HostedApprovalRuntimeAdmission } from './HostedApprovalRuntimeAdmission.js'

const roots: string[] = []
const closes: Array<() => void> = []
afterEach(() => {
  for (const close of closes.splice(0).reverse()) { try { close() } catch { /* expected poison */ } }
  // Only paths created by this test file's mkdtemp are eligible for cleanup.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const image = (source: string) => retainedWalImage(Buffer.from(source))
const io: OwnerWalImageIo = { write: writeSync, sync: fsyncSync, rename: (parent, from, to) => parent.rename(from, to) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owner-wal-image-r975-')); roots.push(root)
  const directory = join(root, 'images'); mkdirSync(directory, { mode: 0o700 })
  return { root, directory, walPath: join(root, 'owner.json') }
}
async function openCustodian(directory: string, overrides: Partial<OwnerWalImageIo> = {}) {
  const custodian = await createDiskOwnerWalImageCustodian(directory, { io: { ...io, ...overrides } })
  closes.push(() => custodian.close())
  return custodian
}
function emission(sequence = 1): BoundOwnerEmission {
  return {
    stream: 'ownerWalTimeline',
    producer: { role: 'owner', implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION,
      artifactManifestSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), exeSha256: '3'.repeat(64),
      pid: process.pid, startTicks: '4', exeDev: '5', exeIno: '6' },
    activation: { controllerNonce: '7'.repeat(64), runId: 'run_test', stackManifestSha256: '8'.repeat(64) },
    descriptor: { fd: 9, device: '9', inode: '10' }, operationNonce: 'a'.repeat(64),
    emissionNonce: sequence.toString(16).padStart(64, '0'), sequence, lineSha256: 'b'.repeat(64),
  }
}

// Linux is the admitted actual Owner platform. No test claims a Darwin fallback.
describe.skipIf(process.platform !== 'linux')('synchronous Owner W2 disk custody', () => {
  test('publication returns the actual successful disk receipt independently of later custodian closure', async () => {
    const { root, directory, walPath } = fixture()
    const custodian = await openCustodian(directory)
    const producer = nativeProducer(root, custodian, [])
    const publications: ReturnType<ReturnType<typeof producer.prepare>['emit']>[] = []
    const capturing = {
      isHealthy: () => producer.isHealthy(),
      withPublication: <T>(operation: () => Promise<T>) => producer.withPublication(operation),
      poison: (reason: string): never => producer.poison(reason),
      close: () => producer.close(),
      prepare: (input: Parameters<typeof producer.prepare>[0]) => {
        const prepared = producer.prepare(input)
        return { ...prepared, emit() { const publication = prepared.emit(); publications.push(publication); return publication } }
      },
    }
    await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath, undefined, capturing))
      .reconcileAdmission(admission('a'))
    expect(publications).toHaveLength(1)
    const publication = publications[0]!
    expect(publication.receipt).toEqual(custodian.receipts()[0])
    expect(publication.receipt?.emission).toEqual(publication.emission)
    custodian.close()
    expect(() => custodian.receipts()).toThrow()
    expect(publication.receipt?.bindingSha256).toBe(hash(readFileSync(join(directory, 'stage-1.binding'))))
  })

  for (const errno of [5, 13]) {
    test(`late pre-rename fstatat errno ${errno} permanently poisons shared capture`, async () => {
      const { root, directory, walPath } = fixture()
      await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath)).reconcileAdmission(admission('a'))
      const predecessor = readFileSync(walPath)
      const identity = statSync(walPath)
      const c = await openCustodian(directory)
      const producer = nativeProducer(root, c, [])
      const nativeBefore = readFileSync(join(root, 'native.ndjson'))
      let armed = false; let fsyncHits = 0; let lookupHits = 0; let renameHits = 0
      const original = posixNamespaceLookup.fstatat
      const lookup = spyOn(posixNamespaceLookup, 'fstatat').mockImplementation((fd, child) => {
        if (armed && child === 'owner.json') {
          lookupHits++
          expect(fsyncHits).toBe(1)
          return { result: -1, errno }
        }
        return original(fd, child)
      })
      try {
        const wal = new HostedApprovalOwnerWal(walPath, {
          afterWalTempFsync: async () => { fsyncHits++; armed = true },
          afterWalRename: async () => { renameHits++ },
        }, producer)
        const store = new HostedApprovalOwnerStore(wal)
        let failure: unknown
        try { await store.reconcileAdmission(admission('b')) } catch (error) { failure = error }
        expect(failure).toBeInstanceOf(HostedApprovalOwnerPublicationError)
        expect(failure).toMatchObject({ stage: 'definitely-not-replaced',
          message: 'Hosted approval WAL publication failed', cause: { errno } })
        expect((failure as Error).cause).toBeInstanceOf(PosixNamespaceLookupError)
        expect(fsyncHits).toBe(1)
        expect(lookupHits).toBe(1)
        expect(renameHits).toBe(0)
        expect(readFileSync(walPath)).toEqual(predecessor)
        expect(statSync(walPath).ino).toBe(identity.ino)
        expect(statSync(walPath).dev).toBe(identity.dev)
        expect(readFileSync(join(directory, 'stage-1.previous'))).toEqual(predecessor)
        expect(existsSync(join(directory, 'stage-1.binding'))).toBe(false)
        expect(c.receipts()).toEqual([])
        expect(readFileSync(join(root, 'native.ndjson'))).toEqual(nativeBefore)
        expect(producer.isHealthy()).toBe(false)
        expect(wal.isPublicationCaptureCurrent()).toBe(false)
        armed = false
        lookup.mockRestore()
        const replacement = new HostedApprovalOwnerWal(walPath, undefined, producer)
        for (const retry of [store, new HostedApprovalOwnerStore(replacement)]) {
          await expect(retry.reconcileAdmission(admission('b'))).rejects.toMatchObject({
            stage: 'definitely-not-replaced', message: 'Hosted approval WAL capture poisoned',
          })
        }
        expect(producer.isHealthy()).toBe(false)
        expect(wal.isPublicationCaptureCurrent()).toBe(false)
        expect(replacement.isPublicationCaptureCurrent()).toBe(false)
        expect(fsyncHits).toBe(1)
        expect(readFileSync(walPath)).toEqual(predecessor)
        expect(statSync(walPath).ino).toBe(identity.ino)
        expect(readFileSync(join(root, 'native.ndjson'))).toEqual(nativeBefore)
        expect(c.receipts()).toEqual([])
      } finally { lookup.mockRestore() }
    })
  }

  test('ordinary definite pre-rename failure remains retryable with valid capture', async () => {
    const { root, directory, walPath } = fixture()
    await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath)).reconcileAdmission(admission('a'))
    const predecessor = readFileSync(walPath)
    const c = await openCustodian(directory)
    const producer = nativeProducer(root, c, [])
    let fail = true
    const cause = new Error('definite pre-rename precondition failure')
    const wal = new HostedApprovalOwnerWal(walPath, {
      afterWalTempFsync: async () => { if (fail) throw cause },
    }, producer)
    const store = new HostedApprovalOwnerStore(wal)
    await expect(store.reconcileAdmission(admission('b'))).rejects.toMatchObject({
      stage: 'definitely-not-replaced', cause,
    })
    expect(readFileSync(walPath)).toEqual(predecessor)
    expect(c.receipts()).toEqual([])
    expect(producer.isHealthy()).toBe(true)
    expect(wal.isPublicationCaptureCurrent()).toBe(true)
    fail = false
    const published = await store.reconcileAdmission(admission('b'))
    expect(published.admissionDigest).toBe(admission('b').digest)
    expect(c.receipts()).toHaveLength(1)
    const retained = await readDiskOwnerWalImages(directory, c.receipts()[0]!)
    expect(retained.previous).toEqual({ kind: 'retained', image: retainedWalImage(predecessor) })
    expect(retained.next.bytes).toEqual(new Uint8Array(readFileSync(walPath)))
    expect(producer.isHealthy()).toBe(true)
    expect(wal.isPublicationCaptureCurrent()).toBe(true)
  })

  for (const errno of [5, 13]) { // EIO / EACCES, not fabricated absent images
    for (const edge of ['snapshot', 'prepare', 'bind', 'reload'] as const) {
      test(`real namespace ${errno} at ${edge} rejects without absence evidence`, async () => {
        const { root, directory, walPath } = fixture()
        let armed = false
        let hits = 0
        const original = posixNamespaceLookup.fstatat
        const lookup = spyOn(posixNamespaceLookup, 'fstatat').mockImplementation((fd, child) => {
          const target = edge === 'snapshot' ? 'owner.json' : 'stage-1.previous'
          if (armed && child === target) { hits++; return { result: -1, errno } }
          return original(fd, child)
        })
        try {
          const c = await openCustodian(directory)
          const wrapped: OwnerWalImageCustodian = { prepare(p, n) {
            if (edge === 'prepare') armed = true
            const stage = c.prepare(p, n)
            return { bind(e) { if (edge === 'bind') armed = true; return stage.bind(e) } }
          } }
          const producer = nativeProducer(root, wrapped, [])
          const wal = new HostedApprovalOwnerWal(walPath, undefined, producer)
          const store = new HostedApprovalOwnerStore(wal)
          armed = edge === 'snapshot'
          if (edge === 'reload') {
            await store.reconcileAdmission(admission('a'))
            const receipt = c.receipts()[0]!
            // Successful publication above exercised actual ENOENT at both boundaries.
            expect((await readDiskOwnerWalImages(directory, receipt)).previous).toEqual({ kind: 'absent' })
            armed = true
            await expect(readDiskOwnerWalImages(directory, receipt)).rejects.toThrow('namespace lookup failed')
          } else {
            await expect(store.reconcileAdmission(admission('a'))).rejects.toThrow()
            expect(producer.isHealthy()).toBe(false)
            expect(wal.isPublicationCaptureCurrent()).toBe(false)
            expect(existsSync(walPath)).toBe(edge === 'bind')
            expect(existsSync(join(directory, 'stage-1.binding'))).toBe(false)
            if (edge !== 'snapshot') expect(c.isHealthy()).toBe(false)
            armed = false
            await expect(store.reconcileAdmission(admission('b'))).rejects.toThrow()
          }
          expect(hits).toBeGreaterThan(0)
        } finally { lookup.mockRestore() }
      })
    }
  }

  test('reload revalidates ancestry changed after its own directory admission', async () => {
    const { root } = fixture()
    const ancestor = join(root, 'owned'); mkdirSync(ancestor, { mode: 0o700 })
    const directory = join(ancestor, 'images'); mkdirSync(directory, { mode: 0o700 })
    const c = await openCustodian(directory)
    const producer = nativeProducer(root, c, [])
    const store = new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(join(root, 'owner.json'), undefined, producer))
    await store.reconcileAdmission(admission('a'))
    const receipt = c.receipts()[0]!
    const original = posixNamespaceLookup.fstatat
    let attacked = false
    const lookup = spyOn(posixNamespaceLookup, 'fstatat').mockImplementation((fd, child) => {
      const result = original(fd, child)
      if (child === 'stage-1.previous' && !attacked) {
        attacked = true
        renameSync(ancestor, join(root, 'moved'))
        symlinkSync(join(root, 'moved'), ancestor)
      }
      return result
    })
    try {
      await expect(readDiskOwnerWalImages(directory, receipt)).rejects.toThrow('ancestry')
      expect(attacked).toBe(true)
      await expect(store.reconcileAdmission(admission('b'))).rejects.toThrow()
      expect(c.isHealthy()).toBe(false)
      expect(producer.isHealthy()).toBe(false)
      expect(readFileSync(join(directory, 'stage-1.binding')).length).toBeGreaterThan(0)
    } finally { lookup.mockRestore() }
  })

  for (const edge of ['prepare', 'bind', 'reload'] as const) {
    test(`ancestor renamed and aliased to the same leaf is rejected at ${edge}`, async () => {
      const { root } = fixture()
      const ancestor = join(root, 'owned'); mkdirSync(ancestor, { mode: 0o700 })
      const directory = join(ancestor, 'images'); mkdirSync(directory, { mode: 0o700 })
      const c = await openCustodian(directory)
      const walPath = join(root, 'owner.json')
      const moved = join(root, 'moved')
      const attack = () => {
        renameSync(ancestor, moved); symlinkSync(moved, ancestor)
        writeFileSync(join(moved, 'unrelated'), 'keep')
      }
      const wrapped: OwnerWalImageCustodian = { prepare(p, n) {
        if (edge === 'prepare') attack()
        const stage = c.prepare(p, n)
        return { bind(e) { if (edge === 'bind') attack(); return stage.bind(e) } }
      } }
      const producer = nativeProducer(root, wrapped, [])
      const wal = new HostedApprovalOwnerWal(walPath, undefined, producer)
      const store = new HostedApprovalOwnerStore(wal)
      if (edge === 'reload') {
        await store.reconcileAdmission(admission('a'))
        const receipt = c.receipts()[0]!
        attack()
        await expect(readDiskOwnerWalImages(directory, receipt)).rejects.toThrow('directory-symlink')
        // The already admitted writer must also reject the changed ancestry.
        await expect(store.reconcileAdmission(admission('b'))).rejects.toThrow()
      } else {
        await expect(store.reconcileAdmission(admission('a'))).rejects.toThrow()
        expect(existsSync(join(directory, 'stage-1.binding'))).toBe(false)
        expect(existsSync(walPath)).toBe(edge === 'bind')
      }
      expect(c.isHealthy()).toBe(false)
      expect(producer.isHealthy()).toBe(false)
      expect(readFileSync(join(moved, 'unrelated'), 'utf8')).toBe('keep')
      // Restoring the original links cannot revive a poisoned generation.
      rmSync(ancestor); renameSync(moved, ancestor)
      await expect(store.reconcileAdmission(admission('c'))).rejects.toThrow()
    })
  }

  test('owns exact noncanonical predecessor bytes and LF-inclusive N before binding; reload requires successful receipt', async () => {
    const { directory } = fixture(); const custodian = await openCustodian(directory)
    const raw = Buffer.from('\ufeff{ "schemaVersion": 1, "literal":"é" }\r\n')
    const previous = { byteSize: raw.length, sha256: hash(raw), bytes: raw }
    const next = image('{"schemaVersion":3}\n')
    const prepared = custodian.prepare({ kind: 'retained', image: previous }, next)
    raw.fill(0)
    expect(readFileSync(join(directory, 'stage-1.previous'))).toEqual(Buffer.from('\ufeff{ "schemaVersion": 1, "literal":"é" }\r\n'))
    expect(readFileSync(join(directory, 'stage-1.next'))).toEqual(Buffer.from(next.bytes))
    expect(custodian.receipts()).toEqual([])
    expect(existsSync(join(directory, 'stage-1.binding'))).toBe(false)
    await expect(readDiskOwnerWalImages(directory, { stage: 1, bindingSha256: '0'.repeat(64), emission: emission() })).rejects.toThrow()
    const bound = prepared.bind(emission())
    const owned = bound.next.bytes; owned.fill(0)
    custodian.close()
    const loaded = await readDiskOwnerWalImages(directory, bound.receipt)
    expect(loaded.next.bytes).toEqual(next.bytes)
    expect(loaded.previous).toEqual(bound.previous)
    expect(loaded.emission).toEqual(emission())
    await expect(createDiskOwnerWalImageCustodian(directory)).rejects.toThrow('directory-not-empty')
  })

  test('retains explicit absence, never infers it from a missing predecessor image', async () => {
    const first = fixture(); const c = await openCustodian(first.directory)
    const bound = c.prepare({ kind: 'absent' }, image('{}\n')).bind(emission())
    expect(JSON.parse(readFileSync(join(first.directory, 'stage-1.stage'), 'utf8')).previous).toEqual({ kind: 'absent' })
    expect((await readDiskOwnerWalImages(first.directory, bound.receipt)).previous).toEqual({ kind: 'absent' })
    writeFileSync(join(first.directory, 'stage-1.previous'), '{}\n', { mode: 0o600 })
    await expect(readDiskOwnerWalImages(first.directory, bound.receipt)).rejects.toThrow('absence-substitution')
    const second = fixture(); const d = await openCustodian(second.directory)
    const retained = d.prepare({ kind: 'retained', image: image(' { }\n') }, image('{}\n')).bind(emission())
    rmSync(join(second.directory, 'stage-1.previous'))
    await expect(readDiskOwnerWalImages(second.directory, retained.receipt)).rejects.toThrow()
  })

  for (const edge of ['write', 'file-sync', 'directory-sync', 'rename-before', 'rename-after', 'bind-directory-sync', 'bind-write', 'bind-file-sync'] as const) {
    test(`injected ${edge} failure poisons without a successful receipt`, async () => {
      const { directory } = fixture()
      let binding = false
      const c = await openCustodian(directory, {
        write(fd, bytes, offset, length, position) {
          if (edge === 'write' || edge === 'bind-write' && binding) throw new Error('injected-write')
          return writeSync(fd, bytes as Uint8Array, offset as number, length as number, position as number)
        },
        sync(fd) {
          const directoryFd = readFileKind(fd)
          if ((edge === 'file-sync' && !directoryFd) ||
              (edge === 'bind-file-sync' && !directoryFd && binding) ||
              (edge === 'directory-sync' && directoryFd && !binding) ||
              (edge === 'bind-directory-sync' && directoryFd && binding)) throw new Error('injected-sync')
          fsyncSync(fd)
        },
        rename(parent, from, to) {
          if (edge === 'rename-before') throw new Error('injected-rename')
          parent.rename(from, to)
          if (edge === 'rename-after') throw new Error('injected-rename-uncertain')
        },
      })
      expect(() => {
        const prepared = c.prepare({ kind: 'absent' }, image('{}\n'))
        binding = true
        prepared.bind(emission())
      }).toThrow('injected')
      expect(c.isHealthy()).toBe(false)
      expect(() => c.receipts()).toThrow()
      expect(() => c.prepare({ kind: 'absent' }, image('{}\n'))).toThrow()
      c.close()
      await expect(createDiskOwnerWalImageCustodian(directory)).rejects.toThrow()
      // Even a visible rename after an uncertain sync is not a receipt. Reload
      // cannot discover one or promote .stage; Root must retain real success.
    })
  }

  test('handles real partial writes and rejects zero progress', async () => {
    const { directory } = fixture()
    const c = await openCustodian(directory, { write(fd, bytes, offset, length, position) {
      return writeSync(fd, bytes as Uint8Array, offset as number, Math.min(2, length as number), position as number)
    } })
    const bound = c.prepare({ kind: 'absent' }, image('{"x":123}\n')).bind(emission())
    expect((await readDiskOwnerWalImages(directory, bound.receipt)).next.bytes).toEqual(image('{"x":123}\n').bytes)
    const broken = fixture(); const d = await openCustodian(broken.directory, { write: () => 0 })
    expect(() => d.prepare({ kind: 'absent' }, image('{}\n'))).toThrow('short-write')
  })

  test('rejects duplicate binding, sequence/nonce replay and substituted producer/activation/descriptor', async () => {
    for (const change of ['stage', 'sequence', 'nonce', 'producer', 'activation', 'descriptor'] as const) {
      const { directory } = fixture(); const c = await openCustodian(directory)
      const prepared = c.prepare({ kind: 'absent' }, image('{}\n')); prepared.bind(emission())
      if (change === 'stage') { expect(() => prepared.bind(emission(2))).toThrow('stage-replay'); continue }
      const second = c.prepare({ kind: 'retained', image: image('{}\n') }, image('{ }\n'))
      const original = emission(2)
      const e = { ...original, producer: { ...original.producer }, activation: { ...original.activation }, descriptor: { ...original.descriptor } }
      if (change === 'sequence') e.sequence = 1
      if (change === 'nonce') e.emissionNonce = emission().emissionNonce
      if (change === 'producer') e.producer.pid += 1
      if (change === 'activation') e.activation.runId = 'other'
      if (change === 'descriptor') e.descriptor.inode = '999'
      expect(() => second.bind(e)).toThrow()
      expect(existsSync(join(directory, 'stage-2.binding'))).toBe(false)
    }
  })

  test('same operation nonce may bind successive distinct native emissions', async () => {
    const { directory } = fixture(); const c = await openCustodian(directory)
    c.prepare({ kind: 'absent' }, image('{}\n')).bind(emission())
    c.prepare({ kind: 'retained', image: image('{}\n') }, image('{ }\n')).bind(emission(2))
    expect(c.receipts()).toHaveLength(2)
  })

  test('rejects image metadata lies, same-size byte substitution, symlinks, and binding collisions', async () => {
    const bad = fixture(); const a = await openCustodian(bad.directory)
    expect(() => a.prepare({ kind: 'absent' }, { ...image('{}\n'), sha256: '0'.repeat(64) })).toThrow('image-metadata')
    for (const attack of ['bytes', 'symlink', 'binding'] as const) {
      const { root, directory } = fixture(); const c = await openCustodian(directory)
      const prepared = c.prepare({ kind: 'absent' }, image('{}\n'))
      if (attack === 'bytes') writeFileSync(join(directory, 'stage-1.next'), '[]\n')
      if (attack === 'symlink') {
        const foreign = join(root, 'foreign'); writeFileSync(foreign, '{}\n', { mode: 0o600 })
        rmSync(join(directory, 'stage-1.next')); symlinkSync(foreign, join(directory, 'stage-1.next'))
      }
      if (attack === 'binding') writeFileSync(join(directory, 'stage-1.binding'), 'collision', { mode: 0o600 })
      expect(() => prepared.bind(emission())).toThrow()
      if (attack === 'binding') expect(readFileSync(join(directory, 'stage-1.binding'), 'utf8')).toBe('collision')
    }
  })

  test('reload rejects substituted operation nonce, line digest, images and binding metadata', async () => {
    const { directory } = fixture(); const c = await openCustodian(directory)
    const { receipt } = c.prepare({ kind: 'absent' }, image('{}\n')).bind(emission())
    for (const key of ['operationNonce', 'lineSha256'] as const) {
      const substituted = { ...receipt, emission: { ...receipt.emission } }; substituted.emission[key] = 'f'.repeat(64)
      await expect(readDiskOwnerWalImages(directory, substituted)).rejects.toThrow('binding-emission')
    }
    writeFileSync(join(directory, 'stage-1.next'), '[]\n')
    await expect(readDiskOwnerWalImages(directory, receipt)).rejects.toThrow('image-metadata')
    writeFileSync(join(directory, 'stage-1.next'), '{}\n')
    writeFileSync(join(directory, 'stage-1.binding'), '{}\n')
    await expect(readDiskOwnerWalImages(directory, receipt)).rejects.toThrow('binding-digest')
  })

  test('refuses foreign directory contents, ancestor symlinks, replaced directory and bounded overflow', async () => {
    const { root, directory } = fixture()
    writeFileSync(join(directory, 'foreign'), 'keep', { mode: 0o600 })
    await expect(createDiskOwnerWalImageCustodian(directory)).rejects.toThrow('directory-not-empty')
    expect(readdirSync(directory)).toEqual(['foreign'])
    symlinkSync(directory, join(root, 'alias'))
    await expect(createDiskOwnerWalImageCustodian(join(root, 'alias'))).rejects.toThrow('directory-symlink')
    const second = fixture(); const c = await openCustodian(second.directory)
    renameSync(second.directory, join(second.root, 'retained')); mkdirSync(second.directory, { mode: 0o700 })
    expect(() => c.prepare({ kind: 'absent' }, image('{}\n'))).toThrow()
    expect(readdirSync(second.directory)).toEqual([])
    const third = fixture(); const d = await createDiskOwnerWalImageCustodian(third.directory, { maxStages: 1 })
    closes.push(() => d.close())
    d.prepare({ kind: 'absent' }, image('{}\n')).bind(emission())
    expect(() => d.prepare({ kind: 'absent' }, image('{}\n'))).toThrow('retention-budget')
  })

  test('real WAL replacement follows staging and actual native append/sync precedes image binding', async () => {
    const { root, directory, walPath } = fixture()
    const events: string[] = []
    const c = await openCustodian(directory, { sync(fd) { fsyncSync(fd); events.push(readFileKind(fd) ? 'image-directory-sync' : 'image-file-sync') } })
    const wrapped: OwnerWalImageCustodian = { prepare(p, n) {
      events.push('prepare')
      if (p.kind === 'absent') expect(existsSync(walPath)).toBe(false)
      else expect(readFileSync(walPath)).toEqual(Buffer.from(p.image.bytes))
      const stage = c.prepare(p, n)
      expect(events.at(-1)).toBe('image-directory-sync')
      expect(existsSync(join(directory, `stage-${events.filter(e => e === 'prepare').length}.binding`))).toBe(false)
      return { bind(e) {
        events.push('bind')
        expect(events.at(-2)).toBe('native-sync')
        expect(readFileSync(walPath)).toEqual(Buffer.from(n.bytes))
        const lines = readFileSync(join(root, 'native.ndjson'), 'utf8').match(/[^\n]*\n/gu)!
        expect(hash(Buffer.from(lines.at(-1)!))).toBe(e.lineSha256)
        expect(JSON.parse(lines.at(-1)!).sequence).toBe(e.sequence)
        return stage.bind(e)
      } }
    } }
    const producer = nativeProducer(root, wrapped, events)
    const wal = new HostedApprovalOwnerWal(walPath, undefined, producer)
    const store = new HostedApprovalOwnerStore(wal)
    await store.reconcileAdmission(admission('a'))
    const predecessor = readFileSync(walPath)
    await store.reconcileAdmission(admission('b'))
    expect(readFileSync(join(directory, 'stage-2.previous'))).toEqual(predecessor)
    expect(c.receipts()).toHaveLength(2)
    const last = await readDiskOwnerWalImages(directory, c.receipts()[1]!)
    expect(last.next.bytes).toEqual(new Uint8Array(readFileSync(walPath)))
    expect(last.emission.descriptor.fd).toBe(9)
  })

  for (const failure of ['wal-rename', 'image-bind'] as const) {
    test(`${failure} uncertainty propagates through the real WAL and producer`, async () => {
      const { root, directory, walPath } = fixture()
      const c = await openCustodian(directory, failure === 'image-bind' ? {
        rename(parent, from, to) { parent.rename(from, to); throw new Error('binding-rename-uncertain') },
      } : {})
      const producer = nativeProducer(root, c, [])
      const wal = new HostedApprovalOwnerWal(walPath, failure === 'wal-rename' ? {
        afterWalRename: async () => { throw new Error('wal-rename-uncertain') },
      } : undefined, producer)
      await expect(new HostedApprovalOwnerStore(wal).reconcileAdmission(admission('a'))).rejects.toMatchObject({
        stage: failure === 'wal-rename' ? 'replacement-uncertain' : 'published-capture-failed',
      })
      expect(existsSync(walPath)).toBe(true)
      expect(producer.isHealthy()).toBe(false)
      const records = readFileSync(join(root, 'native.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
      expect(records.map(record => record.recordType)).toEqual(failure === 'wal-rename'
        ? ['producer-open'] : ['producer-open', 'owner-wal-published'])
      if (failure === 'wal-rename') expect(c.receipts()).toEqual([])
      else expect(() => c.receipts()).toThrow()
    })
  }

  test('directory replacement at the binding rename edge never writes into the replacement directory', async () => {
    const { root, directory } = fixture()
    const c = await openCustodian(directory, { rename(parent, from, to) {
      renameSync(directory, join(root, 'retained'))
      mkdirSync(directory, { mode: 0o700 })
      parent.rename(from, to)
    } })
    const stage = c.prepare({ kind: 'absent' }, image('{}\n'))
    expect(() => stage.bind(emission())).toThrow()
    expect(readdirSync(directory)).toEqual([])
    expect(existsSync(join(root, 'retained', 'stage-1.binding'))).toBe(true)
    expect(() => c.receipts()).toThrow()
  })

  test('real native sync failure leaves staged images unpublished and poisons shared producer', async () => {
    const { root, directory, walPath } = fixture(); const c = await openCustodian(directory)
    let fail = false
    const producer = nativeProducer(root, c, [], () => fail)
    const wal = new HostedApprovalOwnerWal(walPath, undefined, producer)
    fail = true
    await expect(new HostedApprovalOwnerStore(wal).reconcileAdmission(admission('a'))).rejects.toMatchObject({ stage: 'published-capture-failed' })
    expect(existsSync(walPath)).toBe(true)
    expect(existsSync(join(directory, 'stage-1.next'))).toBe(true)
    expect(existsSync(join(directory, 'stage-1.binding'))).toBe(false)
    expect(c.receipts()).toEqual([])
    expect(producer.isHealthy()).toBe(false)
    const replacement = new HostedApprovalOwnerWal(walPath, undefined, producer)
    expect(replacement.isPublicationCaptureCurrent()).toBe(false)
  })
})

// Explicit edge handshakes only: no sleep, timer, or guessed microtask drain.
function publicationSignal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function observed<T>(promise: Promise<T>) {
  return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
}
function proposal(previous: HostedApprovalOwnerState, digest: string) {
  const intent: OwnerWalMutationIntent = {
    operationNonce: digest.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' },
    admission: admission(digest),
  }
  const next = { ...structuredClone(previous), admissionDigest: intent.admission.digest,
    admissionGeneration: intent.admission.admissionGeneration }
  return { previous, next, intent }
}
function publishProposal(wal: HostedApprovalOwnerWal, digest: string) {
  return wal.locked(current => {
    const input = proposal(current!, digest)
    return wal.publishMutation(input.previous, input.next, input.intent)
  })
}

// Two distinct real WALs, one actual native producer and real disk custodian.
// No slot facade/custodian selection logic is implemented by this prerequisite.
async function sharedPublicationFixture(
  failure?: 'before-rename' | 'after-rename' | 'final-fence' | 'bind' | 'bind-close' | 'native-sync',
  lifetime?: { settlement: 'reject' | 'resolve'; abandon?: boolean; holdSecond?: boolean; afterRename?: boolean; typedCancellation?: boolean },
) {
  const { root, directory, walPath: firstPath } = fixture()
  const secondPath = join(root, 'second.json')
  await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(firstPath)).reconcileAdmission(admission('a'))
  await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(secondPath)).reconcileAdmission(admission('b'))
  const previous = [readFileSync(firstPath), readFileSync(secondPath)]
  const custodian = await openCustodian(directory)
  const events: string[] = []
  const blocked = publicationSignal(); const release = publicationSignal(); const queued = publicationSignal()
  const secondBlocked = publicationSignal(); const secondRelease = publicationSignal()
  const cancellation = lifetime?.typedCancellation
    ? new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'shared-facade-cancelled')
    : new Error('shared-facade-cancelled')
  let cancel!: () => void
  const cancelled = new Promise<never>((resolve, reject) => {
    cancel = () => lifetime?.settlement === 'resolve' ? resolve(undefined as never) : reject(cancellation)
  })
  const escaped: Array<Promise<{ value: unknown; error: unknown }>> = []
  let firstPrepared!: ReturnType<OwnerWalPublicationProducer['prepare']>
  let stages = 0
  const producer = nativeProducer(root, { prepare(p, n) {
    const number = ++stages
    events.push(`stage-${number}`)
    const staged = custodian.prepare(p, n)
    return { bind(emission) {
      events.push(`bind-start-${number}`)
      if (failure === 'bind' && number === 1) throw new Error('shared-bind-failure')
      if (failure === 'bind-close' && number === 1) producer.close()
      const result = staged.bind(emission)
      events.push(`bound-${number}`)
      return result
    } }
  } }, events, () => failure === 'native-sync' && stages === 1)
  // Observe real admission, including a fallback prepare edge so reverting WAL
  // sequencing fails an assertion instead of waiting forever for a new API call.
  const withPublication = producer.withPublication?.bind(producer)
  const prepare = producer.prepare.bind(producer)
  let requests = 0; let prepares = 0
  if (withPublication) producer.withPublication = <T>(operation: () => Promise<T>) => {
    const result = withPublication(operation)
    if (++requests === 2) queued.resolve()
    return result
  }
  producer.prepare = input => {
    events.push(`prepare-${++prepares}`)
    if (prepares === 2) queued.resolve()
    return prepare(input)
  }
  const firstProducer: OwnerWalPublicationProducer = lifetime ? {
    isHealthy: () => producer.isHealthy(),
    withPublication: <T>(operation: () => Promise<T>) => producer.withPublication(() => {
      const pending = operation()
      escaped.push(observed(pending))
      return Promise.race([pending, cancelled])
    }),
    prepare(input) { firstPrepared = producer.prepare(input); return firstPrepared },
    poison: reason => producer.poison(reason), close: () => {},
  } : producer
  const secondProducer: OwnerWalPublicationProducer = lifetime ? {
    isHealthy: () => producer.isHealthy(),
    withPublication: operation => producer.withPublication(operation),
    prepare: input => producer.prepare(input),
    poison: reason => producer.poison(reason), close: () => {},
  } : producer
  const first = new HostedApprovalOwnerWal(firstPath, {
    afterWalTempFsync: async () => {
      // This hook is before rename in A's original admission context. Explicit
      // abandonment revokes its capability even though the callback escapes.
      if (lifetime?.abandon) abandonOwnerWalPublication(firstPrepared.lifetime)
      events.push('first-temp')
      if (!lifetime?.afterRename) { blocked.resolve(); await release.promise }
      if (failure === 'before-rename') throw new Error('shared-before-rename')
    },
    afterWalRename: async () => {
      events.push('first-replaced')
      if (lifetime?.afterRename) { blocked.resolve(); await release.promise }
      if (failure === 'after-rename') throw new Error('shared-after-rename')
      if (failure === 'final-fence') {
        renameSync(first.lockPath, `${first.lockPath}.retained`)
        writeFileSync(first.lockPath, '', { mode: 0o600 })
      }
    },
  }, firstProducer)
  const second = new HostedApprovalOwnerWal(secondPath, {
    afterWalTempFsync: async () => {
      events.push('second-temp'); secondBlocked.resolve()
      if (lifetime?.holdSecond) await secondRelease.promise
    },
    afterWalRename: async () => { events.push('second-replaced') },
  }, secondProducer)
  return { root, directory, firstPath, secondPath, previous, producer, custodian, events,
    blocked, release, queued, first, second, cancel, cancellation, escaped, secondBlocked, secondRelease }
}

describe.skipIf(process.platform !== 'linux')('shared Owner FD9 publication sequencing prerequisite', () => {
  test('distinct WALs serialize prepare through replacement, emission and real P/N receipt binding', async () => {
    const f = await sharedPublicationFixture()
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    const second = observed(publishProposal(f.second, 'd'))
    try {
      await f.queued.promise
      expect(f.events.filter(event => event.startsWith('prepare-'))).toEqual(['prepare-1'])
      expect(f.events).not.toContain('second-temp')
      expect(f.events).not.toContain('second-replaced')
      expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
      expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
      expect(f.custodian.receipts()).toEqual([])
    } finally { f.release.resolve() }
    const a = await first; const b = await second
    expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined()
    expect(a.value?.capture).toBe('bound'); expect(b.value?.capture).toBe('bound')
    expect(f.events.indexOf('prepare-2')).toBeGreaterThan(f.events.indexOf('bound-1'))
    const lines = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n')
    const records = lines.map(line => JSON.parse(line))
    expect(records.map(record => record.sequence)).toEqual([0, 1, 2])
    expect(records.map(record => record.recordType)).toEqual(['producer-open', 'owner-wal-published', 'owner-wal-published'])
    expect(records[1].previousRecordSha256).toBe(hash(Buffer.from(`${lines[0]}\n`)))
    expect(records[2].previousRecordSha256).toBe(hash(Buffer.from(`${lines[1]}\n`)))
    for (const [index, result] of [a.value!, b.value!].entries()) {
      if (result.capture !== 'bound') throw new Error('missing publication receipt')
      const publication = result.publication
      expect(publication.receipt).toEqual(f.custodian.receipts()[index])
      expect(publication.emission.sequence).toBe(index + 1)
      expect(publication.emission.operationNonce).toBe((index === 0 ? 'c' : 'd').repeat(64))
      const retained = await readDiskOwnerWalImages(f.directory, publication.receipt!)
      expect(retained.previous.kind).toBe('retained')
      if (retained.previous.kind !== 'retained') throw new Error('missing real predecessor')
      expect(Buffer.from(retained.previous.image.bytes)).toEqual(f.previous[index])
      expect(Buffer.from(retained.next.bytes)).toEqual(readFileSync(index === 0 ? f.firstPath : f.secondPath))
      expect(publication.previous).toEqual(retained.previous)
      expect(publication.next).toEqual(retained.next)
      expect(publication.emission).toEqual(retained.emission)
      expect(records[index + 1].native.stateDelta.previousStateSha256).toBe(hash(f.previous[index]!))
      expect(records[index + 1].native.wal.sha256).toBe(retained.next.sha256)
    }
    f.producer.close()
    const closed = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    expect(closed.at(-1)).toMatchObject({ recordType: 'producer-close', sequence: 3,
      previousRecordSha256: hash(Buffer.from(`${lines[2]}\n`)) })
  })

  for (const failure of ['after-rename', 'final-fence', 'bind', 'bind-close', 'native-sync'] as const) {
    test(`${failure} poisons the shared producer before the queued WAL can prepare or replace`, async () => {
      const f = await sharedPublicationFixture(failure)
      const first = observed(publishProposal(f.first, 'c'))
      await f.blocked.promise
      const second = observed(publishProposal(f.second, 'd'))
      try { await f.queued.promise } finally { f.release.resolve() }
      const a = await first; const b = await second
      const captureFailed = failure === 'bind' || failure === 'bind-close' || failure === 'native-sync'
      expect(a.error).toMatchObject({ stage: captureFailed ? 'published-capture-failed' : 'replacement-uncertain' })
      expect(b.error).toMatchObject({ stage: 'definitely-not-replaced' })
      expect(f.producer.isHealthy()).toBe(false)
      expect(f.first.isPublicationCaptureCurrent()).toBe(false)
      expect(f.second.isPublicationCaptureCurrent()).toBe(false)
      expect(f.events).not.toContain('prepare-2')
      expect(f.events).not.toContain('second-temp')
      expect(f.events).not.toContain('second-replaced')
      expect(readFileSync(f.firstPath)).not.toEqual(f.previous[0])
      expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
      expect(f.custodian.receipts()).toEqual([])
      const records = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
      // A written line alone is not successful capture: native-sync has no receipt.
      expect(records.map(record => record.recordType)).toEqual(captureFailed
        ? ['producer-open', 'owner-wal-published'] : ['producer-open'])
      expect(existsSync(join(f.directory, 'stage-1.binding'))).toBe(false)
      expect(existsSync(join(f.directory, 'stage-2.next'))).toBe(false)
    })
  }

  for (const action of ['poison', 'close'] as const) {
    test(`${action} rejects a queued WAL while the first mutation is still blocked, without a close fact`, async () => {
      const f = await sharedPublicationFixture()
      const first = observed(publishProposal(f.first, 'c'))
      await f.blocked.promise
      const second = observed(publishProposal(f.second, 'd'))
      try {
        await f.queued.promise
        expect(() => action === 'close' ? f.producer.close() : f.producer.poison('shared-external-poison')).toThrow()
        // This must settle without releasing the first filesystem hook.
        expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
        expect(f.producer.isHealthy()).toBe(false)
        expect(f.events).not.toContain('prepare-2')
        expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
        const records = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
        expect(records.map(record => record.recordType)).toEqual(['producer-open'])
      } finally { f.release.resolve() }
      expect((await first).error).toMatchObject({ stage: 'definitely-not-replaced' })
      expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
      expect(f.custodian.receipts()).toEqual([])
      const later = await observed(publishProposal(f.second, 'e'))
      expect(later.error).toMatchObject({ stage: 'definitely-not-replaced' })
    })
  }

  test('owns previous, proposal and nested intent inputs before queued admission', async () => {
    const f = await sharedPublicationFixture()
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    let input!: ReturnType<typeof proposal>
    const second = observed(f.second.locked(current => {
      input = proposal(current!, 'd')
      return f.second.publishMutation(input.previous, input.next, input.intent)
    }))
    try {
      await f.queued.promise
      input.previous.admissionDigest = 'f'.repeat(64)
      input.previous.actorMembers.changed = 'caller'
      input.next.admissionDigest = 'e'.repeat(64)
      input.next.actorMembers.changed = 'caller'
      // Test deliberate hostile mutation through the public readonly types.
      Object.assign(input.intent, { operationNonce: 'f'.repeat(64) })
      Object.assign(input.intent.mutation, { outcome: 'changed' })
      if (!('admission' in input.intent)) throw new Error('wrong test intent')
      Object.assign(input.intent.admission, { digest: 'e'.repeat(64) })
      Object.assign(input.intent.admission.actorMembers, { changed: 'caller' })
      Object.assign(input.intent.admission.outerAuthority.mountBinding, { declaredRootHash: 'f'.repeat(64) })
    } finally { f.release.resolve() }
    expect((await first).error).toBeUndefined()
    const result = await second
    expect(result.error).toBeUndefined()
    expect(result.value?.state.admissionDigest).toBe('d'.repeat(64))
    expect(result.value?.state.actorMembers).toEqual({})
    if (result.value?.capture !== 'bound') throw new Error('missing bound result')
    expect(result.value.publication.emission.operationNonce).toBe('d'.repeat(64))
    expect(result.value.publication.native.mutation).toEqual({ kind: 'admission-reconciled', outcome: 'published' })
    const retained = await readDiskOwnerWalImages(f.directory, result.value.publication.receipt!)
    expect(retained.previous.kind).toBe('retained')
    if (retained.previous.kind === 'retained') expect(Buffer.from(retained.previous.image.bytes)).toEqual(f.previous[1])
  })

  for (const [settlement, afterRename, typedCancellation] of [
    ['reject', false, false], ['resolve', false, false], ['reject', true, false],
    ['reject', false, true], ['reject', true, true],
  ] as const) {
    test(`facade ${settlement}${typedCancellation ? ' typed cancellation' : ''} ${afterRename ? 'after rename' : 'before rename'} poisons unresolved preparation before releasing distinct-WAL admission`, async () => {
      const f = await sharedPublicationFixture(undefined, { settlement, afterRename, typedCancellation })
      const callerSettled = publicationSignal(); const finishLock = publicationSignal()
      let caller!: Awaited<ReturnType<typeof observed>>
      // Keep the authentic writer lock open after the publication caller has
      // received its failure, exactly as in review1216's escaped-callback repro.
      const first = observed(f.first.locked(async current => {
        const input = proposal(current!, 'c')
        caller = await observed(f.first.publishMutation(input.previous, input.next, input.intent))
        callerSettled.resolve()
        await finishLock.promise
      }))
      await f.blocked.promise
      const second = observed(publishProposal(f.second, 'd'))
      const nativeBefore = readFileSync(join(f.root, 'native.ndjson'))
      const firstBeforeCancellation = readFileSync(f.firstPath)
      try {
        await f.queued.promise
        expect(f.events).not.toContain('prepare-2')
        f.cancel()
        await callerSettled.promise
        expect(caller.value).toBeUndefined()
        expect(caller.error).toBeInstanceOf(HostedApprovalOwnerPublicationError)
        if (typedCancellation && !afterRename) expect(caller.error).toBe(f.cancellation)
        else expect(caller.error).toMatchObject({ stage: afterRename ? 'replacement-uncertain' : 'definitely-not-replaced',
          message: 'Hosted approval WAL publication admission failed',
          cause: settlement === 'reject' ? f.cancellation : { message: 'owner-provenance-publication-unresolved' } })
        if (typedCancellation && afterRename) expect((caller.error as Error).cause).toBe(f.cancellation)
        // B's rejection must finish while A is still blocked at the selected edge.
        const b = await second
        expect(b.value).toBeUndefined()
        expect(b.error).toMatchObject({ stage: 'definitely-not-replaced' })
        expect(f.producer.isHealthy()).toBe(false)
        expect(f.first.isPublicationCaptureCurrent()).toBe(false)
        expect(f.second.isPublicationCaptureCurrent()).toBe(false)
        expect(readFileSync(f.firstPath)).toEqual(firstBeforeCancellation)
        if (afterRename) expect(firstBeforeCancellation).not.toEqual(f.previous[0])
        else expect(firstBeforeCancellation).toEqual(f.previous[0])
        expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
        expect(f.custodian.receipts()).toEqual([])
        expect(() => f.producer.close()).toThrow('publication-unresolved')
        expect(readFileSync(join(f.root, 'native.ndjson'))).toEqual(nativeBefore)
      } finally {
        f.release.resolve()
        await Promise.all(f.escaped)
        finishLock.resolve()
        await Promise.all([first, second])
      }
      expect(f.escaped).toHaveLength(1)
      const escaped = await f.escaped[0]!
      expect(escaped.value).toBeUndefined()
      expect(escaped.error).toMatchObject({ stage: afterRename ? 'published-capture-failed' : 'definitely-not-replaced' })
      expect(readFileSync(f.firstPath)).toEqual(firstBeforeCancellation)
      expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
      expect(f.events.filter(event => event === 'first-replaced')).toHaveLength(afterRename ? 1 : 0)
      expect(f.events).not.toContain('prepare-2')
      expect(f.events).not.toContain('second-replaced')
      expect(readFileSync(join(f.root, 'native.ndjson'))).toEqual(nativeBefore)
      expect(f.custodian.receipts()).toEqual([])
      expect(existsSync(join(f.directory, 'stage-1.next'))).toBe(true)
      expect(existsSync(join(f.directory, 'stage-1.binding'))).toBe(false)
      expect(existsSync(join(f.directory, 'stage-2.next'))).toBe(false)
      if (afterRename) expect((await first).error).toMatchObject({ stage: 'published-capture-failed' })
      else expect((await first).error).toBeUndefined()
    })
  }

  for (const typed of [false, true]) {
    test(`${typed ? 'typed' : 'plain'} admission rejection after an earlier publication in the same lock remains definitely not replaced`, async () => {
      const { root, directory, walPath } = fixture()
      await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath)).reconcileAdmission(admission('a'))
      const custodian = await openCustodian(directory)
      const producer = nativeProducer(root, custodian, [])
      const rejection = typed
        ? new HostedApprovalOwnerPublicationError('definitely-not-replaced', 'second-admission-rejected')
        : new Error('second-admission-rejected')
      let requests = 0
      const facade: OwnerWalPublicationProducer = {
        isHealthy: () => producer.isHealthy(),
        withPublication: operation => ++requests === 1 ? producer.withPublication(operation) : Promise.reject(rejection),
        prepare: input => producer.prepare(input),
        poison: reason => producer.poison(reason), close: () => {},
      }
      const wal = new HostedApprovalOwnerWal(walPath, undefined, facade)
      await wal.locked(async current => {
        const first = proposal(current!, 'b')
        const published = await wal.publishMutation(first.previous, first.next, first.intent)
        expect(published.capture).toBe('bound')
        const installed = readFileSync(walPath)
        const second = proposal(published.state, 'c')
        const caller = await observed(wal.publishMutation(second.previous, second.next, second.intent))
        expect(caller.value).toBeUndefined()
        expect(caller.error).toBeInstanceOf(HostedApprovalOwnerPublicationError)
        expect(caller.error).toMatchObject({ stage: 'definitely-not-replaced' })
        if (typed) expect(caller.error).toBe(rejection)
        else expect((caller.error as Error).cause).toBe(rejection)
        expect(readFileSync(walPath)).toEqual(installed)
        expect(custodian.receipts()).toHaveLength(1)
        expect(producer.isHealthy()).toBe(true)
        expect(wal.isPublicationCaptureCurrent()).toBe(true)
      })
      expect(requests).toBe(2)
    })
  }

  test('an explicitly abandoned escaped WAL cannot replace under a new healthy holder', async () => {
    const f = await sharedPublicationFixture(undefined, { settlement: 'reject', abandon: true, holdSecond: true })
    const callerSettled = publicationSignal(); const finishLock = publicationSignal()
    let callerError: unknown
    const first = observed(f.first.locked(async current => {
      const input = proposal(current!, 'c')
      callerError = (await observed(f.first.publishMutation(input.previous, input.next, input.intent))).error
      callerSettled.resolve()
      await finishLock.promise
    }))
    await f.blocked.promise
    const second = observed(publishProposal(f.second, 'd'))
    const nativeBefore = readFileSync(join(f.root, 'native.ndjson'))
    try {
      await f.queued.promise
      f.cancel()
      await callerSettled.promise
      expect(callerError).toMatchObject({ stage: 'definitely-not-replaced', cause: f.cancellation })
      // Abandonment allowed B to prepare while keeping the native producer healthy.
      await Promise.race([f.secondBlocked.promise, second.then(() => { throw new Error('B settled before healthy admission barrier') })])
      expect(f.producer.isHealthy()).toBe(true)
      expect(f.events).toContain('prepare-2')
      expect(f.events).toContain('second-temp')
      f.release.resolve()
      const escaped = await f.escaped[0]!
      expect(escaped.value).toBeUndefined()
      expect(escaped.error).toMatchObject({ stage: 'definitely-not-replaced',
        cause: { message: 'owner-provenance-publication-admission-expired' } })
      expect(f.events).not.toContain('first-replaced')
      expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
      expect(f.producer.isHealthy()).toBe(false)
    } finally {
      f.release.resolve(); f.secondRelease.resolve()
      await Promise.all(f.escaped)
      finishLock.resolve()
      await Promise.all([first, second])
    }
    expect((await first).error).toBeUndefined()
    expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
    expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
    expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
    expect(f.events).not.toContain('second-replaced')
    expect(f.custodian.receipts()).toEqual([])
    expect(readFileSync(join(f.root, 'native.ndjson'))).toEqual(nativeBefore)
    expect(existsSync(join(f.directory, 'stage-1.binding'))).toBe(false)
    expect(existsSync(join(f.directory, 'stage-2.binding'))).toBe(false)
  })

  test('a facade assertion and invented lifetime cannot authorize actual WAL replacement', async () => {
    const f = await sharedPublicationFixture()
    const prepare = f.producer.prepare.bind(f.producer)
    f.producer.prepare = input => ({ ...prepare(input), lifetime: Object.freeze({}), assertCurrent: () => true })
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    const second = observed(publishProposal(f.second, 'd'))
    try { await f.queued.promise } finally { f.release.resolve() }
    expect((await first).error).toMatchObject({ stage: 'definitely-not-replaced',
      cause: { message: 'owner-provenance-publication-lifetime-required' } })
    expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
    expect(f.producer.isHealthy()).toBe(false)
    expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
    expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
    expect(f.events).not.toContain('first-replaced')
    expect(f.events).not.toContain('prepare-2')
    expect(f.custodian.receipts()).toEqual([])
  })

  test('abandonment revokes replacement even before the original admission is released', async () => {
    const f = await sharedPublicationFixture(undefined, { settlement: 'reject', abandon: true })
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    const second = observed(publishProposal(f.second, 'd'))
    try {
      await f.queued.promise
      expect(f.producer.isHealthy()).toBe(true)
    } finally { f.release.resolve() }
    expect((await first).error).toMatchObject({ stage: 'definitely-not-replaced',
      cause: { message: 'owner-provenance-prepared-publication-stale' } })
    expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
    await Promise.all(f.escaped)
    expect(f.events).not.toContain('first-replaced')
    expect(f.events).not.toContain('prepare-2')
    expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
    expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
    expect(f.custodian.receipts()).toEqual([])
  })

  test('definitely-not-replaced failure releases admission without consuming a native sequence', async () => {
    const f = await sharedPublicationFixture('before-rename')
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    const second = observed(publishProposal(f.second, 'd'))
    try { await f.queued.promise } finally { f.release.resolve() }
    expect((await first).error).toMatchObject({ stage: 'definitely-not-replaced' })
    const result = await second
    expect(result.error).toBeUndefined()
    expect(f.producer.isHealthy()).toBe(true)
    expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
    if (result.value?.capture !== 'bound') throw new Error('missing bound result')
    expect(result.value.publication.emission.sequence).toBe(1)
    expect(result.value.publication.receipt?.stage).toBe(2)
    expect(f.custodian.receipts()).toEqual([result.value.publication.receipt!])
    const retained = await readDiskOwnerWalImages(f.directory, result.value.publication.receipt!)
    expect(retained.previous.kind).toBe('retained')
    if (retained.previous.kind !== 'retained') throw new Error('missing real predecessor')
    expect(Buffer.from(retained.previous.image.bytes)).toEqual(f.previous[1])
    expect(Buffer.from(retained.next.bytes)).toEqual(readFileSync(f.secondPath))
    expect(result.value.publication.previous).toEqual(retained.previous)
    expect(result.value.publication.next).toEqual(retained.next)
    expect(result.value.publication.emission).toEqual(retained.emission)
    expect(existsSync(join(f.directory, 'stage-1.binding'))).toBe(false)
    const lines = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).previousRecordSha256).toBe(hash(Buffer.from(`${lines[0]}\n`)))
  })

  for (const substitution of ['predecessor', 'writer-fence'] as const) {
    test(`revalidates queued ${substitution} before custody staging`, async () => {
      const f = await sharedPublicationFixture()
      const first = observed(publishProposal(f.first, 'c'))
      await f.blocked.promise
      const second = observed(publishProposal(f.second, 'd'))
      try {
        await f.queued.promise
        if (substitution === 'predecessor') writeFileSync(f.secondPath, Buffer.concat([Buffer.from(' '), f.previous[1]!]))
        else {
          renameSync(f.second.lockPath, `${f.second.lockPath}.retained`)
          writeFileSync(f.second.lockPath, '', { mode: 0o600 })
        }
      } finally { f.release.resolve() }
      expect((await first).error).toBeUndefined()
      expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
      expect(f.events).not.toContain('prepare-2')
      expect(f.events).not.toContain('second-temp')
      expect(f.events).not.toContain('second-replaced')
      expect(f.custodian.receipts()).toHaveLength(1)
    })
  }

  test('independent real producers can replace and bind while another producer is blocked', async () => {
    const f = await sharedPublicationFixture()
    const g = fixture(); const custodian = await openCustodian(g.directory)
    const producer = nativeProducer(g.root, custodian, [])
    const first = observed(publishProposal(f.first, 'c'))
    await f.blocked.promise
    try {
      await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(g.walPath, undefined, producer)).reconcileAdmission(admission('d'))
      expect(custodian.receipts()).toHaveLength(1)
      expect(custodian.receipts()[0]!.emission.sequence).toBe(1)
      expect(existsSync(g.walPath)).toBe(true)
      expect(f.custodian.receipts()).toEqual([])
      expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
    } finally { f.release.resolve() }
    expect((await first).error).toBeUndefined()
  })

  test('nested publication admission poisons and rejects instead of deadlocking or hiding the error', async () => {
    const f = await sharedPublicationFixture()
    const failure = await observed(f.producer.withPublication(async () => {
      // Even a caller catching the nested rejection cannot restore health.
      await expect(f.producer.withPublication(async () => undefined)).rejects.toThrow('publication-reentrant')
      return 'caught'
    }))
    expect(failure.error).toMatchObject({ message: 'owner-provenance-publication-reentrant' })
    expect(failure.value).toBeUndefined()
    expect(f.producer.isHealthy()).toBe(false)
    expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
  })

  for (const action of ['prepare', 'emit'] as const) {
    test(`an unrelated caller cannot ${action} under another WAL's admission`, async () => {
      const f = await sharedPublicationFixture()
      const prepare = f.producer.prepare.bind(f.producer)
      let input!: Parameters<typeof prepare>[0]
      let prepared!: ReturnType<typeof prepare>
      f.producer.prepare = value => { input = value; prepared = prepare(value); return prepared }
      const first = observed(publishProposal(f.first, 'c'))
      await f.blocked.promise
      const second = observed(publishProposal(f.second, 'd'))
      try {
        await f.queued.promise
        expect(() => action === 'prepare' ? f.producer.prepare(input) : prepared.emit()).toThrow('publication-admission')
        expect((await second).error).toMatchObject({ stage: 'definitely-not-replaced' })
        expect(f.custodian.receipts()).toEqual([])
        expect(readFileSync(f.secondPath)).toEqual(f.previous[1])
      } finally { f.release.resolve() }
      expect((await first).error).toMatchObject({ stage: 'definitely-not-replaced' })
      expect(readFileSync(f.firstPath)).toEqual(f.previous[0])
      const records = readFileSync(join(f.root, 'native.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
      expect(records.map(record => record.recordType)).toEqual(['producer-open'])
    })
  }

  test('bounded queued admission rejects overflow and releases all admitted callers in order', async () => {
    const f = await sharedPublicationFixture()
    const held = publicationSignal(); const release = publicationSignal()
    const first = observed(f.producer.withPublication(async () => { held.resolve(); await release.promise }))
    await held.promise
    const order: number[] = []
    const queued = Array.from({ length: 64 }, (_, index) => observed(f.producer.withPublication(async () => { order.push(index) })))
    try {
      await expect(f.producer.withPublication(async () => { throw new Error('overflow admitted') })).rejects.toThrow('queue-full')
      expect(order).toEqual([])
      expect(f.producer.isHealthy()).toBe(true)
    } finally { release.resolve() }
    expect((await first).error).toBeUndefined()
    for (const result of await Promise.all(queued)) expect(result.error).toBeUndefined()
    expect(order).toEqual(Array.from({ length: 64 }, (_, index) => index))
  })
})

// Uses real Linux identity, descriptor inspection, partial native writes and
// fdatasync. Only descriptor NUMBER is remapped to the test-owned capture FD.
function nativeProducer(root: string, imageCustodian: OwnerWalImageCustodian, events: string[], failSync = () => false) {
  const operations = createOwnerProvenanceNodeOperations()
  const modulePath = resolve(import.meta.dir, 'HostedApprovalOwnerProvenance.ts')
  const identity = operations.identity(modulePath)
  const fd = openSync(join(root, 'native.ndjson'), constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY, 0o600)
  let closed = false
  closes.push(() => { if (!closed) { closed = true; closeSync(fd) } })
  const descriptor = operations.descriptor(fd)
  const capsule = JSON.stringify({
    activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
    contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
    expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: identity.exeSha256,
      implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: identity.moduleSha256 },
    producerRole: 'owner', streams: { ownerWalTimeline: { device: descriptor.device, fd: 9, inode: descriptor.inode } }, version: 2,
  })
  const map = (requested: number) => { expect(requested).toBe(9); return fd }
  const producer = createOwnerWalPublicationProducerFromEnvironment({
    environment: { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: capsule }, modulePath, imageCustodian,
    operations: { ...operations,
      descriptor: requested => operations.descriptor(map(requested)),
      write: (requested, bytes, offset) => writeSync(map(requested), bytes, offset, Math.min(19, bytes.length - offset), null),
      sync: requested => { if (failSync()) throw new Error('native-sync-failure'); operations.sync(map(requested)); events.push('native-sync') },
      close: requested => { operations.close(map(requested)); closed = true },
    },
  })!
  closes.push(() => producer.close())
  return producer
}
function admission(digest: string): HostedApprovalRuntimeAdmission {
  return {
    schemaVersion: 1, admissionGeneration: `approval-admission-generation_${digest}`,
    digest: digest.repeat(64), routes: [], actorMembers: {},
    outerAuthority: { deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
      teamId: `team_${'1'.repeat(32)}`, restoreGeneration: 1, mountBinding: { mountGeneration: 1, declaredRootHash: '0'.repeat(64) } },
    isCurrent: async () => true, prepareEffectToken: async () => null,
  }
}
// Kept separate so fault injection distinguishes real directory/file fsync.
function readFileKind(fd: number): boolean { return fstatSync(fd).isDirectory() }
