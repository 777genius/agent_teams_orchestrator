import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { executeExistingOpenCodeV2TranscriptEnvelope } from '../services/opencode/bridge/OpenCodeV2TeamBridge.js'
import type { OpenCodeV2CanonicalTranscript } from '../services/opencode/bridge/OpenCodeV2TranscriptProjection.js'
import { executionAssert, executionRecord } from '../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeLogProjection, OpenCodeSessionRecord, OpenCodeSessionReconcileSummary } from '../services/opencode/types.js'

export type RuntimeTranscriptSelection = Readonly<{
  team: string; member: string; lane?: string; sessionId?: string; runId?: string
}>
export type RuntimeTranscriptProjection = Readonly<{
  record: Readonly<{ opencodeSessionId: string; selectedModel?: string }>
  summary: OpenCodeSessionReconcileSummary; logProjection: OpenCodeLogProjection
}>
type Ports = Readonly<{
  resolveLegacy: () => Promise<OpenCodeSessionRecord>
  findLegacy: (team: string, lane: string, member: string) => Promise<OpenCodeSessionRecord | null>
  projectLegacy: (record: OpenCodeSessionRecord) => Promise<RuntimeTranscriptProjection>
  executeV2?: typeof executeExistingOpenCodeV2TranscriptEnvelope
}>
const exactText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.trim() === value && !value.includes('\0')
const v2Version = (value: unknown): boolean => typeof value === 'string' && /^2(?:\.|$)/.test(value.trim())
const supported = (value: unknown): boolean => value === '2.0.0' || value === '2.0.32'

/** The V2 owner stores its own run state, never a legacy session-store record.
 * An explicit original binding can select it; a positive legacy record stays V1. */
export async function resolveRuntimeTranscriptProjection(selection: RuntimeTranscriptSelection, ports: Ports): Promise<RuntimeTranscriptProjection> {
  if (selection.runId === undefined) {
    const record = await ports.resolveLegacy()
    if (!v2Version(record.opencodeVersion)) return ports.projectLegacy(record)
    executionAssert(record.providerId === 'opencode' && record.teamId === selection.team && record.memberName === selection.member &&
      (selection.lane === undefined || selection.lane.trim() === record.laneId) &&
      (selection.sessionId === undefined || selection.sessionId.trim() === record.opencodeSessionId), 'v2_transcript_identity_invalid')
    return readV2Transcript({ ...selection, runId: record.runId, lane: record.laneId, sessionId: record.opencodeSessionId },
      record.projectPath, record.opencodeVersion, ports.executeV2)
  }
  assertBinding(selection)
  const record = await ports.findLegacy(selection.team, selection.lane, selection.member)
  if (record) {
    executionAssert(record.providerId === 'opencode' && record.teamId === selection.team &&
      record.memberName === selection.member && (record.laneId ?? 'primary') === selection.lane &&
      record.runId === selection.runId && record.opencodeSessionId === selection.sessionId, 'v2_transcript_identity_invalid')
    if (!v2Version(record.opencodeVersion)) {
      executionAssert(record.opencodeVersion === undefined || /^1\./.test(record.opencodeVersion), 'v2_transcript_version_unsupported')
      return ports.projectLegacy(record)
    }
    executionAssert(record.laneId === selection.lane, 'v2_transcript_identity_invalid')
    return readV2Transcript(selection, record.projectPath, record.opencodeVersion, ports.executeV2)
  }
  return readV2Transcript(selection, process.cwd(), undefined, ports.executeV2)
}
function assertBinding(selection: RuntimeTranscriptSelection): asserts selection is RuntimeTranscriptSelection & { runId: string; lane: string; sessionId: string } {
  executionAssert([selection.team, selection.member, selection.runId, selection.lane, selection.sessionId].every(exactText),
    'v2_transcript_identity_invalid')
}
/** Read the existing authenticated owner once; no selection, qualification,
 * legacy fallback, profile preparation or new host is available on this path. */
async function readV2Transcript(selection: RuntimeTranscriptSelection, projectPath: string, expectedPin: string | undefined,
  execute = executeExistingOpenCodeV2TranscriptEnvelope): Promise<RuntimeTranscriptProjection> {
  assertBinding(selection)
  executionAssert(/^ses_[A-Za-z0-9]+$/.test(selection.sessionId) && path.isAbsolute(projectPath) && exactText(projectPath),
    'v2_transcript_identity_invalid')
  if (expectedPin !== undefined) executionAssert(supported(expectedPin), 'v2_transcript_version_unsupported')
  const envelope = { schemaVersion: 1 as const, requestId: `transcript-${randomUUID()}`,
    command: 'opencode.getRuntimeTranscript' as const, cwd: projectPath,
    startedAt: new Date().toISOString(), timeoutMs: 8000,
    body: { teamId: selection.team, runId: selection.runId, laneId: selection.lane, memberName: selection.member,
      runtimeSessionId: selection.sessionId } }
  const reply = executionRecord(await execute(envelope))
  executionAssert(reply.schemaVersion === 1 && reply.requestId === envelope.requestId && reply.command === envelope.command,
    'v2_transcript_response_invalid')
  if (reply.ok !== true) throw new Error('v2_transcript_original_owner_unavailable')
  const pin = executionRecord(reply.runtime).version
  executionAssert(supported(pin) && (expectedPin === undefined || pin === expectedPin), 'v2_transcript_version_changed')
  // The restricted executor invokes the existing native-cut normalizer. It owns
  // canonical message/tool validation; this boundary checks session and lineage.
  const data = executionRecord(reply.data), projection = executionRecord(data.logProjection)
  executionAssert(data.sessionId === selection.sessionId && projection.sessionId === selection.sessionId &&
    Array.isArray(data.messages) && data.messages.length <= 1600 &&
    Array.isArray(data.diagnostics) && data.diagnostics.includes('v2_native_parent_ids_unavailable') &&
    Array.isArray(projection.diagnostics) && projection.diagnostics.includes('v2_native_parent_ids_unavailable'),
  'v2_transcript_response_invalid')
  const transcript = data as unknown as OpenCodeV2CanonicalTranscript
  const latestUser = transcript.messages.filter(message => message.role === 'user').at(-1)
  const latestAssistant = transcript.messages.filter(message => message.role === 'assistant').at(-1)
  const summary: OpenCodeSessionReconcileSummary = { sessionId: selection.sessionId, reconcileOutcome: 'reconciled',
    rawStatus: null, durableState: transcript.durableState, staleReason: null, profileAuthState: null,
    pendingPermissionRequestIds: [], messageCount: transcript.messages.length,
    toolCallCount: transcript.messages.reduce((count, message) => count + message.toolCalls.length, 0),
    errorCount: transcript.messages.reduce((count, message) => count + Number(message.hasError), 0),
    lastCanonicalCursor: transcript.messages.at(-1)?.id ?? null, latestUserMessageId: latestUser?.id ?? null,
    latestAssistantMessageId: latestAssistant?.id ?? null, latestAssistantText: latestAssistant?.text ?? null,
    latestAssistantPreview: latestAssistant?.previewText ?? null, replyPendingSinceMessageId: null,
    messages: transcript.messages, diagnostics: transcript.diagnostics }
  return { record: { opencodeSessionId: selection.sessionId }, summary, logProjection: transcript.logProjection }
}
