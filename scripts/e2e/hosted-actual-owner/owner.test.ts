import { afterEach, describe, expect, mock, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_MARKER_FILE, ACTUAL_OWNER_PURPOSE } from './contracts.js'
import { validateBootstrapAcceptance } from './bootstrap.js'

mock.module('env-paths', () => ({
  default: () => ({ data: '/tmp', config: '/tmp', cache: '/tmp', log: '/tmp', temp: '/tmp' }),
}))
mock.module('lodash-es/cloneDeep.js', () => ({ default: <T>(value: T): T => structuredClone(value) }))
mock.module('lodash-es/memoize.js', () => ({ default: <T extends (...args: never[]) => unknown>(fn: T): T => fn }))
mock.module('jsonc-parser/lib/esm/main.js', () => ({
  parse: JSON.parse, modify: () => [], applyEdits: (value: string) => value,
}))
mock.module('@anthropic-ai/sdk', () => ({ APIUserAbortError: class APIUserAbortError extends Error {} }))
mock.module('strip-ansi', () => ({ default: (value: string) => value }))
mock.module('lodash-es/sumBy.js', () => ({ default: <T>(values: T[], iteratee: (value: T) => number) =>
  values.reduce((sum, value) => sum + iteratee(value), 0) }))
mock.module('lru-cache', () => ({ LRUCache: class<K, V> extends Map<K, V> {
  constructor(_options: unknown) { super() }
  peek(key: K) { return this.get(key) }
} }))

const ownerModule = () => import('./owner.js')

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
      socketPath: join(root, 'owner.sock'), claudeRoot,
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

  test('uses the real descriptor-bootstrap config shape and an explicit nonconflicting fd map', async () => {
    const { parseAcceptanceInvocation } = await ownerModule()
    const { admission } = await fixture()
    const realFixture: HostedControlBootstrapAdmission = admission
    expect('secretFile' in realFixture.config).toBe(false)
    expect(parseAcceptanceInvocation([
      '--runtime-manifest', '/tmp/manifest', '--launcher-lease-fd', '6',
      '--liveness-fd', '7', '--bootstrap-fd', '8',
    ]).bootstrapFds).toEqual({ launcherLeaseFd: 6, livenessFd: 7, bootstrapFd: 8 })
    expect(() => parseAcceptanceInvocation([
      '--runtime-manifest', '/tmp/manifest', '--launcher-lease-fd', '3',
      '--liveness-fd', '4', '--bootstrap-fd', '5',
    ])).toThrow(/fd_map_invalid/)
  })

  test('invokes the source launcher through a proc fd without using proc as its source root', async () => {
    const root = await mkdtemp('/tmp/actual-owner-launcher-')
    roots.push(root)
    const bunInstall = join(root, 'bun-install')
    await mkdir(join(bunInstall, 'bin'), { recursive: true })
    await writeFile(join(bunInstall, 'bin', 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 })
    const launcherPath = join(process.cwd(), 'scripts/e2e/hosted-actual-owner/cli-source')
    const entryPath = join(process.cwd(), 'scripts/e2e/hosted-actual-owner/owner.ts')
    const launcher = await open(launcherPath, 'r')
    try {
      const child = spawn('/proc/self/fd/3', [
        '--hosted-actual-owner-acceptance-entry', entryPath,
        '--runtime-manifest', join(root, 'manifest.json'),
        '--launcher-lease-fd', '6', '--liveness-fd', '7', '--bootstrap-fd', '8',
      ], {
        cwd: process.cwd(), env: { PATH: '/usr/local/bin:/usr/bin:/bin', BUN_INSTALL: bunInstall },
        stdio: ['ignore', 'pipe', 'pipe', launcher.fd],
      })
      const stdout = await new Response(child.stdout!).text()
      const stderr = await new Response(child.stderr!).text()
      const exit = await new Promise<number | null>(resolve => child.once('exit', resolve))
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout.trim().split('\n')).toEqual([
        'run', entryPath, '--runtime-manifest', join(root, 'manifest.json'),
        '--launcher-lease-fd', '6', '--liveness-fd', '7', '--bootstrap-fd', '8',
      ])
    } finally { await launcher.close() }
  })

  test('import is inert and direct-entry matching is exact', () => {
    return ownerModule().then(({ isDirectAcceptanceEntry }) => {
    expect(isDirectAcceptanceEntry(['bun', '/tmp/not-owner.ts'])).toBe(false)
    expect(isDirectAcceptanceEntry(['bun', new URL('./owner.ts', import.meta.url).pathname])).toBe(true)
    })
  })

  test('rejects a missing marker before evidence, socket, lease, or WAL effects', async () => {
    const { config, admission } = await fixture()
    const { AcceptanceRuntime } = await ownerModule()
    await unlink(config.markerPath)
    const runtime = new AcceptanceRuntime(config, admission)
    await expect(runtime.start()).rejects.toThrow()
    expect(await Bun.file(config.evidenceFile).exists()).toBe(false)
    expect(await Bun.file(config.controlSocket).exists()).toBe(false)
    expect(await Bun.file(config.walFile).exists()).toBe(false)
  })

  test('tombstones the owned socket before close and preserves a synchronized substitute', async () => {
    const { config, admission } = await fixture()
    const { AcceptanceRuntime } = await ownerModule()
    let substitute: Server | null = null
    const runtime = new AcceptanceRuntime(config, admission, {
      afterControlTombstone: async () => {
        substitute = createServer()
        await new Promise<void>((resolve, reject) => {
          substitute!.once('error', reject); substitute!.listen(config.controlSocket, resolve)
        })
        await chmod(config.controlSocket, 0o600)
      },
    })
    await (runtime as unknown as { startControl(): Promise<void> }).startControl()
    await runtime.stop()
    expect((await lstat(config.controlSocket)).isSocket()).toBe(true)
    await new Promise<void>(resolve => substitute!.close(() => resolve()))
  })
})
