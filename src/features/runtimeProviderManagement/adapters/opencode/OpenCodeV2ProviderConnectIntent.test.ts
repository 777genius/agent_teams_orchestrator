import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { prepareOpenCodeV2ConnectVerification, readOpenCodeV2ConnectIntent,
  readRetiredOpenCodeV2CatalogProfile, writeOpenCodeV2ConnectIntent } from './OpenCodeV2ProviderConnectIntent.js'

const input = () => ({ saved: { state: 'pending', providerId: 'kimi-code-plan-global', project: '/TEST/project',
  profileRoot: '/TEST/profile', integrationID: 'kimi-code-plan-global' } as Record<string, unknown>,
  providerId: 'kimi-code-plan-global', project: '/TEST/project', integrationID: 'kimi-code-plan-global',
  mirrorIdentity: 'a'.repeat(64), native: { path: '/TEST/opencode', sha256: 'b'.repeat(64), version: '2.1.4' },
  selectedModel: 'kimi-code-plan-global/kimi-for-coding', readOriginalCredential: async () => 'cred_original',
  proveLegacyPreEffect: async () => {} })

test('proven original pending Connect resumes verification without a connect or remove port', async () => {
  const request = input(); let reads = 0, proofs = 0
  request.readOriginalCredential = async () => { reads++; return 'cred_original' }
  request.proveLegacyPreEffect = async () => { proofs++ }
  const intent = await prepareOpenCodeV2ConnectVerification(request)
  expect(reads).toBe(1); expect(proofs).toBe(1)
  expect(intent).toMatchObject({ state: 'pending', phase: 'verification-prepared', credentialID: 'cred_original',
    profileRoot: '/TEST/profile', mirrorIdentity: request.mirrorIdentity,
    verification: { modelId: request.selectedModel, native: request.native } })
})

test('a saved verification retains its exact original model and probe rather than picking a replacement', async () => {
  const request = input(), prepared = await prepareOpenCodeV2ConnectVerification(request)
  const probe = { sourceKey: 'c'.repeat(64), binding: { teamId: 'TEST-probe', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' },
    sessionID: 'ses_TEST', intentHash: 'd'.repeat(64) }
  request.saved = { ...prepared, phase: 'probe-owned', verification: { ...prepared.verification!, sourceKey: probe.sourceKey, probe } }
  request.selectedModel = 'kimi-code-plan-global/another-model'
  const resumed = await prepareOpenCodeV2ConnectVerification(request)
  expect(resumed.verification?.modelId).toBe(prepared.verification?.modelId)
  expect(resumed.verification?.probe).toEqual(probe)
})

test('ambiguous pre-effect, credential, mirror, native and project changes fail closed', async () => {
  for (const change of ['effect', 'credential', 'mirror', 'native', 'project', 'format', 'legacy-shape'] as const) {
    const request = input(), prepared = await prepareOpenCodeV2ConnectVerification(request)
    request.saved = prepared
    if (change === 'effect') { request.saved = input().saved; request.proveLegacyPreEffect = async () => { throw Error('provider_original_execution_unknown') } }
    if (change === 'credential') request.readOriginalCredential = async () => 'cred_peer'
    if (change === 'mirror') request.mirrorIdentity = 'e'.repeat(64)
    if (change === 'native') request.native = { ...request.native, sha256: 'f'.repeat(64) }
    if (change === 'project') request.project = '/TEST/other-project'
    if (change === 'format') request.saved = { ...prepared, schemaVersion: 3 }
    if (change === 'legacy-shape') request.saved = { ...input().saved, unrecognizedPhase: true }
    await expect(prepareOpenCodeV2ConnectVerification(request)).rejects.toThrow()
  }
})

test('marker publication preserves pending identities, rejects replacement creation and never treats an unreadable marker as absent', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-connect-intent-')))
  const file = path.join(root, 'intent.json'), original = input().saved
  try {
    expect(await readOpenCodeV2ConnectIntent(file)).toBeUndefined()
    await writeOpenCodeV2ConnectIntent(file, original, true)
    await expect(writeOpenCodeV2ConnectIntent(file, { wrong: true }, true)).rejects.toThrow()
    expect(await readOpenCodeV2ConnectIntent(file)).toEqual(original)
    const prepared = await prepareOpenCodeV2ConnectVerification(input())
    await writeOpenCodeV2ConnectIntent(file, prepared)
    expect(await readOpenCodeV2ConnectIntent(file)).toEqual(prepared)
    await writeFile(file, 'incomplete JSON')
    await expect(readOpenCodeV2ConnectIntent(file)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('more than 32 retired readback leases remain recoverable while active or unretired ownership is refused', async () => {
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-retired-catalog-')))
  const root = path.join(dataRoot, 'opencode/v2/provider-profiles/catalog-TESToriginal')
  const lease = '11111111-1111-4111-8111-111111111111', graph = 'a'.repeat(64)
  const released = path.join(root, `.opencode-v2-execution-owner.released.${lease}`)
  const directory = path.join(root, 'config/opencode'), databasePath = path.join(root, 'data/opencode/opencode.db')
  const birth = { format: 'utc-ms', value: '12345', bootId: null }, pid = 12345
  const save = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 })
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    await mkdir(released, { mode: 0o700 })
    await save(path.join(released, 'owner.json'), { profileRoot: root, databasePath, graphSha256: graph, leaseOwnerId: lease })
    await save(path.join(released, 'child.json'), { pid, birth })
    const release = { state: 'retired', receipt: { pid, birth, scopeClosed: true, processRetired: true, descendantsRetired: true } }
    await save(path.join(released, 'release.json'), release)
    await save(path.join(directory, 'opencode.json'), { providers: { 'kimi-code-plan-global': {} }, plugins: [] })
    for (let index = 2; index <= 33; index++) {
      const leaseOwnerId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
      const archive = path.join(root, `.opencode-v2-execution-owner.released.${leaseOwnerId}`)
      await mkdir(archive, { mode: 0o700 })
      await save(path.join(archive, 'owner.json'), { profileRoot: root, databasePath, graphSha256: graph, leaseOwnerId })
      await save(path.join(archive, 'child.json'), { pid, birth })
      await save(path.join(archive, 'release.json'), release)
    }
    expect((await readRetiredOpenCodeV2CatalogProfile(dataRoot, root, 'kimi-code-plan-global', graph)).databasePath).toBe(databasePath)
    await mkdir(path.join(root, '.opencode-v2-execution-owner'), { mode: 0o700 })
    await expect(readRetiredOpenCodeV2CatalogProfile(dataRoot, root, 'kimi-code-plan-global', graph)).rejects.toThrow('provider_original_owner_unknown')
    await rm(path.join(root, '.opencode-v2-execution-owner'), { recursive: true })
    for (const archive of await readdir(root)) {
      if (archive.startsWith('.opencode-v2-execution-owner.released.'))
        await save(path.join(root, archive, 'release.json'), { ...release, receipt: { ...release.receipt, scopeClosed: false } })
    }
    await expect(readRetiredOpenCodeV2CatalogProfile(dataRoot, root, 'kimi-code-plan-global', graph)).rejects.toThrow('provider_original_owner_unknown')
  } finally { await rm(dataRoot, { recursive: true, force: true }) }
})
