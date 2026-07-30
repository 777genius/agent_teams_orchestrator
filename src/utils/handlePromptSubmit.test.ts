import { afterEach, describe, expect, test } from 'bun:test'

import {
  handlePromptSubmit,
  isPromptSubmissionDeferred,
} from './handlePromptSubmit.js'
import {
  clearCommandQueue,
  getCommandQueue,
} from './messageQueueManager.js'
import { QueryGuard } from './QueryGuard.js'

afterEach(() => {
  clearCommandQueue()
})

describe('handlePromptSubmit bootstrap admission', () => {
  test('treats bootstrap admission as a deferred submission state', () => {
    expect(isPromptSubmissionDeferred(false, true)).toBe(true)
    expect(isPromptSubmissionDeferred(true, false)).toBe(true)
    expect(isPromptSubmissionDeferred(false, false)).toBe(false)
  })

  test('queues interactive teammate input until bootstrap is confirmed', async () => {
    const queryGuard = new QueryGuard()
    let inputValue = 'ordinary interactive work'
    let queryCalls = 0
    let bufferClears = 0
    let historyResets = 0

    await handlePromptSubmit({
      input: inputValue,
      mode: 'prompt',
      isBootstrapAdmissionPending: true,
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {
          bufferClears += 1
        },
        resetHistory: () => {
          historyResets += 1
        },
      },
      queryGuard,
      commands: [],
      onInputChange: value => {
        inputValue = value
      },
      setPastedContents: () => {},
      setToolJSX: () => {},
      getToolUseContext: () => {
        throw new Error('bootstrap-deferred input must not build query context')
      },
      messages: [],
      mainLoopModel: 'sonnet',
      ideSelection: undefined,
      setUserInputOnProcessing: () => {},
      setAbortController: () => {},
      onQuery: async () => {
        queryCalls += 1
      },
      setAppState: () => {},
      querySource: 'repl' as never,
    })

    expect(queryGuard.status).toBe('idle')
    expect(queryCalls).toBe(0)
    expect(inputValue).toBe('')
    expect(bufferClears).toBe(1)
    expect(historyResets).toBe(1)
    expect(getCommandQueue()).toMatchObject([
      {
        mode: 'prompt',
        value: 'ordinary interactive work',
      },
    ])
  })
})
