import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_MARKER_FILE, ACTUAL_OWNER_PURPOSE } from './contracts.js'
import { validateBootstrapAcceptance } from './bootstrap.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(`/tmp/actual-owner-${'a'.repeat(48)}-`)
  roots.push(root)
  await chmod(root, 0o700)
  const rootStat = await lstat(root, { bigint: true })
  const markerPath = join(root, ACTUAL_OWNER_MARKER_FILE)
  await writeFile(markerPath, JSON.stringify({
    schemaVersion: 1, purpose: ACTUAL_OWNER_PURPOSE, runId: 'a'.repeat(48),
    rootBasename: root.split('/').at(-1), rootDevice: rootStat.dev.toString(),
    rootInode: rootStat.ino.toString(),
  }), { mode: 0o600 })
  const claudeRoot = join(root, 'claude')
  const teamRoot = join(claudeRoot, 'teams', 'team-key')
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  await chmod(claudeRoot, 0o700)
  await chmod(join(claudeRoot, 'teams'), 0o700)
  const admissionFile = join(teamRoot, 'hosted-approval-runtime-admission.v1.json')
  await writeFile(admissionFile, '{}', { mode: 0o600 })
  const secretFile = join(root, 'hosted-control.secret')
  await writeFile(secretFile, 'secret', { mode: 0o600 })
  const config = {
    admissionFile, controlSocket: join(root, 'acceptance.sock'), evidenceFile: join(root, 'evidence.json'),
    markerPath, openCodeExecutable: '/opt/opencode', openCodeSha256: 'b'.repeat(64),
    productRoot: '/opt/product', productPublicationTimeoutMs: 1_000,
    repositoryRoot: '/repo', runtimeManifestPath: join(root, 'runtime.json'), sandboxRoot: root,
    walFile: join(teamRoot, 'hosted-approval-owner.v1.json'),
    runtime: {
      schemaVersion: 1 as const, purpose: ACTUAL_OWNER_PURPOSE, runId: 'a'.repeat(48), sandboxRoot: root,
      markerPath, capture: { ownerWalTimelinePath: join(root, 'owner.ndjson') },
      descriptors: {
        sandboxRoot: { token: '${SANDBOX_ROOT}', path: root, device: rootStat.dev.toString(), inode: rootStat.ino.toString(), mode: '448', uid: rootStat.uid.toString() },
        productRoot: { token: '${PRODUCT_ROOT}', path: '/opt/product', device: '1', inode: '2', mode: '493', uid: rootStat.uid.toString() },
        orchestratorRoot: { token: '${ORCHESTRATOR_ROOT}', path: '/repo', device: '1', inode: '3', mode: '493', uid: rootStat.uid.toString() },
        openCodeExecutable: { token: '${OPENCODE_EXECUTABLE}', path: '/opt/opencode', device: '1', inode: '4', mode: '493', uid: rootStat.uid.toString(), size: '42', sha256: 'b'.repeat(64) },
      },
      refs: { openCode: 'c'.repeat(40), openCodeExecutableSha256: 'b'.repeat(64),
        orchestrator: 'd'.repeat(40), product: 'e'.repeat(40) },
    },
  } satisfies ActualOwnerAcceptanceConfig
  const admission = {
    config: {
      socketPath: join(root, 'owner.sock'), secretFile, claudeRoot,
      deploymentId: 'deployment-test', bootId: 'boot-test', restoreGeneration: 1,
      workspaceId: 'workspace-test', teamId: `team_${'1'.repeat(32)}`, legacyKey: 'team-key',
      mountGeneration: 1, declaredRootHash: '2'.repeat(64),
      ownerAuthority: 'owner-authority_acceptance-test', ownerGeneration: 1,
      ownerSessionId: 'owner-session_acceptance-test',
    },
    bootstrapBinding: {
      deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
      mountGeneration: 1, bootstrapDigest: '3'.repeat(64),
      ownerArtifactDigest: `sha256:${'4'.repeat(64)}`, proofKeyId: '5'.repeat(64),
    },
    secret: Buffer.alloc(32),
    guard: { lost: new Promise<void>(() => undefined), assertCurrent: async () => true, close: async () => undefined },
  } satisfies HostedControlBootstrapAdmission
  return { root, config, admission }
}

describe('hosted actual-owner real composition preflight', () => {
  test('admits the canonical descriptor configuration and exact private admission bytes', async () => {
    const { config, admission } = await fixture()
    const validated = await validateBootstrapAcceptance(config, admission)
    expect(validated.admissionSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(validated.configSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects an out-of-sandbox descriptor path before descriptor authority is consumed', async () => {
    const { config, admission } = await fixture()
    let checked = false
    const escaped = {
      ...admission,
      config: { ...admission.config, claudeRoot: '/tmp/outside-actual-owner' },
      guard: { ...admission.guard, assertCurrent: async () => { checked = true; return true } },
    }
    await expect(validateBootstrapAcceptance(config, escaped)).rejects.toThrow(/escaped_sandbox/)
    expect(checked).toBe(false)
  })
})
