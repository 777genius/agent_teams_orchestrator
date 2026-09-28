import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildHostedAppMcpLaunchConfig } from '../opencode/OpenCodeMcpManager.js'
import type { TeamLifecycleLaunchPlan } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import type { HostedControlRuntimePortFactoryContext } from './HostedControlRuntime.js'
import { createHostLocalNativeLaneFactory } from './HostedNativeHostLocalLane.js'

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function nativeContext(): Promise<HostedControlRuntimePortFactoryContext> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'hosted-native-lane-')))
  roots.push(base)
  const claudeRoot = join(base, 'claude')
  const teamRoot = join(claudeRoot, 'teams', 'hosted-team')
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  // Only the fields the native factory reads are meaningful here.
  return { claudeRoot, teamRoot, legacyKey: 'hosted-team' } as HostedControlRuntimePortFactoryContext
}

const plan: TeamLifecycleLaunchPlan = {
  schemaVersion: 2, workspaceId: 'workspace_1', teamId: 'team_1', workspaceRoot: '/work', toolApprovalMode: 'auto',
  lanes: [{ laneId: 'lane_1', kind: 'native', provider: 'codex', members: [{ name: 'team-lead', prompt: 'Lead.' }] }],
}
const codex = { codexHome: '/home/op/.codex', codexCliPath: '/opt/codex/bin/codex' }
const appMcp = buildHostedAppMcpLaunchConfig({
  command: '/opt/node/bin/node', commandSha256: 'a'.repeat(64),
  entry: '/opt/agent-teams/mcp/index.js', entrySha256: 'b'.repeat(64),
}, '/srv/claude')
const hostPlatform = process.platform === 'linux' || process.platform === 'darwin'

describe.skipIf(!hostPlatform)('createHostLocalNativeLaneFactory', () => {
  test('stays capability-false without the verified agent-teams MCP artifact', async () => {
    const lane = await createHostLocalNativeLaneFactory({ codex })(await nativeContext(), { appMcp: null })
    expect(lane?.kind).toBe('native')
    expect(lane?.supports('launch')).toBe(false)
  })

  test('admits only the providers the operator configured', async () => {
    const context = await nativeContext()
    const codexOnly = await createHostLocalNativeLaneFactory({ codex })(context, { appMcp })
    expect(codexOnly?.supports('launch')).toBe(true)
    expect(codexOnly?.supportsPlan?.(plan)).toBe(true)
    const claudeOnly = await createHostLocalNativeLaneFactory({ anthropic: { oauthTokenFile: '/op/token' } })(
      context, { appMcp })
    expect(claudeOnly?.supportsPlan?.(plan)).toBe(false)
    const unconfigured = await createHostLocalNativeLaneFactory({})(context, { appMcp })
    expect(unconfigured?.supports('launch')).toBe(false)
  })
})
