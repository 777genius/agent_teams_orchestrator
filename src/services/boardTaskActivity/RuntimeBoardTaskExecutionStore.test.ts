import { beforeEach, describe, expect, test } from 'bun:test'

import { getRuntimeBoardTaskExecutionStore } from './RuntimeBoardTaskExecutionStore.js'
import type { BoardTaskLocator } from './contract.js'

const TASK_A: BoardTaskLocator = {
  ref: 'abcd1234',
  refKind: 'display',
  canonicalId: '123e4567-e89b-12d3-a456-426614174000',
}

const TASK_B: BoardTaskLocator = {
  ref: 'efgh5678',
  refKind: 'display',
  canonicalId: '123e4567-e89b-12d3-a456-426614174001',
}

describe('RuntimeBoardTaskExecutionStore', () => {
  beforeEach(() => {
    getRuntimeBoardTaskExecutionStore().clearForTests()
  })

  test('tracks same-task and other-active-task relations', () => {
    const store = getRuntimeBoardTaskExecutionStore()
    store.applyTransitions('session-1', 'agent-a', [
      { type: 'open', phase: 'work', task: TASK_A },
    ])

    expect(store.getActorContextForTarget('session-1', 'agent-a', TASK_A)).toEqual({
      relation: 'same_task',
    })

    expect(store.getActorContextForTarget('session-1', 'agent-a', TASK_B)).toEqual({
      relation: 'other_active_task',
      activeTask: TASK_A,
      activePhase: 'work',
      activeExecutionSeq: 1,
    })
  })

  test('marks relation ambiguous when multiple scopes are open', () => {
    const store = getRuntimeBoardTaskExecutionStore()
    store.applyTransitions('session-1', 'agent-a', [
      { type: 'open', phase: 'work', task: TASK_A },
      { type: 'open', phase: 'review', task: TASK_B },
    ])

    expect(store.getActorContextForTarget('session-1', 'agent-a', TASK_A)).toEqual({
      relation: 'ambiguous',
    })
    expect(store.getSingleActiveScope('session-1', 'agent-a')).toBeNull()
  })

  test('increments activeExecutionSeq on reopen', () => {
    const store = getRuntimeBoardTaskExecutionStore()
    store.applyTransitions('session-1', 'agent-a', [
      { type: 'open', phase: 'work', task: TASK_A },
    ])
    store.applyTransitions('session-1', 'agent-a', [
      { type: 'close', phase: 'work', task: TASK_A },
    ])
    store.applyTransitions('session-1', 'agent-a', [
      { type: 'open', phase: 'work', task: TASK_A },
    ])

    expect(store.getSingleActiveScope('session-1', 'agent-a')).toEqual({
      locator: TASK_A,
      phase: 'work',
      activeExecutionSeq: 2,
    })
  })

  test('does not create actor state on read-only queries', () => {
    const store = getRuntimeBoardTaskExecutionStore()

    expect(store.getOpenScopeCount('session-empty', 'agent-empty')).toBe(0)
    expect(store.getSingleActiveScope('session-empty', 'agent-empty')).toBeNull()
    expect(
      store.getActorContextForTarget('session-empty', 'agent-empty', TASK_A),
    ).toEqual({
      relation: 'idle',
    })
    expect(store.hasProcessedToolUseId('session-empty', 'agent-empty', 'tool-1')).toBe(false)

    expect((store as { stateByActorKey: Map<string, unknown> }).stateByActorKey.size).toBe(0)
  })

  test('bounds processed tool use ids to avoid unbounded growth', () => {
    const store = getRuntimeBoardTaskExecutionStore()

    for (let index = 0; index < 2500; index += 1) {
      store.markProcessedToolUseId('session-1', 'agent-a', `tool-${index}`)
    }

    const state = (store as {
      stateByActorKey: Map<string, { processedToolUseIds: Set<string> }>
    }).stateByActorKey.get('session-1::agent-a')

    expect(state).toBeDefined()
    expect(state?.processedToolUseIds.size).toBeLessThanOrEqual(2048)
    expect(state?.processedToolUseIds.has('tool-0')).toBe(false)
    expect(state?.processedToolUseIds.has('tool-2499')).toBe(true)
  })
})
