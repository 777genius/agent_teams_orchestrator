import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  assertBootstrapRuntimeWorkspace,
  deriveBootstrapTerminalStatus,
  runTeamBootstrap,
  shouldCreateTeamForBootstrap,
} from './teamBootstrapRunner.js'

let tempDirs: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
})

describe('team bootstrap partial-failure policy', () => {
  test('returns completed when no members failed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 0,
      }),
    ).toBe('completed')
  })

  test('returns partial_success when partial failures are allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: true,
        failedMembersCount: 1,
      }),
    ).toBe('partial_success')
  })

  test('returns failed when partial failures are not allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 2,
      }),
    ).toBe('failed')
  })
})

describe('team bootstrap create-vs-launch policy', () => {
  test('creates missing team during create mode', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'create',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toBe(true)
  })

  test('does not create team when already attached', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'attached_existing',
        teamName: 'atlas-hq',
      }),
    ).toBe(false)
  })

  test('throws when launch mode cannot find team config', () => {
    expect(() =>
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toThrow(
      'Deterministic bootstrap cannot launch team "atlas-hq" because the team config does not exist.',
    )
  })
})

describe('team bootstrap workspace safety', () => {
  test('accepts the current runtime workspace when it matches the request', async () => {
    const cwd = process.cwd()
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects bootstrap when requested workspace differs from runtime cwd', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-cwd-'))
    tempDirs.push(tempDir)
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd: tempDir,
      }),
    ).rejects.toThrow(
      `Deterministic bootstrap cannot start team "atlas-hq" because the runtime workspace "${process.cwd()}" does not match the requested workspace "${tempDir}".`,
    )
  })
})

describe('team bootstrap early-failure durability', () => {
  test('persists terminal failure when onInitialized throws after state init', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-run-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-1',
        requestHash: 'hash-1',
        mode: 'create',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
          },
        ],
        bootstrapTimeoutMs: 1_000,
        continueOnPartialFailure: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {},
        failed: async () => {},
      },
      onInitialized: async () => {
        throw new Error('boom')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.fatal).toBe(true)
    if (result.ok) {
      throw new Error('expected fatal bootstrap result')
    }
    expect(result.error).toContain('boom')

    const teamDir = path.join(
      tempDir,
      'teams',
      teamName,
    )
    const rawState = JSON.parse(
      await fs.readFile(path.join(teamDir, 'bootstrap-state.json'), 'utf8'),
    ) as {
      phase: string
      terminal?: { status?: string; reason?: string }
    }
    expect(rawState.phase).toBe('failed')
    expect(rawState.terminal?.status).toBe('failed')
    expect(rawState.terminal?.reason).toContain('boom')
  })
})
