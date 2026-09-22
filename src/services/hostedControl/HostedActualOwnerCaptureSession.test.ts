import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOSTED_ACTUAL_OWNER_CORPUS_FILE,
  HostedActualOwnerCaptureSession,
} from './HostedActualOwnerCaptureSession.js'
import { HostedApprovalOwnerStore, withoutRevision } from './HostedApprovalOwnerStore.js'
import { HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'
import {
  HOSTED_OWNER_PROVENANCE_CONTRACT,
  HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION,
  type OwnerProvenanceOperations,
} from './HostedApprovalOwnerProvenance.js'
import { parseHostedActualOwnerNativePublication } from '../../entrypoints/hostedActualOwnerAcceptance.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function fixture(startTicks = '9') {
  const chunks: Buffer[] = []
  let nonce = 0
  let syncs = 0
  let closes = 0
  const operations: OwnerProvenanceOperations = {
    identity: () => ({ pid: process.pid, startTicks, exeDev: '10', exeIno: '11',
      exeSha256: '4'.repeat(64), moduleSha256: '5'.repeat(64) }),
    descriptor: () => ({ device: '7', inode: '8', regular: true, append: true,
      writeOnly: true, mode: 0o600, nlink: '1', size: '0' }),
    nonce: () => (++nonce).toString(16).padStart(64, '0'),
    write: (_fd, bytes, offset) => { chunks.push(Buffer.from(bytes.subarray(offset))); return bytes.byteLength - offset },
    sync: () => { syncs += 1 },
    close: () => { closes += 1 },
  }
  const environment = { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: JSON.stringify({
    activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
    contract: HOSTED_OWNER_PROVENANCE_CONTRACT,
    contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
    expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: '4'.repeat(64),
      implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: '5'.repeat(64) },
    producerRole: 'owner', streams: { ownerWalTimeline: { device: '7', fd: 9, inode: '8' } }, version: 2,
  }) }
  return { chunks, operations, environment, get syncs() { return syncs }, get closes() { return closes } }
}

function admission(digest = 'd'.repeat(64)) {
  return {
    schemaVersion: 1 as const, admissionGeneration: 'approval-admission-generation_owner_2', digest,
    routes: [], actorMembers: {}, outerAuthority: {
      deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
      teamId: `team_${'1'.repeat(32)}`, restoreGeneration: 1,
      mountBinding: { mountGeneration: 1, declaredRootHash: '0'.repeat(64) },
    },
    isCurrent: async () => true, prepareEffectToken: async () => null,
  }
}

describe('HostedActualOwnerCaptureSession', () => {
  test('accepts every publication only after the outer lock and preserves distinct same-nonce records in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-session-')); roots.push(root)
    const walPath = join(root, 'owner.json')
    const fx = fixture()
    const session = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: fx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_2', provenanceOperations: fx.operations,
        fileOperations: { open: openSync, close: closeSync, sync: fsyncSync,
          write: (fd, bytes, offset) => writeSync(fd, bytes, offset, Math.min(7, bytes.byteLength - offset)) } } })!
    const wal = new HostedApprovalOwnerWal(walPath, undefined, session.producer)
    const store = new HostedApprovalOwnerStore(wal, Date.now, session)
    const admitted = admission()
    await store.reconcileAdmission(admitted)
    const operationNonce = 'a'.repeat(64)
    await store.locked(async current => {
      const intent = { operationNonce, mutation: { kind: 'admission-reconciled' as const,
        outcome: 'published' as const }, admission: admitted }
      const first = await wal.publishMutation(current, withoutRevision(current!), intent)
      await wal.publishMutation(first.state, withoutRevision(first.state), intent)
    })
    const records = (await readFile(join(root, HOSTED_ACTUAL_OWNER_CORPUS_FILE), 'utf8')).trim().split('\n')
      .map(line => parseHostedActualOwnerNativePublication(Buffer.from(`${line}\n`)))
    expect(records).toHaveLength(3)
    expect(records.slice(1).map(record => record.operation.request.operationNonce)).toEqual([operationNonce, operationNonce])
    expect(records.slice(1).map(record => record.operation.request.mutation.kind)).toEqual(['admission-reconciled', 'admission-reconciled'])
    expect(records[1]!.publication.receipt.revision).toBe(2)
    expect(records[2]!.publication.receipt.revision).toBe(3)
    expect(fx.syncs).toBeGreaterThanOrEqual(3)
    expect((await readdir(root)).filter(name => name.includes('custody'))).toHaveLength(1)
    await session.close()
    expect(fx.closes).toBe(1)
  })

  test('requires durable predecessor lineage and shares irreversible poison with reconstructed WALs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-lineage-')); roots.push(root)
    const walPath = join(root, 'owner.json')
    await Bun.write(walPath, '{}\n')
    const fx = fixture()
    expect(() => HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: fx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_2', provenanceOperations: fx.operations } }))
      .toThrow('hosted_actual_owner_initial_lineage_unproven')
  })

  test('verifies the accepted predecessor corpus before publishing process-replacement lineage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-replacement-')); roots.push(root)
    const walPath = join(root, 'owner.json')
    const firstFx = fixture('9')
    const first = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: firstFx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_1', provenanceOperations: firstFx.operations } })!
    await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath, undefined, first.producer), Date.now, first)
      .reconcileAdmission(admission('a'.repeat(64)))
    await first.close()

    const secondFx = fixture('10')
    const second = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: secondFx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_2', provenanceOperations: secondFx.operations } })!
    await new HostedApprovalOwnerStore(new HostedApprovalOwnerWal(walPath, undefined, second.producer), Date.now, second)
      .reconcileAdmission(admission('b'.repeat(64)))
    const records = (await readFile(join(root, HOSTED_ACTUAL_OWNER_CORPUS_FILE), 'utf8')).trim().split('\n')
      .map(line => parseHostedActualOwnerNativePublication(Buffer.from(`${line}\n`)))
    expect(records[1]!.owner).toMatchObject({ replacementReason: 'process-replacement',
      predecessorOwnerStartToken: records[0]!.owner.ownerStartToken,
      predecessorOwnerGeneration: 'generation_owner_1' })
    await second.close()
  })

  test('classifies corpus failure after replacement and irreversibly poisons every WAL sharing the producer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-poison-')); roots.push(root)
    const walPath = join(root, 'owner.json')
    const fx = fixture()
    let writes = 0
    const session = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: fx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_2', provenanceOperations: fx.operations,
        fileOperations: {
          open: openSync, close: closeSync, sync: fsyncSync,
          write(fd, bytes, offset) {
            writes += 1
            return writes === 2 ? 0 : writeSync(fd, bytes, offset, bytes.byteLength - offset)
          },
        } } })!
    const wal = new HostedApprovalOwnerWal(walPath, undefined, session.producer)
    const store = new HostedApprovalOwnerStore(wal, Date.now, session)
    await expect(store.reconcileAdmission(admission())).rejects.toMatchObject({ stage: 'published-capture-failed' })
    expect(await readFile(walPath, 'utf8')).toContain('approval-admission-generation_owner_2')
    expect(session.isHealthy()).toBe(false)
    expect(new HostedApprovalOwnerWal(walPath, undefined, session.producer).isPublicationCaptureCurrent()).toBe(false)
  })

  test('custody failure is definitely-not-replaced while FD9 sync failure after replacement is uncertain', async () => {
    for (const boundary of ['custody', 'segment-sync'] as const) {
      const root = await mkdtemp(join(tmpdir(), `hosted-owner-live-${boundary}-`)); roots.push(root)
      const walPath = join(root, 'owner.json')
      const fx = fixture()
      let provenanceSyncs = 0
      const provenanceOperations = boundary === 'segment-sync'
        ? { ...fx.operations, sync: () => {
          provenanceSyncs += 1
          if (provenanceSyncs >= 3) throw new Error('segment sync failed')
        } }
        : fx.operations
      const session = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
        configuration: { environment: fx.environment, modulePath: import.meta.path,
          ownerGeneration: 'generation_owner_2', provenanceOperations,
          ...(boundary === 'custody' ? { fileOperations: { open: openSync, close: closeSync,
            write: (fd: number, bytes: Uint8Array, offset: number) => writeSync(fd, bytes, offset, bytes.byteLength - offset),
            sync: () => { throw new Error('custody sync failed') } } } : {}) } })!
      const store = new HostedApprovalOwnerStore(
        new HostedApprovalOwnerWal(walPath, undefined, session.producer), Date.now, session,
      )
      const operation = store.reconcileAdmission(admission())
      if (boundary === 'custody') {
        await expect(operation).rejects.toMatchObject({ stage: 'definitely-not-replaced' })
        expect(Bun.file(walPath).size).toBe(0)
      } else {
        await expect(operation).rejects.toMatchObject({ stage: 'published-capture-failed' })
        expect(await readFile(walPath, 'utf8')).toContain('approval-admission-generation_owner_2')
      }
      expect(session.isHealthy()).toBe(false)
    }
  })

  test('serializes WAL replacement through corpus acceptance across Stores sharing one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-order-')); roots.push(root)
    const walPath = join(root, 'owner.json'); const fx = fixture()
    const session = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: fx.environment, modulePath: import.meta.path,
        ownerGeneration: 'generation_owner_2', provenanceOperations: fx.operations } })!
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let accepts = 0
    const accept = session.accept.bind(session)
    session.accept = async (envelope: Parameters<typeof session.accept>[0], context?: unknown) => {
      accepts += 1
      if (accepts === 1) await blocked
      await accept(envelope, context)
    }
    const storeA = new HostedApprovalOwnerStore(
      new HostedApprovalOwnerWal(walPath, undefined, session.producer), Date.now, session,
    )
    const storeB = new HostedApprovalOwnerStore(
      new HostedApprovalOwnerWal(walPath, undefined, session.producer), Date.now, session,
    )
    let secondSettled = false
    const first = storeA.reconcileAdmission(admission('a'.repeat(64)))
    while (accepts === 0) await Bun.sleep(1)
    const second = storeB.reconcileAdmission(admission('b'.repeat(64))).then(() => { secondSettled = true })
    await Bun.sleep(10)
    expect(secondSettled).toBe(false)
    expect(JSON.parse(await readFile(walPath, 'utf8')).revision).toBe(1)
    release()
    await Promise.all([first, second])
    expect(accepts).toBe(2)
    const records = (await readFile(join(root, HOSTED_ACTUAL_OWNER_CORPUS_FILE), 'utf8')).trim().split('\n')
      .map(line => parseHostedActualOwnerNativePublication(Buffer.from(`${line}\n`)))
    expect(records.map(record => record.publication.receipt.revision)).toEqual([1, 2])
    await session.close()
  })

  test('reports every teardown failure while retaining the first irreversible poison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-live-close-')); roots.push(root)
    const walPath = join(root, 'owner.json'); const fx = fixture()
    const producerPoisonFailure = new Error('producer sync poisoned')
    const producerSyncFailure = new Error('producer cleanup sync failed')
    const producerCloseFailure = new Error('producer cleanup close failed')
    const corpusSyncFailure = new Error('corpus cleanup sync failed')
    const corpusCloseFailure = new Error('corpus cleanup close failed')
    let cleanup = false
    let poisonNextSync = false
    const attempts: string[] = []
    const session = HostedActualOwnerCaptureSession.open({ canonicalTeamRoot: root, walPath,
      configuration: { environment: fx.environment, modulePath: import.meta.path, ownerGeneration: 'generation_owner_2',
        provenanceOperations: { ...fx.operations,
          sync: fd => {
            if (poisonNextSync) { poisonNextSync = false; throw producerPoisonFailure }
            if (cleanup) { attempts.push('producer-sync'); throw producerSyncFailure }
            fx.operations.sync(fd)
          },
          close: fd => {
            attempts.push('producer-close')
            fx.operations.close(fd)
            if (cleanup) throw producerCloseFailure
          },
        },
        fileOperations: { open: openSync, write: (fd, bytes, offset) => writeSync(fd, bytes, offset, bytes.byteLength - offset),
          sync: fd => {
            if (cleanup) { attempts.push('corpus-sync'); throw corpusSyncFailure }
            fsyncSync(fd)
          },
          close: fd => {
            closeSync(fd)
            if (cleanup) { attempts.push('corpus-close'); throw corpusCloseFailure }
          } } } })!
    poisonNextSync = true
    const originalPoison = captureFailure(() => session.producer.syncSegment!())
    cleanup = true
    const failure = await session.close().catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure.message).toBe('hosted_actual_owner_capture_close_failed')
    expect(failure.errors).toHaveLength(5)
    expect(failure.errors[0]).toBe(originalPoison)
    expect(failure.errors[1]).toBe(producerSyncFailure)
    expect(failure.errors[2]).toBe(producerCloseFailure)
    expect(failure.errors[3]).toBe(corpusSyncFailure)
    expect(failure.errors[4]).toBe(corpusCloseFailure)
    expect(attempts).toEqual(['producer-sync', 'producer-close', 'corpus-sync', 'corpus-close'])
    expect(session.isHealthy()).toBe(false)
    expect(captureFailure(() => session.begin())).toBe(originalPoison)
  })
})

function captureFailure(operation: () => unknown): unknown {
  try { operation() } catch (error) { return error }
  throw new Error('expected operation to fail')
}
