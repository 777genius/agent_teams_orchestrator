import { createHash } from 'node:crypto'
import type { OpenCodeSessionRecord, OpenCodeSessionStopAuthority } from './types.js'

// Private extension of the Host's owned session store, not message commandStatus.
export const OPENCODE_STOP_RECOVERY_CONTRACT_VERSION = 1

export type OpenCodeStopTarget = {
  teamId: string
  laneId: string
  runId: string
  projectPath: string
  capabilitySnapshotId: string
  expectedBehaviorFingerprint: string
  // OpenCode session IDs identify the original generation, even within one run.
  members: { memberName: string; sessionId: string }[]
}
export type OpenCodeStopRequest = {
  contractVersion: 1
  originalRequestId: string
  idempotencyKey: string
  target: OpenCodeStopTarget
}
export type OpenCodeStopData = {
  runId: string
  stopped: boolean
  members: Record<string, { sessionId?: string; stopped: boolean; diagnostics: string[] }>
  warnings: string[]
  diagnostics: { code: string; severity: 'info' | 'warning' | 'error'; message: string }[]
  idempotencyKey?: string
  manifestHighWatermark: number | null
  runtimeStoreManifestHighWatermark: number | null
}
export type OpenCodeStopBinding = {
  memberName: string; sessionId: string; hostKey: string; createdAt: string
}
export type OpenCodeStopReceipt = {
  request: OpenCodeStopRequest
  binding: OpenCodeStopBinding[]
  runtime: OpenCodeSessionStopAuthority['runtime']
  status: 'inflight' | 'completed'
  data?: OpenCodeStopData
}
export type OpenCodeStopOutcome =
  | { status: 'completed'; receipt: OpenCodeStopReceipt & { data: OpenCodeStopData } }
  | { status: 'inflight' | 'unknown' | 'target_mismatch' }
export type OpenCodeStopReconciliation = {
  status: 'reconciled_stopped' | 'active' | 'unknown' | 'target_mismatch'
  // Current-state observation only. Never an original result or a reusable cleanup lease.
  target: OpenCodeStopTarget
  sessionSetToken?: string
  binding?: OpenCodeStopBinding[]
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Stop recovery object')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid Stop recovery identity')
  return value
}
export function parseOpenCodeStopRequest(value: unknown): OpenCodeStopRequest {
  const input = object(value)
  if (input.contractVersion !== 1) throw new Error('Unsupported OpenCode Stop recovery contract; version 1 required')
  const raw = object(input.target)
  if (!Array.isArray(raw.members) || !raw.members.length) throw new Error('Stop recovery requires the nonempty original session set')
  const members = raw.members.map(value => {
    const member = object(value)
    return { memberName: string(member.memberName), sessionId: string(member.sessionId) }
  }).sort((a, b) => a.memberName.localeCompare(b.memberName))
  if (new Set(members.map(member => member.memberName)).size !== members.length
    || new Set(members.map(member => member.sessionId)).size !== members.length) {
    throw new Error('Ambiguous Stop recovery session set')
  }
  const capabilitySnapshotId = string(raw.capabilitySnapshotId)
  const expectedBehaviorFingerprint = string(raw.expectedBehaviorFingerprint)
  if (!/^opencode:[a-f0-9]{32}$/.test(capabilitySnapshotId)
    || !/^[a-f0-9]{64}$/.test(expectedBehaviorFingerprint)) throw new Error('Invalid Stop recovery capability/behavior identity')
  return {
    contractVersion: 1, originalRequestId: string(input.originalRequestId), idempotencyKey: string(input.idempotencyKey),
    target: { teamId: string(raw.teamId), laneId: string(raw.laneId), runId: string(raw.runId),
      projectPath: string(raw.projectPath), capabilitySnapshotId, expectedBehaviorFingerprint, members },
  }
}
export function stopRequestKey(request: OpenCodeStopRequest): string {
  // Index by original request only: a changed key/target must reject, not miss.
  return createHash('sha256').update(request.originalRequestId).digest('hex')
}
export function sameStopRequest(left: OpenCodeStopRequest, right: OpenCodeStopRequest): boolean {
  return JSON.stringify(parseOpenCodeStopRequest(left)) === JSON.stringify(parseOpenCodeStopRequest(right))
}
export function stopBinding(records: OpenCodeSessionRecord[]): OpenCodeStopBinding[] {
  return records.map(record => ({ memberName: record.memberName, sessionId: record.opencodeSessionId,
    hostKey: record.hostKey, createdAt: record.createdAt })).sort((a, b) => a.memberName.localeCompare(b.memberName))
}
export function stopSessionSetToken(target: OpenCodeStopTarget, binding: OpenCodeStopBinding[]): string {
  return createHash('sha256').update(JSON.stringify({ target, binding })).digest('hex')
}
export function matchesStopTarget(records: OpenCodeSessionRecord[], target: OpenCodeStopTarget): boolean {
  return records.length === target.members.length && target.members.every(member => records.some(record =>
    record.teamId === target.teamId && (record.laneId ?? 'primary') === target.laneId
    && record.runId === target.runId && record.projectPath === target.projectPath
    && record.expectedBehaviorFingerprint === target.expectedBehaviorFingerprint
    && record.memberName === member.memberName && record.opencodeSessionId === member.sessionId
    && !!record.hostKey && !!record.createdAt
    && (!record.stopAuthority || (record.stopAuthority.runtime.capabilitySnapshotId === target.capabilitySnapshotId
      && record.stopAuthority.expectedBehaviorFingerprint === target.expectedBehaviorFingerprint))))
}
export function validateStopData(value: unknown, request: OpenCodeStopRequest): OpenCodeStopData {
  const data = object(value)
  const members = object(data.members)
  if (data.runId !== request.target.runId || typeof data.stopped !== 'boolean'
    || !Array.isArray(data.warnings) || !data.warnings.every(item => typeof item === 'string')
    || !Array.isArray(data.diagnostics) || !data.diagnostics.every(value => {
      const d = object(value)
      return typeof d.code === 'string' && typeof d.message === 'string'
        && typeof d.severity === 'string' && ['info', 'warning', 'error'].includes(d.severity)
    }) || (data.idempotencyKey !== undefined && data.idempotencyKey !== request.idempotencyKey)
    || ![data.manifestHighWatermark, data.runtimeStoreManifestHighWatermark].every(value => value === null || (Number.isSafeInteger(value) && Number(value) >= 0))
    || Object.keys(members).length !== request.target.members.length
    || !request.target.members.every(target => {
      const member = object(members[target.memberName])
      return member.sessionId === target.sessionId && typeof member.stopped === 'boolean'
        && Array.isArray(member.diagnostics) && member.diagnostics.every(item => typeof item === 'string')
    }) || data.stopped !== Object.values(members).every(value => object(value).stopped === true)) {
    throw new Error('Invalid durable Stop result')
  }
  return structuredClone(value) as OpenCodeStopData
}

export function validateStopReceipt(value: unknown): OpenCodeStopReceipt {
  const receipt = object(value)
  const request = parseOpenCodeStopRequest(receipt.request)
  const runtime = object(receipt.runtime)
  if (runtime.providerId !== 'opencode' || runtime.capabilitySnapshotId !== request.target.capabilitySnapshotId
    || ![runtime.binaryPath, runtime.binaryFingerprint, runtime.version].every(value => value === null || typeof value === 'string')
    || !Array.isArray(receipt.binding) || receipt.binding.length !== request.target.members.length
    || !request.target.members.every((member, index) => {
      const bound = object((receipt.binding as unknown[])[index])
      return bound.memberName === member.memberName && bound.sessionId === member.sessionId
        && typeof bound.hostKey === 'string' && !!bound.hostKey
        && typeof bound.createdAt === 'string' && !!bound.createdAt
    }) || (receipt.status !== 'inflight' && receipt.status !== 'completed')) throw new Error('Corrupt Stop receipt')
  if (receipt.status === 'completed') validateStopData(receipt.data, request)
  return value as OpenCodeStopReceipt
}
