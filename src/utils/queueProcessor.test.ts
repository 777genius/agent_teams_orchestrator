import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearCommandQueue,
  enqueue,
  getCommandQueue,
} from './messageQueueManager.js'
import { processQueueIfReady } from './queueProcessor.js'

afterEach(() => {
  clearCommandQueue()
})

describe('queue processor bootstrap admission', () => {
  test('does not dequeue work while bootstrap admission is pending', () => {
    enqueue({
      mode: 'prompt',
      value: 'ordinary work that arrived before bootstrap',
    })
    let executed = false

    const result = processQueueIfReady({
      executeInput: async () => {
        executed = true
      },
      isBootstrapAdmissionPending: true,
    })

    expect(result).toEqual({ processed: false })
    expect(executed).toBe(false)
    expect(getCommandQueue()).toHaveLength(1)
  })

  test('drains the preserved work after bootstrap admission is released', () => {
    enqueue({
      mode: 'prompt',
      value: 'ordinary work that arrived before bootstrap',
    })
    let executedValues: string[] = []

    const blockedResult = processQueueIfReady({
      executeInput: async commands => {
        executedValues = commands.map(command => String(command.value))
      },
      isBootstrapAdmissionPending: true,
    })
    const releasedResult = processQueueIfReady({
      executeInput: async commands => {
        executedValues = commands.map(command => String(command.value))
      },
      isBootstrapAdmissionPending: false,
    })

    expect(blockedResult).toEqual({ processed: false })
    expect(releasedResult).toEqual({ processed: true })
    expect(executedValues).toEqual([
      'ordinary work that arrived before bootstrap',
    ])
    expect(getCommandQueue()).toHaveLength(0)
  })
})
