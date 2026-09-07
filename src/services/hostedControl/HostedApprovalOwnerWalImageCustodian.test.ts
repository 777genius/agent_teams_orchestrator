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
  HOSTED_OWNER_PROVENANCE_CONTRACT, HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, retainedWalImage,
  type BoundOwnerEmission, type OwnerWalImageCustodian,
} from './HostedApprovalOwnerProvenance.js'
import { HostedApprovalOwnerPublicationError, HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'
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
