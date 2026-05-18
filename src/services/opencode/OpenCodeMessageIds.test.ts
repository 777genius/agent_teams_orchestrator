import { beforeEach, describe, expect, test } from 'bun:test'

import {
  buildOpenCodeRuntimePromptMessageId,
  getGreatestCanonicalOpenCodeMessageId,
  getGreatestOpenCodePromptOrderingMessageId,
  getOpenCodeAscendingMessageIdTimestampSlot,
  isCanonicalOpenCodeAscendingMessageId,
  reserveOpenCodeRuntimePromptMessageId,
  resetOpenCodeRuntimePromptMessageIdAllocatorForTest,
} from './OpenCodeMessageIds.js'

const BASE62_SUFFIX = '0123456789ABCD'

describe('OpenCodeMessageIds', () => {
  beforeEach(() => {
    resetOpenCodeRuntimePromptMessageIdAllocatorForTest()
  })

  test('builds canonical OpenCode-compatible runtime prompt ids', () => {
    const id = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 1_779_126_000_000,
      randomSuffix: BASE62_SUFFIX,
    })

    expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(isCanonicalOpenCodeAscendingMessageId(id)).toBe(true)
  })

  test('sorts generated prompt ids after older canonical OpenCode message ids', () => {
    const previousAssistant = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 1_000,
      counter: 1,
      randomSuffix: 'AAAAAAAAAAAAAA',
    })
    const prompt = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 1_001,
      randomSuffix: '00000000000000',
    })

    expect(prompt > previousAssistant).toBe(true)
  })

  test('keeps same-millisecond OpenCode assistant ids after reserved prompt ids', () => {
    const prompt = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 2_000,
      counter: 0,
      randomSuffix: 'zzzzzzzzzzzzzz',
    })
    const assistant = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 2_000,
      counter: 1,
      randomSuffix: '00000000000000',
    })

    expect(assistant > prompt).toBe(true)
  })

  test('ignores legacy random UUID-like ids when choosing canonical lower bounds', () => {
    const canonical = buildOpenCodeRuntimePromptMessageId({
      timestampMs: 3_000,
      randomSuffix: 'BBBBBBBBBBBBBB',
    })
    const latest = getGreatestCanonicalOpenCodeMessageId([
      'msg_0d008f4f44e4481a8e3b0bbe848d519c',
      canonical,
      'msg_prompt_legacy',
    ])

    expect(latest).toBe(canonical)
  })

  test('keeps high legacy msg ids as prompt-ordering lower bounds', () => {
    const canonical = 'msg_e00000000000BBBBBBBBBBBBBB'
    const highLegacy = 'msg_fabc1234fabc1234fabc1234fabc1234'
    const latest = getGreatestOpenCodePromptOrderingMessageId([
      canonical,
      highLegacy,
      'msgagtboot_legacy',
      null,
    ])

    expect(latest).toBe(highLegacy)
  })

  test('keeps low legacy msg ids below canonical prompt-ordering lower bounds', () => {
    const canonical = 'msg_e00000000000BBBBBBBBBBBBBB'
    const latest = getGreatestOpenCodePromptOrderingMessageId([
      'msg_0d008f4f44e4481a8e3b0bbe848d519c',
      canonical,
    ])

    expect(latest).toBe(canonical)
  })

  test('reserves locally monotonic prompt ids and reports needed wall-clock wait', () => {
    const first = reserveOpenCodeRuntimePromptMessageId({
      nowMs: 4_000,
      randomSuffix: 'CCCCCCCCCCCCCC',
    })
    const second = reserveOpenCodeRuntimePromptMessageId({
      nowMs: 4_000,
      randomSuffix: 'DDDDDDDDDDDDDD',
    })

    expect(second.runtimePromptMessageId > first.runtimePromptMessageId).toBe(true)
    expect(second.waitMs).toBe(1)
    expect(getOpenCodeAscendingMessageIdTimestampSlot(second.runtimePromptMessageId)).toBe(
      (getOpenCodeAscendingMessageIdTimestampSlot(first.runtimePromptMessageId) ?? 0) + 1,
    )
  })

  test('does not wait indefinitely when local wall clock moves backward', () => {
    reserveOpenCodeRuntimePromptMessageId({
      nowMs: 10_000,
      randomSuffix: 'EEEEEEEEEEEEEE',
    })
    const afterClockRollback = reserveOpenCodeRuntimePromptMessageId({
      nowMs: 9_000,
      randomSuffix: 'FFFFFFFFFFFFFF',
    })

    expect(afterClockRollback.waitMs).toBe(0)
    expect(getOpenCodeAscendingMessageIdTimestampSlot(afterClockRollback.runtimePromptMessageId)).toBe(
      getOpenCodeAscendingMessageIdTimestampSlot(
        buildOpenCodeRuntimePromptMessageId({
          timestampMs: 9_000,
          randomSuffix: 'FFFFFFFFFFFFFF',
        }),
      ),
    )
  })
})
