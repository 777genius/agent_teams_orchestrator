import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getSessionId,
  getSessionProjectDir,
  switchSession,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import { hasBootstrapConfirmation } from './spawnMultiAgent.js'
import { getSeparateProcessRequirement } from './spawnMultiAgent.js'
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

  it('counts matching member_briefing transcript result as bootstrap confirmation', async () => {
    const previousSessionId = getSessionId()
    const previousProjectDir = getSessionProjectDir()
    const projectDir = await mkdtemp(join(tmpdir(), 'spawn-transcript-ok-'))
    const teamName = `transcript-team-${Date.now()}`
    const boundary = '2026-05-01T19:56:38.000Z'

    try {
      switchSession(randomUUID() as SessionId, projectDir)
      await writeFile(
        join(projectDir, 'bob-session.jsonl'),
        [
          JSON.stringify({
            teamName,
            agentName: 'bob',
            type: 'user',
            timestamp: '2026-05-01T19:56:42.000Z',
            message: {
              role: 'user',
              content: `You are bootstrapping into team "${teamName}" as member "bob".`,
            },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-05-01T19:56:56.000Z',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  name: 'mcp__agent-teams__member_briefing',
                  input: { teamName, memberName: 'bob' },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-05-01T19:56:57.000Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  content: `Member briefing for bob on team "${teamName}" (${teamName}).\nRole: developer.`,
                },
              ],
            },
          }),
        ].join('\n'),
      )

      expect(
        await hasBootstrapConfirmation(
          teamName,
          `bob@${teamName}`,
          boundary,
          'bob',
        ),
      ).toBe(true)
    } finally {
      switchSession(previousSessionId, previousProjectDir)
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('counts matching native app-managed runtime proof as bootstrap confirmation', async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await mkdtemp(join(tmpdir(), 'spawn-native-proof-ok-'))
    const teamName = `native-proof-team-${Date.now()}`
    const boundary = '2026-05-01T19:56:38.000Z'
    const bootstrapRunId = 'run-native-proof'
    const proofToken = 'native-proof-token'
    const contextHash = 'a'.repeat(64)
    const briefingHash = 'b'.repeat(64)
    const runtimeEventsPath = join(configDir, 'runtime', 'bob.runtime.jsonl')

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      await mkdir(join(configDir, 'teams', teamName), { recursive: true })
      await mkdir(join(configDir, 'runtime'), { recursive: true })
      await writeFile(
        join(configDir, 'teams', teamName, 'config.json'),
        JSON.stringify({
          name: teamName,
          members: [
            {
              name: 'bob',
              agentId: `bob@${teamName}`,
              bootstrapExpectedAfter: boundary,
              bootstrapProofToken: proofToken,
              bootstrapRunId,
              bootstrapProofMode: 'native_app_managed_context',
              bootstrapContextHash: contextHash,
              bootstrapBriefingHash: briefingHash,
              bootstrapRuntimeEventsPath: runtimeEventsPath,
            },
          ],
        }),
      )
      await writeFile(
        runtimeEventsPath,
        `${JSON.stringify({
          version: 1,
          type: 'bootstrap_confirmed',
          timestamp: '2026-05-01T19:56:56.000Z',
          pid: 1234,
          teamName,
          agentName: 'bob',
          agentId: `bob@${teamName}`,
          runId: bootstrapRunId,
          source: 'native_app_managed_bootstrap_private_turn',
          bootstrapProofToken: proofToken,
          contextHash,
          briefingHash,
        })}\n`,
      )

      expect(
        await hasBootstrapConfirmation(
          teamName,
          `bob@${teamName}`,
          boundary,
          'bob',
        ),
      ).toBe(true)
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
      }
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('does not count native app-managed runtime proof with mismatched hashes', async () => {
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await mkdtemp(join(tmpdir(), 'spawn-native-proof-mismatch-'))
    const teamName = `native-proof-team-${Date.now()}`
    const boundary = '2026-05-01T19:56:38.000Z'
    const bootstrapRunId = 'run-native-proof'
    const proofToken = 'native-proof-token'
    const runtimeEventsPath = join(configDir, 'runtime', 'bob.runtime.jsonl')

    try {
      process.env.CLAUDE_CONFIG_DIR = configDir
      await mkdir(join(configDir, 'teams', teamName), { recursive: true })
      await mkdir(join(configDir, 'runtime'), { recursive: true })
      await writeFile(
        join(configDir, 'teams', teamName, 'config.json'),
        JSON.stringify({
          name: teamName,
          members: [
            {
              name: 'bob',
              agentId: `bob@${teamName}`,
              bootstrapExpectedAfter: boundary,
              bootstrapProofToken: proofToken,
              bootstrapRunId,
              bootstrapProofMode: 'native_app_managed_context',
              bootstrapContextHash: 'a'.repeat(64),
              bootstrapBriefingHash: 'b'.repeat(64),
              bootstrapRuntimeEventsPath: runtimeEventsPath,
            },
          ],
        }),
      )
      await writeFile(
        runtimeEventsPath,
        `${JSON.stringify({
          version: 1,
          type: 'bootstrap_confirmed',
          timestamp: '2026-05-01T19:56:56.000Z',
          pid: 1234,
          teamName,
          agentName: 'bob',
          agentId: `bob@${teamName}`,
          runId: bootstrapRunId,
          source: 'native_app_managed_bootstrap_private_turn',
          bootstrapProofToken: proofToken,
          contextHash: 'c'.repeat(64),
          briefingHash: 'b'.repeat(64),
        })}\n`,
      )

      expect(
        await hasBootstrapConfirmation(
          teamName,
          `bob@${teamName}`,
          boundary,
          'bob',
        ),
      ).toBe(false)
    } finally {
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
      }
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('does not count stale or foreign member_briefing transcript results', async () => {
    const previousSessionId = getSessionId()
    const previousProjectDir = getSessionProjectDir()
    const projectDir = await mkdtemp(join(tmpdir(), 'spawn-transcript-stale-'))
    const teamName = `transcript-team-${Date.now()}`
    const boundary = '2026-05-01T19:56:38.000Z'

    try {
      switchSession(randomUUID() as SessionId, projectDir)
      await writeFile(
        join(projectDir, 'foreign-session.jsonl'),
        [
          JSON.stringify({
            teamName,
            agentName: 'alice',
            type: 'user',
            timestamp: '2026-05-01T19:56:42.000Z',
            message: { role: 'user', content: 'bootstrap' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-05-01T19:56:56.000Z',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  name: 'mcp__agent-teams__member_briefing',
                  input: { teamName, memberName: 'bob' },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-05-01T19:56:57.000Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  content: `Member briefing for bob on team "${teamName}" (${teamName}).`,
                },
              ],
            },
          }),
        ].join('\n'),
      )

      await writeFile(
        join(projectDir, 'stale-session.jsonl'),
        [
          JSON.stringify({
            teamName,
            agentName: 'bob',
            type: 'user',
            timestamp: '2026-05-01T19:55:00.000Z',
            message: { role: 'user', content: 'old bootstrap' },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-05-01T19:55:01.000Z',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  name: 'mcp__agent-teams__member_briefing',
                  input: { teamName, memberName: 'bob' },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'user',
            timestamp: '2026-05-01T19:55:02.000Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  content: `Member briefing for bob on team "${teamName}" (${teamName}).`,
                },
              ],
            },
          }),
        ].join('\n'),
      )

      expect(
        await hasBootstrapConfirmation(
          teamName,
          `bob@${teamName}`,
          boundary,
          'bob',
        ),
      ).toBe(false)
    } finally {
      switchSession(previousSessionId, previousProjectDir)
      await rm(projectDir, { recursive: true, force: true })
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
