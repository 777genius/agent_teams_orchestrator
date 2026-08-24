import { join } from 'node:path'
import {
  readHostedControlSecret,
  resolveHostedControlOwnerBinding,
  validateHostedControlOwnerBinding,
} from './ownerProof.js'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import type {
  HostedLifecycleAuthority,
  HostedLifecycleCommandPort,
  HostedTeamMessagePort,
} from './HostedControlDispatcher.js'
import type { HostedControlAuthority, HostedControlStableAuthority } from './protocol.js'
import type { HostedApprovalWirePort } from './HostedApprovalWire.js'
import {
  HostedControlServer,
  type HostedApprovalActivationSessionFactory,
} from './HostedControlServer.js'
import { HostedTaskMutationService } from './HostedTaskMutationService.js'
import { HostedTaskMutationWal } from './HostedTaskMutationWal.js'
import { HostedRootOwnerLease } from './HostedRootOwnerLease.js'
import type {
  HostedControlBootstrapAdmission,
  HostedControlDescriptorGuard,
} from './HostedControlBootstrap.js'
import {
  hostedControlAuthorityFromConfig,
  hostedControlOwnerIdentityFromConfig,
  loadHostedControlRuntimeConfig,
  validateHostedControlRuntimePaths,
  type HostedControlRuntimeConfig,
} from './HostedControlRuntimeConfig.js'

export type HostedControlRuntimePorts = {
  lifecycle: HostedLifecycleCommandPort
  messages: HostedTeamMessagePort
  /**
   * Deliberately optional until the external lifecycle approval owner is installed.
   * When activation is composed, this is the stable activation-managed port: it
   * must fail closed before activation and synchronously after session revocation.
   */
  approvals?: HostedApprovalWirePort
  /** Per-connection O2-C activation boundary; omitted for legacy composition. */
  activationSessionFactory?: HostedApprovalActivationSessionFactory
  close(): Promise<void>
}

export type HostedControlRuntimePortFactoryContext = {
  authority: Readonly<HostedControlStableAuthority>
  readonly legacyKey: string
  /** Canonical owner-validated root for all private hosted durable state. */
  teamRoot: string
  isCurrentAuthority(authority: HostedControlAuthority | HostedLifecycleAuthority): Promise<boolean>
}

export type HostedControlRuntimePortFactory = (
  context: HostedControlRuntimePortFactoryContext,
) => HostedControlRuntimePorts | Promise<HostedControlRuntimePorts>

export class HostedControlRuntime {
  #server: HostedControlServer | null = null
  #ports: HostedControlRuntimePorts | null = null
  #acceptingEffects = false
  #operationTail: Promise<void> = Promise.resolve()
  #startup: { cancelled: boolean } | null = null
  #startRequested = false
  #rootLease: HostedRootOwnerLease | null = null
  #descriptorGuard: HostedControlDescriptorGuard | null = null
  #descriptorAuthorityLost = false
  #secret: Buffer | null = null

  constructor(
    private readonly source: string | HostedControlBootstrapAdmission,
    private readonly createPorts: HostedControlRuntimePortFactory,
  ) {}

  get server(): HostedControlServer | null {
    return this.#server
  }

  async start(): Promise<void> {
    if (this.#startRequested || this.#server) throw new Error('Hosted control runtime is already started')
    this.#startRequested = true
    const startup = { cancelled: false }
    this.#startup = startup
    return this.#enqueue(async () => {
      try {
        await this.#start(startup)
      } finally {
        if (this.#startup === startup) this.#startup = null
        if (!this.#server) this.#startRequested = false
      }
    })
  }

  async #start(startup: { cancelled: boolean }): Promise<void> {
    const descriptorAdmission = typeof this.source === 'string' ? null : this.source
    if (descriptorAdmission) {
      this.#secret = descriptorAdmission.secret
      this.#descriptorGuard = descriptorAdmission.guard
      this.#descriptorAuthorityLost = false
      this.#watchDescriptorAuthority(descriptorAdmission.guard)
    }
    let rootLease: HostedRootOwnerLease | null = null
    let server: HostedControlServer | null = null
    let ports: HostedControlRuntimePorts | null = null
    try {
      const config: HostedControlRuntimeConfig | HostedControlBootstrapAdmission['config'] =
        descriptorAdmission?.config ?? await loadHostedControlRuntimeConfig(this.source as string)
      if (descriptorAdmission) await validateHostedControlRuntimePaths(config)
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      const secret = descriptorAdmission?.secret ?? await readHostedControlSecret((config as HostedControlRuntimeConfig).secretFile)
      this.#secret = secret
      const ownerScope = await resolveHostedControlOwnerBinding({
        claudeRoot: config.claudeRoot,
        legacyKey: config.legacyKey,
      })
      if (this.#descriptorGuard && !(await this.#descriptorGuard.assertCurrent())) {
        throw new Error('Hosted control launcher authority is no longer current')
      }
      const configuredAuthority = hostedControlAuthorityFromConfig(config)
      const authority: HostedControlStableAuthority = Object.freeze({
        ...configuredAuthority,
        mountBinding: Object.freeze({ ...configuredAuthority.mountBinding }),
      })
      const wal = new HostedTaskMutationWal(
        join(config.claudeRoot, 'teams', config.legacyKey),
        config.teamId,
      )
      rootLease = descriptorAdmission ? null : new HostedRootOwnerLease(ownerScope.canonicalTeamRoot)
      await rootLease?.acquire()
      this.#rootLease = rootLease
      let startupRecovery = true
      const validateOwner = async (): Promise<boolean> => {
        if (!this.#acceptingEffects) return false
        const validRoot = await validateHostedControlOwnerBinding({
          claudeRoot: config.claudeRoot,
          legacyKey: config.legacyKey,
          expectedRootIdentity: ownerScope.rootIdentity,
        })
        if (!validRoot) return false
        if (this.#descriptorGuard && !(await this.#descriptorGuard.assertCurrent())) return false
        return startupRecovery || !!server && await server.hasActiveLease()
      }
      const isCurrentAuthority = async (
        candidate: HostedControlAuthority | HostedLifecycleAuthority,
      ): Promise<boolean> => authorityMatches(candidate, authority) && await validateOwner()
      const taskService = new HostedTaskMutationService({
        claudeRoot: config.claudeRoot,
        legacyKey: config.legacyKey,
        authority,
        wal,
        validateOwner,
      })
      if (startup.cancelled || this.#descriptorAuthorityLost) {
        throw new Error('Hosted control launcher authority is no longer current')
      }
      this.#acceptingEffects = true
      if (!(await taskService.recover())) {
        throw new Error('Hosted control WAL recovery did not establish a safe state')
      }
      startupRecovery = false
      let dispatcher: HostedControlDispatcher
      if (!(await validateHostedControlOwnerBinding({
        claudeRoot: config.claudeRoot,
        legacyKey: config.legacyKey,
        expectedRootIdentity: ownerScope.rootIdentity,
      })) || this.#descriptorGuard && !(await this.#descriptorGuard.assertCurrent())) {
        this.#acceptingEffects = false
        throw new Error('Hosted control owner changed before port composition')
      }
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      ports = await this.createPorts(Object.freeze({
        authority,
        legacyKey: config.legacyKey,
        teamRoot: ownerScope.canonicalTeamRoot,
        isCurrentAuthority,
      }))
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      server = new HostedControlServer({
        socketPath: config.socketPath,
        secret,
        ownerIdentity: hostedControlOwnerIdentityFromConfig(config),
        authority,
        service: taskService,
        bootstrapBinding: descriptorAdmission?.bootstrapBinding,
        dispatchCoexistingOperation: (message, rawLine) => dispatcher.dispatch(message, rawLine),
        activationSessionFactory: ports.activationSessionFactory,
      })
      dispatcher = new HostedControlDispatcher({
        secret,
        authority,
        getOwnerBinding: () => server?.ownerBinding ?? null,
        lifecycle: ports.lifecycle,
        messages: ports.messages,
        approvals: ports.approvals,
      })
      if (this.#descriptorGuard && !(await this.#descriptorGuard.assertCurrent())) {
        throw new Error('Hosted control launcher authority was lost before socket publication')
      }
      await server.start()
      if (this.#descriptorGuard && !(await this.#descriptorGuard.assertCurrent())) {
        throw new Error('Hosted control launcher authority was lost during socket publication')
      }
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      this.#ports = ports
      this.#server = server
    } catch (error) {
      this.#acceptingEffects = false
      this.#ports = null
      // Activation invalidation and handler draining must precede composed
      // approval/lifecycle/message port teardown.
      await server?.stop().catch(() => undefined)
      await ports?.close().catch(() => undefined)
      this.#rootLease = null
      try { await rootLease?.release() } finally { await this.#disposeDescriptorAuthority() }
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this.#startup) this.#startup.cancelled = true
    this.#acceptingEffects = false
    return this.#enqueue(async () => {
      const server = this.#server
      const ports = this.#ports
      this.#server = null
      this.#ports = null
      this.#startRequested = false
      try {
        await server?.stop()
      } finally {
        try { await ports?.close() } finally {
          const rootLease = this.#rootLease
          this.#rootLease = null
          try { await rootLease?.release() } finally { await this.#disposeDescriptorAuthority() }
        }
      }
    })
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.catch(() => undefined)
    return result
  }

  #watchDescriptorAuthority(guard: HostedControlDescriptorGuard): void {
    const lost = (): void => {
      // Ignore close-induced resolution from an authority already detached by
      // disposal. A live descriptor loss must synchronously fence admission;
      // the queued stop then removes the socket and drains owned effects.
      if (this.#descriptorGuard !== guard) return
      this.#descriptorAuthorityLost = true
      this.#acceptingEffects = false
      if (this.#startup) this.#startup.cancelled = true
      void this.stop().catch(() => undefined)
    }
    void guard.lost.then(lost, lost)
  }

  async #disposeDescriptorAuthority(): Promise<void> {
    const guard = this.#descriptorGuard
    const secret = this.#secret
    this.#descriptorGuard = null
    this.#secret = null
    secret?.fill(0)
    await guard?.close()
  }
}

function authorityMatches(
  candidate: HostedControlAuthority | HostedLifecycleAuthority,
  expected: HostedControlStableAuthority,
): boolean {
  if (candidate.workspaceId !== expected.workspaceId || candidate.teamId !== expected.teamId ||
    candidate.deploymentId !== expected.deploymentId || candidate.restoreGeneration !== expected.restoreGeneration ||
    candidate.bootId !== expected.bootId) return false
  return 'mountBinding' in candidate
    ? candidate.mountBinding.mountGeneration === expected.mountBinding.mountGeneration &&
      candidate.mountBinding.declaredRootHash === expected.mountBinding.declaredRootHash
    : candidate.mountGeneration === expected.mountBinding.mountGeneration
}
