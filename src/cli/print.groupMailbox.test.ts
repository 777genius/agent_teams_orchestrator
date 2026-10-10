import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  getCurrentGroupRunIdentity,
  setActiveHeadlessGroupMailboxTurn,
  setHeadlessGroupMailboxProcessor,
  shouldDeferGroupMailboxCommand,
} from '../utils/groupMailbox.js'
import { enqueue, getCommandsByMaxPriority, getCommandQueue, remove } from '../utils/messageQueueManager.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { canBatchWith } from './print.js'

describe('headless group mailbox prompt isolation', () => {
  const dm: QueuedCommand = { mode: 'prompt', value: 'private message', isMeta: true, protocolKind: 'teammate-message' }
  const group: QueuedCommand = { mode: 'prompt', value: 'group envelope', isMeta: true, protocolKind: 'group_chat_message' }

  test('keeps each physical group envelope separate from private prompts in both queue orders', () => {
    expect(canBatchWith(group, dm)).toBe(false)
    expect(canBatchWith(dm, group)).toBe(false)
  })

  test('never merges two physical group envelopes, including replies in the same group', () => {
    expect(canBatchWith(group, { ...group, value: 'second physical envelope' })).toBe(false)
    expect(canBatchWith(group, { ...group, value: 'another group' })).toBe(false)
  })

  test('preserves ordinary batching and its workload and metadata boundaries', () => {
    expect(canBatchWith(dm, { ...dm, value: 'second private message' })).toBe(true)
    expect(canBatchWith(dm, { ...dm, workload: 'different' })).toBe(false)
    expect(canBatchWith(dm, { ...dm, isMeta: false })).toBe(false)
    expect(canBatchWith(dm, undefined)).toBe(false)
  })
})

describe('group turn mid-query consumption boundary', () => {
  test('leaves group and competing private prompts queued while allowing background completion notifications', () => {
    const group: QueuedCommand = { mode: 'prompt', value: 'group envelope', uuid: randomUUID(), protocolKind: 'group_chat_message' }
    const dm: QueuedCommand = { mode: 'prompt', value: 'private input', uuid: randomUUID() }
    const completion: QueuedCommand = { mode: 'task-notification', value: 'background completion', uuid: randomUUID() }
    const ownIds = new Set([group.uuid, dm.uuid, completion.uuid])
    try {
      enqueue(group); enqueue(dm); enqueue(completion)
      // This is the query boundary: deferral occurs before attachment
      // generation and before removing every consumed snapshot command.
      const snapshot = getCommandsByMaxPriority('next').filter(command =>
        ownIds.has(command.uuid) && !shouldDeferGroupMailboxCommand(command, true),
      )
      expect(snapshot.map(command => command.uuid)).toEqual([completion.uuid])
      remove(snapshot)
      expect(getCommandQueue().filter(command => ownIds.has(command.uuid)).map(command => command.uuid)).toEqual([group.uuid, dm.uuid])
      const afterGroup = getCommandsByMaxPriority('next').filter(command =>
        ownIds.has(command.uuid) && !shouldDeferGroupMailboxCommand(command, false),
      )
      expect(afterGroup.map(command => command.uuid)).toEqual([dm.uuid])
    } finally {
      remove(getCommandQueue().filter(command => ownIds.has(command.uuid)))
    }
  })

  test('applies the same private-command fence to the exact current headless owner and releases it after the turn', () => {
    const identity = getCurrentGroupRunIdentity()
    const owner = { teamName: 'synthetic-headless', memberName: 'team-lead', runKey: identity.groupRunKey }
    const dm: QueuedCommand = { mode: 'prompt', value: 'private input' }
    try {
      setHeadlessGroupMailboxProcessor(owner)
      setActiveHeadlessGroupMailboxTurn(owner)
      expect(shouldDeferGroupMailboxCommand(dm)).toBe(true)
      expect(shouldDeferGroupMailboxCommand({ mode: 'task-notification' })).toBe(false)
      setActiveHeadlessGroupMailboxTurn(undefined)
      expect(shouldDeferGroupMailboxCommand(dm)).toBe(false)
    } finally {
      setActiveHeadlessGroupMailboxTurn(undefined)
      setHeadlessGroupMailboxProcessor(undefined)
    }
  })
})
