import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOSTED_CONTROL_CONFIG_ENV,
  installHostedControlPortFactory,
  startProductionHostedControlFromEnvironment,
  startHostedControlFromEnvironment,
  stopHostedControl,
} from './udsMessaging.js'

const roots: string[] = []

afterEach(async () => {
  await stopHostedControl()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('hosted control setup gate', () => {
  test('is inert without config and fails closed when authority ports are absent', async () => {
    expect(await startHostedControlFromEnvironment({})).toBeNull()
    expect(startHostedControlFromEnvironment({
      [HOSTED_CONTROL_CONFIG_ENV]: '/private/runtime/hosted-control.json',
    })).rejects.toThrow(
      'Hosted control config is unavailable: no admitted lifecycle owner and message port composition is installed',
    )
  })

  test('uninstalls the production factory when configured startup fails', async () => {
    await expect(startProductionHostedControlFromEnvironment({
      [HOSTED_CONTROL_CONFIG_ENV]: '/missing/private/hosted-control.json',
    })).rejects.toThrow()

    const uninstall = installHostedControlPortFactory(() => ({
      lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
      messages: { dispatch: async () => ({}) },
      close: async () => undefined,
    }))
    uninstall()
  })

  test('starts the configured production composition and uninstalls it on stop', async () => {
    const root = await realpath(await mkdtemp('/tmp/hosted-production-start-'))
    roots.push(root)
    const claudeRoot = join(root, 'claude')
    const teamRoot = join(claudeRoot, 'teams', 'legacy')
    const runtimeRoot = join(root, 'runtime')
    const configPath = join(runtimeRoot, 'config.json')
    const secretFile = join(runtimeRoot, 'owner.key')
    await mkdir(teamRoot, { recursive: true, mode: 0o700 })
    await mkdir(join(claudeRoot, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
    await writeFile(secretFile, 'a'.repeat(64), { mode: 0o600 })
    await writeFile(configPath, JSON.stringify({
      socketPath: join(runtimeRoot, 'control.sock'),
      secretFile,
      claudeRoot,
      deploymentId: 'deployment-test',
      bootId: 'boot-test',
      restoreGeneration: 0,
      workspaceId: 'workspace-test',
      teamId: `team_${'a'.repeat(32)}`,
      legacyKey: 'legacy',
      mountGeneration: 1,
      declaredRootHash: 'b'.repeat(64),
      ownerAuthority: 'owner-authority_production-test',
      ownerGeneration: 1,
      ownerSessionId: `owner-session_${'c'.repeat(32)}`,
    }), { mode: 0o600 })
    await Promise.all([chmod(secretFile, 0o600), chmod(configPath, 0o600)])
    const environment = { [HOSTED_CONTROL_CONFIG_ENV]: configPath }

    expect(await startProductionHostedControlFromEnvironment(environment)).not.toBeNull()
    await stopHostedControl()
    expect(await startProductionHostedControlFromEnvironment(environment)).not.toBeNull()
  })
})
