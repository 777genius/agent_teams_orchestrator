import { OPEN_CODE_LOADING_TIMEOUT_MS } from '../OpenCodeLoadingBudget.js'
import { createHash } from 'node:crypto'
import { isOpenCodeV2Identity, isOpenCodeV2Pin, type OpenCodeV2Dialect, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'

/** One absolute owner startup ceiling; callers may clip it to an earlier deadline. */
export function openCodeV2RunInitializationMs(platform: NodeJS.Platform): number {
  return platform === 'win32' || platform === 'darwin' ? 300_000 : OPEN_CODE_LOADING_TIMEOUT_MS
}
/** The activation deadline a child accepts: the caller's deadline, clipped to the
 * platform ceiling counted from before the child was spawned. The entry refuses any
 * deadline past its own start plus that ceiling, so a longer caller deadline (the
 * 240s catalog lease) must not reach it unclipped. */
export function openCodeV2ActivationDeadline(callerDeadline: number, acquisitionStartedAt: number, platform: NodeJS.Platform): number {
  return Math.min(callerDeadline, acquisitionStartedAt + openCodeV2RunInitializationMs(platform))
}
// Windows physical close shares the 40s owner Stop envelope. The
// owner clips this ceiling to leave 2s for the final durable run receipt.
export const OPEN_CODE_V2_WINDOWS_CLOSE_MS = 38_000

export type ExecutionPin = OpenCodeV2Pin
export type ExecutionBirth = Readonly<{ format: 'linux-start-ticks' | 'darwin-pidversion' | 'windows-filetime' | 'utc-ms'; value: string; bootId: string | null }>
export type ExecutionAuthority = Readonly<{
  /** pin/dialect identify the exact owned engine; selectedCli.version identifies the installed CLI. */
  generation: 'v2'; pin: ExecutionPin; dialect: OpenCodeV2Dialect
  graphSha256: string
  selectedCli: Readonly<{ path: string; sha256: string; version: ExecutionPin }>
  child: Readonly<{ pid: number; birth: ExecutionBirth; executablePath: string; sha256: string }>
  hostInstanceId: string; profileEpoch: string; profileRoot: string
  directory: string; leaseOwnerId: string
}>
export type ExecutionContext = Readonly<{
  teamId: string; runId: string; laneId: string; memberId: string
  deadline: number; signal?: AbortSignal
}>
export type ExecutionSelectedModel = Readonly<{ providerID: string; id: string; variant?: string }>
export type SessionAuthority = Readonly<{
  host: ExecutionAuthority; teamId: string; runId: string; laneId: string; memberId: string
  sessionID: string; agent: string; model: ExecutionSelectedModel
}>
export type Disposition = 'accepted' | 'pending' | 'cancelled' | 'rejected' | 'unknown'
export type IntentIdentity = Readonly<{
  requestId: string; deliveryAttemptId: string; localMessageId: string; nativeInputID: string
}>
export type AdmissionRecord = {
  identity: IntentIdentity; payloadHash: string; authority: SessionAuthority
  state: 'prepared' | 'submitting' | 'not_submitted' | 'accepted' | 'unknown'
  disposition: Disposition; returnedInboxID?: string; projectedUserID?: string; nativePayloadHash?: string
  beforeCursor: number | null; beforeUserIDs: string[]
  cursor: number | null; complete: boolean; revision: number
}
export function executionAssert(value: unknown, code = 'execution_contract_invalid'): asserts value {
  if (!value) throw new Error(code)
}
export function executionRecord(value: unknown): Record<string, unknown> {
  executionAssert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
// Stable JSON is also the conflict contract. Undefined, non-finite values and
// prototype-bearing objects are refused before any persistence or HTTP effects.
export function canonicalExecutionJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') { executionAssert(Number.isFinite(value)); return JSON.stringify(value) }
  if (Array.isArray(value)) return '[' + value.map(canonicalExecutionJSON).join(',') + ']'
  const object = executionRecord(value)
  executionAssert(Object.getPrototypeOf(object) === Object.prototype || Object.getPrototypeOf(object) === null)
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalExecutionJSON(object[key])).join(',') + '}'
}
export const executionHash = (value: unknown) => createHash('sha256').update(canonicalExecutionJSON(value)).digest('hex')
function exactKeys(value: unknown, expected: string[], optional: string[] = []): void {
  const row = executionRecord(value)
  executionAssert(expected.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => [...expected, ...optional].includes(key)), 'store_unknown')
}
export function assertExecutionAuthority(host: ExecutionAuthority): void {
  exactKeys(host, ['generation', 'pin', 'dialect', 'graphSha256', 'selectedCli', 'child', 'hostInstanceId', 'profileEpoch', 'profileRoot', 'directory', 'leaseOwnerId'])
  exactKeys(host.selectedCli, ['path', 'sha256', 'version']); exactKeys(host.child, ['pid', 'birth', 'executablePath', 'sha256'])
  exactKeys(host.child.birth, ['format', 'value', 'bootId'])
  executionAssert(host.child.birth.format === 'linux-start-ticks' ? typeof host.child.birth.bootId === 'string' && host.child.birth.bootId.length > 0 :
    host.child.birth.format === 'darwin-pidversion' ? /^\d+:\d+$/.test(host.child.birth.value) && typeof host.child.birth.bootId === 'string' && /^[a-f0-9-]{36}$/i.test(host.child.birth.bootId) :
    host.child.birth.format === 'windows-filetime' ? /^[1-9]\d{0,19}$/.test(host.child.birth.value) &&
      BigInt(host.child.birth.value) <= 0xffffffffffffffffn && host.child.birth.bootId === null :
    host.child.birth.format === 'utc-ms' && host.child.birth.bootId === null)
  executionAssert(host.generation === 'v2' && isOpenCodeV2Identity(host.pin, host.dialect) && isOpenCodeV2Pin(host.selectedCli.version))
  executionAssert([host.graphSha256, host.selectedCli.sha256, host.child.sha256].every(x => /^[a-f0-9]{64}$/.test(x)))
  executionAssert(Number.isSafeInteger(host.child.pid) && host.child.pid > 0 && typeof host.child.birth.value === 'string' && host.child.birth.value.length > 0)
  executionAssert([host.profileEpoch, host.hostInstanceId, host.leaseOwnerId].every(x => typeof x === 'string' && x.length > 0))
  executionAssert([host.profileRoot, host.directory, host.selectedCli.path, host.child.executablePath].every(x => typeof x === 'string' && x.length > 0))
}
export function assertSessionAuthority(authority: SessionAuthority): void {
  exactKeys(authority, ['host', 'teamId', 'runId', 'laneId', 'memberId', 'sessionID', 'agent', 'model'])
  assertExecutionSelectedModel(authority.model)
  assertExecutionAuthority(authority.host)
  executionAssert(/^ses_[a-zA-Z0-9]+$/.test(authority.sessionID))
  executionAssert([authority.teamId, authority.runId, authority.laneId, authority.memberId, authority.agent]
    .every(x => typeof x === 'string' && x.length > 0))
}
/** Both pinned native ModelRef dialects use catalog id, providerID and optional variant. */
export function assertExecutionSelectedModel(model: ExecutionSelectedModel): void {
  exactKeys(model, ['providerID', 'id'], ['variant'])
  executionAssert([model.providerID, model.id].every(x => typeof x === 'string' && x.length > 0), 'invalid_model')
  if (Object.hasOwn(model, 'variant')) executionAssert(typeof model.variant === 'string' &&
    model.variant.length > 0 && Buffer.byteLength(model.variant) <= 4096 && !model.variant.includes('\0'), 'invalid_model')
}
/** App message IDs can be long: a still-stuck work-sync nudge carries two SHA-256 agendas and a
 * timestamp (224 chars). The native input ID is a hash, so this bound only limits record size. */
export const INTENT_IDENTITY_MAX_LENGTH = 512
export function assertIntentIdentity(identity: IntentIdentity): void {
  executionAssert(Object.keys(identity).sort().join(',') === 'deliveryAttemptId,localMessageId,nativeInputID,requestId')
  executionAssert([identity.requestId, identity.deliveryAttemptId, identity.localMessageId].every(x => typeof x === 'string' && x.length > 0 &&
    x.length <= INTENT_IDENTITY_MAX_LENGTH), 'intent_identity_invalid')
  executionAssert(/^msg_[a-zA-Z0-9]+$/.test(identity.nativeInputID))
}
