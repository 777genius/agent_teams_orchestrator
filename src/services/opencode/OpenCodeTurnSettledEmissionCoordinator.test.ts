import { describe, expect, test } from 'bun:test'

import { OpenCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'

import type { OpenCodeRuntimeTurnSettledEvent } from './OpenCodeRuntimeTurnSettledEmitter.js'
import type { OpenCodeDeliveryResponseObservation } from './OpenCodeDeliveryResponseObserver.js'
import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolCall,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from './types.js'

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
    toolCallCount: 2,
    errorCount: 0,
    lastCanonicalCursor: 'cursor-1',
    latestUserMessageId: 'msg-user-1',
    latestAssistantMessageId: 'msg-assistant-1',
    latestAssistantText: 'done',
    latestAssistantPreview: 'done',
    replyPendingSinceMessageId: null,
    messages: buildBootstrapReadyMessages(),
    diagnostics: [],
    ...overrides,
  }
}

function buildMessage(
  overrides: Partial<OpenCodeCanonicalMessage>,
): OpenCodeCanonicalMessage {
  return {
    id: null,
    parentId: null,
    role: 'unknown',
    agent: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    completedAt: null,
    text: '',
    reasoningText: '',
    previewText: null,
    partTypes: [],
    reasoningPartCount: 0,
    toolCalls: [],
    contentBlocks: [],
    finishReason: null,
    errorName: null,
    errorMessage: null,
    hasError: false,
    ...overrides,
  }
}

function buildToolCall(
  overrides: Partial<OpenCodeCanonicalToolCall>,
): OpenCodeCanonicalToolCall {
  return {
    callId: 'tool-1',
    toolName: 'agent-teams_runtime_bootstrap_checkin',
    title: null,
    status: 'completed',
    input: null,
    output: null,
    outputText: null,
    outputPreview: null,
    startedAt: null,
    completedAt: null,
    isError: false,
    ...overrides,
  }
}

function buildBootstrapReadyMessages(): OpenCodeCanonicalMessage[] {
  return [
    buildMessage({
      id: 'msg-assistant-1',
      role: 'assistant',
      text: 'done',
      toolCalls: [
        buildToolCall({
          callId: 'tool-bootstrap-checkin',
          toolName: 'agent-teams_runtime_bootstrap_checkin',
          status: 'completed',
          output: { ok: true },
        }),
        buildToolCall({
          callId: 'tool-member-briefing',
          toolName: 'agent-teams_member_briefing',
          status: 'completed',
          output: { ok: true },
        }),
      ],
    }),
  ]
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

  test('does not upgrade a stale previous assistant message to success for the current prompt', async () => {
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
      runtimePromptMessageId: 'msg-current-user',
      turnSettled: {
        outcome: 'idle_without_assistant_activity',
        sessionId: 'session-1',
        runtimePromptMessageId: 'msg-current-user',
        turnId: 'msg-current-user',
        endpoint: '/event',
        streamConnected: true,
        observedEventCount: 6,
        matchedEventCount: 5,
        assistantActivityCount: 0,
        promptPersisted: true,
        latestEventType: 'session.status',
        latestAssistantMessageId: null,
        diagnostics: ['OpenCode observed session.status idle without assistant activity'],
      },
      reconcileSummary: buildReconcileSummary({
        latestUserMessageId: 'msg-current-user',
        latestAssistantMessageId: 'msg-previous-assistant',
        replyPendingSinceMessageId: 'msg-current-user',
        messages: [
          buildMessage({ id: 'msg-previous-user', role: 'user' }),
          buildMessage({
            id: 'msg-previous-assistant',
            parentId: 'msg-previous-user',
            role: 'assistant',
            text: 'previous reply',
          }),
          buildMessage({ id: 'msg-current-user', role: 'user' }),
        ],
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'idle_without_assistant_activity',
      runtimePromptMessageId: 'msg-current-user',
      detail: expect.stringContaining('without assistant activity'),
    })
  })

  test('does not downgrade the current prompt because of a stale previous assistant error', async () => {
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
      runtimePromptMessageId: 'msg-current-user',
      turnSettled: {
        outcome: 'idle_without_assistant_activity',
        sessionId: 'session-1',
        runtimePromptMessageId: 'msg-current-user',
        turnId: 'msg-current-user',
        endpoint: '/event',
        streamConnected: true,
        observedEventCount: 6,
        matchedEventCount: 5,
        assistantActivityCount: 0,
        promptPersisted: true,
        latestEventType: 'session.status',
        latestAssistantMessageId: null,
        diagnostics: ['OpenCode observed session.status idle without assistant activity'],
      },
      reconcileSummary: buildReconcileSummary({
        errorCount: 1,
        latestUserMessageId: 'msg-current-user',
        latestAssistantMessageId: 'msg-previous-assistant',
        replyPendingSinceMessageId: 'msg-current-user',
        messages: [
          buildMessage({ id: 'msg-previous-user', role: 'user' }),
          buildMessage({
            id: 'msg-previous-assistant',
            parentId: 'msg-previous-user',
            role: 'assistant',
            hasError: true,
            errorName: 'ProviderError',
            errorMessage: 'previous turn failed',
          }),
          buildMessage({ id: 'msg-current-user', role: 'user' }),
        ],
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'idle_without_assistant_activity',
      runtimePromptMessageId: 'msg-current-user',
    })
  })

  test('uses reconcile proof only when an assistant response belongs to the current prompt', async () => {
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
      runtimePromptMessageId: 'msg-current-user',
      turnSettled: {
        outcome: 'timeout',
        sessionId: 'session-1',
        runtimePromptMessageId: 'msg-current-user',
        turnId: 'msg-current-user',
        endpoint: '/event',
        streamConnected: true,
        observedEventCount: 12,
        matchedEventCount: 10,
        assistantActivityCount: 0,
        promptPersisted: true,
        latestEventType: 'server.heartbeat',
        latestAssistantMessageId: null,
        diagnostics: ['observer timed out'],
      },
      reconcileSummary: buildReconcileSummary({
        latestUserMessageId: 'msg-current-user',
        latestAssistantMessageId: 'msg-current-assistant',
        replyPendingSinceMessageId: null,
        messages: [
          buildMessage({ id: 'msg-current-user', role: 'user' }),
          buildMessage({
            id: 'msg-current-assistant',
            parentId: 'msg-current-user',
            role: 'assistant',
            text: 'current reply',
          }),
        ],
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'success',
      runtimePromptMessageId: 'msg-current-user',
    })
  })

  test('uses reconcile error only when it belongs to the current prompt', async () => {
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
      runtimePromptMessageId: 'msg-current-user',
      turnSettled: {
        outcome: 'timeout',
        sessionId: 'session-1',
        runtimePromptMessageId: 'msg-current-user',
        turnId: 'msg-current-user',
        endpoint: '/event',
        streamConnected: true,
        observedEventCount: 12,
        matchedEventCount: 10,
        assistantActivityCount: 0,
        promptPersisted: true,
        latestEventType: 'server.heartbeat',
        latestAssistantMessageId: null,
        diagnostics: ['observer timed out'],
      },
      reconcileSummary: buildReconcileSummary({
        errorCount: 1,
        latestUserMessageId: 'msg-current-user',
        latestAssistantMessageId: 'msg-current-assistant',
        replyPendingSinceMessageId: null,
        messages: [
          buildMessage({ id: 'msg-current-user', role: 'user' }),
          buildMessage({
            id: 'msg-current-assistant',
            parentId: 'msg-current-user',
            role: 'assistant',
            hasError: true,
            errorName: 'ProviderError',
            errorMessage: 'current turn failed',
          }),
        ],
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'error',
      runtimePromptMessageId: 'msg-current-user',
    })
  })

  test('emits legacy launch error when bootstrap MCP tools are not connected', async () => {
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
      emitter: {
        emit: async event => {
          events.push(event)
        },
      },
    })

    await coordinator.emitLaunch({
      record: buildRecord({
        bootstrapMode: 'model_tool_checkin',
        bootstrapEvidenceSource: 'runtime_bootstrap_checkin',
      }),
      reconcileSummary: buildReconcileSummary({
        latestAssistantMessageId: 'msg-bootstrap-failed',
        latestAssistantText: 'Both calls returned "Not connected".',
        messages: [
          buildMessage({
            id: 'msg-bootstrap-failed',
            role: 'assistant',
            toolCalls: [
              buildToolCall({
                toolName: 'agent-teams_runtime_bootstrap_checkin',
                status: 'errored',
                outputText: 'Not connected',
                isError: true,
              }),
              buildToolCall({
                callId: 'tool-2',
                toolName: 'agent-teams_member_briefing',
                status: 'errored',
                outputText: 'Not connected',
                isError: true,
              }),
            ],
          }),
        ],
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'error',
      detail: expect.stringContaining('runtime_bootstrap_checkin, member_briefing'),
    })
  })

  test('emits app-managed launch success when assistant response omits legacy bootstrap tools', async () => {
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
      emitter: {
        emit: async event => {
          events.push(event)
        },
      },
    })

    await coordinator.emitLaunch({
      record: buildRecord(),
      reconcileSummary: buildReconcileSummary({
        latestAssistantMessageId: 'msg-no-tools',
        latestAssistantText:
          "I don't have the agent-teams MCP tools available in my current toolset.",
        messages: [
          buildMessage({
            id: 'msg-no-tools',
            role: 'assistant',
            text: "I don't have the agent-teams MCP tools available in my current toolset.",
            toolCalls: [],
          }),
        ],
        toolCallCount: 0,
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'success',
    })
    expect(events[0]?.detail ?? '').not.toContain(
      'OpenCode bootstrap MCP did not complete required tools before assistant response',
    )
  })

  test('emits legacy launch error when bootstrap assistant response omits required MCP tools', async () => {
    const events: OpenCodeRuntimeTurnSettledEvent[] = []
    const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
      emitter: {
        emit: async event => {
          events.push(event)
        },
      },
    })

    await coordinator.emitLaunch({
      record: buildRecord({
        bootstrapMode: 'model_tool_checkin',
        bootstrapEvidenceSource: 'runtime_bootstrap_checkin',
      }),
      reconcileSummary: buildReconcileSummary({
        latestAssistantMessageId: 'msg-no-tools',
        latestAssistantText:
          "I don't have the agent-teams MCP tools available in my current toolset.",
        messages: [
          buildMessage({
            id: 'msg-no-tools',
            role: 'assistant',
            text: "I don't have the agent-teams MCP tools available in my current toolset.",
            toolCalls: [],
          }),
        ],
        toolCallCount: 0,
      }),
    })

    expect(events[0]).toMatchObject({
      outcome: 'error',
      detail: expect.stringContaining(
        'OpenCode bootstrap MCP did not complete required tools before assistant response',
      ),
    })
  })
})
