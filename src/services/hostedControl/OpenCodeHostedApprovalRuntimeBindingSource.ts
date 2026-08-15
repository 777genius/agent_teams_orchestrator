import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { OpenCodePermissionEffectContext } from '../opencode/OpenCodeSessionBridge.js'
import type { OpenCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import type { OpenCodeHostedApprovalCapability, OpenCodeSessionRecord } from '../opencode/types.js'
import {
  fingerprintHostedApprovalLiveEffect,
  fingerprintHostedApprovalSessionRecord,
} from './HostedApprovalRuntimeBindingFingerprint.js'
import type {
  HostedApprovalRuntimeBindingFence,
  HostedApprovalRuntimeBindingPin,
} from './HostedApprovalRuntimeBindingFence.js'
import {
  captureHostedControlProcessIdentity,
  type HostedControlProcessIdentity,
} from './HostedControlProcessIdentity.js'
import type { HostedControlOwnerBinding } from './protocol.js'
export {
  HOSTED_APPROVAL_BINDING_GOLDEN_DIGEST,
  HOSTED_APPROVAL_TRANSITION_CONTRACT_SHA256,
} from './HostedApprovalTransitionBindingContract.js'

export type HostedApprovalRuntimeOuterAuthority = {
  deploymentId: string
  bootId: string
  workspaceId: string
  teamId: string
  restoreGeneration: number
  mountBinding: { mountGeneration: number; declaredRootHash: string }
}

export type HostedApprovalRuntimeRoute = {
  routeId: string
  authority: {
    deploymentId: string; teamId: string; runId: string; planGeneration: number; laneId: string
    providerId: 'opencode'; credentialGeneration: number; credentialId: string; sessionId: string
    runtimeInstanceId: string; deliveryOwnerId: string
  }
  scope: {
    principalId: string; workspaceId: string; teamId: string
    authorityGeneration: string; restoreGeneration: number
  }
  memberName: string
  openCodeBinding: {
    toolApprovalMode: 'manual'; planGeneration: number; credentialGeneration: number
    credentialId: string; runtimeInstanceId: string; deliveryOwnerId: string
    openCodeArtifactDigest: `sha256:${string}`
    sessionRecordFingerprint: string; liveEffectFingerprint: string
  }
}

export type HostedApprovalRuntimeBindingOwner = HostedControlOwnerBinding & {
  teamId: string
  socketPath: string
  processIdentity: HostedControlProcessIdentity
}

export type HostedApprovalRuntimeBindingCapability = OpenCodeHostedApprovalCapability

export type HostedApprovalRuntimeBinding = {
  outerAuthority: HostedApprovalRuntimeOuterAuthority
  routes: readonly HostedApprovalRuntimeRoute[]
  memberIdsByName: Readonly<Record<string, string>>
  actorMembers: Readonly<Record<string, string>>
  owner: HostedApprovalRuntimeBindingOwner
  capability: HostedApprovalRuntimeBindingCapability
}

export type AuthoritativeHostedApprovalRuntimeBinding = HostedApprovalRuntimeBinding

export type HostedApprovalLifecycleBindingRecord = {
  outerAuthority: HostedApprovalRuntimeOuterAuthority
  routes: readonly {
    routeId: string; runId: string; planGeneration: number; laneId: string
    authorityGeneration: string
  }[]
}

export type HostedApprovalMembershipBindingRecord = {
  members: readonly {
    routeId: string; memberName: string; principalId: string; deliveryOwnerId: string
  }[]
}

export type HostedApprovalCredentialBindingRecord = {
  routeId: string
  credentialGeneration: number
  credentialId: string
}

export type HostedApprovalHostEndpointIdentity = {
  address: '127.0.0.1'
  port: number
  pid: number
  startIdentity: `start_${string}`
}

export type HostedApprovalHostBindingRecord = {
  context: OpenCodePermissionEffectContext
  processIdentity: HostedControlProcessIdentity
  endpointIdentity: HostedApprovalHostEndpointIdentity
  executedArtifactDigest: `sha256:${string}`
  resolvedConfigFingerprint: string
}

export type HostedApprovalRuntimeBindingSourcePorts = {
  lifecycle: { read(): Promise<HostedApprovalLifecycleBindingRecord> }
  membership: { read(teamId: string): Promise<HostedApprovalMembershipBindingRecord> }
  credentials: { read(teamId: string): Promise<readonly HostedApprovalCredentialBindingRecord[]> }
  sessions: Pick<OpenCodeSessionStore, 'get'>
  hosts: { read(record: OpenCodeSessionRecord): Promise<HostedApprovalHostBindingRecord> }
  capability: {
    read(
      record: OpenCodeSessionRecord,
      host: HostedApprovalHostBindingRecord,
    ): Promise<HostedApprovalRuntimeBindingCapability>
  }
  owner: {
    socketPath: string
    processId?: number
    getProcessId?(): number | null
    getOwnerBinding(): HostedControlOwnerBinding | null
    isCurrent(): Promise<boolean>
  }
  fence: HostedApprovalRuntimeBindingFence
  captureProcessIdentity?: (pid: number) => Promise<HostedControlProcessIdentity>
}

/**
 * Independent authoritative binding projection. No product admission or
 * approval-owner state is an input: provisioning can resolve this snapshot
 * before hosted-approval-runtime-admission.v1.json exists.
 */
export class OpenCodeHostedApprovalRuntimeBindingSource {
  constructor(private readonly ports: HostedApprovalRuntimeBindingSourcePorts) {}

  async capture(pin?: HostedApprovalRuntimeBindingPin): Promise<HostedApprovalRuntimeBinding> {
    const operation = async () => await this.#captureFenced()
    return pin
      ? await this.ports.fence.capturePinned(pin, operation)
      : await this.ports.fence.capture(operation)
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
    const sessions = this.ports.sessions
    const processIdentity = this.ports.captureProcessIdentity ?? captureHostedControlProcessIdentity
    const lifecycle = await this.ports.lifecycle.read()
    if (!validLifecycle(lifecycle) || !(await current(this.ports.owner))) throw unavailable()
    const teamId = lifecycle.outerAuthority.teamId
    const [membership, credentials] = await Promise.all([
      this.ports.membership.read(teamId),
      this.ports.credentials.read(teamId),
    ])
    if (!validMembership(membership) || !validCredentials(credentials)) throw unavailable()

    const ownerBinding = this.ports.owner.getOwnerBinding()
    if (!ownerBinding || !validOwner(ownerBinding, this.ports.owner.socketPath)) throw unavailable()
    const ownerPid = this.ports.owner.getProcessId?.() ?? this.ports.owner.processId
    if (!safeInteger(ownerPid, 1)) throw unavailable()
    const ownerProcessBefore = await processIdentity(ownerPid)
    if (!validProcessIdentity(ownerProcessBefore) || ownerProcessBefore.pid !== ownerPid) throw unavailable()

    const memberships = new Map(membership.members.map(value => [value.routeId, value]))
    const credentialRecords = new Map(credentials.map(value => [value.routeId, value]))
    if (memberships.size !== lifecycle.routes.length || credentialRecords.size !== lifecycle.routes.length) {
      throw unavailable()
    }

    const capturedRoutes: HostedApprovalRuntimeRoute[] = []
    let bindingCapability: HostedApprovalRuntimeBindingCapability | null = null
    for (const lifecycleRoute of [...lifecycle.routes].sort(compareRouteId)) {
      const member = memberships.get(lifecycleRoute.routeId)
      const credential = credentialRecords.get(lifecycleRoute.routeId)
      if (!member || !credential) throw unavailable()
      const record = await sessions.get(teamId, lifecycleRoute.laneId, member.memberName)
      if (!validSession(record, teamId, lifecycleRoute, member)) throw unavailable()

      const host = await this.ports.hosts.read(record)
      if (!validHost(host, record)) throw unavailable()
      const capability = await this.ports.capability.read(record, host)
      if (!validCapability(capability)) throw unavailable()
      const recordAfter = await sessions.get(teamId, lifecycleRoute.laneId, member.memberName)
      const hostAfter = await this.ports.hosts.read(record)
      if (!recordAfter || !isDeepStrictEqual(record, recordAfter) ||
        !isDeepStrictEqual(host, hostAfter) ||
        host.processIdentity.pid !== host.endpointIdentity.pid ||
        host.processIdentity.startIdentity !== host.endpointIdentity.startIdentity) {
        throw unavailable()
      }
      if (bindingCapability && !isDeepStrictEqual(bindingCapability, capability)) throw unavailable()
      bindingCapability = { ...capability }

      const sessionRecordFingerprint = fingerprintHostedApprovalSessionRecord(record)
      const effectFingerprint = liveHostedApprovalEffectFingerprint(host, capability)
      capturedRoutes.push({
        routeId: lifecycleRoute.routeId,
        authority: {
          deploymentId: lifecycle.outerAuthority.deploymentId,
          teamId,
          runId: lifecycleRoute.runId,
          planGeneration: lifecycleRoute.planGeneration,
          laneId: lifecycleRoute.laneId,
          providerId: 'opencode',
          credentialGeneration: credential.credentialGeneration,
          credentialId: credential.credentialId,
          sessionId: record.opencodeSessionId,
          runtimeInstanceId: capability.runtimeInstanceId,
          deliveryOwnerId: member.deliveryOwnerId,
        },
        scope: {
          principalId: member.principalId,
          workspaceId: lifecycle.outerAuthority.workspaceId,
          teamId,
          authorityGeneration: lifecycleRoute.authorityGeneration,
          restoreGeneration: lifecycle.outerAuthority.restoreGeneration,
        },
        memberName: member.memberName,
        openCodeBinding: {
          toolApprovalMode: 'manual',
          planGeneration: lifecycleRoute.planGeneration,
          credentialGeneration: credential.credentialGeneration,
          credentialId: credential.credentialId,
          runtimeInstanceId: capability.runtimeInstanceId,
          deliveryOwnerId: member.deliveryOwnerId,
          openCodeArtifactDigest: host.executedArtifactDigest,
          sessionRecordFingerprint,
          liveEffectFingerprint: effectFingerprint,
        },
      })
    }
    if (!bindingCapability) throw unavailable()

    const [lifecycleAfter, membershipAfter, credentialsAfter, ownerProcessAfter] = await Promise.all([
      this.ports.lifecycle.read(),
      this.ports.membership.read(teamId),
      this.ports.credentials.read(teamId),
      processIdentity(ownerPid),
    ])
    if (!isDeepStrictEqual(lifecycle, lifecycleAfter) ||
      !isDeepStrictEqual(membership, membershipAfter) ||
      !isDeepStrictEqual(credentials, credentialsAfter) ||
      !isDeepStrictEqual(ownerProcessBefore, ownerProcessAfter) ||
      !isDeepStrictEqual(ownerBinding, this.ports.owner.getOwnerBinding()) ||
      (this.ports.owner.getProcessId?.() ?? this.ports.owner.processId) !== ownerPid ||
      !(await current(this.ports.owner))) throw unavailable()

    const memberIdsByName = sortedDictionary(Object.fromEntries(
      membership.members.map(value => [value.memberName, value.deliveryOwnerId]),
    ))
    const actorMembers = sortedDictionary(Object.fromEntries(
      membership.members.map(value => [value.principalId, value.deliveryOwnerId]),
    ))
    if (Object.keys(memberIdsByName).length !== capturedRoutes.length ||
      Object.keys(actorMembers).length !== capturedRoutes.length) throw unavailable()

    const binding: HostedApprovalRuntimeBinding = {
      outerAuthority: cloneOuterAuthority(lifecycle.outerAuthority),
      routes: capturedRoutes,
      memberIdsByName,
      actorMembers,
      owner: {
        teamId,
        ownerAuthority: ownerBinding.ownerAuthority,
        ownerGeneration: ownerBinding.ownerGeneration,
        ownerSessionId: ownerBinding.ownerSessionId,
        socketPath: this.ports.owner.socketPath,
        socketIdentity: { ...ownerBinding.socketIdentity },
        processIdentity: ownerProcessAfter,
      },
      capability: bindingCapability,
    }
    assertHostedApprovalRuntimeBinding(binding)
    return binding
  }
}

export function liveHostedApprovalEffectFingerprint(
  host: HostedApprovalHostBindingRecord,
  capability: HostedApprovalRuntimeBindingCapability,
): string {
  return fingerprintHostedApprovalLiveEffect({ ...host, capability })
}

export function digestHostedApprovalRuntimeBinding(binding: HostedApprovalRuntimeBinding): string {
  return createHash('sha256').update(canonicalHostedApprovalRuntimeBinding(binding)).digest('hex')
}

/**
 * Serializes the binding in frozen schema order. Dictionary members are
 * emitted directly in UTF-16 order because ordinary object enumeration moves
 * array-index-shaped names (for example, "2") ahead of "10".
 */
export function canonicalHostedApprovalRuntimeBinding(binding: HostedApprovalRuntimeBinding): string {
  assertHostedApprovalRuntimeBinding(binding)
  return `{"outerAuthority":${JSON.stringify(binding.outerAuthority)}` +
    `,"routes":${JSON.stringify(binding.routes)}` +
    `,"memberIdsByName":${canonicalDictionary(binding.memberIdsByName)}` +
    `,"actorMembers":${canonicalDictionary(binding.actorMembers)}` +
    `,"owner":${JSON.stringify(binding.owner)}` +
    `,"capability":${JSON.stringify(binding.capability)}}`
}

export function assertHostedApprovalRuntimeBinding(binding: HostedApprovalRuntimeBinding): void {
  if (!isRecord(binding)) throw invalid()
  exact(binding, ['outerAuthority', 'routes', 'memberIdsByName', 'actorMembers', 'owner', 'capability'])
  if (!Array.isArray(binding.routes) || !isRecord(binding.memberIdsByName) ||
    !isRecord(binding.actorMembers) || !isRecord(binding.owner) || !isRecord(binding.capability) ||
    !validOuterAuthority(binding.outerAuthority) ||
    binding.routes.length < 1 || binding.routes.length > 256 ||
    !validOwner(binding.owner, binding.owner.socketPath) || !validProcessIdentity(binding.owner.processIdentity) ||
    binding.owner.teamId !== binding.outerAuthority.teamId || !validCapability(binding.capability)) throw invalid()
  exact(binding.outerAuthority, ['deploymentId', 'bootId', 'workspaceId', 'teamId', 'restoreGeneration', 'mountBinding'])
  exact(binding.outerAuthority.mountBinding, ['mountGeneration', 'declaredRootHash'])
  exact(binding.owner, ['teamId', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketPath', 'socketIdentity', 'processIdentity'])
  exact(binding.owner.socketIdentity, ['device', 'inode', 'uid', 'gid', 'mode'])
  exact(binding.owner.processIdentity, ['pid', 'startIdentity'])
  exact(binding.capability, ['schemaVersion', 'protocol', 'authentication', 'runtimeInstanceId', 'configGeneration'])
  const memberValues = Object.values(binding.memberIdsByName)
  const actorValues = Object.values(binding.actorMembers)
  if (memberValues.length < 1 || memberValues.length > 256 ||
    actorValues.length < 1 || actorValues.length > 256 ||
    !schemaOrderedDictionary(binding.memberIdsByName) ||
    !schemaOrderedDictionary(binding.actorMembers) ||
    Object.entries(binding.memberIdsByName).some(([name, memberId]) =>
      !validIdentifier(name) || !matches(/^member_[0-9a-f]{32}$/, memberId)) ||
    Object.entries(binding.actorMembers).some(([actorId, memberId]) =>
      !matches(/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, actorId) ||
      !matches(/^member_[0-9a-f]{32}$/, memberId)) ||
    memberValues.length !== actorValues.length || new Set(memberValues).size !== memberValues.length ||
    new Set(actorValues).size !== actorValues.length ||
    [...memberValues].sort().join('\0') !== [...actorValues].sort().join('\0')) throw invalid()
  for (let index = 0; index < binding.routes.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(binding.routes, index)) throw invalid()
    const route = binding.routes[index]!
    exact(route, ['routeId', 'authority', 'scope', 'memberName', 'openCodeBinding'])
    exact(route.authority, ['deploymentId', 'teamId', 'runId', 'planGeneration', 'laneId', 'providerId', 'credentialGeneration', 'credentialId', 'sessionId', 'runtimeInstanceId', 'deliveryOwnerId'])
    exact(route.scope, ['principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration'])
    exact(route.openCodeBinding, ['toolApprovalMode', 'planGeneration', 'credentialGeneration', 'credentialId', 'runtimeInstanceId', 'deliveryOwnerId', 'openCodeArtifactDigest', 'sessionRecordFingerprint', 'liveEffectFingerprint'])
    if (!validRoute(route) || (index > 0 && binding.routes[index - 1]!.routeId >= route.routeId) ||
      route.authority.deploymentId !== binding.outerAuthority.deploymentId ||
      route.authority.teamId !== binding.outerAuthority.teamId || route.scope.teamId !== binding.outerAuthority.teamId ||
      route.scope.workspaceId !== binding.outerAuthority.workspaceId ||
      route.scope.restoreGeneration !== binding.outerAuthority.restoreGeneration ||
      binding.memberIdsByName[route.memberName] !== route.authority.deliveryOwnerId ||
      binding.actorMembers[route.scope.principalId] !== route.authority.deliveryOwnerId ||
      route.openCodeBinding.runtimeInstanceId !== binding.capability.runtimeInstanceId) throw invalid()
  }
  if (new Set(binding.routes.map(route => route.authority.sessionId)).size !== binding.routes.length) throw invalid()
}

function validLifecycle(value: HostedApprovalLifecycleBindingRecord): boolean {
  return validOuterAuthority(value.outerAuthority) && value.routes.length >= 1 && value.routes.length <= 256 &&
    value.routes.every(route => validIdentifier(route.routeId) && matches(/^run_[0-9a-f]{32}$/, route.runId) &&
      safeInteger(route.planGeneration, 1) && matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, route.laneId) &&
      matches(/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/, route.authorityGeneration)) &&
    new Set(value.routes.map(route => route.routeId)).size === value.routes.length
}

function validMembership(value: HostedApprovalMembershipBindingRecord): boolean {
  return value.members.length >= 1 && value.members.length <= 256 && value.members.every(member =>
    validIdentifier(member.routeId) && validIdentifier(member.memberName) &&
    matches(/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, member.principalId) &&
    matches(/^member_[0-9a-f]{32}$/, member.deliveryOwnerId)) &&
    new Set(value.members.map(member => member.routeId)).size === value.members.length &&
    new Set(value.members.map(member => member.memberName)).size === value.members.length &&
    new Set(value.members.map(member => member.principalId)).size === value.members.length &&
    new Set(value.members.map(member => member.deliveryOwnerId)).size === value.members.length
}

function validCredentials(value: readonly HostedApprovalCredentialBindingRecord[]): boolean {
  return value.length >= 1 && value.length <= 256 && value.every(record =>
    validIdentifier(record.routeId) && safeInteger(record.credentialGeneration, 1) &&
    validIdentifier(record.credentialId)) && new Set(value.map(record => record.routeId)).size === value.length
}

function validSession(
  record: OpenCodeSessionRecord | null,
  teamId: string,
  lifecycle: HostedApprovalLifecycleBindingRecord['routes'][number],
  member: HostedApprovalMembershipBindingRecord['members'][number],
): record is OpenCodeSessionRecord {
  return !!record && record.providerId === 'opencode' && record.toolApprovalMode === 'manual' &&
    record.teamId === teamId && (record.laneId ?? 'primary') === lifecycle.laneId &&
    record.runId === lifecycle.runId && record.memberName === member.memberName &&
    record.staleReason === null && validIdentifier(record.opencodeSessionId) &&
    matches(/^sha256:[0-9a-f]{64}$/, record.openCodeArtifactDigest)
}

function validHost(host: HostedApprovalHostBindingRecord, record: OpenCodeSessionRecord): boolean {
  return host.context.record === record && validProcessIdentity(host.processIdentity) &&
    host.context.host.pid === host.processIdentity.pid && host.endpointIdentity.address === '127.0.0.1' &&
    safeInteger(host.endpointIdentity.port, 1) && host.endpointIdentity.port <= 65535 &&
    host.context.host.port === host.endpointIdentity.port &&
    host.context.host.baseUrl === `http://127.0.0.1:${host.endpointIdentity.port}` &&
    host.endpointIdentity.pid === host.processIdentity.pid &&
    host.endpointIdentity.startIdentity === host.processIdentity.startIdentity &&
    host.executedArtifactDigest === record.openCodeArtifactDigest &&
    host.context.host.openCodeArtifactDigest === host.executedArtifactDigest &&
    host.context.host.resolvedConfigFingerprint === host.resolvedConfigFingerprint &&
    host.resolvedConfigFingerprint.length > 0
}

function validCapability(value: HostedApprovalRuntimeBindingCapability): boolean {
  return isRecord(value) && value.schemaVersion === 2 && value.protocol === 'agent-teams-hosted-approval-v2' &&
    value.authentication === 'opencode-basic' && matches(/^runtime_instance_[0-9a-f]{32}$/, value.runtimeInstanceId) &&
    matches(/^config_generation_[0-9a-f]{32}$/, value.configGeneration)
}

function validOuterAuthority(authority: HostedApprovalRuntimeOuterAuthority): boolean {
  return isRecord(authority) && isRecord(authority.mountBinding) &&
    matches(/^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/, authority.deploymentId) &&
    validIdentifier(authority.bootId) && validIdentifier(authority.workspaceId) &&
    matches(/^team_[0-9a-f]{32}$/, authority.teamId) && safeInteger(authority.restoreGeneration, 0) &&
    safeInteger(authority.mountBinding.mountGeneration, 1) &&
    matches(/^[0-9a-f]{64}$/, authority.mountBinding.declaredRootHash)
}

function validRoute(route: HostedApprovalRuntimeRoute): boolean {
  if (!isRecord(route) || !isRecord(route.authority) || !isRecord(route.scope) ||
    !isRecord(route.openCodeBinding)) return false
  const { authority, scope, openCodeBinding: binding } = route
  return validIdentifier(route.routeId) && validIdentifier(route.memberName) &&
    matches(/^deployment_[A-Za-z0-9][A-Za-z0-9._-]{0,116}$/, authority.deploymentId) &&
    matches(/^team_[0-9a-f]{32}$/, authority.teamId) && matches(/^run_[0-9a-f]{32}$/, authority.runId) &&
    safeInteger(authority.planGeneration, 1) && matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, authority.laneId) &&
    authority.providerId === 'opencode' && safeInteger(authority.credentialGeneration, 1) &&
    validIdentifier(authority.credentialId) && validIdentifier(authority.sessionId) &&
    matches(/^runtime_instance_[0-9a-f]{32}$/, authority.runtimeInstanceId) &&
    matches(/^member_[0-9a-f]{32}$/, authority.deliveryOwnerId) &&
    matches(/^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/, scope.principalId) && validIdentifier(scope.workspaceId) &&
    matches(/^team_[0-9a-f]{32}$/, scope.teamId) && matches(/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/, scope.authorityGeneration) &&
    safeInteger(scope.restoreGeneration, 0) && binding.toolApprovalMode === 'manual' &&
    binding.planGeneration === authority.planGeneration && binding.credentialGeneration === authority.credentialGeneration &&
    binding.credentialId === authority.credentialId && binding.runtimeInstanceId === authority.runtimeInstanceId &&
    binding.deliveryOwnerId === authority.deliveryOwnerId && matches(/^sha256:[0-9a-f]{64}$/, binding.openCodeArtifactDigest) &&
    matches(/^[0-9a-f]{64}$/, binding.sessionRecordFingerprint) && matches(/^[0-9a-f]{64}$/, binding.liveEffectFingerprint)
}

function validOwner(binding: HostedControlOwnerBinding, socketPath: string): boolean {
  if (!isRecord(binding) || !isRecord(binding.socketIdentity) || typeof socketPath !== 'string') return false
  const socket = binding.socketIdentity
  return matches(/^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, binding.ownerAuthority) &&
    safeInteger(binding.ownerGeneration, 1) && matches(/^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/, binding.ownerSessionId) &&
    isAbsolute(socketPath) && !socketPath.includes('\0') && normalize(socketPath) === socketPath &&
    Buffer.byteLength(socketPath) <= 103 && matches(/^(?:0|[1-9][0-9]{0,31})$/, socket.device) &&
    matches(/^(?:0|[1-9][0-9]{0,31})$/, socket.inode) && safeInteger(socket.uid, 0) &&
    safeInteger(socket.gid, 0) && socket.mode === 0o600
}

function validProcessIdentity(identity: HostedControlProcessIdentity): boolean {
  return isRecord(identity) && safeInteger(identity.pid, 1) &&
    matches(/^start_[0-9a-f]{64}$/, identity.startIdentity)
}

function cloneOuterAuthority(authority: HostedApprovalRuntimeOuterAuthority): HostedApprovalRuntimeOuterAuthority {
  return { ...authority, mountBinding: { ...authority.mountBinding } }
}

function sortedDictionary(input: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function canonicalDictionary(value: Readonly<Record<string, string>>): string {
  const members = Object.keys(value).sort(compareUtf16).map(key =>
    `${JSON.stringify(key)}:${JSON.stringify(value[key])}`,
  )
  return `{${members.join(',')}}`
}

function schemaOrderedDictionary(value: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(value)
  // ECMAScript erases the raw placement of array-index-shaped property names.
  // Their ordering is therefore checked by canonicalDictionary at the byte
  // boundary; all other dictionaries retain and must expose schema order.
  if (keys.some(isArrayIndexName)) return true
  return keys.every((key, index) => index === 0 || compareUtf16(keys[index - 1]!, key) < 0)
}

function isArrayIndexName(value: string): boolean {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 && numeric < 0xffff_ffff && String(numeric) === value
}

function compareRouteId(left: { routeId: string }, right: { routeId: string }): number {
  return compareUtf16(left.routeId, right.routeId)
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exact(value: unknown, expected: readonly string[]): void {
  if (!isRecord(value) || Object.keys(value).join('\0') !== expected.join('\0')) throw invalid()
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function validIdentifier(value: unknown): value is string {
  return matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/, value)
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && !Object.is(value, -0) && Number.isSafeInteger(value) && value >= minimum
}

async function current(owner: HostedApprovalRuntimeBindingSourcePorts['owner']): Promise<boolean> {
  try { return await owner.isCurrent() } catch { return false }
}

function unavailable(): Error {
  return new Error('Hosted approval authoritative binding is unavailable')
}

function invalid(): TypeError {
  return new TypeError('Hosted approval authoritative binding schema is invalid')
}
