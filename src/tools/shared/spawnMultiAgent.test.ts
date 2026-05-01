import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { getProjectDir } from '../../utils/sessionStoragePortable.js'
import { getSeparateProcessRequirement } from './spawnMultiAgent.js'
import { hasBootstrapConfirmation } from './spawnMultiAgent.js'
import { isProcessBackendCommandForTeammate } from './spawnMultiAgent.js'
import { isBootstrapConfirmationMailboxMessage } from './spawnMultiAgent.js'
import { parseProcessBackendPid } from './spawnMultiAgent.js'
import { resolveTeammateModel } from './spawnMultiAgent.js'
import { shouldUseNativeProcessBackendForSpawn } from './spawnMultiAgent.js'
import { shouldDetachNativeProcessBackend } from './spawnMultiAgent.js'
import { spawnTeammate } from './spawnMultiAgent.js'

afterEach(() => {
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
})

describe('spawnMultiAgent bootstrap confirmation', () => {
  it('keeps native process teammates attached to the parent console on Windows', () => {
    expect(shouldDetachNativeProcessBackend('win32')).toBe(false)
    expect(shouldDetachNativeProcessBackend('linux')).toBe(true)
    expect(shouldDetachNativeProcessBackend('darwin')).toBe(true)
  })

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

  it('accepts teammate display names when runtime ids include the team suffix', () => {
    expect(
      isBootstrapConfirmationMailboxMessage(
        {
          text: JSON.stringify({
            type: 'idle_notification',
            from: 'alice',
            timestamp: '2026-04-08T12:00:00.000Z',
            idleReason: 'available',
          }),
          timestamp: '2026-04-08T12:00:00.000Z',
        },
        'alice@live-team',
        '2026-04-08T11:59:59.000Z',
        'alice',
      ),
    ).toBe(true)
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

  it('accepts member_briefing transcript success when teammate sends no idle heartbeat', async () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const tempConfigDir = await mkdtemp(join(tmpdir(), 'spawn-bootstrap-transcript-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir
      const teamName = 'beacon-desk-test'
      const memberName = 'atlas'
      const boundary = new Date(Date.now() - 5_000).toISOString()
      const successAt = new Date(Date.now() - 1_000).toISOString()
      const projectDir = getProjectDir(process.cwd())
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'atlas-session.jsonl'),
        [
          JSON.stringify({
            timestamp: new Date(Date.now() - 6_000).toISOString(),
            teamName,
            agentName: memberName,
            type: 'user',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "${memberName}".`,
            },
          }),
          JSON.stringify({
            timestamp: successAt,
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'item_0',
                  content: `Member briefing for ${memberName} on team "${teamName}" (${teamName}).\nTask briefing for ${memberName}:\nNo actionable tasks.`,
                  is_error: false,
                },
              ],
            },
          }),
        ].join('\n') + '\n',
      )

      await expect(
        hasBootstrapConfirmation(
          teamName,
          `${memberName}@${teamName}`,
          boundary,
          memberName,
        ),
      ).resolves.toBe(true)
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
      }
      await rm(tempConfigDir, { recursive: true, force: true })
    }
  })

  it('does not accept member_briefing transcript success from an unattributed file', async () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const tempConfigDir = await mkdtemp(join(tmpdir(), 'spawn-bootstrap-transcript-'))
    try {
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir
      const teamName = 'beacon-desk-test'
      const memberName = 'atlas'
      const boundary = new Date(Date.now() - 5_000).toISOString()
      const successAt = new Date(Date.now() - 1_000).toISOString()
      const projectDir = getProjectDir(process.cwd())
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, 'lead-session.jsonl'),
        JSON.stringify({
          timestamp: successAt,
          teamName,
          agentName: 'team-lead',
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'item_0',
                content: `Member briefing for ${memberName} on team "${teamName}" (${teamName}).\nTask briefing for ${memberName}:\nNo actionable tasks.`,
                is_error: false,
              },
            ],
          },
        }) + '\n',
      )

      await expect(
        hasBootstrapConfirmation(
          teamName,
          `${memberName}@${teamName}`,
          boundary,
          memberName,
        ),
      ).resolves.toBe(false)
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
      }
      await rm(tempConfigDir, { recursive: true, force: true })
    }
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

describe('native process teammate backend selection', () => {
  it('uses native process backend for forced or separate-process auto teammate mode', () => {
    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'auto',
        forceProcessTeammates: '1',
      }),
    ).toBe(true)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'in-process',
        forceProcessTeammates: 'true',
      }),
    ).toBe(false)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'tmux',
        forceProcessTeammates: '1',
      }),
    ).toBe(false)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'auto',
        forceProcessTeammates: undefined,
      }),
    ).toBe(false)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'auto',
        forceProcessTeammates: undefined,
        separateProcessRequired: true,
      }),
    ).toBe(true)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'in-process',
        separateProcessRequired: true,
      }),
    ).toBe(false)

    expect(
      shouldUseNativeProcessBackendForSpawn({
        teammateMode: 'tmux',
        separateProcessRequired: true,
      }),
    ).toBe(false)
  })

  it('parses persisted process backend pid markers', () => {
    expect(parseProcessBackendPid('process:1234')).toBe(1234)
    expect(parseProcessBackendPid('5678')).toBe(5678)
    expect(parseProcessBackendPid('%1')).toBeNull()
    expect(parseProcessBackendPid('in-process')).toBeNull()
  })

  it('matches process backend command lines by teammate identity', () => {
    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name alpha --agent-id bob@alpha --agent-name bob',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(true)

    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name alpha --agent-id alice@alpha --agent-name alice',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(false)

    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name alpha --agent-id alice@alpha --note bob@alpha',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(false)

    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name "alpha team" --agent-id "bob@alpha team"',
        'bob@alpha team',
        'alpha team',
      ),
    ).toBe(true)
  })
})
