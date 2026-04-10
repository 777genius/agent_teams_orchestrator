import { afterEach, describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import {
  BootstrapMemberBriefingLoopAbortError,
  clearBootstrapMemberBriefingLoopState,
  getActiveBootstrapMemberBriefingContext,
  isBootstrapMemberBriefingLoopAbortReason,
  prepareBootstrapMemberBriefingCall,
  resetBootstrapMemberBriefingGuardStateForTests,
  BOOTSTRAP_MEMBER_BRIEFING_LOOP_ABORT_REASON,
} from './teamBootstrapMemberBriefingGuard.js'

function createAppState(messages: AppState['inbox']['messages']): Pick<
  AppState,
  'inbox'
> {
  return {
    inbox: {
      messages,
    },
  }
}

function createBootstrapMirror(
  overrides: Partial<AppState['inbox']['messages'][number]> = {},
): AppState['inbox']['messages'][number] {
  return {
    id: 'bootstrap-1',
    messageId: 'bootstrap-msg-1',
    mailboxClaimedBySessionId: 'session-1',
    from: 'team-lead',
    text: 'Your FIRST action: call MCP tool member_briefing with: {}',
    timestamp: '2026-04-10T10:00:00.000Z',
    status: 'pending',
    ...overrides,
  }
}

afterEach(() => {
  resetBootstrapMemberBriefingGuardStateForTests()
})

describe('teamBootstrapMemberBriefingGuard', () => {
  test('detects an active live-owned bootstrap row for teammate sessions', () => {
    expect(
      getActiveBootstrapMemberBriefingContext({
        appState: createAppState([createBootstrapMirror()]),
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }),
    ).toEqual({
      teamName: 'vector-room',
      memberName: 'bob',
      bootstrapMirrorId: 'bootstrap-1',
      bootstrapMessageId: 'bootstrap-msg-1',
    })
  })

  test('returns no bootstrap context outside teammate bootstrap', () => {
    expect(
      getActiveBootstrapMemberBriefingContext({
        appState: createAppState([createBootstrapMirror()]),
        currentSessionId: 'session-1',
        isTeammateSession: false,
        teamName: 'vector-room',
        memberName: 'bob',
      }),
    ).toBeNull()

    expect(
      getActiveBootstrapMemberBriefingContext({
        appState: createAppState([
          createBootstrapMirror({
            mailboxClaimedBySessionId: 'different-session',
          }),
        ]),
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }),
    ).toBeNull()
  })

  test('repairs only a missing teamName during active bootstrap', () => {
    const result = prepareBootstrapMemberBriefingCall({
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: { memberName: 'bob' },
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    })

    expect(result.args).toEqual({
      teamName: 'vector-room',
      memberName: 'bob',
    })
    expect(result.repairedFields).toEqual(['teamName'])
  })

  test('repairs only a missing memberName during active bootstrap', () => {
    const result = prepareBootstrapMemberBriefingCall({
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: { teamName: 'vector-room' },
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    })

    expect(result.args).toEqual({
      teamName: 'vector-room',
      memberName: 'bob',
    })
    expect(result.repairedFields).toEqual(['memberName'])
  })

  test('repairs both args when both are missing', () => {
    const result = prepareBootstrapMemberBriefingCall({
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: {},
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    })

    expect(result.args).toEqual({
      teamName: 'vector-room',
      memberName: 'bob',
    })
    expect(result.repairedFields).toEqual(['teamName', 'memberName'])
  })

  test('does not overwrite non-empty caller-provided args', () => {
    const result = prepareBootstrapMemberBriefingCall({
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: {
        teamName: 'custom-team',
        memberName: 'custom-bob',
      },
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    })

    expect(result.args).toEqual({
      teamName: 'custom-team',
      memberName: 'custom-bob',
    })
    expect(result.repairedFields).toEqual([])
  })

  test('does not repair non-member_briefing tools or non-agent-teams servers', () => {
    expect(
      prepareBootstrapMemberBriefingCall({
        serverName: 'different-server',
        toolName: 'member_briefing',
        args: {},
        appState: createAppState([createBootstrapMirror()]),
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }).repairedFields,
    ).toEqual([])

    expect(
      prepareBootstrapMemberBriefingCall({
        serverName: 'agent-teams',
        toolName: 'different_tool',
        args: {},
        appState: createAppState([createBootstrapMirror()]),
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }).repairedFields,
    ).toEqual([])
  })

  test('trips the bootstrap loop breaker on the fourth malformed call', () => {
    const params = {
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: {},
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    } as const

    prepareBootstrapMemberBriefingCall(params)
    prepareBootstrapMemberBriefingCall(params)
    prepareBootstrapMemberBriefingCall(params)

    expect(() => prepareBootstrapMemberBriefingCall(params)).toThrow(
      BootstrapMemberBriefingLoopAbortError,
    )
  })

  test('successful member_briefing can clear prior malformed loop state', () => {
    const first = prepareBootstrapMemberBriefingCall({
      serverName: 'agent-teams',
      toolName: 'member_briefing',
      args: {},
      appState: createAppState([createBootstrapMirror()]),
      currentSessionId: 'session-1',
      isTeammateSession: true,
      teamName: 'vector-room',
      memberName: 'bob',
    })
    expect(first.bootstrapContext).not.toBeNull()

    clearBootstrapMemberBriefingLoopState(first.bootstrapContext!)

    expect(
      prepareBootstrapMemberBriefingCall({
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        args: {},
        appState: createAppState([createBootstrapMirror()]),
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }).repairedFields,
    ).toEqual(['teamName', 'memberName'])
  })

  test('changed bootstrap mirror id does not reuse old malformed loop count', () => {
    const firstContextAppState = createAppState([
      createBootstrapMirror({ id: 'bootstrap-1' }),
    ])
    const secondContextAppState = createAppState([
      createBootstrapMirror({ id: 'bootstrap-2', messageId: 'bootstrap-msg-2' }),
    ])

    for (let attempt = 0; attempt < 3; attempt++) {
      prepareBootstrapMemberBriefingCall({
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        args: {},
        appState: firstContextAppState,
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      })
    }

    expect(
      prepareBootstrapMemberBriefingCall({
        serverName: 'agent-teams',
        toolName: 'member_briefing',
        args: {},
        appState: secondContextAppState,
        currentSessionId: 'session-1',
        isTeammateSession: true,
        teamName: 'vector-room',
        memberName: 'bob',
      }).repairedFields,
    ).toEqual(['teamName', 'memberName'])
  })

  test('marks the internal abort reason explicitly', () => {
    expect(
      isBootstrapMemberBriefingLoopAbortReason(
        BOOTSTRAP_MEMBER_BRIEFING_LOOP_ABORT_REASON,
      ),
    ).toBe(true)
    expect(isBootstrapMemberBriefingLoopAbortReason('interrupt')).toBe(false)
  })
})
