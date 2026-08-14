import { afterEach, describe, expect, mock, test } from 'bun:test'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostedControlBootstrapAdmission } from '../../../src/services/hostedControl/HostedControlBootstrap.js'
import type { ActualOwnerAcceptanceConfig } from './contracts.js'
import { ACTUAL_OWNER_MARKER_FILE, ACTUAL_OWNER_PURPOSE, parseRuntimeManifest } from './contracts.js'
import { validateBootstrapAcceptance } from './bootstrap.js'

let capturedSession: unknown = null
let capturedEffect: unknown = null

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
mock.module('proper-lockfile', () => ({
  lock: async () => async () => undefined,
  lockSync: () => () => undefined,
  unlock: async () => undefined,
  check: async () => false,
}))
mock.module('lodash-es/sumBy.js', () => ({ default: <T>(values: T[], iteratee: (value: T) => number) =>
  values.reduce((sum, value) => sum + iteratee(value), 0) }))
mock.module('lru-cache', () => ({ LRUCache: class<K, V> extends Map<K, V> {
  constructor(_options: unknown) { super() }
  peek(key: K) { return this.get(key) }
} }))
mock.module('../../../src/services/opencode/OpenCodeSessionStore.js', () => ({
  openCodeSessionStore: {
    get: async () => capturedSession,
    prepareEffectToken: async () => ({ consume: () => true }),
  },
}))
mock.module('../../../src/services/opencode/OpenCodeSessionBridge.js', () => ({
  OpenCodePermissionEffectNotAuthorizedError: class extends Error {},
  OpenCodePermissionEffectUnavailableError: class extends Error {},
  openCodeSessionBridge: {
    observeHostedApprovalPermissions: async (_record: unknown, authorize?: (effect: unknown) => Promise<boolean>) => {
      if (!capturedEffect) throw new Error('provider_effect_missing')
      if (authorize && !(await authorize(capturedEffect))) throw new Error('provider_effect_not_authorized')
      return []
    },
    answerPermission: async () => undefined,
  },
}))

const ownerModule = () => import('./owner.js')

const roots: string[] = []
const execFileAsync = promisify(execFile)
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
    runtimeManifestIdentity: {
      device: rootStat.dev.toString(), inode: rootStat.ino.toString(), size: '2',
      mtimeNs: '1', ctimeNs: '1', mode: '384', nlink: '1', uid: rootStat.uid.toString(),
    },
    runtimeManifestSha256: 'f'.repeat(64),
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

async function privateRepository(root: string, name: string): Promise<{ root: string; head: string }> {
  const path = join(root, name)
  await mkdir(path, { mode: 0o700 })
  const options = { cwd: path, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } }
  await execFileAsync('/usr/bin/git', ['init', '--quiet'], options)
  await writeFile(join(path, 'source.txt'), `${name}\n`, { mode: 0o600 })
  await execFileAsync('/usr/bin/git', ['add', '--', 'source.txt'], options)
  await execFileAsync('/usr/bin/git', [
    '-c', 'user.name=Acceptance Test', '-c', 'user.email=acceptance@example.invalid',
    'commit', '--quiet', '-m', 'test fixture',
  ], options)
  const head = (await execFileAsync('/usr/bin/git', ['rev-parse', 'HEAD'], options)).stdout.trim()
  return { root: path, head }
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

  test('real provider capture follows proc exe while preserving exact executable identity', async () => {
    const root = await mkdtemp('/tmp/actual-owner-provider-')
    roots.push(root)
    const executable = join(root, 'provider')
    await copyFile('/bin/sleep', executable); await chmod(executable, 0o500)
    const descriptor = await stat(executable, { bigint: true })
    const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
    const child = spawn(executable, ['30'], { stdio: 'ignore' })
    try {
      const { proveExecutingProviderIdentity } = await ownerModule()
      const proof = await proveExecutingProviderIdentity({
        pid: child.pid!, executable, device: descriptor.dev.toString(),
        inode: descriptor.ino.toString(), sha256,
      })
      expect(proof.executable).toBe(executable)
      expect(proof.processStartIdentity).toMatch(/^[1-9]\d*$/)
    } finally {
      child.kill('SIGKILL')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })

  test('starts the real owner composition after marker admission and captures a live provider process', async () => {
    const root = await mkdtemp(`/tmp/actual-owner-${'f'.repeat(48)}-`)
    roots.push(root); await chmod(root, 0o700)
    const [orchestrator, product] = await Promise.all([
      privateRepository(root, 'orchestrator'), privateRepository(root, 'product'),
    ])
    const executable = join(root, 'opencode')
    await copyFile('/bin/sleep', executable); await chmod(executable, 0o500)
    const executableBytes = await readFile(executable)
    const executableSha256 = createHash('sha256').update(executableBytes).digest('hex')
    const provider = spawn(executable, ['30'], { stdio: 'ignore' })
    const runId = 'f'.repeat(48)
    let acceptance: { start(): Promise<void>; stop(): Promise<void> } | null = null
    try {
      const rootStat = await lstat(root, { bigint: true })
      const markerPath = join(root, ACTUAL_OWNER_MARKER_FILE)
      await writeFile(markerPath, JSON.stringify({
        schemaVersion: 1, purpose: ACTUAL_OWNER_PURPOSE, runId,
        rootBasename: root.split('/').at(-1), rootDevice: rootStat.dev.toString(),
        rootInode: rootStat.ino.toString(),
      }), { mode: 0o600 })
      const describe = async (token: string, path: string) => {
        const value = await lstat(path, { bigint: true })
        return { token, path, device: value.dev.toString(), inode: value.ino.toString(),
          mode: (value.mode & 0o777n).toString(), uid: value.uid.toString() }
      }
      const executableStat = await lstat(executable, { bigint: true })
      const runtimeManifestPath = join(root, 'runtime.json')
      const capturePath = join(root, 'capture', 'owner-wal.ndjson')
      await mkdir(join(root, 'capture'), { mode: 0o700 })
      const runtimeSource = {
        schemaVersion: 1, purpose: ACTUAL_OWNER_PURPOSE, runId,
        sandboxRoot: '${SANDBOX_ROOT}', markerPath: '${SANDBOX_ROOT}/.agent-teams-actual-owner-e2e-owner.json',
        evidenceRoot: join(root, 'evidence'), driverBaseUrl: 'http://127.0.0.1:49152/',
        productBaseUrl: 'http://127.0.0.1:49153/', approvalPath: '/hosted/approvals', browser: {},
        descriptors: {
          sandboxRoot: await describe('${SANDBOX_ROOT}', root),
          productRoot: await describe('${PRODUCT_ROOT}', product.root),
          orchestratorRoot: await describe('${ORCHESTRATOR_ROOT}', orchestrator.root),
          openCodeExecutable: { ...await describe('${OPENCODE_EXECUTABLE}', executable),
            size: executableStat.size.toString(), sha256: executableSha256 },
        },
        capture: {
          conditionalPostLedgerPath: join(root, 'capture', 'posts.ndjson'),
          negativeResultsPath: join(root, 'capture', 'negative.json'),
          openCodeTimelinePath: join(root, 'capture', 'opencode.ndjson'),
          ownerWalTimelinePath: '${SANDBOX_ROOT}/capture/owner-wal.ndjson',
          productTimelinePath: join(root, 'capture', 'product.ndjson'),
          protectedEffectLedgerPath: join(root, 'capture', 'effects.json'),
        },
        refs: { openCode: 'a'.repeat(40), openCodeExecutableSha256: executableSha256,
          orchestrator: orchestrator.head, product: product.head },
      }
      const runtimeBytes = Buffer.from(JSON.stringify(runtimeSource))
      await writeFile(runtimeManifestPath, runtimeBytes, { mode: 0o600 })
      const runtimeManifestStat = await lstat(runtimeManifestPath, { bigint: true })
      const runtime = parseRuntimeManifest(runtimeSource)
      const claudeRoot = join(root, 'claude')
      const teamRoot = join(claudeRoot, 'teams', 'team-key')
      await mkdir(teamRoot, { recursive: true, mode: 0o700 })
      await chmod(claudeRoot, 0o700); await chmod(join(claudeRoot, 'teams'), 0o700)
      const teamId = `team_${'1'.repeat(32)}`
      const session = {
        teamId, laneId: 'secondary:opencode:worker', runId: `run_${'2'.repeat(32)}`,
        memberName: 'worker', providerId: 'opencode', toolApprovalMode: 'manual',
        opencodeSessionId: 'session_1', staleReason: null,
        hostKey: `${root}/project::profile::behavior::config`, projectPath: join(root, 'project'),
        profileRootKey: 'profile', projectBehaviorFingerprint: 'behavior',
        managedConfigFingerprint: 'config', sourceAuthFingerprint: 'source-auth',
        managedAuthFingerprint: 'managed-auth', runtimePid: provider.pid!,
        openCodeArtifactDigest: `sha256:${executableSha256}` as const,
        createdAt: '2026-08-14T00:00:00.000Z',
      }
      const effect = {
        record: session,
        profile: {
          projectPath: session.projectPath, profileRootKey: session.profileRootKey,
          profileRootPath: join(root, 'profile'),
          projectBehaviorFingerprint: session.projectBehaviorFingerprint,
          behaviorSources: [], managedConfig: {},
          managedConfigFingerprint: session.managedConfigFingerprint,
          homePath: join(root, 'profile', 'home'), tmpPath: join(root, 'tmp'),
          xdgConfigHome: join(root, 'profile', 'config'), xdgDataHome: join(root, 'profile', 'data'),
          xdgCacheHome: join(root, 'profile', 'cache'), managedAuthPath: join(root, 'profile', 'auth.json'),
          sourceAuthPath: join(root, 'source-auth.json'), sourceAuthFingerprint: session.sourceAuthFingerprint,
          managedAuthFingerprint: session.managedAuthFingerprint, authState: 'ok', env: {},
        },
        host: {
          hostKey: session.hostKey, profileRootKey: session.profileRootKey,
          projectPath: session.projectPath,
          projectBehaviorFingerprint: session.projectBehaviorFingerprint,
          openCodeArtifactDigest: session.openCodeArtifactDigest, pid: provider.pid!,
          processStartedAtMs: 1, resolvedConfigFingerprint: 'resolved',
        },
      }
      const adapter = await import('../../../src/services/hostedControl/OpenCodeHostedApprovalRuntimeAdapter.js')
      const route = {
        routeId: 'route_1', memberName: 'worker',
        authority: {
          deploymentId: 'deployment-test', teamId, runId: session.runId, planGeneration: 2,
          laneId: session.laneId, providerId: 'opencode', credentialGeneration: 3,
          credentialId: 'credential_1', sessionId: session.opencodeSessionId,
          runtimeInstanceId: 'runtime_1', deliveryOwnerId: `member_${'4'.repeat(32)}`,
        },
        scope: { principalId: 'actor_owner', workspaceId: 'workspace-test', teamId,
          authorityGeneration: 'generation_1', restoreGeneration: 1 },
        openCodeBinding: {
          toolApprovalMode: 'manual', planGeneration: 2, credentialGeneration: 3,
          credentialId: 'credential_1', runtimeInstanceId: 'runtime_1',
          deliveryOwnerId: `member_${'4'.repeat(32)}`,
          openCodeArtifactDigest: session.openCodeArtifactDigest,
          sessionRecordFingerprint: adapter.fingerprintOpenCodeApprovalSessionRecord(session as never),
          liveEffectFingerprint: adapter.liveEffectFingerprint(effect as never),
        },
      }
      const admissionFile = join(teamRoot, 'hosted-approval-runtime-admission.v1.json')
      await writeFile(admissionFile, JSON.stringify({
        schemaVersion: 1, admissionGeneration: 'approval-admission-generation_1',
        outerAuthority: {
          deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
          teamId, restoreGeneration: 1,
          mountBinding: { mountGeneration: 1, declaredRootHash: '2'.repeat(64) },
        },
        routes: [route], actorMembers: { actor_owner: `member_${'4'.repeat(32)}` },
      }), { mode: 0o600 })
      capturedSession = session; capturedEffect = effect
      const config = {
        admissionFile, controlSocket: join(root, 'acceptance.sock'),
        evidenceFile: join(root, 'evidence.json'), markerPath, openCodeExecutable: executable,
        openCodeSha256: executableSha256, productRoot: product.root,
        productPublicationTimeoutMs: 1_000, repositoryRoot: orchestrator.root,
        runtimeManifestPath,
        runtimeManifestIdentity: {
          device: runtimeManifestStat.dev.toString(), inode: runtimeManifestStat.ino.toString(),
          size: runtimeManifestStat.size.toString(), mtimeNs: runtimeManifestStat.mtimeNs.toString(),
          ctimeNs: runtimeManifestStat.ctimeNs.toString(),
          mode: (runtimeManifestStat.mode & 0o777n).toString(),
          nlink: runtimeManifestStat.nlink.toString(), uid: runtimeManifestStat.uid.toString(),
        },
        runtimeManifestSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
        runtime, sandboxRoot: root, walFile: join(teamRoot, 'hosted-approval-owner.v1.json'),
      } satisfies ActualOwnerAcceptanceConfig
      const bootstrapSecret = Buffer.alloc(32)
      const bootstrap = {
        config: {
          socketPath: join(root, 'owner.sock'), claudeRoot,
          deploymentId: 'deployment-test', bootId: 'boot-test', restoreGeneration: 1,
          workspaceId: 'workspace-test', teamId, legacyKey: 'team-key', mountGeneration: 1,
          declaredRootHash: '2'.repeat(64), ownerAuthority: 'owner-authority_acceptance-test',
          ownerGeneration: 1, ownerSessionId: 'owner-session_acceptance-test',
        },
        bootstrapBinding: {
          deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
          mountGeneration: 1, bootstrapDigest: '3'.repeat(64),
          ownerArtifactDigest: `sha256:${'4'.repeat(64)}`,
          proofKeyId: createHash('sha256').update(bootstrapSecret).digest('hex'),
        },
        secret: bootstrapSecret,
        guard: { lost: new Promise<void>(() => undefined), assertCurrent: async () => true,
          close: async () => undefined },
      } satisfies HostedControlBootstrapAdmission
      const { AcceptanceRuntime } = await ownerModule()
      acceptance = new AcceptanceRuntime(config, bootstrap)
      await acceptance.start()
      const evidence = JSON.parse(await readFile(config.evidenceFile, 'utf8'))
      expect(evidence.status).toBe('ready')
      expect(evidence.providers).toMatchObject([{
        routeId: 'route_1', pid: provider.pid, executable, executableSha256,
      }])
      expect(evidence.timeline.path).toBe(capturePath)
      await acceptance.stop()
    } finally {
      capturedSession = null; capturedEffect = null
      await acceptance?.stop().catch(() => undefined)
      provider.kill('SIGKILL')
      await new Promise(resolve => provider.once('exit', resolve))
    }
  }, 20_000)

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

  test('does not publish failure evidence for raw but invalid admission bytes', async () => {
    const { config, admission } = await fixture()
    const { AcceptanceRuntime } = await ownerModule()
    const runtime = new AcceptanceRuntime(config, admission)
    await (runtime as unknown as { waitForProductPublication(): Promise<void> }).waitForProductPublication()
    await runtime.writeFailure('hosted_actual_owner_admission_invalid')
    expect(await Bun.file(config.evidenceFile).exists()).toBe(false)
    await runtime.stop()
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
    await (runtime as unknown as { waitForProductPublication(): Promise<void> }).waitForProductPublication()
    await (runtime as unknown as { startControl(): Promise<void> }).startControl()
    await runtime.stop()
    expect((await lstat(config.controlSocket)).isSocket()).toBe(true)
    await new Promise<void>(resolve => substitute!.close(() => resolve()))
  })
})
