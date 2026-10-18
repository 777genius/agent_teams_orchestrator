import { createHash } from 'node:crypto'

/** One absolute owner startup ceiling; callers may clip it to an earlier deadline. */
export function openCodeV2RunInitializationMs(platform: NodeJS.Platform): number {
  return platform === 'win32' ? 300_000 : platform === 'darwin' ? 180_000 : 90_000
}
// Windows physical close shares the existing 29s owner Stop envelope. The
// owner clips this ceiling to leave 2s for the final durable run receipt.
export const OPEN_CODE_V2_WINDOWS_CLOSE_MS = 27_000

export type ExecutionPin = '2.0.0' | '2.0.32'
export type ExecutionBirth = Readonly<{ format: 'linux-start-ticks' | 'darwin-pidversion' | 'windows-filetime' | 'utc-ms'; value: string; bootId: string | null }>
export type ExecutionAuthority = Readonly<{
  generation: 'v2'; pin: ExecutionPin; dialect: 'v2-2.0.0' | 'v2-2.0.32'
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
  executionAssert(host.generation === 'v2' && (host.pin === '2.0.0' || host.pin === '2.0.32'))
  executionAssert(host.dialect === `v2-${host.pin}` && host.selectedCli.version === host.pin)
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
export function assertIntentIdentity(identity: IntentIdentity): void {
  executionAssert(Object.keys(identity).sort().join(',') === 'deliveryAttemptId,localMessageId,nativeInputID,requestId')
  executionAssert([identity.requestId, identity.deliveryAttemptId, identity.localMessageId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 200))
  executionAssert(/^msg_[a-zA-Z0-9]+$/.test(identity.nativeInputID))
}
