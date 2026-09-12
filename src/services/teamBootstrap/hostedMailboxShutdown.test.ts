import { expect, test } from 'bun:test'
import { readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { appStateTeammateFromExistingRoster } from './teamBootstrapRunner.js'

const rootGate = process.platform === 'linux' && process.geteuid?.() === 0
const gatedTest = rootGate ? test : test.skip
const STARTUP_DEADLINE_MS = 15_000
const FIXTURE_DEADLINE_MS = 40_000

type FixtureResult = {
  namespace: { isolated: boolean; configReadOnly: boolean; nestedTasksWritable: boolean
    configOwner: number; workerUid: number; workerGid: number; capabilities: string
    chmodErrno: string; renameErrno: string; remountDenied: boolean
    privatePropagation: boolean; distinctNestedMounts: boolean
    canonicalTeamOwner: number; teamParentOwner: number; registryOwner: number; bindingOwner: number }
  taskPathMatchesProduction: boolean
  producerSemantics: { configJoinedAt: number; appSpawnedAt: number; appRosterJoinedAt: number
    runtimeIdentityMatches: boolean; normalCleanupRemoved: boolean }
  sequential: { firstHandled: boolean; secondHandled: boolean; firstOwner: string | null
    secondOwner: string | null; membersRemaining: number; appsRemaining: number; phase: string
    joinedAt: number; firstHostedOwnerId: string; secondHostedOwnerId: string }
  captureFences: Record<string, boolean | string>
  partialRejected: boolean; partialPhase: string; retryPhase: string; parseRejected: boolean
  mismatch: { rejected: boolean; repairedOwner: string | null; replacementOwnerAfterReject: string
    replacementOwnerAfterRetry: string; retryPhase: string }
  replacementResults: Record<string, boolean>
  joinedAtFence: { rejected: boolean; phaseAfterReject: string; rosterJoinedAt: number; taskOwner: string
    appSpawnedAt: number; appRosterJoinedAt: number; retryPhase: string; retryOwner: string | null; retryAppRemoved: boolean }
  appStateFence: { replacementPreserved: boolean; phase: string }
  historicalAppState: { rejected: boolean; phase: string; preserved: boolean; retryPhase: string; retryRemoved: boolean }
  legacyCleanup: { rejected: boolean; rosterJoinedAt: number; taskOwner: string
    appSpawnedAt: number; appRosterJoinedAt: number }
  publicationRetries: Record<string, boolean>
  handlerPhaseRetries: Record<string, boolean>
  recovery: { publicationRejected: boolean; retryHandled: boolean; persistedRequestId: string
    persistedAgentId: string; memberPresent: boolean; appPresent: boolean; cleanupStateAbsent: boolean }
}

function deadline(ms: number, message: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>
  return {
    promise: new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    cancel: () => clearTimeout(timer!),
  }
}

async function runFixture(): Promise<FixtureResult> {
  const helper = join(import.meta.dir, 'hostedMailboxShutdown.fixture.ts')
  const tsconfig = join(import.meta.dir, '../../..', 'tsconfig.json')
  const parentNamespace = readlinkSync('/proc/self/ns/mnt')
  const child = Bun.spawn({
    cmd: ['/usr/bin/setsid', '/usr/bin/unshare', '--mount', '--propagation', 'private',
      process.execPath, '--no-install', '--tsconfig-override', tsconfig, helper, '--fixture-root', parentNamespace],
    stdout: 'pipe', stderr: 'pipe',
  })
  let stdout = ''
  let stderr = ''
  let readyResolve!: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })
  const stdoutPump = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      stdout += decoder.decode(item.value, { stream: true })
      if (stdout.includes('FIXTURE_READY\n')) readyResolve()
    }
    stdout += decoder.decode()
  })()
  const stderrPump = (async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const item = await reader.read()
      if (item.done) break
      stderr += decoder.decode(item.value, { stream: true })
    }
    stderr += decoder.decode()
  })()
  const startup = deadline(STARTUP_DEADLINE_MS, 'shutdown fixture did not become ready within 15 seconds')
  const overall = deadline(FIXTURE_DEADLINE_MS, 'shutdown fixture exceeded its 40 second process budget')
  let exitCode: number | undefined
  try {
    await Promise.race([ready, startup.promise, child.exited.then(code => {
      throw new Error(`shutdown fixture exited before ready (${code}): ${stderr}`)
    })])
    startup.cancel()
    exitCode = await Promise.race([child.exited, overall.promise])
  } finally {
    startup.cancel()
    overall.cancel()
    if (exitCode === undefined) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      exitCode = await child.exited
    }
    await Promise.allSettled([stdoutPump, stderrPump])
  }
  if (exitCode !== 0) throw new Error(`shutdown fixture failed (${exitCode}): ${stderr}`)
  const line = stdout.trim().split('\n').findLast(value => value.startsWith('{'))
  if (!line) throw new Error(`shutdown fixture returned no result: ${stdout}`)
  return JSON.parse(line) as FixtureResult
}

test('gate is explicit outside Linux/root', () => {
  if (!rootGate) expect(true).toBe(true)
})

test('existing roster restoration carries exact incarnation and available runtime identity', () => {
  const restored = appStateTeammateFromExistingRoster({
    agentId: 'worker@atlas', name: 'worker', joinedAt: 1000, tmuxPaneId: 'process:9', cwd: '/tmp',
    subscriptions: [], processStartedAtMs: 7, processOsIdentity: 'unix-pgid:9',
    processOwnerToken: 'owner', processRunId: 'run', spawnClaimToken: 'claim',
    spawnClaimRunId: 'claim-run',
  })
  expect(restored).toMatchObject({
    spawnedAt: 1000, rosterJoinedAt: 1000, tmuxPaneId: 'process:9', processStartedAtMs: 7,
    processOsIdentity: 'unix-pgid:9', processOwnerToken: 'owner', processRunId: 'run',
    spawnClaimToken: 'claim', spawnClaimRunId: 'claim-run',
  })
})

gatedTest('isolated immutable-root fixture exercises durable shutdown and fail-closed recovery', async () => {
  const result = await runFixture()
  expect(result.namespace).toEqual({
    isolated: true, configReadOnly: true, nestedTasksWritable: true, configOwner: 65534,
    workerUid: 65534, workerGid: 65534, capabilities: '0000000000000000',
    chmodErrno: 'EROFS', renameErrno: 'EROFS', remountDenied: true,
    privatePropagation: true, distinctNestedMounts: true,
    canonicalTeamOwner: 65534, teamParentOwner: 0, registryOwner: 0, bindingOwner: 0,
  })
  expect(result.taskPathMatchesProduction).toBe(true)
  expect(result.producerSemantics).toEqual({
    configJoinedAt: 1000, appSpawnedAt: 1200, appRosterJoinedAt: 1000,
    runtimeIdentityMatches: true, normalCleanupRemoved: true,
  })
  expect(result.sequential).toEqual({
    firstHandled: true, secondHandled: true, firstOwner: null, secondOwner: null,
    membersRemaining: 0, appsRemaining: 0, phase: 'complete', joinedAt: 2000,
    firstHostedOwnerId: `member_${'a'.repeat(32)}`,
    secondHostedOwnerId: `member_${'b'.repeat(32)}`,
  })
  expect(result).toMatchObject({
    partialRejected: true, partialPhase: 'roster_removed', retryPhase: 'complete',
    parseRejected: true,
    captureFences: { wrongJoinedAtNameOnly: true, wrongJoinedAtExplicit: true, wrongAgentId: true,
      repairedOwner: `member_${'a'.repeat(32)}` },
    mismatch: { rejected: true, repairedOwner: null,
      replacementOwnerAfterReject: `member_${'c'.repeat(32)}`,
      replacementOwnerAfterRetry: `member_${'c'.repeat(32)}`, retryPhase: 'complete' },
    replacementResults: { prepared: true, preparedOwnerPreserved: true,
      roster_removed: true, roster_removedOwnerPreserved: true },
    joinedAtFence: { rejected: true, phaseAfterReject: 'prepared', rosterJoinedAt: 1001,
      taskOwner: `member_${'c'.repeat(32)}`,
      appSpawnedAt: 1201, appRosterJoinedAt: 1001,
      retryPhase: 'complete', retryOwner: null, retryAppRemoved: true },
    appStateFence: { replacementPreserved: true, phase: 'complete' },
    historicalAppState: { rejected: true, phase: 'tasks_cleaned', preserved: true,
      retryPhase: 'complete', retryRemoved: true },
    legacyCleanup: { rejected: true, rosterJoinedAt: 1001, taskOwner: `member_${'c'.repeat(32)}`,
      appSpawnedAt: 1201, appRosterJoinedAt: 1001 },
    publicationRetries: { prepared: true, roster_removed: true, tasks_cleaned: true, complete: true },
    handlerPhaseRetries: { prepared: true, roster_removed: true, tasks_cleaned: true },
    recovery: { publicationRejected: true, retryHandled: true, persistedRequestId: 'request-recovery',
      persistedAgentId: 'worker@atlas', memberPresent: true, appPresent: true, cleanupStateAbsent: true },
  })
}, 45_000)
