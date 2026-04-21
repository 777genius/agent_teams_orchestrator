import { describe, expect, test } from 'bun:test'

import {
  classifyCodexNativeWarningSource,
  createCodexNativeExecutionSummaryMessage,
  createCodexNativeThreadStatusMessage,
  createCodexNativeWarningMessage,
} from './statusAuthority.js'

describe('codexNative status authority helpers', () => {
  test('classifies history and process warnings conservatively', () => {
    expect(
      classifyCodexNativeWarningSource(
        'thread/read failed while backfilling turn items for turn completion',
      ),
    ).toBe('history')
    expect(classifyCodexNativeWarningSource('native stderr warning')).toBe(
      'process',
    )
  })

  test('builds structured warning, thread-status, and execution-summary messages', () => {
    expect(createCodexNativeWarningMessage('native stderr warning')).toMatchObject(
      {
        type: 'system',
        subtype: 'codex_native_warning',
        codexNativeWarningSource: 'process',
      },
    )

    expect(
      createCodexNativeThreadStatusMessage({
        status: 'running',
        threadId: 'thread-1',
      }),
    ).toMatchObject({
      type: 'system',
      subtype: 'codex_native_thread_status',
      codexNativeThreadStatus: 'running',
      codexNativeThreadId: 'thread-1',
    })

    expect(
      createCodexNativeExecutionSummaryMessage({
        identity: {
          executablePath: '/usr/local/bin/codex',
          executableSource: 'system-path',
          version: 'codex-cli 0.117.0',
        },
        threadId: 'thread-1',
        completionPolicy: 'persistent',
        finalHistoryCompleteness: 'explicit-hydration-required',
        finalUsageAuthority: 'live-turn-completed',
      }),
    ).toMatchObject({
      type: 'system',
      subtype: 'codex_native_execution_summary',
      codexNativeThreadId: 'thread-1',
      codexNativeCompletionPolicy: 'persistent',
      codexNativeHistoryCompleteness: 'explicit-hydration-required',
      codexNativeExecutableVersion: 'codex-cli 0.117.0',
    })
  })
})
