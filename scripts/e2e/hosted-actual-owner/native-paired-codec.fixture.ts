/** Root-executed paired regression seam. Pass the ACTUAL accepted Product
 * module exports under its own alias-resolving loader; no copied mock decoder.
 * This file neither loads Product nor runs/signs anything at import time. */
import assert from 'node:assert/strict'
import { canonicalJson } from './native-http-contract.js'
import { decodeNativeAllocation } from './native-operation-allocation.js'
import { decodeNativeLaunchAdmission, nativeLaunchAdmissionSigningBytes, verifyNativeLaunchAdmission,
  type NativeAdmissionStatement, type NativeLaunchAdmission } from './native-admission-codec.js'
import { decodeSelectedLaunchPhase } from '../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'
import { pairedNativeCodecVectors, fixtureSign } from './native-admission.fixture.js'
import * as observations from './native-product-observation-codec.js'

export interface PairedProductCodecs {
  decodeNativeAllocation(value: unknown): unknown
  decodeNativeLaunchAdmission(value: unknown): unknown
  nativeLaunchAdmissionSigningBytes(value: NativeAdmissionStatement): Buffer
  verifyNativeLaunchAdmission(value: unknown, key: string, launch: Readonly<Record<string, unknown>>, sealed: unknown): unknown
  encodeSelectedLaunchPhase(launch: Readonly<Record<string, unknown>>, sealed: unknown, admission: NativeLaunchAdmission): Buffer
}

export function assertPairedProductObservationCodecs(product: Pick<typeof observations,
  'parseHostedTeamApprovalPageRequest' | 'parseHostedTeamApprovalPreviewRequest' |
  'parseHostedTeamApprovalPage' | 'deriveRuntimePermissionApprovalIdentity'>): void {
  const input = { teamId: `team_${'1'.repeat(32)}`, runId: `run_${'9'.repeat(32)}`,
    requestId: 'pending', effectRef: `effect:${'7'.repeat(64)}` }
  const identity = observations.deriveRuntimePermissionApprovalIdentity(input)
  assert.deepEqual(product.deriveRuntimePermissionApprovalIdentity(input), identity)
  const request = { schemaVersion: 1, teamId: input.teamId, expectedRunId: input.runId, cursor: null, limit: 20 }
  for (const value of [request, { ...request, limit: 51 }, { ...request, cursor: 'cursor_1' },
    { ...request, cursor: 'cursor_' + 'x'.repeat(250) }, { ...request, teamId: input.teamId + '\n' },
    { ...request, expectedRunId: input.runId + '\n' }, { ...request, extra: 1 }])
    assert.deepEqual(product.parseHostedTeamApprovalPageRequest(value), observations.parseHostedTeamApprovalPageRequest(value))
  const preview = { schemaVersion: 1, teamId: input.teamId, expectedRunId: input.runId,
    approvalId: identity.approvalId, expectedGeneration: identity.approvalGeneration, previewRef: 'approval_preview_later' }
  for (const value of [preview, { ...preview, previewRef: null }, { ...preview, extra: 1 }])
    assert.deepEqual(product.parseHostedTeamApprovalPreviewRequest(value), observations.parseHostedTeamApprovalPreviewRequest(value))
  const item = { teamId: input.teamId, runId: input.runId, approvalId: identity.approvalId,
    generation: identity.approvalGeneration, category: 'command', summary: 'Pending',
    requestedAtMs: 1, expiresAtMs: null, previewRef: preview.previewRef }
  const page = { schemaVersion: 1, kind: 'approval_page', teamId: input.teamId,
    items: [item], nextCursor: null, truncated: false,
    budget: { itemLimit: 20, byteLimit: 10000, timeLimitMs: 100, usedItems: 1, usedBytes: 500, elapsedMs: 1 } }
  for (const value of [page, { ...page, items: [item, item] }, { ...page, truncated: true },
    ...['itemLimit', 'byteLimit', 'timeLimitMs', 'usedItems', 'usedBytes', 'elapsedMs'].map(k =>
      ({ ...page, budget: { ...page.budget, [k]: -1 } })),
    { ...page, budget: { ...page.budget, usedItems: 2 } },
    { ...page, items: [{ ...item, summary: ' space ' }] },
    { ...page, items: [{ ...item, teamId: `team_${'2'.repeat(32)}` }] }])
    assert.deepEqual(product.parseHostedTeamApprovalPage(value), observations.parseHostedTeamApprovalPage(value))
}
export function assertPairedNativeCodecs(product: PairedProductCodecs): void {
  for (const v of pairedNativeCodecVectors()) {
    const { launch, sealed } = v.phase
    assert.deepEqual(product.decodeNativeAllocation(v.statement.allocation), decodeNativeAllocation(v.statement.allocation))
    assert.deepEqual(product.decodeNativeLaunchAdmission(v.admission), decodeNativeLaunchAdmission(v.admission))
    assert.equal(product.nativeLaunchAdmissionSigningBytes(v.statement).toString('hex'), v.signingBytesHex)
    const encoded = product.encodeSelectedLaunchPhase(launch, sealed, v.admission)
    assert.equal(encoded.toString('hex'), v.frameHex)
    assert.deepEqual(decodeSelectedLaunchPhase(encoded), v.phase)
    assert.deepEqual(product.verifyNativeLaunchAdmission(v.admission, v.launcherPublicKey, launch, sealed),
      verifyNativeLaunchAdmission(v.admission, v.launcherPublicKey, launch, sealed))
    const badAllocations = [
      { ...v.statement.allocation, entries: [] },
      { ...v.statement.allocation, entries: v.statement.allocation.entries.map(e => e.id === 'Apreview'
        ? { ...e, dependencies: ['Apage'] } : e) },
      { ...v.statement.allocation, entries: v.statement.allocation.entries.map(e => e.id === 'Apage'
        ? { ...e, operation: { ...e.operation, method: 'GET' } } : e) },
    ]
    for (const bad of badAllocations) {
      assert.throws(() => product.decodeNativeAllocation(bad)); assert.throws(() => decodeNativeAllocation(bad))
    }
    for (const bad of [undefined, { ...v.admission, extra: true },
      { ...v.admission, statement: { ...v.statement, scenario: {} } },
      { ...v.admission, statement: { ...v.statement, controllerDescriptor: JSON.stringify(v.statement.controllerDescriptor) } },
      { ...v.admission, statement: { ...v.statement, format: 'agent-teams.owner-native-launch-admission/v1' } }]) {
      assert.throws(() => product.decodeNativeLaunchAdmission(bad)); assert.throws(() => decodeNativeLaunchAdmission(bad))
    }
    const badDomain = { ...v.admission, signatureBase64url: fixtureSign(Buffer.from(canonicalJson(v.statement))) }
    for (const verify of [product.verifyNativeLaunchAdmission, verifyNativeLaunchAdmission]) {
      assert.throws(() => verify(badDomain, v.launcherPublicKey, launch, sealed))
      assert.throws(() => verify(v.admission, v.launcherPublicKey, { ...launch, bootstrapV2HeaderSha256: '0'.repeat(64) }, sealed))
    }
    assert.equal(nativeLaunchAdmissionSigningBytes(v.statement).toString('hex'), v.signingBytesHex)
  }
}
