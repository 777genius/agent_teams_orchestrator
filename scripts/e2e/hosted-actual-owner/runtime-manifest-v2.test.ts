import { describe, expect, test } from 'bun:test'
import { parseAcceptanceInvocation } from './invocation.js'
import { parseOwnerRuntimeManifestV2, parseOwnerV2Invocation, OWNER_V2_INVOCATION } from './runtime-manifest-v2.js'
import type { OwnerV2LaunchSelection } from '../../../src/services/hostedControl/HostedControlBootstrapV2Launch.js'
import { HOSTED_CONTROL_BOOTSTRAP_FD, HOSTED_CONTROL_LIVENESS_FD, HOSTED_CONTROL_LAUNCHER_LEASE_FD } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import { hashV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'
import { fixtureHeaderV2 } from '../../../src/services/hostedControl/fixtures/bootstrapV2Producer.js'
import { HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 } from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'

// Exact SupervisorPlan.runtimeManifest object built by Product processes.ts;
// the old parseActualOwnerRuntimeManifest's harnessRunId shape is different.
function sourceManifest() {
  const refs = { openCode: '1'.repeat(40), openCodeExecutableSha256: '9'.repeat(64), orchestrator: '2'.repeat(40), product: '3'.repeat(40) }
  const value = { schemaVersion: 1, purpose: 'agent-teams.hosted-actual-owner-e2e/v1', runId: '1'.repeat(64),
    sandboxRoot: '/sandbox', markerPath: '/sandbox/.p3c-sandbox.json', evidenceRoot: '/sandbox/evidence',
    driverBaseUrl: 'http://127.0.0.1:45130/', productBaseUrl: 'http://127.0.0.1:45131/', approvalPath: '/api/hosted/v1/team-approvals/decisions',
    browser: { workers: 1, retries: 0 }, capture: Object.fromEntries(['conditionalPostLedgerPath', 'negativeResultsPath',
      'openCodeTimelinePath', 'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath'].map(k => [k, `/sandbox/capture/${k}.ndjson`])),
    captureEmissionContract: { contract: 'claude-team/hosted-producer-provenance', version: 2, contractSha256: HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256,
      environment: 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2', framing: 'canonical-ndjson', descriptorSlots: { ownerWalTimeline: 9,
        conditionalPostLedger: 9, productTimeline: 10, negativeResults: 9, openCodeTimeline: 9, protectedEffectLedger: 10 },
      verifierMayProduceBytes: false, producerNativeIdentitiesComposed: false }, refs }
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  // Parser-only projection. It never constructs a bootstrap/custody admission.
  const selected = { expectedHost: fixtureHeaderV2().expectedHost, refs,
    runtimeManifestSha256: hashV2(bytes) } as unknown as OwnerV2LaunchSelection
  return { value, bytes, selected }
}
describe('explicit Owner v2 invocation and actual Product manifest', () => {
  test('v2 cannot enter legacy contract argv; v1 defaults and legacy 6/7/8 remain exact', () => {
    expect([HOSTED_CONTROL_LAUNCHER_LEASE_FD, HOSTED_CONTROL_LIVENESS_FD, HOSTED_CONTROL_BOOTSTRAP_FD]).toEqual([3, 4, 5])
    const args = [OWNER_V2_INVOCATION, '--runtime-manifest', '/sandbox/runtime-manifest.json']
    expect(parseOwnerV2Invocation(args)).toBe('/sandbox/runtime-manifest.json')
    expect(() => parseAcceptanceInvocation(args)).toThrow()
    for (const bad of [args.slice(1), [args[0].replace('v2', 'v1'), ...args.slice(1)], [...args, '--bootstrap-fd', '8'],
      [args[0], args[1], '/sandbox/../sandbox/runtime-manifest.json']]) expect(() => parseOwnerV2Invocation(bad)).toThrow()
    expect(parseAcceptanceInvocation(['--runtime-manifest', '/legacy', '--actual-owner-contract', '/contract',
      '--actual-owner-contract-sha256', 'digest', '--actual-owner-contract-byte-count', '1', '--launcher-lease-fd', '6',
      '--liveness-fd', '7', '--bootstrap-fd', '8']).bootstrapFds).toEqual({ launcherLeaseFd: 6, livenessFd: 7, bootstrapFd: 8 })
  })
  test('uses selected refs/digest and the closed current Product shape', () => {
    const f = sourceManifest()
    expect(parseOwnerRuntimeManifestV2(f.bytes, f.selected).runId).toBe(f.value.runId)
    expect(() => parseOwnerRuntimeManifestV2(f.bytes, { ...f.selected, refs: { ...f.selected.refs, product: '0'.repeat(40) } })).toThrow()
    for (const mutate of [
      (v: any) => { v.harnessRunId = v.runId; delete v.runId },
      (v: any) => { v.refs.openCodeExecutableSha256 = '0'.repeat(64) },
      (v: any) => { v.captureEmissionContract.descriptorSlots.ownerWalTimeline = 11 },
      (v: any) => { v.descriptors = {} },
    ]) {
      const value = structuredClone(f.value); mutate(value); const bytes = Buffer.from(JSON.stringify(value))
      expect(() => parseOwnerRuntimeManifestV2(bytes, { ...f.selected, runtimeManifestSha256: hashV2(bytes) })).toThrow()
    }
  })
})
