import path from 'node:path'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import type { HostedProductCurrentMember, HostedProductDecisionKind,
  HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'

const BINDING_KEYS = ['runId', 'memberId', 'teamId', 'laneId', 'deploymentId',
  'runtimeWorkspaceId', 'planSha256', 'rosterBindingSha256', 'restoreGeneration',
  'mountGeneration'] as const
const REQUEST_KEYS = ['operationId', 'planTeamId', 'planFingerprint', 'runId',
  'teamId', 'laneId', 'memberId'] as const
const SHA = /^[a-f0-9]{64}$/
const RUN = /^run_[a-f0-9]{32}$/
const MEMBER = /^member_[a-f0-9]{32}$/
const TEAM = /^team_[a-f0-9]{32}$/
const LANE = /^lane_[a-f0-9]{32}$/
const WORKSPACE = /^workspace_[a-f0-9]{32}$/
const DEPLOYMENT = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]*$/

type ProductDecision = Readonly<{
  withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, kind: HostedProductDecisionKind,
    callback: (current: HostedProductCurrentMember) => T): Promise<T>
}>

export type HostedRootSingleMemberPins = Readonly<{
  binding: HostedProductMemberBinding
  workspaceParent: string
  sandboxWorkspaceRoot: string
  bootId: string
  ownerGeneration: number
  ownerSessionId: string
}>

export type HostedRootCurrentIncarnation = Readonly<{
  runId: string
  bootId: string
  ownerGeneration: number
  ownerSessionId: string
  state: 'active'
}>

/** Must synchronously read current boot, Owner session and run retirement under an audited fence. */
export type HostedRootCurrentIncarnationSource =
  (current: HostedProductCurrentMember) => HostedRootCurrentIncarnation | null

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validPins(pins: HostedRootSingleMemberPins): boolean {
  const binding = pins?.binding
  return exact(pins, ['binding', 'workspaceParent', 'sandboxWorkspaceRoot', 'bootId',
    'ownerGeneration', 'ownerSessionId']) &&
    exact(binding, BINDING_KEYS) && RUN.test(binding.runId) && MEMBER.test(binding.memberId) &&
    TEAM.test(binding.teamId) && LANE.test(binding.laneId) &&
    DEPLOYMENT.test(binding.deploymentId) && WORKSPACE.test(binding.runtimeWorkspaceId) &&
    SHA.test(binding.planSha256) && SHA.test(binding.rosterBindingSha256) &&
    Number.isSafeInteger(binding.restoreGeneration) && binding.restoreGeneration >= 0 &&
    Number.isSafeInteger(binding.mountGeneration) && binding.mountGeneration >= 1 &&
    typeof pins.workspaceParent === 'string' && path.isAbsolute(pins.workspaceParent) &&
    path.normalize(pins.workspaceParent) === pins.workspaceParent &&
    typeof pins.sandboxWorkspaceRoot === 'string' && path.isAbsolute(pins.sandboxWorkspaceRoot) &&
    path.normalize(pins.sandboxWorkspaceRoot) === pins.sandboxWorkspaceRoot &&
    path.dirname(pins.sandboxWorkspaceRoot) === pins.workspaceParent &&
    path.basename(pins.sandboxWorkspaceRoot).length >= 8 &&
    /^boot_[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pins.bootId) &&
    Number.isSafeInteger(pins.ownerGeneration) && pins.ownerGeneration >= 1 &&
    /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(pins.ownerSessionId)
}

/** Root-owned one-member Product binding. It supplies a decision, never a launch permit. */
export class HostedRootSingleMemberAuthority {
  private readonly pins: HostedRootSingleMemberPins

  constructor(private readonly product: ProductDecision, pins: HostedRootSingleMemberPins,
    private readonly readCurrentIncarnation: HostedRootCurrentIncarnationSource) {
    if (typeof product?.withCurrentMemberDecision !== 'function' || !validPins(pins) ||
      typeof readCurrentIncarnation !== 'function') {
      throw new Error('hosted-root-member-pins-invalid')
    }
    this.pins = Object.freeze({ ...pins, binding: Object.freeze({ ...pins.binding }) })
  }

  /** The Owner's managed request is only an exact selector for these root-owned pins. */
  matchesManagedRequest(request: HostedMemberNetworkRequest): boolean {
    const binding = this.pins.binding
    return exact(request, REQUEST_KEYS) &&
      request.operationId === hostedMemberStartOperationId(binding.runId, binding.memberId,
        binding.planSha256) && request.planTeamId === binding.teamId &&
      request.planFingerprint === binding.planSha256 && request.runId === binding.runId &&
      request.teamId === binding.teamId && request.laneId === binding.laneId &&
      request.memberId === binding.memberId
  }

  /** A synchronous callback may claim and write one exact kernel effect under Product BEGIN IMMEDIATE. */
  async withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, kind: HostedProductDecisionKind,
    callback: (current: HostedProductCurrentMember) => T): Promise<T> {
    if (!exact(binding, BINDING_KEYS) ||
      BINDING_KEYS.some(key => binding[key] !== this.pins.binding[key]) ||
      typeof callback !== 'function') throw new Error('hosted-root-member-binding-denied')
    return await this.product.withCurrentMemberDecision(this.pins.binding, kind, current => {
      if (current.admittedWorkspaceRoot !== this.pins.sandboxWorkspaceRoot) {
        throw new Error('hosted-root-member-sandbox-denied')
      }
      const incarnation: unknown = this.readCurrentIncarnation(current)
      if (!exact(incarnation, ['runId', 'bootId', 'ownerGeneration', 'ownerSessionId', 'state']) ||
        incarnation.state !== 'active' || incarnation.runId !== current.runId ||
        incarnation.bootId !== current.bootId || incarnation.bootId !== this.pins.bootId ||
        incarnation.ownerGeneration !== this.pins.ownerGeneration ||
        incarnation.ownerSessionId !== this.pins.ownerSessionId) {
        throw new Error('hosted-root-member-incarnation-denied')
      }
      return callback(current)
    })
  }

  assertCurrent(): Promise<boolean> {
    return this.withCurrentMemberDecision(this.pins.binding, 'observe', () => true)
  }
}
