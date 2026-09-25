import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCwdState,
  getFlagSettingsInline,
  getInitialMainLoopModel,
  getMainLoopModelOverride,
  getOriginalCwd,
  setCwdState,
  setFlagSettingsInline,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { TeamCreateTool } from './TeamCreateTool.js'

describe('TeamCreateTool', () => {
  let tempConfigDir: string
  let previousClaudeConfigDir: string | undefined
  let previousOriginalCwd: string
  let previousCwd: string
  let previousModelOverride: string | null | undefined
  let previousInitialModel: string | null
  let previousFlagSettingsInline: Record<string, unknown> | null
  let previousEntryProvider: string | undefined
  let previousProviderManagedByHost: string | undefined

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'team-create-tool-'))
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir

    previousOriginalCwd = getOriginalCwd()
    previousCwd = getCwdState()
    previousModelOverride = getMainLoopModelOverride() as string | null | undefined
    previousInitialModel = getInitialMainLoopModel() as string | null
    previousFlagSettingsInline = getFlagSettingsInline()
    previousEntryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER
    previousProviderManagedByHost = process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST

    setOriginalCwd(tempConfigDir)
    setCwdState(tempConfigDir)
  })

  afterEach(() => {
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
    }

    setOriginalCwd(previousOriginalCwd)
    setCwdState(previousCwd)
    setMainLoopModelOverride(previousModelOverride)
    setInitialMainLoopModel(previousInitialModel)
    setFlagSettingsInline(previousFlagSettingsInline)
    if (previousEntryProvider === undefined) {
      delete process.env.CLAUDE_CODE_ENTRY_PROVIDER
    } else {
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = previousEntryProvider
    }
    if (previousProviderManagedByHost === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    } else {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST =
        previousProviderManagedByHost
    }

    rmSync(tempConfigDir, { recursive: true, force: true })
  })

  test('prefers launch-time model override over stale appState model for lead config', async () => {
    setMainLoopModelOverride('gemini-2.5-flash-lite')
    setInitialMainLoopModel('gemini-2.5-flash-lite')

    let appState: AppState = {
      teamContext: undefined,
      mainLoopModel: 'gemini-2.5-flash',
      mainLoopModelForSession: 'gemini-2.5-flash',
    } as AppState

    await TeamCreateTool.call(
      {
        team_name: 'atlas-hq-6',
        description: 'Regression repro',
      },
      {
        getAppState: () => appState,
        setAppState: (updater) => {
          appState = updater(appState)
        },
      } as never
    )

    const teamFile = await readTeamFileAsync('atlas-hq-6')
    expect(teamFile).not.toBeNull()
    expect(teamFile?.members[0]?.name).toBe('team-lead')
    expect(teamFile?.members[0]?.model).toBe('gemini-2.5-flash-lite')
  })

  test('falls back to a ChatGPT-supported Codex model for the lead config', async () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex'
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    setFlagSettingsInline({
      codex: {
        forced_login_method: 'chatgpt',
      },
    })
    setMainLoopModelOverride('gpt-5.1-codex-max')
    setInitialMainLoopModel('gpt-5.1-codex-max')

    let appState: AppState = {
      teamContext: undefined,
      mainLoopModel: 'gpt-5.1-codex-max',
      mainLoopModelForSession: 'gpt-5.1-codex-max',
    } as AppState

    await TeamCreateTool.call(
      {
        team_name: 'codex-safe-fallback',
        description: 'Codex ChatGPT auth fallback',
      },
      {
        getAppState: () => appState,
        setAppState: updater => {
          appState = updater(appState)
        },
      } as never
    )

    const teamFile = await readTeamFileAsync('codex-safe-fallback')
    expect(teamFile?.members[0]?.model).toBe('gpt-5.4')
  })

  test('replaces the hosted draft placeholder in place instead of renaming the team', async () => {
    const teamDir = join(tempConfigDir, 'teams', 'hosted-draft')
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(join(teamDir, 'config.json'),
      `${JSON.stringify({ name: 'hosted-draft', pendingCreate: true }, null, 2)}\n`)
    // A pinned model keeps lead model resolution away from ambient provider auth.
    setMainLoopModelOverride('claude-opus-4-6')
    setInitialMainLoopModel('claude-opus-4-6')
    let appState: AppState = { teamContext: undefined } as AppState

    const call = TeamCreateTool.call as (input: unknown, context: unknown) => Promise<unknown>
    const result = await call(
      { team_name: 'hosted-draft', description: 'Hosted native launch' },
      {
        getAppState: () => appState,
        setAppState: updater => {
          appState = updater(appState)
        },
      } as never
    )

    expect((result as { data: { team_name: string } }).data.team_name).toBe('hosted-draft')
    const teamFile = await readTeamFileAsync('hosted-draft')
    expect(teamFile?.leadAgentId).toBe('team-lead@hosted-draft')
    expect(teamFile?.members.map(member => member.name)).toEqual(['team-lead'])
  })

  test('rejects Windows reserved team names before creating team files', async () => {
    const result = await TeamCreateTool.validateInput?.(
      {
        team_name: 'con',
      },
      {} as never,
    )

    expect(result?.result).toBe(false)
    await expect(
      TeamCreateTool.call(
        {
          team_name: 'con',
        },
        {
          getAppState: () => ({ teamContext: undefined }) as AppState,
          setAppState: () => {},
        } as never,
      ),
    ).rejects.toThrow('reserved on Windows')
  })
})
