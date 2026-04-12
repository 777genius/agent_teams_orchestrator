import { describe, expect, test } from 'bun:test'

import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessages,
} from '../../utils/messages.js'
import type { TaskAwareAssistantMessage, TaskAwareUserMessage } from './contract.js'

describe('BoardTask carrier propagation in normalizeMessages', () => {
  test('keeps ambient execution links only on conversational assistant children', () => {
    const message = createAssistantMessage({
      content: [
        {
          type: 'text',
          text: 'Working through the refactor now.',
        },
        {
          type: 'thinking',
          thinking: 'Need to inspect the task transitions first.',
          signature: 'sig-1',
        },
      ],
      boardTaskLinks: [
        {
          schemaVersion: 1,
          task: {
            ref: 'abcd1234',
            refKind: 'display',
            canonicalId: '123e4567-e89b-12d3-a456-426614174000',
          },
          targetRole: 'subject',
          linkKind: 'execution',
          actorContext: {
            relation: 'same_task',
          },
        },
      ],
    }) as TaskAwareAssistantMessage

    const normalized = normalizeMessages([message]) as TaskAwareAssistantMessage[]

    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.message.content[0]?.type).toBe('text')
    expect(normalized[0]?.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        task: {
          ref: 'abcd1234',
          refKind: 'display',
          canonicalId: '123e4567-e89b-12d3-a456-426614174000',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
        },
      },
    ])
    expect(normalized[1]?.message.content[0]?.type).toBe('thinking')
    expect(normalized[1]?.boardTaskLinks).toBeUndefined()
  })

  test('assigns ambient assistant execution links only once across multiple text children', () => {
    const message = createAssistantMessage({
      content: [
        {
          type: 'text',
          text: 'First update.',
        },
        {
          type: 'text',
          text: 'Second update.',
        },
      ],
      boardTaskLinks: [
        {
          schemaVersion: 1,
          task: {
            ref: 'abcd1234',
            refKind: 'display',
          },
          targetRole: 'subject',
          linkKind: 'execution',
          actorContext: {
            relation: 'same_task',
          },
        },
      ],
    }) as TaskAwareAssistantMessage

    const normalized = normalizeMessages([message]) as TaskAwareAssistantMessage[]

    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.boardTaskLinks).toHaveLength(1)
    expect(normalized[1]?.boardTaskLinks).toBeUndefined()
  })

  test('filters user carriers by block identity during normalization', () => {
    const message = createUserMessage({
      content: [
        {
          type: 'text',
          text: 'Done.',
        },
        {
          type: 'text',
          text: 'Still working.',
        },
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: 'ok',
        },
      ],
      boardTaskLinks: [
        {
          schemaVersion: 1,
          task: {
            ref: 'abcd1234',
            refKind: 'display',
          },
          targetRole: 'subject',
          linkKind: 'execution',
          actorContext: {
            relation: 'same_task',
          },
        },
        {
          schemaVersion: 1,
          toolUseId: 'tool-1',
          task: {
            ref: 'abcd1234',
            refKind: 'display',
          },
          targetRole: 'subject',
          linkKind: 'lifecycle',
          taskArgumentSlot: 'taskId',
          actorContext: {
            relation: 'idle',
          },
        },
      ],
      boardTaskToolActions: [
        {
          schemaVersion: 1,
          toolUseId: 'tool-1',
          canonicalToolName: 'task_start',
        },
      ],
    }) as TaskAwareUserMessage

    const normalized = normalizeMessages([message]) as TaskAwareUserMessage[]

    expect(normalized).toHaveLength(3)
    expect(normalized[0]?.message.content[0]?.type).toBe('text')
    expect(normalized[0]?.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        task: {
          ref: 'abcd1234',
          refKind: 'display',
        },
        targetRole: 'subject',
        linkKind: 'execution',
        actorContext: {
          relation: 'same_task',
        },
      },
    ])
    expect(normalized[0]?.boardTaskToolActions).toBeUndefined()
    expect(normalized[1]?.message.content[0]?.type).toBe('text')
    expect(normalized[1]?.boardTaskLinks).toBeUndefined()
    expect(normalized[1]?.boardTaskToolActions).toBeUndefined()

    expect(normalized[2]?.message.content[0]?.type).toBe('tool_result')
    expect(normalized[2]?.boardTaskLinks).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        task: {
          ref: 'abcd1234',
          refKind: 'display',
        },
        targetRole: 'subject',
        linkKind: 'lifecycle',
        taskArgumentSlot: 'taskId',
        actorContext: {
          relation: 'idle',
        },
      },
    ])
    expect(normalized[2]?.boardTaskToolActions).toEqual([
      {
        schemaVersion: 1,
        toolUseId: 'tool-1',
        canonicalToolName: 'task_start',
      },
    ])
  })
})
