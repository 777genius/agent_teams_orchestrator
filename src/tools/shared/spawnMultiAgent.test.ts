import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { getSeparateProcessRequirement } from './spawnMultiAgent.js'
import { isBootstrapConfirmationMailboxMessage } from './spawnMultiAgent.js'
import { resolveTeammateModel } from './spawnMultiAgent.js'
import { spawnTeammate } from './spawnMultiAgent.js'

afterEach(() => {
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
})

describe('spawnMultiAgent bootstrap confirmation', () => {
  it('counts heartbeat, peer-summary heartbeat, interrupted, and task-terminal idle as bootstrap confirmation', () => {
    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
        },
        'alice',
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:01.000Z',
            idleReason: 'available',
            summary: '[to bob] aligned on rollout order',
          }),
        },
        'alice',
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:02.000Z',
            idleReason: 'interrupted',
          }),
        },
        'alice',
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:03.000Z',
            completedTaskId: 'task-1',
            completedStatus: 'resolved',
          }),
        },
        'alice',
      ),
    ).toBe(true)
  })

  it('does not count failure idle or mismatched teammate ids as bootstrap confirmation', () => {
    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:01:00.000Z',
            idleReason: 'failed',
            completedStatus: 'failed',
            failureReason: 'teammate crashed',
          }),
        },
        'alice',
      ),
    ).toBe(false)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'bob',
            timestamp: '2026-04-08T12:01:01.000Z',
            idleReason: 'available',
          }),
        },
        'alice',
      ),
    ).toBe(false)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: 'not structured idle',
        },
        'alice',
      ),
    ).toBe(false)
  })

  it('respects bootstrapExpectedAfter boundary when provided', () => {
    const boundary = '2026-04-08T12:00:02.000Z'

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: '2026-04-08T12:00:01.999Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(false)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: '2026-04-08T12:00:02.000Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:03.000Z',
            idleReason: 'available',
            summary: '[to bob] aligned on rollout order',
          }),
          timestamp: '2026-04-08T12:00:03.000Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:04.000Z',
            idleReason: 'interrupted',
          }),
          timestamp: '2026-04-08T12:00:04.000Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:05.000Z',
            completedTaskId: 'task-1',
            completedStatus: 'resolved',
          }),
          timestamp: '2026-04-08T12:00:05.000Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(true)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:06.000Z',
            idleReason: 'failed',
            completedStatus: 'failed',
            failureReason: 'teammate crashed',
          }),
          timestamp: '2026-04-08T12:00:06.000Z',
        },
        'alice',
        boundary,
      ),
    ).toBe(false)
  })

  it('keeps legacy coarse behavior when no boundary is present', () => {
    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: '2026-04-08T11:59:00.000Z',
        },
        'alice',
        null,
      ),
    ).toBe(true)
  })

  it('fails closed for malformed boundary or mailbox timestamp when boundary is active', () => {
    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: '2026-04-08T12:00:02.000Z',
        },
        'alice',
        'not-a-timestamp',
      ),
    ).toBe(false)

    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: 'invalid-mailbox-timestamp',
        },
        'alice',
        '2026-04-08T12:00:02.000Z',
      ),
    ).toBe(false)
  })
})

describe('resolveTeammateModel', () => {
  it('defaults unset teammate models to the Opus alias path', () => {
    expect(resolveTeammateModel(undefined, null)).toBe('opus')
  })

  it('lets the default Opus alias honor env-based overrides at resolution time', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'custom-opus-model'

    expect(parseUserSpecifiedModel(resolveTeammateModel(undefined, null))).toBe(
      'custom-opus-model',
    )
  })

  it('still inherits the leader model when inherit is requested explicitly', () => {
    expect(resolveTeammateModel('inherit', 'leader-model')).toBe('leader-model')
  })
})

describe('getSeparateProcessRequirement', () => {
  it('forces separate-process execution for codex-native teammates even without provider mismatch', async () => {
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER
    const originalCodexApiKey = process.env.CODEX_API_KEY
    const originalPath = process.env.PATH
    const tempBinDir = await mkdtemp(join(tmpdir(), 'spawn-codex-native-bin-'))

    try {
      const fakeCodexPath = join(tempBinDir, 'codex')
      await writeFile(fakeCodexPath, '#!/bin/sh\nexit 0\n')
      await chmod(fakeCodexPath, 0o755)

      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
      process.env.CODEX_API_KEY = 'sk-codex-native-test'
      process.env.PATH = `${tempBinDir}:${originalPath ?? ''}`

      expect(getSeparateProcessRequirement(undefined)).toEqual({
        required: true,
        reason: 'codex-native-runtime',
        provider: 'codex',
      })
    } finally {
      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
      if (originalCodexApiKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodexApiKey
      }
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
      await rm(tempBinDir, { recursive: true, force: true })
    }
  })

  it('keeps provider-mismatch precedence over codex-native runtime forcing', () => {
    const originalEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER

    try {
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic'

      expect(getSeparateProcessRequirement('codex')).toEqual({
        required: true,
        reason: 'provider-mismatch',
        provider: 'codex',
      })
    } finally {
      if (originalEntryProvider === undefined) {
        delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
      } else {
        process.env.CLAUDE_CODE_ENTRY_PROVIDER = originalEntryProvider
      }
    }
  })
})

describe('spawnTeammate worktree isolation validation', () => {
  it('rejects cwd with worktree isolation before spawn side effects', async () => {
    await expect(
      spawnTeammate(
        {
          name: 'alice',
          prompt: 'work',
          cwd: '/tmp/alice',
          isolation: 'worktree',
        },
        {
          getAppState: () => ({}),
        } as never,
      ),
    ).rejects.toThrow('cwd is mutually exclusive with isolation: "worktree"')
  })
})
