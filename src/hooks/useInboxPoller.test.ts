import { describe, expect, test } from 'bun:test'

import {
  extractTaskRefFromMailboxText,
  findBootstrapAttemptOutcome,
  findOrdinaryAttemptExecutionError,
  findOrdinaryDirectReplyFallback,
  findOrdinaryDirectReplyOutcome,
  getBootstrapTranscriptActivitySignature,
  getBootstrapReadinessDecision,
  getBootstrapProcessingAction,
  getOrdinaryProcessingAction,
  getBootstrapInlineHandoffPrompt,
  getOrdinaryInlineHandoffPrompt,
  getOrdinaryRecoveryInlineHandoffPrompt,
  getOrdinaryPendingMessage,
  getBootstrapPendingMessage,
  getQueuedMailboxMetaPrompt,
  buildAgentErrorNotificationText,
  buildMailboxExecutionFailureLeadNotificationText,
  isBootstrapMemberBriefingCallableNow,
  isBootstrapMailboxInstructionText,
  isMemberBriefingToolName,
  shouldSkipBootstrapReadinessWait,
  shouldDeferPendingInboxDelivery,
} from './useInboxPoller.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '../utils/messages.js'

describe('useInboxPoller queued mailbox meta prompt', () => {
  test('detects bootstrap teammate mailbox instructions', () => {
    expect(
      isBootstrapMailboxInstructionText(
        'The team has already been created and you are being attached as a persistent teammate.',
      ),
    ).toBe(false)
    expect(
      isBootstrapMailboxInstructionText(
        'The team has already been created and you are being attached as a persistent teammate. Call member_briefing next.',
      ),
    ).toBe(true)
    expect(
      isBootstrapMailboxInstructionText(
        'Your FIRST action: call MCP tool member_briefing with: {"foo":"bar"}',
      ),
    ).toBe(true)
    expect(isBootstrapMailboxInstructionText('Please review the latest diff.')).toBe(
      false,
    )
  })

  test('uses a bootstrap-specific meta prompt for the first teammate bootstrap turn', () => {
    const prompt = getQueuedMailboxMetaPrompt({
      isTeammateSession: true,
      pendingMessages: [
        {
          from: 'team-lead',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      ],
    })

    expect(prompt).toContain('onboarding/bootstrap instructions')
    expect(prompt).toContain('member_briefing')
    expect(prompt).toContain('retry tool search at most once')
    expect(prompt).not.toBe('Process the queued teammate mailbox attachment for this turn.')
  })

  test('keeps the generic meta prompt for normal teammate mailbox turns', () => {
    expect(
      getQueuedMailboxMetaPrompt({
        isTeammateSession: true,
        pendingMessages: [
          {
            from: 'team-lead',
            text: 'Please pick up the next queued task.',
          },
        ],
      }),
    ).toBe('Process the queued teammate mailbox attachment for this turn.')
  })

  test('keeps the generic meta prompt for lead path even if text resembles bootstrap', () => {
    expect(
      getQueuedMailboxMetaPrompt({
        isTeammateSession: false,
        pendingMessages: [
          {
            from: 'team-lead',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      }),
    ).toBe('Process the queued teammate mailbox attachment for this turn.')
  })

  test('formats agent errors as red-renderable user-facing messages', () => {
    const text = buildMailboxExecutionFailureLeadNotificationText({
      memberName: 'bob',
      taskRef: 'abc12345',
      detail: 'Credit balance is too low',
    })

    expect(text).toContain('bob hit a mailbox turn execution error for #abc12345')
    expect(text).toContain('API Error: Credit balance is too low')
  })

  test('formats generic agent errors without provider-specific assumptions', () => {
    const text = buildAgentErrorNotificationText({
      memberName: 'alice',
      detail: 'provider rejected the request',
      action: 'failed bootstrap after teammate startup',
    })

    expect(text).toBe(
      'alice failed bootstrap after teammate startup. API Error: provider rejected the request',
    )
  })

  test('finds the first actionable bootstrap row for teammate sessions', () => {
    expect(
      getBootstrapPendingMessage({
        isTeammateSession: true,
        pendingMessages: [
          {
            id: '1',
            messageId: 'a',
            mailboxClaimedBySessionId: 's',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Do the next task.',
          },
          {
            id: '2',
            messageId: 'b',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      })?.messageId,
    ).toBe('b')
  })

  test('finds the first actionable ordinary regular row', () => {
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [
          {
            id: '1',
            messageId: 'bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: '2',
            messageId: 'regular',
            mailboxClaimedBySessionId: 's',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Тут?',
          },
        ],
      })?.messageId,
    ).toBe('regular')
  })

  test('builds an inline ordinary mailbox handoff from the row itself', () => {
    const prompt = getOrdinaryInlineHandoffPrompt({
      from: 'user',
      text: '<info_for_agent>reply via SendMessage</info_for_agent>\n\nТут?',
      timestamp: '2026-04-09T13:38:16.210Z',
    })

    expect(prompt).toContain('Process this queued mailbox message now.')
    expect(prompt).toContain('Sender: "user".')
    expect(prompt).toContain('Timestamp: "2026-04-09T13:38:16.210Z".')
    expect(prompt).toContain('<queued_mailbox_message>')
    expect(prompt).toContain('reply via SendMessage')
    expect(prompt).toContain('Тут?')
  })

  test('builds an inline bootstrap handoff with explicit args and instructions', () => {
    const prompt = getBootstrapInlineHandoffPrompt({
      bootstrapInstructionText:
        'Your FIRST action: call MCP tool member_briefing with: { teamName: "harbor-labs", memberName: "alice" }',
      memberName: 'alice',
      teamName: 'harbor-labs',
    })

    expect(prompt).toContain('teamName="harbor-labs"')
    expect(prompt).toContain('memberName="alice"')
    expect(prompt).toContain('<bootstrap_instructions>')
    expect(prompt).toContain('Do not explore files, inbox paths, or team config')
    expect(prompt).toContain('retry tool search at most once')
    expect(prompt).toContain('Do not keep searching for member_briefing')
  })

  test('returns null inline handoff when teammate context is incomplete', () => {
    expect(
      getBootstrapInlineHandoffPrompt({
        bootstrapInstructionText: 'Your FIRST action: call MCP tool member_briefing with: {}',
        teamName: 'harbor-labs',
      }),
    ).toBeNull()
  })

  test('keeps bootstrap readiness wait when a full inline handoff prompt is available but tool is deferred', () => {
    expect(
      shouldSkipBootstrapReadinessWait({
        bootstrapInstructionText:
          'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs","memberName":"alice"}',
        teamName: 'harbor-labs',
        memberName: 'alice',
        toolCallableNow: false,
      }),
    ).toBe(false)
  })

  test('keeps bootstrap readiness wait when teammate context is incomplete and tool is deferred', () => {
    expect(
      shouldSkipBootstrapReadinessWait({
        bootstrapInstructionText:
          'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs","memberName":"alice"}',
        teamName: 'harbor-labs',
        toolCallableNow: false,
      }),
    ).toBe(false)
  })

  test('skips bootstrap readiness wait when member_briefing is callable', () => {
    expect(
      shouldSkipBootstrapReadinessWait({
        bootstrapInstructionText:
          'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs","memberName":"alice"}',
        teamName: 'harbor-labs',
        memberName: 'alice',
        toolCallableNow: true,
      }),
    ).toBe(true)
  })

  test('treats prefixed member_briefing as callable when tool search is off', () => {
    expect(
      isBootstrapMemberBriefingCallableNow({
        toolSearchEnabledOptimistic: false,
        tools: [
          {
            alwaysLoad: false,
            isMcp: true,
            name: 'mcp__agent-teams__member_briefing',
            shouldDefer: false,
          },
        ],
      }),
    ).toBe(true)
  })

  test('treats prefixed MCP member_briefing name as canonical bootstrap tool name', () => {
    expect(isMemberBriefingToolName('member_briefing')).toBe(true)
    expect(isMemberBriefingToolName('mcp__agent-teams__member_briefing')).toBe(
      true,
    )
    expect(isMemberBriefingToolName('SendMessage')).toBe(false)
  })

  test('does not treat deferred member_briefing as callable when tool search is on', () => {
    expect(
      isBootstrapMemberBriefingCallableNow({
        toolSearchEnabledOptimistic: true,
        tools: [
          {
            alwaysLoad: false,
            isMcp: true,
            name: 'mcp__agent-teams__member_briefing',
            shouldDefer: false,
          },
        ],
      }),
    ).toBe(false)
  })

  test('readiness gate waits until grace expires when member_briefing is not callable', () => {
    expect(
      getBootstrapReadinessDecision({
        now: 5_000,
        toolCallableNow: false,
        waitStartedAt: 0,
      }),
    ).toEqual({ type: 'wait', remainingMs: 10_000 })
  })

  test('readiness gate falls through after grace expires', () => {
    expect(
      getBootstrapReadinessDecision({
        now: 15_000,
        toolCallableNow: false,
        waitStartedAt: 0,
      }),
    ).toEqual({ type: 'proceed' })
  })

  test('does not defer bootstrap teammate delivery while loading', () => {
    expect(
      shouldDeferPendingInboxDelivery({
        isLoading: true,
        focusedInputDialog: undefined,
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'bootstrap-row',
            messageId: 'bootstrap-msg',
            mailboxClaimedBySessionId: 'session-1',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-22T19:50:57.224Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"relay-works-6","memberName":"alice"}',
          },
        ],
      }),
    ).toBe(false)
  })

  test('still defers ordinary teammate delivery while loading', () => {
    expect(
      shouldDeferPendingInboxDelivery({
        isLoading: true,
        focusedInputDialog: undefined,
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'regular-row',
            messageId: 'regular-msg',
            mailboxClaimedBySessionId: 'session-1',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-22T19:50:57.224Z',
            text: 'Тут?',
          },
        ],
      }),
    ).toBe(true)
  })

  test('always defers when a dialog is focused', () => {
    expect(
      shouldDeferPendingInboxDelivery({
        isLoading: false,
        focusedInputDialog: 'tool-permission',
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'bootstrap-row',
            messageId: 'bootstrap-msg',
            mailboxClaimedBySessionId: 'session-1',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-22T19:50:57.224Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"relay-works-6","memberName":"alice"}',
          },
        ],
      }),
    ).toBe(true)
  })

  test('bootstrap transcript activity signature changes when transcript appends', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'Готово.', type: 'text' } as never],
    })

    expect(getBootstrapTranscriptActivitySignature([submitted])).not.toBe(
      getBootstrapTranscriptActivitySignature([submitted, assistant]),
    )
  })

  test('detects successful member_briefing tool result as bootstrap success', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-1',
          input: { memberName: 'alice', teamName: 'harbor-labs' },
          name: 'member_briefing',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'briefing ok',
          is_error: false,
          tool_use_id: 'tool-1',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('member_briefing')
  })

  test('detects successful prefixed member_briefing tool result as bootstrap success', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-1',
          input: { memberName: 'alice', teamName: 'harbor-labs' },
          name: 'mcp__agent-teams__member_briefing',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'briefing ok',
          is_error: false,
          tool_use_id: 'tool-1',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('member_briefing')
  })

  test('detects SendMessage to team-lead as bootstrap fallback', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-2',
          input: {
            message: 'member_briefing failed: boom',
            to: 'team-lead',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-2',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('team_lead_fallback')
  })

  test('detects successful SendMessage to user as ordinary direct reply', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-send',
          input: {
            message: 'На месте.',
            summary: 'Ответ',
            to: 'user',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('user_send_message')
  })

  test('does not treat plain assistant text as ordinary direct reply', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'На месте.', type: 'text' } as never],
    })

    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('none')
  })

  test('extracts plain assistant text as ordinary direct reply fallback', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'На месте.', type: 'text' } as never],
    })

    expect(
      findOrdinaryDirectReplyFallback({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toEqual({ text: 'На месте.' })
  })

  test('does not fallback plain text when SendMessage to user was attempted', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'Отвечаю через инструмент.', type: 'text' } as never,
        {
          id: 'tool-send',
          input: {
            message: 'На месте.',
            summary: 'Ответ',
            to: 'user',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyFallback({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBeNull()
  })

  test('does not treat an errored member_briefing result as bootstrap success', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const briefingAttempt = createAssistantMessage({
      content: [
        {
          id: 'tool-brief',
          input: { memberName: 'alice', teamName: 'harbor-labs' },
          name: 'member_briefing',
          type: 'tool_use',
        } as never,
      ],
    })
    const briefingError = createUserMessage({
      content: [
        {
          content: 'briefing failed',
          is_error: true,
          tool_use_id: 'tool-brief',
          type: 'tool_result',
        } as never,
      ],
    })
    const fallback = createAssistantMessage({
      content: [
        {
          id: 'tool-send',
          input: {
            message: 'member_briefing failed: boom',
            to: 'team-lead',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, briefingAttempt, briefingError, fallback],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('none')
  })

  test('does not treat an errored SendMessage fallback result as bootstrap fallback', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const fallbackAttempt = createAssistantMessage({
      content: [
        {
          id: 'tool-send',
          input: {
            message: 'member_briefing failed: boom',
            to: 'team-lead',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })
    const fallbackError = createUserMessage({
      content: [
        {
          content: 'send failed',
          is_error: true,
          tool_use_id: 'tool-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, fallbackAttempt, fallbackError],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('none')
  })

  test('ignores later turns when checking bootstrap outcome', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const nextTurn = createUserMessage({
      content: 'user task',
      uuid: 'later-user-turn',
    })
    const laterAssistant = createAssistantMessage({
      content: [
        {
          id: 'tool-3',
          input: { teamName: 'harbor-labs', memberName: 'alice' },
          name: 'member_briefing',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findBootstrapAttemptOutcome({
        messages: [submitted, nextTurn, laterAssistant],
        submitUserMessageUuid: 'bootstrap-uuid',
      }),
    ).toBe('none')
  })

  test('lifecycle - processing row with missing attempt resets back to pending', () => {
    expect(
      getBootstrapProcessingAction({
        messages: [],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({ type: 'reset_to_pending' })
  })

  test('lifecycle - in-flight row with successful briefing finalizes', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const briefingAttempt = createAssistantMessage({
      content: [
        {
          id: 'tool-brief',
          input: { memberName: 'alice', teamName: 'harbor-labs' },
          name: 'member_briefing',
          type: 'tool_use',
        } as never,
      ],
    })
    const briefingResult = createUserMessage({
      content: [
        {
          content: 'briefing ok',
          is_error: false,
          tool_use_id: 'tool-brief',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, briefingAttempt, briefingResult],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - in-flight row without outcome enters cooldown, then cooling row noops', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'I need more context.', type: 'text' } as never],
    })
    const processingRow = {
      id: 'row-1',
      messageId: 'mailbox-1',
      mailboxClaimedBySessionId: 'session-1',
      from: 'team-lead',
      status: 'processing' as const,
      timestamp: '2026-04-09T13:00:00.000Z',
      text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
    }

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingBootstrapMessage: processingRow,
      }),
    ).toEqual({ type: 'schedule_cooldown' })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 5000,
          status: 'cooling_down',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingBootstrapMessage: processingRow,
      }),
    ).toEqual({ type: 'noop' })
  })

  test('lifecycle - bootstrap API error fails instead of retrying', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'Please run /login',
      errorDetails: 'API Error: 401 invalid authentication credentials',
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, apiError],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({
      type: 'fail',
      detail: 'API Error: 401 invalid authentication credentials',
    })
  })

  test('lifecycle - transient bootstrap API error keeps cooldown retry behavior', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'API Error: 502 upstream unavailable',
      errorDetails: 'API Error: 502 upstream unavailable',
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, apiError],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown' })
  })

  test('lifecycle - in-flight row without post-submit activity stays in processing', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({ type: 'noop' })
  })

  test('lifecycle - bootstrap row ignores system-only activity while waiting for meaningful progress', () => {
    const submitted = createUserMessage({
      content: 'bootstrap handoff',
      isMeta: true,
      uuid: 'bootstrap-uuid',
    })
    const system = createSystemMessage('Codex native thread started.', 'info')

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, system],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
        },
      }),
    ).toEqual({ type: 'noop' })
  })

  test('lifecycle - ordinary direct row finalizes only after SendMessage to user', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const sendAttempt = createAssistantMessage({
      content: [
        {
          id: 'tool-send',
          input: {
            message: 'На месте.',
            summary: 'Ответ',
            to: 'user',
          },
          name: 'SendMessage',
          type: 'tool_use',
        } as never,
      ],
    })
    const sendResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, sendAttempt, sendResult],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'user',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Тут?',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - ordinary direct row relays plain text instead of ignoring it', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'На месте.', type: 'text' } as never],
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'user',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Тут?',
        },
      }),
    ).toEqual({ type: 'deliver_assistant_text', text: 'На месте.' })
  })

  test('lifecycle - ordinary non-user row finalizes after transcript activity', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'Принял задачу.', type: 'text' } as never],
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Возьми следующую задачу.',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - ordinary non-user row does not finalize on system-only activity', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const system = createSystemMessage('Codex native thread started.', 'info')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, system],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Возьми следующую задачу.',
        },
      }),
    ).toEqual({ type: 'noop' })
  })

  test('detects Codex native timeout API error after an ordinary mailbox submit', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const timeout = createAssistantAPIErrorMessage({
      content: 'Codex native exec timed out after 120000ms.',
      errorDetails: 'Codex native exec timed out after 120000ms.',
    })

    expect(
      findOrdinaryAttemptExecutionError({
        messages: [submitted, timeout],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toEqual({
      type: 'codex_native_timeout',
      detail: 'Codex native exec timed out after 120000ms.',
    })
  })

  test('does not classify plain assistant text that mentions a prior Codex timeout as an execution error', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content:
        'I saw the previous Codex native exec timed out after 120000ms, checked the diff, and continued.',
    })

    expect(
      findOrdinaryAttemptExecutionError({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBeNull()

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Task assigned: taskId: "545b704e"',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - ordinary non-user Codex timeout schedules recovery instead of finalize', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const timeout = createAssistantAPIErrorMessage({
      content: 'Codex native exec timed out after 120000ms of inactivity.',
      errorDetails: 'Codex native exec timed out after 120000ms of inactivity.',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, timeout],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Task assigned: taskId: "545b704e"',
        },
      }),
    ).toEqual({
      type: 'schedule_recovery',
      detail: 'Codex native exec timed out after 120000ms of inactivity.',
      taskRef: '545b704e',
    })
  })

  test('lifecycle - initial non-user API error notifies failure instead of finalizing or retrying', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'Rate limit reached.',
      errorDetails: 'Rate limit reached.',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, apiError],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Task assigned: taskId: "545b704e"',
        },
      }),
    ).toEqual({
      type: 'notify_failure',
      detail: 'Rate limit reached.',
      reason: 'execution_failed',
      taskRef: '545b704e',
    })
  })

  test('lifecycle - initial user API error still relays text to the user', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'Rate limit reached.',
      errorDetails: 'Rate limit reached.',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, apiError],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'user',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Question from user',
        },
      }),
    ).toEqual({
      type: 'deliver_assistant_text',
      text: 'Rate limit reached.',
    })
  })

  test('builds a recovery prompt with no blind restart instruction and task ref', () => {
    const text = 'Task assigned: taskId: "545b704e"'
    const prompt = getOrdinaryRecoveryInlineHandoffPrompt({
      from: 'team-lead',
      text,
      timestamp: '2026-04-09T13:00:00.000Z',
      failureDetail: 'Codex native exec timed out after 120000ms.',
      taskRef: extractTaskRefFromMailboxText(text),
    })

    expect(prompt).toContain('Recovery mode after a Codex native mailbox timeout.')
    expect(prompt).toContain('Do not restart from scratch.')
    expect(prompt).toContain('Task reference: #545b704e.')
    expect(prompt).toContain('<queued_mailbox_message>')
    expect(prompt).toContain(text)
  })

  test('lifecycle - second ordinary timeout notifies failure instead of recovering again', () => {
    const submitted = createUserMessage({
      content: 'ordinary recovery handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const timeout = createAssistantAPIErrorMessage({
      content: 'Codex native exec timed out after 300000ms of inactivity.',
      errorDetails: 'Codex native exec timed out after 300000ms of inactivity.',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, timeout],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Task assigned: taskId: "545b704e"',
        },
        recoveryAttemptCount: 1,
      }),
    ).toEqual({
      type: 'notify_failure',
      detail: 'Codex native exec timed out after 300000ms of inactivity.',
      reason: 'timeout_recovery_failed',
      taskRef: '545b704e',
    })
  })

  test('lifecycle - recovery API error notifies failure instead of finalizing', () => {
    const submitted = createUserMessage({
      content: 'ordinary recovery handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'Rate limit reached.',
      errorDetails: 'Rate limit reached.',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, apiError],
        processingOrdinaryMessage: {
          id: 'row-regular',
          messageId: 'mailbox-regular',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Task assigned: taskId: "545b704e"',
        },
        recoveryAttemptCount: 1,
      }),
    ).toEqual({
      type: 'notify_failure',
      detail: 'Rate limit reached.',
      reason: 'timeout_recovery_failed',
      taskRef: '545b704e',
    })
  })
})
