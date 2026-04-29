import { describe, expect, test } from 'bun:test'

import { OpenCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'

import type { OpenCodeRuntimeTurnSettledEvent } from './OpenCodeRuntimeTurnSettledEmitter.js'
import type { OpenCodeDeliveryResponseObservation } from './OpenCodeDeliveryResponseObserver.js'
import type { OpenCodeSessionRecord, OpenCodeSessionReconcileSummary } from './types.js'

function buildRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openrouter/qwen/qwen3-coder',
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'resolved-fingerprint',
    opencodeSessionId: 'session-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    runtimePid: 123,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  }
}

function buildReconcileSummary(
  overrides: Partial<OpenCodeSessionReconcileSummary> = {},
): OpenCodeSessionReconcileSummary {
  return {
    sessionId: 'session-1',
    reconcileOutcome: 'reconciled',
    rawStatus: 'idle',
    durableState: 'idle',
    staleReason: null,
    profileAuthState: 'ok',
    pendingPermissionRequestIds: [],
    messageCount: 2,
    toolCallCount: 0,
    errorCount: 0,
    lastCanonicalCursor: 'cursor-1',
    latestUserMessageId: 'msg-user-1',
    latestAssistantMessageId: 'msg-assistant-1',
    latestAssistantText: 'done',
    latestAssistantPreview: 'done',
    replyPendingSinceMessageId: null,
    messages: [],
    diagnostics: [],
    ...overrides,
  }
}

describe('OpenCodeTurnSettledEmissionCoordinator', () => {
  test('emits successful delivery event from visible response proof', async () => {
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
      now: () => new Date('2026-04-29T12:00:00.000Z'),
      emitter: {
        emit: async event => {
          events.push(event)
        },
      },
    })
    const responseObservation: OpenCodeDeliveryResponseObservation = {
      state: 'responded_visible_message',
      deliveredUserMessageId: 'msg-user-1',
      assistantMessageId: 'msg-assistant-1',
      toolCallNames: ['message_send'],
      visibleMessageToolCallId: 'tool-1',
      visibleReplyMessageId: 'team-message-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      latestAssistantPreview: 'done',
      reason: 'visible proof',
    }

    await coordinator.emitDelivery({
      record: buildRecord(),
      runtimePromptMessageId: 'msg_prompt_1',
      reconcileSummary: buildReconcileSummary(),
      responseObservation,
    })

    expect(events).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        recordedAt: '2026-04-29T12:00:00.000Z',
        teamName: 'team-a',
        memberName: 'alice',
        sessionId: 'session-1',
        runtimePromptMessageId: 'msg_prompt_1',
        turnId: 'msg_prompt_1',
        outcome: 'success',
        runtimePid: 123,
      }),
    ])
  })

  test('emits error outcome for tool error delivery proof', async () => {
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
      emitter: {
        emit: async event => {
          events.push(event)
        },
      },
    })

    await coordinator.emitDelivery({
      record: buildRecord(),
      responseObservation: {
        state: 'tool_error',
        deliveredUserMessageId: 'msg-user-1',
        assistantMessageId: 'msg-assistant-1',
        toolCallNames: ['message_send'],
        visibleMessageToolCallId: null,
        visibleReplyMessageId: null,
        visibleReplyCorrelation: null,
        latestAssistantPreview: 'tool failed',
        reason: 'MCP Not connected',
      },
    })

    expect(events[0]).toMatchObject({
      outcome: 'error',
      detail: expect.stringContaining('MCP Not connected'),
    })
  })
})
