import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from 'bun:test'

import type { HostedControlRuntimePortFactoryContext } from '../HostedControlRuntime.js'
import { createHostedManagedOpenCodeLane,
  type HostedManagedOpenCodeLaneDependencies } from './HostedManagedOpenCodeLane.js'

const input = {
  planTeamId: `team_${'a'.repeat(32)}`,
  workspaceRoot: '/sandbox/test-project', toolApprovalMode: 'auto' as const,
  runId: `run_${'b'.repeat(32)}`,
  lane: { kind: 'opencode', laneId: `lane_${'c'.repeat(32)}`,
    selectedModel: 'openai/test-model', members: [{ name: 'test-member', prompt: 'Test prompt.' }] },
}

async function fixture() {
  const teamRoot = await mkdtemp(join(tmpdir(), 'hosted-isolated-lane-test-'))
  let rootCalls = 0
  let productCalls = 0
  let ownerCalls = 0
  const root = {
    prepareManagedMember: async () => { rootCalls++; throw new Error('unexpected root prepare') },
    startManagedMember: async () => { rootCalls++; throw new Error('unexpected root start') },
    observeManagedMember: async () => { rootCalls++; throw new Error('unexpected root observe') },
    stopManagedMember: async () => { rootCalls++; throw new Error('unexpected root stop') },
    beginEndpointUse: async () => { rootCalls++; throw new Error('unexpected endpoint begin') },
    endEndpointUse: async () => { rootCalls++; throw new Error('unexpected endpoint end') },
  }
  const context = { teamRoot, authority: { teamId: input.planTeamId },
    isCurrentAuthority: async () => { ownerCalls++; return true } } as unknown as HostedControlRuntimePortFactoryContext
  const dependencies = {
    root: root as never,
    resolveCanonicalLaneIdentity: async () => null,
    preparationRequest: async () => null,
    assertCurrentProduct: async () => { productCalls++; return false },
    readiness: () => ({ endpoint: true, fd3Handoff: true, providerConfig: true,
      memberSessions: true, gateway: false, product: true, root: true }),
  } satisfies HostedManagedOpenCodeLaneDependencies
  return { context, dependencies, calls: () => ({ rootCalls, productCalls, ownerCalls }),
    cleanup: () => rm(teamRoot, { recursive: true, force: true }) }
}

test('incomplete root/Product dependencies cannot create a hosted lane', async () => {
  const f = await fixture()
  try {
    expect(() => createHostedManagedOpenCodeLane(f.context, {} as never))
      .toThrow('dependencies-incomplete')
  } finally { await f.cleanup() }
})

test('gateway gate remains closed before Product or root effects', async () => {
  const f = await fixture()
  try {
    const lane = createHostedManagedOpenCodeLane(f.context, f.dependencies)
    expect(lane.supports('launch')).toBe(false)
    expect(await lane.launch(input as never)).toEqual({ phase: 'failed', recoverable: true })
    expect(f.calls()).toEqual({ rootCalls: 0, productCalls: 0, ownerCalls: 0 })
  } finally { await f.cleanup() }
})

test('current Product denial stops before managed root preparation', async () => {
  const f = await fixture()
  try {
    const lane = createHostedManagedOpenCodeLane(f.context, { ...f.dependencies,
      readiness: () => ({ ...f.dependencies.readiness(), gateway: true }) })
    expect(lane.supports('launch')).toBe(true)
    expect(await lane.launch(input as never)).toEqual({ phase: 'failed', recoverable: true })
    expect(f.calls()).toEqual({ rootCalls: 0, productCalls: 1, ownerCalls: 1 })
  } finally { await f.cleanup() }
})
