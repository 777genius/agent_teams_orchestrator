import { beforeEach, describe, expect, test } from 'bun:test'

import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import {
  clearDynamicTeamContext,
  setDynamicTeamContext,
} from '../../utils/teammate.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import {
  annotateAmbientBoardTaskExecutionMessage,
  annotateBoardTaskToolResultMessage,
} from './BoardTaskTranscriptProjector.js'
import { getRuntimeBoardTaskExecutionStore } from './RuntimeBoardTaskExecutionStore.js'

describe('BoardTaskTranscriptProjector', () => {
  beforeEach(() => {
    getRuntimeBoardTaskExecutionStore().clearForTests()
    clearDynamicTeamContext()
  })

  test('stamps lifecycle rows with pre-event actor context and opens execution scope after start', () => {
    const toolResultMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'ok',
        },
      ],
    })

    const annotatedToolResult = annotateBoardTaskToolResultMessage({
      message: toolResultMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: { taskId: 'abcd1234' },
      result: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        displayId: 'abcd1234',
      },
      toolUseId: 'tool-1',
      sessionId: 'session-1',
      agentId: 'agent-a',
    })

    expect(annotatedToolResult.boardTaskLinks).toHaveLength(1)
    expect(annotatedToolResult.boardTaskLinks?.[0]?.linkKind).toBe('lifecycle')
    expect(annotatedToolResult.boardTaskLinks?.[0]?.actorContext).toEqual({
      relation: 'idle',
    })
    expect(annotatedToolResult.boardTaskToolActions?.[0]?.canonicalToolName).toBe(
      'task_start',
    )

    const assistantMessage = createAssistantMessage({
      content: 'Working on the implementation details now.',
    })
    const annotatedAssistant = annotateAmbientBoardTaskExecutionMessage({
      message: assistantMessage,
      sessionId: 'session-1',
      agentId: 'agent-a',
    })

    expect(annotatedAssistant.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ])
  })

  test('marks board actions on another task as other_active_task', () => {
    const startMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: startMessage,
      toolName: 'task_start',
      input: { taskId: 'abcd1234' },
      result: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        displayId: 'abcd1234',
      },
      toolUseId: 'tool-1',
      sessionId: 'session-1',
      agentId: 'agent-a',
    })

    const commentMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-2',
          content: 'ok',
        },
      ],
    })

    const annotatedComment = annotateBoardTaskToolResultMessage({
      message: commentMessage,
      toolName: 'task_add_comment',
      input: { taskId: 'efgh5678' },
      result: {
        commentId: 'comment-1',
        task: {
          id: '123e4567-e89b-12d3-a456-426614174001',
          displayId: 'efgh5678',
        },
      },
      toolUseId: 'tool-2',
      sessionId: 'session-1',
      agentId: 'agent-a',
    })

    expect(annotatedComment.boardTaskLinks?.[0]?.actorContext).toEqual({
      relation: 'other_active_task',
      activeTask: {
        ref: 'abcd1234',
        refKind: 'display',
        canonicalId: '123e4567-e89b-12d3-a456-426614174000',
      },
      activePhase: 'work',
      activeExecutionSeq: 1,
    })
  })

  test('skips explicit task metadata for unsuccessful tool results', () => {
    const errorMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-err',
          content: 'Error: rejected',
          is_error: true,
        },
      ],
    })

    const annotated = annotateBoardTaskToolResultMessage({
      message: errorMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: { taskId: 'abcd1234' },
      result: 'User rejected tool use',
      toolUseId: 'tool-err',
      sessionId: 'session-1',
      agentId: 'agent-a',
    })

    expect(annotated.boardTaskLinks).toBeUndefined()
    expect(annotated.boardTaskToolActions).toBeUndefined()
    expect(
      getRuntimeBoardTaskExecutionStore().getSingleActiveScope(
        'session-1',
        'agent-a',
      ),
    ).toBeNull()
  })

  test('stamps teammate ambient execution without requiring toolUseContext agentId', () => {
    setDynamicTeamContext({
      agentId: 'tom@beacon-desk-2',
      agentName: 'tom',
      teamName: 'beacon-desk-2',
      planModeRequired: false,
    })

    const startMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-start',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: startMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: { taskId: 'abcd1234' },
      result: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        displayId: 'abcd1234',
      },
      toolUseId: 'tool-start',
      sessionId: 'session-1',
      agentId: undefined,
    })

    expect(
      getRuntimeBoardTaskExecutionStore().getSingleActiveScope(
        'session-1',
        'tom@beacon-desk-2',
      ),
    ).toEqual({
      locator: {
        ref: 'abcd1234',
        refKind: 'display',
        canonicalId: '123e4567-e89b-12d3-a456-426614174000',
      },
      phase: 'work',
      activeExecutionSeq: 1,
    })

    const grepResultMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-grep',
          content: '<persisted-output>',
        },
      ],
    })

    const annotatedGrepResult = annotateAmbientBoardTaskExecutionMessage({
      message: grepResultMessage,
      sessionId: 'session-1',
      agentId: undefined,
    })

    expect(annotatedGrepResult.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-grep',
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: { relation: 'same_task' },
      },
    ])
  })

  test('does not open lead-local execution scopes for delegated harbor-labs task_start actors', () => {
    setDynamicTeamContext({
      agentId: 'team-lead@harbor-labs',
      agentName: TEAM_LEAD_NAME,
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const jackStartMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-jack-start',
          content: 'ok',
        },
      ],
    })
    const tomStartMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-tom-start',
          content: 'ok',
        },
      ],
    })

    const annotatedJackStart = annotateBoardTaskToolResultMessage({
      message: jackStartMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: {
        taskId: '5541d414-f86b-4abf-a3cd-c33d5254a339',
        actor: 'jack',
      },
      result: {
        id: '5541d414-f86b-4abf-a3cd-c33d5254a339',
      },
      toolUseId: 'tool-jack-start',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })
    const annotatedTomStart = annotateBoardTaskToolResultMessage({
      message: tomStartMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: {
        taskId: 'fe36048f-e592-427a-a481-96af7c50232f',
        actor: 'tom',
      },
      result: {
        id: 'fe36048f-e592-427a-a481-96af7c50232f',
      },
      toolUseId: 'tool-tom-start',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })

    expect(annotatedJackStart.boardTaskLinks?.[0]?.linkKind).toBe('lifecycle')
    expect(annotatedTomStart.boardTaskLinks?.[0]?.linkKind).toBe('lifecycle')
    expect(
      getRuntimeBoardTaskExecutionStore().getOpenScopeCount(
        'session-harbor-labs',
        'team-lead@harbor-labs',
      ),
    ).toBe(0)
  })

  test('opens execution scope when task_start actor matches the current teammate', () => {
    setDynamicTeamContext({
      agentId: 'tom@harbor-labs',
      agentName: 'tom',
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const startMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-tom-self-start',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: startMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: {
        taskId: 'fe36048f-e592-427a-a481-96af7c50232f',
        actor: 'tom',
      },
      result: {
        id: 'fe36048f-e592-427a-a481-96af7c50232f',
      },
      toolUseId: 'tool-tom-self-start',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })

    expect(
      getRuntimeBoardTaskExecutionStore().getSingleActiveScope(
        'session-harbor-labs',
        'tom@harbor-labs',
      ),
    ).toEqual({
      locator: {
        ref: 'fe36048f-e592-427a-a481-96af7c50232f',
        refKind: 'canonical',
        canonicalId: 'fe36048f-e592-427a-a481-96af7c50232f',
      },
      phase: 'work',
      activeExecutionSeq: 1,
    })
  })

  test('uses from as the lifecycle actor when actor is absent', () => {
    setDynamicTeamContext({
      agentId: 'team-lead@harbor-labs',
      agentName: TEAM_LEAD_NAME,
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const leadReviewStartMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-review-start-lead',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: leadReviewStartMessage,
      toolName: 'mcp__agent-teams__review_start',
      input: {
        taskId: '078c75fd-bf56-47b3-a230-a294642d20b1',
        from: 'reviewer',
      },
      result: {
        id: '078c75fd-bf56-47b3-a230-a294642d20b1',
      },
      toolUseId: 'tool-review-start-lead',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })

    expect(
      getRuntimeBoardTaskExecutionStore().getOpenScopeCount(
        'session-harbor-labs',
        'team-lead@harbor-labs',
      ),
    ).toBe(0)

    setDynamicTeamContext({
      agentId: 'reviewer@harbor-labs',
      agentName: 'reviewer',
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const reviewerReviewStartMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-review-start-reviewer',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: reviewerReviewStartMessage,
      toolName: 'mcp__agent-teams__review_start',
      input: {
        taskId: '078c75fd-bf56-47b3-a230-a294642d20b1',
        from: 'reviewer',
      },
      result: {
        id: '078c75fd-bf56-47b3-a230-a294642d20b1',
      },
      toolUseId: 'tool-review-start-reviewer',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })

    expect(
      getRuntimeBoardTaskExecutionStore().getSingleActiveScope(
        'session-harbor-labs',
        'reviewer@harbor-labs',
      ),
    ).toEqual({
      locator: {
        ref: '078c75fd-bf56-47b3-a230-a294642d20b1',
        refKind: 'canonical',
        canonicalId: '078c75fd-bf56-47b3-a230-a294642d20b1',
      },
      phase: 'review',
      activeExecutionSeq: 1,
    })
  })

  test('uses memberName as the lifecycle actor when actor and from are absent', () => {
    setDynamicTeamContext({
      agentId: 'tom@harbor-labs',
      agentName: 'tom',
      teamName: 'harbor-labs',
      planModeRequired: false,
    })

    const startMessage = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-member-name-start',
          content: 'ok',
        },
      ],
    })

    annotateBoardTaskToolResultMessage({
      message: startMessage,
      toolName: 'mcp__agent-teams__task_start',
      input: {
        taskId: '80e41895-d621-4b65-b57a-1e4532595f66',
        memberName: 'tom',
      },
      result: {
        id: '80e41895-d621-4b65-b57a-1e4532595f66',
      },
      toolUseId: 'tool-member-name-start',
      sessionId: 'session-harbor-labs',
      agentId: undefined,
    })

    expect(
      getRuntimeBoardTaskExecutionStore().getSingleActiveScope(
        'session-harbor-labs',
        'tom@harbor-labs',
      ),
    ).toEqual({
      locator: {
        ref: '80e41895-d621-4b65-b57a-1e4532595f66',
        refKind: 'canonical',
        canonicalId: '80e41895-d621-4b65-b57a-1e4532595f66',
      },
      phase: 'work',
      activeExecutionSeq: 1,
    })
  })

  test('does not stamp ambient execution for lead sessions without a teammate actor id', () => {
    setDynamicTeamContext({
      agentId: 'team-lead@beacon-desk-2',
      agentName: TEAM_LEAD_NAME,
      teamName: 'beacon-desk-2',
      planModeRequired: false,
    })

    const assistantMessage = createAssistantMessage({
      content: 'Reviewing the board state now.',
    })

    const annotatedAssistant = annotateAmbientBoardTaskExecutionMessage({
      message: assistantMessage,
      sessionId: 'session-1',
      agentId: undefined,
    })

    expect(annotatedAssistant.boardTaskLinks).toBeUndefined()
  })
})
