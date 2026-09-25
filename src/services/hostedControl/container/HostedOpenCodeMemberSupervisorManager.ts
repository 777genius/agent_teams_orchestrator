import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'

import { HostedOpenCodeContainerSupervisor, type HostedOpenCodeContainerSupervisorOptions } from './HostedOpenCodeContainerSupervisor.js'
import { HostedMemberNetworkProvisioner, type HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'

const ID = /^[a-z0-9][a-z0-9_-]{7,95}$/
const NETWORK_ID = /^[0-9a-f]{64}$/
const RECEIPT_ID = /^[0-9a-f]{32}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/

type Supervisor = Pick<HostedOpenCodeContainerSupervisor, 'prepareMember' | 'startPrepared' | 'observe' | 'stop'>
type Receipt = Awaited<ReturnType<Supervisor['prepareMember']>>
type StartResult = Awaited<ReturnType<Supervisor['startPrepared']>>
type Action = 'prepare' | 'start' | 'observe'

export type ManagedMemberLookup = Readonly<{
  /** A fresh read operation, separate from the durable member Start operation. */
  operationId: string
  memberOperationId: string
  planTeamId: string
  planFingerprint: string
  runId: string
  teamId: string
  laneId: string
  memberId: string
}>

export type ManagedMemberBinding = Readonly<{
  memberOperationId: string
  receiptId: string
  handle: string
  generation: string
  state: 'prepared' | 'started' | 'stopped' | 'unresolved'
}>

export type HostedMemberSupervisorManagerOptions = Readonly<{
  stateDirectory: string
  network: HostedMemberNetworkProvisioner
  supervisorOptions: Omit<HostedOpenCodeContainerSupervisorOptions, 'networkId' | 'stateDirectory'>
  /** Independent Product authority. Neither decision may be inferred from an Owner RPC. */
  admitMember: (request: HostedMemberNetworkRequest) => Promise<boolean>
  assertEffectFence: (request: HostedMemberNetworkRequest, action: Action) => Promise<boolean>
  /** Root-local cleanup authority, independent of positive launch admission after revocation. */
  assertCleanupAuthority: (request: HostedMemberNetworkRequest, stopOperationId: string) => Promise<boolean>
  /** Inert tests only. Production uses the root supervisor's own fail-closed authority. */
  testOnlySupervisorFactory?: (options: HostedOpenCodeContainerSupervisorOptions) => Promise<Supervisor>
  /** Simulates a crash after a fully synced receipt staging file, before publication. */
  testOnlyBeforeReceiptPublish?: () => Promise<void>
  /** Simulates a crash after network provisioning, before publishing its durable manager index. */
  testOnlyBeforeNetworkIndexPublish?: () => Promise<void>
  /** Simulates a crash after a claim's final link, before the staging link is removed. */
  testOnlyAfterClaimLink?: (kind: 'operation' | 'network-index') => Promise<void>
}>

type Operation = Readonly<{ request: HostedMemberNetworkRequest; directoryName: string }>
type NetworkClaim = Readonly<{ operationId: string; networkId: string }>
type StopTerminal = Readonly<{ handle: string; generation: string; stopped: true; unresolved: false }>
type StartIntent = Readonly<{ receiptId: string; handle: string; generation: string }>
type StartTerminal = StartIntent & Readonly<{ status: 'started' | 'unresolved'; effectEnabled: false }>

function validRequest(request: HostedMemberNetworkRequest): boolean {
  return !!request && Object.keys(request).sort().join(',') ===
    ['operationId', 'planTeamId', 'planFingerprint', 'runId', 'teamId', 'laneId', 'memberId'].sort().join(',') &&
    [request.operationId, request.planTeamId, request.runId, request.teamId, request.laneId,
      request.memberId].every(value => typeof value === 'string' && ID.test(value)) &&
    typeof request.planFingerprint === 'string' && NETWORK_ID.test(request.planFingerprint)
}

function validReceipt(row: unknown, operationId: string): row is Receipt {
  if (!exact(row, ['operationId', 'receiptId', 'handle', 'generation', 'connector']) ||
    row.operationId !== operationId || typeof row.receiptId !== 'string' || !RECEIPT_ID.test(row.receiptId) ||
    typeof row.handle !== 'string' || !HANDLE.test(row.handle) ||
    typeof row.generation !== 'string' || !RECEIPT_ID.test(row.generation) ||
    !exact(row.connector, ['pid', 'startTicks'])) return false
  return Number.isSafeInteger(row.connector.pid) && Number(row.connector.pid) > 0 &&
    typeof row.connector.startTicks === 'string' && /^\d+$/.test(row.connector.startTicks)
}

function sameRequest(left: HostedMemberNetworkRequest, right: HostedMemberNetworkRequest): boolean {
  return Object.keys(left).length === Object.keys(right).length &&
    (Object.keys(left) as Array<keyof HostedMemberNetworkRequest>).every(key => left[key] === right[key])
}

function memberKey(request: HostedMemberNetworkRequest): string {
  return createHash('sha256').update(`${request.runId}\0${request.teamId}\0${request.memberId}`).digest('hex')
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** Inactive root-side composition seam. One operation owns one network and one supervisor directory. */
export class HostedOpenCodeMemberSupervisorManager {
  private readonly supervisors = new Map<string, Promise<Supervisor>>()
  private readonly preparations = new Map<string, Promise<Receipt>>()
  private readonly starts = new Map<string, Promise<StartResult>>()
  private readonly memberMutations = new Map<string, Promise<unknown>>()
  private readonly uid: number
  private readonly identity: Readonly<{ dev: number; ino: number }>

  private constructor(private readonly options: HostedMemberSupervisorManagerOptions,
    identity: Readonly<{ dev: number; ino: number }>) {
    this.uid = process.getuid!()
    this.identity = identity
  }

  static async create(options: HostedMemberSupervisorManagerOptions): Promise<HostedOpenCodeMemberSupervisorManager> {
    if (typeof options.admitMember !== 'function' || typeof options.assertEffectFence !== 'function') {
      throw new Error('hosted-member-product-authority-required')
    }
    if (typeof options.assertCleanupAuthority !== 'function') {
      throw new Error('hosted-member-cleanup-authority-required')
    }
    if (options.testOnlySupervisorFactory && (process.env.NODE_ENV !== 'test' ||
      !options.supervisorOptions.testOnlyAllowNonRoot)) {
      throw new Error('hosted-member-test-supervisor-forbidden')
    }
    if (options.testOnlyBeforeReceiptPublish && (process.env.NODE_ENV !== 'test' ||
      !options.supervisorOptions.testOnlyAllowNonRoot)) {
      throw new Error('hosted-member-test-receipt-hook-forbidden')
    }
    if (options.testOnlyBeforeNetworkIndexPublish && (process.env.NODE_ENV !== 'test' ||
      !options.supervisorOptions.testOnlyAllowNonRoot)) {
      throw new Error('hosted-member-test-network-hook-forbidden')
    }
    if (options.testOnlyAfterClaimLink && (process.env.NODE_ENV !== 'test' ||
      !options.supervisorOptions.testOnlyAllowNonRoot)) {
      throw new Error('hosted-member-test-claim-hook-forbidden')
    }
    if (!path.isAbsolute(options.stateDirectory) || path.normalize(options.stateDirectory) !== options.stateDirectory ||
      /[,=]/.test(options.stateDirectory)) throw new Error('hosted-member-state-path-invalid')
    const stat = await lstat(options.stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 || await realpath(options.stateDirectory) !== options.stateDirectory) {
      throw new Error('hosted-member-state-directory-invalid')
    }
    if (!options.supervisorOptions.testOnlyAllowNonRoot && (process.platform !== 'linux' || process.getuid?.() !== 0)) {
      throw new Error('hosted-member-root-required')
    }
    if (!options.supervisorOptions.testOnlyAllowNonRoot &&
      !(options.network instanceof HostedMemberNetworkProvisioner)) {
      throw new Error('hosted-member-root-network-required')
    }
    if (!options.supervisorOptions.testOnlyAllowNonRoot) {
      for (let current = path.dirname(options.stateDirectory); ; current = path.dirname(current)) {
        const ancestor = await lstat(current)
        if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ancestor.uid !== 0 ||
          (ancestor.mode & 0o022) !== 0 || await realpath(current) !== current) {
          throw new Error('hosted-member-state-ancestor-untrusted')
        }
        if (current === path.dirname(current)) break
      }
    }
    return new HostedOpenCodeMemberSupervisorManager(options, { dev: stat.dev, ino: stat.ino })
  }

  private async assertDirectory(): Promise<void> {
    const stat = await lstat(this.options.stateDirectory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== this.identity.dev ||
      stat.ino !== this.identity.ino || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o700 ||
      await realpath(this.options.stateDirectory) !== this.options.stateDirectory) {
      throw new Error('hosted-member-state-directory-invalid')
    }
  }

  private file(name: string): string { return path.join(this.options.stateDirectory, name) }

  private async syncDirectory(): Promise<void> {
    await this.assertDirectory()
    const handle = await open(this.options.stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }

  private async read<T>(name: string): Promise<T | null> {
    await this.assertDirectory()
    let handle
    try { handle = await open(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== this.uid || (stat.mode & 0o777) !== 0o600 || stat.size > 2048 ||
        stat.nlink < 1 || stat.nlink > 2) throw new Error('hosted-member-record-invalid')
      return JSON.parse(await handle.readFile('utf8')) as T
    } finally { await handle.close() }
  }

  private async publishImmutable(name: string, value: unknown, beforePublish?: () => Promise<void>,
    afterLink?: () => Promise<void>): Promise<boolean> {
    const destination = this.file(name)
    const staging = `${destination}.stage-${randomBytes(16).toString('hex')}`
    await this.assertDirectory()
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await beforePublish?.()
    await this.assertDirectory()
    let linked = false
    try { await link(staging, destination); linked = true }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    if (linked) await afterLink?.()
    await this.syncDirectory()
    await unlink(staging)
    await this.syncDirectory()
    return linked
  }

  private async authorized(request: HostedMemberNetworkRequest, action: Action): Promise<void> {
    if (!validRequest(request) || !await this.options.admitMember(request) ||
      !await this.options.assertEffectFence(request, action)) {
      throw new Error('hosted-member-product-authority-denied')
    }
  }

  private async mutateMember<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.memberMutations.get(operationId)
    const current = (async () => {
      await previous?.catch(() => undefined)
      return work()
    })()
    this.memberMutations.set(operationId, current)
    try { return await current } finally {
      if (this.memberMutations.get(operationId) === current) this.memberMutations.delete(operationId)
    }
  }

  private async operation(operationId: string): Promise<Operation> {
    if (!ID.test(operationId)) throw new Error('hosted-member-operation-invalid')
    const row = await this.read<Operation>(`operation-${operationId}.json`)
    if (!row || !exact(row, ['request', 'directoryName']) || !validRequest(row.request) ||
      row.request.operationId !== operationId || row.directoryName !== `supervisor-${operationId}`) {
      throw new Error('hosted-member-operation-unbound')
    }
    return row
  }

  private async bind(request: HostedMemberNetworkRequest): Promise<Operation> {
    if (!validRequest(request)) throw new Error('hosted-member-request-invalid')
    const row: Operation = { request, directoryName: `supervisor-${request.operationId}` }
    await this.publishImmutable(`operation-${request.operationId}.json`, row, undefined,
      () => this.options.testOnlyAfterClaimLink?.('operation') ?? Promise.resolve())
    const stored = await this.operation(request.operationId)
    if (!sameRequest(stored.request, request)) throw new Error('hosted-member-operation-conflict')
    const memberName = `member-${memberKey(request)}.json`
    await this.publishImmutable(memberName, stored)
    const member = await this.read<Operation>(memberName)
    if (!member || !exact(member, ['request', 'directoryName']) ||
      !sameRequest(member.request, request) || member.directoryName !== stored.directoryName) {
      throw new Error('hosted-member-already-owned')
    }
    return stored
  }

  private async assertMemberBinding(operation: Operation): Promise<void> {
    const member = await this.read<Operation>(`member-${memberKey(operation.request)}.json`)
    if (!member || !exact(member, ['request', 'directoryName']) ||
      !sameRequest(member.request, operation.request) || member.directoryName !== operation.directoryName) {
      throw new Error('hosted-member-member-binding-invalid')
    }
  }

  private async networkId(operationId: string): Promise<string | null> {
    const claim = await this.read<NetworkClaim>(`network-result-${operationId}.json`)
    if (!claim) return null
    if (!exact(claim, ['operationId', 'networkId']) || claim.operationId !== operationId ||
      typeof claim.networkId !== 'string' || !NETWORK_ID.test(claim.networkId)) {
      throw new Error('hosted-member-network-record-invalid')
    }
    const index = await this.read<NetworkClaim>(`network-id-${claim.networkId}.json`)
    if (!index || !exact(index, ['operationId', 'networkId']) || index.operationId !== operationId ||
      index.networkId !== claim.networkId) throw new Error('hosted-member-network-index-invalid')
    return claim.networkId
  }

  private async publishNetwork(operationId: string, networkId: string): Promise<void> {
    if (!NETWORK_ID.test(networkId)) throw new Error('hosted-member-network-id-invalid')
    const claim: NetworkClaim = { operationId, networkId }
    const indexName = `network-id-${networkId}.json`
    await this.publishImmutable(indexName, claim, this.options.testOnlyBeforeNetworkIndexPublish,
      () => this.options.testOnlyAfterClaimLink?.('network-index') ?? Promise.resolve())
    const index = await this.read<NetworkClaim>(indexName)
    if (!index || !exact(index, ['operationId', 'networkId']) || index.operationId !== operationId ||
      index.networkId !== networkId) throw new Error('hosted-member-network-already-owned')
    const resultName = `network-result-${operationId}.json`
    await this.publishImmutable(resultName, claim)
    if (await this.networkId(operationId) !== networkId) throw new Error('hosted-member-network-conflict')
  }

  private async supervisor(operation: Operation, mayProvision: boolean): Promise<Supervisor> {
    const operationId = operation.request.operationId
    const cached = this.supervisors.get(operationId)
    if (cached) return cached
    const creating = (async () => {
      let networkId = await this.networkId(operationId)
      if (!networkId) {
        if (!mayProvision) throw new Error('hosted-member-network-unresolved')
        try { networkId = await this.options.network.provision(operation.request) }
        catch (error) {
          if (!(error instanceof Error) || error.message !== 'hosted-network-operation-already-claimed') throw error
          networkId = await this.options.network.reconcile(operation.request)
        }
        await this.publishNetwork(operationId, networkId)
      }
      const stateDirectory = this.file(operation.directoryName)
      try { await mkdir(stateDirectory, { mode: 0o700 }) }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      }
      const stat = await lstat(stateDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.uid ||
        (stat.mode & 0o777) !== 0o700 || await realpath(stateDirectory) !== stateDirectory) {
        throw new Error('hosted-member-supervisor-directory-invalid')
      }
      await this.syncDirectory()
      const options = { ...this.options.supervisorOptions, networkId, stateDirectory }
      return this.options.testOnlySupervisorFactory
        ? this.options.testOnlySupervisorFactory(options)
        : HostedOpenCodeContainerSupervisor.create(options)
    })()
    this.supervisors.set(operationId, creating)
    try { return await creating }
    catch (error) { this.supervisors.delete(operationId); throw error }
  }

  private async receipt(operationId: string): Promise<Receipt | null> {
    const row = await this.read<Receipt>(`receipt-${operationId}.json`)
    if (!row) return null
    if (!validReceipt(row, operationId)) {
      throw new Error('hosted-member-receipt-invalid')
    }
    const index = await this.read<Receipt>(`receipt-handle-${row.handle}.json`)
    if (!index || JSON.stringify(index) !== JSON.stringify(row)) {
      throw new Error('hosted-member-receipt-index-invalid')
    }
    return row
  }

  private async startIntent(operationId: string, receipt: Receipt): Promise<StartIntent | null> {
    const row = await this.read<StartIntent>(`start-intent-${operationId}.json`)
    if (!row) return null
    if (!exact(row, ['receiptId', 'handle', 'generation']) || row.receiptId !== receipt.receiptId ||
      row.handle !== receipt.handle || row.generation !== receipt.generation) {
      throw new Error('hosted-member-start-intent-invalid')
    }
    return row
  }

  private async startTerminal(operationId: string, receipt: Receipt): Promise<StartTerminal | null> {
    const row = await this.read<StartTerminal>(`start-terminal-${operationId}.json`)
    if (!row) return null
    if (!exact(row, ['receiptId', 'handle', 'generation', 'status', 'effectEnabled']) ||
      row.receiptId !== receipt.receiptId || row.handle !== receipt.handle ||
      row.generation !== receipt.generation || !['started', 'unresolved'].includes(row.status) ||
      row.effectEnabled !== false) throw new Error('hosted-member-start-terminal-invalid')
    return row
  }

  /** Exact, read-only root recovery. No supervisor or network provisioner is opened. */
  async lookupManagedMember(input: ManagedMemberLookup): Promise<ManagedMemberBinding | null> {
    if (!exact(input, ['operationId', 'memberOperationId', 'planTeamId', 'planFingerprint',
      'runId', 'teamId', 'laneId', 'memberId']) || !ID.test(input.operationId) ||
      !validRequest({ operationId: input.memberOperationId, planTeamId: input.planTeamId,
        planFingerprint: input.planFingerprint, runId: input.runId, teamId: input.teamId,
        laneId: input.laneId, memberId: input.memberId })) {
      throw new Error('hosted-member-lookup-invalid')
    }
    if (!await this.read<Operation>(`operation-${input.memberOperationId}.json`)) return null
    const operation = await this.operation(input.memberOperationId)
    const expected = { operationId: input.memberOperationId, planTeamId: input.planTeamId,
      planFingerprint: input.planFingerprint, runId: input.runId, teamId: input.teamId,
      laneId: input.laneId, memberId: input.memberId }
    if (!sameRequest(operation.request, expected)) throw new Error('hosted-member-lookup-binding-conflict')
    await this.assertMemberBinding(operation)
    if (!await this.networkId(input.memberOperationId)) throw new Error('hosted-member-network-unresolved')
    const positive = await this.options.admitMember(operation.request) &&
      await this.options.assertEffectFence(operation.request, 'observe')
    if (!positive && !await this.options.assertCleanupAuthority(operation.request, input.operationId)) {
      throw new Error('hosted-member-lookup-authority-denied')
    }
    const receipt = await this.receipt(input.memberOperationId)
    if (!receipt) throw new Error('hosted-member-receipt-unbound')
    const intent = await this.startIntent(input.memberOperationId, receipt)
    const terminal = await this.startTerminal(input.memberOperationId, receipt)
    if (terminal && !intent) throw new Error('hosted-member-start-terminal-unbound')
    const stop = await this.stopTerminal(input.memberOperationId)
    if (stop && (stop.handle !== receipt.handle || stop.generation !== receipt.generation)) {
      throw new Error('hosted-member-stop-terminal-conflict')
    }
    return { memberOperationId: input.memberOperationId, receiptId: receipt.receiptId,
      handle: receipt.handle, generation: receipt.generation,
      state: stop ? 'stopped' : terminal?.status ?? (intent ? 'unresolved' : 'prepared') }
  }

  private async stopTerminal(operationId: string): Promise<StopTerminal | null> {
    const row = await this.read<StopTerminal>(`stop-terminal-${operationId}.json`)
    if (!row) return null
    if (!exact(row, ['handle', 'generation', 'stopped', 'unresolved']) ||
      typeof row.handle !== 'string' || !HANDLE.test(row.handle) ||
      typeof row.generation !== 'string' || !RECEIPT_ID.test(row.generation) ||
      row.stopped !== true || row.unresolved !== false) {
      throw new Error('hosted-member-stop-terminal-invalid')
    }
    return row
  }

  async prepareMember(request: HostedMemberNetworkRequest): Promise<Receipt> {
    await this.authorized(request, 'prepare')
    const operation = await this.bind(request)
    const pending = this.preparations.get(request.operationId)
    if (pending) return pending
    const preparing = (async () => {
      const supervisor = await this.supervisor(operation, true)
      await this.authorized(request, 'prepare')
      const receipt = await supervisor.prepareMember({ operationId: request.operationId })
      if (!validReceipt(receipt, request.operationId)) throw new Error('hosted-member-receipt-invalid')
      await this.publishImmutable(`receipt-handle-${receipt.handle}.json`, receipt)
      const indexed = await this.read<Receipt>(`receipt-handle-${receipt.handle}.json`)
      if (!indexed || JSON.stringify(indexed) !== JSON.stringify(receipt)) {
        throw new Error('hosted-member-receipt-index-conflict')
      }
      const prior = await this.receipt(request.operationId)
      if (!prior) await this.publishImmutable(`receipt-${request.operationId}.json`, receipt,
        this.options.testOnlyBeforeReceiptPublish)
      const stored = await this.receipt(request.operationId)
      if (!stored || JSON.stringify(stored) !== JSON.stringify(receipt)) throw new Error('hosted-member-receipt-conflict')
      return stored
    })()
    this.preparations.set(request.operationId, preparing)
    try { return await preparing } finally { this.preparations.delete(request.operationId) }
  }

  async startPrepared(input: { operationId: string; receiptId: string }): ReturnType<Supervisor['startPrepared']> {
    if (!exact(input, ['operationId', 'receiptId']) || !ID.test(input.operationId) ||
      !RECEIPT_ID.test(input.receiptId)) throw new Error('hosted-member-prepared-start-invalid')
    const pending = this.starts.get(input.operationId)
    if (pending) return pending
    const starting = this.mutateMember(input.operationId, () => this.startPreparedOnce(input))
    this.starts.set(input.operationId, starting)
    try { return await starting } finally { this.starts.delete(input.operationId) }
  }

  private async startPreparedOnce(input: { operationId: string; receiptId: string }): Promise<StartResult> {
    const operation = await this.operation(input.operationId)
    await this.authorized(operation.request, 'start')
    const receipt = await this.receipt(input.operationId)
    if (!receipt || receipt.receiptId !== input.receiptId) throw new Error('hosted-member-receipt-unbound')
    await this.assertMemberBinding(operation)
    const stop = await this.stopTerminal(input.operationId)
    if (stop) {
      if (stop.handle !== receipt.handle || stop.generation !== receipt.generation) {
        throw new Error('hosted-member-stop-terminal-conflict')
      }
      throw new Error('hosted-member-already-stopped')
    }
    const priorIntent = await this.startIntent(input.operationId, receipt)
    const priorTerminal = await this.startTerminal(input.operationId, receipt)
    if (priorTerminal && !priorIntent) throw new Error('hosted-member-start-terminal-unbound')
    if (priorIntent) return priorTerminal
      ? { handle: priorTerminal.handle, generation: priorTerminal.generation,
        status: priorTerminal.status, effectEnabled: false }
      : { handle: receipt.handle, generation: receipt.generation, status: 'unresolved', effectEnabled: false }
    const supervisor = await this.supervisor(operation, false)
    await this.authorized(operation.request, 'start')
    const created = await this.publishImmutable(`start-intent-${input.operationId}.json`, {
      receiptId: receipt.receiptId, handle: receipt.handle, generation: receipt.generation,
    } satisfies StartIntent)
    if (!await this.startIntent(input.operationId, receipt)) throw new Error('hosted-member-start-intent-unbound')
    if (!created) {
      const terminal = await this.startTerminal(input.operationId, receipt)
      return terminal
        ? { handle: terminal.handle, generation: terminal.generation,
          status: terminal.status, effectEnabled: false }
        : { handle: receipt.handle, generation: receipt.generation,
          status: 'unresolved', effectEnabled: false }
    }
    const result = await supervisor.startPrepared(input)
    if (result.handle !== receipt.handle || result.generation !== receipt.generation ||
      !['started', 'unresolved'].includes(result.status) || result.effectEnabled !== false) {
      throw new Error('hosted-member-start-result-conflict')
    }
    await this.publishImmutable(`start-terminal-${input.operationId}.json`, {
      receiptId: receipt.receiptId, handle: result.handle, generation: result.generation,
      status: result.status, effectEnabled: false,
    } satisfies StartTerminal)
    const stored = await this.startTerminal(input.operationId, receipt)
    if (!stored || stored.status !== result.status) throw new Error('hosted-member-start-result-conflict')
    return { handle: stored.handle, generation: stored.generation,
      status: stored.status, effectEnabled: false }
  }

  async observe(input: { memberOperationId: string; operationId: string; handle: string; generation: string }):
    ReturnType<Supervisor['observe']> {
    const { operation, request } = await this.boundHandle(input)
    await this.authorized(operation.request, 'observe')
    const supervisor = await this.supervisor(operation, false)
    await this.authorized(operation.request, 'observe')
    return supervisor.observe(request)
  }

  async stop(input: { memberOperationId: string; operationId: string; handle: string; generation: string }):
    ReturnType<Supervisor['stop']> {
    return this.mutateMember(input.memberOperationId, () => this.stopOnce(input))
  }

  private async stopOnce(input: { memberOperationId: string; operationId: string; handle: string;
    generation: string }): ReturnType<Supervisor['stop']> {
    const { operation, request } = await this.boundHandle(input)
    await this.cleanupAuthorized(operation.request, input.operationId)
    const prior = await this.stopTerminal(input.memberOperationId)
    if (prior && (prior.handle !== input.handle || prior.generation !== input.generation)) {
      throw new Error('hosted-member-stop-terminal-conflict')
    }
    let terminal = prior
    if (!terminal) {
      const supervisor = await this.supervisor(operation, false)
      await this.cleanupAuthorized(operation.request, input.operationId)
      const result = await supervisor.stop(request)
      if (result.handle !== input.handle || result.generation !== input.generation) {
        throw new Error('hosted-member-stop-result-conflict')
      }
      if (!result.stopped || result.unresolved) return result
      terminal = { handle: result.handle, generation: result.generation, stopped: true, unresolved: false }
      await this.publishImmutable(`stop-terminal-${input.memberOperationId}.json`, terminal)
      const stored = await this.stopTerminal(input.memberOperationId)
      if (!stored || stored.handle !== terminal.handle || stored.generation !== terminal.generation) {
        throw new Error('hosted-member-stop-terminal-conflict')
      }
    }
    await this.cleanupAuthorized(operation.request, input.operationId)
    await this.options.network.cleanup(operation.request)
    return terminal
  }

  private async cleanupAuthorized(request: HostedMemberNetworkRequest, stopOperationId: string): Promise<void> {
    if (!await this.options.assertCleanupAuthority(request, stopOperationId)) {
      throw new Error('hosted-member-cleanup-authority-denied')
    }
  }

  private async boundHandle(input: { memberOperationId: string; operationId: string; handle: string;
    generation: string }): Promise<{ operation: Operation; request: {
      operationId: string; handle: string; generation: string } }> {
    if (!ID.test(input.operationId)) throw new Error('hosted-member-operation-invalid')
    const operation = await this.operation(input.memberOperationId)
    const receipt = await this.receipt(input.memberOperationId)
    if (!receipt || receipt.handle !== input.handle || receipt.generation !== input.generation) {
      throw new Error('hosted-member-handle-unbound')
    }
    await this.assertMemberBinding(operation)
    const request = { operationId: input.operationId, handle: input.handle, generation: input.generation }
    return { operation, request }
  }
}
