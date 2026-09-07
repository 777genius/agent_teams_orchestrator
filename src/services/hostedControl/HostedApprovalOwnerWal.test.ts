import { afterEach, describe, expect, test } from 'bun:test'
import { dlopen, FFIType } from 'bun:ffi'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  decodeOwnerState, HostedApprovalOwnerPublicationError, HostedApprovalOwnerWal, parseOwnerStateSource, type HostedApprovalOwnerState,
} from './HostedApprovalOwnerWal.js'
import {
  createOwnerWalPublicationProducerFromEnvironment,
  createOwnerProvenanceNodeOperations,
  HOSTED_OWNER_PROVENANCE_CONTRACT,
  HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
  HOSTED_OWNER_PROVENANCE_IMPLEMENTATION,
  type BoundWalPublication,
  type OwnerWalNative,
  type PreviousWalImage,
  type RetainedWalImage,
  type OwnerWalPublicationProducer,
  type OwnerWalInitialDeliveryWitness,
} from './HostedApprovalOwnerProvenance.js'
import { fingerprintHostedApprovalDelivery, type HostedApprovalIngressRecord } from './HostedApprovalWire.js'
import {
  createRegularNodeAtDarwin, type DarwinSpawnNative,
} from './HostedApprovalOwnerWalDarwin.internal.js'
import { HostedApprovalOwnerStore } from './HostedApprovalOwnerStore.js'
import type { HostedApprovalRuntimeAdmission, HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'

const teamId = `team_${'1'.repeat(32)}`
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const route: HostedApprovalRuntimeRoute = {
  routeId: 'route_1', memberName: 'worker',
  authority: {
    deploymentId: 'deployment_test', teamId, runId: `run_${'2'.repeat(32)}`,
    planGeneration: 2, laneId: 'secondary:opencode:worker', providerId: 'opencode',
    credentialGeneration: 3, credentialId: 'credential_1', sessionId: 'session_1',
    runtimeInstanceId: 'runtime_1', deliveryOwnerId: `member_${'4'.repeat(32)}`,
  },
  scope: {
    principalId: 'actor_owner', workspaceId: `workspace_${'3'.repeat(32)}`, teamId,
    authorityGeneration: 'generation_1', restoreGeneration: 1,
  },
  openCodeBinding: {
    toolApprovalMode: 'manual',
    planGeneration: 2, credentialGeneration: 3, credentialId: 'credential_1',
    runtimeInstanceId: 'runtime_1', deliveryOwnerId: `member_${'4'.repeat(32)}`,
    openCodeArtifactDigest: `sha256:${'c'.repeat(64)}`,
    sessionRecordFingerprint: 'a'.repeat(64),
    liveEffectFingerprint: 'b'.repeat(64),
  },
}

describe('decodeOwnerState R2 adversarial persistence', () => {
  test('deep-decodes exact route authority and explicit actor-to-owner cross-binding', () => {
    expect(decodeOwnerState(state())).toMatchObject({ routes: [{ routeId: 'route_1' }] })
    const extra = state(); (extra.routes[0]!.authority as unknown as Record<string, unknown>).extra = true
    expect(() => decodeOwnerState(extra)).toThrow('keys')
    const substituted = state(); substituted.actorMembers.actor_owner = `member_${'9'.repeat(32)}`
    expect(() => decodeOwnerState(substituted)).toThrow('route binding')
  })

  test('rejects missing or malformed persisted OpenCode artifact bindings', () => {
    const missing = state() as unknown as { routes: Array<{ openCodeBinding: Record<string, unknown> }> }
    delete missing.routes[0]!.openCodeBinding.openCodeArtifactDigest
    expect(() => decodeOwnerState(missing)).toThrow('WAL OpenCode binding keys')

    const malformed = state()
    malformed.routes[0]!.openCodeBinding.openCodeArtifactDigest = `sha256:${'C'.repeat(64)}`
    expect(() => decodeOwnerState(malformed)).toThrow('WAL route binding')
  })

  test('rejects ingress authority, payload, acknowledgement, and delivery substitutions', () => {
    const authority = state(); authority.ingress[0]!.authority.planGeneration += 1
    expect(() => decodeOwnerState(authority)).toThrow('ingress binding')
    const payload = state(); const body = JSON.parse(payload.ingress[0]!.payloadJson); body.deliveryRef = 'delivery_ref_substituted'; payload.ingress[0]!.payloadJson = JSON.stringify(body)
    expect(() => decodeOwnerState(payload)).toThrow('ingress payload')
    const encodedHostPath = state(); const encodedBody = JSON.parse(encodedHostPath.ingress[0]!.payloadJson); encodedBody.summary = 'inspect %252e%252e%255cprivate%255ckey'; encodedHostPath.ingress[0]!.payloadJson = JSON.stringify(encodedBody)
    expect(() => decodeOwnerState(encodedHostPath)).toThrow('ingress payload')
    for (const summary of [
      'prefix% %2e%2e%2fprivate%2fkey',
      'inspect %25252e%25252e%25252fprivate%25252fkey',
      'inspect %255c%255c%253f%255cC%253a%255cprivate%255ckey',
    ]) {
      const hostile = state(); const hostileBody = JSON.parse(hostile.ingress[0]!.payloadJson); hostileBody.summary = summary; hostile.ingress[0]!.payloadJson = JSON.stringify(hostileBody)
      expect(() => decodeOwnerState(hostile)).toThrow('ingress payload')
    }
    const acknowledgement = state(); acknowledgement.ingress[0]!.acknowledgedAtIso = '2026-08-13T09:59:00.000Z'; acknowledgement.ingress[0]!.lease = { generation: 1, ownerId: 'owner_1', leaseToken: 'lease_1', claimedAtIso: '2026-08-13T10:00:01.000Z', leaseExpiresAtIso: '2026-08-13T10:00:02.000Z' }
    expect(() => decodeOwnerState(acknowledgement)).toThrow('acknowledgement')
    const delivery = state(); delivery.deliveries = [{ providerDeliveryId: 'delivery_1', reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`, deliveryRef: 'delivery_ref_wrong', payloadFingerprint: 'f'.repeat(64), outboxId: delivery.ingress[0]!.outboxId, effectRef: delivery.ingress[0]!.effectRef, phase: 'started', result: null }]
    expect(() => decodeOwnerState(delivery)).toThrow('delivery binding')

    const halfLegacyBinding = state()
    halfLegacyBinding.bindings[0] = {
      ...halfLegacyBinding.bindings[0]!, effectRef: null, quarantined: true,
    }
    expect(() => decodeOwnerState(halfLegacyBinding)).toThrow('private binding')
  })

  test('rejects malformed UTF-8 and duplicate nested persisted keys', () => {
    expect(() => parseOwnerStateSource(Uint8Array.from([0x7b, 0xff, 0x7d]))).toThrow()
    const duplicate = JSON.stringify(state()).replace('"routeId":"route_1"', '"routeId":"route_1","routeId":"route_substituted"')
    expect(() => parseOwnerStateSource(Buffer.from(duplicate))).toThrow('JSON')
  })

  test('migrates exact legacy v1 state-only, revoking routes and retaining referenced evidence', () => {
    const current = state()
    const referenced = current.ingress[0]!
    const unreferenced = structuredClone(referenced)
    unreferenced.outboxId = `runtime_permission:effect:${'d'.repeat(64)}`
    unreferenced.effectRef = `effect:${'d'.repeat(64)}`
    unreferenced.deliveryRef = 'delivery_ref_unreferenced'
    unreferenced.commandId = 'permission_unreferenced'
    const payload = JSON.parse(unreferenced.payloadJson)
    payload.deliveryRef = unreferenced.deliveryRef
    unreferenced.payloadJson = JSON.stringify(payload)
    const legacy = structuredClone(current) as unknown as {
      schemaVersion: number
      routes: Array<{ openCodeBinding: Record<string, unknown> }>
      ingress: typeof current.ingress
      deliveries: HostedApprovalOwnerState['deliveries']
      bindings?: HostedApprovalOwnerState['bindings']
    }
    legacy.schemaVersion = 1
    delete legacy.bindings
    delete legacy.routes[0].openCodeBinding.openCodeArtifactDigest
    legacy.ingress.push(unreferenced)
    for (const record of legacy.ingress) {
      ;(record as { outboxVersion: number }).outboxVersion = 1
      record.outboxId = `runtime_permission:${record.effectRef}`
    }
    const legacyReferenced = legacy.ingress[0]!
    legacy.deliveries = [{
      providerDeliveryId: 'delivery_legacy',
      reconciliationRef: 'approval-reconciliation_legacy',
      deliveryRef: legacyReferenced.deliveryRef,
      payloadFingerprint: 'f'.repeat(64),
      outboxId: legacyReferenced.outboxId,
      effectRef: legacyReferenced.effectRef,
      phase: 'started',
      result: null,
    }]
    const migrated = decodeOwnerState(legacy)
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      routes: [],
      actorMembers: {},
      ingress: [],
      retiredIngress: [{ outboxId: legacyReferenced.outboxId }],
      deliveries: [{ providerDeliveryId: 'delivery_legacy', phase: 'started' }],
    })
    const priorSchema2Migration = structuredClone(migrated) as unknown as Record<string, unknown>
    priorSchema2Migration.schemaVersion = 2
    delete priorSchema2Migration.bindings
    expect(decodeOwnerState(priorSchema2Migration)).toMatchObject({
      schemaVersion: 3, retiredIngress: [{ outboxId: legacyReferenced.outboxId }],
      deliveries: [{ providerDeliveryId: 'delivery_legacy', phase: 'started' }],
    })
  })

  test('migrates schema2 composite hashes without relabeling them as permission digests', () => {
    const old = structuredClone(state()) as unknown as Record<string, unknown> & {
      ingress: HostedApprovalOwnerState['ingress']; bindings?: HostedApprovalOwnerState['bindings']
      deliveries: HostedApprovalOwnerState['deliveries']
    }
    old.schemaVersion = 2
    delete old.bindings
    const ingress = old.ingress[0]!
    ;(ingress as { outboxVersion: number }).outboxVersion = 1
    ingress.outboxId = `runtime_permission:${ingress.effectRef}`
    old.deliveries = [{
      providerDeliveryId: 'delivery_schema2', reconciliationRef: 'approval-reconciliation_schema2',
      deliveryRef: ingress.deliveryRef, payloadFingerprint: 'f'.repeat(64), outboxId: ingress.outboxId,
      effectRef: ingress.effectRef, phase: 'completed', result: 'delivered',
    }]
    const migrated = decodeOwnerState(old)
    expect(migrated).toMatchObject({
      schemaVersion: 3, routes: [], ingress: [],
      retiredIngress: [{ outboxId: ingress.outboxId, effectRef: ingress.effectRef }],
      bindings: [{ requestId: ingress.commandId, effectRef: null, bindingDigest: null, quarantined: true }],
      deliveries: [{ phase: 'completed', result: 'delivered' }],
    })
  })

  test('recovers retired schema2 evidence by its old authority and accepts its own migration output', () => {
    const old = structuredClone(state()) as unknown as Record<string, unknown> & {
      routes: HostedApprovalRuntimeRoute[]; ingress: HostedApprovalOwnerState['ingress']
      retiredIngress: HostedApprovalOwnerState['retiredIngress']; bindings?: HostedApprovalOwnerState['bindings']
      deliveries: HostedApprovalOwnerState['deliveries']
    }
    old.schemaVersion = 2
    delete old.bindings
    const record = old.ingress.pop()!
    ;(record as { outboxVersion: number }).outboxVersion = 1
    record.outboxId = `runtime_permission:${record.effectRef}`
    old.retiredIngress = [record]
    old.deliveries = [{
      providerDeliveryId: 'delivery_retired', reconciliationRef: 'approval-reconciliation_retired',
      deliveryRef: record.deliveryRef, payloadFingerprint: 'f'.repeat(64), outboxId: record.outboxId,
      effectRef: record.effectRef, phase: 'started', result: null,
    }]
    old.routes[0]!.authority.credentialGeneration += 1
    old.routes[0]!.authority.credentialId = 'credential_rotated'
    old.routes[0]!.openCodeBinding.credentialGeneration += 1
    old.routes[0]!.openCodeBinding.credentialId = 'credential_rotated'

    const migrated = decodeOwnerState(old)
    expect(migrated).toMatchObject({
      schemaVersion: 3, routes: [], ingress: [],
      retiredIngress: [{ outboxId: record.outboxId, authority: record.authority }],
      deliveries: [{ phase: 'started', result: null }],
    })
    expect(decodeOwnerState(structuredClone(migrated))).toEqual(migrated)
  })

  test('rejects schema2 duplicate routes and v2 ingress before migration', () => {
    const duplicate = structuredClone(state()) as unknown as Record<string, unknown> & {
      routes: HostedApprovalRuntimeRoute[]; ingress: HostedApprovalOwnerState['ingress']
      bindings?: HostedApprovalOwnerState['bindings']
    }
    duplicate.schemaVersion = 2
    delete duplicate.bindings
    ;(duplicate.ingress[0] as { outboxVersion: number }).outboxVersion = 1
    duplicate.ingress[0]!.outboxId = `runtime_permission:${duplicate.ingress[0]!.effectRef}`
    duplicate.routes.push(structuredClone(duplicate.routes[0]!))
    expect(() => decodeOwnerState(duplicate)).toThrow('schema2 route identity')
    duplicate.routes[1]!.routeId = 'route_2'
    expect(() => decodeOwnerState(duplicate)).toThrow('schema2 route identity')

    const masquerading = structuredClone(state()) as unknown as Record<string, unknown> & {
      bindings?: HostedApprovalOwnerState['bindings']
    }
    masquerading.schemaVersion = 2
    delete masquerading.bindings
    expect(() => decodeOwnerState(masquerading)).toThrow('legacy ingress')
  })

  test('enforces legacy tombstones, private-B ownership, and the complete v2 outbox prefix', () => {
    const tombstone = state()
    tombstone.bindings.push({
      teamId: tombstone.bindings[0]!.teamId, runId: tombstone.bindings[0]!.runId,
      requestId: tombstone.bindings[0]!.requestId,
      effectRef: null, bindingDigest: null, quarantined: true,
    })
    expect(() => decodeOwnerState(tombstone)).toThrow('identity')

    const reused = state()
    reused.bindings.push({
      teamId: reused.bindings[0]!.teamId, runId: `run_${'9'.repeat(32)}`, requestId: 'permission_other',
      effectRef: `effect:${'d'.repeat(64)}`, bindingDigest: reused.bindings[0]!.bindingDigest,
      quarantined: false,
    })
    expect(() => decodeOwnerState(reused)).toThrow('identity')

    const distinct = state()
    distinct.bindings.push({
      teamId: distinct.bindings[0]!.teamId, runId: `run_${'9'.repeat(32)}`, requestId: 'permission_other',
      effectRef: distinct.bindings[0]!.effectRef, bindingDigest: 'd'.repeat(64), quarantined: false,
    })
    expect(decodeOwnerState(distinct).bindings).toHaveLength(2)

    const junkPrefix = state()
    junkPrefix.ingress[0]!.outboxId = `${'x'.repeat('runtime_permission:effect:'.length)}${'b'.repeat(64)}`
    expect(() => decodeOwnerState(junkPrefix)).toThrow('ingress binding')
  })
})

describe('HostedApprovalOwnerWal R3 shared writer fence', () => {
  test('binds exact absent P and durable N only after the real WAL replacement', async () => {
    const { path } = await walPath()
    const capture = publicationCapture(path)
    const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const admission = admissionFixture()
    const result = await new HostedApprovalOwnerStore(wal).reconcileAdmission(admission)
    const prepared = capture.prepared!
    const durable = await readFile(path)
    expect(prepared?.previous).toEqual({ kind: 'absent' })
    expect(Buffer.from(prepared!.next.bytes)).toEqual(durable)
    expect(prepared!.native.stateDelta.changedFields).toEqual([
      'actorMembers', 'admissionDigest', 'admissionGeneration', 'bindings', 'deliveries', 'ingress',
      'retiredIngress', 'revision', 'routes', 'schemaVersion', 'writerFence',
    ])
    expect(prepared!.native.stateDelta.collectionSizes).toEqual({
      actorMembers: { previous: 0, next: Object.keys(admission.actorMembers).length },
      bindings: { previous: 0, next: 0 },
      deliveries: { previous: 0, next: 0 },
      ingress: { previous: 0, next: 0 },
      retiredIngress: { previous: 0, next: 0 },
      routes: { previous: 0, next: admission.routes.length },
    })
    expect(result).toMatchObject({ revision: 1, admissionDigest: admission.digest,
      admissionGeneration: admission.admissionGeneration, routes: admission.routes, actorMembers: admission.actorMembers,
      ingress: [], retiredIngress: [], bindings: [], deliveries: [] })
    expect(capture.bound!.next.sha256).toBe(prepared.native.wal.sha256)
    expect(capture.bound!.native.fence).toEqual(result.writerFence)
    capture.assertBound()
  })

  test('rejects invented ingress and bindings in absent or migrated admission publications', async () => {
    for (const predecessor of ['absent', 'legacy'] as const) {
      const { path } = await walPath()
      let oldBytes: Buffer | null = null
      if (predecessor === 'legacy') {
        const setup = new HostedApprovalOwnerWal(path)
        const initial = await new HostedApprovalOwnerStore(setup).reconcileAdmission(admissionFixture())
        const legacy = { ...initial, schemaVersion: 2, routes: [], actorMembers: {} } as Record<string, unknown>
        delete legacy.bindings
        oldBytes = Buffer.from(` ${JSON.stringify(legacy)}\n`)
        await writeFile(path, oldBytes, { mode: 0o600 })
      }
      let prepares = 0
      const producer: OwnerWalPublicationProducer = {
        isHealthy: () => true,
        prepare() { prepares += 1; throw new Error('invalid witness reached capture') },
        poison(reason): never { throw new Error(reason) }, close() {},
      }
      const wal = new HostedApprovalOwnerWal(path, undefined, producer)
      await expect(wal.locked(current => wal.publishMutation(current, withoutRevision(state()), {
        operationNonce: 'e'.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' },
        admission: admissionFixture(),
      }))).rejects.toMatchObject({ stage: 'definitely-not-replaced',
        message: 'Hosted approval admission publication witness mismatch' })
      expect(prepares).toBe(0)
      if (oldBytes) expect(await readFile(path)).toEqual(oldBytes)
      else expect(existsSync(path)).toBe(false)
    }
  })

  test('retains old raw P separately from migrated M and reconciled N', async () => {
    const { path } = await walPath()
    const setupWal = new HostedApprovalOwnerWal(path)
    const current = await setupWal.locked(value => setupWal.publish(value, withoutRevision(state())))
    const legacy = structuredClone(current) as unknown as Record<string, unknown>
    legacy.schemaVersion = 2; legacy.routes = []; legacy.actorMembers = {}; legacy.ingress = []
    delete legacy.bindings
    const oldBytes = Buffer.from(` ${JSON.stringify(legacy)}\n`)
    await writeFile(path, oldBytes, { mode: 0o600 })
    const capture = publicationCapture(path)
    const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const migratedState = await wal.read()
    const result = await new HostedApprovalOwnerStore(wal).reconcileAdmission(admissionFixture())
    const captured = capture.prepared!
    expect(result).toMatchObject({ revision: current.revision + 1, routes: current.routes,
      actorMembers: current.actorMembers, ingress: [], retiredIngress: [], bindings: [], deliveries: [] })
    expect(migratedState).toMatchObject({ routes: [], actorMembers: {}, ingress: [] })
    expect(Buffer.from(captured.next.bytes)).not.toEqual(oldBytes)
    capture.assertBound()
    expect(migratedState).toMatchObject({ schemaVersion: 3, revision: current.revision, bindings: [] })
    expect(captured?.previous.kind).toBe('retained')
    if (captured?.previous.kind !== 'retained') throw new Error('missing retained predecessor')
    expect(Buffer.from(captured.previous.image.bytes)).toEqual(oldBytes)
    expect(captured.native.stateDelta.previousStateSha256).toBe(createHash('sha256').update(oldBytes).digest('hex'))
    expect(captured.native.stateDelta.previousRevision).toBe(current.revision)
    expect(captured.native.stateDelta.changedFields).toContain('bindings')
    expect(Buffer.from(captured.next.bytes)).toEqual(await readFile(path))
  })

  test('retains exact P while Store reconciliation publishes actually compacted N', async () => {
    const { path } = await walPath()
    const setupWal = new HostedApprovalOwnerWal(path)
    const initial = await new HostedApprovalOwnerStore(setupWal).reconcileAdmission(admissionFixture())
    const base = state().ingress[0]!
    const records = Array.from({ length: 2_050 }, (_, index) => {
      const digest = index.toString(16).padStart(64, '0')
      const deliveryRef = `delivery_ref_opencode-${digest}`
      return { ...structuredClone(base), commandId: `permission_${index}`,
        effectRef: `effect:${digest}`, outboxId: `runtime_permission:effect:${digest}`, deliveryRef,
        payloadJson: JSON.stringify({ ...JSON.parse(base.payloadJson), deliveryRef }),
        lease: { generation: 1, ownerId: 'owner_terminal', leaseToken: `lease_${index}`,
          claimedAtIso: '2026-08-13T10:00:01.000Z', leaseExpiresAtIso: '2026-08-13T10:00:03.000Z' },
        acknowledgedAtIso: '2026-08-13T10:00:02.000Z' }
    })
    const previous = { ...initial, ingress: records, bindings: records.map(record => ({
      teamId, runId: route.authority.runId, requestId: record.commandId,
      effectRef: record.effectRef, bindingDigest: record.outboxId.slice('runtime_permission:effect:'.length), quarantined: false,
    })) }
    // Retention runs on publication, not load: seed an exact valid older image.
    expect(decodeOwnerState(previous).ingress).toHaveLength(2_050)
    const oldBytes = Buffer.from(` ${JSON.stringify(previous)}\n`)
    await writeFile(path, oldBytes, { mode: 0o600 })
    const capture = publicationCapture(path)
    const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const result = await new HostedApprovalOwnerStore(wal).reconcileAdmission({ ...admissionFixture(), digest: 'd'.repeat(64) })
    expect(result.ingress).toEqual(records.slice(2))
    expect(result.bindings).toEqual(previous.bindings)
    expect(result.revision).toBe(initial.revision + 1)
    expect(capture.prepared!.native.stateDelta.collectionSizes.ingress).toEqual({ previous: 2_050, next: 2_048 })
    expect(capture.prepared!.native.stateDelta.previousStateSha256).toBe(createHash('sha256').update(oldBytes).digest('hex'))
    const retained = capture.bound!.previous
    expect(retained.kind).toBe('retained')
    if (retained.kind !== 'retained') throw new Error('missing retained predecessor')
    expect(Buffer.from(retained.image.bytes)).toEqual(oldBytes)
    capture.assertBound()
  })

  // The concrete implementation reads Linux /proc descriptor flags. Other
  // platforms must not stand in for that path with fabricated syscall results.
  test.skipIf(process.platform !== 'linux')('admits only 00600 through real descriptor inspection and producer startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owner-native-descriptor-mode-'))
    roots.push(root)
    const operations = createOwnerProvenanceNodeOperations()
    const modulePath = resolve(import.meta.dir, 'HostedApprovalOwnerProvenance.ts')
    const identity = operations.identity(modulePath)
    for (const mode of [0o0600, 0o4600, 0o2600, 0o1600, 0o6600, 0o7600, 0o0640, 0o0700]) {
      const path = join(root, `capture-${mode.toString(8)}.ndjson`)
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | constants.O_WRONLY, 0o600)
      let closed = false
      try {
        // The pinned Bun gate did not retain special bits after fchmodSync.
        // Use fixed-arity libc fchmod, then inspect the actual fd through both
        // fstat and the production /proc descriptor projection.
        const native = dlopen('libc.so.6', { fchmod: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 } })
        try { expect(native.symbols.fchmod(fd, mode)).toBe(0) } finally { native.close() }
        expect(Number(fstatSync(fd, { bigint: true }).mode & 0o7777n)).toBe(mode)
        const descriptor = operations.descriptor(fd)
        expect(descriptor.mode).toBe(mode)
        const capsule = JSON.stringify({ activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
          contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
          expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: identity.exeSha256,
            implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: identity.moduleSha256 },
          producerRole: 'owner', streams: { ownerWalTimeline: { device: descriptor.device, fd: 9, inode: descriptor.inode } }, version: 2 })
        const mappedFd = (requested: number) => { expect(requested).toBe(9); return fd }
        const create = () => createOwnerWalPublicationProducerFromEnvironment({
          environment: { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: capsule }, modulePath,
          imageCustodian: { prepare: () => { throw new Error('no WAL publication in descriptor admission test') } },
          // Remap only the descriptor number; every observation/write/sync/close
          // still uses the concrete operations on this test's owned file.
          operations: { ...operations,
            descriptor: requested => operations.descriptor(mappedFd(requested)),
            write: (requested, bytes, offset) => operations.write(mappedFd(requested), bytes, offset),
            sync: requested => operations.sync(mappedFd(requested)),
            close: requested => { operations.close(mappedFd(requested)); closed = true },
          },
        })
        if (mode === 0o600) {
          const producer = create()
          expect(producer).not.toBeNull()
          producer!.close()
          const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
          expect(lines.map(line => line.recordType)).toEqual(['producer-open', 'producer-close'])
          expect(lines[0].native.descriptor).toEqual({ device: descriptor.device, fd: 9, inode: descriptor.inode })
        } else {
          expect(create).toThrow('owner-provenance-descriptor-identity')
          expect(await readFile(path, 'utf8')).toBe('')
        }
        expect(closed).toBe(true)
      } finally { if (!closed) closeSync(fd) }
    }
  })

  test('serializes one canonical native fact with controlled partial descriptor writes', () => {
    const chunks: Buffer[] = []; let nonce = 0
    const capsule = JSON.stringify({ activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
      contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: '4'.repeat(64), implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: '5'.repeat(64) },
      producerRole: 'owner', streams: { ownerWalTimeline: { device: '7', fd: 9, inode: '8' } }, version: 2 })
    const producer = createOwnerWalPublicationProducerFromEnvironment({
      environment: { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: capsule }, modulePath: '/unused',
      imageCustodian: { prepare: (previous, next) => ({ bind: () => ({ previous, next }) }) },
      operations: {
        identity: () => ({ pid: process.pid, startTicks: '9', exeDev: '10', exeIno: '11', exeSha256: '4'.repeat(64), moduleSha256: '5'.repeat(64) }),
        descriptor: () => ({ device: '7', inode: '8', regular: true, append: true, writeOnly: true, mode: 0o600, nlink: '1', size: '0' }),
        nonce: () => (++nonce).toString(16).padStart(64, '0'),
        write: (_fd, bytes, offset) => { const count = Math.min(17, bytes.byteLength - offset); chunks.push(Buffer.from(bytes.subarray(offset, offset + count))); return count },
        sync: () => {}, close: () => {},
      },
    })!
    const bytes = Buffer.from('{}\n'); const hash = createHash('sha256').update(bytes).digest('hex')
    const native: OwnerWalNative = { fence: { generation: `approval-writer-fence_${'a'.repeat(32)}`, dev: '1', ino: '2' },
      mutation: { kind: 'admission-reconciled', outcome: 'published' }, revision: 1,
      stateDelta: { changedFields: ['actorMembers', 'admissionDigest', 'admissionGeneration', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'revision', 'routes', 'schemaVersion', 'writerFence'],
        collectionSizes: Object.fromEntries(['actorMembers', 'bindings', 'deliveries', 'ingress', 'retiredIngress', 'routes'].map(key => [key, { previous: 0, next: 0 }])) as OwnerWalNative['stateDelta']['collectionSizes'],
        nextRevision: 1, nextStateSha256: hash, previousRevision: null, previousStateSha256: null }, wal: { byteSize: bytes.length, sha256: hash } }
    producer.prepare({ intent: { operationNonce: 'a'.repeat(64), mutation: native.mutation, admission: {} as HostedApprovalRuntimeAdmission }, native,
      previous: { kind: 'absent' }, next: { byteSize: bytes.length, sha256: hash, bytes } }).emit()
    const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.recordType)).toEqual(['producer-open', 'owner-wal-published'])
    expect(lines[1].previousRecordSha256).toBe(createHash('sha256').update(`${JSON.stringify(lines[0])}\n`).digest('hex'))
  })

  test('cleanup close failure after directory sync preserves replacement uncertainty and poisons capture', async () => {
    const { path } = await walPath(); const capture = publicationCapture(path)
    let closed = false
    const wal = new HostedApprovalOwnerWal(path, { closeWalTemp(fd) {
      closeSync(fd); closed = true; throw new Error('temporary descriptor close failed')
    } }, capture.producer)
    const store = new HostedApprovalOwnerStore(wal)
    await expect(store.reconcileAdmission(admissionFixture())).rejects.toMatchObject({ stage: 'replacement-uncertain' })
    expect(closed).toBe(true)
    const durable = await readFile(path)
    expect(JSON.parse(durable.toString()).revision).toBe(1)
    expect(capture.lines.map(line => line.recordType)).toEqual(['producer-open'])
    expect(wal.isPublicationCaptureCurrent()).toBe(false)
    await wal.locked(async current => { expect(await wal.prepareEffectToken(current!)).toBeNull() })
    expect(await readFile(path)).toEqual(durable)
  })

  test('byte-identical predecessor inode substitution fails CAS without emitting or replacing it', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const bytes = await readFile(path); const initialInode = (await lstat(path)).ino
    let replacementInode = 0
    await expect(wal.locked(async current => {
      await writeFile(`${path}.replacement`, bytes, { mode: 0o600 })
      await rename(`${path}.replacement`, path)
      replacementInode = (await lstat(path)).ino
      return wal.publishMutation(current, { ...withoutRevision(current!), admissionDigest: 'd'.repeat(64) }, {
        operationNonce: 'e'.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' },
        admission: { ...admissionFixture(), digest: 'd'.repeat(64) },
      })
    })).rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval WAL compare-and-swap conflict' })
    expect(replacementInode).not.toBe(initialInode)
    expect((await lstat(path)).ino).toBe(replacementInode)
    expect(await readFile(path)).toEqual(bytes)
    expect(capture.prepared).toBeUndefined()
    expect(capture.lines).toHaveLength(1)
    capture.producer.close()
  })

  test('advances predecessor inode and raw P for two native publications within one lock', async () => {
    const { path } = await walPath(); const capture = publicationCapture(path)
    const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const admission = admissionFixture()
    await wal.locked(async current => {
      const first = await wal.publishMutation(current, {
        ...withoutRevision(state()), ingress: [], bindings: [],
      }, { operationNonce: 'a'.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' }, admission })
      const firstBytes = await readFile(path); const firstInode = (await lstat(path)).ino
      const second = await wal.publishMutation(first.state, { ...withoutRevision(first.state), admissionDigest: 'd'.repeat(64) }, {
        operationNonce: 'b'.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' },
        admission: { ...admission, digest: 'd'.repeat(64) },
      })
      expect(second.state.revision).toBe(2)
      expect((await lstat(path)).ino).not.toBe(firstInode)
      expect(capture.bound!.previous.kind).toBe('retained')
      if (capture.bound!.previous.kind === 'retained') expect(Buffer.from(capture.bound!.previous.image.bytes)).toEqual(firstBytes)
    })
    expect(capture.lines.map(line => line.recordType)).toEqual(['producer-open', 'owner-wal-published', 'owner-wal-published'])
    expect(capture.lines[2].previousRecordSha256).toBe(createHash('sha256').update(`${JSON.stringify(capture.lines[1])}\n`).digest('hex'))
    capture.producer.close()
  })

  test('custody and caller byte aliases cannot alter either bound retained preimage', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const previousBytes = await readFile(path)
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    await new HostedApprovalOwnerStore(wal).reconcileAdmission({ ...admissionFixture(), digest: 'd'.repeat(64) })
    const bound = capture.bound!; const custody = capture.custody!
    const nextBytes = await readFile(path)
    expect(bound.next).not.toBe(custody.next)
    expect(bound.next).not.toBe(custody.returned.next)
    for (const image of [custody.next, custody.returned.next, bound.next]) image.bytes.fill(0)
    for (const previous of [custody.previous, custody.returned.previous, bound.previous]) {
      if (previous.kind !== 'retained') throw new Error('missing P')
      previous.image.bytes.fill(0)
    }
    expect(Buffer.from(bound.next.bytes)).toEqual(nextBytes)
    if (bound.previous.kind !== 'retained') throw new Error('missing bound P')
    expect(Buffer.from(bound.previous.image.bytes)).toEqual(previousBytes)
    expect(bound.next.sha256).toBe(createHash('sha256').update(bound.next.bytes).digest('hex'))
    expect(bound.previous.image.sha256).toBe(createHash('sha256').update(bound.previous.image.bytes).digest('hex'))
    expect(bound.emission.lineSha256).toBe(createHash('sha256').update(`${JSON.stringify(capture.lines[1])}\n`).digest('hex'))
    capture.producer.close()
  })

  test('postpublication admission false and rejection both revoke capture and outstanding effect tokens', async () => {
    for (const failure of ['false', 'throw'] as const) {
      const { path } = await walPath(); const capture = publicationCapture(path)
      const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      let probes = 0; let token: { consume(): boolean } | null = null
      const admission: HostedApprovalRuntimeAdmission = { ...admissionFixture(), isCurrent: async () => {
        if (++probes !== 3) return true
        token = await wal.prepareEffectToken((await wal.read())!)
        if (failure === 'throw') throw new Error('admission probe rejected')
        return false
      } }
      await expect(new HostedApprovalOwnerStore(wal).reconcileAdmission(admission)).rejects.toThrow(
        failure === 'throw' ? 'admission probe rejected' : 'admission changed during recovery',
      )
      expect(probes).toBe(3)
      expect(capture.lines.map(line => line.recordType)).toEqual(['producer-open', 'owner-wal-published'])
      expect(capture.bound!.next.bytes).toEqual(new Uint8Array(await readFile(path)))
      expect(wal.isPublicationCaptureCurrent()).toBe(false)
      expect(token).not.toBeNull()
      expect((token as { consume(): boolean } | null)?.consume()).toBe(false)
      await wal.locked(async current => { expect(current?.revision).toBe(1); expect(await wal.prepareEffectToken(current!)).toBeNull() })
    }
  })

  test('capture poison revokes a token within its live locked context and persists across locks', async () => {
    const { path } = await walPath(); const capture = publicationCapture(path)
    const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    await expect(wal.locked(async current => {
      const result = await wal.publishMutation(current, { ...withoutRevision(state()), ingress: [], bindings: [] }, {
        operationNonce: 'a'.repeat(64), mutation: { kind: 'admission-reconciled', outcome: 'published' }, admission: admissionFixture(),
      })
      const token = await wal.prepareEffectToken(result.state)
      expect(token).not.toBeNull()
      wal.poisonPublicationCapture('test authority revoked')
      expect(await wal.ownsCurrentFence()).toBe(true)
      expect(token!.consume()).toBe(false)
      expect(await wal.prepareEffectToken(result.state)).toBeNull()
    })).rejects.toMatchObject({ stage: 'published-capture-failed' })
    await wal.locked(async current => { expect(current?.revision).toBe(1); expect(await wal.prepareEffectToken(current!)).toBeNull() })
  })

  test('typed lease witnesses reject no-op, live, reordered, duplicate and identity-changing claims', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    const fixture = state(); const secondRecord = structuredClone(fixture.ingress[0]!)
    secondRecord.commandId = 'permission_2'; secondRecord.outboxId = `runtime_permission:effect:${'e'.repeat(64)}`
    secondRecord.deliveryRef = `delivery_ref_opencode-${'e'.repeat(64)}`
    secondRecord.payloadJson = JSON.stringify({ ...JSON.parse(secondRecord.payloadJson), deliveryRef: secondRecord.deliveryRef })
    fixture.ingress.push(secondRecord)
    fixture.bindings.push({ ...fixture.bindings[0]!, requestId: secondRecord.commandId, bindingDigest: 'e'.repeat(64) })
    await setup.locked(current => setup.publish(current, withoutRevision(fixture)))
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    let now = Date.parse('2026-08-13T10:00:01.000Z')
    const store = new HostedApprovalOwnerStore(wal, () => now)
    const request = { ownerId: 'owner_1', leaseToken: 'lease_1', leaseDurationMs: 30_000, limit: 2 }
    const [claimed, second] = await store.claim(request, 1_000_000)
    expect(claimed!.lease!.generation).toBe(1)
    const bytes = await readFile(path)
    const rejectClaim = async (records: NonNullable<typeof claimed>[]) => {
      await expect(wal.locked(current => wal.publishMutation(current, {
        ...withoutRevision(current!), ingress: current!.ingress.map(record => records.find(item => item.outboxId === record.outboxId) ?? record),
      }, { operationNonce: 'e'.repeat(64), mutation: { kind: 'ingress-lease-claimed', outcome: 'claimed',
        claims: records.map(record => ({ outboxId: record.outboxId, ...record.lease! })) }, records })))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval claim publication witness mismatch' })
    }
    await rejectClaim([claimed!])
    await rejectClaim([{ ...claimed!, lease: { ...claimed!.lease!, generation: 2 } }])
    const renewed = { ...claimed!, lease: { ...claimed!.lease!, generation: 2,
      claimedAtIso: '2026-08-13T10:00:31.000Z', leaseExpiresAtIso: '2026-08-13T10:01:01.000Z' } }
    await rejectClaim([renewed, renewed])
    await rejectClaim([{ ...second!, lease: renewed.lease }, renewed])
    await rejectClaim([{ ...renewed, acceptedAtIso: '2026-08-13T10:00:00.001Z' }])
    expect(await readFile(path)).toEqual(bytes)
    expect(capture.lines).toHaveLength(2)
    expect(await store.claim(request, 1_000_000)).toEqual([claimed!, second!])
    expect(capture.lines).toHaveLength(2)
    now += 30_000
    expect((await store.claim(request, 1_000_000))[0]!.lease!.generation).toBe(2)
    expect(capture.lines).toHaveLength(3)
    capture.producer.close()
  })

  test('ack witnesses enforce exact live lease and change only the first acknowledgement', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const store = new HostedApprovalOwnerStore(wal, () => Date.parse('2026-08-13T10:00:01.000Z'))
    const [claimed] = await store.claim({ ownerId: 'owner_1', leaseToken: 'lease_1', leaseDurationMs: 30_000, limit: 1 }, 1_000_000)
    const request = { outboxId: claimed!.outboxId, generation: 1, ownerId: 'owner_1', leaseToken: 'lease_1' }
    const acknowledged = { ...claimed!, acknowledgedAtIso: '2026-08-13T10:00:02.000Z' }
    const bytes = await readFile(path)
    for (const input of [
      { request: { ...request, generation: 2 }, record: acknowledged },
      { request: { ...request, ownerId: 'owner_wrong' }, record: acknowledged },
      { request: { ...request, leaseToken: 'lease_wrong' }, record: acknowledged },
      { request, record: { ...acknowledged, acceptedAtIso: '2026-08-13T10:00:00.001Z' } },
      { request, record: { ...acknowledged, acknowledgedAtIso: '2026-08-13T10:00:31.000Z' } },
    ]) {
      await expect(wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), ingress: [input.record] }, {
        operationNonce: 'e'.repeat(64), mutation: { kind: 'ingress-acknowledged', outcome: 'acknowledged' }, ...input,
      }))).rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval acknowledgement publication witness mismatch' })
    }
    expect(await readFile(path)).toEqual(bytes)
    expect(capture.lines).toHaveLength(2)
    expect(await store.acknowledge(request)).toEqual({ status: 'acknowledged' })
    expect(await store.acknowledge(request)).toEqual({ status: 'already_acknowledged' })
    await expect(wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), ingress: [acknowledged] }, {
      operationNonce: 'f'.repeat(64), mutation: { kind: 'ingress-acknowledged', outcome: 'acknowledged' }, request, record: acknowledged,
    }))).rejects.toMatchObject({ stage: 'definitely-not-replaced' })
    expect(capture.lines).toHaveLength(3)
    capture.producer.close()
  })

  for (const retainWitness of [false, true]) test(`settlements preserve delivery identity with ${retainWitness ? 'original' : 'legacy null'} witness`, async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    const initial = await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const record = initial.ingress[0]!
    const witness = initialDeliveryWitness(record)
    const started: HostedApprovalOwnerState['deliveries'][number] = {
      providerDeliveryId: witness.request.providerDeliveryId, reconciliationRef: witness.request.reconciliationRef, deliveryRef: record.deliveryRef,
      outboxId: record.outboxId, effectRef: record.effectRef, payloadFingerprint: witness.payloadFingerprint, phase: 'started', result: null,
    }
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    const settle = (delivery: typeof started, initial: OwnerWalInitialDeliveryWitness | null = null) => wal.locked(current => wal.publishMutation(current, {
      ...withoutRevision(current!), deliveries: [delivery],
    }, { operationNonce: 'e'.repeat(64), mutation: { kind: 'delivery-settled', phase: 'completed', outcome: 'delivered' }, delivery, initial }))
    const completed = { ...started, phase: 'completed' as const, result: 'delivered' as const }
    await expect(settle(completed)).rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval settlement publication witness mismatch' })
    expect(capture.lines).toHaveLength(1)
    await wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), deliveries: [started] }, {
      operationNonce: 'e'.repeat(64), mutation: { kind: 'delivery-started', outcome: 'started' }, delivery: started,
      initial: witness,
    }))
    const bytes = await readFile(path)
    for (const changed of [{ providerDeliveryId: 'delivery_other' }, { reconciliationRef: 'approval-reconciliation_other' }, { payloadFingerprint: 'd'.repeat(64) }]) {
      await expect(settle({ ...completed, ...changed })).rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval settlement publication witness mismatch' })
    }
    for (const invalid of [
      { ...witness, payloadFingerprint: 'f'.repeat(64) },
      { ...witness, request: { ...witness.request, requestId: 'permission_other' } },
    ]) {
      await expect(settle(completed, invalid)).rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval settlement publication witness mismatch' })
    }
    expect(await readFile(path)).toEqual(bytes)
    expect(capture.lines).toHaveLength(2)
    await settle(completed, retainWitness ? witness : null)
    expect((await wal.read())!.deliveries).toEqual([completed])
    expect(capture.lines).toHaveLength(3)
    capture.producer.close()
  })

  test('poisons capture after durable publication failure and cannot retry from old authority', async () => {
    const { path } = await walPath(); let failSync = false
    const capture = publicationCapture(path, { failSync: () => failSync })
    const admission = admissionFixture()
    const wal = new HostedApprovalOwnerWal(path, { afterWalRename: async () => { failSync = true } }, capture.producer)
    const store = new HostedApprovalOwnerStore(wal)
    await expect(store.reconcileAdmission(admission)).rejects.toMatchObject({ stage: 'published-capture-failed' })
    const durable = await readFile(path)
    expect(JSON.parse(durable.toString())).toMatchObject({ revision: 1,
      admissionDigest: admission.digest, routes: admission.routes, ingress: [], bindings: [], deliveries: [] })
    expect(wal.isPublicationCaptureCurrent()).toBe(false)
    expect(capture.bound).toBeUndefined()
    // Bytes appended before a failing sync are not a bound publication receipt.
    expect(capture.lines).toHaveLength(2)
    await expect(store.reconcileAdmission({ ...admission, digest: 'c'.repeat(64) })).rejects.toThrow('poisoned')
    expect(await readFile(path)).toEqual(durable)
    expect(capture.lines).toHaveLength(2)
  })

  test('a direct rejected delivery remains a valid native settlement without a started publication', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    const initial = await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const record = initial.ingress[0]!
    const witness = initialDeliveryWitness(record)
    const rejected: HostedApprovalOwnerState['deliveries'][number] = {
      providerDeliveryId: witness.request.providerDeliveryId, reconciliationRef: witness.request.reconciliationRef, deliveryRef: record.deliveryRef,
      outboxId: record.outboxId, effectRef: record.effectRef, payloadFingerprint: witness.payloadFingerprint, phase: 'rejected', result: 'expired',
    }
    const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
    await wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), deliveries: [rejected] }, {
      operationNonce: 'e'.repeat(64), mutation: { kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' }, delivery: rejected,
      initial: witness,
    }))
    expect(capture.lines.map(line => line.recordType)).toEqual(['producer-open', 'owner-wal-published'])
    expect(capture.bound!.native.mutation).toEqual({ kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' })
    expect((await wal.read())!.deliveries).toEqual([rejected])
    capture.assertBound()
  })
  test('keeps variadic creation out of Bun FFI on every supported platform', async () => {
    const source = await readFile(resolve(import.meta.dir, 'HostedApprovalOwnerWal.ts'), 'utf8')
    const openatDeclaration = source.split('\n').find(line => line.trimStart().startsWith('openat:'))
    expect(openatDeclaration?.trim()).toBe(
      'openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },',
    )
    expect(source).not.toMatch(/openAt\([^;]+O_CREAT/)
    expect(source).toContain("if (darwinSpawnLibc) return makeRegularNodeAtDarwin(parentFd, name)")
    expect(source).toContain('posix_spawn_file_actions_addopen')
  })

  test('portable fake-native creator retries EINTR and validates retained relative creation before success', () => {
    const calls: unknown[][] = []
    const waits = [
      { result: -1, status: 0, errno: 4 },
      { result: 73, status: 0, errno: 0 },
    ]
    const native = fakeDarwinSpawnNative(calls, { waits })
    let removed = 0
    expect(createRegularNodeAtDarwin(41, 'owner.json.writer-lock', native, () => { removed += 1 })).toBe(true)
    expect(removed).toBe(0)
    expect(calls).toEqual([
      ['init'],
      ['chdir', 41],
      ['open', 0, 'owner.json.writer-lock',
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600],
      ['spawn', '/usr/bin/true'],
      ['wait', 73],
      ['wait', 73],
      ['destroy'],
    ])
  })

  test('portable fake-native creator rejects nonzero and signaled children without claiming creation', () => {
    for (const [status, message] of [[127 << 8, 'exited 127'], [23 << 8, 'exited 23'], [9, 'signal 9']] as const) {
      const calls: unknown[][] = []; let removed = 0
      const native = fakeDarwinSpawnNative(calls, { waits: [{ result: 73, status, errno: 0 }] })
      expect(() => createRegularNodeAtDarwin(41, 'node', native, () => { removed += 1 })).toThrow(message)
      expect(calls.filter(call => call[0] === 'wait')).toEqual([['wait', 73]])
      expect(calls.at(-1)).toEqual(['destroy'])
      expect(removed).toBe(0)
    }
  })

  test('portable fake-native creator rejects wrong-pid, wait errors, and EINTR exhaustion without claiming creation', () => {
    for (const fixture of [
      { waits: [{ result: 74, status: 0, errno: 0 }], message: 'creator wait failed' },
      { waits: [{ result: -1, status: 0, errno: 10 }], message: 'creator wait failed' },
      {
        waits: Array.from({ length: 65 }, () => ({ result: -1, status: 0, errno: 4 })),
        message: 'creator wait failed',
      },
      { waits: [{ result: 73, status: 0x10000, errno: 0 }], message: 'wait status ambiguous' },
    ]) {
      let removed = 0
      const native = fakeDarwinSpawnNative([], { waits: fixture.waits })
      expect(() => createRegularNodeAtDarwin(41, 'node', native, () => { removed += 1 }))
        .toThrow(fixture.message)
      expect(removed).toBe(0)
    }
  })

  test('preserves a sentinel pre-existing lock on child-exit-127, signal, and wait failure', async () => {
    const cases = [
      { waits: [{ result: 73, status: 127 << 8, errno: 0 }], message: 'exited 127' },
      { waits: [{ result: 73, status: 9, errno: 0 }], message: 'signal 9' },
      { waits: [{ result: -1, status: 0, errno: 10 }], message: 'creator wait failed' },
    ]
    for (const fixture of cases) {
      const { path } = await walPath()
      const lockPath = `${path}.writer-lock`
      await writeFile(lockPath, 'sentinel-pre-existing-lock', { mode: 0o600 })
      const native = fakeDarwinSpawnNative([], { waits: fixture.waits })
      expect(() => createRegularNodeAtDarwin(41, 'owner.json.writer-lock', native, () => unlinkSync(lockPath)))
        .toThrow(fixture.message)
      expect(await readFile(lockPath, 'utf8')).toBe('sentinel-pre-existing-lock')
    }
  })

  test('portable fake-native creator preserves a pre-existing lock on action, exec, and EEXIST failures', () => {
    const cases: Array<{ overrides: Parameters<typeof fakeDarwinSpawnNative>[1]; error?: string; result?: boolean }> = [
      { overrides: { chdirError: 22 }, error: 'retained spawn directory unavailable' },
      { overrides: { openError: 13 }, error: 'spawn create action unavailable' },
      { overrides: { spawnError: 2 }, error: 'creator spawn failed' },
      { overrides: { pid: 0 }, error: 'creator spawn failed' },
      { overrides: { spawnError: 17 }, result: false },
    ]
    for (const fixture of cases) {
      let removed = 0
      const native = fakeDarwinSpawnNative([], fixture.overrides)
      if (fixture.error) {
        expect(() => createRegularNodeAtDarwin(41, 'owner.json.writer-lock', native, () => { removed += 1 }))
          .toThrow(fixture.error)
      } else {
        expect(createRegularNodeAtDarwin(41, 'owner.json.writer-lock', native, () => { removed += 1 }))
          .toBe(fixture.result!)
      }
      expect(removed).toBe(0)
    }
  })

  test('portable fake-native creator treats action destruction as failure and cleans an owned node', () => {
    let removed = 0
    const native = fakeDarwinSpawnNative([], {
      waits: [{ result: 73, status: 0, errno: 0 }], destroyError: 22,
    })
    expect(() => createRegularNodeAtDarwin(41, 'node', native, () => { removed += 1 }))
      .toThrow('actions destroy failed')
    expect(removed).toBe(1)
  })

  test('publishes a legacy v1 migration as v3 without restoring legacy routes', async () => {
    const { path } = await walPath()
    const wal = new HostedApprovalOwnerWal(path)
    const published = await wal.locked(async current => wal.publish(current, withoutRevision(state())))
    const legacy = structuredClone(published) as unknown as {
      schemaVersion: number
      routes: Array<{ openCodeBinding: Record<string, unknown> }>
      bindings?: HostedApprovalOwnerState['bindings']
    }
    legacy.schemaVersion = 1
    delete legacy.bindings
    delete legacy.routes[0]!.openCodeBinding.openCodeArtifactDigest
    for (const record of (legacy as unknown as { ingress: HostedApprovalOwnerState['ingress'] }).ingress) {
      ;(record as { outboxVersion: number }).outboxVersion = 1
      record.outboxId = `runtime_permission:${record.effectRef}`
    }
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 })
    const migrated = await wal.locked(async current => {
      expect(current).toMatchObject({ schemaVersion: 3, routes: [], ingress: [] })
      return wal.publish(current, withoutRevision(current!))
    })
    expect(migrated.schemaVersion).toBe(3)
    expect(JSON.parse(await readFile(path, 'utf8')).schemaVersion).toBe(3)
  })

  test('rejects a writer-fence symlink without mutating its target', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    const target = join(path, '..', 'target'); await writeFile(target, 'untouched', { mode: 0o644 })
    const before = await lstat(target); await symlink(target, wal.fencePath)
    await expect(wal.locked(async state => state)).rejects.toThrow()
    const after = await lstat(target)
    expect(await readFile(target, 'utf8')).toBe('untouched')
    expect(after.mode).toBe(before.mode); expect(after.size).toBe(before.size)
  })

  test('creates through the retained parent fd and closes descriptors when the linked parent races', async () => {
    if (process.platform !== 'linux') return
    const raceCreate = async () => {
      const { path } = await walPath(); const root = join(path, '..'); const retained = `${root}.retained`
      roots.push(retained)
      let observedRetainedNode = false
      const wal = new HostedApprovalOwnerWal(path, {
        beforeRetainedCreate: () => {
          renameSync(root, retained)
          mkdirSync(root, { mode: 0o700 })
        },
        afterRetainedCreate: name => {
          observedRetainedNode = lstatSync(join(retained, name)).isFile()
          expect(existsSync(join(root, name))).toBe(false)
        },
      })
      await expect(wal.locked(async state => state)).rejects.toThrow('outside pinned namespace')
      expect(observedRetainedNode).toBe(true)
      expect(existsSync(join(retained, 'owner.json.writer-lock'))).toBe(false)
    }
    await raceCreate()
    const settledFds = readdirSync('/proc/self/fd').length
    await raceCreate()
    expect(readdirSync('/proc/self/fd').length).toBe(settledFds)
  })

  test('fails closed when the fence pathname is replaced after safe open and before identity use', async () => {
    const { path } = await walPath(); const replacement = `${path}.replacement`
    const wal = new HostedApprovalOwnerWal(path, { afterFenceOpen: async () => {
      await writeFile(replacement, '', { mode: 0o600 }); await rename(replacement, wal.fencePath)
    } })
    await expect(wal.locked(async state => state)).rejects.toThrow('identity changed')
    expect((await lstat(wal.fencePath)).size).toBe(0)
  })

  test('rejects parent namespace substitution after fence open and preserves the authoritative WAL', async () => {
    const { path } = await walPath(); const root = join(path, '..'); const moved = `${root}.authoritative`
    roots.push(moved)
    const initialWal = new HostedApprovalOwnerWal(path)
    const authoritative = await initialWal.locked(async current => initialWal.publish(current, withoutRevision(state())))
    const wal = new HostedApprovalOwnerWal(path, { afterFenceOpen: async () => {
      await rename(root, moved)
      await mkdir(root, { mode: 0o700 })
      await link(join(moved, 'owner.json.writer-fence.sqlite'), wal.fencePath)
      const substituted = { ...authoritative, revision: authoritative.revision + 1,
        actorMembers: { ...authoritative.actorMembers, actor_substituted: `member_${'9'.repeat(32)}` } }
      await writeFile(path, `${JSON.stringify(substituted)}\n`, { mode: 0o600 })
    } })
    await expect(wal.locked(async current => wal.publish(current, {
      ...withoutRevision(current!), actorMembers: { ...current!.actorMembers, actor_rogue: `member_${'7'.repeat(32)}` },
    }))).rejects.toThrow('identity changed')
    expect(JSON.parse(await readFile(join(moved, 'owner.json'), 'utf8'))).toEqual(authoritative)
    expect(JSON.parse(await readFile(path, 'utf8')).actorMembers.actor_substituted).toBeDefined()
  })

  test('serializes two independent owner instances and reloads after handover without lost updates', async () => {
    const { path } = await walPath(); const first = new HostedApprovalOwnerWal(path); const second = new HostedApprovalOwnerWal(path)
    await first.locked(async current => first.publish(current, withoutRevision(state())))
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve })
    let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve })
    const firstWrite = first.locked(async current => {
      enter(); await gate
      return first.publish(current, { ...withoutRevision(current!), actorMembers: { ...current!.actorMembers, actor_first: `member_${'5'.repeat(32)}` } })
    })
    await entered
    const secondWrite = second.locked(async current => second.publish(current, {
      ...withoutRevision(current!), actorMembers: { ...current!.actorMembers, actor_second: `member_${'6'.repeat(32)}` },
    }))
    resume(); await Promise.all([firstWrite, secondWrite])
    expect(await first.read()).toMatchObject({ revision: 3, actorMembers: { actor_first: `member_${'5'.repeat(32)}`, actor_second: `member_${'6'.repeat(32)}` } })
  })

  test('rejects a rogue stale publish with compare-and-swap and preserves the replacement owner state', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    const initial = await wal.locked(async current => wal.publish(current, withoutRevision(state())))
    await expect(wal.locked(async current => {
      const replacement = { ...current!, revision: current!.revision + 1, actorMembers: { ...current!.actorMembers, actor_replacement: `member_${'7'.repeat(32)}` } }
      await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 })
      return wal.publish(current, { ...withoutRevision(current!), actorMembers: { ...current!.actorMembers, actor_stale: `member_${'9'.repeat(32)}` } })
    })).rejects.toThrow('compare-and-swap conflict')
    expect(await wal.read()).toMatchObject({ revision: initial.revision + 1, actorMembers: { actor_replacement: `member_${'7'.repeat(32)}` } })
    expect((await wal.read())?.actorMembers.actor_stale).toBeUndefined()
  })

  test('a replacement owner preserves a crash-left started effect as operator-only ambiguity', async () => {
    const { path } = await walPath(); const crashed = new HostedApprovalOwnerWal(path)
    const initial = await crashed.locked(async current => crashed.publish(current, withoutRevision(state())))
    const ingress = initial.ingress[0]!
    await crashed.locked(async current => crashed.publish(current, {
      ...withoutRevision(current!),
      deliveries: [{ providerDeliveryId: 'delivery_1', reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`, deliveryRef: ingress.deliveryRef, payloadFingerprint: 'f'.repeat(64), outboxId: ingress.outboxId, effectRef: ingress.effectRef, phase: 'started', result: null }],
    }))
    const replacement = new HostedApprovalOwnerWal(path)
    expect(await replacement.read()).toMatchObject({ deliveries: [{ phase: 'started', result: null, effectRef: ingress.effectRef }] })
  })

  test('compacts terminal delivery history while retaining every active or ambiguous effect', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    const base = state(); const active = structuredClone(base.ingress[0]!)
    active.effectRef = `effect:${'e'.repeat(64)}`; active.outboxId = `runtime_permission:effect:${'e'.repeat(64)}`
    active.deliveryRef = `delivery_ref_opencode-${'e'.repeat(64)}`
    active.payloadJson = JSON.stringify({
      schemaVersion: 1, deliveryRef: active.deliveryRef, category: 'command', summary: 'Run tests',
      expiresAtMs: null, preview: null,
    })
    const terminalIngress = Array.from({ length: 2_050 }, (_, index) => {
      const suffix = index.toString(36); const digest = index.toString(16).padStart(64, '0')
      const record = structuredClone(base.ingress[0]!)
      record.effectRef = `effect:${digest}`; record.outboxId = `runtime_permission:effect:${digest}`
      record.deliveryRef = `delivery_ref_opencode-${digest}`
      record.commandId = `permission_terminal_${suffix}`
      record.payloadJson = JSON.stringify({
        schemaVersion: 1, deliveryRef: record.deliveryRef, category: 'command', summary: 'Run tests',
        expiresAtMs: null, preview: null,
      })
      record.lease = {
        generation: 1, ownerId: 'owner_terminal', leaseToken: `lease_${suffix}`,
        claimedAtIso: '2026-08-13T10:00:01.000Z', leaseExpiresAtIso: '2026-08-13T10:00:03.000Z',
      }
      record.acknowledgedAtIso = '2026-08-13T10:00:02.000Z'
      return record
    })
    const deliveries: HostedApprovalOwnerState['deliveries'] = terminalIngress.map((record, index) => ({
      providerDeliveryId: `delivery_${index.toString(36)}`,
      reconciliationRef: `approval-reconciliation_${index.toString(36)}`,
      deliveryRef: record.deliveryRef, payloadFingerprint: index.toString(16).padStart(64, '0'),
      outboxId: record.outboxId, effectRef: record.effectRef,
      phase: 'completed', result: 'delivered',
    }))
    deliveries.push({
      providerDeliveryId: 'delivery_active', reconciliationRef: 'approval-reconciliation_active',
      deliveryRef: active.deliveryRef, payloadFingerprint: 'f'.repeat(64), outboxId: active.outboxId,
      effectRef: active.effectRef, phase: 'started' as const, result: null,
    })
    const published = await wal.locked(current => wal.publish(current, {
      ...withoutRevision(base), ingress: [...terminalIngress, active], deliveries,
      bindings: [...terminalIngress, active].map(record => ({
        teamId: record.authority.teamId, runId: record.authority.runId, requestId: record.commandId,
        effectRef: record.effectRef, bindingDigest: record.outboxId.slice('runtime_permission:effect:'.length),
        quarantined: false,
      })),
    }))
    expect(published.deliveries).toHaveLength(2_049)
    expect(published.deliveries[0]?.outboxId).toBe(terminalIngress[2]!.outboxId)
    expect(published.deliveries.at(-1)).toMatchObject({ outboxId: active.outboxId, phase: 'started' })
    expect(published.ingress.some(record => record.outboxId === active.outboxId)).toBe(true)
  })

  test('serializes concurrent processes and crash handover without a stale-time reclaim window', async () => {
    const { path } = await walPath()
    const root = join(path, '..'); const start = join(root, 'start'); const entered = join(root, 'entered')
    const firstScript = join(root, 'first.ts'); const secondScript = join(root, 'second.ts')
    const moduleUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerWal.ts')).href
    await writeFile(firstScript, `
import { access, writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => {
  await writeFile(process.argv[3], 'entered')
  while (await access(process.argv[4]).then(() => false).catch(() => true)) await new Promise(r => setTimeout(r, 5))
  return state
})
`)
    await writeFile(secondScript, `
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => state)
`)
    const first = Bun.spawn({ cmd: [process.execPath, firstScript, path, entered, start], stdout: 'ignore', stderr: 'ignore' })
    while (await Bun.file(entered).exists() === false) await new Promise(resolve => setTimeout(resolve, 5))
    const second = Bun.spawn({ cmd: [process.execPath, secondScript, path], stdout: 'ignore', stderr: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(second.exitCode).toBeNull()
    first.kill('SIGKILL')
    expect(await second.exited).toBe(0)
    expect(first.exitCode).not.toBe(0)
  }, 15_000)

  test('keeps a cross-process contender excluded after ownsCurrentFence and effect-token consume', async () => {
    if (process.platform === 'win32') return
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    await wal.locked(async current => wal.publish(current, withoutRevision(state())))
    const root = join(path, '..'); const edge = join(root, 'edge'); const contenderEntered = join(root, 'contender-entered')
    const ownerScript = join(root, 'edge-owner.ts'); const contenderScript = join(root, 'edge-contender.ts')
    const moduleUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerWal.ts')).href
    await writeFile(ownerScript, `
import { writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => {
  if (!await wal.ownsCurrentFence()) throw new Error('lost fence before effect token')
  const token = await wal.prepareEffectToken(state)
  if (!token?.consume()) throw new Error('effect token rejected')
  await writeFile(process.argv[3], 'consumed')
  await new Promise(() => {})
})
`)
    await writeFile(contenderScript, `
import { writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => { await writeFile(process.argv[3], 'entered'); return state })
`)
    const owner = Bun.spawn({ cmd: [process.execPath, ownerScript, path, edge], stdout: 'ignore', stderr: 'pipe' })
    while (!await Bun.file(edge).exists()) await new Promise(resolve => setTimeout(resolve, 5))
    const contender = Bun.spawn({ cmd: [process.execPath, contenderScript, path, contenderEntered], stdout: 'ignore', stderr: 'pipe' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(contender.exitCode).toBeNull()
    expect(await Bun.file(contenderEntered).exists()).toBe(false)
    owner.kill('SIGKILL'); expect(await owner.exited).not.toBe(0)
    expect(await contender.exited).toBe(0)
    expect(await readFile(contenderEntered, 'utf8')).toBe('entered')
  }, 15_000)

  test('recovers immutable fence initialization after SIGKILL at both durability edges', async () => {
    if (process.platform === 'win32') return
    for (const hook of ['afterFenceTempFsync', 'afterFenceLink'] as const) {
      const { path } = await walPath(); const root = join(path, '..')
      const reached = join(root, `reached-${hook}`); const script = join(root, `init-${hook}.ts`)
      const moduleUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerWal.ts')).href
      await writeFile(script, `
import { writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const pause = async () => { await writeFile(process.argv[3], 'reached'); await new Promise(() => {}) }
const hooks = process.argv[4] === 'afterFenceTempFsync' ? { afterFenceTempFsync: pause } : { afterFenceLink: pause }
const wal = new HostedApprovalOwnerWal(process.argv[2], hooks)
await wal.locked(async state => state)
`)
      const initializing = Bun.spawn({ cmd: [process.execPath, script, path, reached, hook], stdout: 'ignore', stderr: 'pipe' })
      while (!await Bun.file(reached).exists()) await new Promise(resolve => setTimeout(resolve, 5))
      initializing.kill('SIGKILL'); expect(await initializing.exited).not.toBe(0)
      const replacement = new HostedApprovalOwnerWal(path)
      await expect(replacement.locked(async current => current)).resolves.toBeNull()
      await expect(replacement.locked(async current => current)).resolves.toBeNull()
    }
  }, 15_000)

  test('SIGKILL handover preserves durable started ambiguity without retrying a simulated provider effect', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    const initial = await wal.locked(async current => wal.publish(current, withoutRevision(state())))
    const root = join(path, '..'); const ready = join(root, 'ready'); const go = join(root, 'go')
    const entered = join(root, 'entered'); const effects = join(root, 'effects'); const outcome = join(root, 'outcome')
    const firstScript = join(root, 'effect-owner.ts'); const replacementScript = join(root, 'replacement-owner.ts')
    const moduleUrl = pathToFileURL(resolve('src/services/hostedControl/HostedApprovalOwnerWal.ts')).href
    await writeFile(firstScript, `
import { access, appendFile, writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => {
  const ingress = state.ingress[0]
  await wal.publish(state, { ...state, deliveries: [{ providerDeliveryId: 'delivery_1', reconciliationRef: 'approval-reconciliation_${'4'.repeat(64)}', deliveryRef: ingress.deliveryRef, payloadFingerprint: '${'f'.repeat(64)}', outboxId: ingress.outboxId, effectRef: ingress.effectRef, phase: 'started', result: null }] })
  await writeFile(process.argv[3], 'ready')
  while (await access(process.argv[4]).then(() => false).catch(() => true)) await new Promise(r => setTimeout(r, 5))
  await appendFile(process.argv[5], 'provider-effect\\n')
  await writeFile(process.argv[6], 'entered')
  await new Promise(() => {})
})
`)
    await writeFile(replacementScript, `
import { appendFile, writeFile } from 'node:fs/promises'
import { HostedApprovalOwnerWal } from ${JSON.stringify(moduleUrl)}
const wal = new HostedApprovalOwnerWal(process.argv[2])
await wal.locked(async state => {
  const started = state.deliveries.find(item => item.phase === 'started')
  if (!started) await appendFile(process.argv[3], 'provider-effect\\n')
  await writeFile(process.argv[4], started ? 'operator_required' : 'delivered')
})
`)
    const first = Bun.spawn({ cmd: [process.execPath, firstScript, path, ready, go, effects, entered], stdout: 'ignore', stderr: 'pipe' })
    while (!await Bun.file(ready).exists()) await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(go, 'go')
    while (!await Bun.file(entered).exists()) await new Promise(resolve => setTimeout(resolve, 5))
    const replacement = Bun.spawn({ cmd: [process.execPath, replacementScript, path, effects, outcome], stdout: 'ignore', stderr: 'pipe' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(replacement.exitCode).toBeNull()
    expect(await Bun.file(outcome).exists()).toBe(false)
    first.kill('SIGKILL'); expect(await first.exited).not.toBe(0)
    expect(await replacement.exited).toBe(0)
    expect(await readFile(outcome, 'utf8')).toBe('operator_required')
    expect((await readFile(effects, 'utf8')).trim().split('\n')).toEqual(['provider-effect'])
    expect(await wal.read()).toMatchObject({ revision: initial.revision + 1, deliveries: [{ phase: 'started', result: null }] })
  }, 15_000)

  test('fails closed when the writer-fence inode is replaced during acquisition', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    await wal.locked(async state => wal.publish(state, withoutRevision(stateFixture())))
    const replacement = `${wal.fencePath}.replacement`
    await writeFile(replacement, '', { mode: 0o600 })
    await rename(replacement, wal.fencePath)
    await expect(wal.locked(async state => state)).rejects.toThrow()
  })

  test('ownsCurrentFence revokes the locked writer immediately after pathname replacement', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    await wal.locked(async state => wal.publish(state, withoutRevision(stateFixture())))
    let revoked = false
    await expect(wal.locked(async () => {
      expect(await wal.ownsCurrentFence()).toBe(true)
      const replacement = `${wal.fencePath}.replacement`; await writeFile(replacement, '', { mode: 0o600 })
      await rename(replacement, wal.fencePath)
      revoked = !(await wal.ownsCurrentFence())
    })).rejects.toThrow()
    expect(revoked).toBe(true)
  })

  test('rejects a WAL inode replacement after rename instead of claiming durable publication', async () => {
    const { path } = await walPath(); const replacement = `${path}.replacement`
    const wal = new HostedApprovalOwnerWal(path, { afterWalRename: async () => {
      await writeFile(replacement, '{}\n', { mode: 0o600 })
      await rename(replacement, path)
    } })
    await expect(wal.locked(async current => wal.publish(current, withoutRevision(state()))))
      .rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{}\n')
  })

  test('rejects a parent-directory substitution during publication', async () => {
    const { path } = await walPath(); const root = join(path, '..'); const moved = `${root}.moved`
    roots.push(moved)
    const wal = new HostedApprovalOwnerWal(path, { afterWalRename: async () => {
      await rename(root, moved)
      await mkdir(root, { mode: 0o700 })
    } })
    await expect(wal.locked(async current => wal.publish(current, withoutRevision(state()))))
      .rejects.toThrow()
  })

  test('effect token rejects WAL replacement immediately before provider authority', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    await wal.locked(async current => {
      const published = await wal.publish(current, withoutRevision(state()))
      const token = await wal.prepareEffectToken(published)
      expect(token).not.toBeNull()
      const replacement = `${path}.replacement`
      await writeFile(replacement, `${JSON.stringify(published)}\n`, { mode: 0o600 })
      await rename(replacement, path)
      expect(token!.consume()).toBe(false)
    })
  })

  test('effect token rejects parent namespace substitution immediately before provider authority', async () => {
    const { path } = await walPath(); const root = join(path, '..'); const moved = `${root}.effect-authority`
    roots.push(moved)
    const wal = new HostedApprovalOwnerWal(path)
    let effects = 0
    let publishedBytes: Buffer | undefined
    const operation = wal.locked(async current => {
      const published = await wal.publish(current, withoutRevision(state()))
      publishedBytes = await readFile(path)
      const token = await wal.prepareEffectToken(published)
      expect(token).not.toBeNull()
      await rename(root, moved)
      await mkdir(root, { mode: 0o700 })
      await link(join(moved, 'owner.json'), path)
      await link(join(moved, 'owner.json.writer-fence.sqlite'), wal.fencePath)
      const consumed = token!.consume()
      if (consumed) effects += 1
      expect(consumed).toBe(false)
    })
    await expect(operation).rejects.toBeInstanceOf(HostedApprovalOwnerPublicationError)
    await expect(operation).rejects.toMatchObject({ stage: 'replacement-uncertain' })
    expect(effects).toBe(0)
    expect(await readFile(path)).toEqual(publishedBytes)
    expect(await readFile(join(moved, 'owner.json'))).toEqual(publishedBytes)
  })

})

function admissionFixture(): HostedApprovalRuntimeAdmission {
  const fixture = state()
  return {
    schemaVersion: 1, admissionGeneration: fixture.admissionGeneration,
    digest: fixture.admissionDigest, routes: fixture.routes, actorMembers: fixture.actorMembers,
    outerAuthority: { deploymentId: route.authority.deploymentId, bootId: 'boot_test',
      workspaceId: route.scope.workspaceId, teamId, restoreGeneration: 1,
      mountBinding: { mountGeneration: 1, declaredRootHash: '0'.repeat(64) } },
    isCurrent: async () => true, prepareEffectToken: async () => null,
  }
}

// WAL/Store + production serializer + durable test custody coverage. Descriptor
// and process identity are controlled here; the real syscall test above is a
// separate boundary check, not proof of full hosted native integration.
function publicationCapture(path: string, options: { failSync?: () => boolean; duringCustodyPrepare?: () => void } = {}) {
  let prepared: Parameters<OwnerWalPublicationProducer['prepare']>[0] | undefined
  let bound: BoundWalPublication | undefined
  let custody: { previous: PreviousWalImage; next: RetainedWalImage; returned: { previous: PreviousWalImage; next: RetainedWalImage } } | undefined
  const chunks: Buffer[] = []
  let nonce = 0
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const stage = (name: string, bytes: Uint8Array) => {
    const stagedPath = `${path}.${name}`
    const fd = openSync(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(join(path, '..'), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
    return stagedPath
  }
  const native = createOwnerWalPublicationProducerFromEnvironment({
    environment: { CLAUDE_TEAM_PRODUCER_PROVENANCE_V2: JSON.stringify({
      activation: { controllerNonce: '1'.repeat(64), runId: 'run_test', stackManifestSha256: '2'.repeat(64) },
      contract: HOSTED_OWNER_PROVENANCE_CONTRACT, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      expectedProducer: { artifactManifestSha256: '3'.repeat(64), executableSha256: '4'.repeat(64),
        implementationId: HOSTED_OWNER_PROVENANCE_IMPLEMENTATION, moduleSha256: '5'.repeat(64) },
      producerRole: 'owner', streams: { ownerWalTimeline: { device: '7', fd: 9, inode: '8' } }, version: 2,
    }) }, modulePath: '/unused',
    operations: {
      identity: () => ({ pid: process.pid, startTicks: '9', exeDev: '10', exeIno: '11', exeSha256: '4'.repeat(64), moduleSha256: '5'.repeat(64) }),
      descriptor: () => ({ device: '7', inode: '8', regular: true, append: true, writeOnly: true, mode: 0o600, nlink: '1', size: '0' }),
      nonce: () => (++nonce).toString(16).padStart(64, '0'),
      write: (_fd, bytes, offset) => { chunks.push(Buffer.from(bytes.subarray(offset))); return bytes.byteLength - offset },
      sync: () => { if (options.failSync?.()) throw new Error('capture sync failed') }, close: () => {},
    },
    imageCustodian: { prepare(previous, next) {
      // Custody stages P/N before replacement and binds only after N is live.
      if (previous.kind === 'absent') expect(existsSync(path)).toBe(false)
      else expect(readFileSync(path)).toEqual(Buffer.from(previous.image.bytes))
      const sequence = chunks.length
      const operationNonce = prepared!.intent.operationNonce
      const previousPath = previous.kind === 'retained' ? stage(`P.${sequence}`, previous.image.bytes) : null
      const nextPath = stage(`N.${sequence}`, next.bytes)
      const returned = { previous: previous.kind === 'absent' ? previous :
        { kind: 'retained' as const, image: { ...previous.image, bytes: previous.image.bytes } },
        next: { ...next, bytes: next.bytes } }
      custody = { previous, next, returned }
      options.duringCustodyPrepare?.()
      return { bind(emission) {
        expect(readFileSync(path)).toEqual(readFileSync(nextPath))
        if (previous.kind === 'retained') expect(readFileSync(previousPath!)).toEqual(Buffer.from(previous.image.bytes))
        expect(hash(chunks[sequence]!)).toBe(emission.lineSha256)
        expect(emission.operationNonce).toBe(operationNonce)
        return returned
      } }
    } },
  })!
  return {
    get prepared() { return prepared }, get bound() { return bound }, get custody() { return custody },
    get lines() { return chunks.map(chunk => JSON.parse(chunk.toString())) },
    producer: {
      isHealthy: () => native.isHealthy(),
      prepare(input) { prepared = input; const staged = native.prepare(input)
        return { emit() { bound = staged.emit(); return bound } } },
      poison(reason): never { return native.poison(reason) }, close() { native.close() },
    } satisfies OwnerWalPublicationProducer,
    assertBound() {
      expect(bound).toBeDefined()
      expect(chunks).toHaveLength(2)
      const line = JSON.parse(chunks[1]!.toString())
      expect(line.recordType).toBe('owner-wal-published')
      expect(line.native).toEqual(prepared!.native)
      expect(line.previousRecordSha256).toBe(hash(chunks[0]!))
      expect(bound!.emission.lineSha256).toBe(hash(chunks[1]!))
      expect(bound!.next.sha256).toBe(hash(readFileSync(path)))
      expect(bound!.next.byteSize).toBe(readFileSync(path).byteLength)
      expect(bound!.previous).toEqual(prepared!.previous)
      native.close()
    },
  }
}

describe('Owner W2 r809 boundary regressions', () => {
  test.skipIf(process.platform !== 'linux')('outer cleanup closes every unconsumed effect token descriptor', async () => {
    const { path } = await walPath(); const wal = new HostedApprovalOwnerWal(path)
    await new HostedApprovalOwnerStore(wal).reconcileAdmission(admissionFixture())
    const identity = lstatSync(path)
    const openWalDescriptors = () => readdirSync('/proc/self/fd').filter(name => {
      try { const stat = fstatSync(Number(name)); return stat.dev === identity.dev && stat.ino === identity.ino }
      catch { return false }
    }).length
    const tokens: Array<{ consume(): boolean }> = []
    await wal.locked(async current => {
      tokens.push((await wal.prepareEffectToken(current!))!, (await wal.prepareEffectToken(current!))!)
      expect(tokens.every(Boolean)).toBe(true)
      expect(openWalDescriptors()).toBe(2)
    })
    expect(openWalDescriptors()).toBe(0)
    for (const token of tokens) expect(token.consume()).toBe(false)
  })

  test('producer poison and close revoke already prepared tokens and every sharing WAL', async () => {
    for (const failure of ['poison', 'close'] as const) {
      let duringClose: (() => void) | undefined
      const { path } = await walPath(); const capture = publicationCapture(path, { failSync: () => { duringClose?.(); return false } })
      const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      await new HostedApprovalOwnerStore(wal).reconcileAdmission(admissionFixture())
      const peer = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      await wal.locked(async current => {
        const token = await wal.prepareEffectToken(current!)
        expect(token).not.toBeNull()
        if (failure === 'poison') expect(() => capture.producer.poison('shared producer failed')).toThrow('shared producer failed')
        else {
          let observedClosing = false
          duringClose = () => {
            observedClosing = true
            expect(capture.producer.isHealthy()).toBe(false)
            expect(token!.consume()).toBe(false)
          }
          capture.producer.close()
          expect(observedClosing).toBe(true)
        }
        expect(capture.producer.isHealthy()).toBe(false)
        expect(peer.isPublicationCaptureCurrent()).toBe(false)
        expect(wal.isPublicationCaptureCurrent()).toBe(false)
        expect(token!.consume()).toBe(false)
        expect(await wal.prepareEffectToken(current!)).toBeNull()
      })
      const reconstructed = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      await new HostedApprovalOwnerStore(reconstructed).reconcileAdmission(admissionFixture())
      expect(reconstructed.isPublicationCaptureCurrent()).toBe(false)
      await reconstructed.locked(async current => {
        expect(current?.revision).toBe(1)
        expect(await reconstructed.prepareEffectToken(current!)).toBeNull()
      })
    }
  })

  test('final synchronous CAS rejects P replacement from custody and after awaited temporary staging', async () => {
    for (const boundary of ['custody', 'staging'] as const) for (const substitution of ['inode', 'bytes', 'absent'] as const) {
      const { path } = await walPath()
      if (substitution !== 'absent') {
        const setup = new HostedApprovalOwnerWal(path)
        await new HostedApprovalOwnerStore(setup).reconcileAdmission(admissionFixture())
      }
      const oldBytes = existsSync(path) ? readFileSync(path) : null
      const oldInode = existsSync(path) ? lstatSync(path).ino : null
      let replacement!: Buffer; let replacementInode = 0; let renamed = false
      let capture!: ReturnType<typeof publicationCapture>
      const substitute = () => {
        replacement = oldBytes ? Buffer.from(oldBytes) : Buffer.from(capture.prepared!.next.bytes)
        if (substitution === 'bytes') {
          replacement = Buffer.from(`${JSON.stringify({ ...JSON.parse(replacement.toString()), admissionDigest: 'f'.repeat(64) })}\n`)
          writeFileSync(path, replacement)
        } else {
          writeFileSync(`${path}.substitution`, replacement, { mode: 0o600 })
          renameSync(`${path}.substitution`, path)
        }
        replacementInode = lstatSync(path).ino
      }
      capture = publicationCapture(path, { duringCustodyPrepare: boundary === 'custody' ? substitute : undefined })
      const wal = new HostedApprovalOwnerWal(path, {
        afterWalTempFsync: boundary === 'staging' ? async () => { await Promise.resolve(); substitute() } : undefined,
        afterWalRename: async () => { renamed = true },
      }, capture.producer)
      await expect(new HostedApprovalOwnerStore(wal).reconcileAdmission({ ...admissionFixture(), digest: 'd'.repeat(64) }))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      expect(renamed).toBe(false)
      expect(readFileSync(path)).toEqual(replacement)
      expect(lstatSync(path).ino).toBe(replacementInode)
      if (substitution === 'inode') expect(replacementInode).not.toBe(oldInode)
      if (substitution === 'bytes') expect(replacementInode).toBe(oldInode)
      expect(capture.prepared).toBeDefined()
      expect(capture.bound).toBeUndefined()
      expect(capture.lines.map(line => line.recordType)).toEqual(['producer-open'])
      expect(readdirSync(join(path, '..')).filter(name => name.startsWith('owner.json.tmp.'))).toEqual([])
      capture.producer.close()
    }
  })

  test('quarantine requires an exact predecessor tuple/semantic witness and a canonical observation', async () => {
    const observed = state().ingress[0]!
    for (const mismatch of ['first', 'team', 'run', 'request', 'semantic'] as const) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      const fixture = state(); fixture.ingress = []
      if (mismatch === 'first') fixture.bindings = []
      else {
        const binding = fixture.bindings[0]!; binding.bindingDigest = 'e'.repeat(64)
        if (mismatch === 'team') binding.teamId = `team_${'9'.repeat(32)}`
        if (mismatch === 'run') binding.runId = `run_${'9'.repeat(32)}`
        if (mismatch === 'request') binding.requestId = 'permission_other'
        if (mismatch === 'semantic') binding.effectRef = `effect:${'9'.repeat(64)}`
      }
      await setup.locked(current => setup.publish(current, withoutRevision(fixture)))
      const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      const bytes = readFileSync(path)
      await expect(wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), bindings: [...current!.bindings, {
        ...state().bindings[0]!, quarantined: true,
      }] }, { operationNonce: 'e'.repeat(64), mutation: { kind: 'binding-quarantined', outcome: 'quarantined' }, record: observed })))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced', message: 'Hosted approval quarantine publication witness mismatch' })
      expect(readFileSync(path)).toEqual(bytes)
      expect(capture.prepared).toBeUndefined()
      expect(await new HostedApprovalOwnerStore(wal).admitIngress(admissionFixture(), observed)).toBe('admitted')
      expect(capture.bound!.native.mutation.kind).toBe('ingress-admitted')
      capture.producer.close()
    }
    for (const predecessor of ['exposed', 'quarantined', 'tombstone'] as const) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      const fixture = state(); fixture.ingress = []
      fixture.bindings[0] = { ...fixture.bindings[0]!, bindingDigest: predecessor === 'tombstone' ? null : 'e'.repeat(64),
        effectRef: predecessor === 'tombstone' ? null : observed.effectRef, quarantined: predecessor !== 'exposed' }
      await setup.locked(current => setup.publish(current, withoutRevision(fixture)))
      const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      const store = new HostedApprovalOwnerStore(wal)
      for (const bad of [{ ...observed, deliveryRef: 'delivery_ref_wrong' }, { ...observed, payloadJson: '{}' },
        { ...observed, authority: { ...observed.authority, runtimeInstanceId: 'runtime_wrong' } }]) {
        await expect(wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), bindings: [
          ...current!.bindings, { ...state().bindings[0]!, quarantined: true },
        ] }, { operationNonce: 'e'.repeat(64), mutation: { kind: 'binding-quarantined', outcome: 'quarantined' }, record: bad })))
          .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      }
      expect(capture.lines).toHaveLength(1)
      expect(await store.admitIngress(admissionFixture(), observed)).toBe('quarantined')
      expect(capture.bound!.native.mutation.kind).toBe('binding-quarantined')
      expect((await wal.read())!.ingress).toEqual([])
      expect(await store.admitIngress(admissionFixture(), observed)).toBe('quarantined')
      expect(capture.lines).toHaveLength(2)
      capture.producer.close()
    }
  })

  test('initial starts and direct rejections bind the entire original request and fingerprint', async () => {
    for (const phase of ['started', 'rejected'] as const) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      const fixture = state(); const first = fixture.ingress[0]!
      const second = { ...structuredClone(first), commandId: 'permission_2', outboxId: `runtime_permission:effect:${'e'.repeat(64)}`,
        deliveryRef: `delivery_ref_opencode-${'e'.repeat(64)}`, effectRef: `effect:${'d'.repeat(64)}` }
      second.payloadJson = JSON.stringify({ ...JSON.parse(second.payloadJson), deliveryRef: second.deliveryRef })
      fixture.ingress.push(second)
      fixture.bindings.push({ ...fixture.bindings[0]!, requestId: second.commandId, bindingDigest: 'e'.repeat(64), effectRef: second.effectRef })
      await setup.locked(current => setup.publish(current, withoutRevision(fixture)))
      const initial = initialDeliveryWitness(first)
      const delivery: HostedApprovalOwnerState['deliveries'][number] = { providerDeliveryId: initial.request.providerDeliveryId,
        reconciliationRef: initial.request.reconciliationRef, payloadFingerprint: initial.payloadFingerprint,
        outboxId: first.outboxId, deliveryRef: first.deliveryRef, effectRef: first.effectRef, phase, result: phase === 'started' ? null : 'expired' }
      const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      const publish = (candidate: typeof delivery, witness: OwnerWalInitialDeliveryWitness) => wal.locked(current => wal.publishMutation(current, {
        ...withoutRevision(current!), deliveries: [candidate],
      }, phase === 'started'
        ? { operationNonce: 'a'.repeat(64), mutation: { kind: 'delivery-started', outcome: 'started' }, delivery: candidate, initial: witness }
        : { operationNonce: 'a'.repeat(64), mutation: { kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' }, delivery: candidate, initial: witness }))
      const before = readFileSync(path)
      // A's provider ID/reconciliation/fingerprint crossed with B's internally
      // coherent outbox/delivery/effect tuple used to pass every decoder.
      await expect(publish({ ...delivery, outboxId: second.outboxId, deliveryRef: second.deliveryRef, effectRef: second.effectRef }, initial))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      for (const patch of [{ approvalId: `approval_${'f'.repeat(32)}` }, { approvalGeneration: `generation_runtime-permission-${'f'.repeat(64)}` },
        { requestId: second.commandId }, { partition: { ...initial.request.partition, runId: `run_${'9'.repeat(32)}` } }]) {
        const request = { ...initial.request, ...patch }; const payloadFingerprint = fingerprintHostedApprovalDelivery(request)
        await expect(publish({ ...delivery, payloadFingerprint }, { request, payloadFingerprint })).rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      }
      await expect(publish({ ...delivery, payloadFingerprint: 'f'.repeat(64) }, { ...initial, payloadFingerprint: 'f'.repeat(64) }))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      expect(readFileSync(path)).toEqual(before)
      expect(capture.lines).toHaveLength(1)
      await publish(delivery, initial)
      expect(capture.bound!.native.mutation.kind).toBe(phase === 'started' ? 'delivery-started' : 'delivery-settled')
      expect((await wal.read())!.deliveries).toEqual([delivery])
      capture.producer.close()
    }
  })

  test('initial started and direct rejected publications preserve the accepted reconciliation reference domain', async () => {
    for (const phase of ['started', 'rejected'] as const) for (const suffix of ['1', 'Z.Mixed_case-9', 'A'.repeat(192)]) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      const fixture = state(); const record = fixture.ingress[0]!
      await setup.locked(current => setup.publish(current, withoutRevision(fixture)))
      const capture = publicationCapture(path); const wal = new HostedApprovalOwnerWal(path, undefined, capture.producer)
      const request = { ...initialDeliveryWitness(record).request, reconciliationRef: `approval-reconciliation_${suffix}` }
      const initial = { request, payloadFingerprint: fingerprintHostedApprovalDelivery(request) }
      const delivery: HostedApprovalOwnerState['deliveries'][number] = { providerDeliveryId: request.providerDeliveryId,
        reconciliationRef: request.reconciliationRef, payloadFingerprint: initial.payloadFingerprint,
        deliveryRef: record.deliveryRef, outboxId: record.outboxId, effectRef: record.effectRef,
        phase, result: phase === 'started' ? null : 'expired' }
      const publish = (candidate: typeof delivery, witness: OwnerWalInitialDeliveryWitness) => wal.locked(current => wal.publishMutation(current, {
        ...withoutRevision(current!), deliveries: [candidate],
      }, phase === 'started'
        ? { operationNonce: 'a'.repeat(64), mutation: { kind: 'delivery-started', outcome: 'started' }, delivery: candidate, initial: witness }
        : { operationNonce: 'a'.repeat(64), mutation: { kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' }, delivery: candidate, initial: witness }))
      const before = readFileSync(path)
      for (const reconciliationRef of ['approval-reconciliation_', 'approval-reconciliation_.x', 'approval-reconciliation_-x',
        'approval-reconciliation_x:y', 'approval-reconciliation_x/y', 'approval-reconciliation_é',
        'approval-reconciliation_x y', 'other_1', `approval-reconciliation_${'A'.repeat(193)}`]) {
        const invalidRequest = { ...request, reconciliationRef }
        const payloadFingerprint = fingerprintHostedApprovalDelivery(invalidRequest)
        await expect(publish({ ...delivery, reconciliationRef, payloadFingerprint }, { request: invalidRequest, payloadFingerprint }))
          .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      }
      // Valid references still require the exact original request and fingerprint.
      const changedRequest = { ...request, reconciliationRef: 'approval-reconciliation_other' }
      await expect(publish(delivery, { request: changedRequest, payloadFingerprint: fingerprintHostedApprovalDelivery(changedRequest) }))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      await expect(publish({ ...delivery, payloadFingerprint: 'f'.repeat(64) }, { ...initial, payloadFingerprint: 'f'.repeat(64) }))
        .rejects.toMatchObject({ stage: 'definitely-not-replaced' })
      expect(readFileSync(path)).toEqual(before)
      expect(capture.lines).toHaveLength(1)
      await publish(delivery, initial)
      expect((await wal.read())!.deliveries).toEqual([delivery])
      expect(capture.bound!.native.mutation.kind).toBe(phase === 'started' ? 'delivery-started' : 'delivery-settled')
      capture.producer.close()
    }
  })

  test('native receipt owns nonce, mutation claims and every nested count across preparation and emission', async () => {
    const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
    await setup.locked(current => setup.publish(current, withoutRevision(state())))
    const capture = publicationCapture(path)
    let expected!: OwnerWalNative; let operationNonce = ''
    const wal = new HostedApprovalOwnerWal(path, { afterWalRename: async () => {
      const input = capture.prepared!
      expected = structuredClone(input.native); operationNonce = input.intent.operationNonce
      Reflect.set(input.intent, 'operationNonce', 'f'.repeat(64))
      if (input.native.mutation.kind !== 'ingress-lease-claimed') throw new Error('expected native lease claim')
      Reflect.set(input.native.mutation.claims[0]!, 'leaseToken', 'lease_substituted')
      for (const pair of Object.values(input.native.stateDelta.collectionSizes)) Reflect.set(pair, 'next', 99)
      await Promise.resolve()
    } }, capture.producer)
    await new HostedApprovalOwnerStore(wal, () => Date.parse('2026-08-13T10:00:01.000Z')).claim(
      { ownerId: 'owner_1', leaseToken: 'lease_1', leaseDurationMs: 30_000, limit: 1 }, 1_000_000)
    const bound = capture.bound!; const line = capture.lines[1]!
    expect(line.native).toEqual(expected)
    expect(line.operationNonce).toBe(operationNonce)
    expect(bound.native).toEqual(line.native)
    expect(bound.emission.operationNonce).toBe(operationNonce)
    expect(bound.emission.lineSha256).toBe(createHash('sha256').update(`${JSON.stringify(line)}\n`).digest('hex'))
    const assertFrozen = (value: unknown) => {
      if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true)
        for (const child of Object.values(value)) assertFrozen(child)
      }
    }
    assertFrozen(bound.native); assertFrozen(bound.emission)
    expect(Reflect.set(bound.native.stateDelta.collectionSizes.ingress, 'next', 99)).toBe(false)
    if (bound.native.mutation.kind !== 'ingress-lease-claimed') throw new Error('expected bound lease claim')
    expect(Reflect.set(bound.native.mutation.claims[0]!, 'leaseToken', 'lease_mutated')).toBe(false)
    expect((await wal.read())!.ingress[0]!.lease!.leaseToken).toBe('lease_1')
    expect(bound.native).toEqual(line.native)
    capture.producer.close()
  })

  test('outer cleanup attempts all releases and retains typed stage after direct rejection or start', async () => {
    for (const phase of ['started', 'rejected'] as const) for (const failures of [['parent'], ['fence', 'unlock', 'lock', 'parent']]) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      await setup.locked(current => setup.publish(current, withoutRevision(state())))
      const initial = initialDeliveryWitness(state().ingress[0]!)
      const record = state().ingress[0]!
      const delivery: HostedApprovalOwnerState['deliveries'][number] = { providerDeliveryId: initial.request.providerDeliveryId,
        reconciliationRef: initial.request.reconciliationRef, deliveryRef: record.deliveryRef, outboxId: record.outboxId,
        effectRef: record.effectRef, payloadFingerprint: initial.payloadFingerprint, phase, result: phase === 'started' ? null : 'expired' }
      const capture = publicationCapture(path); let armed = true; const releases: string[] = []
      const wal = new HostedApprovalOwnerWal(path, { releaseWriterResource: async (resource, release) => {
        if (armed && releases.some(released => failures.includes(released))) expect(capture.producer.isHealthy()).toBe(false)
        await release()
        if (armed) { releases.push(resource); if (failures.includes(resource)) throw new Error(`release ${resource} failed`) }
      } }, capture.producer)
      let error: unknown
      try {
        await wal.locked(current => wal.publishMutation(current, { ...withoutRevision(current!), deliveries: [delivery] }, phase === 'started'
          ? { operationNonce: 'e'.repeat(64), mutation: { kind: 'delivery-started', outcome: 'started' }, delivery, initial }
          : { operationNonce: 'e'.repeat(64), mutation: { kind: 'delivery-settled', phase: 'rejected', outcome: 'expired' }, delivery, initial }))
      } catch (failure) { error = failure }
      expect(error).toBeInstanceOf(HostedApprovalOwnerPublicationError)
      expect(error).toMatchObject({ stage: 'published-capture-failed' })
      expect(((error as Error).cause as AggregateError).errors.map(failure => failure.message))
        .toEqual(failures.map(resource => `release ${resource} failed`))
      expect(releases).toEqual(['fence', 'unlock', 'lock', 'parent'])
      expect(capture.bound!.native.mutation.kind).toBe(phase === 'started' ? 'delivery-started' : 'delivery-settled')
      expect(capture.producer.isHealthy()).toBe(false)
      expect((await wal.read())!.deliveries).toEqual([delivery])
      armed = false
      await wal.locked(async current => { expect(await wal.prepareEffectToken(current!)).toBeNull() })
      expect(capture.lines).toHaveLength(2)
    }
  })

  test('cleanup aggregates preserve the original failure before and after the replacement boundary', async () => {
    for (const boundary of ['acquisition', 'replacement'] as const) {
      const { path } = await walPath(); const setup = new HostedApprovalOwnerWal(path)
      await new HostedApprovalOwnerStore(setup).reconcileAdmission(admissionFixture())
      const capture = publicationCapture(path); let armed = true; const releases: string[] = []
      const fail = async () => { if (armed) throw new Error(`${boundary} failed`) }
      const wal = new HostedApprovalOwnerWal(path, {
        afterFenceOpen: boundary === 'acquisition' ? fail : undefined,
        afterWalRename: boundary === 'replacement' ? fail : undefined,
        releaseWriterResource: async (resource, release) => {
          await release()
          if (armed) { releases.push(resource); throw new Error(`release ${resource} failed`) }
        },
      }, capture.producer)
      let error: unknown
      try { await new HostedApprovalOwnerStore(wal).reconcileAdmission({ ...admissionFixture(), digest: 'd'.repeat(64) }) }
      catch (failure) { error = failure }
      expect(releases).toEqual(['fence', 'unlock', 'lock', 'parent'])
      if (boundary === 'replacement') expect(error).toMatchObject({ stage: 'replacement-uncertain' })
      const aggregate = boundary === 'replacement' ? (error as Error).cause : error
      expect(aggregate).toBeInstanceOf(AggregateError)
      expect((aggregate as AggregateError).errors).toHaveLength(5)
      expect((aggregate as AggregateError).errors[0]).toBeInstanceOf(Error)
      expect(capture.lines).toHaveLength(1)
      expect(capture.producer.isHealthy()).toBe(boundary === 'acquisition')
      armed = false
      await wal.locked(async current => { expect(current?.revision).toBe(boundary === 'acquisition' ? 1 : 2) })
      if (boundary === 'acquisition') capture.producer.close()
    }
  })
})

function initialDeliveryWitness(record: HostedApprovalIngressRecord): OwnerWalInitialDeliveryWitness {
  const { teamId, runId } = record.authority
  const request = {
    providerDeliveryId: 'delivery_1', reconciliationRef: `approval-reconciliation_${'4'.repeat(64)}`,
    principal: { kind: 'operator' as const, actorId: 'actor_operator' }, deliveryRef: record.deliveryRef,
    approvalId: `approval_${createHash('sha256').update(JSON.stringify({ schemaVersion: 1,
      teamId, runId, requestId: record.commandId })).digest('hex').slice(0, 32)}`,
    approvalGeneration: `generation_runtime-permission-${record.effectRef.slice(7)}`,
    decision: 'allow' as const, partition: { teamId, runId }, requestId: record.commandId,
  }
  return { request, payloadFingerprint: fingerprintHostedApprovalDelivery(request) }
}

function state(): HostedApprovalOwnerState {
  const effectRef = `effect:${'c'.repeat(64)}`
  const bindingDigest = 'b'.repeat(64)
  const deliveryRef = `delivery_ref_opencode-${bindingDigest}`
  const ingress = {
    outboxVersion: 2 as const, outboxId: `runtime_permission:effect:${bindingDigest}`,
    commandId: 'permission_1', effectRef, deliveryRef, authority: structuredClone(route.authority),
    payloadJson: JSON.stringify({
      schemaVersion: 1, deliveryRef, category: 'command', summary: 'Run tests',
      expiresAtMs: null, preview: null,
    }),
    observedAtIso: '2026-08-13T10:00:00.000Z', acceptedAtIso: '2026-08-13T10:00:00.000Z',
    lease: null, acknowledgedAtIso: null,
  }
  return {
    schemaVersion: 3 as const, revision: 1, admissionGeneration: 'approval-admission-generation_1',
    admissionDigest: 'a'.repeat(64), routes: [structuredClone(route)],
    writerFence: { generation: `approval-writer-fence_${'a'.repeat(32)}`, dev: '1', ino: '1' },
    actorMembers: { actor_owner: route.authority.deliveryOwnerId, actor_operator: `member_${'8'.repeat(32)}` },
    ingress: [ingress], retiredIngress: [], bindings: [{
      teamId: route.authority.teamId, runId: route.authority.runId, requestId: ingress.commandId,
      effectRef, bindingDigest, quarantined: false,
    }], deliveries: [],
  }
}

function withoutRevision(value: HostedApprovalOwnerState) { const { revision: _revision, writerFence: _writerFence, ...rest } = value; return rest }
function stateFixture() { return state() }
async function walPath() { const root = await mkdtemp(join(tmpdir(), 'approval-owner-r3-wal-')); roots.push(root); return { path: join(root, 'owner.json') } }

function fakeDarwinSpawnNative(calls: unknown[][], overrides: {
  initError?: number
  chdirError?: number
  openError?: number
  spawnError?: number
  pid?: number
  waits?: Array<{ result: number; status: number; errno: number }>
  destroyError?: number
} = {}): DarwinSpawnNative {
  const actions = Symbol('actions')
  const pid = overrides.pid ?? 73
  const waits = [...(overrides.waits ?? [{ result: pid, status: 0, errno: 0 }])]
  return {
    initActions: () => { calls.push(['init']); return { actions, error: overrides.initError ?? 0 } },
    addChdir: (actual, parentFd) => {
      expect(actual).toBe(actions); calls.push(['chdir', parentFd]); return overrides.chdirError ?? 0
    },
    addOpen: (actual, targetFd, name, flags, mode) => {
      expect(actual).toBe(actions); calls.push(['open', targetFd, name, flags, mode]); return overrides.openError ?? 0
    },
    spawn: (actual, executable) => {
      expect(actual).toBe(actions); calls.push(['spawn', executable])
      return { error: overrides.spawnError ?? 0, pid }
    },
    waitPid: actualPid => {
      calls.push(['wait', actualPid])
      const waited = waits.shift()
      if (!waited) throw new Error('unexpected extra waitPid call')
      return waited
    },
    destroyActions: actual => {
      expect(actual).toBe(actions); calls.push(['destroy']); return overrides.destroyError ?? 0
    },
  }
}
