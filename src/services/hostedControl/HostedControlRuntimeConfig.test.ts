import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadHostedControlRuntimeConfig } from './HostedControlRuntimeConfig.js'

const roots: string[] = []
afterEach(async () => Promise.all(
  roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
))

describe('loadHostedControlRuntimeConfig', () => {
  test('preserves the opaque declared root hash and rejects extension keys', async () => {
    const fixture = await createFixture()
    expect((await loadHostedControlRuntimeConfig(fixture.configPath)).declaredRootHash)
      .toBe('d'.repeat(64))
    await writeFile(fixture.configPath, JSON.stringify({ ...fixture.value, extra: true }), { mode: 0o600 })
    expect(loadHostedControlRuntimeConfig(fixture.configPath)).rejects.toThrow('config keys')
  })

  test('rejects symlinked config and secret files', async () => {
    const fixture = await createFixture()
    const configLink = join(fixture.root, 'config-link.json')
    await symlink(fixture.configPath, configLink)
    expect(loadHostedControlRuntimeConfig(configLink)).rejects.toThrow()

    const secretLink = join(fixture.root, 'secret-link')
    await symlink(fixture.secretFile, secretLink)
    await writeFile(fixture.configPath, JSON.stringify({
      ...fixture.value,
      secretFile: secretLink,
    }), { mode: 0o600 })
    expect(loadHostedControlRuntimeConfig(fixture.configPath)).rejects.toThrow()
  })

  test('accepts only a canonical absolute socket path within the Unix-domain byte limit', async () => {
    const fixture = await createFixture()
    for (const socketPath of [
      'relative/control.sock',
      `${fixture.root}//control.sock`,
      `${fixture.root}/segment/../control.sock`,
      `${fixture.root}/control\0.sock`,
      `/${'a'.repeat(103)}`,
    ]) {
      await writeFile(fixture.configPath, JSON.stringify({ ...fixture.value, socketPath }), { mode: 0o600 })
      await expect(loadHostedControlRuntimeConfig(fixture.configPath)).rejects.toThrow('socketPath')
    }

    await writeFile(fixture.configPath, JSON.stringify({ ...fixture.value, socketPath: join(fixture.root, 'control.sock') }), { mode: 0o600 })
    await expect(loadHostedControlRuntimeConfig(fixture.configPath)).resolves.toMatchObject({ socketPath: join(fixture.root, 'control.sock') })
  })
})

async function createFixture(): Promise<{
  root: string
  configPath: string
  secretFile: string
  value: Record<string, unknown>
}> {
  const root = await realpath(await mkdtemp('/tmp/hosted-config-'))
  roots.push(root)
  const configPath = join(root, 'config.json')
  const secretFile = join(root, 'owner.key')
  await mkdir(join(root, 'claude'), { mode: 0o700 })
  await writeFile(secretFile, Buffer.alloc(32, 1).toString('hex'), { mode: 0o600 })
  const value = {
    socketPath: join(root, 'control.sock'),
    secretFile,
    claudeRoot: join(root, 'claude'),
    deploymentId: 'deployment_test',
    bootId: 'boot_test',
    restoreGeneration: 0,
    workspaceId: 'workspace_test',
    teamId: `team_${'a'.repeat(32)}`,
    legacyKey: 'legacy',
    mountGeneration: 1,
    declaredRootHash: 'd'.repeat(64),
    ownerAuthority: 'owner-authority_config-test',
    ownerGeneration: 1,
    ownerSessionId: 'owner-session_config-test',
  }
  await writeFile(configPath, JSON.stringify(value), { mode: 0o600 })
  return { root, configPath, secretFile, value }
}
