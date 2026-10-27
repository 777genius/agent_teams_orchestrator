import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getFlagSettingsInline,
  getSessionId,
  setFlagSettingsInline,
} from '../../bootstrap/state.js'
import { call as branchConversation } from '../../commands/branch/branch.js'
import { processResumedConversation } from '../../utils/sessionRestore.js'
import {
  assertCodexNativeHistoryOperationSupported,
  getCodexNativeHistoryOperationError,
  usesCodexNativeConversation,
} from './conversationHistoryGuard.js'

const ENV_KEYS = [
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD',
  'CODEX_CLI_PATH',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
] as const
let originalEnv: Record<string, string | undefined>
let originalSettings: ReturnType<typeof getFlagSettingsInline>

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  originalSettings = getFlagSettingsInline()
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'api'
  // The guard only resolves the route; it must never execute this path.
  process.env.CODEX_CLI_PATH = '/TEST/not-launched-codex'
  process.env.CODEX_API_KEY = 'TEST-no-network'
  setFlagSettingsInline({ codex: { forced_login_method: 'api' } })
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  setFlagSettingsInline(originalSettings)
})

describe('native conversation history guards', () => {
  test('uses the selected native route and rejects unsupported history operations', () => {
    expect(usesCodexNativeConversation()).toBe(true)
    for (const operation of ['rewind', 'partial-resume', 'fork'] as const) {
      expect(getCodexNativeHistoryOperationError(operation)).toContain('Resume the full session')
      expect(() => assertCodexNativeHistoryOperationSupported(operation)).toThrow('Native Codex')
    }
  })

  test('still refuses history edits when native credentials and binary are unavailable', () => {
    delete process.env.CODEX_API_KEY
    delete process.env.OPENAI_API_KEY
    process.env.CODEX_CLI_PATH = '/TEST/missing-native-binary'
    expect(usesCodexNativeConversation()).toBe(true)
    for (const operation of ['rewind', 'partial-resume', 'fork'] as const) {
      expect(() => assertCodexNativeHistoryOperationSupported(operation)).toThrow('Native Codex')
    }
  })

  test('does not block another host-selected provider when Codex is installed', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    expect(usesCodexNativeConversation()).toBe(false)
    expect(getCodexNativeHistoryOperationError('rewind')).toBeUndefined()
    expect(() => assertCodexNativeHistoryOperationSupported('fork')).not.toThrow()
  })

  test('refuses interactive fork resume before inspecting or mutating loaded state', async () => {
    const sessionId = getSessionId()
    const uninspected = new Proxy({}, {
      get() { throw new Error('resume state accessed before native fork refusal') },
    })
    await expect(processResumedConversation(uninspected as never, { forkSession: true }, uninspected as never))
      .rejects.toThrow('Native Codex does not support forking')
    expect(getSessionId()).toBe(sessionId)
  })

  test('branch command reports refusal without entering the fork or resume path', async () => {
    const sessionId = getSessionId()
    const replies: string[] = []
    let resumed = false
    await branchConversation(
      message => { replies.push(message) },
      { resume: async () => { resumed = true } } as never,
      'TEST unsupported native branch',
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('Native Codex does not support forking')
    expect(resumed).toBe(false)
    expect(getSessionId()).toBe(sessionId)
  })
})
