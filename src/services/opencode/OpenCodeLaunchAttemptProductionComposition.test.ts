import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createOpenCodeLaunchAttemptProductionBridge } from './OpenCodeLaunchAttemptProductionComposition.js'
import {
  computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchRequestCorrelationDigest,
  type OpenCodeLaunchAttemptBridgePort,
} from './OpenCodeLaunchAttemptBridge.js'
import type { OpenCodeLaunchAttemptResult } from './OpenCodeLaunchAttempt.js'
import { OpenCodeLaunchMutationLedger } from './OpenCodeLaunchMutationLedger.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { createOpenCodeLaunchAttemptProductionTestBridge,
  OpenCodeLaunchHostReleaseLedger } from './OpenCodeLaunchAttemptProduction.js'
import { isProcessAlive, readProcessBirthToken } from '../../utils/processKill.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
const projectedLaunchAttempt = (value: { data?: unknown }): unknown =>
  (value.data as { launchAttempt?: unknown } | undefined)?.launchAttempt
const snapshot = { detected: false } as OpenCodeProvisioningSnapshot
const result: OpenCodeLaunchAttemptResult = {
  attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456', payloadHash: 'a'.repeat(64),
  generation: 1,
  inputDigest: 'b'.repeat(64), immutableDigest: 'c'.repeat(64),
  status: 'succeeded',
  committed: [],
  failed: [],
  pending: [],
  cleanupPending: [],
  cleanup: 'complete',
  absoluteDeadlineAtMs: 10_000,
  workDeadlineAtMs: 9_000,
}
const nativePidRecycleRequired = process.env.OPENCODE_REQUIRE_NATIVE_PID_RECYCLE === '1'
const pidNamespaceSupervisorSocket = process.env.OPENCODE_PID_NAMESPACE_SUPERVISOR_SOCKET
const nativePidRecycleHeaderLength = 16
const maxNativePidRecycleDataHomeLength = 4096
const canExerciseNativePidRecycle = process.platform !== 'linux' || (nativePidRecycleRequired && (() => {
  try {
    accessSync('/proc/sys/kernel/ns_last_pid', fsConstants.W_OK)
    return typeof pidNamespaceSupervisorSocket === 'string' && pidNamespaceSupervisorSocket.length > 0
  } catch { return false }
})())
if (nativePidRecycleRequired && !canExerciseNativePidRecycle) {
  throw new Error('mandatory Linux native PID-recycle authority is unavailable')
}
let projectPath = ''
beforeAll(async () => { projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-composition-')) })
afterAll(async () => { await rm(projectPath, { recursive: true, force: true }) })

function requestExactNativePidRecycle(leaderPid: number, grandchildPid: number,
  dataHome: string): Promise<number> {
  if (!pidNamespaceSupervisorSocket) throw new Error('PID namespace supervisor socket is absent')
  const data = Buffer.from(dataHome)
  if (data.length === 0 || data.length > maxNativePidRecycleDataHomeLength) {
    throw new Error(`PID namespace supervisor data home has invalid byte length ${data.length}`)
  }
  const request = Buffer.allocUnsafe(nativePidRecycleHeaderLength + data.length)
  request.write('OPCR', 0, 'ascii')
  request.writeUInt32BE(leaderPid, 4)
  request.writeUInt32BE(grandchildPid, 8)
  request.writeUInt32BE(data.length, 12)
  data.copy(request, nativePidRecycleHeaderLength)
  return new Promise((resolve, reject) => {
    const socket = createConnection(pidNamespaceSupervisorSocket)
    let response = ''
    socket.setEncoding('utf8')
    // Keep the readable side open: the supervisor replies and closes after it
    // has read exactly the length-prefixed request, without waiting for EOF.
    socket.on('connect', () => socket.write(request))
    socket.on('data', chunk => { response += chunk })
    socket.once('error', reject)
    socket.once('end', () => {
      const match = response.match(/^OK ([0-9]+)\n$/)
      if (!match) reject(new Error(`PID namespace supervisor rejected recycle: ${response.trim()}`))
      else resolve(Number(match[1]))
    })
  })
}

function command(): Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] {
  const value: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] = {
    request: {
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
        payloadHash: 'a'.repeat(64),
        generation: 1,
        proofNonce: 'n'.repeat(43),
        parent: { sessionIdentity: identity('b'), messageIdentity: identity('c') },
        providerId: 'openrouter',
        modelId: 'openrouter/model',
        requiredMcpTools: ['agent-teams.message_send'],
        requireFreshRetainedHostProof: true,
      },
    },
    members: [{ name: 'alice', memberIdentity: identity('d') }],
    runId: 'run', laneId: 'primary', teamId: 'team', projectPath,
    selectedModel: 'openrouter/model', toolApprovalMode: 'auto', continuation: false,
    requestedBudgetMs: 10_000,
    preconditions: {
      handshakeIdentityHash: '1'.repeat(64), laneId: 'primary', expectedRunId: 'run',
      expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: '2'.repeat(64),
      expectedManifestHighWatermark: null, commandLeaseId: 'lease-1',
      idempotencyKey: '018f47a2-4a13-7c2f-8d44-c0ffee123456',
    },
  }
  value.request.launchAttempt.requestCorrelationDigest =
    computeOpenCodeLaunchRequestCorrelationDigest(value)
  return value
}

function correlate(
  value: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0],
): typeof value {
  value.request.launchAttempt.requestCorrelationDigest =
    computeOpenCodeLaunchRequestCorrelationDigest(value)
  return value
}

describe('OpenCode production launch composition', () => {
  test('read-only host-obligation classification precedes authorization and every accepted-core effect', async () => {
    const calls: string[] = []
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {
        calls.push('tokenless-v1')
        throw new Error('unsafe host obligation')
      },
      authorize: async value => { calls.push('authorization'); return value },
      inspect: async () => { calls.push('command-ledger'); return null },
      executeAfterPreflight: async () => {
        calls.push('core')
        return { output: { snapshot, data: null }, result }
      },
    })

    await expect(bridge.execute(command())).rejects.toThrow('unsafe host obligation')
    expect(calls).toEqual(['tokenless-v1'])
  })

  for (const status of ['succeeded', 'reconciliation_required'] as const) {
    test(`durable ${status} gate runs before every profile, host, and member effect`, async () => {
      const calls: string[] = []
      const output = { snapshot, data: { launchAttempt: { status }, durable: true } }
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
        preflightAuthorization: async () => {},
        authorize: async value => { calls.push('plan'); return value },
        inspect: async () => { calls.push('command-ledger'); return output },
        executeAfterPreflight: async () => {
          calls.push('profile', 'host', 'member')
          return { output: { snapshot, data: null }, result }
        },
      })

      await expect(bridge.execute(command())).resolves.toEqual(output)
      expect(calls).toEqual(['plan', 'command-ledger'])
    })
  }

  test('durable mismatch fails closed before launch effects', async () => {
    const calls: string[] = []
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('command-ledger'); throw new Error('immutable plan mismatch') },
      executeAfterPreflight: async () => {
        calls.push('profile', 'host', 'member')
        return { output: { snapshot, data: null }, result }
      },
    })

    await expect(bridge.execute(command())).rejects.toThrow('immutable plan mismatch')
    expect(calls).toEqual(['plan', 'command-ledger'])
  })

  test('missing correlation fails before realpath, authorization, ledger, or effects', async () => {
    const calls: string[] = []
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('command-ledger'); return null },
      executeAfterPreflight: async () => {
        calls.push('profile', 'host', 'member')
        return { output: { snapshot, data: null }, result }
      },
    }, { canonicalizeProject: async value => { calls.push('realpath'); return value } })
    const value = command()
    delete value.request.launchAttempt.requestCorrelationDigest

    await expect(bridge.execute(value)).rejects.toThrow('correlation digest is required')
    expect(calls).toEqual([])
  })

  test('completed and unknown replay compare the exact generation input key', async () => {
    for (const status of ['succeeded', 'reconciliation_required'] as const) {
      let durableKey: { attemptId: string; payloadHash: string; generation: number; inputDigest: string } | undefined
      let effects = 0
      const output = { snapshot, data: { launchAttempt: { outcome: status } } }
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
        preflightAuthorization: async () => {},
        authorize: async value => value,
        inspect: async (_value, key) => {
          durableKey ??= { ...key }
          if (JSON.stringify(key) !== JSON.stringify(durableKey)) throw new Error('exact replay mismatch')
          return output
        },
        executeAfterPreflight: async () => { effects += 1; return { output, result } },
      })
      await bridge.execute(command())
      const changedGeneration = command()
      changedGeneration.request.launchAttempt.generation = 2
      changedGeneration.request.launchAttempt.continuationToken = 'changed-token'
      changedGeneration.continuation = true
      correlate(changedGeneration)
      await expect(bridge.execute(changedGeneration)).rejects.toThrow('exact replay mismatch')
      const changedMode = command(); changedMode.continuation = true
      correlate(changedMode)
      await expect(bridge.execute(changedMode)).rejects.toThrow()
      const changedToken = command(); changedToken.request.launchAttempt.continuationToken = 'changed-token'
      correlate(changedToken)
      await expect(bridge.execute(changedToken)).rejects.toThrow()
      expect(effects).toBe(0)
    }
  })

  test('absent ledger is the only path to the accepted core and durable projection', async () => {
    const calls: string[] = []
    const output = { snapshot, data: { launchAttempt: result } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async value => { calls.push('plan'); return value },
      inspect: async () => { calls.push('command-ledger'); return null },
      executeAfterPreflight: async () => {
        calls.push('core')
        return { output, result }
      },
    })

    await expect(bridge.execute(command())).resolves.toBe(output)
    expect(calls).toEqual(['plan', 'command-ledger', 'core'])
  })

  test('a hanging authorization is bounded by the one outer absolute deadline', async () => {
    const value = correlate({ ...command(), requestedBudgetMs: 250, outerRemainingBudgetMs: 250 })
    let authorizationSignal: AbortSignal | undefined
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async (_command, controls) => {
        authorizationSignal = controls.signal
        return new Promise<never>(() => {})
      },
      inspect: async () => { throw new Error('ledger must not run') },
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    })
    const started = performance.now()
    await expect(bridge.execute(value)).rejects.toThrow('absolute deadline')
    expect(authorizationSignal?.aborted).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test.skipIf(process.platform === 'win32')('canonicalizes aliases for mutations while request correlation retains exact path spelling', async () => {
    const project = path.join(projectPath, 'canonical-project')
    const alias = path.join(projectPath, 'canonical-alias')
    await mkdir(project); await symlink(project, alias)
    const observed: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0][] = []
    const output = { snapshot, data: { launchAttempt: { status: 'succeeded' } } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async value => { observed.push(value); return value },
      inspect: async () => output,
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    })

    await bridge.execute(correlate({ ...command(), projectPath: project }))
    await bridge.execute(correlate({ ...command(), projectPath: alias }))
    const correlatedAlias = {
      ...command(),
      projectPath: alias,
      requestProjectPath: alias,
      effectiveProfilePlanDigest: 'f'.repeat(64),
    }
    correlatedAlias.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(correlatedAlias)
    await bridge.execute(correlatedAlias)

    expect(observed).toHaveLength(3)
    expect(observed[0]!.projectPath).toBe(project)
    expect(observed[1]!.projectPath).toBe(project)
    expect(observed[0]!.projectIdentity).toBe(observed[1]!.projectIdentity)
    expect(computeOpenCodeLaunchCommandInputDigest(observed[0]!))
      .not.toBe(computeOpenCodeLaunchCommandInputDigest(observed[1]!))
    expect(observed[2]).toMatchObject({
      projectPath: project,
      projectIdentity: project,
      requestProjectPath: alias,
      effectiveProfilePlanDigest: 'f'.repeat(64),
    })
    expect(observed[2]!.request.launchAttempt.requestCorrelationDigest)
      .toBe(computeOpenCodeLaunchRequestCorrelationDigest(observed[2]!))
    const targets = observed.slice(0, 2).map(value => OpenCodeLaunchMutationLedger.targetDigest({
      teamId: value.teamId,
      laneId: value.laneId,
      projectIdentity: value.projectIdentity!,
      memberIdentity: value.members[0]!.memberIdentity,
    }))
    expect(targets[0]).toBe(targets[1])
    expect(OpenCodeLaunchMutationLedger.idempotencyIdentity(targets[0]!))
      .toBe(OpenCodeLaunchMutationLedger.idempotencyIdentity(targets[1]!))
  })

  test('retains exact whitespace-bearing path bytes while canonicalizing the production identity', async () => {
    const rawPath = ` ${projectPath} `
    const canonicalPath = path.join(projectPath, 'canonical-whitespace-project')
    const calls: string[] = []
    let authorized: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] | undefined
    const output = { snapshot, data: { launchAttempt: { status: 'succeeded' } } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async value => { calls.push('plan'); authorized = value; return value },
      inspect: async () => { calls.push('command-ledger'); return output },
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    }, { canonicalizeProject: async value => {
      calls.push(`realpath:${value}`)
      return canonicalPath
    } })
    const value = command()
    value.projectPath = rawPath
    value.requestProjectPath = rawPath
    value.request.launchAttempt.requestCorrelationDigest =
      computeOpenCodeLaunchRequestCorrelationDigest(value)

    await expect(bridge.execute(value)).resolves.toEqual(output)

    expect(calls).toEqual([`realpath:${rawPath}`, 'plan', 'command-ledger'])
    expect(authorized).toMatchObject({
      projectPath: canonicalPath,
      projectIdentity: canonicalPath,
      requestProjectPath: rawPath,
    })
    expect(authorized!.request.launchAttempt.requestCorrelationDigest)
      .toBe(computeOpenCodeLaunchRequestCorrelationDigest(authorized!))
  })

  test('an 80ms durable inspection cannot reset or extend the absolute envelope', async () => {
    let now = 1_000
    let inspectedDeadline = 0
    let executed: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] | undefined
    const output = { snapshot, data: { launchAttempt: result } }
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async (value, controls) => {
        expect(controls.deadlineAtMs).toBe(1_100)
        return value
      },
      inspect: async value => {
        inspectedDeadline = value.deadlineAtMs!
        now += 80
        return null
      },
      executeAfterPreflight: async value => {
        executed = value
        return { output, result }
      },
    }, { monotonicNow: () => now })
    const value = correlate({ ...command(), requestedBudgetMs: 100, outerRemainingBudgetMs: 100,
      deadlineAtMs: 1_100 })

    await expect(bridge.execute(value)).resolves.toBe(output)
    expect(inspectedDeadline).toBe(1_100)
    expect(executed?.deadlineAtMs).toBe(1_100)
    expect(executed?.outerRemainingBudgetMs).toBe(20)
    expect(executed!.deadlineAtMs! - now).toBe(20)
  })

  test('pre-cancellation bounds canonicalization and reaches no authorization or ledger work', async () => {
    const reason = new Error('caller cancelled')
    const controller = new AbortController(); controller.abort(reason)
    let canonicalCalls = 0
    const bridge = createOpenCodeLaunchAttemptProductionBridge({
      preflightAuthorization: async () => {},
      authorize: async () => { throw new Error('authorization must not run') },
      inspect: async () => { throw new Error('ledger must not run') },
      executeAfterPreflight: async () => { throw new Error('effects must not run') },
    }, { canonicalizeProject: async () => { canonicalCalls += 1; return new Promise<never>(() => {}) } })

    await expect(bridge.execute({ ...command(), signal: controller.signal })).rejects.toBe(reason)
    expect(canonicalCalls).toBe(1)
  })

  test('static child/grandchild runs through production bridge, real HostManager, durable receipt, native containment, and restart replay', async () => {
    if (process.platform !== 'linux' && process.platform !== 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-native-composition-'))
    const project = path.join(root, 'project')
    const data = path.join(root, 'data')
    const cache = path.join(root, 'cache')
    const userHome = path.join(root, 'home')
    await Promise.all([mkdir(project), mkdir(userHome)])
    const fixtureName = `opencode-host-fixture${process.platform === 'win32' ? '.exe' : ''}`
    const fixtureBinary = path.resolve(import.meta.dir, '../../../native/opencode-host-fixture/target/debug', fixtureName)
    const prior = { ...process.env }
    const restoreEnvironment = () => {
      for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key]
      Object.assign(process.env, prior)
    }
    try {
      process.env.CLAUDE_MULTIMODEL_DATA_HOME = data
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME = cache
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = fixtureBinary
      process.env.HOME = userHome
      process.env.USERPROFILE = userHome
      process.env.XDG_CONFIG_HOME = path.join(root, 'user-config')
      process.env.XDG_DATA_HOME = path.join(root, 'user-data')
      process.env.DEEPINFRA_API_KEY = 'static-fixture-key'
      if (process.platform !== 'win32') {
        process.env.PATH = ['/usr/bin', '/bin', process.env.PATH ?? ''].join(path.delimiter)
      }
      delete process.env.OPENCODE_CONFIG
      delete process.env.OPENCODE_CONFIG_CONTENT

      const profileManager = new OpenCodeProfileManager()
      const current = await profileManager.captureCurrentScopedProfilePlan({
        purpose: 'launch', providerId: 'deepinfra', modelId: 'deepinfra/static-model',
        runtimeInstanceId: result.attemptId, projectPath: project,
      })
      const value = command()
      value.projectPath = project
      value.selectedModel = 'deepinfra/static-model'
      value.request.launchAttempt.providerId = 'deepinfra'
      value.request.launchAttempt.modelId = 'deepinfra/static-model'
      value.request.launchAttempt.proofNonce = 'A'.repeat(22)
      value.preconditions.expectedBehaviorFingerprint = current.evidence.projectBehaviorFingerprint
      value.request.launchAttempt.requestCorrelationDigest = computeOpenCodeLaunchRequestCorrelationDigest(value)
      const sessionStore = new OpenCodeSessionStore(path.join(root, 'sessions.json'))
      const registryPath = path.join(data, 'opencode', 'hosts.json')
      let firstMcpObservedHostAlive: boolean | undefined
      const disconnectedMcp = { ensureAppMcp: async () => {
        if (firstMcpObservedHostAlive === undefined) {
          const childLine = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
            .trim().split('\n').find(line => line.startsWith('child:'))
          firstMcpObservedHostAlive = childLine !== undefined
            && isProcessAlive(Number(childLine.split(':')[1]))
        }
        return { mcp: {}, summary: {
          serverName: 'agent-teams', matchedServerName: null, status: 'missing', connected: false,
          launchSource: null, availableServerNames: [], diagnostics: ['static failure boundary'],
        } }
      } }
      let exactReleaseCalls = 0
      const createBridge = () => createOpenCodeLaunchAttemptProductionTestBridge({
        dataDirectory: data,
        profileManager,
        sessionStore,
        hostManager: new Proxy(new OpenCodeHostManager({ persistentRegistryPath: registryPath }), {
          get(target, property, receiver) {
            if (property === 'reconcileHostReleaseReceipt') return async (
              ...input: Parameters<OpenCodeHostManager['reconcileHostReleaseReceipt']>
            ) => {
              exactReleaseCalls += 1
              return target.reconcileHostReleaseReceipt(...input)
            }
            const member = Reflect.get(target, property, receiver)
            return typeof member === 'function' ? member.bind(target) : member
          },
        }),
        mcpManager: disconnectedMcp as never,
      })

      const first = await createBridge().execute(value)
      if (!projectedLaunchAttempt(first)) {
        const journal = await readFile(path.join(data, 'opencode', 'launch-attempts',
          `${value.request.launchAttempt.attemptId}.journal`), 'utf8').catch(() => 'missing journal')
        throw new Error(`missing launch result: ${JSON.stringify(first)} journal=${journal}`)
      }
      expect(projectedLaunchAttempt(first)).toMatchObject({ launchAttempt: { outcome: 'failed' } })
      expect(firstMcpObservedHostAlive).toBe(true)
      expect(exactReleaseCalls).toBe(1)
      const pidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
        .trim().split('\n')
      expect(pidLines.map(line => line.split(':')[0]).sort()).toEqual(['child', 'grandchild'])
      for (const line of pidLines) expect(isProcessAlive(Number(line.split(':')[1]))).toBe(false)

      const ledger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode', 'launch-attempts',
        `${value.request.launchAttempt.attemptId}.host-release.json`))
      const receipt = await ledger.read({ attemptId: value.request.launchAttempt.attemptId,
        payloadHash: value.request.launchAttempt.payloadHash, generation: 1 })
      expect(receipt).toMatchObject({ disposition: 'dispose', releaseState: 'complete' })
      await expect(readFile(registryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      // A new production runtime/HostManager must project the exact durable
      // outcome without reacquisition or a PID-only cleanup attempt.
      const replay = await createBridge().execute(value)
      expect(projectedLaunchAttempt(replay)).toEqual(projectedLaunchAttempt(first))

      // Hold a second real native acquisition after HostManager has returned
      // its exact capability, close the caller envelope, and only then expose
      // it to the production runtime. The caller-facing operation is already
      // cancelled, while the private physical settlement must still publish
      // the exact completed receipt and reap both fixture processes.
      const lateValue = structuredClone(value)
      lateValue.request.launchAttempt.attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee654321'
      lateValue.request.launchAttempt.payloadHash = 'e'.repeat(64)
      lateValue.request.launchAttempt.proofNonce = 'AQEBAQEBAQEBAQEBAQEBAQ'
      lateValue.request.launchAttempt.parent = {
        sessionIdentity: identity('e'), messageIdentity: identity('f'),
      }
      lateValue.members = [{ name: 'late', memberIdentity: identity('9') }]
      lateValue.preconditions.idempotencyKey = lateValue.request.launchAttempt.attemptId
      lateValue.preconditions.commandLeaseId = 'lease-late'
      const caller = new AbortController()
      lateValue.signal = caller.signal
      lateValue.request.launchAttempt.requestCorrelationDigest =
        computeOpenCodeLaunchRequestCorrelationDigest(lateValue)
      const physicalManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
      let exposeReference!: () => void
      const exposure = new Promise<void>(resolve => { exposeReference = resolve })
      let referenceReady!: () => void
      const atReference = new Promise<void>(resolve => { referenceReady = resolve })
      const delayedManager = new Proxy(physicalManager, {
        get(target, property, receiver) {
          if (property === 'ensureScopedHostReference') return async (...input: Parameters<OpenCodeHostManager['ensureScopedHostReference']>) => {
            const reference = await target.ensureScopedHostReference(...input)
            referenceReady()
            await exposure
            return reference
          }
          const member = Reflect.get(target, property, receiver)
          return typeof member === 'function' ? member.bind(target) : member
        },
      })
      const lateBridge = createOpenCodeLaunchAttemptProductionTestBridge({ dataDirectory: data,
        profileManager, sessionStore, hostManager: delayedManager,
        mcpManager: disconnectedMcp as never })
      const lateRun = lateBridge.execute(lateValue)
      await atReference
      caller.abort(new Error('static caller envelope closed after physical acquisition'))
      exposeReference()
      await lateRun.catch(() => undefined)
      const lateLedger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode', 'launch-attempts',
        `${lateValue.request.launchAttempt.attemptId}.host-release.json`))
      let lateReceipt = null
      // Physical release is bounded at five seconds, while the independent
      // private settlement retains ten seconds to publish its durable receipt.
      // Observe the full settlement bound without changing runtime behavior.
      for (let attempt = 0; attempt < 500; attempt += 1) {
        lateReceipt = await lateLedger.read({ attemptId: lateValue.request.launchAttempt.attemptId,
          payloadHash: lateValue.request.launchAttempt.payloadHash, generation: 1 }).catch(() => null)
        if (lateReceipt?.releaseState === 'complete') break
        await Bun.sleep(20)
      }
      expect(lateReceipt).toMatchObject({ disposition: 'dispose', releaseState: 'complete' })
      const allPidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
        .trim().split('\n')
      expect(allPidLines).toHaveLength(4)
      for (const line of allPidLines) expect(isProcessAlive(Number(line.split(':')[1]))).toBe(false)

      // A deterministic unhealthy response exercises failed-health rollback
      // through the same production composition. Exact native containment is
      // strongly reaped, so the bound acquisition obligation may be cleared.
      await writeFile(path.join(data, 'static-host-fixture.mode'), 'unhealthy\n')
      const unhealthyValue = structuredClone(value)
      unhealthyValue.request.launchAttempt.attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee666666'
      unhealthyValue.request.launchAttempt.payloadHash = '6'.repeat(64)
      unhealthyValue.request.launchAttempt.proofNonce = 'AwMDAwMDAwMDAwMDAwMDAw'
      unhealthyValue.request.launchAttempt.parent = {
        sessionIdentity: identity('3'), messageIdentity: identity('4'),
      }
      unhealthyValue.members = [{ name: 'unhealthy', memberIdentity: identity('6') }]
      unhealthyValue.preconditions.idempotencyKey = unhealthyValue.request.launchAttempt.attemptId
      unhealthyValue.preconditions.commandLeaseId = 'lease-unhealthy'
      unhealthyValue.request.launchAttempt.requestCorrelationDigest =
        computeOpenCodeLaunchRequestCorrelationDigest(unhealthyValue)
      const unhealthy = await createBridge().execute(unhealthyValue)
      expect(projectedLaunchAttempt(unhealthy)).toMatchObject({ launchAttempt: { outcome: 'failed' } })
      const unhealthyLedger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode',
        'launch-attempts', `${unhealthyValue.request.launchAttempt.attemptId}.host-release.json`))
      expect(await unhealthyLedger.read({ attemptId: unhealthyValue.request.launchAttempt.attemptId,
        payloadHash: unhealthyValue.request.launchAttempt.payloadHash, generation: 1 })).toBeNull()
      const unhealthyPidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
        .trim().split('\n').slice(4)
      expect(unhealthyPidLines).toHaveLength(2)
      for (const line of unhealthyPidLines) expect(isProcessAlive(Number(line.split(':')[1]))).toBe(false)

      if (process.platform === 'linux') {
      // Fail before health after the native leader has exited while its
      // TERM-resistant grandchild remains in the owned containment unit. The
      // actual production acquisition must turn the prepublished obligation
      // into an immutable pending receipt, and a fresh runtime may project
      // only the durable incomplete terminal until exact native proof exists.
      await writeFile(path.join(data, 'static-host-fixture.mode'), 'leader-exit\n')
      const failedValue = structuredClone(value)
      failedValue.request.launchAttempt.attemptId = '018f47a2-4a13-7c2f-8d44-c0ffee777777'
      failedValue.request.launchAttempt.payloadHash = '7'.repeat(64)
      failedValue.request.launchAttempt.proofNonce = 'AgICAgICAgICAgICAgICAg'
      failedValue.request.launchAttempt.parent = {
        sessionIdentity: identity('5'), messageIdentity: identity('6'),
      }
      failedValue.members = [{ name: 'failed-startup', memberIdentity: identity('7') }]
      failedValue.preconditions.idempotencyKey = failedValue.request.launchAttempt.attemptId
      failedValue.preconditions.commandLeaseId = 'lease-failed-startup'
      failedValue.requestedBudgetMs = 10_000
      failedValue.outerRemainingBudgetMs = 10_000
      failedValue.request.launchAttempt.requestCorrelationDigest =
        computeOpenCodeLaunchRequestCorrelationDigest(failedValue)
      // Keep this manager for the post-kill retry. The separate-process case
      // below covers restart semantics; here the live manager still owns the
      // exact receipt capability and must settle it once the non-signalling
      // Linux observer proves that the killed descendant left no live member.
      const failedHostManager = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
      const failedBridge = createOpenCodeLaunchAttemptProductionTestBridge({ dataDirectory: data,
        profileManager, sessionStore, hostManager: failedHostManager,
        mcpManager: disconnectedMcp as never })
      const failed = await failedBridge.execute(failedValue)
      expect(projectedLaunchAttempt(failed)).toMatchObject({ launchAttempt: { outcome: 'failed' } })
      const failedLedger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode',
        'launch-attempts', `${failedValue.request.launchAttempt.attemptId}.host-release.json`))
      let failedReceipt = null
      for (let attempt = 0; attempt < 100; attempt += 1) {
        failedReceipt = await failedLedger.read({ attemptId: failedValue.request.launchAttempt.attemptId,
          payloadHash: failedValue.request.launchAttempt.payloadHash, generation: 1 }).catch(() => null)
        if (failedReceipt) break
        await Bun.sleep(20)
      }
      expect(failedReceipt)
        .toMatchObject({ disposition: 'dispose', releaseState: 'pending' })
      let blockedReplay: Awaited<ReturnType<typeof failedBridge.execute>> | undefined
      for (let attempt = 0; attempt < 100 && blockedReplay === undefined; attempt += 1) {
        try { blockedReplay = await failedBridge.execute(failedValue) }
        catch (error) {
          if (!(error instanceof Error)
            || !/(?:read-only .*changed|changed during pre-authorization cleanup snapshot)/
              .test(error.message)) throw error
          await Bun.sleep(20)
        }
      }
      expect(blockedReplay).toBeDefined()
      expect(projectedLaunchAttempt(blockedReplay!)).toEqual(projectedLaunchAttempt(failed))
      expect(await failedLedger.read({ attemptId: failedValue.request.launchAttempt.attemptId,
        payloadHash: failedValue.request.launchAttempt.payloadHash, generation: 1 }))
        .toMatchObject({ disposition: 'dispose', releaseState: 'pending' })
      const failedPidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
        .trim().split('\n').slice(6)
      expect(failedPidLines.map(line => line.split(':')[0]).sort()).toEqual(['child', 'grandchild'])
      const failedGrandchild = Number(failedPidLines.find(line => line.startsWith('grandchild:'))!
        .split(':')[1])
      expect(isProcessAlive(failedGrandchild)).toBe(true)
      process.kill(failedGrandchild, 'SIGKILL')
      for (let attempt = 0; attempt < 100 && isProcessAlive(failedGrandchild); attempt += 1) {
        await Bun.sleep(10)
      }
      await failedBridge.execute(failedValue)
      expect(await failedLedger.read({ attemptId: failedValue.request.launchAttempt.attemptId,
        payloadHash: failedValue.request.launchAttempt.payloadHash, generation: 1 }))
        .toMatchObject({ disposition: 'dispose', releaseState: 'complete' })

      }
    } finally {
      restoreEnvironment()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test('separate acquisition and replay processes repair receipt and disposition publication crash boundaries', async () => {
    if (process.platform !== 'linux' && process.platform !== 'win32') return
    const fixtureName = `opencode-host-fixture${process.platform === 'win32' ? '.exe' : ''}`
    const fixtureBinary = path.resolve(import.meta.dir,
      '../../../native/opencode-host-fixture/target/debug', fixtureName)
    const fixtureScript = path.resolve(import.meta.dir,
      'OpenCodeLaunchAttemptProductionRestartFixture.ts')
    const boundaries = ['crash-after-receipt', 'crash-before-disposition'] as const
    for (const boundary of boundaries) {
      const root = await mkdtemp(path.join(os.tmpdir(), `opencode-${boundary}-`))
      const project = path.join(root, 'project')
      const data = path.join(root, 'data')
      const userHome = path.join(root, 'home')
      const fixtureSystemRoot = path.join(root, 'system-root')
      const runPhase = (phase: typeof boundary | 'replay') => new Promise<{
        code: number | null; output: string
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [fixtureScript, phase], {
          env: { ...process.env, OPENCODE_RESTART_FIXTURE_ROOT: root,
            ...(process.platform === 'win32' ? { SystemRoot: fixtureSystemRoot } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        child.stdout?.on('data', chunk => { output += String(chunk) })
        child.stderr?.on('data', chunk => { output += String(chunk) })
        child.once('error', reject)
        child.once('exit', code => resolve({ code, output }))
      })
      try {
        await Promise.all([mkdir(project), mkdir(userHome), mkdir(data, { recursive: true })])
        if (process.platform === 'win32') {
          await mkdir(path.join(fixtureSystemRoot, 'System32'), { recursive: true })
          await copyFile(fixtureBinary, path.join(fixtureSystemRoot, 'System32', 'taskkill.exe'))
        }
        await writeFile(path.join(data, 'static-host-fixture.mode'), '\n')
        const crashed = await runPhase(boundary)
        expect(crashed.code, crashed.output).toBe(86)

        const attempt = '018f47a2-4a13-7c2f-8d44-c0ffee777777'
        const ledger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode',
          'launch-attempts', `${attempt}.host-release.json`))
        const beforeReplay = await ledger.read({ attemptId: attempt,
          payloadHash: '7'.repeat(64), generation: 1 })
        expect(beforeReplay).toMatchObject({ disposition: 'unknown', releaseState: 'pending' })
        const journalPath = path.join(data, 'opencode', 'launch-attempts', `${attempt}.journal`)
        const journalManifest = JSON.parse(await readFile(journalPath, 'utf8'))
        const journal = JSON.parse(await readFile(`${journalPath}.slot${journalManifest.slot}`, 'utf8'))
        const durableBinding = journal.hostCleanupObligations.find(
          (item: { obligationId: string }) => item.obligationId === beforeReplay!.obligationId)
        expect(durableBinding).toMatchObject({ obligationId: beforeReplay!.obligationId,
          reservationDigest: beforeReplay!.reservationDigest })
        if (boundary === 'crash-after-receipt') {
          expect(durableBinding.receiptIdentityDigest).toBeUndefined()
        } else {
          expect(durableBinding.receiptIdentityDigest).toBe(beforeReplay!.receiptIdentityDigest)
        }

        const replayed = await runPhase('replay')
        expect(replayed.code, replayed.output).toBe(0)
        const records = await ledger.readAllPending({ attemptId: attempt,
          payloadHash: '7'.repeat(64), currentGeneration: 1 })
        const repaired = records.find(record => record.obligationId === beforeReplay!.obligationId)
        expect(repaired).toMatchObject({
          obligationId: beforeReplay!.obligationId,
          reservationDigest: beforeReplay!.reservationDigest,
          receiptIdentityDigest: beforeReplay!.receiptIdentityDigest,
          disposition: 'dispose',
          releaseState: process.platform === 'linux' ? 'complete' : 'pending',
        })
        const reboundManifest = JSON.parse(await readFile(journalPath, 'utf8'))
        const reboundJournal = JSON.parse(await readFile(
          `${journalPath}.slot${reboundManifest.slot}`, 'utf8'))
        expect(reboundJournal.hostCleanupObligations).toContainEqual({
          obligationId: beforeReplay!.obligationId,
          reservationDigest: beforeReplay!.reservationDigest,
          receiptIdentityDigest: beforeReplay!.receiptIdentityDigest,
        })
      } finally {
        const lines = await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8')
          .catch(() => '')
        for (const line of lines.trim().split('\n')) {
          const pid = Number(line.split(':')[1])
          if (pid > 0 && isProcessAlive(pid)) {
            try { process.kill(pid, 'SIGKILL') } catch {}
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  }, 30_000)

  test.skipIf(!canExerciseNativePidRecycle)(
    'native cleanup acquisition and replay use separate OS processes with no retained authority', async () => {
    if (process.platform !== 'linux' && process.platform !== 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-native-process-restart-'))
    const project = path.join(root, 'project')
    const data = path.join(root, 'data')
    const userHome = path.join(root, 'home')
    const fixtureName = `opencode-host-fixture${process.platform === 'win32' ? '.exe' : ''}`
    const fixtureBinary = path.resolve(import.meta.dir,
      '../../../native/opencode-host-fixture/target/debug', fixtureName)
    const fixtureScript = path.resolve(import.meta.dir,
      'OpenCodeLaunchAttemptProductionRestartFixture.ts')
    const fixtureSystemRoot = path.join(root, 'system-root')
    const runPhase = (phase: 'acquire' | 'replay') => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fixtureScript, phase], {
        env: { ...process.env, OPENCODE_RESTART_FIXTURE_ROOT: root,
          ...(process.platform === 'win32' ? { SystemRoot: fixtureSystemRoot } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout?.on('data', chunk => { output += String(chunk) })
      child.stderr?.on('data', chunk => { output += String(chunk) })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve()
        : reject(new Error(`restart fixture ${phase} exited ${code}: ${output}`)))
    })
    let recycledLeaderBirthToken: string | null = null
    try {
      await Promise.all([mkdir(project), mkdir(userHome)])
      await mkdir(data, { recursive: true })
      if (process.platform === 'win32') {
        await mkdir(path.join(fixtureSystemRoot, 'System32'), { recursive: true })
        await copyFile(fixtureBinary, path.join(fixtureSystemRoot, 'System32', 'taskkill.exe'))
      }
      await writeFile(path.join(data, 'static-host-fixture.mode'), '\n')
      await runPhase('acquire')
      const acquired = JSON.parse(await readFile(path.join(root, 'restart-acquire.json'), 'utf8'))
      expect(acquired).toMatchObject({ outcome: 'failed', disposition: 'dispose',
        releaseState: 'pending' })
      expect(acquired.reservationDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(acquired.receiptIdentityDigest).toMatch(/^[a-f0-9]{64}$/)
      const pidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
        .trim().split('\n')
      const leaderPid = Number(pidLines.find(line => line.startsWith('child:'))!.split(':')[1])
      const grandchildPid = Number(pidLines.find(line => line.startsWith('grandchild:'))!.split(':')[1])
      expect(leaderPid).toBe(acquired.pid)

      if (process.platform === 'linux') {
        process.kill(leaderPid, 'SIGKILL')
        process.kill(grandchildPid, 'SIGKILL')
        for (let attempt = 0; attempt < 200 && isProcessAlive(leaderPid); attempt += 1) {
          await Bun.sleep(10)
        }
        for (let attempt = 0; attempt < 200 && isProcessAlive(grandchildPid); attempt += 1) {
          await Bun.sleep(10)
        }
        // Namespace PID 1 reaps these exact adopted zombies, stops Bun's
        // process group, and performs one receipt-bound recycled fork/exec.
        expect(await requestExactNativePidRecycle(leaderPid, grandchildPid, data)).toBe(leaderPid)
        recycledLeaderBirthToken = readProcessBirthToken(leaderPid, 'linux')
        expect(recycledLeaderBirthToken).not.toBeNull()
        expect(recycledLeaderBirthToken).not.toBe(acquired.processBirthToken)
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const lines = await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8')
          if (lines.includes('recycled-follower:')) break
          await Bun.sleep(10)
        }
      }

      await runPhase('replay')
      const replayed = JSON.parse(await readFile(path.join(root, 'restart-replay.json'), 'utf8'))
      expect(replayed).toMatchObject({ outcome: 'failed', disposition: 'dispose',
        releaseState: 'pending', obligationId: acquired.obligationId,
        reservationDigest: acquired.reservationDigest,
        receiptIdentityDigest: acquired.receiptIdentityDigest })
      const registry = JSON.parse(await readFile(path.join(data, 'opencode', 'hosts.json'), 'utf8'))
      const retainedRegistryRecords = Object.values(registry.hosts) as Array<{
        pid: number; processBirthToken?: string; scopedIdentityBinding?: string
      }>
      expect(retainedRegistryRecords).toHaveLength(1)
      expect(retainedRegistryRecords[0]).toMatchObject({ pid: acquired.pid })
      expect(retainedRegistryRecords[0]!.scopedIdentityBinding).toMatch(/^[a-f0-9]{64}$/)
      if (acquired.processBirthToken) {
        expect(retainedRegistryRecords[0]!.processBirthToken).toBe(acquired.processBirthToken)
      }
      if (process.platform === 'linux') {
        const replayPidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
          .trim().split('\n')
        const recycledFollowerPid = Number(replayPidLines
          .find(line => line.startsWith('recycled-follower:'))!.split(':')[1])
        // The recycled leader resists TERM while its follower does not. A
        // negative-PGID mutation would kill the follower and a direct KILL
        // would kill the recycled leader. Both remaining alive proves the
        // changed-native-birth branch made zero containment mutation.
        expect(isProcessAlive(leaderPid)).toBe(true)
        expect(isProcessAlive(recycledFollowerPid)).toBe(true)
        expect(readProcessBirthToken(leaderPid, 'linux')).toBe(recycledLeaderBirthToken)
      } else {
        // The acquisition process owned the launcher/job. Replay is a genuinely
        // fresh process without that handle and must leave the exact receipt pending.
        expect(replayed.releaseState).toBe('pending')
        const replayPidLines = (await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8'))
          .trim().split('\n')
        expect(replayPidLines.some(line => line.startsWith('taskkill-mutation:'))).toBe(false)
      }
    } finally {
      const lines = await readFile(path.join(data, 'static-host-fixture.pids'), 'utf8')
        .catch(() => '')
      for (const line of lines.trim().split('\n')) {
        const pid = Number(line.split(':')[1])
        if (pid > 0 && isProcessAlive(pid)) {
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      }
      await rm(root, { recursive: true, force: true })
    }
    }, 30_000)
})
