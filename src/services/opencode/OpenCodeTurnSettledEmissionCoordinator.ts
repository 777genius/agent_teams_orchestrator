import {
  emitOpenCodeRuntimeTurnSettledBestEffort,
  type OpenCodeRuntimeTurnSettledEmitterPort,
  } from './OpenCodeRuntimeTurnSettledEmitter.js'
import { qualifyOpenCodeV1TerminalProof } from './OpenCodeV1TerminalProof.js'
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

function compactDiagnostics(values: Array<string | null | undefined>): string | undefined {
  const value = values
    .filter((item): item is string => Boolean(item?.trim()))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return value || undefined
}

export class OpenCodeTurnSettledEmissionCoordinator {
  private readonly emittedObservations = new WeakSet<object>()

  constructor(private readonly deps: CoordinatorDeps = {}) {}

  async emitDelivery(input: {
    record: OpenCodeSessionRecord
    runtimePromptMessageId?: string | null
    turnSettled?: OpenCodeTurnSettledSummary | null
    reconcileSummary?: OpenCodeSessionReconcileSummary | null
    responseObservation?: OpenCodeDeliveryResponseObservation
  }): Promise<void> {
    const runtimePromptMessageId = input.runtimePromptMessageId
    if (!input.record.laneId || !input.record.teamId || !input.record.memberName || input.record.staleReason) return
    const observation = input.turnSettled
    if (observation && (observation.sessionId !== input.record.opencodeSessionId || observation.runtimePromptMessageId !== runtimePromptMessageId)) return
    const evidence = input.reconcileSummary ? input.reconcileSummary.terminalEvidence : observation?.terminalProof?.evidence
    if (input.reconcileSummary && (input.reconcileSummary.sessionId !== input.record.opencodeSessionId || input.reconcileSummary.staleReason || input.reconcileSummary.durableState === 'blocked' || input.reconcileSummary.pendingPermissionRequestIds.length)) return
    const { proof } = qualifyOpenCodeV1TerminalProof(evidence, input.record.opencodeSessionId, runtimePromptMessageId)
    if (!proof) return
    const authority = proof.evidence.authority
    if (!authority || authority.hostKey !== input.record.hostKey || authority.runId !== input.record.runId || authority.profileRootKey !== input.record.profileRootKey || authority.projectPath !== input.record.projectPath) return
    if (observation?.terminalProof && (observation.terminalProof.sessionId !== input.record.opencodeSessionId || observation.terminalProof.runtimePromptMessageId !== runtimePromptMessageId)) return
    if (observation && this.emittedObservations.has(observation)) return
    if (observation) this.emittedObservations.add(observation)
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
        memberName: input.record.memberName ?? '',
        laneId: input.record.laneId,
        cwd: input.record.projectPath,
        outcome: proof.outcome,
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
    runtimePromptMessageId?: string | null
    previewSummary?: OpenCodeSessionPreviewSummary | null
    reconcileSummary?: OpenCodeSessionReconcileSummary | null
  }): Promise<void> {
    // Silent bootstrap is lifecycle readiness, never native execution.
    if (input.record.bootstrapMode !== 'model_tool_checkin' || !input.runtimePromptMessageId || input.record.bootstrapRuntimePromptMessageId !== input.runtimePromptMessageId) return
    await this.emitDelivery({
      record: input.record, runtimePromptMessageId: input.runtimePromptMessageId,
      reconcileSummary: input.reconcileSummary,
    })
  }
}

export const openCodeTurnSettledEmissionCoordinator = new OpenCodeTurnSettledEmissionCoordinator()
