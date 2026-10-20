import { afterEach, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotOpenCodeGatewayCredential } from './OpenCodeGatewayCredentialSnapshot.js'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-gateway-credential-'))
  roots.push(root)
  const home = await realpath(root)
  const teamName = 'TEST-team', memberName = 'builder', gatewayUsageRef = 'TEST-usage'
  const providerId = 'gateway-test-builder-' + digest([teamName, memberName, gatewayUsageRef]).slice(0, 12)
  const configPath = join(home, '.config', 'opencode', 'opencode.json')
  const scope = createHash('sha256').update(configPath).digest('hex').slice(0, 16)
  const directory = join(home, '.config', 'opencode', 'agent-teams-credentials')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const keyPath = join(directory, `${providerId}-${scope}-${randomUUID()}.key`)
  const apiKey = 'TEST-private-gateway-key'
  await writeFile(keyPath, apiKey, { mode: 0o600 })
  const provider = { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.test/v1', apiKey: `{file:${keyPath}}` }, models: { model: {} } }
  const config = { provider: { [providerId]: provider } }
  const markerPath = join(directory, `${providerId}-${scope}.owner.json`)
  const owner = { schemaVersion: 1, owner: 'agent-teams-gateway', teamName, memberName, gatewayUsageRef, providerId, configPath,
    credentialReference: provider.options.apiKey, providerDigest: digest(provider), inputDigest: digest([provider.options.baseURL, apiKey]) }
  await writeFile(markerPath, JSON.stringify(owner), { mode: 0o600 })
  return { home, config, provider, providerId, keyPath, markerPath, owner, apiKey }
}

test('captures only the selected owned key so a later file change cannot rotate the host credentials', async () => {
  const f = await fixture()
  await snapshotOpenCodeGatewayCredential(f.config, f.providerId, { HOME: f.home })
  expect(f.provider.options.apiKey).toBe(f.apiKey)
  await writeFile(f.keyPath, 'changed-test-key')
  expect(f.provider.options.apiKey).toBe(f.apiKey)
  expect(JSON.parse(await readFile(f.markerPath, 'utf8'))).toEqual(f.owner)
})

test('fails closed on edited credentials, edited provider config, or missing ownership without disclosing secrets', async () => {
  for (const change of ['key', 'provider', 'owner']) {
    const f = await fixture()
    if (change === 'key') await writeFile(f.keyPath, 'edited-TEST-secret')
    if (change === 'provider') f.provider.options.baseURL = 'https://edited.test/v1'
    if (change === 'owner') await unlink(f.markerPath)
    await expect(snapshotOpenCodeGatewayCredential(f.config, f.providerId, { HOME: f.home }))
      .rejects.toThrow('OpenCode gateway credential ownership or contents changed')
    expect(f.provider.options.apiKey.startsWith('{file:')).toBe(true)
  }
})

test('rejects a symlink credential and leaves the target untouched', async () => {
  const f = await fixture()
  const target = f.keyPath + '.target'
  await writeFile(target, f.apiKey, { mode: 0o600 })
  await unlink(f.keyPath)
  await symlink(target, f.keyPath)
  await expect(snapshotOpenCodeGatewayCredential(f.config, f.providerId, { HOME: f.home })).rejects.toThrow(/ownership/)
  expect(await readFile(target, 'utf8')).toBe(f.apiKey)
})

test.skipIf(process.platform === 'win32')('rejects non-private credentials', async () => {
  const f = await fixture()
  await chmod(f.keyPath, 0o644)
  await expect(snapshotOpenCodeGatewayCredential(f.config, f.providerId, { HOME: f.home })).rejects.toThrow(/ownership/)
})

test('leaves unrelated provider file references to the existing strict authority rejection', async () => {
  const config = { provider: { custom: { options: { apiKey: '{file:/unrelated-private-file}' } } } }
  await snapshotOpenCodeGatewayCredential(config, 'custom', {})
  expect(config.provider.custom.options.apiKey).toBe('{file:/unrelated-private-file}')
})
