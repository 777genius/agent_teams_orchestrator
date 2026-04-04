import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCwdState,
  getInitialMainLoopModel,
  getMainLoopModelOverride,
  getOriginalCwd,
  setCwdState,
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

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'team-create-tool-'))
    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir

    previousOriginalCwd = getOriginalCwd()
    previousCwd = getCwdState()
    previousModelOverride = getMainLoopModelOverride() as string | null | undefined
    previousInitialModel = getInitialMainLoopModel() as string | null

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
})
