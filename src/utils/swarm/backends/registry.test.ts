import { describe, expect, it } from 'bun:test'
import {
  resolveInProcessEnabled,
} from './registry.js'

describe('resolveInProcessEnabled forced process teammates', () => {
  it('honors forced process teammates in interactive auto sessions', () => {
    expect(
      resolveInProcessEnabled({
        mode: 'auto',
        isNonInteractiveSession: false,
        forceProcessTeammates: '1',
        inProcessFallbackActive: false,
        insideTmux: false,
        inITerm2: false,
      }),
    ).toBe(false)
  })

  it('keeps explicit in-process mode as an opt-out from forced process teammates', () => {
    expect(
      resolveInProcessEnabled({
        mode: 'in-process',
        isNonInteractiveSession: false,
        forceProcessTeammates: '1',
        inProcessFallbackActive: false,
        insideTmux: false,
        inITerm2: false,
      }),
    ).toBe(true)
  })

  it('lets forced process teammates override stale non-interactive in-process fallback', () => {
    expect(
      resolveInProcessEnabled({
        mode: 'auto',
        isNonInteractiveSession: true,
        forceProcessTeammates: '1',
        inProcessFallbackActive: true,
        insideTmux: false,
        inITerm2: false,
      }),
    ).toBe(false)
  })
})
