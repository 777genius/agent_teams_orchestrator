import { describe, expect, test } from 'bun:test'

import {
  runCodexNativePhase0SignOffHarness,
} from './signOffHarness.js'

describe('runCodexNativePhase0SignOffHarness', () => {
  test('captures normalized events, projected transcript truth, and summary metadata', async () => {
    const evidence = await runCodexNativePhase0SignOffHarness(
      {
        cwd: '/tmp/demo',
        prompt: 'Reply only with OK',
        ephemeral: false,
        apiKey: 'openai-test-key',
      },
      {
        runExec: async function* () {
          yield {
            type: 'binary_identity',
            identity: {
              executablePath: '/usr/local/bin/codex',
              executableSource: 'system-path',
              version: 'codex-cli 0.117.0',
            },
          }
          yield {
            type: 'normalized_event',
            event: {
              type: 'thread_started',
              threadId: 'thread-persistent',
            },
          }
          yield {
            type: 'normalized_event',
            event: {
              type: 'warning',
              source: 'stderr',
              text: 'thread/read failed while backfilling turn items for turn completion',
            },
          }
          yield {
            type: 'normalized_event',
            event: {
              type: 'assistant_text',
              itemId: 'item_0',
              text: 'OK',
            },
          }
          yield {
            type: 'normalized_event',
            event: {
              type: 'usage_updated',
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
            },
          }
          yield {
            type: 'normalized_event',
            event: {
              type: 'turn_completed',
            },
          }
          return {
            identity: {
              executablePath: '/usr/local/bin/codex',
              executableSource: 'system-path',
              version: 'codex-cli 0.117.0',
            },
            threadId: 'thread-persistent',
            credentialSource: 'explicit-api-key',
            completionPolicy: 'persistent',
            finalHistoryCompleteness: 'explicit-hydration-required',
            finalUsageAuthority: 'live-turn-completed',
          }
        },
      },
    )

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      capabilityProfile: 'headless-limited',
      apiKeyInputSource: 'explicit',
      summary: {
        threadId: 'thread-persistent',
        completionPolicy: 'persistent',
        finalHistoryCompleteness: 'explicit-hydration-required',
      },
      normalizedEventTypes: [
        'thread_started',
        'warning',
        'assistant_text',
        'usage_updated',
        'turn_completed',
      ],
      finalAssistantText: 'OK',
    })

    expect(evidence.projectedMessages).toMatchObject([
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'running',
        codexNativeThreadId: 'thread-persistent',
      },
      {
        type: 'system',
        subtype: 'codex_native_warning',
        codexNativeWarningSource: 'history',
      },
      {
        type: 'assistant',
        text: 'OK',
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
        },
      },
      {
        type: 'system',
        subtype: 'codex_native_execution_summary',
        codexNativeCompletionPolicy: 'persistent',
        codexNativeHistoryCompleteness: 'explicit-hydration-required',
      },
      {
        type: 'system',
        subtype: 'codex_native_thread_status',
        codexNativeThreadStatus: 'completed',
        codexNativeThreadId: 'thread-persistent',
      },
    ])
  })
})
