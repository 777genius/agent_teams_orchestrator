import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  HostedActualOwnerNativeWriter,
  attestHostedActualOwnerWalOperationEnvelope,
  attestHostedActualOwnerWalOperationCompletion,
  buildHostedActualOwnerNativePublication,
  hostedActualOwnerStartToken,
  type HostedActualOwnerNativeWriteRequest,
} from './HostedActualOwnerNativeWriter.js'
import type { BoundWalPublication, OwnerWalPublicationProducer } from './HostedApprovalOwnerProvenance.js'
import { HostedApprovalOwnerWal } from './HostedApprovalOwnerWal.js'

const clock = (monotonicNs: string) => ({ wallTimeIso: '2026-09-19T12:00:00.000Z', monotonicNs })

async function input(previous: 'absent' | 'retained' = 'absent'): Promise<HostedActualOwnerNativeWriteRequest> {
  const root = await mkdtemp(join(tmpdir(), 'hosted-actual-owner-success-'))
  let operationCompletion: HostedActualOwnerNativeWriteRequest['operationCompletion']
  try {
    const path = join(root, 'owner.json')
    if (previous === 'retained') {
      const setup = new HostedApprovalOwnerWal(path)
      await setup.locked(current => setup.publish(current, proposedState('c'.repeat(64))))
    }
    const wal = new HostedApprovalOwnerWal(path, undefined, canonicalPublicationProducer().producer)
    const admission = admissionFixture('d'.repeat(64))
    operationCompletion = await attestHostedActualOwnerWalOperationCompletion(
      wal, proposedState(admission.digest), {
        operationNonce: '1'.repeat(64),
        mutation: { kind: 'admission-reconciled', outcome: 'published' }, admission,
      })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  const ownerStartToken = hostedActualOwnerStartToken({ pid: 123, startTicks: '456', exeDev: '8',
    exeIno: '9', exeSha256: '7'.repeat(64) })
  return {
    operationCompletion,
    owner: { ownerStartToken, ownerGeneration: 'generation_owner_2',
      predecessorOwnerStartToken: null, predecessorOwnerGeneration: null, replacementReason: 'initial' },
    requestClock: clock('1'), resultClock: clock('2'),
    lifecycle: {
      sync: { status: 'durable', clock: clock('3') },
      seal: { status: 'sealed', clock: clock('4') },
      revocation: { status: 'not-revoked', reason: null, clock: clock('5') },
    },
  }
}

function admissionFixture(digest: string) {
  return {
    schemaVersion: 1 as const, admissionGeneration: 'approval-admission-generation_2', digest,
    routes: [], actorMembers: {}, outerAuthority: {
      deploymentId: 'deployment_test', bootId: 'boot_test', workspaceId: 'workspace_test',
      teamId: `team_${'1'.repeat(32)}`, restoreGeneration: 1,
      mountBinding: { mountGeneration: 1, declaredRootHash: '0'.repeat(64) },
    },
    isCurrent: async () => true, prepareEffectToken: async () => null,
  }
}

function proposedState(digest: string) {
  return {
    schemaVersion: 3 as const, admissionGeneration: 'approval-admission-generation_2',
    admissionDigest: digest, routes: [], actorMembers: {}, ingress: [], retiredIngress: [],
    bindings: [], deliveries: [],
  }
}

function canonicalPublicationProducer(onEmit?: (publication: BoundWalPublication) => void) {
  let healthy = true
  const producer: OwnerWalPublicationProducer = {
    isHealthy: () => healthy,
    prepare(value) {
      return { emit: () => {
        const publication = {
          previous: value.previous, next: value.next, native: canonicalNative(value.native),
          emission: {
            stream: 'ownerWalTimeline', operationNonce: value.intent.operationNonce,
            emissionNonce: '2'.repeat(64), sequence: 7, lineSha256: '3'.repeat(64),
            activation: { controllerNonce: 'controller_nonce', runId: 'generation_owner_2',
              stackManifestSha256: '4'.repeat(64) },
            descriptor: { fd: 9, device: '20', inode: '21' },
            producer: {
              role: 'owner', implementationId: 'agent-teams.orchestrator.hosted-approval-owner.v1',
              artifactManifestSha256: '5'.repeat(64), moduleSha256: '6'.repeat(64),
              exeSha256: '7'.repeat(64), pid: 123, startTicks: '456', exeDev: '8', exeIno: '9',
            },
          },
        } satisfies BoundWalPublication
        onEmit?.(publication)
        return publication
      } }
    },
    poison(reason): never { healthy = false; throw new Error(reason) },
    close() { healthy = false },
  }
  return { producer, isHealthy: () => healthy }
}

function canonicalNative<T>(value: T): T {
  const canonical = (entry: any): any => Array.isArray(entry) ? entry.map(canonical) :
    entry && typeof entry === 'object' ? Object.fromEntries(Object.keys(entry).sort((a, b) =>
      Buffer.from(a).compare(Buffer.from(b))).map(key => [key, canonical(entry[key])])) : entry
  return JSON.parse(Buffer.from(JSON.stringify(canonical(value))).toString()) as T
}

describe('HostedActualOwnerNativeWriter', () => {
  test('rejects a frozen but non-runtime operation envelope', async () => {
    const request = await input()
    const forged = Object.freeze({ result: null, publications: Object.freeze([
      request.operationCompletion.result.publication,
    ]) })
    expect(() => attestHostedActualOwnerWalOperationEnvelope(forged)).toThrow(
      'hosted_actual_owner_operation_envelope_invalid',
    )
  })

  test('retains exact N and a writer-fence-bound proof for absent P', async () => {
    const request = await input()
    const record = buildHostedActualOwnerNativePublication(request)
    expect(Buffer.from(record.publication.final.base64, 'base64')).toEqual(
      Buffer.from(request.operationCompletion.result.publication.next.bytes))
    const fence = request.operationCompletion.result.publication.native.fence
    expect(record.publication.predecessor).toEqual({
      kind: 'absent', proof: { operationNonce: '1'.repeat(64), ownerGeneration: 'generation_owner_2',
        writerFence: fence },
    })
    expect(Object.keys(request.operationCompletion.result.publication.native.fence))
      .toEqual(['dev', 'generation', 'ino'])
    expect(Object.keys(record.publication.receipt.writerFence)).toEqual(['dev', 'generation', 'ino'])
    expect(record.publication.receipt.status).toBe('published')
    expect(record.operation.request.operationNonce).toBe(record.operation.result.operationNonce)
    expect(record.operation.result).toMatchObject({
      type: 'owner-wal-operation-completed', status: 'succeeded', cleanup: 'completed',
      publicationStatus: 'published',
    })
  })

  test('retains exact P and N and every process/activation pin', async () => {
    const base = await input('retained')
    const request: HostedActualOwnerNativeWriteRequest = { ...base,
      owner: { ...base.owner, replacementReason: 'process-replacement',
      predecessorOwnerStartToken: `owner-start_${'8'.repeat(64)}`,
      predecessorOwnerGeneration: 'generation_owner_1' } }
    const record = buildHostedActualOwnerNativePublication(request)
    expect(record.publication.predecessor.kind).toBe('retained')
    if (record.publication.predecessor.kind === 'retained') {
      expect(Buffer.from(record.publication.predecessor.image.base64, 'base64')).toEqual(
      Buffer.from(request.operationCompletion.result.publication.previous.kind === 'retained'
        ? request.operationCompletion.result.publication.previous.image.bytes : []))
    }
    expect(record.owner.predecessorOwnerGeneration).toBe('generation_owner_1')
    expect(record.pins).toMatchObject({ producerPid: 123, producerStartTicks: '456',
      activationRunId: 'generation_owner_2', streamDevice: '20', streamInode: '21' })
  })

  test('writes exactly one canonical bounded line and seals locally', async () => {
    const accepted: Uint8Array[] = []
    const writer = new HostedActualOwnerNativeWriter({ append: bytes => accepted.push(Uint8Array.from(bytes)) })
    const request = await input()
    const record = writer.write(request)
    expect(Buffer.from(accepted[0]!).toString()).toBe(`${JSON.stringify(record)}\n`)
    writer.seal()
    expect(() => writer.write(request)).toThrow('writer_sealed')
  })

  test('rejects identity, lineage, and clock weakening before sink I/O', async () => {
    const cases = [
      (v: any) => { v.owner.ownerStartToken = `owner-start_${'0'.repeat(64)}` },
      (v: any) => { v.owner.predecessorOwnerGeneration = 'generation_old' },
      (v: any) => { v.resultClock = clock('0') },
    ]
    for (const mutate of cases) {
      let called = false
      const writer = new HostedActualOwnerNativeWriter({ append: () => { called = true } })
      const value: any = await input()
      mutate(value)
      expect(() => writer.write(value)).toThrow()
      expect(called).toBe(false)
    }
  })

  test('cannot attest or publish a receipt leaked before outer WAL cleanup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-actual-owner-cleanup-'))
    try {
      let leaked: BoundWalPublication | undefined
      const capture = canonicalPublicationProducer(publication => { leaked = publication })
      const wal = new HostedApprovalOwnerWal(join(root, 'owner.json'), {
        releaseWriterResource: async (resource, release) => {
          await release()
          if (resource === 'parent') throw new Error('forced outer cleanup failure')
        },
      }, capture.producer)
      const admission = admissionFixture('d'.repeat(64))
      let failure: unknown
      try {
        await attestHostedActualOwnerWalOperationCompletion(wal, proposedState(admission.digest), {
          operationNonce: '1'.repeat(64),
          mutation: { kind: 'admission-reconciled', outcome: 'published' }, admission,
        })
      } catch (error) { failure = error }
      expect(failure).toMatchObject({ message: 'Hosted approval writer cleanup failed' })
      const aggregate = failure instanceof AggregateError ? failure : (failure as Error).cause as AggregateError
      expect(aggregate.errors[0])
        .toMatchObject({ message: 'forced outer cleanup failure' })
      expect(leaked).toMatchObject({ emission: { operationNonce: '1'.repeat(64) } })
      expect(capture.isHealthy()).toBe(false)

      const accepted: Uint8Array[] = []
      const request: any = await input()
      request.operationCompletion = leaked
      expect(() => new HostedActualOwnerNativeWriter({ append: bytes => accepted.push(bytes) }).write(request))
        .toThrow('operation_completion_invalid')
      expect(accepted).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

export const hostedActualOwnerTestInput = input
