import { afterEach, describe, expect, test } from 'bun:test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, stat, unlink, writeFile, type FileHandle,
} from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { ACTUAL_OWNER_MARKER_FILE, ACTUAL_OWNER_PURPOSE } from './contracts.js'
import { getOpenCodeManagedSubscriptionPluginPackages } from '../../../src/services/opencode/OpenCodeCuratedSubscriptionCatalog.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

type ChildTermination =
  | { kind: 'error'; error: Error }
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null }

interface TrackedChild {
  child: ChildProcess
  termination: Promise<ChildTermination>
  isTerminated(): boolean
}

const children = new Map<ChildProcess, TrackedChild>()

function trackChild(child: ChildProcess): TrackedChild {
  let terminated = child.exitCode !== null || child.signalCode !== null
  const termination = new Promise<ChildTermination>(resolve => {
    let settled = false
    const settle = (value: ChildTermination) => {
      terminated = true
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('error', error => settle({ kind: 'error', error }))
    child.once('close', (code, signal) => settle({ kind: 'close', code, signal }))
    if (terminated) settle({ kind: 'close', code: child.exitCode, signal: child.signalCode })
  })
  const tracked = { child, termination, isTerminated: () => terminated }
  children.set(child, tracked)
  return tracked
}

function childFailure(tracked: TrackedChild, context: string): Promise<never> {
  return tracked.termination.then(termination => {
    if (termination.kind === 'error') throw new Error(`${context}: ${termination.error.message}`, { cause: termination.error })
    throw new Error(`${context}: child closed with code ${termination.code} and signal ${termination.signal ?? 'none'}`)
  })
}

async function terminateChild(tracked: TrackedChild): Promise<void> {
  if (!tracked.isTerminated()) tracked.child.kill('SIGKILL')
  await Promise.race([
    tracked.termination,
    Bun.sleep(5_000).then(() => { throw new Error(`child cleanup timed out for pid ${tracked.child.pid ?? 'unassigned'}`) }),
  ])
  children.delete(tracked.child)
}

class CleanupStack {
  readonly #callbacks: Array<() => Promise<void>> = []

  defer(callback: () => Promise<void>): void {
    this.#callbacks.push(callback)
  }

  async dispose(): Promise<void> {
    const failures: unknown[] = []
    for (const callback of this.#callbacks.reverse()) {
      try { await callback() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup failed')
  }
}

function idempotentClose(handle: FileHandle): () => Promise<void> {
  let closed: Promise<void> | undefined
  return () => closed ??= handle.close()
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('unsupported fixture fingerprint value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const input = value as Record<string, unknown>
  return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`
}

function fingerprintSession(record: Record<string, any>): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1, teamId: record.teamId, laneId: record.laneId ?? 'primary',
    runId: record.runId ?? null, memberName: record.memberName, providerId: record.providerId,
    opencodeSessionId: record.opencodeSessionId, projectPath: record.projectPath,
    hostKey: record.hostKey, openCodeArtifactDigest: record.openCodeArtifactDigest ?? null,
    profileRootKey: record.profileRootKey, projectBehaviorFingerprint: record.projectBehaviorFingerprint,
    managedConfigFingerprint: record.managedConfigFingerprint ?? null,
    sourceAuthFingerprint: record.sourceAuthFingerprint, managedAuthFingerprint: record.managedAuthFingerprint,
    toolApprovalMode: record.toolApprovalMode ?? null, runtimePid: record.runtimePid ?? null,
    createdAt: record.createdAt,
  })).digest('hex')
}

function fingerprintEffect(effect: Record<string, any>): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: 1, sessionRecordFingerprint: fingerprintSession(effect.record),
    hostKey: effect.host.hostKey, profileRootKey: effect.host.profileRootKey,
    projectPath: effect.host.projectPath,
    projectBehaviorFingerprint: effect.host.projectBehaviorFingerprint,
    openCodeArtifactDigest: effect.host.openCodeArtifactDigest ?? null,
    runtimePid: effect.host.pid, processStartedAtMs: effect.host.processStartedAtMs,
    resolvedConfigFingerprint: effect.host.resolvedConfigFingerprint,
    preparedProfile: { profileRootKey: effect.profile.profileRootKey,
      projectPath: effect.profile.projectPath,
      projectBehaviorFingerprint: effect.profile.projectBehaviorFingerprint,
      managedConfigFingerprint: effect.profile.managedConfigFingerprint,
      sourceAuthFingerprint: effect.profile.sourceAuthFingerprint,
      managedAuthFingerprint: effect.profile.managedAuthFingerprint },
  })).digest('hex')
}

async function linuxProcessStartTicks(pid: number): Promise<number | null> {
  const source = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  if (!source) return null
  const commandEnd = source.lastIndexOf(')')
  if (commandEnd < 0) return null
  const ticks = Number(source.slice(commandEnd + 2).trim().split(/\s+/)[19])
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
}

const contractBytes = Buffer.from(`${JSON.stringify({
  schemaVersion: 1, purpose: 'agent-teams.hosted-actual-owner-e2e.contract/v1', authority: 'product',
  orchestratorEntry: 'scripts/e2e/hosted-actual-owner-owner.ts',
  descriptorTokens: { sandboxRoot: '${SANDBOX_ROOT}', productRoot: '${PRODUCT_ROOT}',
    orchestratorRoot: '${ORCHESTRATOR_ROOT}', openCodeExecutable: '${OPENCODE_EXECUTABLE}' },
  inheritedFds: { launcherLeaseFd: 6, livenessFd: 7, bootstrapFd: 8 },
  runtimeManifest: { ownerBindingFields: ['ownerUid', 'ownerSessionId', 'ownerTokenSha256'],
    socketIdentityFields: ['driverSocket', 'productSocket'], httpCapabilityEndpointField: 'capabilityEndpoint',
    ownerWalTimelineRawPathField: 'ownerWalTimelineRawPath', captureArtifactPathFields: [
      'browserResultsPath', 'conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
      'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath'] },
  timeline: { mediaType: 'application/x-ndjson', encoding: 'utf-8', lineTerminator: '\n',
    timestamp: 'canonical UTC ISO-8601 with exactly milliseconds', digest: 'sha256 of exact raw bytes',
    byteCount: 'exact raw byte count', fileIdentityFields: ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'],
    eventFields: ['schemaVersion', 'at', 'routeId', 'sessionId', 'runId', 'generation', 'approvalId',
      'requestId', 'effectId', 'event', 'sequence'],
    approvalIdDiscriminant: 'approval events require approvalId; maintenance events require null',
    nullableCorrelationFields: ['approvalId', 'requestId', 'effectId'] },
  correlationFields: ['routeId', 'sessionId', 'runId', 'generation', 'approvalId', 'requestId', 'effectId'],
})}\n`)

afterEach(async () => {
  const failures: unknown[] = []
  await Promise.all([...children.values()].map(async child => {
    try { await terminateChild(child) } catch (error) { failures.push(error) }
  }))
  children.clear()
  for (const root of roots.splice(0)) {
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'afterEach cleanup failed')
})

const isolatedEnvironment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra,
})

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('/usr/bin/git', ['--no-replace-objects', '-C', root, ...args], {
    encoding: 'utf8', env: isolatedEnvironment(),
  })).stdout.trim()
}

interface InheritedFifo {
  reader: FileHandle
  writer: FileHandle
  closeReader(): Promise<void>
  closeWriter(): Promise<void>
  close(): Promise<void>
}

async function inheritedFifo(
  root: string,
  name: string,
  afterOpen?: (path: string, reader: FileHandle, writer: FileHandle) => Promise<void>,
): Promise<InheritedFifo> {
  const path = join(root, name)
  let pathExists = false
  let rendezvous: FileHandle | undefined
  let reader: FileHandle | undefined
  let writer: FileHandle | undefined
  let handedOff = false
  try {
    await execFileAsync('/usr/bin/mkfifo', ['--mode=600', '--', path], {
      encoding: 'utf8', env: isolatedEnvironment(),
    })
    pathExists = true
    const linked = await lstat(path, { bigint: true })
    if (!linked.isFIFO() || linked.nlink !== 1n || (linked.mode & 0o777n) !== 0o600n ||
      (process.getuid?.() !== undefined && linked.uid !== BigInt(process.getuid()))) {
      throw new Error('inherited FIFO helper produced an unsafe descriptor')
    }
    // Linux permits an O_RDWR rendezvous handle, keeping the two real FIFO ends
    // from blocking one another during setup without changing their inherited modes.
    rendezvous = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
    reader = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    writer = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
    await rendezvous.close()
    rendezvous = undefined
    await afterOpen?.(path, reader, writer)

    const [readStat, writeStat] = await Promise.all([
      reader.stat({ bigint: true }), writer.stat({ bigint: true }),
    ])
    for (const opened of [readStat, writeStat]) {
      if (!opened.isFIFO() || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.mode !== linked.mode || opened.uid !== linked.uid || opened.nlink !== linked.nlink) {
        throw new Error('inherited FIFO identity or security metadata changed while opening it')
      }
    }

    await unlink(path)
    pathExists = false
    const closeReader = idempotentClose(reader)
    const closeWriter = idempotentClose(writer)
    handedOff = true
    return {
      reader, writer, closeReader, closeWriter,
      close: async () => { await Promise.all([closeReader(), closeWriter()]) },
    }
  } finally {
    const cleanup: Promise<unknown>[] = []
    if (rendezvous) cleanup.push(rendezvous.close())
    if (!handedOff && reader) cleanup.push(reader.close())
    if (!handedOff && writer) cleanup.push(writer.close())
    if (pathExists) cleanup.push(unlink(path))
    const results = await Promise.allSettled(cleanup)
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, `failed to clean up inherited FIFO ${path}`)
  }
}

async function writeAllAndClose(handle: FileHandle, close: () => Promise<void>, bytes: Buffer): Promise<void> {
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (bytesWritten === 0) throw new Error('inherited FIFO accepted a zero-byte write')
      offset += bytesWritten
    }
  } finally {
    await close()
  }
}

async function createProductRepository(root: string): Promise<{ path: string; head: string }> {
  const path = join(root, 'product')
  await mkdir(join(path, 'scripts/e2e/hosted-actual-owner'), { recursive: true, mode: 0o700 })
  await git(path, ['init', '--quiet'])
  await writeFile(join(path, 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json'), contractBytes)
  await git(path, ['add', '--', '.'])
  await git(path, ['-c', 'user.name=Acceptance Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'test: pin product contract'])
  return { path, head: await git(path, ['rev-parse', '--verify', 'HEAD^{commit}']) }
}

async function descriptor(token: string, path: string) {
  const value = await lstat(path, { bigint: true })
  return { token, path, device: value.dev.toString(), inode: value.ino.toString(),
    mode: (value.mode & 0o777n).toString(), uid: value.uid.toString() }
}

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const port = server.port
  await server.stop(true)
  return port
}

async function waitForHttp(url: string, child: TrackedChild): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await fetch(url).then(response => response.ok, () => false)) return
    await Promise.race([Bun.sleep(25), childFailure(child, `fixture server failed before readiness at ${url}`)])
  }
  throw new Error(`fixture server did not become ready: ${url}`)
}

function jsonLine(stream: NodeJS.ReadableStream): { next(): Promise<Record<string, unknown>> } {
  let buffered = ''
  const queue: Record<string, unknown>[] = []
  const waiters: Array<{ resolve(line: Record<string, unknown>): void; reject(error: Error): void }> = []
  let streamFailure: Error | undefined
  const fail = (error: Error) => {
    streamFailure ??= error
    for (const waiter of waiters.splice(0)) waiter.reject(streamFailure)
  }
  stream.on('data', chunk => {
    buffered += chunk.toString()
    for (;;) {
      const end = buffered.indexOf('\n')
      if (end < 0) break
      let line: Record<string, unknown>
      try { line = JSON.parse(buffered.slice(0, end)) as Record<string, unknown> } catch (error) {
        fail(new Error('child emitted invalid readiness JSON', { cause: error })); return
      }
      buffered = buffered.slice(end + 1)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(line); else queue.push(line)
    }
  })
  stream.once('error', error => fail(error))
  stream.once('end', () => fail(new Error('child stdout ended before a complete readiness line')))
  stream.once('close', () => fail(new Error('child stdout closed before a complete readiness line')))
  return { next: () => queue.length > 0 ? Promise.resolve(queue.shift()!) :
    streamFailure ? Promise.reject(streamFailure) : new Promise((resolve, reject) => waiters.push({ resolve, reject })) }
}

async function control(socketPath: string, operation: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let source = ''
    let settled = false
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error); else resolve(value!)
    }
    socket.setTimeout(5_000, () => finish(new Error(`control operation timed out: ${operation}`)))
    socket.once('error', error => finish(error))
    socket.on('data', chunk => { source += chunk.toString() })
    socket.once('end', () => {
      try { finish(undefined, JSON.parse(source) as Record<string, unknown>) } catch (error) { finish(error) }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify({ schemaVersion: 1, operation })}\n`, error => {
      if (error) finish(error)
    }))
  })
}

test('rejects same-owner FIFO metadata drift and cleans opened handles and path', async () => {
  const root = await mkdtemp('/tmp/actual-owner-fifo-regression-')
  roots.push(root)
  await chmod(root, 0o700)
  const openedFds: number[] = []
  const path = join(root, 'drift.fifo')

  await expect(inheritedFifo(root, 'drift.fifo', async (fifoPath, reader, writer) => {
    openedFds.push(reader.fd, writer.fd)
    await chmod(fifoPath, 0o400)
  })).rejects.toThrow('inherited FIFO identity or security metadata changed while opening it')
  expect(openedFds).toHaveLength(2)
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const fd of openedFds) {
    await expect(stat(`/proc/self/fd/${fd}`)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('settles child failures on both spawn error and premature close', async () => {
  const failedSpawn = trackChild(spawn('/definitely-missing-hosted-owner-fixture'))
  await expect(childFailure(failedSpawn, 'spawn regression')).rejects.toThrow('spawn regression')
  await terminateChild(failedSpawn)

  const prematureClose = trackChild(spawn(process.execPath, ['-e', 'process.exit(23)'], {
    stdio: 'ignore', env: isolatedEnvironment(),
  }))
  await expect(childFailure(prematureClose, 'close regression')).rejects.toThrow(
    'close regression: child closed with code 23 and signal none',
  )
  await terminateChild(prematureClose)
  expect(children.size).toBe(0)
})

describe('hosted actual-owner source launcher black box', () => {
  test('runs pinned Bun through real source bootstrap, capability, readiness, and shutdown', async () => {
    const repositoryRoot = join(import.meta.dir, '../../..')
    expect(await git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe('')
    const orchestratorHead = await git(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const runId = 'f'.repeat(48)
    const root = await mkdtemp(`/tmp/actual-owner-${runId}-`)
    roots.push(root)
    await chmod(root, 0o700)
    const product = await createProductRepository(root)
    const home = join(root, 'home')
    const data = join(root, 'multimodel-data')
    const cache = join(root, 'multimodel-cache')
    const project = join(root, 'project')
    await Promise.all([home, data, cache, project].map(path => mkdir(path, { recursive: true, mode: 0o700 })))

    const bunExecutable = join(root, 'opencode')
    await copyFile(process.execPath, bunExecutable)
    await chmod(bunExecutable, 0o500)
    const bunBytes = await readFile(bunExecutable)
    const executableSha256 = createHash('sha256').update(bunBytes).digest('hex')
    const providerPort = await unusedPort()
    const password = 'actual-owner-fixture-password'
    const providerSource = join(root, 'provider.ts')
    await writeFile(providerSource, `
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const authorization = 'Basic ' + Buffer.from('opencode:${password}').toString('base64')
const capability = {schemaVersion:2,protocol:'agent-teams-hosted-approval-v2',authentication:'opencode-basic',runtimeInstanceId:'runtime_instance_${'8'.repeat(32)}',configGeneration:'config_generation_${'9'.repeat(32)}'}
Bun.serve({hostname:'127.0.0.1',port,fetch(request){
  const url = new URL(request.url)
  if (url.pathname === '/global/health') return Response.json({healthy:true,version:'fixture'})
  if (['/config','/config/providers','/agent','/mcp'].includes(url.pathname)) return Response.json({})
  if (request.headers.get('authorization') !== authorization || request.headers.get('x-opencode-directory') !== ${JSON.stringify(project)}) return new Response('forbidden',{status:403})
  if (url.pathname === '/experimental/agent-teams/hosted-approval-capability') return Response.json(capability)
  if (url.pathname === '/experimental/agent-teams/hosted-approval/session/session_1/permissions') return Response.json({schemaVersion:capability.schemaVersion,protocol:capability.protocol,runtimeInstanceId:capability.runtimeInstanceId,configGeneration:capability.configGeneration,sessionId:'session_1',permissions:[]})
  return new Response('not found',{status:404})
}})
await new Promise(() => {})
`)
    const fixtureEnvironment = isolatedEnvironment({
      HOME: home, XDG_DATA_HOME: join(home, 'xdg-data'),
      CLAUDE_MULTIMODEL_DATA_HOME: data, CLAUDE_MULTIMODEL_CACHE_HOME: cache,
      OPENCODE_SERVER_PASSWORD: password,
    })
    const cleanup = new CleanupStack()
    const provider = spawn(bunExecutable, ['run', providerSource, 'serve', '--port', String(providerPort),
      '--hostname', '127.0.0.1'], { env: fixtureEnvironment, stdio: ['ignore', 'ignore', 'pipe'] })
    const trackedProvider = trackChild(provider)
    cleanup.defer(() => terminateChild(trackedProvider))
    try {
    await waitForHttp(`http://127.0.0.1:${providerPort}/global/health`, trackedProvider)
    const processStartedAtMs = await linuxProcessStartTicks(provider.pid!)
    expect(processStartedAtMs).not.toBeNull()

    const profileModule = join(repositoryRoot, 'src/services/opencode/OpenCodeProfileManager.ts')
    const profileSource = `import { OpenCodeProfileManager } from ${JSON.stringify(profileModule)}; console.log(JSON.stringify(await new OpenCodeProfileManager().prepareProfile(${JSON.stringify(project)}, {toolApprovalMode:'manual'})))`
    const profile = JSON.parse((await execFileAsync(bunExecutable, ['-e', profileSource], {
      encoding: 'utf8', env: fixtureEnvironment, maxBuffer: 16 * 1024 * 1024,
    })).stdout) as Record<string, any>
    await Promise.all(getOpenCodeManagedSubscriptionPluginPackages().map(async packageSpec => {
      const packageRoot = join(profile.xdgCacheHome, 'opencode', 'packages', packageSpec)
      await mkdir(packageRoot, { recursive: true, mode: 0o700 })
      await writeFile(join(packageRoot, 'package.json'), '{}\n', { mode: 0o600 })
    }))
    const resolvedConfigFingerprint = createHash('sha256').update(JSON.stringify({
      config: {}, configProviders: {}, agents: {}, mcp: [],
    })).digest('hex')
    const hostKey = 'actual-owner-fixture-host'
    const teamId = `team_${'1'.repeat(32)}`
    const routeRunId = `run_${'2'.repeat(32)}`
    const session = {
      teamId, laneId: 'secondary:opencode:worker', runId: routeRunId, memberName: 'worker',
      providerId: 'opencode', toolApprovalMode: 'manual', opencodeSessionId: 'session_1', staleReason: null,
      hostKey, projectPath: project, profileRootKey: profile.profileRootKey,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      sourceAuthFingerprint: profile.sourceAuthFingerprint, managedAuthFingerprint: profile.managedAuthFingerprint,
      runtimePid: provider.pid!, openCodeArtifactDigest: `sha256:${executableSha256}`,
      createdAt: '2026-08-15T00:00:00.000Z',
    }
    const effect = { record: session, profile, host: {
      hostKey, profileRootKey: profile.profileRootKey, projectPath: project,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      openCodeArtifactDigest: session.openCodeArtifactDigest, pid: provider.pid!, processStartedAtMs,
      resolvedConfigFingerprint,
    } }
    const memberId = `member_${'4'.repeat(32)}`
    const route = {
      routeId: 'route_1', memberName: 'worker', authority: {
        deploymentId: 'deployment-test', teamId, runId: routeRunId, planGeneration: 2,
        laneId: session.laneId, providerId: 'opencode', credentialGeneration: 3,
        credentialId: 'credential_1', sessionId: session.opencodeSessionId,
        runtimeInstanceId: 'runtime_1', deliveryOwnerId: memberId,
      },
      scope: { principalId: 'actor_owner', workspaceId: 'workspace-test', teamId,
        authorityGeneration: 'generation_1', restoreGeneration: 1 },
      openCodeBinding: { toolApprovalMode: 'manual', planGeneration: 2, credentialGeneration: 3,
        credentialId: 'credential_1', runtimeInstanceId: 'runtime_1', deliveryOwnerId: memberId,
        openCodeArtifactDigest: session.openCodeArtifactDigest,
        sessionRecordFingerprint: fingerprintSession(session),
        liveEffectFingerprint: fingerprintEffect(effect) },
    }

    const sessionStore = join(data, 'opencode', 'session-store.json')
    const hostRegistry = join(data, 'opencode', 'host-registry.json')
    await mkdir(join(data, 'opencode'), { recursive: true, mode: 0o700 })
    await writeFile(sessionStore, JSON.stringify({ schemaVersion: 1,
      records: { [`${teamId}::${session.laneId}::worker`]: session } }, null, 2))
    await writeFile(hostRegistry, JSON.stringify({ schemaVersion: 1, hosts: { [hostKey]: {
      hostKey, profileRootKey: profile.profileRootKey, projectPath: project,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      baseUrl: `http://127.0.0.1:${providerPort}`, port: providerPort, pid: provider.pid!,
      processStartedAtMs, version: 'fixture', resolvedConfigFingerprint,
      updatedAt: '2026-08-15T00:00:00.000Z', leases: {},
    } } }, null, 2))

    const claudeRoot = join(root, 'claude')
    const teamRoot = join(claudeRoot, 'teams', 'team-key')
    const captureRoot = join(root, 'capture')
    await mkdir(teamRoot, { recursive: true, mode: 0o700 })
    await mkdir(captureRoot, { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'browser'), { recursive: true, mode: 0o700 })
    await chmod(claudeRoot, 0o700); await chmod(join(claudeRoot, 'teams'), 0o700)
    const admissionFile = join(teamRoot, 'hosted-approval-runtime-admission.v1.json')
    await writeFile(admissionFile, JSON.stringify({
      schemaVersion: 1, admissionGeneration: 'approval-admission-generation_1',
      outerAuthority: { deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
        teamId, restoreGeneration: 1, mountBinding: { mountGeneration: 1, declaredRootHash: '3'.repeat(64) } },
      routes: [route], actorMembers: { actor_owner: memberId },
    }), { mode: 0o600 })

    const markerPath = join(root, ACTUAL_OWNER_MARKER_FILE)
    const rootStat = await lstat(root, { bigint: true })
    await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, purpose: ACTUAL_OWNER_PURPOSE, runId,
      rootBasename: root.split('/').at(-1), rootDevice: rootStat.dev.toString(),
      rootInode: rootStat.ino.toString() }), { mode: 0o600 })
    const contractPath = join(root, 'actual-owner-contract.v1.json')
    await writeFile(contractPath, contractBytes, { mode: 0o400 })
    const contractStat = await lstat(contractPath, { bigint: true })
    const contractSha256 = createHash('sha256').update(contractBytes).digest('hex')
    const ownerToken = 'actual-owner-fixture-token'
    const capabilityState: { runtimeManifestSha256?: string; captures?: Record<string, unknown> } = {}
    let capabilityRequests = 0
    const capabilityServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const nonce = request.headers.get('x-agent-teams-nonce')
      if (!nonce || request.headers.get('authorization') !== `Bearer ${ownerToken}` ||
        request.headers.get('x-actual-owner-session') !== `session_${runId}` ||
        !capabilityState.runtimeManifestSha256 || !capabilityState.captures) return new Response('forbidden', { status: 403 })
      capabilityRequests += 1
      const unsigned = { schemaVersion: 1, purpose: 'agent-teams.hosted-actual-owner-e2e.capability/v1',
        nonce, harnessRunId: runId, ownerSessionId: `session_${runId}`, contractSha256,
        runtimeManifestSha256: capabilityState.runtimeManifestSha256,
        driverSocket: { endpoint: `127.0.0.1:${capabilityServer.port}`, device: '1', inode: '10' },
        productSocket: { endpoint: `127.0.0.1:${providerPort}`, device: '1', inode: '11' },
        routes: [{ routeId: route.routeId, sessionId: session.opencodeSessionId,
          routeRunId, generation: route.scope.authorityGeneration }], captures: capabilityState.captures }
      return Response.json({ ...unsigned,
        hmacSha256: createHmac('sha256', ownerToken).update(JSON.stringify(unsigned)).digest('hex') })
    } })
    try {
      const runtimeManifestPath = join(root, 'runtime.json')
      const capture = {
        browserResultsPath: '${SANDBOX_ROOT}/capture/browser-results.json',
        conditionalPostLedgerPath: '${SANDBOX_ROOT}/capture/posts.ndjson',
        negativeResultsPath: '${SANDBOX_ROOT}/capture/negative.json',
        openCodeTimelinePath: '${SANDBOX_ROOT}/capture/opencode.ndjson',
        ownerWalTimelinePath: '${SANDBOX_ROOT}/capture/owner.ndjson',
        productTimelinePath: '${SANDBOX_ROOT}/capture/product.ndjson',
        protectedEffectLedgerPath: '${SANDBOX_ROOT}/capture/effects.json',
      }
      const executableStat = await lstat(bunExecutable, { bigint: true })
      const manifest = {
        schemaVersion: 1, purpose: ACTUAL_OWNER_PURPOSE, runId, sandboxRoot: '${SANDBOX_ROOT}',
        markerPath: '${SANDBOX_ROOT}/.agent-teams-actual-owner-e2e-owner.json',
        ownerWalTimelineRawPath: '${SANDBOX_ROOT}/capture/owner.ndjson', evidenceRoot: join(root, 'evidence'),
        driverBaseUrl: `http://127.0.0.1:${capabilityServer.port}/`,
        productBaseUrl: `http://127.0.0.1:${providerPort}/`, approvalPath: '/hosted/approvals',
        capabilityEndpoint: `http://127.0.0.1:${capabilityServer.port}/v1/capability`,
        ownerBinding: { ownerUid: process.getuid?.() ?? 0, ownerSessionId: `session_${runId}`,
          ownerTokenSha256: createHash('sha256').update(ownerToken).digest('hex') },
        socketIdentity: {
          driverSocket: { endpoint: `127.0.0.1:${capabilityServer.port}`, device: '1', inode: '10' },
          productSocket: { endpoint: `127.0.0.1:${providerPort}`, device: '1', inode: '11' },
        },
        contract: { path: '${SANDBOX_ROOT}/actual-owner-contract.v1.json', sha256: contractSha256,
          byteCount: contractBytes.length, device: contractStat.dev.toString(), inode: contractStat.ino.toString(),
          mode: (contractStat.mode & 0o777n).toString(), sourceCommit: product.head,
          repositoryPath: 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json' },
        browser: { ownerStorageStatePath: '${SANDBOX_ROOT}/browser/owner.json',
          nonOwnerStorageStatePath: '${SANDBOX_ROOT}/browser/non-owner.json',
          tracePath: '${SANDBOX_ROOT}/browser/trace.zip', resultsPath: capture.browserResultsPath },
        capture,
        descriptors: {
          sandboxRoot: await descriptor('${SANDBOX_ROOT}', root),
          productRoot: await descriptor('${PRODUCT_ROOT}', product.path),
          orchestratorRoot: await descriptor('${ORCHESTRATOR_ROOT}', repositoryRoot),
          openCodeExecutable: { ...await descriptor('${OPENCODE_EXECUTABLE}', bunExecutable),
            size: executableStat.size.toString(), sha256: executableSha256 },
        },
        refs: { openCode: 'a'.repeat(40), openCodeExecutableSha256: executableSha256,
          orchestrator: orchestratorHead, product: product.head },
      }
      const runtimeBytes = Buffer.from(JSON.stringify(manifest))
      await writeFile(runtimeManifestPath, runtimeBytes, { mode: 0o600 })
      capabilityState.runtimeManifestSha256 = createHash('sha256').update(runtimeBytes).digest('hex')
      capabilityState.captures = Object.fromEntries(await Promise.all(Object.entries(capture).map(async ([field, token]) => {
        const path = `${root}${token.slice('${SANDBOX_ROOT}'.length)}`
        const parent = await stat(join(path, '..'), { bigint: true })
        return [field, { path, parentDevice: parent.dev.toString(), parentInode: parent.ino.toString() }]
      })))

      const leasePath = join(root, 'launcher-lease')
      const leaseBytes = Buffer.from('actual-owner-source-fixture\n')
      await writeFile(leasePath, leaseBytes, { mode: 0o600 })
      const lease = await open(leasePath, 'r')
      cleanup.defer(idempotentClose(lease))
      const leaseStat = await lease.stat()
      const secret = Buffer.alloc(32, 0xa5)
      const leaseDigest = createHash('sha256').update(leaseBytes).digest('hex')
      const header = {
        format: 'agent-teams.hosted-control.bootstrap/v1', restoreGeneration: 1, teamId,
        declaredRootHash: '3'.repeat(64), ownerAuthority: 'owner-authority_acceptance-fixture',
        ownerGeneration: 1, ownerSessionId: 'owner-session_acceptance-fixture', claudeRoot,
        socketPath: join(root, 'owner.sock'), legacyKey: 'team-key',
        bootstrapBinding: { deploymentId: 'deployment-test', bootId: 'boot-test', workspaceId: 'workspace-test',
          mountGeneration: 1, bootstrapDigest: '5'.repeat(64), ownerArtifactDigest: `sha256:${leaseDigest}`,
          proofKeyId: createHash('sha256').update(secret).digest('hex') },
        leaseEvidence: { device: String(leaseStat.dev), inode: String(leaseStat.ino), uid: leaseStat.uid,
          gid: leaseStat.gid, mode: leaseStat.mode & 0o777, launcherLeaseId: 'launcher-lease-fixture',
          launcherArtifactDigest: leaseDigest },
      }
      const headerBytes = Buffer.from(JSON.stringify(header))
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(headerBytes.length)
      const authenticated = Buffer.concat([prefix, headerBytes])
      const bootstrapFrame = Buffer.concat([authenticated, secret, createHmac('sha256', secret)
        .update('agent-teams.hosted-control.bootstrap/v1').update(Buffer.from([0])).update(authenticated).digest()])
      const sourceEntry = join(repositoryRoot, 'scripts/e2e/hosted-actual-owner-owner.ts')
      const stagedEntry = join(root, 'owner.ts')
      await copyFile(sourceEntry, stagedEntry); await chmod(stagedEntry, 0o400)
      const launcher = await open(join(repositoryRoot, 'scripts/e2e/hosted-actual-owner/cli-source'), 'r')
      cleanup.defer(idempotentClose(launcher))
      const liveness = await inheritedFifo(root, 'liveness.fifo')
      cleanup.defer(() => liveness.close())
      const bootstrap = await inheritedFifo(root, 'bootstrap.fifo')
      cleanup.defer(() => bootstrap.close())
      await writeAllAndClose(bootstrap.writer, bootstrap.closeWriter, bootstrapFrame)
      const controlSocket = join(root, 'acceptance.sock')
      const evidenceFile = join(root, 'evidence.json')
      const child = spawn('/proc/self/fd/3', [
        '--hosted-actual-owner-acceptance-entry', stagedEntry,
        '--runtime-manifest', runtimeManifestPath, '--actual-owner-contract', contractPath,
        '--actual-owner-contract-sha256', contractSha256,
        '--actual-owner-contract-byte-count', String(contractBytes.length),
        '--launcher-lease-fd', '6', '--liveness-fd', '7', '--bootstrap-fd', '8',
      ], { cwd: repositoryRoot, env: { ...fixtureEnvironment,
        HOSTED_ACTUAL_OWNER_E2E_BUN_EXECUTABLE: bunExecutable,
        HOSTED_ACTUAL_OWNER_E2E_BUN_SHA256: executableSha256,
        HOSTED_ACTUAL_OWNER_E2E_MARKER: markerPath,
        HOSTED_ACTUAL_OWNER_E2E_ADMISSION_FILE: admissionFile,
        HOSTED_ACTUAL_OWNER_E2E_OWNER_TOKEN: ownerToken,
        HOSTED_ACTUAL_OWNER_E2E_PRODUCT_PUBLICATION_TIMEOUT_MS: '5000',
        HOSTED_ACTUAL_OWNER_E2E_CONTROL_SOCKET: controlSocket,
        HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_FILE: evidenceFile,
        HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST: runtimeManifestPath,
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: bunExecutable, OPENCODE_BIN_PATH: bunExecutable,
      }, stdio: ['ignore', 'pipe', 'pipe', launcher.fd, 'ignore', 'ignore', lease.fd,
        liveness.reader.fd, bootstrap.reader.fd] })
      const trackedChild = trackChild(child)
      cleanup.defer(() => terminateChild(trackedChild))
      const inheritedStdio = child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>
      expect(inheritedStdio[7]).toBeNull()
      expect(inheritedStdio[8]).toBeNull()
      await Promise.all([liveness.closeReader(), bootstrap.closeReader()])
      child.stderr!.on('data', chunk => process.stderr.write(chunk))
      const lines = jsonLine(child.stdout!)
      const readiness = await Promise.race([
        lines.next(),
        childFailure(trackedChild, 'actual-owner failed before readiness'),
        Bun.sleep(15_000).then(() => { throw new Error('actual-owner readiness timed out') }),
      ])
      expect(readiness).toMatchObject({
        purpose: 'agent-teams.hosted-actual-owner-e2e.orchestrator-readiness/v1', status: 'ready',
        evidenceFile, controlSocket,
      })
      expect(capabilityRequests).toBeGreaterThanOrEqual(2)
      expect(await control(controlSocket, 'readiness')).toMatchObject({ status: 'ready' })
      expect(await control(controlSocket, 'shutdown')).toEqual({ schemaVersion: 1, operation: 'shutdown', accepted: true })
      const termination = await Promise.race([trackedChild.termination,
        Bun.sleep(10_000).then(() => { throw new Error('actual-owner shutdown timed out') })])
      if (termination.kind === 'error') throw termination.error
      expect(termination).toMatchObject({ kind: 'close', code: 0, signal: null })
      children.delete(child)
      await liveness.closeWriter()
    } finally {
      await capabilityServer.stop(true)
    }
    } finally {
      await cleanup.dispose()
    }
  }, 30_000)
})
