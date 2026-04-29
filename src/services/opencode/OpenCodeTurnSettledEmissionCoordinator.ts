import {
  emitOpenCodeRuntimeTurnSettledBestEffort,
  type OpenCodeRuntimeTurnSettledEmitterPort,
  type OpenCodeRuntimeTurnSettledOutcome,
} from './OpenCodeRuntimeTurnSettledEmitter.js'
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

function isTerminalDeliveryProof(observation: OpenCodeDeliveryResponseObservation | undefined): boolean {
  return observation?.state === 'responded_visible_message' ||
    observation?.state === 'responded_plain_text' ||
    observation?.state === 'responded_tool_call' ||
    observation?.state === 'responded_non_visible_tool' ||
    observation?.state === 'tool_error'
}

function outcomeFromDelivery(input: {
  turnSettled?: OpenCodeTurnSettledSummary | null
  reconcileSummary?: OpenCodeSessionReconcileSummary | null
  responseObservation?: OpenCodeDeliveryResponseObservation
}): OpenCodeRuntimeTurnSettledOutcome {
  if (isTerminalDeliveryProof(input.responseObservation)) {
    return input.responseObservation?.state === 'tool_error' ? 'error' : 'success'
  }
  if (input.reconcileSummary?.errorCount && input.reconcileSummary.errorCount > 0) {
    return 'error'
  }
  if (input.reconcileSummary?.latestAssistantMessageId) {
    return 'success'
  }
  return input.turnSettled?.outcome ?? 'unknown'
}

function outcomeFromLaunch(input: {
  previewSummary?: OpenCodeSessionPreviewSummary | null
  reconcileSummary?: OpenCodeSessionReconcileSummary | null
}): OpenCodeRuntimeTurnSettledOutcome {
  if (input.reconcileSummary?.errorCount && input.reconcileSummary.errorCount > 0) {
    return 'error'
  }
  if (input.reconcileSummary?.latestAssistantMessageId) {
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
        outcome: outcomeFromDelivery(input),
        ...(runtimePromptMessageId ? { runtimePromptMessageId, turnId: runtimePromptMessageId } : {}),
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
