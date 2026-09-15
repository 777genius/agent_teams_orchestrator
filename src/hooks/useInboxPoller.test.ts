import { describe, expect, test } from 'bun:test'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractTaskRefFromMailboxText,
  findBootstrapAttemptOutcome,
  findMemberWorkSyncNudgeOutcome,
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
  getProcessingOrdinaryMessage,
  getOrdinaryPendingMessage,
  getBootstrapPendingMessage,
  getBootstrapMessageIdsToFinalize,
  getBootstrapProcessingMessage,
  getQueuedMailboxMetaPrompt,
  resolveOrdinaryUserDirectReplyProtocol,
  buildAgentErrorNotificationText,
  buildOrdinaryAgentErrorMetadata,
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
import {
  armWorkSyncPostTurnAdmissionWindow,
  bindWorkSyncContinuationAdmission,
  resetWorkSyncAdmissionProcessorForTests,
  unbindWorkSyncContinuationAdmission,
} from '../utils/workSyncContinuationAdmission.js'
import { QueryGuard } from '../utils/QueryGuard.js'

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

  test('builds structured terminal metadata for outer runtime recovery', () => {
    expect(
      buildOrdinaryAgentErrorMetadata({
        reason: 'execution_failed',
        detail: 'API Error: 529 overloaded_error',
        failedMessageId: 'recovery-message-1',
        runtimeSessionId: 'runtime-session-1',
        bootstrapRunId: 'bootstrap-run-1',
        innerRecoveryAttempts: 3,
      }),
    ).toEqual({
      schemaVersion: 1,
      type: 'api_error',
      phase: 'terminal',
      detail: 'API Error: 529 overloaded_error',
      failedMessageId: 'recovery-message-1',
      runtimeSessionId: 'runtime-session-1',
      bootstrapRunId: 'bootstrap-run-1',
      innerRecoveryAttempts: 3,
    })
  })

  test('finds the actionable bootstrap row for teammate sessions', () => {
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

  test('prefers the last appended bootstrap row when stale launch rows are still pending', () => {
    expect(
      getBootstrapPendingMessage({
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'old-row',
            messageId: 'old-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:05.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'regular-row',
            messageId: 'regular',
            mailboxClaimedBySessionId: 's',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-09T13:00:02.000Z',
            text: 'Ping.',
          },
          {
            id: 'new-row',
            messageId: 'new-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:03.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      })?.messageId,
    ).toBe('new-bootstrap')
  })

  test('ignores non-pending bootstrap rows when choosing delivery', () => {
    expect(
      getBootstrapPendingMessage({
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'processing-row',
            messageId: 'processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:03.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'processed-row',
            messageId: 'processed-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processed',
            timestamp: '2026-04-09T13:00:04.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('collects all active bootstrap rows for finalization', () => {
    expect(
      getBootstrapMessageIdsToFinalize({
        messages: [
          {
            id: 'old-row',
            messageId: 'old-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'new-row',
            messageId: 'new-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:03.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'regular-row',
            messageId: 'regular',
            mailboxClaimedBySessionId: 's',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-09T13:00:04.000Z',
            text: 'Ping.',
          },
        ],
      }),
    ).toEqual(['old-bootstrap', 'new-bootstrap'])
  })

  test('finds the newest processing bootstrap row when no fresh pending row exists', () => {
    expect(
      getBootstrapProcessingMessage({
        messages: [
          {
            id: 'old-processing-row',
            messageId: 'old-processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'new-processing-row',
            messageId: 'new-processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      })?.messageId,
    ).toBe('new-processing-bootstrap')
  })

  test('lets the newest pending bootstrap row outrank stale processing rows', () => {
    expect(
      getBootstrapProcessingMessage({
        messages: [
          {
            id: 'stale-processing-row',
            messageId: 'stale-processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'fresh-pending-row',
            messageId: 'fresh-pending-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('does not fall back to stale processing bootstrap rows when the newest active row is unprocessable', () => {
    expect(
      getBootstrapProcessingMessage({
        messages: [
          {
            id: 'stale-processing-row',
            messageId: 'stale-processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'newer-processing-row-without-message-id',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      }),
    ).toBeUndefined()
  })

  test('keeps processing the newest bootstrap row when older pending rows remain', () => {
    expect(
      getBootstrapProcessingMessage({
        messages: [
          {
            id: 'stale-pending-row',
            messageId: 'stale-pending-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'pending',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
          {
            id: 'current-processing-row',
            messageId: 'current-processing-bootstrap',
            mailboxClaimedBySessionId: 's',
            from: 'team-lead',
            status: 'processing',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"harbor-labs"}',
          },
        ],
      })?.messageId,
    ).toBe('current-processing-bootstrap')
  })

  test('finds the first actionable ordinary regular row', () => {
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [
          {
            id: 'agent-error-row',
            messageId: 'agent-error-1',
            mailboxClaimedBySessionId: 's',
            from: 'bob',
            status: 'pending',
            timestamp: '2026-04-09T13:00:00.500Z',
            text: 'bob hit a mailbox turn execution error. API Error: balance exhausted',
            messageKind: 'agent_error',
          },
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

  test('prioritizes member work-sync nudges over older ordinary rows', () => {
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [
          {
            id: 'older',
            messageId: 'regular-before-nudge',
            mailboxClaimedBySessionId: 's',
            from: 'user',
            status: 'pending',
            timestamp: '2026-04-09T13:00:00.000Z',
            text: 'Ping before work sync.',
          },
          {
            id: 'nudge',
            messageId: 'work-sync-nudge',
            mailboxClaimedBySessionId: 's',
            from: 'system',
            status: 'pending',
            timestamp: '2026-04-09T13:00:01.000Z',
            text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
            messageKind: 'member_work_sync_nudge',
          },
        ],
      })?.messageId,
    ).toBe('work-sync-nudge')
  })

  test('after handshake, skips unticketed work-sync nudges so D1 reserve can win idle', () => {
    const pendingMessages = [
      {
        id: 'nudge',
        messageId: 'work-sync-nudge',
        mailboxClaimedBySessionId: 's',
        from: 'system',
        status: 'pending' as const,
        timestamp: '2026-04-09T13:00:01.000Z',
        text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        messageKind: 'member_work_sync_nudge' as const,
      },
      {
        id: 'ticketed',
        messageId: 'work-sync-ticketed',
        mailboxClaimedBySessionId: 's',
        from: 'system',
        status: 'pending' as const,
        timestamp: '2026-04-09T13:00:02.000Z',
        text: 'Early continuation: continue remaining assigned work.',
        messageKind: 'member_work_sync_nudge' as const,
        workSyncRuntimeTicketId: 'ticket-1',
        workSyncRuntimeGeneration: 0,
        workSyncRuntimeInstanceId: 'runtime-1',
        workSyncIntentId: 'intent-c1',
      },
    ]
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c1',
      reservationNonce: 'ticket-1',
    })
    bindWorkSyncContinuationAdmission({
      guard,
      teamName: 'team-a',
      memberName: 'bob',
    })
    try {
      expect(
        getOrdinaryPendingMessage({
          pendingMessages,
          deferUnticketedWorkSyncNudges: true,
        })?.messageId,
      ).toBe('work-sync-ticketed')
      expect(
        getOrdinaryPendingMessage({
          pendingMessages: [pendingMessages[0]!],
          deferUnticketedWorkSyncNudges: true,
        }),
      ).toBeUndefined()
      expect(
        getOrdinaryPendingMessage({
          pendingMessages: [pendingMessages[0]!],
          deferUnticketedWorkSyncNudges: false,
        })?.messageId,
      ).toBe('work-sync-nudge')
    } finally {
      unbindWorkSyncContinuationAdmission()
    }
  })

  test('skips a stale ticketed envelope so a newer ticket or user mailbox can proceed', () => {
    const stale = {
      id: 'c1',
      messageId: 'work-sync-c1',
      mailboxClaimedBySessionId: 's',
      from: 'system',
      status: 'pending' as const,
      timestamp: '2026-04-09T13:00:01.000Z',
      text: 'Early continuation C1.',
      messageKind: 'member_work_sync_nudge' as const,
      workSyncRuntimeTicketId: 'ticket-c1',
      workSyncRuntimeGeneration: 0,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncIntentId: 'intent-c1',
    }
    const next = {
      id: 'c2',
      messageId: 'work-sync-c2',
      mailboxClaimedBySessionId: 's',
      from: 'system',
      status: 'pending' as const,
      timestamp: '2026-04-09T13:00:02.000Z',
      text: 'Early continuation C2.',
      messageKind: 'member_work_sync_nudge' as const,
      workSyncRuntimeTicketId: 'ticket-c2',
      workSyncRuntimeGeneration: 0,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncIntentId: 'intent-c2',
    }
    const user = {
      id: 'user-row',
      messageId: 'user-1',
      mailboxClaimedBySessionId: 's',
      from: 'user',
      status: 'pending' as const,
      timestamp: '2026-04-09T13:00:03.000Z',
      text: 'Please look at this.',
    }
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 0,
      intentId: 'intent-c2',
      reservationNonce: 'ticket-c2',
    })
    bindWorkSyncContinuationAdmission({
      guard,
      teamName: 'team-a',
      memberName: 'bob',
    })
    try {
      expect(
        getOrdinaryPendingMessage({
          pendingMessages: [stale, next],
          deferUnticketedWorkSyncNudges: true,
        })?.messageId,
      ).toBe('work-sync-c2')
    } finally {
      unbindWorkSyncContinuationAdmission()
    }
    expect(
      getOrdinaryPendingMessage({
        pendingMessages: [stale, user],
        deferUnticketedWorkSyncNudges: true,
      })?.messageId,
    ).toBe('user-1')
  })

  test('builds an inline ordinary mailbox handoff from the row itself', () => {
    const prompt = getOrdinaryInlineHandoffPrompt({
      from: 'user',
      memberName: 'jack',
      messageId: 'mailbox-1',
      replyProtocol: 'agent_teams_message_send',
      text: '<info_for_agent>reply via SendMessage</info_for_agent>\n\nТут?',
      teamName: 'harbor-labs',
      timestamp: '2026-04-09T13:38:16.210Z',
    })

    expect(prompt).toContain('Process this queued mailbox message now.')
    expect(prompt).toContain('Sender: "user".')
    expect(prompt).toContain('Timestamp: "2026-04-09T13:38:16.210Z".')
    expect(prompt).toContain('agent-teams_message_send')
    expect(prompt).toContain('teamName="harbor-labs"')
    expect(prompt).toContain('from="jack"')
    expect(prompt).toContain('relayOfMessageId="mailbox-1"')
    expect(prompt).toContain('supersedes older SendMessage-only wording')
    expect(prompt).toContain('<queued_mailbox_message>')
    expect(prompt).toContain('reply via SendMessage')
    expect(prompt).toContain('Тут?')
  })

  test('keeps SendMessage handoff for non-Codex user direct messages', () => {
    const prompt = getOrdinaryInlineHandoffPrompt({
      from: 'user',
      memberName: 'jack',
      messageId: 'mailbox-1',
      replyProtocol: 'send_message',
      text: 'Тут?',
      teamName: 'harbor-labs',
      timestamp: '2026-04-09T13:38:16.210Z',
    })

    expect(prompt).toContain('reply via SendMessage')
    expect(prompt).not.toContain('agent-teams_message_send')
    expect(prompt).not.toContain('relayOfMessageId="mailbox-1"')
  })

  test('uses Codex MCP message and board-tool hints for team-lead mailbox messages', () => {
    const prompt = getOrdinaryInlineHandoffPrompt({
      from: 'team-lead',
      memberName: 'bob',
      messageId: 'mailbox-2',
      replyProtocol: 'agent_teams_message_send',
      text: 'New task assigned. Use task_get and member_work_sync_status.',
      teamName: 'harbor-labs',
      timestamp: '2026-04-09T13:38:16.210Z',
    })

    expect(prompt).toContain('reply via agent-teams_message_send')
    expect(prompt).toContain('to="team-lead"')
    expect(prompt).toContain('from="bob"')
    expect(prompt).toContain('Do not use SendMessage for this Codex-native handoff')
    expect(prompt).toContain('mcp__agent-teams__task_get')
    expect(prompt).toContain('mcp__agent-teams__member_work_sync_status')
    expect(prompt).toContain('Do not run shell searches or list MCP resources')
  })

  test('falls back to SendMessage handoff when Codex MCP context is incomplete', () => {
    const prompt = getOrdinaryInlineHandoffPrompt({
      from: ' user ',
      memberName: 'jack',
      messageId: 'mailbox-1',
      replyProtocol: 'agent_teams_message_send',
      text: 'Тут?',
      teamName: ' ',
      timestamp: '2026-04-09T13:38:16.210Z',
    })

    expect(prompt).toContain('reply via SendMessage')
    expect(prompt).not.toContain('agent-teams_message_send')
    expect(prompt).not.toContain('relayOfMessageId="mailbox-1"')
  })

  test('resolves MCP handoff only for explicit Codex entry provider', () => {
    expect(resolveOrdinaryUserDirectReplyProtocol('codex')).toBe(
      'agent_teams_message_send',
    )
    expect(resolveOrdinaryUserDirectReplyProtocol('CODEx')).toBe(
      'agent_teams_message_send',
    )
    expect(resolveOrdinaryUserDirectReplyProtocol('anthropic')).toBe(
      'send_message',
    )
    expect(resolveOrdinaryUserDirectReplyProtocol('gemini')).toBe(
      'send_message',
    )
    expect(resolveOrdinaryUserDirectReplyProtocol(undefined)).toBe(
      'send_message',
    )
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

  test('defers while loading when only an already-processing bootstrap row exists', () => {
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
            status: 'processing',
            timestamp: '2026-04-22T19:50:57.224Z',
            text: 'Your FIRST action: call MCP tool member_briefing with: {"teamName":"relay-works-6","memberName":"alice"}',
          },
        ],
      }),
    ).toBe(true)
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

  test('defers ordinary delivery during the post-turn D1 admission window', () => {
    armWorkSyncPostTurnAdmissionWindow(Date.now(), 5_000)
    expect(
      shouldDeferPendingInboxDelivery({
        isLoading: false,
        focusedInputDialog: undefined,
        isTeammateSession: true,
        pendingMessages: [
          {
            id: 'nudge',
            messageId: 'work-sync-nudge',
            mailboxClaimedBySessionId: 'session-1',
            from: 'system',
            status: 'pending',
            timestamp: '2026-04-22T19:50:57.224Z',
            text: 'Work sync check: call member_work_sync_status.',
            messageKind: 'member_work_sync_nudge',
          },
        ],
      }),
    ).toBe(true)
    resetWorkSyncAdmissionProcessorForTests()
  })

  test('defers ticketed continuation while the test consume-hold file exists', () => {
    const holdPath = join(tmpdir(), `work-sync-hold-${Date.now()}`)
    writeFileSync(holdPath, 'hold\n')
    const previous = process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
    process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = holdPath
    const guard = new QueryGuard('runtime-1')
    guard.reserveContinuation({
      runtimeInstanceId: 'runtime-1',
      expectedGeneration: 1,
      intentId: 'work-sync-nudge',
      reservationNonce: 'ticket-1',
    })
    bindWorkSyncContinuationAdmission({
      guard,
      teamName: 'team-a',
      memberName: 'bob',
    })
    try {
      expect(
        shouldDeferPendingInboxDelivery({
          isLoading: false,
          focusedInputDialog: undefined,
          isTeammateSession: true,
          pendingMessages: [
            {
              id: 'nudge',
              messageId: 'work-sync-nudge',
              mailboxClaimedBySessionId: 'session-1',
              from: 'system',
              status: 'pending',
              timestamp: '2026-04-22T19:50:57.224Z',
              text: 'Early continuation',
              messageKind: 'member_work_sync_nudge',
              workSyncRuntimeTicketId: 'ticket-1',
              workSyncRuntimeInstanceId: 'runtime-1',
              workSyncRuntimeGeneration: 1,
            },
          ],
        }),
      ).toBe(true)
    } finally {
      unbindWorkSyncContinuationAdmission()
      unlinkSync(holdPath)
      if (previous === undefined) {
        delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
      } else {
        process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = previous
      }
    }
  })

  test('does not defer bootstrap while the test consume-hold file exists', () => {
    const holdPath = join(tmpdir(), `work-sync-hold-bootstrap-${Date.now()}`)
    writeFileSync(holdPath, 'hold\n')
    const previous = process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
    process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = holdPath
    try {
      expect(
        shouldDeferPendingInboxDelivery({
          isLoading: false,
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
    } finally {
      unlinkSync(holdPath)
      if (previous === undefined) {
        delete process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH
      } else {
        process.env.CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH = previous
      }
    }
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

  test('detects successful Agent Teams message_send to user as ordinary direct reply', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-message-send',
          input: {
            from: 'jack',
            relayOfMessageId: 'mailbox-regular',
            source: 'runtime_delivery',
            summary: 'Ответ',
            teamName: 'harbor-labs',
            text: 'На месте.',
            to: ' user ',
          },
          name: 'agent-teams_message_send',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-message-send',
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

  test('accepts bare message_send only when teamName matches ordinary direct context', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-message-send',
          input: {
            from: 'jack',
            summary: 'Ответ',
            teamName: 'harbor-labs',
            text: 'На месте.',
            to: 'user',
          },
          name: 'message_send',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-message-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'harbor-labs',
      }),
    ).toBe('user_send_message')
    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'other-team',
      }),
    ).toBe('none')
  })

  test('does not finalize prefixed Agent Teams message_send when explicit teamName conflicts', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-message-send',
          input: {
            from: 'jack',
            summary: 'Ответ',
            teamName: 'other-team',
            text: 'На месте.',
            to: 'user',
          },
          name: 'mcp__agent-teams__message_send',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-message-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'harbor-labs',
      }),
    ).toBe('none')
  })

  test('does not treat cross_team_send as the direct user reply for an ordinary DM', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'Запросил у внешней команды, вернусь с ответом.', type: 'text' } as never,
        {
          id: 'tool-cross-team-send',
          input: {
            teamName: 'harbor-labs',
            text: 'Нужна проверка по этому вопросу.',
            toTeam: 'other-team',
          },
          name: 'mcp__agent-teams__cross_team_send',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-cross-team-send',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'harbor-labs',
      }),
    ).toBe('none')
    expect(
      findOrdinaryDirectReplyFallback({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'harbor-labs',
      }),
    ).toEqual({ text: 'Запросил у внешней команды, вернусь с ответом.' })
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

  test('does not fallback plain text when Agent Teams message_send to user was attempted', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'Отвечаю через MCP.', type: 'text' } as never,
        {
          id: 'tool-message-send',
          input: {
            from: 'jack',
            summary: 'Ответ',
            teamName: 'harbor-labs',
            text: 'На месте.',
            to: 'user',
          },
          name: 'mcp__agent-teams__message_send',
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

  test('does not suppress plain-text fallback for bare message_send from another team', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'На месте.', type: 'text' } as never,
        {
          id: 'tool-message-send',
          input: {
            from: 'jack',
            summary: 'Ответ',
            teamName: 'other-team',
            text: 'На месте.',
            to: 'user',
          },
          name: 'message_send',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findOrdinaryDirectReplyFallback({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
        teamName: 'harbor-labs',
      }),
    ).toEqual({ text: 'На месте.' })
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

  test('lifecycle - native app-managed bootstrap finalizes after private response proof', () => {
    const submitted = createUserMessage({
      content: '<agent_teams_native_app_managed_bootstrap_check>',
      isMeta: true,
      uuid: 'native-bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'Startup context received.', type: 'text' } as never,
      ],
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          nativeAppManaged: {
            bootstrapProofToken: 'proof-token',
            briefingHash: 'briefing-hash',
            contextHash: 'context-hash',
            runId: 'run-native-bootstrap',
          },
          status: 'in_flight',
          submitUserMessageUuid: 'native-bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: '<agent_teams_native_app_managed_bootstrap_check>',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - native app-managed bootstrap treats non-error prose as proof', () => {
    const submitted = createUserMessage({
      content: '<agent_teams_native_app_managed_bootstrap_check>',
      isMeta: true,
      uuid: 'native-bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: 'Startup context received. I see no API errors.', type: 'text' } as never,
      ],
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          nativeAppManaged: {
            bootstrapProofToken: 'proof-token',
            briefingHash: 'briefing-hash',
            contextHash: 'context-hash',
            runId: 'run-native-bootstrap',
          },
          status: 'in_flight',
          submitUserMessageUuid: 'native-bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: '<agent_teams_native_app_managed_bootstrap_check>',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('lifecycle - native app-managed bootstrap keeps empty assistant turn retryable', () => {
    const submitted = createUserMessage({
      content: '<agent_teams_native_app_managed_bootstrap_check>',
      isMeta: true,
      uuid: 'native-bootstrap-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        { text: '(no content)', type: 'text' } as never,
      ],
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          nativeAppManaged: {
            bootstrapProofToken: 'proof-token',
            briefingHash: 'briefing-hash',
            contextHash: 'context-hash',
            runId: 'run-native-bootstrap',
          },
          status: 'in_flight',
          submitUserMessageUuid: 'native-bootstrap-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant],
        processingBootstrapMessage: {
          id: 'row-1',
          messageId: 'mailbox-1',
          mailboxClaimedBySessionId: 'session-1',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: '<agent_teams_native_app_managed_bootstrap_check>',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown' })
  })

  test('lifecycle - native app-managed bootstrap fails on terminal provider error', () => {
    const submitted = createUserMessage({
      content: '<agent_teams_native_app_managed_bootstrap_check>',
      isMeta: true,
      uuid: 'native-bootstrap-uuid',
    })
    const apiError = createAssistantAPIErrorMessage({
      content: 'Please run /login',
      errorDetails: 'API Error: 401 invalid authentication credentials',
    })

    expect(
      getBootstrapProcessingAction({
        attempt: {
          cooldownUntil: 0,
          nativeAppManaged: {
            bootstrapProofToken: 'proof-token',
            briefingHash: 'briefing-hash',
            contextHash: 'context-hash',
            runId: 'run-native-bootstrap',
          },
          status: 'in_flight',
          submitUserMessageUuid: 'native-bootstrap-uuid',
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
          text: '<agent_teams_native_app_managed_bootstrap_check>',
        },
      }),
    ).toEqual({
      type: 'fail',
      detail: 'API Error: 401 invalid authentication credentials',
    })
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

  test('lifecycle - ordinary direct row relays plain text for trimmed user sender', () => {
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
          from: ' user ',
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

  test('detects successful member_work_sync_report after a work-sync nudge', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: 'report accepted',
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('report')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('work-sync nudge waits while member_work_sync_report result is pending', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('pending_tool')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1_000,
          timer: null,
        },
        messages: [submitted, assistant],
        now: 1_000 + 119_999,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'noop' })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1_000,
          timer: null,
        },
        messages: [submitted, assistant],
        now: 1_000 + 120_000,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('work-sync nudge waits while member_work_sync_status result is pending', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('pending_tool')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1_000,
          timer: null,
        },
        messages: [submitted, assistant],
        now: 1_000 + 119_999,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'noop' })
  })

  test('does not accept rejected member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: JSON.stringify({
            accepted: false,
            code: 'stale_agenda_fingerprint',
            message: 'Report rejected.',
          }),
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('does not accept generic non-empty member_work_sync_report output as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: 'ok',
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('does not accept object-content rejected member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: {
            accepted: false,
            code: 'report_token_invalid',
            message: 'Report rejected.',
          },
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')
  })

  test('accepts object-content accepted member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: {
            accepted: true,
            state: 'still_working',
          },
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('report')
  })

  test('does not accept wrapped rejected member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: [
            {
              text: [
                'Report rejected.',
                JSON.stringify({
                  accepted: false,
                  code: 'stale_agenda_fingerprint',
                  message: 'Report rejected for agenda {old}.',
                }),
                'Call status again.',
              ].join('\n'),
              type: 'text',
            },
          ],
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')
  })

  test('accepts later member_work_sync_report after an earlier rejected report', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const firstAssistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report-stale',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const firstToolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: JSON.stringify({
            accepted: false,
            code: 'stale_agenda_fingerprint',
          }),
          is_error: false,
          tool_use_id: 'tool-report-stale',
          type: 'tool_result',
        } as never,
      ],
    })
    const secondAssistant = createAssistantMessage({
      content: [
        {
          id: 'tool-report-current',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const secondToolResult = createUserMessage({
      content: [
        {
          content: JSON.stringify({
            accepted: true,
            state: 'still_working',
          }),
          is_error: false,
          tool_use_id: 'tool-report-current',
          type: 'tool_result',
        } as never,
      ],
    })
    const messages = [submitted, firstAssistant, firstToolResult, secondAssistant, secondToolResult]

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages,
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('report')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'finalize' })
  })

  test('prefers wrapped accepted flag over earlier JSON objects in report result', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: [
            {
              text: [
                'Debug context:',
                JSON.stringify({ tool: 'member_work_sync_report' }),
                'Result:',
                JSON.stringify({
                  accepted: false,
                  code: 'stale_agenda_fingerprint',
                }),
              ].join('\n'),
              type: 'text',
            },
          ],
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')
  })

  test('does not let earlier accepted debug JSON override a later rejected report result', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: [
            {
              text: [
                'Previous debug context:',
                JSON.stringify({ accepted: true, source: 'previous_attempt' }),
                'Actual result:',
                JSON.stringify({
                  accepted: false,
                  code: 'stale_agenda_fingerprint',
                }),
              ].join('\n'),
              type: 'text',
            },
          ],
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')
  })

  test('does not accept plain-text rejected member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: 'Report rejected. Call member_work_sync_status again.',
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')
  })

  test('does not accept plain-text stale member_work_sync_report as work-sync proof', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_status',
          type: 'tool_use',
        } as never,
        {
          id: 'tool-report',
          input: { memberName: 'atlas', state: 'still_working', teamName: 'best-team' },
          name: 'mcp__agent-teams__member_work_sync_report',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
        {
          content: 'Report fingerprint is stale. Read current member work sync status and retry.',
          is_error: false,
          tool_use_id: 'tool-report',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('work-sync nudge stays pending after status-only activity', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-status',
          input: { memberName: 'atlas', teamName: 'best-team' },
          name: 'member_work_sync_status',
          type: 'tool_use',
        } as never,
        { text: 'Status checked, still working.', type: 'text' } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'status ok',
          is_error: false,
          tool_use_id: 'tool-status',
          type: 'tool_result',
        } as never,
      ],
    })

    expect(
      findMemberWorkSyncNudgeOutcome({
        messages: [submitted, assistant, toolResult],
        submitUserMessageUuid: 'ordinary-uuid',
      }),
    ).toBe('status')

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1,
          timer: null,
        },
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('work-sync nudge waits briefly when the submitted turn has no activity yet', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1_000,
          timer: null,
        },
        messages: [submitted],
        now: 1_000 + 119_999,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'noop' })
  })

  test('work-sync nudge retries when the submitted turn has no activity for the stall window', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })

    expect(
      getOrdinaryProcessingAction({
        attempt: {
          cooldownUntil: 0,
          status: 'in_flight',
          submitUserMessageUuid: 'ordinary-uuid',
          submittedAt: 1_000,
          timer: null,
        },
        messages: [submitted],
        now: 1_000 + 120_000,
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('work-sync nudge does not finalize on plain assistant acknowledgement', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [{ text: 'Принял, продолжаю.', type: 'text' } as never],
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
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('work-sync nudge does not finalize on message_send without report', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
    })
    const assistant = createAssistantMessage({
      content: [
        {
          id: 'tool-message-send',
          input: {
            from: 'atlas',
            summary: 'Still working',
            teamName: 'best-team',
            text: 'Still working.',
            to: 'user',
          },
          name: 'agent-teams_message_send',
          type: 'tool_use',
        } as never,
      ],
    })
    const toolResult = createUserMessage({
      content: [
        {
          content: 'sent ok',
          is_error: false,
          tool_use_id: 'tool-message-send',
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
        messages: [submitted, assistant, toolResult],
        processingOrdinaryMessage: {
          id: 'row-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-work-sync',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
        teamName: 'best-team',
      }),
    ).toEqual({ type: 'schedule_cooldown', cooldownMs: 120000 })
  })

  test('ordinary processing selection skips cooling-down rows', () => {
    const selected = getProcessingOrdinaryMessage({
      messages: [
        {
          id: 'row-cooling',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-cooling',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Waiting for cooldown.',
        },
        {
          id: 'row-active',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-active',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:01:00.000Z',
          text: 'Active message.',
        },
      ],
      getAttemptStatus: messageId =>
        messageId === 'mailbox-cooling' ? 'cooling_down' : 'in_flight',
    })

    expect(selected?.id).toBe('row-active')
  })

  test('ordinary processing selection leaves only cooling-down rows unselected', () => {
    const selected = getProcessingOrdinaryMessage({
      messages: [
        {
          id: 'row-cooling',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-cooling',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Waiting for cooldown.',
        },
      ],
      getAttemptStatus: () => 'cooling_down',
    })

    expect(selected).toBeUndefined()
  })

  test('ordinary processing selection can rescue a cooling-down row after late terminal activity', () => {
    const selected = getProcessingOrdinaryMessage({
      messages: [
        {
          id: 'row-cooling',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-cooling',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check.',
        },
        {
          id: 'row-active',
          mailboxClaimedBySessionId: 'session-1',
          messageId: 'mailbox-active',
          from: 'team-lead',
          status: 'processing',
          timestamp: '2026-04-09T13:01:00.000Z',
          text: 'Active message.',
        },
      ],
      getAttemptStatus: messageId =>
        messageId === 'mailbox-cooling' ? 'cooling_down' : 'in_flight',
      shouldProcessCoolingDown: message => message.messageId === 'mailbox-cooling',
    })

    expect(selected?.id).toBe('row-cooling')
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
        now: 1000,
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

  test('lifecycle - ordinary row with no post-submit activity eventually cools down', () => {
    const submitted = createUserMessage({
      content: 'ordinary handoff',
      isMeta: true,
      uuid: 'ordinary-uuid',
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
        messages: [submitted],
        now: 120_001,
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
    ).toEqual({
      type: 'schedule_cooldown',
      cooldownMs: 5000,
    })
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

  test('work-sync API error schedules retry cooldown instead of terminal failure', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
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
          id: 'row-work-sync',
          messageId: 'mailbox-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
      }),
    ).toEqual({
      type: 'schedule_cooldown',
      cooldownMs: 120000,
    })
  })

  test('work-sync timeout schedules retry cooldown instead of timeout terminal failure', () => {
    const submitted = createUserMessage({
      content: 'work sync handoff',
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
          id: 'row-work-sync',
          messageId: 'mailbox-work-sync',
          mailboxClaimedBySessionId: 'session-1',
          messageKind: 'member_work_sync_nudge',
          from: 'system',
          status: 'processing',
          timestamp: '2026-04-09T13:00:00.000Z',
          text: 'Work sync check: call member_work_sync_status then member_work_sync_report.',
        },
        recoveryAttemptCount: 1,
      }),
    ).toEqual({
      type: 'schedule_cooldown',
      cooldownMs: 120000,
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
