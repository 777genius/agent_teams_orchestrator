import { isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import {
  openCodeSessionBridge,
  type OpenCodeSessionBridge,
} from '../opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore, type OpenCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import {
  fingerprintOpenCodeApprovalSessionRecord,
  liveEffectFingerprint,
} from './OpenCodeHostedApprovalRuntimeAdapter.js'
import type { HostedApprovalRuntimeAdmission, HostedApprovalRuntimeRoute } from './HostedApprovalRuntimeAdmission.js'
import type {
  HostedApprovalRuntimeBindingFence,
  HostedApprovalRuntimeBindingPin,
} from './HostedApprovalRuntimeBindingFence.js'
import {
  captureHostedControlProcessIdentity,
  type HostedControlProcessIdentity,
} from './HostedControlProcessIdentity.js'
import type { HostedControlOwnerBinding } from './protocol.js'

export type HostedApprovalRuntimeBindingOwner = HostedControlOwnerBinding & {
  teamId: string
  socketPath: string
  processIdentity: HostedControlProcessIdentity
}

export type HostedApprovalRuntimeBindingCapability = {
  schemaVersion: 2
  protocol: 'agent-teams-hosted-approval-v2'
  authentication: 'opencode-basic'
  runtimeInstanceId: string
  configGeneration: string
}

export type HostedApprovalRuntimeBinding = {
  outerAuthority: HostedApprovalRuntimeAdmission['outerAuthority']
  routes: readonly HostedApprovalRuntimeRoute[]
  memberIdsByName: Readonly<Record<string, string>>
  actorMembers: Readonly<Record<string, string>>
  owner: HostedApprovalRuntimeBindingOwner
  capability: HostedApprovalRuntimeBindingCapability
}

export type AuthoritativeHostedApprovalRuntimeBinding = HostedApprovalRuntimeBinding

type OwnerSource = {
  socketPath: string
  processId?: number
  getProcessId?(): number | null
  getOwnerBinding(): HostedControlOwnerBinding | null
  isCurrent(): Promise<boolean>
}

/**
 * Builds the closed transition-contract binding exclusively from recovered
 * admission, live session/profile/host evidence, and the current hosted owner.
 */
export class OpenCodeHostedApprovalRuntimeBindingSource {
  constructor(private readonly options: {
    admission: HostedApprovalRuntimeAdmission
    fence: HostedApprovalRuntimeBindingFence
    owner: OwnerSource
    approvalOwner: { isAdmissionRecoveredCurrent(): Promise<boolean> }
    sessions?: Pick<OpenCodeSessionStore, 'get'>
    bridge?: Pick<OpenCodeSessionBridge, 'captureHostedApprovalBinding'>
    captureProcessIdentity?: (pid: number) => Promise<HostedControlProcessIdentity>
  }) {}

  async capture(pin?: HostedApprovalRuntimeBindingPin): Promise<HostedApprovalRuntimeBinding> {
    const operation = async () => await this.#captureFenced()
    return pin
      ? await this.options.fence.capturePinned(pin, operation)
      : await this.options.fence.capture(operation)
  }

  async captureBinding(pin?: HostedApprovalRuntimeBindingPin): Promise<HostedApprovalRuntimeBinding> {
    return await this.capture(pin)
  }

  async captureHostedApprovalBinding(
    pin?: HostedApprovalRuntimeBindingPin,
  ): Promise<HostedApprovalRuntimeBinding> {
    return await this.capture(pin)
  }

  async #captureFenced(): Promise<HostedApprovalRuntimeBinding> {
    const sessions = this.options.sessions ?? openCodeSessionStore
    const bridge = this.options.bridge ?? openCodeSessionBridge
    const processIdentity = this.options.captureProcessIdentity ?? captureHostedControlProcessIdentity

    if (!(await this.#sourcesCurrent())) throw unavailable()
    const ownerBinding = this.options.owner.getOwnerBinding()
    if (!ownerBinding || !validOwner(ownerBinding, this.options.owner.socketPath)) throw unavailable()
    const ownerPid = this.options.owner.getProcessId?.() ?? this.options.owner.processId
    if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
      throw unavailable()
    }
    const ownerProcessBefore = await processIdentity(ownerPid)
    if (!validProcessIdentity(ownerProcessBefore) || ownerProcessBefore.pid !== ownerPid) {
      throw unavailable()
    }

    const routes = [...this.options.admission.routes].sort((left, right) =>
      left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0,
    )
    if (!validOuterAuthority(this.options.admission.outerAuthority) ||
      routes.length < 1 || routes.length > 256 ||
      routes.some((route, index) => !validRoute(route) ||
        (index > 0 && routes[index - 1]?.routeId === route.routeId)) ||
      new Set(routes.map(route => route.authority.sessionId)).size !== routes.length) {
      throw unavailable()
    }

    let capability: HostedApprovalRuntimeBindingCapability | null = null
    const capturedRoutes: HostedApprovalRuntimeRoute[] = []
    for (const route of routes) {
      const record = await sessions.get(
        route.authority.teamId,
        route.authority.laneId,
        route.memberName,
      )
      if (!record || record.teamId !== route.authority.teamId ||
        (record.laneId ?? 'primary') !== route.authority.laneId ||
        record.runId !== route.authority.runId || record.memberName !== route.memberName ||
        record.providerId !== 'opencode' || record.opencodeSessionId !== route.authority.sessionId ||
        record.toolApprovalMode !== 'manual' || record.staleReason !== null ||
        record.openCodeArtifactDigest !== route.openCodeBinding.openCodeArtifactDigest) {
        throw unavailable()
      }

      const capture = await bridge.captureHostedApprovalBinding(record)
      if (capture.context.record !== record || capture.context.host.pid !== capture.processIdentity.pid ||
        !validProcessIdentity(capture.processIdentity) ||
        capture.context.host.openCodeArtifactDigest !== route.openCodeBinding.openCodeArtifactDigest ||
        capture.capability.runtimeInstanceId !== route.authority.runtimeInstanceId ||
        capture.capability.runtimeInstanceId !== route.openCodeBinding.runtimeInstanceId ||
        fingerprintOpenCodeApprovalSessionRecord(record) !== route.openCodeBinding.sessionRecordFingerprint ||
        liveEffectFingerprint(capture.context) !== route.openCodeBinding.liveEffectFingerprint) {
        throw unavailable()
      }
      if (!/^runtime_instance_[0-9a-f]{32}$/.test(capture.capability.runtimeInstanceId) ||
        !/^config_generation_[0-9a-f]{32}$/.test(capture.capability.configGeneration)) {
        throw unavailable()
      }
      if (capability && !isDeepStrictEqual(capability, capture.capability)) throw unavailable()
      capability = {
        schemaVersion: 2,
        protocol: 'agent-teams-hosted-approval-v2',
        authentication: 'opencode-basic',
        runtimeInstanceId: capture.capability.runtimeInstanceId,
        configGeneration: capture.capability.configGeneration,
      }
      capturedRoutes.push(cloneRoute(route))
    }
    if (!capability) throw unavailable()

    const memberIdsByName = sortedDictionary(Object.fromEntries(capturedRoutes.map(route =>
      [route.memberName, route.authority.deliveryOwnerId],
    )))
    const actorMembers = sortedDictionary(this.options.admission.actorMembers)
    const memberValues = Object.values(memberIdsByName)
    const actorValues = Object.values(actorMembers)
    if (Object.keys(memberIdsByName).length !== capturedRoutes.length ||
      memberValues.length !== actorValues.length || new Set(memberValues).size !== memberValues.length ||
      new Set(actorValues).size !== actorValues.length ||
      Object.entries(actorMembers).some(([actorId, memberId]) =>
        !/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(actorId) ||
        !/^member_[0-9a-f]{32}$/.test(memberId)) ||
      [...memberValues].sort().join('\0') !== [...actorValues].sort().join('\0') ||
      capturedRoutes.some(route =>
        memberIdsByName[route.memberName] !== route.authority.deliveryOwnerId ||
        actorMembers[route.scope.principalId] !== route.authority.deliveryOwnerId ||
        route.authority.deploymentId !== this.options.admission.outerAuthority.deploymentId ||
        route.authority.teamId !== this.options.admission.outerAuthority.teamId ||
        route.scope.workspaceId !== this.options.admission.outerAuthority.workspaceId ||
        route.scope.teamId !== this.options.admission.outerAuthority.teamId ||
        route.scope.restoreGeneration !== this.options.admission.outerAuthority.restoreGeneration ||
        route.openCodeBinding.planGeneration !== route.authority.planGeneration ||
        route.openCodeBinding.credentialGeneration !== route.authority.credentialGeneration ||
        route.openCodeBinding.credentialId !== route.authority.credentialId ||
        route.openCodeBinding.runtimeInstanceId !== route.authority.runtimeInstanceId ||
        route.openCodeBinding.deliveryOwnerId !== route.authority.deliveryOwnerId)) {
      throw unavailable()
    }

    const ownerProcessAfter = await processIdentity(ownerPid)
    const currentOwnerBinding = this.options.owner.getOwnerBinding()
    if (!isDeepStrictEqual(ownerProcessBefore, ownerProcessAfter) ||
      (this.options.owner.getProcessId?.() ?? this.options.owner.processId) !== ownerPid ||
      !isDeepStrictEqual(ownerBinding, currentOwnerBinding) || !(await this.#sourcesCurrent())) {
      throw unavailable()
    }

    return {
      outerAuthority: cloneOuterAuthority(this.options.admission.outerAuthority),
      routes: capturedRoutes,
      memberIdsByName,
      actorMembers,
      owner: {
        teamId: this.options.admission.outerAuthority.teamId,
        ownerAuthority: ownerBinding.ownerAuthority,
        ownerGeneration: ownerBinding.ownerGeneration,
        ownerSessionId: ownerBinding.ownerSessionId,
        socketPath: this.options.owner.socketPath,
        socketIdentity: {
          device: ownerBinding.socketIdentity.device,
          inode: ownerBinding.socketIdentity.inode,
          uid: ownerBinding.socketIdentity.uid,
          gid: ownerBinding.socketIdentity.gid,
          mode: ownerBinding.socketIdentity.mode,
        },
        processIdentity: {
          pid: ownerProcessAfter.pid,
          startIdentity: ownerProcessAfter.startIdentity,
        },
      },
      capability,
    }
  }

  async #sourcesCurrent(): Promise<boolean> {
    try {
      return await this.options.owner.isCurrent() &&
        await this.options.approvalOwner.isAdmissionRecoveredCurrent() &&
        await this.options.admission.isCurrent()
    } catch {
      return false
    }
  }
}

function cloneOuterAuthority(
  authority: HostedApprovalRuntimeAdmission['outerAuthority'],
): HostedApprovalRuntimeAdmission['outerAuthority'] {
  return {
    deploymentId: authority.deploymentId,
    bootId: authority.bootId,
    workspaceId: authority.workspaceId,
    teamId: authority.teamId,
    restoreGeneration: authority.restoreGeneration,
    mountBinding: {
      mountGeneration: authority.mountBinding.mountGeneration,
      declaredRootHash: authority.mountBinding.declaredRootHash,
    },
  }
}

function cloneRoute(route: HostedApprovalRuntimeRoute): HostedApprovalRuntimeRoute {
  return {
    routeId: route.routeId,
    authority: {
      deploymentId: route.authority.deploymentId,
      teamId: route.authority.teamId,
      runId: route.authority.runId,
      planGeneration: route.authority.planGeneration,
      laneId: route.authority.laneId,
      providerId: 'opencode',
      credentialGeneration: route.authority.credentialGeneration,
      credentialId: route.authority.credentialId,
      sessionId: route.authority.sessionId,
      runtimeInstanceId: route.authority.runtimeInstanceId,
      deliveryOwnerId: route.authority.deliveryOwnerId,
    },
    scope: {
      principalId: route.scope.principalId,
      workspaceId: route.scope.workspaceId,
      teamId: route.scope.teamId,
      authorityGeneration: route.scope.authorityGeneration,
      restoreGeneration: route.scope.restoreGeneration,
    },
    memberName: route.memberName,
    openCodeBinding: {
      toolApprovalMode: 'manual',
      planGeneration: route.openCodeBinding.planGeneration,
      credentialGeneration: route.openCodeBinding.credentialGeneration,
      credentialId: route.openCodeBinding.credentialId,
      runtimeInstanceId: route.openCodeBinding.runtimeInstanceId,
      deliveryOwnerId: route.openCodeBinding.deliveryOwnerId,
      openCodeArtifactDigest: route.openCodeBinding.openCodeArtifactDigest,
      sessionRecordFingerprint: route.openCodeBinding.sessionRecordFingerprint,
      liveEffectFingerprint: route.openCodeBinding.liveEffectFingerprint,
    },
  }
}

function sortedDictionary(input: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ))
}

function unavailable(): Error {
  return new Error('Hosted approval authoritative binding is unavailable')
}

function validOwner(binding: HostedControlOwnerBinding, socketPath: string): boolean {
  const socket = binding.socketIdentity
  return /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(binding.ownerAuthority) &&
    Number.isSafeInteger(binding.ownerGeneration) && binding.ownerGeneration > 0 &&
    /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(binding.ownerSessionId) &&
    isAbsolute(socketPath) && !socketPath.includes('\0') && normalize(socketPath) === socketPath &&
    Buffer.byteLength(socketPath) >= 1 && Buffer.byteLength(socketPath) <= 103 &&
    /^(?:0|[1-9][0-9]{0,31})$/.test(socket.device) &&
    /^(?:0|[1-9][0-9]{0,31})$/.test(socket.inode) &&
    Number.isSafeInteger(socket.uid) && socket.uid >= 0 &&
    Number.isSafeInteger(socket.gid) && socket.gid >= 0 && socket.mode === 0o600
}

function validProcessIdentity(identity: HostedControlProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    /^start_[0-9a-f]{64}$/.test(identity.startIdentity)
}

function validOuterAuthority(
  authority: HostedApprovalRuntimeAdmission['outerAuthority'],
): boolean {
  return /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/.test(authority.deploymentId) &&
    validIdentifier(authority.bootId) && validIdentifier(authority.workspaceId) &&
    /^team_[0-9a-f]{32}$/.test(authority.teamId) &&
    safeInteger(authority.restoreGeneration, 0) &&
    safeInteger(authority.mountBinding.mountGeneration, 1) &&
    /^[0-9a-f]{64}$/.test(authority.mountBinding.declaredRootHash)
}

function validRoute(route: HostedApprovalRuntimeRoute): boolean {
  const authority = route.authority
  const scope = route.scope
  const binding = route.openCodeBinding
  return validIdentifier(route.routeId) && validIdentifier(route.memberName) &&
    /^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/.test(authority.deploymentId) &&
    /^team_[0-9a-f]{32}$/.test(authority.teamId) && /^run_[0-9a-f]{32}$/.test(authority.runId) &&
    safeInteger(authority.planGeneration, 1) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(authority.laneId) &&
    authority.providerId === 'opencode' && safeInteger(authority.credentialGeneration, 1) &&
    validIdentifier(authority.credentialId) && validIdentifier(authority.sessionId) &&
    /^runtime_instance_[0-9a-f]{32}$/.test(authority.runtimeInstanceId) &&
    /^member_[0-9a-f]{32}$/.test(authority.deliveryOwnerId) &&
    /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/.test(scope.principalId) &&
    validIdentifier(scope.workspaceId) && /^team_[0-9a-f]{32}$/.test(scope.teamId) &&
    /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(scope.authorityGeneration) &&
    safeInteger(scope.restoreGeneration, 0) && binding.toolApprovalMode === 'manual' &&
    safeInteger(binding.planGeneration, 1) && safeInteger(binding.credentialGeneration, 1) &&
    validIdentifier(binding.credentialId) && /^runtime_instance_[0-9a-f]{32}$/.test(binding.runtimeInstanceId) &&
    /^member_[0-9a-f]{32}$/.test(binding.deliveryOwnerId) &&
    /^sha256:[0-9a-f]{64}$/.test(binding.openCodeArtifactDigest) &&
    /^[0-9a-f]{64}$/.test(binding.sessionRecordFingerprint) &&
    /^[0-9a-f]{64}$/.test(binding.liveEffectFingerprint)
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)
}

function safeInteger(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum
}
