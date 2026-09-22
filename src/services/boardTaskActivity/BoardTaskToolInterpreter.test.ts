import { describe, expect, test } from 'bun:test'

import { interpretBoardTaskToolCall } from './BoardTaskToolInterpreter.js'

describe('BoardTaskToolInterpreter', () => {
  test('interprets task_start with canonical locator enrichment from result', () => {
    const interpreted = interpretBoardTaskToolCall({
      toolName: 'mcp__agent-teams__task_start',
      input: { taskId: 'abcd1234' },
      result: {
        id: '123e4567-e89b-12d3-a456-426614174000',
        displayId: 'abcd1234',
      },
    })

    expect(interpreted).not.toBeNull()
    expect(interpreted?.canonicalToolName).toBe('task_start')
    expect(interpreted?.links).toEqual([
      {
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        taskArgumentSlot: 'taskId',
      },
    ])
    expect(interpreted?.transitions).toEqual([
      {
        type: 'open',
        phase: 'work',
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
      },
    ])
  })

  test('interprets dual-target relationship tools', () => {
    const interpreted = interpretBoardTaskToolCall({
      toolName: 'mcp__agent_teams__task_link',
      input: {
        taskId: 'abcd1234',
        targetId: 'efgh5678',
        relationship: 'related',
      },
      result: {
        task: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          displayId: 'abcd1234',
        },
      },
    })

    expect(interpreted?.canonicalToolName).toBe('task_link')
    expect(interpreted?.links).toEqual([
      {
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'board_action',
        taskArgumentSlot: 'taskId',
      },
      {
        task: {
          ref: 'efgh5678',
          refKind: 'display',
        },
        targetRole: 'related',
        linkKind: 'board_action',
        taskArgumentSlot: 'targetId',
      },
    ])
    expect(interpreted?.action?.input).toEqual({ relationship: 'related' })
  })

  test('captures action result refs for comment and attachment tools', () => {
    const commentAction = interpretBoardTaskToolCall({
      toolName: 'task_add_comment',
      input: { taskId: 'abcd1234' },
      result: {
        commentId: 'c123',
        task: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          displayId: 'abcd1234',
        },
      },
    })

    expect(commentAction?.action?.resultRefs).toEqual({ commentId: 'c123' })

    const attachmentAction = interpretBoardTaskToolCall({
      toolName: 'task_attach_file',
      input: { taskId: 'abcd1234' },
      result: {
        id: 'a123',
        filename: 'report.md',
        task: {
          id: '123e4567-e89b-12d3-a456-426614174000',
          displayId: 'abcd1234',
        },
      },
    })

    expect(attachmentAction?.action?.resultRefs).toEqual({
      attachmentId: 'a123',
      filename: 'report.md',
    })
  })

  test('normalizes owner and clarification payloads to semantic values only', () => {
    const clearedOwner = interpretBoardTaskToolCall({
      toolName: 'mcp__agent-teams__task_set_owner',
      input: { taskId: 'abcd1234', owner: 'clear' },
      result: { ok: true },
    })
    const clarification = interpretBoardTaskToolCall({
      toolName: 'mcp__agent-teams__task_set_clarification',
      input: { taskId: 'abcd1234', value: 'lead' },
      result: { ok: true },
    })
    const clearedClarification = interpretBoardTaskToolCall({
      toolName: 'mcp__agent-teams__task_set_clarification',
      input: { taskId: 'abcd1234', value: 'clear' },
      result: { ok: true },
    })

    expect(clearedOwner?.action?.input).toEqual({ owner: null })
    expect(clarification?.action?.input).toEqual({ clarification: 'lead' })
    expect(clearedClarification?.action?.input).toEqual({
      clarification: null,
    })
  })
})
