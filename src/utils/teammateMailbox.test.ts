import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getSessionId,
  regenerateSessionId,
  resetStateForTests,
  switchSession,
} from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import {
  claimUnreadRegularMessages,
  classifyIdleNotification,
  createCompatibilityInboxMessageId,
  finalizeClaimedMessagesAsRead,
  isAgentErrorNotificationMessage,
  isLegacyPlanApprovalResponseMessage,
  isPlanApprovalResponse,
  isSilentRegularMailboxMessageForLiveContext,
  isLiveInboxMirrorMessageOwnedBySession,
  readAndClaimInteractiveMailboxSnapshot,
  readMailbox,
  readUnreadMessages,
  writeToMailbox,
} from './teammateMailbox.js'

const structuredModeSetRequest = JSON.stringify({
  type: 'mode_set_request',
  mode: 'acceptEdits',
  source: 'team-lead',
  reason: 'test',
})

const idleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:00.000Z',
  idleReason: 'available',
})

const failedIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:01.000Z',
  idleReason: 'failed',
  completedStatus: 'failed',
  failureReason: 'teammate crashed',
})

const summaryIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:02.000Z',
  idleReason: 'available',
  summary: '[to bob] aligned on API shape',
})

const whitespaceSummaryIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:02.500Z',
  idleReason: 'available',
  summary: '   ',
})

const interruptedIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:03.000Z',
  idleReason: 'interrupted',
  summary: '[to bob] stopped for clarification',
})

const resolvedTaskIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:04.000Z',
  completedTaskId: 'task-1',
  completedStatus: 'resolved',
  summary: '[to bob] task complete',
})

const blockedTaskIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:05.000Z',
  completedTaskId: 'task-2',
  completedStatus: 'blocked',
})

const implicitFailureIdleNotification = JSON.stringify({
  type: 'idle_notification',
  from: 'alice',
  timestamp: '2026-01-01T00:00:06.000Z',
  failureReason: 'filesystem permission denied',
})

describe('teammateMailbox', () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempConfigDir: string

  beforeEach(async () => {
    resetStateForTests()
    tempConfigDir = await mkdtemp(join(tmpdir(), 'teammate-mailbox-test-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  })

  afterEach(async () => {
    resetStateForTests()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(tempConfigDir, { recursive: true, force: true })
  })

  it('uses the documented compatibility vector for legacy rows', () => {
    expect(
      createCompatibilityInboxMessageId({
        from: 'alice',
        text: 'legacy',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe('inbox-3d4d01c54fc0dc52')
  })

  it('classifies legacy plan approval responses without treating them as approvals', () => {
    const legacyResponse = JSON.stringify({
      type: 'plan_approval_response',
      request_id: 'perm-1',
      approve: true,
    })

    expect(isLegacyPlanApprovalResponseMessage(legacyResponse)).toBe(true)
    expect(isPlanApprovalResponse(legacyResponse)).toBeNull()
  })

  it('writes canonical message ids for new mailbox rows', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'hello',
        timestamp: '2026-01-02T00:00:00.000Z',
      },
      'my-team',
    )

    const [message] = await readMailbox('team-lead', 'my-team')
    expect(message).toMatchObject({
      from: 'alice',
      text: 'hello',
      read: false,
      messageId: createCompatibilityInboxMessageId({
        from: 'alice',
        text: 'hello',
        timestamp: '2026-01-02T00:00:00.000Z',
      }),
    })
  })

  it('preserves agent error message kind in the team lead inbox', async () => {
    await writeToMailbox(
      'team-lead',
      {
        messageId: 'agent-error-1',
        from: 'alice',
        text: 'alice hit a mailbox turn execution error. API Error: balance exhausted',
        timestamp: '2026-01-02T00:00:00.000Z',
        messageKind: 'agent_error',
      },
      'my-team',
    )

    const [message] = await readMailbox('team-lead', 'my-team')
    expect(message?.messageKind).toBe('agent_error')
    expect(message && isAgentErrorNotificationMessage(message)).toBe(true)
  })

  it('classifies only availability-only idle notifications as silent regular live-context messages', () => {
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: idleNotification,
      }),
    ).toBe(true)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: summaryIdleNotification,
      }),
    ).toBe(true)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: whitespaceSummaryIdleNotification,
      }),
    ).toBe(true)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: failedIdleNotification,
      }),
    ).toBe(false)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: interruptedIdleNotification,
      }),
    ).toBe(false)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: 'normal teammate update',
      }),
    ).toBe(false)
    expect(
      isSilentRegularMailboxMessageForLiveContext({
        text: structuredModeSetRequest,
      }),
    ).toBe(false)
  })

  it('classifies heartbeat, passive peer summary, interrupted, and failure semantics without drift', () => {
    expect(classifyIdleNotification(idleNotification)).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'silent_finalize',
      uiPresentation: 'heartbeat',
    })

    expect(classifyIdleNotification(summaryIdleNotification)).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: true,
      peerSummary: '[to bob] aligned on API shape',
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'passive_activity',
      uiPresentation: 'peer_summary',
    })

    expect(classifyIdleNotification(whitespaceSummaryIdleNotification)).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      peerSummary: null,
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'silent_finalize',
      uiPresentation: 'heartbeat',
    })

    expect(classifyIdleNotification(interruptedIdleNotification)).toMatchObject({
      primaryKind: 'interrupted',
      hasPeerSummary: true,
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'interrupted',
    })

    expect(classifyIdleNotification(resolvedTaskIdleNotification)).toMatchObject({
      primaryKind: 'task_terminal',
      hasPeerSummary: true,
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'task_terminal',
    })

    expect(classifyIdleNotification(blockedTaskIdleNotification)).toMatchObject({
      primaryKind: 'task_terminal',
      hasPeerSummary: false,
      countsAsBootstrapConfirmation: true,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'task_terminal',
    })

    expect(classifyIdleNotification(failedIdleNotification)).toMatchObject({
      primaryKind: 'failure',
      hasPeerSummary: false,
      countsAsBootstrapConfirmation: false,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'failure',
    })

    expect(classifyIdleNotification(implicitFailureIdleNotification)).toMatchObject({
      primaryKind: 'failure',
      hasPeerSummary: false,
      countsAsBootstrapConfirmation: false,
      liveDelivery: 'visible_actionable',
      uiPresentation: 'failure',
    })
  })

  it('uses only payload summary for classification and ignores mailbox-row preview summary drift', () => {
    expect(
      classifyIdleNotification({
        text: idleNotification,
        summary: 'preview only and must be ignored',
      }),
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: false,
      liveDelivery: 'silent_finalize',
      uiPresentation: 'heartbeat',
    })

    expect(
      classifyIdleNotification({
        text: summaryIdleNotification,
      }),
    ).toMatchObject({
      primaryKind: 'heartbeat',
      hasPeerSummary: true,
      peerSummary: '[to bob] aligned on API shape',
      liveDelivery: 'passive_activity',
      uiPresentation: 'peer_summary',
    })
  })

  it('claims only regular unread rows and finalizes only the current session claim', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'regular-1',
        timestamp: '2026-01-03T00:00:00.000Z',
      },
      'my-team',
    )
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: structuredModeSetRequest,
        timestamp: '2026-01-03T00:00:01.000Z',
      },
      'my-team',
    )
    await writeToMailbox(
      'team-lead',
      {
        from: 'bob',
        text: 'regular-2',
        timestamp: '2026-01-03T00:00:02.000Z',
      },
      'my-team',
    )

    const claimed = await claimUnreadRegularMessages(
      'team-lead',
      'session-a',
      'my-team',
    )
    expect(claimed.map(message => message.text)).toEqual([
      'regular-1',
      'regular-2',
    ])
    expect(
      claimed.every(message => message.claimedBySessionId === 'session-a'),
    ).toBe(true)

    const unreadAfterClaim = await readUnreadMessages('team-lead', 'my-team')
    expect(
      unreadAfterClaim.map(message => ({
        text: message.text,
        claimedBySessionId: message.claimedBySessionId,
        read: message.read,
      })),
    ).toEqual([
      {
        text: 'regular-1',
        claimedBySessionId: 'session-a',
        read: false,
      },
      {
        text: structuredModeSetRequest,
        claimedBySessionId: undefined,
        read: false,
      },
      {
        text: 'regular-2',
        claimedBySessionId: 'session-a',
        read: false,
      },
    ])

    await finalizeClaimedMessagesAsRead(
      'team-lead',
      claimed.map(message => message.messageId),
      'session-b',
      'my-team',
    )

    const unreadAfterWrongSessionFinalize = await readUnreadMessages(
      'team-lead',
      'my-team',
    )
    expect(
      unreadAfterWrongSessionFinalize.filter(message =>
        message.text.startsWith('regular-'),
      ),
    ).toHaveLength(2)

    await finalizeClaimedMessagesAsRead(
      'team-lead',
      claimed.map(message => message.messageId),
      'session-a',
      'my-team',
    )

    const unreadAfterFinalize = await readUnreadMessages('team-lead', 'my-team')
    expect(unreadAfterFinalize.map(message => message.text)).toEqual([
      structuredModeSetRequest,
    ])
  })

  it('atomically returns protocol rows while claiming only regular rows for interactive polling', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'regular-message',
        timestamp: '2026-01-03T00:10:00.000Z',
      },
      'my-team',
    )
    await writeToMailbox(
      'team-lead',
      {
        from: 'team-lead',
        text: structuredModeSetRequest,
        timestamp: '2026-01-03T00:10:01.000Z',
      },
      'my-team',
    )

    const snapshot = await readAndClaimInteractiveMailboxSnapshot(
      'team-lead',
      'session-a',
      'my-team',
    )

    expect(snapshot.regularClaimed.map(message => message.text)).toEqual([
      'regular-message',
    ])
    expect(snapshot.protocolUnread.map(message => message.text)).toEqual([
      structuredModeSetRequest,
    ])

    const unread = await readUnreadMessages('team-lead', 'my-team')
    expect(unread).toHaveLength(2)
    const regularRow = unread.find(message => message.text === 'regular-message')
    expect(regularRow?.claimedBySessionId).toBe('session-a')
    const protocolRow = unread.find(
      message => message.text === structuredModeSetRequest,
    )
    expect(protocolRow?.claimedBySessionId).toBeUndefined()
  })

  it('allows stale-claim takeover only after the configured timeout', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'stale-message',
        timestamp: '2026-01-04T00:00:00.000Z',
      },
      'my-team',
    )
    await writeToMailbox(
      'team-lead',
      {
        from: 'bob',
        text: 'fresh-message',
        timestamp: '2026-01-04T00:00:01.000Z',
      },
      'my-team',
    )

    const [staleMessage, freshMessage] = await claimUnreadRegularMessages(
      'team-lead',
      'session-a',
      'my-team',
      {
        now: '2026-01-04T00:00:10.000Z',
      },
    )
    expect([staleMessage.text, freshMessage.text]).toEqual([
      'stale-message',
      'fresh-message',
    ])

    const claimedTooEarly = await claimUnreadRegularMessages(
      'team-lead',
      'session-b',
      'my-team',
      {
        now: '2026-01-04T00:04:59.000Z',
      },
    )
    expect(claimedTooEarly).toHaveLength(0)

    const claimedBySessionB = await claimUnreadRegularMessages(
      'team-lead',
      'session-b',
      'my-team',
      {
        now: '2026-01-04T00:06:11.000Z',
      },
    )
    expect(claimedBySessionB.map(message => message.text)).toEqual([
      'stale-message',
      'fresh-message',
    ])
    expect(
      claimedBySessionB.every(message => message.claimedBySessionId === 'session-b'),
    ).toBe(true)
  })

  it('allows same-session recovery without waiting for stale timeout', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'recoverable-message',
        timestamp: '2026-01-05T00:00:00.000Z',
      },
      'my-team',
    )

    const [initialClaim] = await claimUnreadRegularMessages(
      'team-lead',
      'session-a',
      'my-team',
      {
        now: '2026-01-05T00:00:10.000Z',
      },
    )
    expect(initialClaim.claimedBySessionId).toBe('session-a')

    const [recoveredClaim] = await claimUnreadRegularMessages(
      'team-lead',
      'session-a',
      'my-team',
      {
        now: '2026-01-05T00:00:11.000Z',
      },
    )
    expect(recoveredClaim).toMatchObject({
      messageId: initialClaim.messageId,
      claimedBySessionId: 'session-a',
      text: 'recoverable-message',
    })
  })

  it('does not treat switchSession as same-session recovery before stale timeout', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'session-switch-boundary',
        timestamp: '2026-01-05T00:10:00.000Z',
      },
      'my-team',
    )

    const initialSessionId = getSessionId()
    const [initialClaim] = await claimUnreadRegularMessages(
      'team-lead',
      initialSessionId,
      'my-team',
      {
        now: '2026-01-05T00:10:10.000Z',
      },
    )
    expect(initialClaim.claimedBySessionId).toBe(initialSessionId)

    switchSession(
      asSessionId('11111111-1111-4111-8111-111111111111'),
      null,
    )
    const switchedSessionId = getSessionId()
    expect(switchedSessionId).not.toBe(initialSessionId)

    const afterSwitchClaim = await claimUnreadRegularMessages(
      'team-lead',
      switchedSessionId,
      'my-team',
      {
        now: '2026-01-05T00:10:11.000Z',
      },
    )
    expect(afterSwitchClaim).toHaveLength(0)
  })

  it('does not treat regenerateSessionId as same-session recovery before stale timeout', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'clear-boundary',
        timestamp: '2026-01-05T00:20:00.000Z',
      },
      'my-team',
    )

    const initialSessionId = getSessionId()
    const [initialClaim] = await claimUnreadRegularMessages(
      'team-lead',
      initialSessionId,
      'my-team',
      {
        now: '2026-01-05T00:20:10.000Z',
      },
    )
    expect(initialClaim.claimedBySessionId).toBe(initialSessionId)

    const regeneratedSessionId = regenerateSessionId()
    expect(regeneratedSessionId).not.toBe(initialSessionId)

    const afterClearClaim = await claimUnreadRegularMessages(
      'team-lead',
      regeneratedSessionId,
      'my-team',
      {
        now: '2026-01-05T00:20:11.000Z',
      },
    )
    expect(afterClearClaim).toHaveLength(0)
  })

  it('treats only current-session regular mirror rows as live-owned', () => {
    expect(
      isLiveInboxMirrorMessageOwnedBySession(
        {
          text: 'regular-message',
          mailboxClaimedBySessionId: 'session-a',
        },
        'session-a',
      ),
    ).toBe(true)

    expect(
      isLiveInboxMirrorMessageOwnedBySession(
        {
          text: 'regular-message',
          mailboxClaimedBySessionId: 'session-b',
        },
        'session-a',
      ),
    ).toBe(false)

    expect(
      isLiveInboxMirrorMessageOwnedBySession(
        {
          text: structuredModeSetRequest,
          mailboxClaimedBySessionId: undefined,
        },
        'session-a',
      ),
    ).toBe(true)
  })

  it('serializes concurrent claimers so a regular row gets one live owner', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'contended-message',
        timestamp: '2026-01-06T00:00:00.000Z',
      },
      'my-team',
    )

    const [claimA, claimB] = await Promise.all([
      claimUnreadRegularMessages('team-lead', 'session-a', 'my-team', {
        now: '2026-01-06T00:00:10.000Z',
      }),
      claimUnreadRegularMessages('team-lead', 'session-b', 'my-team', {
        now: '2026-01-06T00:00:10.000Z',
      }),
    ])

    const successfulClaimSets = [claimA, claimB].filter(
      claimedMessages => claimedMessages.length > 0,
    )
    expect(successfulClaimSets).toHaveLength(1)
    expect(successfulClaimSets[0]).toHaveLength(1)
    expect(successfulClaimSets[0]?.[0]?.text).toBe('contended-message')
  })

  it('keeps a second unread row untouched until the next cycle after exact finalize', async () => {
    await writeToMailbox(
      'team-lead',
      {
        from: 'alice',
        text: 'first-message',
        timestamp: '2026-01-07T00:00:00.000Z',
      },
      'my-team',
    )

    const [claimed] = await claimUnreadRegularMessages(
      'team-lead',
      'session-a',
      'my-team',
      {
        now: '2026-01-07T00:00:10.000Z',
      },
    )

    await writeToMailbox(
      'team-lead',
      {
        from: 'bob',
        text: 'second-message',
        timestamp: '2026-01-07T00:00:11.000Z',
      },
      'my-team',
    )

    await finalizeClaimedMessagesAsRead(
      'team-lead',
      [claimed.messageId],
      'session-a',
      'my-team',
    )

    const unread = await readUnreadMessages('team-lead', 'my-team')
    expect(unread.map(message => message.text)).toEqual(['second-message'])
  })
})
