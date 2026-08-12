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
import { HostedControlServer } from './HostedControlServer.js'
import { HostedTaskMutationService } from './HostedTaskMutationService.js'
import { HostedTaskMutationWal } from './HostedTaskMutationWal.js'
import { HostedRootOwnerLease } from './HostedRootOwnerLease.js'
import {
  hostedControlAuthorityFromConfig,
  hostedControlOwnerIdentityFromConfig,
  loadHostedControlRuntimeConfig,
} from './HostedControlRuntimeConfig.js'

export type HostedControlRuntimePorts = {
  lifecycle: HostedLifecycleCommandPort
  messages: HostedTeamMessagePort
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

  constructor(
    private readonly configPath: string,
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
    const config = await loadHostedControlRuntimeConfig(this.configPath)
    if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
    const [secret, ownerScope] = await Promise.all([
      readHostedControlSecret(config.secretFile),
      resolveHostedControlOwnerBinding({
        claudeRoot: config.claudeRoot,
        legacyKey: config.legacyKey,
      }),
    ])
    const configuredAuthority = hostedControlAuthorityFromConfig(config)
    const authority: HostedControlStableAuthority = Object.freeze({
      ...configuredAuthority,
      mountBinding: Object.freeze({ ...configuredAuthority.mountBinding }),
    })
    const wal = new HostedTaskMutationWal(
      join(config.claudeRoot, 'teams', config.legacyKey),
      config.teamId,
    )
    const rootLease = new HostedRootOwnerLease(ownerScope.canonicalTeamRoot)
    await rootLease.acquire()
    this.#rootLease = rootLease
    let startupRecovery = true
    let server: HostedControlServer | null = null
    const validateOwner = async (): Promise<boolean> => {
      if (!this.#acceptingEffects) return false
      const validRoot = await validateHostedControlOwnerBinding({
        claudeRoot: config.claudeRoot,
        legacyKey: config.legacyKey,
        expectedRootIdentity: ownerScope.rootIdentity,
      })
      if (!validRoot) return false
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
    this.#acceptingEffects = true
    try {
      if (!(await taskService.recover())) {
        throw new Error('Hosted control WAL recovery did not establish a safe state')
      }
    } catch (error) {
      this.#acceptingEffects = false
      this.#rootLease = null
      await rootLease.release()
      throw error
    }
    startupRecovery = false
    let dispatcher: HostedControlDispatcher
    server = new HostedControlServer({
      socketPath: config.socketPath,
      secret,
      ownerIdentity: hostedControlOwnerIdentityFromConfig(config),
      authority,
      service: taskService,
      dispatchCoexistingOperation: message => dispatcher.dispatch(message),
    })
    if (!(await validateHostedControlOwnerBinding({
      claudeRoot: config.claudeRoot,
      legacyKey: config.legacyKey,
      expectedRootIdentity: ownerScope.rootIdentity,
    }))) {
      this.#acceptingEffects = false
      throw new Error('Hosted control owner changed before port composition')
    }
    let ports: HostedControlRuntimePorts | null = null
    try {
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      ports = await this.createPorts(Object.freeze({
        authority,
        legacyKey: config.legacyKey,
        teamRoot: ownerScope.canonicalTeamRoot,
        isCurrentAuthority,
      }))
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      dispatcher = new HostedControlDispatcher({
        secret,
        authority,
        getOwnerBinding: () => server?.ownerBinding ?? null,
        lifecycle: ports.lifecycle,
        messages: ports.messages,
      })
      await server.start()
      if (startup.cancelled) throw new Error('Hosted control runtime startup was cancelled')
      this.#ports = ports
      this.#server = server
    } catch (error) {
      this.#acceptingEffects = false
      this.#ports = null
      await Promise.allSettled([ports?.close(), server.stop()])
      this.#rootLease = null
      await rootLease.release()
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
          await rootLease?.release()
        }
      }
    })
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.catch(() => undefined)
    return result
  }
}

function authorityMatches(
  candidate: HostedControlAuthority | HostedLifecycleAuthority,
  expected: HostedControlStableAuthority,
): boolean {
  if (candidate.workspaceId !== expected.workspaceId || candidate.teamId !== expected.teamId ||
    candidate.deploymentId !== expected.deploymentId || candidate.restoreGeneration !== expected.restoreGeneration ||
    candidate.bootId !== expected.bootId) return false
  return !('mountBinding' in candidate) ||
    candidate.mountBinding.mountGeneration === expected.mountBinding.mountGeneration &&
    candidate.mountBinding.declaredRootHash === expected.mountBinding.declaredRootHash
}
