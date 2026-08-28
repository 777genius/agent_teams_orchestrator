import { afterEach, describe, expect, test } from 'bun:test'

import type { OpenCodeInventorySnapshot } from '../opencode/types.js'
import { getUnifiedRuntimeStatusPayload } from './registry.js'
import {
  buildOpenCodePassiveStatus,
  type OpenCodePassiveStatusEvidence,
} from './openCodePassiveStatus.js'

const originalManagedBinary = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
const originalOpenCodeBinary = process.env.OPENCODE_BIN_PATH

afterEach(() => {
  restoreEnv('CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', originalManagedBinary)
  restoreEnv('OPENCODE_BIN_PATH', originalOpenCodeBinary)
})

describe('OpenCode passive runtime status', () => {
  test('uses the exact provider status wire enum', () => {
    const expected = [
      ['ready', 'model_only', null],
      ['pending', 'pending', 'partial_response'],
      ['timeout', 'transient_error', 'timeout'],
      ['unavailable', 'transient_error', 'unavailable'],
      ['runtime_missing', 'transient_error', 'runtime_missing'],
    ] as const

    for (const [state, outcome, errorCode] of expected) {
      const status = passiveStatus({
        state,
        binaryPath: state === 'runtime_missing' ? null : '/managed/opencode',
      })
      expect(status.statusCheckOutcome).toBe(outcome)
      expect(status.statusCheckErrorCode).toBe(errorCode)
    }
  })

  test('successful retained evidence is display-only and cannot grant launch authority', () => {
    const status = passiveStatus({
      state: 'ready',
      binaryPath: '/managed/opencode',
      version: '1.2.3',
      models: ['openai/gpt-5', 'anthropic/claude-sonnet-4-5'],
    })

    expect(status).toMatchObject({
      supported: true,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      capabilities: { teamLaunch: false, oneShot: false },
      models: ['openai/gpt-5', 'anthropic/claude-sonnet-4-5'],
      statusCheckOutcome: 'model_only',
      statusCheckErrorCode: null,
    })
    expect(status.backend?.authMethodDetail).toBeNull()
    expect(status.detailMessage).toContain('version 1.2.3')
  })

  test('incomplete retained evidence is pending and remains non-authorizing', () => {
    const status = passiveStatus({
      state: 'pending',
      binaryPath: '/managed/opencode',
      models: ['openai/gpt-5'],
    })

    expect(status).toMatchObject({
      authenticated: false,
      capabilities: { teamLaunch: false },
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    })
  })

  test('reader failure is unavailable rather than optimistic legacy status', () => {
    const status = buildOpenCodePassiveStatus({
      readOpenCodePassiveEvidence: () => {
        throw new Error('retained evidence unavailable')
      },
    })

    expect(status).toMatchObject({
      supported: false,
      authenticated: false,
      capabilities: { teamLaunch: false },
      statusCheckOutcome: 'transient_error',
      statusCheckErrorCode: 'unavailable',
    })
  })

  test('missing legacy outcome fields remain pending and non-authorizing', () => {
    const status = buildOpenCodePassiveStatus({
      readOpenCodePassiveEvidence: () => ({
        binaryPath: '/legacy/opencode',
        authenticated: true,
        capabilities: { teamLaunch: true },
      } as unknown as OpenCodePassiveStatusEvidence),
    })

    expect(status).toMatchObject({
      authenticated: false,
      capabilities: { teamLaunch: false },
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
    })
  })

  test('default reader uses only already-known binary metadata', () => {
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = '/managed/opencode'
    process.env.OPENCODE_BIN_PATH = '/user/opencode'

    const status = buildOpenCodePassiveStatus()

    expect(status.externalRuntimeDiagnostics[0]).toEqual({
      id: 'cli-bin',
      label: 'OpenCode CLI',
      detected: true,
      statusMessage: 'OpenCode detected (passive)',
      detailMessage: '/managed/opencode',
    })
    expect(status.statusCheckOutcome).toBe('model_only')
  })

  test('summary registry path never calls active inventory', async () => {
    let passiveReads = 0
    let inventoryReads = 0
    const payload = await getUnifiedRuntimeStatusPayload('opencode', {
      readOpenCodePassiveEvidence: () => {
        passiveReads += 1
        return {
          state: 'ready',
          binaryPath: '/managed/opencode',
          models: ['openai/gpt-5'],
        }
      },
      getOpenCodeInventorySnapshot: async () => {
        inventoryReads += 1
        throw new Error('active inventory must be unreachable')
      },
    }, { detailLevel: 'summary' })

    expect(passiveReads).toBe(1)
    expect(inventoryReads).toBe(0)
    expect(payload.providers.opencode).toMatchObject({
      authenticated: false,
      capabilities: { teamLaunch: false },
      models: ['openai/gpt-5'],
      statusCheckOutcome: 'model_only',
    })
    expect(payload.providers.opencode).not.toHaveProperty('modelCatalog')
    expect(payload.providers.opencode).not.toHaveProperty('capabilitiesInfo')
  })
})

describe('OpenCode active runtime status contract', () => {
  test.each([
    {
      name: 'complete response',
      snapshot: inventory({
        connectedProviders: [
          { id: 'openai', authHint: 'api', source: 'credentials' },
        ],
        models: ['openai/gpt-5'],
      }),
      outcome: 'authoritative',
      errorCode: null,
      authorizes: true,
    },
    {
      name: 'partial response with retained provider and model data',
      snapshot: inventory({
        connectedProviders: [
          { id: 'openai', authHint: 'api', source: 'credentials' },
        ],
        models: ['openai/gpt-5'],
        probeError: 'provider response ended early',
      }),
      outcome: 'pending',
      errorCode: 'partial_response',
      authorizes: false,
    },
    {
      name: 'timeout with retained provider and model data',
      snapshot: inventory({
        connectedProviders: [
          { id: 'openai', authHint: 'api', source: 'credentials' },
        ],
        models: ['openai/gpt-5'],
        probeError: 'OpenCode inventory probe timed out after 10ms',
      }),
      outcome: 'transient_error',
      errorCode: 'timeout',
      authorizes: false,
    },
    {
      name: 'unavailable error with retained provider and model data',
      snapshot: inventory({
        connectedProviders: [
          { id: 'openai', authHint: 'api', source: 'credentials' },
        ],
        models: ['openai/gpt-5'],
        probeError: 'OpenCode inventory unavailable',
      }),
      outcome: 'pending',
      errorCode: 'partial_response',
      authorizes: false,
    },
    {
      name: 'unavailable response without retained data',
      snapshot: inventory({ probeError: 'OpenCode inventory unavailable' }),
      outcome: 'transient_error',
      errorCode: 'unavailable',
      authorizes: false,
    },
    {
      name: 'missing runtime',
      snapshot: inventory({ detected: false, binaryPath: null }),
      outcome: 'transient_error',
      errorCode: 'runtime_missing',
      authorizes: false,
    },
  ])('$name emits the expected status contract', async ({
    snapshot,
    outcome,
    errorCode,
    authorizes,
  }) => {
    const payload = await getUnifiedRuntimeStatusPayload('opencode', {
      getOpenCodeInventorySnapshot: async () => snapshot,
    })
    const opencode = payload.providers.opencode

    expect(opencode?.statusCheckOutcome).toBe(outcome)
    expect(opencode?.statusCheckErrorCode).toBe(errorCode)
    expect(opencode?.authenticated).toBe(authorizes)
    expect(opencode?.authMethod).toBe(authorizes ? 'opencode_managed' : null)
    expect(opencode?.capabilities.teamLaunch).toBe(authorizes)
    expect(opencode?.verificationState).toBe(
      authorizes
        ? 'verified'
        : snapshot.detected
          ? outcome === 'pending' ? 'unknown' : 'error'
          : 'offline',
    )
    if (!authorizes) expect(opencode?.backend?.authMethodDetail ?? null).toBeNull()
  })
})

function passiveStatus(evidence: OpenCodePassiveStatusEvidence) {
  let reads = 0
  const status = buildOpenCodePassiveStatus({
    readOpenCodePassiveEvidence: () => {
      reads += 1
      return evidence
    },
  })
  expect(reads).toBe(1)
  return status
}

function inventory(
  overrides: Partial<OpenCodeInventorySnapshot> = {},
): OpenCodeInventorySnapshot {
  return {
    detected: true,
    binaryPath: '/managed/opencode',
    version: '1.2.3',
    projectPath: '/not-a-real-project',
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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
