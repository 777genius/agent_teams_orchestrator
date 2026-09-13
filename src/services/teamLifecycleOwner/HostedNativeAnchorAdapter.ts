import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { isDeepStrictEqual } from 'node:util'

import type {
  NodeAnchorLaunchAuthorityCatalog,
  NodeAnchorProviderStdio,
  ObserveProcessExecutionUnitResult,
  ProcessControllerInstanceId,
  ProcessExecutionUnit,
  ProcessOwnerBinding,
  ProcessOwnershipStorePort,
  ResolvedProcessLaunchSpec,
  RuntimeCancellation,
  StartProcessExecutionUnitResult,
  StopProcessExecutionUnitResult,
  SupervisedProcessRef,
} from '@agent-teams/owner-anchor-library'
import type { LoadedHostedOwnerAnchorLibrary } from './HostedOwnerAnchorLibrary.js'

export type HostedNativeAnchorUnitBinding = Readonly<{
  /** Owner's opaque string generation. Mapping it to Product's numeric generation belongs to B. */
  ownerPlanGeneration: string
  ownerUnitBindingId: string
  orderedMembers: readonly Readonly<{ ordinal: number; memberId: string }>[]
  executionUnit: ProcessExecutionUnit
  launchSpec: ResolvedProcessLaunchSpec
}>

export type HostedNativeProviderStdioCustody = Readonly<{
  processRef: SupervisedProcessRef
  stdoutConsumption: 'attached'
  stderrConsumption: 'attached'
  release(): void | Promise<void>
}>

export type HostedNativeAnchorDisposition = Readonly<{
  required: true
  reason: 'start_result_uncertain' | 'stdio_custody_failed' | 'scope_not_live' |
    'stop_result_uncertain' | 'stdio_custody_release_unsettled' |
    'stdio_transport_close_unsettled' | 'observation_uncertain'
}>

export type HostedNativeAnchorStartResult =
  | Readonly<{
      status: 'started' | 'already_started'
      processRef: SupervisedProcessRef
      anchorReady: 'committed_ownership_and_anchor_handshake_only'
      stdio: NodeAnchorProviderStdio
    }>
  | Readonly<{
      status: 'uncertain'
      productResult: StartProcessExecutionUnitResult
      processRef?: SupervisedProcessRef
      stdio?: NodeAnchorProviderStdio
      disposition: HostedNativeAnchorDisposition
    }>

export type HostedNativeAnchorStopResult =
  | Readonly<{ status: 'drained' | 'already_drained' }>
  | Readonly<{
      status: 'uncertain'
      productResult: StopProcessExecutionUnitResult | { status: 'scope_not_live' }
      processDrain?: Readonly<{ status: 'drained' | 'already_drained' }>
      consumerSettlement?: 'pending' | 'failed'
      transportClosure?: 'failed'
      disposition: HostedNativeAnchorDisposition
    }>

export type HostedNativeAnchorObserveResult =
  | Readonly<{ status: 'starting' | 'ready' | 'stopping' }>
  | Readonly<{ status: 'exited'; outcome: 'drained' }>
  | Readonly<{ status: 'exited'; outcome: 'unknown'; disposition: HostedNativeAnchorDisposition }>
  | Readonly<{ status: 'uncertain'; disposition: HostedNativeAnchorDisposition }>

export type HostedNativeAnchorAdapterOptions = Readonly<{
  admittedLibrary: LoadedHostedOwnerAnchorLibrary
  /** Required durable Owner/B implementation. There is intentionally no in-memory default. */
  store: ProcessOwnershipStorePort
  ownerBinding: ProcessOwnerBinding
  controllerInstanceId: ProcessControllerInstanceId
  launchCatalog: NodeAnchorLaunchAuthorityCatalog
  neutralWorkingDirectory: string
  launchTimeoutMs: number
  stopTimeoutMs: number
  recoveryTimeoutMs: number
  claimProviderStdio(input: Readonly<{
    binding: HostedNativeAnchorUnitBinding
    processRef: SupervisedProcessRef
    stdio: NodeAnchorProviderStdio
  }>): HostedNativeProviderStdioCustody
}>

type TerminalCustody = {
  readonly productResult: Readonly<{ status: 'drained' | 'already_drained' }>
  readonly releaseUnavailable: boolean
  consumerSettlement: 'pending' | 'settled' | 'failed'
  invokingRelease: boolean
  releaseInFlight?: Promise<'settled' | 'failed'>
  stdioClosed: boolean
  providerStdioClosed: boolean
  transportClosed: boolean
}

type RetainedUnit = {
  readonly binding: HostedNativeAnchorUnitBinding
  readonly processRef: SupervisedProcessRef
  readonly startProductResult: Readonly<{
    status: 'started' | 'already_started'
    processRef: SupervisedProcessRef
  }>
  readonly stdio?: NodeAnchorProviderStdio
  readonly custody?: HostedNativeProviderStdioCustody
  readonly consumerClaim: 'claimed' | 'not_present' | 'unavailable'
  terminal?: TerminalCustody
  stopInFlight?: Promise<HostedNativeAnchorStopResult>
}

/**
 * One Owner-lifetime seam over Product's real supervisor, materializer and Node spawner. It does
 * not translate Owner plan generations, infer authority from a PID/PGID, or attest runtime/LLM
 * readiness. Product `started` is only committed process ownership plus the anchor handshake.
 */
export class HostedNativeAnchorAdapter {
  readonly #library: LoadedHostedOwnerAnchorLibrary['library']
  readonly #spawner: InstanceType<LoadedHostedOwnerAnchorLibrary['library']['NodeAnchorSpawner']>
  readonly #supervisor: InstanceType<LoadedHostedOwnerAnchorLibrary['library']['AnchorProcessSupervisorAdapter']>
  readonly #claimProviderStdio: HostedNativeAnchorAdapterOptions['claimProviderStdio']
  readonly #retained = new Map<SupervisedProcessRef, RetainedUnit>()
  readonly #stopTimeoutMs: number

  constructor(options: HostedNativeAnchorAdapterOptions) {
    if (!options.store) throw new TypeError('hosted-native-anchor-store-required')
    if (!options.admittedLibrary?.library || !options.admittedLibrary.anchorExecutablePath) {
      throw new TypeError('hosted-native-anchor-admitted-library-required')
    }
    if (!options.ownerBinding) throw new TypeError('hosted-native-anchor-owner-binding-required')
    if (!options.controllerInstanceId) throw new TypeError('hosted-native-anchor-controller-instance-required')
    if (typeof options.claimProviderStdio !== 'function') throw new TypeError('hosted-native-anchor-stdio-custodian-required')
    requirePositiveTimeout(options.launchTimeoutMs, 'launch')
    requirePositiveTimeout(options.stopTimeoutMs, 'stop')
    requirePositiveTimeout(options.recoveryTimeoutMs, 'recovery')

    this.#library = options.admittedLibrary.library
    const ownerBinding = this.#library.parseProcessOwnerBinding(options.ownerBinding)
    const controllerInstanceId = this.#library.parseProcessControllerInstanceId(options.controllerInstanceId)
    const materializer = new this.#library.NodeAnchorLaunchMaterializer(freezeCatalog(options.launchCatalog))
    this.#spawner = new this.#library.NodeAnchorSpawner({
      anchorExecutablePath: options.admittedLibrary.anchorExecutablePath,
      neutralWorkingDirectory: options.neutralWorkingDirectory,
      materializer,
      ownerBinding,
      providerStdio: 'pipe',
    })
    this.#supervisor = new this.#library.AnchorProcessSupervisorAdapter({
      store: options.store,
      identities: {
        createProcessRef: () => this.#library.parseOwnedProcessRef(`owner-process:${randomUUID()}`),
        createSpawnNonce: () => this.#library.parseSpawnNonce(`owner-spawn:${randomUUID()}`),
      },
      spawner: this.#spawner,
      clock: { now: () => performance.now() },
      controllerInstanceId,
      ownerBinding,
      inventoryMode: 'hosted_authority',
      launchTimeoutMs: options.launchTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
      recoveryTimeoutMs: options.recoveryTimeoutMs,
    })
    this.#claimProviderStdio = options.claimProviderStdio
    this.#stopTimeoutMs = options.stopTimeoutMs
  }

  async start(binding: HostedNativeAnchorUnitBinding, cancellation: RuntimeCancellation): Promise<HostedNativeAnchorStartResult> {
    const exactBinding = snapshotAndValidateBinding(binding)
    let productResult: StartProcessExecutionUnitResult
    try {
      productResult = await this.#supervisor.start({
        executionUnit: exactBinding.executionUnit,
        launchSpec: exactBinding.launchSpec,
        cancellation,
      })
    } catch {
      return uncertainStart({ status: 'rejected', reason: 'unavailable' }, 'start_result_uncertain')
    }
    if (productResult.status !== 'started' && productResult.status !== 'already_started') {
      return uncertainStart(productResult, 'start_result_uncertain')
    }
    const processRef = productResult.processRef
    const existing = this.#retained.get(processRef)
    if (existing) {
      if (!sameBinding(existing.binding, exactBinding)) {
        return uncertainStart(productResult, 'scope_not_live', processRef)
      }
      if (existing.terminal || !existing.stdio || !existing.custody) {
        return uncertainStart(existing.startProductResult, 'stdio_custody_failed', processRef, existing.stdio)
      }
      return Object.freeze({ status: 'already_started', processRef, anchorReady: 'committed_ownership_and_anchor_handshake_only', stdio: existing.stdio })
    }
    const stdio = this.#spawner.providerStdioFor(processRef)
    if (!stdio || stdio.processRef !== processRef) {
      this.#retained.set(processRef, {
        binding: exactBinding,
        processRef,
        startProductResult: productResult,
        consumerClaim: 'not_present',
      })
      return uncertainStart(productResult, 'stdio_custody_failed', processRef)
    }
    try {
      const custody = this.#claimProviderStdio({ binding: exactBinding, processRef, stdio })
      requireStdioCustody(custody, processRef)
      this.#retained.set(processRef, {
        binding: exactBinding,
        processRef,
        startProductResult: productResult,
        stdio,
        custody,
        consumerClaim: 'claimed',
      })
      return Object.freeze({ status: productResult.status, processRef, anchorReady: 'committed_ownership_and_anchor_handshake_only', stdio })
    } catch {
      // Ownership is already committed. Do not report no-effect or destroy anonymous pipes as if
      // that proved drain; the caller must reconcile/stop this exact Product scope.
      this.#retained.set(processRef, {
        binding: exactBinding,
        processRef,
        startProductResult: productResult,
        stdio,
        consumerClaim: 'unavailable',
      })
      return uncertainStart(productResult, 'stdio_custody_failed', processRef, stdio)
    }
  }

  async stop(input: Readonly<{
    binding: HostedNativeAnchorUnitBinding
    processRef: SupervisedProcessRef
    mode: 'graceful' | 'immediate'
    cancellation: RuntimeCancellation
  }>): Promise<HostedNativeAnchorStopResult> {
    const retained = this.#retained.get(input.processRef)
    if (!retained || !sameBinding(retained.binding, input.binding)) {
      return uncertainStop({ status: 'scope_not_live' }, 'scope_not_live')
    }
    if (retained.terminal?.invokingRelease) return unsettledConsumerStop(retained.terminal)
    if (retained.stopInFlight) return retained.stopInFlight

    const stopInFlight = this.#stopRetained(retained, input)
    retained.stopInFlight = stopInFlight
    try {
      return await stopInFlight
    } finally {
      if (retained.stopInFlight === stopInFlight) retained.stopInFlight = undefined
    }
  }

  async #stopRetained(retained: RetainedUnit, input: Readonly<{
    binding: HostedNativeAnchorUnitBinding
    processRef: SupervisedProcessRef
    mode: 'graceful' | 'immediate'
    cancellation: RuntimeCancellation
  }>): Promise<HostedNativeAnchorStopResult> {
    if (retained.terminal) return this.#settleTerminalCustody(retained)

    let result: StopProcessExecutionUnitResult
    try {
      result = await this.#supervisor.stop({
        planRef: retained.binding.launchSpec.planRef,
        executionUnitId: retained.binding.executionUnit.executionUnitId,
        processRef: retained.processRef,
        mode: input.mode,
        cancellation: input.cancellation,
      })
    } catch {
      return uncertainStop({ status: 'unclassified_residual' }, 'stop_result_uncertain')
    }
    if (result.status === 'drained' || result.status === 'already_drained') {
      const productDrain = Object.freeze({ ...result, status: result.status })
      retained.terminal = {
        productResult: productDrain,
        releaseUnavailable: retained.consumerClaim === 'unavailable',
        consumerSettlement: retained.consumerClaim === 'claimed'
          ? 'pending'
          : retained.consumerClaim === 'not_present' ? 'settled' : 'failed',
        invokingRelease: false,
        stdioClosed: false,
        providerStdioClosed: false,
        transportClosed: false,
      }
      return this.#settleTerminalCustody(retained)
    }
    return uncertainStop(result, 'stop_result_uncertain')
  }

  async #settleTerminalCustody(retained: RetainedUnit): Promise<HostedNativeAnchorStopResult> {
    const terminal = retained.terminal
    if (!terminal) throw new TypeError('hosted-native-anchor-terminal-custody-missing')
    if (terminal.consumerSettlement === 'settled') {
      return this.#settledTerminalResult(retained, terminal)
    }
    if (terminal.releaseUnavailable) return unsettledConsumerStop(terminal, 'failed')

    if (!terminal.releaseInFlight || terminal.consumerSettlement === 'failed') {
      terminal.consumerSettlement = 'pending'
      terminal.invokingRelease = true
      let released: void | Promise<void>
      let releaseThrew = false
      try {
        if (!retained.custody) throw new TypeError('hosted-native-anchor-stdio-release-custody-missing')
        released = retained.custody.release()
      } catch {
        terminal.consumerSettlement = 'failed'
        releaseThrew = true
        released = undefined
      } finally {
        terminal.invokingRelease = false
      }
      terminal.releaseInFlight = releaseThrew
        ? Promise.resolve('failed')
        : Promise.resolve(released).then(
            () => {
              terminal.consumerSettlement = 'settled'
              return 'settled' as const
            },
            () => {
              terminal.consumerSettlement = 'failed'
              return 'failed' as const
            },
          )
    }

    const releaseInFlight = terminal.releaseInFlight
    if (!releaseInFlight) throw new TypeError('hosted-native-anchor-stdio-release-missing')
    const settlement = await boundedSettlement(releaseInFlight, this.#stopTimeoutMs)
    if (settlement === 'settled') return this.#settledTerminalResult(retained, terminal)
    return unsettledConsumerStop(terminal, settlement)
  }

  #settledTerminalResult(retained: RetainedUnit, terminal: TerminalCustody): HostedNativeAnchorStopResult {
    if (!this.#closeTerminalTransport(retained, terminal)) return unsettledTransportStop(terminal)
    return Object.freeze({ status: terminal.productResult.status })
  }

  #closeTerminalTransport(retained: RetainedUnit, terminal: TerminalCustody): boolean {
    if (terminal.transportClosed) return true
    try {
      if (!terminal.stdioClosed) {
        retained.stdio?.close()
        terminal.stdioClosed = true
      }
      if (!terminal.providerStdioClosed) {
        this.#spawner.closeProviderStdio(retained.processRef)
        terminal.providerStdioClosed = true
      }
    } catch {
      return false
    }
    terminal.transportClosed = terminal.stdioClosed && terminal.providerStdioClosed
    return terminal.transportClosed
  }

  async observe(input: Readonly<{
    binding: HostedNativeAnchorUnitBinding
    processRef: SupervisedProcessRef
  }>): Promise<HostedNativeAnchorObserveResult> {
    const retained = this.#retained.get(input.processRef)
    if (!retained || !sameBinding(retained.binding, input.binding)) {
      return Object.freeze({ status: 'uncertain', disposition: disposition('scope_not_live') })
    }
    const terminal = retained.terminal
    if (terminal) {
      if (terminal.consumerSettlement !== 'settled') {
        return Object.freeze({ status: 'uncertain', disposition: disposition('stdio_custody_release_unsettled') })
      }
      if (!terminal.transportClosed) {
        return Object.freeze({ status: 'uncertain', disposition: disposition('stdio_transport_close_unsettled') })
      }
      return Object.freeze({ status: 'exited', outcome: 'drained' })
    }
    let result: ObserveProcessExecutionUnitResult
    try {
      result = await this.#supervisor.observe({
        planRef: retained.binding.launchSpec.planRef,
        executionUnitId: retained.binding.executionUnit.executionUnitId,
        processRef: retained.processRef,
      })
    } catch {
      return Object.freeze({ status: 'uncertain', disposition: disposition('observation_uncertain') })
    }
    if (result.status === 'starting' || result.status === 'ready' || result.status === 'stopping') return result
    if (result.status === 'exited') {
      return Object.freeze({ status: 'exited', outcome: 'unknown', disposition: disposition('observation_uncertain') })
    }
    return Object.freeze({ status: 'uncertain', disposition: disposition('observation_uncertain') })
  }
}

function snapshotAndValidateBinding(binding: HostedNativeAnchorUnitBinding): HostedNativeAnchorUnitBinding {
  if (!binding || typeof binding.ownerPlanGeneration !== 'string' || binding.ownerPlanGeneration.length < 16 ||
    typeof binding.ownerUnitBindingId !== 'string' || binding.ownerUnitBindingId.length < 1 ||
    !Array.isArray(binding.orderedMembers) || binding.orderedMembers.length < 1) {
    throw new TypeError('hosted-native-anchor-unit-binding-invalid')
  }
  if (binding.executionUnit.executionUnitId !== binding.launchSpec.executionUnitId ||
    binding.executionUnit.backendBinding.backend !== 'provisioning_cli' ||
    binding.launchSpec.backend !== 'provisioning_cli' ||
    binding.executionUnit.memberIds.length !== binding.orderedMembers.length) {
    throw new TypeError('hosted-native-anchor-product-scope-invalid')
  }
  let previousOrdinal = -1
  for (let index = 0; index < binding.orderedMembers.length; index += 1) {
    const member = binding.orderedMembers[index]
    if (!member || !Number.isSafeInteger(member.ordinal) || member.ordinal < 0 || member.ordinal <= previousOrdinal ||
      member.memberId !== binding.executionUnit.memberIds[index]) {
      throw new TypeError('hosted-native-anchor-member-order-invalid')
    }
    previousOrdinal = member.ordinal
  }
  return deepFreezeClone(binding)
}

function sameBinding(left: HostedNativeAnchorUnitBinding, right: HostedNativeAnchorUnitBinding): boolean {
  return isDeepStrictEqual(left, right)
}

function requireStdioCustody(custody: HostedNativeProviderStdioCustody, processRef: SupervisedProcessRef): void {
  if (!custody || custody.processRef !== processRef || custody.stdoutConsumption !== 'attached' ||
    custody.stderrConsumption !== 'attached' || typeof custody.release !== 'function') {
    throw new TypeError('hosted-native-anchor-stdio-custody-invalid')
  }
}

function requirePositiveTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`hosted-native-anchor-${name}-timeout-invalid`)
}

function freezeCatalog(catalog: NodeAnchorLaunchAuthorityCatalog): NodeAnchorLaunchAuthorityCatalog {
  if (!catalog || !Array.isArray(catalog.executables) || !Array.isArray(catalog.workdirs) || !Array.isArray(catalog.environments)) {
    throw new TypeError('hosted-native-anchor-launch-catalog-invalid')
  }
  return deepFreezeClone(catalog)
}

function deepFreezeClone<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => deepFreezeClone(item))) as T
  if (value && typeof value === 'object') {
    const clone: Record<PropertyKey, unknown> = {}
    for (const key of Reflect.ownKeys(value as object)) clone[key] = deepFreezeClone((value as Record<PropertyKey, unknown>)[key])
    return Object.freeze(clone) as T
  }
  return value
}

function disposition(reason: HostedNativeAnchorDisposition['reason']): HostedNativeAnchorDisposition {
  return Object.freeze({ required: true, reason })
}

function uncertainStart(
  productResult: StartProcessExecutionUnitResult,
  reason: HostedNativeAnchorDisposition['reason'],
  processRef?: SupervisedProcessRef,
  stdio?: NodeAnchorProviderStdio,
): HostedNativeAnchorStartResult {
  if (processRef === undefined) {
    return Object.freeze({ status: 'uncertain', productResult, disposition: disposition(reason) })
  }
  if (stdio === undefined) {
    return Object.freeze({ status: 'uncertain', productResult, processRef, disposition: disposition(reason) })
  }
  return Object.freeze({ status: 'uncertain', productResult, processRef, stdio, disposition: disposition(reason) })
}

function uncertainStop(productResult: StopProcessExecutionUnitResult | { status: 'scope_not_live' }, reason: HostedNativeAnchorDisposition['reason']): HostedNativeAnchorStopResult {
  return Object.freeze({ status: 'uncertain', productResult, disposition: disposition(reason) })
}

function unsettledConsumerStop(
  terminal: TerminalCustody,
  settlement: 'pending' | 'failed' = 'pending',
): HostedNativeAnchorStopResult {
  return Object.freeze({
    status: 'uncertain',
    productResult: terminal.productResult,
    processDrain: Object.freeze({ status: terminal.productResult.status }),
    consumerSettlement: settlement,
    disposition: disposition('stdio_custody_release_unsettled'),
  })
}

function unsettledTransportStop(terminal: TerminalCustody): HostedNativeAnchorStopResult {
  return Object.freeze({
    status: 'uncertain',
    productResult: terminal.productResult,
    processDrain: Object.freeze({ status: terminal.productResult.status }),
    transportClosure: 'failed',
    disposition: disposition('stdio_transport_close_unsettled'),
  })
}

async function boundedSettlement(
  release: Promise<'settled' | 'failed'>,
  timeoutMs: number,
): Promise<'settled' | 'failed' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      release,
      new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
