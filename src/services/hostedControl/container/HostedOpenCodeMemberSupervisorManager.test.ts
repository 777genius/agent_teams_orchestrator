import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { HostedOpenCodeMemberSupervisorManager, type HostedMemberSupervisorManagerOptions } from './HostedOpenCodeMemberSupervisorManager.js'
import type { HostedMemberNetworkProvisioner, HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'

const SHA = 'a'.repeat(64)
const A: HostedMemberNetworkRequest = {
  operationId: 'operation_a123', planTeamId: 'plan_team123', planFingerprint: SHA,
  runId: 'run_test123', teamId: 'team_test123', laneId: 'lane_test123', memberId: 'member_a123',
}
const B: HostedMemberNetworkRequest = { ...A, operationId: 'operation_b123', memberId: 'member_b123' }
const lookup = (request: HostedMemberNetworkRequest) => ({
  ...request, memberOperationId: request.operationId, operationId: 'lookup_member123',
})
const NETWORK_A = '1'.repeat(64)
const NETWORK_B = '2'.repeat(64)
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const stateDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-member-manager-')))
  directories.push(stateDirectory)
  const created: string[] = []
  const stopped: string[] = []
  const cleaned: string[] = []
  const started: string[] = []
  const supervisors: string[] = []
  const network = {
    provision: async (request: HostedMemberNetworkRequest) => {
      created.push(request.operationId)
      return request.operationId === A.operationId ? NETWORK_A : NETWORK_B
    },
    reconcile: async () => { throw new Error('unexpected-reconcile') },
    cleanup: async (request: HostedMemberNetworkRequest) => { cleaned.push(request.operationId) },
  }
  let admitted = true
  let fenced = true
  let cleanupAllowed = true
  const options: HostedMemberSupervisorManagerOptions = {
    stateDirectory, network: network as unknown as HostedMemberNetworkProvisioner,
    supervisorOptions: { testOnlyAllowNonRoot: true } as HostedMemberSupervisorManagerOptions['supervisorOptions'],
    admitMember: async () => admitted,
    assertEffectFence: async () => fenced,
    assertCleanupAuthority: async () => cleanupAllowed,
    testOnlySupervisorFactory: async options => {
      supervisors.push(`${options.networkId}:${options.stateDirectory}`)
      const isA = options.networkId === NETWORK_A
      const operationId = isA ? A.operationId : B.operationId
      const handle = `opencode_${(isA ? 'a' : 'b').repeat(32)}`
      const generation = isA ? 'a'.repeat(32) : 'b'.repeat(32)
      return {
        prepareMember: async () => ({ operationId, receiptId: isA ? 'c'.repeat(32) : 'd'.repeat(32),
          handle, generation, connector: { pid: isA ? 101 : 102, startTicks: '100' } }),
        startPrepared: async () => { started.push(operationId); return { handle, generation,
          status: 'started' as const, effectEnabled: false } },
        observe: async () => ({ handle, generation, status: 'running' as const, effectEnabled: false }),
        stop: async () => { stopped.push(operationId); return { handle, generation, stopped: true, unresolved: false } },
      }
    },
  }
  return { options, stateDirectory, created, stopped, cleaned, started, supervisors,
    denyAdmission: () => { admitted = false }, denyFence: () => { fenced = false },
    denyCleanup: () => { cleanupAllowed = false } }
}

describe('HostedOpenCodeMemberSupervisorManager', () => {
  test('exact root lookup survives restart and returns only pinned member state', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await manager.lookupManagedMember(lookup(A))).toBeNull()
    const receipt = await manager.prepareMember(A)
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const identity = { memberOperationId: A.operationId, receiptId: receipt.receiptId,
      handle: receipt.handle, generation: receipt.generation }
    expect(await restarted.lookupManagedMember(lookup(A))).toEqual({ ...identity, state: 'prepared' })
    expect(f.created).toEqual([A.operationId])
    expect(f.supervisors).toHaveLength(1)
    expect(f.started).toEqual([])
    await restarted.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId })
    const afterStart = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await afterStart.lookupManagedMember(lookup(A))).toEqual({ ...identity, state: 'started' })
    expect(f.started).toEqual([A.operationId])
    await afterStart.stop({ memberOperationId: A.operationId, operationId: 'stop_lookup123',
      handle: receipt.handle, generation: receipt.generation })
    const afterStop = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await afterStop.lookupManagedMember(lookup(A))).toEqual({ ...identity, state: 'stopped' })
    await expect(afterStop.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId }))
      .rejects.toThrow('hosted-member-already-stopped')
    expect(f.started).toEqual([A.operationId])
  })

  test('ambiguous Start is durably unresolved and lookup never reissues it', async () => {
    const f = await fixture()
    const factory = f.options.testOnlySupervisorFactory!
    const calls: string[] = []
    const options = { ...f.options, testOnlySupervisorFactory: async (
      settings: Parameters<typeof factory>[0]) => {
      const supervisor = await factory(settings)
      return { ...supervisor, startPrepared: async (input: { operationId: string; receiptId: string }) => {
        calls.push(input.operationId)
        throw new Error('simulated-uncertain-reply')
      } }
    } } satisfies HostedMemberSupervisorManagerOptions
    const manager = await HostedOpenCodeMemberSupervisorManager.create(options)
    const receipt = await manager.prepareMember(A)
    await expect(manager.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId }))
      .rejects.toThrow('simulated-uncertain-reply')
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(options)
    expect(await restarted.lookupManagedMember(lookup(A))).toEqual({
      memberOperationId: A.operationId, receiptId: receipt.receiptId,
      handle: receipt.handle, generation: receipt.generation, state: 'unresolved',
    })
    expect(await restarted.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId }))
      .toMatchObject({ status: 'unresolved', effectEnabled: false })
    expect(calls).toEqual([A.operationId])
  })

  test('concurrent Start cannot borrow another receipt or mutate its queued request', async () => {
    const f = await fixture()
    const factory = f.options.testOnlySupervisorFactory!
    let entered!: () => void
    let release!: () => void
    const startEntered = new Promise<void>(resolve => { entered = resolve })
    const holdStart = new Promise<void>(resolve => { release = resolve })
    const manager = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlySupervisorFactory: async options => {
        const supervisor = await factory(options)
        return { ...supervisor, startPrepared: async input => {
          entered()
          await holdStart
          return supervisor.startPrepared(input)
        } }
      },
    })
    const receipt = await manager.prepareMember(A)
    const first = manager.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId })
    await startEntered
    const foreign = manager.startPrepared({ operationId: A.operationId, receiptId: 'f'.repeat(32) })
    release()
    await expect(foreign).rejects.toThrow('hosted-member-receipt-unbound')
    await expect(first).resolves.toMatchObject({ handle: receipt.handle })
    expect(f.started).toEqual([A.operationId])

    const other = await fixture()
    const queued = await HostedOpenCodeMemberSupervisorManager.create(other.options)
    const next = await queued.prepareMember(A)
    const input = { operationId: A.operationId, receiptId: next.receiptId }
    const starting = queued.startPrepared(input)
    input.receiptId = 'f'.repeat(32)
    await expect(starting).resolves.toMatchObject({ handle: next.handle })
    expect(other.started).toEqual([A.operationId])
  })

  test('a terminal stop before Start cannot later activate the prepared member', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await manager.prepareMember(A)
    await manager.stop({ memberOperationId: A.operationId, operationId: 'stop_prepared123',
      handle: receipt.handle, generation: receipt.generation })
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await expect(restarted.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId }))
      .rejects.toThrow('hosted-member-already-stopped')
    expect(await restarted.lookupManagedMember(lookup(A))).toMatchObject({ state: 'stopped' })
    expect(f.started).toEqual([])
  })

  test('concurrent Stop wins over a later Start in the same root manager', async () => {
    const f = await fixture()
    const factory = f.options.testOnlySupervisorFactory!
    let entered!: () => void
    let release!: () => void
    const stopEntered = new Promise<void>(resolve => { entered = resolve })
    const holdStop = new Promise<void>(resolve => { release = resolve })
    const manager = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlySupervisorFactory: async options => {
        const supervisor = await factory(options)
        return { ...supervisor, stop: async request => {
          entered()
          await holdStop
          return supervisor.stop(request)
        } }
      },
    })
    const receipt = await manager.prepareMember(A)
    const stopping = manager.stop({ memberOperationId: A.operationId, operationId: 'stop_race123',
      handle: receipt.handle, generation: receipt.generation })
    await stopEntered
    const starting = manager.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId })
    release()
    await stopping
    await expect(starting).rejects.toThrow('hosted-member-already-stopped')
    expect(f.started).toEqual([])
  })

  test('lookup rejects a foreign tuple, substituted receipt, and revoked authority', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await manager.prepareMember(A)
    await expect(manager.lookupManagedMember({ ...lookup(A), memberId: B.memberId }))
      .rejects.toThrow('hosted-member-lookup-binding-conflict')
    await expect(manager.lookupManagedMember({ ...lookup(A), planFingerprint: 'b'.repeat(64) }))
      .rejects.toThrow('hosted-member-lookup-binding-conflict')
    f.denyAdmission()
    f.denyCleanup()
    await expect(manager.lookupManagedMember(lookup(A))).rejects.toThrow('hosted-member-lookup-authority-denied')
    const file = path.join(f.stateDirectory, `receipt-${A.operationId}.json`)
    const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    await writeFile(file, JSON.stringify({ ...stored, handle: `opencode_${'e'.repeat(32)}` }))
    const restarted = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      admitMember: async () => true })
    await expect(restarted.lookupManagedMember(lookup(A))).rejects.toThrow('hosted-member-receipt-index-invalid')
    expect(receipt.handle).not.toBe(`opencode_${'e'.repeat(32)}`)
    expect(f.started).toEqual([])
  })
  test('two concurrent members keep distinct internal network IDs, supervisor directories and exact handle routes', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const [a, b] = await Promise.all([manager.prepareMember(A), manager.prepareMember(B)])
    expect(a.handle).not.toBe(b.handle)
    expect(f.created.sort()).toEqual([A.operationId, B.operationId])
    expect(new Set(f.supervisors.map(value => value.split(':')[0]))).toEqual(new Set([NETWORK_A, NETWORK_B]))
    expect(new Set(f.supervisors.map(value => value.split(':')[1])).size).toBe(2)
    expect((await readdir(f.stateDirectory)).filter(name => name.startsWith('supervisor-')).sort())
      .toEqual([`supervisor-${A.operationId}`, `supervisor-${B.operationId}`])
    expect(await manager.startPrepared({ operationId: A.operationId, receiptId: a.receiptId }))
      .toMatchObject({ handle: a.handle, generation: a.generation })
    expect(await manager.startPrepared({ operationId: B.operationId, receiptId: b.receiptId }))
      .toMatchObject({ handle: b.handle, generation: b.generation })
    await expect(manager.stop({ memberOperationId: B.operationId, operationId: 'stop_wrong123',
      handle: a.handle, generation: a.generation })).rejects.toThrow('hosted-member-handle-unbound')
    await expect(manager.observe({ memberOperationId: A.operationId, operationId: 'observe_wrong123',
      handle: a.handle, generation: b.generation })).rejects.toThrow('hosted-member-handle-unbound')
    expect(await manager.stop({ memberOperationId: A.operationId, operationId: 'stop_member123',
      handle: a.handle, generation: a.generation })).toMatchObject({ stopped: true })
    expect(f.stopped).toEqual([A.operationId])
    expect(f.cleaned).toEqual([A.operationId])
    expect(await manager.observe({ memberOperationId: B.operationId, operationId: 'observe_member123',
      handle: b.handle, generation: b.generation })).toMatchObject({ status: 'running', handle: b.handle })

    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await restarted.observe({ memberOperationId: B.operationId, operationId: 'observe_restart123',
      handle: b.handle, generation: b.generation })).toMatchObject({ status: 'running', handle: b.handle })
    expect(f.created).toHaveLength(2)
  })

  test('uncertain network create is recovered by reconcile without issuing a second Docker create', async () => {
    const f = await fixture()
    let dockerCreates = 0
    let claimed = false
    f.options.network.provision = async () => {
      if (claimed) throw new Error('hosted-network-operation-already-claimed')
      claimed = true
      dockerCreates++
      throw new Error('hosted-network-create-unresolved')
    }
    f.options.network.reconcile = async () => NETWORK_A
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await expect(manager.prepareMember(A)).rejects.toThrow('hosted-network-create-unresolved')
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await restarted.prepareMember(A)).toMatchObject({ operationId: A.operationId })
    expect(dockerCreates).toBe(1)
  })

  test('a member cannot be rebound to another operation or share a network ID', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await manager.prepareMember(A)
    const replay: HostedMemberNetworkRequest = { ...A, operationId: 'operation_replay123' }
    await expect(manager.prepareMember(replay)).rejects.toThrow('hosted-member-already-owned')
    expect(f.created).toEqual([A.operationId])

    f.options.network.provision = async () => NETWORK_A
    await expect(manager.prepareMember(B)).rejects.toThrow('hosted-member-network-already-owned')
    expect(f.supervisors).toHaveLength(1)
  })

  test('unresolved network reconciliation never opens a supervisor', async () => {
    const f = await fixture()
    let claimed = false
    f.options.network.provision = async () => {
      if (claimed) throw new Error('hosted-network-operation-already-claimed')
      claimed = true
      throw new Error('hosted-network-create-unresolved')
    }
    f.options.network.reconcile = async () => { throw new Error('hosted-network-unresolved') }
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await expect(manager.prepareMember(A)).rejects.toThrow('hosted-network-create-unresolved')
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await expect(restarted.prepareMember(A)).rejects.toThrow('hosted-network-unresolved')
    expect(f.supervisors).toEqual([])
  })

  test('missing or denied Product authority prevents positive effects, while separate cleanup authority controls stop', async () => {
    const f = await fixture()
    await expect(HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      assertEffectFence: undefined as never })).rejects.toThrow('hosted-member-product-authority-required')
    await expect(HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      assertCleanupAuthority: undefined as never })).rejects.toThrow('hosted-member-cleanup-authority-required')
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    f.denyAdmission()
    await expect(manager.prepareMember(A)).rejects.toThrow('hosted-member-product-authority-denied')
    expect(f.created).toEqual([])
    const g = await fixture()
    const second = await HostedOpenCodeMemberSupervisorManager.create(g.options)
    const receipt = await second.prepareMember(A)
    g.denyFence()
    await expect(second.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId }))
      .rejects.toThrow('hosted-member-product-authority-denied')
    g.denyCleanup()
    await expect(second.stop({ memberOperationId: A.operationId, operationId: 'stop_denied123',
      handle: receipt.handle, generation: receipt.generation }))
      .rejects.toThrow('hosted-member-cleanup-authority-denied')
    expect(g.stopped).toEqual([])
    expect(g.cleaned).toEqual([])
  })

  test('revoked positive admission still permits exact root-authorized stop, including after restart', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const a = await manager.prepareMember(A)
    const b = await manager.prepareMember(B)
    await manager.startPrepared({ operationId: A.operationId, receiptId: a.receiptId })
    await manager.startPrepared({ operationId: B.operationId, receiptId: b.receiptId })
    f.denyAdmission()
    f.denyFence()
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    await expect(restarted.stop({ memberOperationId: B.operationId, operationId: 'stop_wrong123',
      handle: a.handle, generation: a.generation })).rejects.toThrow('hosted-member-handle-unbound')
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_revoked123',
      handle: a.handle, generation: a.generation })).toMatchObject({ stopped: true, unresolved: false })
    expect(f.stopped).toEqual([A.operationId])
    expect(f.cleaned).toEqual([A.operationId])
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_replay123',
      handle: a.handle, generation: a.generation })).toMatchObject({ stopped: true, unresolved: false })
    expect(f.stopped).toEqual([A.operationId])
    expect(f.cleaned).toEqual([A.operationId, A.operationId])
    await expect(restarted.observe({ memberOperationId: B.operationId, operationId: 'observe_revoked123',
      handle: b.handle, generation: b.generation })).rejects.toThrow('hosted-member-product-authority-denied')
  })

  test('failed network cleanup retries from terminal stop without stopping or opening supervisor again', async () => {
    const f = await fixture()
    const manager = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await manager.prepareMember(A)
    let cleanupCalls = 0
    f.options.network.cleanup = async () => {
      cleanupCalls++
      if (cleanupCalls === 1) throw new Error('hosted-network-cleanup-unresolved')
    }
    await expect(manager.stop({ memberOperationId: A.operationId, operationId: 'stop_first123',
      handle: receipt.handle, generation: receipt.generation })).rejects.toThrow('hosted-network-cleanup-unresolved')
    expect(f.stopped).toEqual([A.operationId])
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_retry123',
      handle: receipt.handle, generation: receipt.generation })).toMatchObject({ stopped: true, unresolved: false })
    expect(f.stopped).toEqual([A.operationId])
    expect(f.supervisors).toHaveLength(1)
    expect(cleanupCalls).toBe(2)
  })

  test('unresolved supervisor stop never authorizes network cleanup', async () => {
    const f = await fixture()
    const factory = f.options.testOnlySupervisorFactory!
    const manager = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlySupervisorFactory: async options => {
        const supervisor = await factory(options)
        return { ...supervisor, stop: async request => ({ handle: request.handle,
          generation: request.generation, stopped: false, unresolved: true }) }
      },
    })
    const receipt = await manager.prepareMember(A)
    expect(await manager.stop({ memberOperationId: A.operationId, operationId: 'stop_uncertain123',
      handle: receipt.handle, generation: receipt.generation }))
      .toMatchObject({ stopped: false, unresolved: true })
    expect(f.cleaned).toEqual([])
    expect((await readdir(f.stateDirectory)).some(name => name === `stop-terminal-${A.operationId}.json`)).toBe(false)
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_recovery123',
      handle: receipt.handle, generation: receipt.generation })).toMatchObject({ stopped: true, unresolved: false })
    expect(f.cleaned).toEqual([A.operationId])
  })

  test('start rechecks effect fence after supervisor reconstruction', async () => {
    const f = await fixture()
    const first = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await first.prepareMember(A)
    let entered!: () => void
    let resume!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { resume = resolve })
    const factory = f.options.testOnlySupervisorFactory!
    const restarted = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlySupervisorFactory: async options => { entered(); await blocked; return factory(options) },
    })
    const attempt = restarted.startPrepared({ operationId: A.operationId, receiptId: receipt.receiptId })
    await enteredPromise
    f.denyFence()
    resume()
    await expect(attempt).rejects.toThrow('hosted-member-product-authority-denied')
    expect(f.started).toEqual([])
  })

  test('receipt publication crash leaves retryable staging, never a truncated final receipt', async () => {
    const f = await fixture()
    const crashing = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlyBeforeReceiptPublish: async () => { throw new Error('simulated-crash') },
    })
    await expect(crashing.prepareMember(A)).rejects.toThrow('simulated-crash')
    expect((await readdir(f.stateDirectory)).some(name => name === `receipt-${A.operationId}.json`)).toBe(false)
    expect((await readdir(f.stateDirectory)).some(name => name.startsWith(`receipt-${A.operationId}.json.stage-`)))
      .toBe(true)
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    expect(await restarted.prepareMember(A)).toMatchObject({ operationId: A.operationId })
    expect((await readdir(f.stateDirectory)).some(name => name === `receipt-${A.operationId}.json`)).toBe(true)
    expect(f.created).toHaveLength(1)
  })

  test('network-index publication crash recovers exact provisioned ID and permits terminal cleanup', async () => {
    const f = await fixture()
    let claimed = false
    let dockerCreates = 0
    let reconciles = 0
    f.options.network.provision = async () => {
      if (claimed) throw new Error('hosted-network-operation-already-claimed')
      claimed = true
      dockerCreates++
      return NETWORK_A
    }
    f.options.network.reconcile = async () => { reconciles++; return NETWORK_A }
    const crashing = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlyBeforeNetworkIndexPublish: async () => { throw new Error('simulated-network-index-crash') },
    })
    await expect(crashing.prepareMember(A)).rejects.toThrow('simulated-network-index-crash')
    const names = await readdir(f.stateDirectory)
    expect(names).not.toContain(`network-id-${NETWORK_A}.json`)
    expect(names.some(name => name.startsWith(`network-id-${NETWORK_A}.json.stage-`))).toBe(true)
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await restarted.prepareMember(A)
    expect(dockerCreates).toBe(1)
    expect(reconciles).toBe(1)
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_recovered123',
      handle: receipt.handle, generation: receipt.generation })).toMatchObject({ stopped: true, unresolved: false })
    expect(f.cleaned).toEqual([A.operationId])
  })

  test('after-link crash on primary claims leaves exact independently published secondary records recoverable', async () => {
    const f = await fixture()
    let claimed = false
    let dockerCreates = 0
    f.options.network.provision = async () => {
      if (claimed) throw new Error('hosted-network-operation-already-claimed')
      claimed = true
      dockerCreates++
      return NETWORK_A
    }
    f.options.network.reconcile = async () => NETWORK_A
    const crashOperation = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlyAfterClaimLink: async kind => {
        if (kind === 'operation') throw new Error('simulated-operation-link-crash')
      },
    })
    await expect(crashOperation.prepareMember(A)).rejects.toThrow('simulated-operation-link-crash')
    const crashNetwork = await HostedOpenCodeMemberSupervisorManager.create({ ...f.options,
      testOnlyAfterClaimLink: async kind => {
        if (kind === 'network-index') throw new Error('simulated-network-link-crash')
      },
    })
    await expect(crashNetwork.prepareMember(A)).rejects.toThrow('simulated-network-link-crash')
    const restarted = await HostedOpenCodeMemberSupervisorManager.create(f.options)
    const receipt = await restarted.prepareMember(A)
    expect(await restarted.stop({ memberOperationId: A.operationId, operationId: 'stop_staged123',
      handle: receipt.handle, generation: receipt.generation }))
      .toMatchObject({ stopped: true, unresolved: false })
    expect(dockerCreates).toBe(1)
    expect(f.cleaned).toEqual([A.operationId])
  })
})
