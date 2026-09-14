import {
  emitOpenCodeRuntimeTurnSettledBestEffort,
  type OpenCodeRuntimeTurnSettledEmitterPort,
  type OpenCodeRuntimeTurnSettledOutcome,
} from './OpenCodeRuntimeTurnSettledEmitter.js'
import {
  summarizeOpenCodeBootstrapMcpFailure,
  summarizeOpenCodeBootstrapMcpReadiness,
} from './OpenCodeBootstrapMcpFailure.js'
import type { OpenCodeDeliveryResponseObservation } from './OpenCodeDeliveryResponseObserver.js'
import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'
import type {
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionRecord,
} from './types.js'

type CoordinatorDeps = {
  emitter?: OpenCodeRuntimeTurnSettledEmitterPort
  now?: () => Date
}

function deriveOpenCodeCompletedGeneration(identity: string): number {
  let hash = 2166136261
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function isTerminalDeliveryProof(observation: OpenCodeDeliveryResponseObservation | undefined): boolean {
  return observation?.state === 'responded_visible_message' ||
    observation?.state === 'responded_plain_text' ||
    observation?.state === 'responded_tool_call' ||
    observation?.state === 'responded_non_visible_tool' ||
    observation?.state === 'tool_error'
}

function hasAssistantResponseForPrompt(
  summary: OpenCodeSessionReconcileSummary | null | undefined,
  runtimePromptMessageId: string | null | undefined,
): boolean {
  const promptId = runtimePromptMessageId?.trim()
  if (!summary || !promptId) {
    return false
  }

  if (summary.replyPendingSinceMessageId === promptId) {
    return false
  }

  if (summary.messages.some(message => message.role === 'assistant' && message.parentId === promptId)) {
    return true
  }

  const promptIndex = summary.messages.findIndex(
    message => message.role === 'user' && message.id === promptId,
  )
  if (promptIndex < 0) {
    return false
  }

  return summary.messages.slice(promptIndex + 1).some(message => message.role === 'assistant')
}

function hasErrorForPrompt(
  summary: OpenCodeSessionReconcileSummary | null | undefined,
  runtimePromptMessageId: string | null | undefined,
): boolean {
  const promptId = runtimePromptMessageId?.trim()
  if (!summary || !promptId) {
    return false
  }

  if (
    summary.messages.some(
      message => message.role === 'assistant' && message.parentId === promptId && message.hasError,
    )
  ) {
    return true
  }

  const promptIndex = summary.messages.findIndex(
    message => message.role === 'user' && message.id === promptId,
  )
  if (promptIndex < 0) {
    return false
  }

  return summary.messages
    .slice(promptIndex + 1)
    .some(message => message.role === 'assistant' && message.hasError)
}

function isAppManagedOpenCodeBootstrap(
  record: Pick<OpenCodeSessionRecord, 'bootstrapMode'>,
): boolean {
  return record.bootstrapMode !== 'model_tool_checkin'
}

function bootstrapMcpFailureDetail(
  record: OpenCodeSessionRecord,
  summary: OpenCodeSessionReconcileSummary | null | undefined,
): string | null {
  if (!summary || isAppManagedOpenCodeBootstrap(record)) {
    return null
  }
  return summarizeOpenCodeBootstrapMcpFailure(summary)?.message ?? null
}

function outcomeFromDelivery(input: {
  turnSettled?: OpenCodeTurnSettledSummary | null
  reconcileSummary?: OpenCodeSessionReconcileSummary | null
  responseObservation?: OpenCodeDeliveryResponseObservation
  runtimePromptMessageId?: string | null
}): OpenCodeRuntimeTurnSettledOutcome {
  if (isTerminalDeliveryProof(input.responseObservation)) {
    return input.responseObservation?.state === 'tool_error' ? 'error' : 'success'
  }
  const runtimePromptMessageId =
    input.runtimePromptMessageId?.trim() ||
    input.turnSettled?.runtimePromptMessageId?.trim()
  if (hasErrorForPrompt(input.reconcileSummary, runtimePromptMessageId)) {
    return 'error'
  }
  if (hasAssistantResponseForPrompt(input.reconcileSummary, runtimePromptMessageId)) {
    return 'success'
  }
  return input.turnSettled?.outcome ?? 'unknown'
}

function outcomeFromLaunch(input: {
  record: OpenCodeSessionRecord
  previewSummary?: OpenCodeSessionPreviewSummary | null
  reconcileSummary?: OpenCodeSessionReconcileSummary | null
}): OpenCodeRuntimeTurnSettledOutcome {
  if (input.reconcileSummary?.staleReason) {
    return 'error'
  }
  if (input.reconcileSummary?.errorCount && input.reconcileSummary.errorCount > 0) {
    return 'error'
  }
  if (bootstrapMcpFailureDetail(input.record, input.reconcileSummary)) {
    return 'error'
  }
  if (isAppManagedOpenCodeBootstrap(input.record)) {
    if (
      input.reconcileSummary?.pendingPermissionRequestIds.length ||
      input.reconcileSummary?.durableState === 'blocked'
    ) {
      return 'idle_without_assistant_activity'
    }
    if (input.previewSummary?.runtimeState === 'error') {
      return 'error'
    }
    if (input.previewSummary?.streamConnected === false && !input.reconcileSummary) {
      return 'stream_unavailable'
    }
    return 'success'
  }
  if (input.reconcileSummary && summarizeOpenCodeBootstrapMcpReadiness(input.reconcileSummary).ready) {
    return 'success'
  }
  if (input.previewSummary?.runtimeState === 'error') {
    return 'error'
  }
  if (input.previewSummary?.latestAssistantMessageId) {
    return 'success'
  }
  if (input.previewSummary?.streamConnected === false) {
    return 'stream_unavailable'
  }
  return 'idle_without_assistant_activity'
}

function compactDiagnostics(values: Array<string | null | undefined>): string | undefined {
  const value = values
    .filter((item): item is string => Boolean(item?.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return value || undefined
}

export class OpenCodeTurnSettledEmissionCoordinator {
  constructor(private readonly deps: CoordinatorDeps = {}) {}

  async emitDelivery(input: {
    record: OpenCodeSessionRecord
    runtimePromptMessageId?: string | null
    turnSettled?: OpenCodeTurnSettledSummary | null
    reconcileSummary?: OpenCodeSessionReconcileSummary | null
    responseObservation?: OpenCodeDeliveryResponseObservation
  }): Promise<void> {
    const runtimePromptMessageId =
      input.runtimePromptMessageId?.trim() ||
      input.turnSettled?.runtimePromptMessageId?.trim()
    const detail = compactDiagnostics([
      input.responseObservation?.state,
      input.responseObservation?.reason,
      ...(input.turnSettled?.diagnostics ?? []),
      ...(input.reconcileSummary?.diagnostics ?? []),
    ])
    await emitOpenCodeRuntimeTurnSettledBestEffort(
      {
        schemaVersion: 1,
        provider: 'opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        source: 'agent-teams-orchestrator-opencode',
        recordedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        sessionId: input.record.opencodeSessionId,
        teamName: input.record.teamId,
        memberName: input.record.memberName,
        laneId: input.record.laneId,
        cwd: input.record.projectPath,
        outcome: outcomeFromDelivery({
          ...input,
          runtimePromptMessageId,
        }),
        ...(runtimePromptMessageId ? { runtimePromptMessageId, turnId: runtimePromptMessageId } : {}),
        runtimeInstanceId: `opencode:${input.record.laneId}`,
        completedGeneration: deriveOpenCodeCompletedGeneration(
          runtimePromptMessageId || input.record.opencodeSessionId,
        ),
        ...(input.record.selectedModel ? { selectedModel: input.record.selectedModel } : {}),
        ...(typeof input.record.runtimePid === 'number' && input.record.runtimePid > 0
          ? { runtimePid: input.record.runtimePid }
          : {}),
        ...(detail ? { detail } : {}),
      },
      this.deps.emitter,
    )
  }

  async emitLaunch(input: {
    record: OpenCodeSessionRecord
    previewSummary?: OpenCodeSessionPreviewSummary | null
    reconcileSummary?: OpenCodeSessionReconcileSummary | null
  }): Promise<void> {
    const turnId = input.reconcileSummary?.latestUserMessageId
    const detail = compactDiagnostics([
      bootstrapMcpFailureDetail(input.record, input.reconcileSummary),
      ...(input.previewSummary?.diagnostics ?? []),
      ...(input.reconcileSummary?.diagnostics ?? []),
    ])
    await emitOpenCodeRuntimeTurnSettledBestEffort(
      {
        schemaVersion: 1,
        provider: 'opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        source: 'agent-teams-orchestrator-opencode',
        recordedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
        sessionId: input.record.opencodeSessionId,
        teamName: input.record.teamId,
        memberName: input.record.memberName,
        laneId: input.record.laneId,
        cwd: input.record.projectPath,
        outcome: outcomeFromLaunch(input),
        ...(turnId ? { turnId } : {}),
        runtimeInstanceId: `opencode:${input.record.laneId}`,
        completedGeneration: deriveOpenCodeCompletedGeneration(
          turnId || input.record.opencodeSessionId,
        ),
        ...(input.record.selectedModel ? { selectedModel: input.record.selectedModel } : {}),
        ...(typeof input.record.runtimePid === 'number' && input.record.runtimePid > 0
          ? { runtimePid: input.record.runtimePid }
          : {}),
        ...(detail ? { detail } : {}),
      },
      this.deps.emitter,
    )
  }
}

export const openCodeTurnSettledEmissionCoordinator = new OpenCodeTurnSettledEmissionCoordinator()
