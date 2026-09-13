import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveNativeProcessLaunchMaterial, type NativeProcessLaunchMaterialRequest } from './NativeProcessLaunchMaterial.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const sum = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function request(): Promise<NativeProcessLaunchMaterialRequest> {
  const data = await mkdtemp(join(tmpdir(), 'native-material-')); roots.push(data); await chmod(data, 0o700)
  const legacyKey = 'exact-team'; const team = join(data, 'teams', legacyKey); const tasks = join(data, 'tasks', legacyKey); const cwd = join(data, 'cwd')
  await Promise.all([team, tasks, cwd].map(value => mkdir(value, { recursive: true, mode: 0o700 })))
  const settingsPath = join(data, 'settings.json'); const mcpPath = join(data, 'mcp.json')
  await writeFile(settingsPath, '{}', { mode: 0o600 }); await writeFile(mcpPath, '{}', { mode: 0o600 })
  const executablePath = await realpath(process.execPath); const executableBytes = await readFile(executablePath)
  const admitted = (canonicalPath: string, bytes: Uint8Array) => ({ canonicalPath, sha256: sum(bytes) })
  const members = [
    { ordinal: 0, laneId: 'lane-a', displayName: 'alpha', agentId: 'member-alpha', provider: 'anthropic', model: 'claude', prompt: 'lead' },
    { ordinal: 1, laneId: 'lane-b', displayName: 'beta', agentId: 'member-beta', provider: 'codex', model: 'gpt', prompt: 'work' },
    { ordinal: 2, laneId: 'lane-b', displayName: 'gamma', agentId: 'member-gamma', provider: 'gemini', model: 'gemini', prompt: 'work' },
    { ordinal: 3, laneId: 'lane-c', displayName: 'delta', agentId: 'member-delta', provider: 'opencode', model: 'open', prompt: 'work' },
    { ordinal: 4, laneId: 'lane-a', displayName: 'epsilon', agentId: 'member-epsilon', provider: 'anthropic', model: 'claude', prompt: 'repeat' },
  ] as const
  return {
    publicTeamId: 'public-team', legacyKey, canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks, canonicalCwd: cwd,
    runId: 'run-1', attemptSetId: 'attempt-set-1', ownerBootId: 'boot-1', ownerControllerInstanceId: 'controller-1',
    ownerPlanGeneration: 'opaque-generation', productPlanGeneration: 7, productPlanRef: `sha256:${'7'.repeat(64)}`, workdirRef: 'workdir:admitted', primaryOrdinal: 0, members,
    cli: { executable: { ...admitted(executablePath, executableBytes), executableRef: 'executable:cli', binaryId: 'binary:cli', binaryRevision: 3,
      binaryHash: sum(executableBytes) }, argv: [], argvKind: 'executable-only' },
    settings: admitted(settingsPath, new TextEncoder().encode('{}')), mcpConfig: admitted(mcpPath, new TextEncoder().encode('{}')),
    permissionMode: 'bypassPermissions', disallowedTools: ['TeamCreate'], strictMcpConfig: true,
    profiles: members.map(member => ({ provider: member.provider, selectedBackendId: 'selected', resolvedBackendId: 'resolved', resolvedLaunchModel: member.model,
      endpointIdentity: `endpoint:${member.provider}`, configurationIdentity: `configuration:${member.agentId}`, authHandleRevision: 'auth:1',
      accessAdmissionId: `access:${member.agentId}`, environmentRef: `environment:${member.agentId}`, frozenEnv: { PATH: '/admitted/bin' } })),
    anchorCapability: { admissionId: 'admission:owner-anchor', version: 1,
      hash: 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5' },
  }
}

describe('native process launch material admission', () => {
  test('preserves the exact ordered mixed roster including repeated providers and lanes', async () => {
    const material = await resolveNativeProcessLaunchMaterial(await request())
    expect(material.members.map(member => [member.ordinal, member.provider, member.laneId])).toEqual([
      [0, 'anthropic', 'lane-a'], [1, 'codex', 'lane-b'], [2, 'gemini', 'lane-b'], [3, 'opencode', 'lane-c'], [4, 'anthropic', 'lane-a'],
    ])
    expect(material.ownerPlanGeneration).toBe('opaque-generation')
    expect(material.productPlanGeneration).toBe(7)
  })

  test('rejects ambiguous order and profile/model substitution', async () => {
    const ambiguous = await request()
    const reordered = [1, 0, 2, 3, 4] as const
    await expect(resolveNativeProcessLaunchMaterial({ ...ambiguous,
      members: reordered.map(index => ambiguous.members[index]!),
      profiles: reordered.map(index => ambiguous.profiles[index]!),
    })).rejects.toThrow('order or ordinal')
    const substituted = await request()
    await expect(resolveNativeProcessLaunchMaterial({ ...substituted, profiles: substituted.profiles.map((profile, index) => index === 2
      ? { ...profile, resolvedLaunchModel: 'other' } : profile) })).rejects.toThrow('profile selection mismatch')
  })

  test('rejects changed admitted settings bytes and fixed-control relaxation', async () => {
    const changed = await request(); await writeFile(changed.settings.canonicalPath, '{"changed":true}', { mode: 0o600 })
    await expect(resolveNativeProcessLaunchMaterial(changed)).rejects.toThrow('changed after admission')
    const relaxed = await request()
    await expect(resolveNativeProcessLaunchMaterial({ ...relaxed, strictMcpConfig: false } as never)).rejects.toThrow('fixed permission controls')
  })

  test('rejects base argv control injection and unbound source entry material', async () => {
    const injected = await request()
    await expect(resolveNativeProcessLaunchMaterial({ ...injected, cli: { ...injected.cli, argv: ['--model', 'substitute'] } })).rejects.toThrow('override fixed')
    const source = await request()
    await expect(resolveNativeProcessLaunchMaterial({ ...source, cli: { ...source.cli, argvKind: 'source-entry', sourceEntryArgIndex: 0 } } as never))
      .rejects.toThrow('source argv lacks exact admitted module')
  })
})
