import { describe, expect, test } from 'bun:test'
import { buildAcceptanceEvidence, validateAcceptanceEvidence } from './evidence.js'

const config = {
  admissionFile: '/tmp/sandbox/team/hosted-approval-runtime-admission.v1.json',
  controlSocket: '/tmp/sandbox/control.sock', evidenceFile: '/tmp/sandbox/evidence.json',
  hostedControlConfig: '/tmp/sandbox/config.json', markerPath: '/tmp/sandbox/marker',
  openCodeExecutable: '/opt/opencode', openCodeSha256: 'a'.repeat(64),
  productRoot: '/product',
  productPublicationTimeoutMs: 30_000,
  repositoryRoot: '/repo', runtimeManifestPath: '/tmp/sandbox/manifest.json',
  sandboxRoot: '/tmp/sandbox', walFile: '/tmp/sandbox/team/hosted-approval-owner.v1.json',
  runtime: {
    schemaVersion: 1 as const, purpose: 'agent-teams.hosted-actual-owner-e2e/v1' as const,
    runId: 'b'.repeat(48), sandboxRoot: '/tmp/sandbox', markerPath: '/tmp/sandbox/marker',
    capture: { ownerWalTimelinePath: '/tmp/sandbox/owner.ndjson' },
    refs: { openCode: 'c'.repeat(40), openCodeExecutableSha256: 'a'.repeat(64),
      orchestrator: 'd'.repeat(40), product: 'e'.repeat(40) },
  },
}

describe('hosted actual-owner acceptance evidence', () => {
  test('emits the exact machine-readable readiness and decision-control schema', () => {
    const evidence = buildAcceptanceEvidence({ config, status: 'ready' })
    expect(validateAcceptanceEvidence(evidence)).toEqual(evidence)
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
})
