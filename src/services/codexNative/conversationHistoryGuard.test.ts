import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  getFlagSettingsInline,
  getSessionId,
  getSessionProjectDir,
  setFlagSettingsInline,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { call as branchConversation } from '../../commands/branch/branch.js'
import { processResumedConversation } from '../../utils/sessionRestore.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import {
  assertCodexNativeHistoryOperationSupported,
  assertCodexNativeHistoryOperationSupportedForTranscript,
  getCodexNativeHistoryOperationError,
  getCodexNativeHistoryOperationErrorForTranscript,
  usesCodexNativeConversation,
} from './conversationHistoryGuard.js'

const ENV_KEYS = [
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD',
  'CODEX_CLI_PATH',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_CONFIG_DIR',
] as const
let originalEnv: Record<string, string | undefined>
let originalSettings: ReturnType<typeof getFlagSettingsInline>
let originalSessionId: ReturnType<typeof getSessionId>
let originalSessionProjectDir: ReturnType<typeof getSessionProjectDir>
let fixtureRoot: string | undefined

async function transcriptFixture(content: string): Promise<string> {
  fixtureRoot ??= await mkdtemp(path.join(tmpdir(), 'TEST-native-history-guard-'))
  const transcriptPath = path.join(fixtureRoot, 'source-session.jsonl')
  await writeFile(transcriptPath, content)
  return transcriptPath
}

function ownerRow(): string {
  return JSON.stringify({ type: 'codex-conversation-owner', schemaVersion: 1,
    sessionId: getSessionId(), ownerKey: 'a'.repeat(64) }) + '\n'
}

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  originalSettings = getFlagSettingsInline()
  originalSessionId = getSessionId()
  originalSessionProjectDir = getSessionProjectDir()
  process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
  process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  process.env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'api'
  // The guard only resolves the route; it must never execute this path.
  process.env.CODEX_CLI_PATH = '/TEST/not-launched-codex'
  process.env.CODEX_API_KEY = 'TEST-no-network'
  setFlagSettingsInline({ codex: { forced_login_method: 'api' } })
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  setFlagSettingsInline(originalSettings)
  switchSession(asSessionId(originalSessionId), originalSessionProjectDir)
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
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

  test('a saved native owner still blocks history edits after switching provider', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    const transcriptPath = await transcriptFixture(ownerRow())
    expect(usesCodexNativeConversation()).toBe(false)
    for (const operation of ['rewind', 'partial-resume', 'fork'] as const) {
      expect(await getCodexNativeHistoryOperationErrorForTranscript(operation, transcriptPath))
        .toContain('Native Codex')
      await expect(assertCodexNativeHistoryOperationSupportedForTranscript(operation, transcriptPath))
        .rejects.toThrow('Native Codex')
    }
  })

  test('unbound non-Codex history and quoted owner metadata remain editable', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    const transcriptPath = await transcriptFixture(JSON.stringify({ type: 'user', message: { content: ownerRow() } }) + '\n')
    expect(await getCodexNativeHistoryOperationErrorForTranscript('rewind', transcriptPath)).toBeUndefined()
    expect(await getCodexNativeHistoryOperationErrorForTranscript('fork', path.join(fixtureRoot!, 'new-session.jsonl'))).toBeUndefined()
  })

  test('malformed native owner metadata and transcript IO errors fail closed', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    const transcriptPath = await transcriptFixture('{"type":"codex-conversation-owner", broken\n')
    expect(await getCodexNativeHistoryOperationErrorForTranscript('rewind', transcriptPath)).toContain('Cannot verify')
    expect(await getCodexNativeHistoryOperationErrorForTranscript('rewind', fixtureRoot!)).toContain('Cannot verify')
  })

  test('fork resume checks the source transcript before state access under another provider', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    const transcriptPath = await transcriptFixture(ownerRow())
    const sessionId = getSessionId()
    const uninspected = new Proxy({}, {
      get() { throw new Error('resume state accessed before bound-owner refusal') },
    })
    await expect(processResumedConversation(uninspected as never, { forkSession: true, transcriptPath }, uninspected as never))
      .rejects.toThrow('Native Codex does not support forking')
    expect(getSessionId()).toBe(sessionId)
  })

  test('branch checks the current transcript owner before copying a switched-provider session', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'
    await transcriptFixture('')
    // Explicit projectDir avoids the production getProjectDir memoization
    // retaining another test's configured profile directory.
    switchSession(asSessionId(randomUUID()), path.join(fixtureRoot!, 'current-project'))
    const transcriptPath = getTranscriptPath()
    await mkdir(path.dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, ownerRow())
    const replies: string[] = []
    let resumed = false
    await branchConversation(message => { replies.push(message) },
      { resume: async () => { resumed = true } } as never, 'TEST bound native branch')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('Native Codex does not support forking')
    expect(resumed).toBe(false)
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
