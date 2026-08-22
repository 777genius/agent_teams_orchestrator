import { describe, expect, test } from 'bun:test'

import type { OpenCodeInventorySnapshot } from '../opencode/types.js'
import { getOpenCodeRuntimeStatusCheck } from './opencodeStatusCheck.js'

function snapshot(overrides: Partial<OpenCodeInventorySnapshot> = {}): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/opt/homebrew/bin/opencode',
    version: '1.18.11',
    projectPath: '/tmp/status-contract',
    profile: null,
    connectedProviders: [],
    availableProviders: [],
    models: [],
    modelMetadata: [],
    agents: [],
    authStorePath: null,
    probeError: null,
    diagnostics: [],
    ...overrides,
  }
}

describe('getOpenCodeRuntimeStatusCheck', () => {
  test('makes completed inventory authoritative', () => {
    expect(getOpenCodeRuntimeStatusCheck(snapshot())).toEqual({
      statusCheckOutcome: 'authoritative',
    })
  })

  test('does not turn an inventory timeout into a disconnect', () => {
    expect(
      getOpenCodeRuntimeStatusCheck(
        snapshot({ probeError: 'OpenCode inventory probe timed out after 8000ms' }),
      ),
    ).toEqual({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'timeout',
    })
  })

  test('makes a completed missing-runtime observation authoritative', () => {
    expect(
      getOpenCodeRuntimeStatusCheck(snapshot({ detected: false, binaryPath: null })),
    ).toEqual({
      statusCheckOutcome: 'authoritative',
      statusCheckErrorCode: 'runtime_missing',
    })
  })

  test('keeps failed probes transient even when detection is false', () => {
    expect(
      getOpenCodeRuntimeStatusCheck(
        snapshot({
          detected: false,
          binaryPath: null,
          probeError: 'OpenCode profile preparation failed: EACCES',
        }),
      ),
    ).toEqual({
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    })
  })
})
