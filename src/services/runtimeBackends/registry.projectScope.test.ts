import { describe, expect, test } from 'bun:test'

import { getUnifiedRuntimeStatusPayload } from './registry.js'

describe('OpenCode project identity for runtime status', () => {
  test('uses explicit project scope independently of Bun process cwd; remains fail closed', async () => {
    const selected = '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio'
    const received: Array<string | null | undefined> = []
    const getOpenCodeInventorySnapshot = async (projectPath?: string | null) => {
      received.push(projectPath)
      return {
        detected: false,
        binaryPath: null,
        version: null,
        projectPath: projectPath ?? '/cwd/was-not-selected',
        profile: null,
        connectedProviders: [],
        availableProviders: [],
        models: [],
        agents: [],
        authStorePath: null,
        probeError: 'Offline project read',
        diagnostics: [],
        readGeneration: 'unsupported' as const,
      }
    }
    const status = await getUnifiedRuntimeStatusPayload(
      'opencode',
      { getOpenCodeInventorySnapshot },
      { detailLevel: 'full', projectPath: selected },
    )
    expect(received).toEqual([selected])
    expect(status.providers.opencode?.capabilities.teamLaunch).toBe(false)
    expect(status.providers.opencode?.authenticated).toBe(false)

    await getUnifiedRuntimeStatusPayload('opencode', { getOpenCodeInventorySnapshot }, { detailLevel: 'full' })
    expect(received).toEqual([selected, undefined])
  })

  test('summary remains passive and does not inspect the requested project', async () => {
    let called = false
    const status = await getUnifiedRuntimeStatusPayload('opencode', {
      getOpenCodeInventorySnapshot: async () => {
        called = true
        throw new Error('must not inspect a project for passive status')
      },
    }, { detailLevel: 'summary', projectPath: '/Users/TEST/Library/CloudStorage/Project' })
    expect(called).toBe(false)
    expect(status.providers.opencode?.capabilities.teamLaunch).toBe(false)
  })
})
