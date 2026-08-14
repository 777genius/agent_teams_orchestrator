import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { buildAcceptanceEvidence, productTimelineLine, validateAcceptanceEvidence, validateProductTimelineEvent } from './evidence.js'

const config = {
  admissionFile: '/tmp/sandbox/team/hosted-approval-runtime-admission.v1.json',
  controlSocket: '/tmp/sandbox/control.sock', evidenceFile: '/tmp/sandbox/evidence.json',
  markerPath: '/tmp/sandbox/marker',
  openCodeExecutable: '/opt/opencode', openCodeSha256: 'a'.repeat(64),
  productRoot: '/product',
  productPublicationTimeoutMs: 30_000,
  repositoryRoot: '/repo', runtimeManifestPath: '/tmp/sandbox/manifest.json',
  runtimeManifestIdentity: {
    device: '1', inode: '6', size: '3', mtimeNs: '4', ctimeNs: '5',
    mode: '384', nlink: '1', uid: '1000',
  },
  runtimeManifestSha256: 'f'.repeat(64),
  sandboxRoot: '/tmp/sandbox', walFile: '/tmp/sandbox/team/hosted-approval-owner.v1.json',
  runtime: {
    schemaVersion: 1 as const, purpose: 'agent-teams.hosted-actual-owner-e2e/v1' as const,
    runId: 'b'.repeat(48), sandboxRoot: '/tmp/sandbox', markerPath: '/tmp/sandbox/marker',
    capture: { ownerWalTimelinePath: '/tmp/sandbox/owner.ndjson' },
    descriptors: {
      sandboxRoot: { token: '${SANDBOX_ROOT}', path: '/tmp/sandbox', device: '1', inode: '2', mode: '448', uid: '1000' },
      productRoot: { token: '${PRODUCT_ROOT}', path: '/product', device: '1', inode: '3', mode: '493', uid: '1000' },
      orchestratorRoot: { token: '${ORCHESTRATOR_ROOT}', path: '/repo', device: '1', inode: '4', mode: '493', uid: '1000' },
      openCodeExecutable: { token: '${OPENCODE_EXECUTABLE}', path: '/opt/opencode', device: '1', inode: '5', mode: '493', uid: '1000', size: '42', sha256: 'a'.repeat(64) },
    },
    refs: { openCode: 'c'.repeat(40), openCodeExecutableSha256: 'a'.repeat(64),
      orchestrator: 'd'.repeat(40), product: 'e'.repeat(40) },
  },
}

describe('hosted actual-owner acceptance evidence', () => {
  test('emits the exact machine-readable readiness and decision-control schema', () => {
    const identity = {
      device: '1', inode: '2', size: '3', mtimeNs: '4', ctimeNs: '5',
      mode: '384', nlink: '1', uid: '1000',
    }
    const evidence = buildAcceptanceEvidence({
      config, status: 'ready',
      ownerProcessStartIdentity: '42',
      admission: { digest: '1'.repeat(64), admissionGeneration: 'approval-admission-generation_test' },
      ownerSocket: '/tmp/sandbox/owner.sock',
      state: { revision: 1, ingress: [], deliveries: [], writerFence: {
        generation: `approval-writer-fence_${'2'.repeat(32)}`, dev: '1', ino: '2',
      } },
      publication: { admission: { ...identity, inode: '6' } },
      bootstrap: { bootstrapBinding: {
        bootstrapDigest: '3'.repeat(64), ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
      } } as never,
      configSha256: '5'.repeat(64), controlSocketIdentity: identity,
      ownerSocketIdentity: identity, walIdentity: identity,
      walSha256: '6'.repeat(64), stateSha256: '7'.repeat(64),
      timeline: { identity, sha256: 'b'.repeat(64), bytes: 42, eventCount: 1, lastSequence: 0 },
      providers: [{
        routeId: 'route_test', sessionId: 'session_test',
        sessionRecordFingerprint: '8'.repeat(64), liveEffectFingerprint: '9'.repeat(64),
        executable: '/opt/opencode', executableDevice: '1', executableInode: '9',
        executableSha256: 'a'.repeat(64), pid: 42, processStartIdentity: '100',
        processStartedAtMs: 1,
      }],
    })
    expect(validateAcceptanceEvidence(evidence)).toEqual(evidence)
    expect(evidence.publication.admission?.inode).toBe('6')
    expect(evidence.owner.decisionOperations).toEqual([
      'approval_decision_deliver', 'approval_decision_reconcile',
    ])
  })

  test('rejects schema extension and non-sha256 artifact identity', () => {
    const evidence = buildAcceptanceEvidence({ config, status: 'ready' })
    expect(() => validateAcceptanceEvidence({ ...evidence, enabled: true })).toThrow(/evidence_invalid/)
    expect(() => validateAcceptanceEvidence({ ...evidence, artifact: { ...evidence.artifact, sha256: 'nope' } }))
      .toThrow(/evidence_invalid/)
  })

  test('rejects duplicate route/session provider evidence', () => {
    const evidence = buildAcceptanceEvidence({ config, status: 'starting' })
    const provider = {
      routeId: 'route_1', sessionId: 'session_1', sessionRecordFingerprint: 'a'.repeat(64),
      liveEffectFingerprint: 'b'.repeat(64), executable: evidence.artifact.executable,
      executableDevice: '1', executableInode: '2', executableSha256: 'a'.repeat(64),
      pid: 1, processStartIdentity: '1', processStartedAtMs: 1,
    }
    expect(() => validateAcceptanceEvidence({ ...evidence, providers: [provider, provider] }))
      .toThrow(/acceptance_evidence_invalid/)
  })

  test('matches the product owner-WAL discriminated union', () => {
    for (const event of ['poll_ingress', 'reconcile_operator_required']) {
      expect(validateProductTimelineEvent({
        schemaVersion: 1, runId: 'b'.repeat(48), sequence: 1,
        at: '2026-08-14T00:00:00.000Z', event,
        approvalId: null,
        generation: 'generation_test',
      }).event).toBe(event)
    }
    expect(() => validateProductTimelineEvent({
      schemaVersion: 1, runId: 'b'.repeat(48), sequence: 1,
      at: '2026-08-14T00:00:00.000Z', event: 'ingress_durable', approvalId: null,
      generation: 'generation_test',
    })).toThrow(/timeline_event_invalid/)
    expect(() => validateProductTimelineEvent({
      schemaVersion: 1, runId: 'b'.repeat(48), sequence: 1,
      at: '2026-08-14T00:00:00.000Z', event: 'poll_ingress',
      approvalId: `approval_${'a'.repeat(32)}`, generation: 'generation_test',
    })).toThrow(/timeline_event_invalid/)
    for (const event of [
      'restart_checkpoint:after_owner_ingress_before_product_ack',
      'negative_observed:artifact_rotation:stale',
    ]) {
      expect(validateProductTimelineEvent({
        schemaVersion: 1, at: '2026-08-14T00:00:00.000Z',
        approvalId: `approval_${'a'.repeat(32)}`, event, generation: 'generation_test',
        runId: 'b'.repeat(48), sequence: 0,
      }).event).toBe(event)
    }
  })

  test('accepts the shared cross-harness owner-WAL fixture', async () => {
    const raw = await readFile(new URL('./product-owner-wal.fixture.ndjson', import.meta.url), 'utf8')
    const events = raw.trimEnd().split('\n').map(line => validateProductTimelineEvent(JSON.parse(line)))
    expect(Buffer.concat(events.map(productTimelineLine)).toString('utf8')).toBe(raw)
    expect(events.map(event => [event.event, event.approvalId])).toEqual([
      ['ingress_durable', `approval_${'a'.repeat(32)}`],
      ['poll_ingress', null],
      ['reconcile_operator_required', null],
    ])
  })
})
