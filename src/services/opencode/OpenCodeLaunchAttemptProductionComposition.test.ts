import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
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
import { isProcessAlive } from '../../utils/processKill.js'
import type { OpenCodeProvisioningSnapshot } from './types.js'

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
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
let projectPath = ''
beforeAll(async () => { projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-composition-')) })
afterAll(async () => { await rm(projectPath, { recursive: true, force: true }) })

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
  for (const status of ['succeeded', 'reconciliation_required'] as const) {
    test(`durable ${status} gate runs before every profile, host, and member effect`, async () => {
      const calls: string[] = []
      const output = { snapshot, data: { launchAttempt: { status }, durable: true } }
      const bridge = createOpenCodeLaunchAttemptProductionBridge({
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
      const disconnectedMcp = { ensureAppMcp: async () => ({ mcp: {}, summary: {
        serverName: 'agent-teams', matchedServerName: null, status: 'missing', connected: false,
        launchSource: null, availableServerNames: [], diagnostics: ['static failure boundary'],
      } }) }
      const createBridge = () => createOpenCodeLaunchAttemptProductionTestBridge({
        dataDirectory: data,
        profileManager,
        sessionStore,
        hostManager: new OpenCodeHostManager({ persistentRegistryPath: registryPath }),
        mcpManager: disconnectedMcp as never,
      })

      const first = await createBridge().execute(value)
      if (!first.data?.launchAttempt) {
        const journal = await readFile(path.join(data, 'opencode', 'launch-attempts',
          `${value.request.launchAttempt.attemptId}.journal`), 'utf8').catch(() => 'missing journal')
        throw new Error(`missing launch result: ${JSON.stringify(first)} journal=${journal}`)
      }
      expect(first.data?.launchAttempt).toMatchObject({ launchAttempt: { outcome: 'failed' } })
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
      expect(replay.data?.launchAttempt).toEqual(first.data?.launchAttempt)

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
      for (let attempt = 0; attempt < 100; attempt += 1) {
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
    } finally {
      restoreEnvironment()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
