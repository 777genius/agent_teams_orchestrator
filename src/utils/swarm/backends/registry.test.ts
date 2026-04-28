import { afterEach, describe, expect, it } from 'bun:test'
import { setIsInteractive } from '../../../bootstrap/state.js'
import {
  isInProcessEnabled,
  markInProcessFallback,
  resetBackendDetection,
} from './registry.js'
import { clearCliTeammateModeOverride } from './teammateModeSnapshot.js'

const originalForceProcessTeammates =
  process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES

afterEach(() => {
  if (originalForceProcessTeammates === undefined) {
    delete process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES
  } else {
    process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES =
      originalForceProcessTeammates
  }
  setIsInteractive(true)
  clearCliTeammateModeOverride('auto')
  resetBackendDetection()
})

describe('isInProcessEnabled forced process teammates', () => {
  it('honors forced process teammates in interactive auto sessions', () => {
    setIsInteractive(true)
    clearCliTeammateModeOverride('auto')
    process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1'

    expect(isInProcessEnabled()).toBe(false)
  })

  it('keeps explicit in-process mode as an opt-out from forced process teammates', () => {
    setIsInteractive(true)
    clearCliTeammateModeOverride('in-process')
    process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1'

    expect(isInProcessEnabled()).toBe(true)
  })

  it('lets forced process teammates override stale non-interactive in-process fallback', () => {
    setIsInteractive(false)
    clearCliTeammateModeOverride('auto')
    markInProcessFallback()
    process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '1'

    expect(isInProcessEnabled()).toBe(false)
  })
})
