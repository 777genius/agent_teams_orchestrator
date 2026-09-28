import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import { HostedProductCurrentMemberDecision, type HostedProductCurrentMember,
  type HostedProductMemberBinding } from '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority, type HostedRootCurrentIncarnation } from
  './HostedRootSingleMemberAuthority.js'

const RUN = /^run_[a-f0-9]{32}$/
const MEMBER = /^member_[a-f0-9]{32}$/
const TEAM = /^team_[a-f0-9]{32}$/
const LANE = /^lane_[a-f0-9]{32}$/
const SHA = /^[a-f0-9]{64}$/
const BOOT = /^boot_[A-Za-z0-9][A-Za-z0-9._-]*$/
const DEPLOYMENT = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]*$/
const OWNER = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]*$/
const SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')

type RootPins = Readonly<{
  databasePath: string
  expectedProductUid: number
  workspaceParent: string
  sandboxWorkspaceRoot: string
  deploymentId: string
  bootId: string
  ownerAuthority: string
  ownerGeneration: number
  ownerSessionId: string
  runId: string
  memberIds: readonly string[]
  testOnlyAllowNonRoot?: boolean
  now?: () => number
}>
type Member = Readonly<{ binding: HostedProductMemberBinding;
  request: HostedMemberNetworkRequest; authority: HostedRootSingleMemberAuthority }>
type Row = Record<string, unknown>

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted-root-sandbox-product-record-invalid')
  }
  return value as Row
}

function exact(value: unknown, fields: readonly string[]): Row {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error('hosted-root-sandbox-product-record-invalid')
  }
  return row
}

function validPins(pins: RootPins): boolean {
  return !!pins && [pins.databasePath, pins.workspaceParent, pins.sandboxWorkspaceRoot]
    .every(value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value) &&
    path.dirname(pins.sandboxWorkspaceRoot) === pins.workspaceParent &&
    /^[a-z0-9][a-z0-9-]{7,63}$/.test(path.basename(pins.sandboxWorkspaceRoot)) &&
    Number.isSafeInteger(pins.expectedProductUid) && pins.expectedProductUid >= 0 &&
    DEPLOYMENT.test(pins.deploymentId) && BOOT.test(pins.bootId) &&
    OWNER.test(pins.ownerAuthority) && SESSION.test(pins.ownerSessionId) &&
    Number.isSafeInteger(pins.ownerGeneration) && pins.ownerGeneration >= 1 && RUN.test(pins.runId) &&
    Array.isArray(pins.memberIds) && pins.memberIds.length >= 1 && pins.memberIds.length <= 2 &&
    pins.memberIds.every(value => MEMBER.test(value)) && new Set(pins.memberIds).size === pins.memberIds.length &&
    (!pins.testOnlyAllowNonRoot || process.env.NODE_ENV === 'test')
}

function identity(databasePath: string, uid: number): Readonly<{ dev: number; ino: number }> {
  const stat = lstatSync(databasePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid ||
    (stat.mode & 0o022) !== 0 || realpathSync(databasePath) !== databasePath) {
    throw new Error('hosted-root-sandbox-product-file-invalid')
  }
  return { dev: stat.dev, ino: stat.ino }
}

/** Inert root-owned composition. Each member is checked independently; this is not a peer-effect permit. */
export class HostedRootSandboxMemberComposition {
  private constructor(private readonly product: HostedProductCurrentMemberDecision,
    private readonly reader: Database, private readonly pins: RootPins,
    private readonly databaseIdentity: Readonly<{ dev: number; ino: number }>,
    private readonly members: ReadonlyMap<string, Member>) {}

  static async create(source: RootPins): Promise<HostedRootSandboxMemberComposition> {
    if (!validPins(source)) throw new Error('hosted-root-sandbox-pins-invalid')
    const pins = Object.freeze({ ...source, memberIds: Object.freeze([...source.memberIds]) })
    const databaseIdentity = identity(pins.databasePath, pins.expectedProductUid)
    const product = await HostedProductCurrentMemberDecision.create({ databasePath: pins.databasePath,
      expectedUid: pins.expectedProductUid, now: pins.now,
      testOnlyAllowNonRoot: pins.testOnlyAllowNonRoot })
    let reader: Database | undefined
    try {
      reader = new Database(pins.databasePath, { readonly: true })
      reader.exec('PRAGMA query_only = ON')
      const currentIdentity = identity(pins.databasePath, pins.expectedProductUid)
      if (JSON.stringify(currentIdentity) !== JSON.stringify(databaseIdentity)) {
        throw new Error('hosted-root-sandbox-product-file-substituted')
      }
      const reservationRow = reader.query(`SELECT record_json FROM main.hosted_lifecycle_run_reservations
        WHERE run_id = ?`).get(pins.runId) as { record_json: string } | null
      if (!reservationRow || typeof reservationRow.record_json !== 'string' ||
        Buffer.byteLength(reservationRow.record_json) > 16 * 1024) {
        throw new Error('hosted-root-sandbox-reservation-missing')
      }
      const reservation = object(JSON.parse(reservationRow.record_json))
      if (reservation.runId !== pins.runId || reservation.deploymentId !== pins.deploymentId ||
        reservation.bootId !== pins.bootId || reservation.ownerAuthority !== pins.ownerAuthority ||
        reservation.ownerGeneration !== pins.ownerGeneration ||
        reservation.ownerSessionId !== pins.ownerSessionId ||
        reservation.admittedWorkspaceRoot !== undefined ||
        typeof reservation.teamId !== 'string' || !TEAM.test(reservation.teamId) ||
        typeof reservation.runtimeWorkspaceId !== 'string' ||
        !/^workspace_[a-f0-9]{32}$/.test(reservation.runtimeWorkspaceId) ||
        typeof reservation.planSha256 !== 'string' || !SHA.test(reservation.planSha256) ||
        typeof reservation.rosterBindingSha256 !== 'string' || !SHA.test(reservation.rosterBindingSha256) ||
        typeof reservation.promotionOperationId !== 'string' ||
        !Number.isSafeInteger(reservation.restoreGeneration) ||
        !Number.isSafeInteger(reservation.mountGeneration)) {
        throw new Error('hosted-root-sandbox-reservation-invalid')
      }
      const rosterRow = reader.query(`SELECT plan_sha256, binding_json FROM
        main.hosted_promotion_roster_bindings WHERE operation_id = ?`)
        .get(reservation.promotionOperationId as string) as { plan_sha256: string; binding_json: string } | null
      if (!rosterRow || rosterRow.plan_sha256 !== reservation.planSha256 ||
        typeof rosterRow.binding_json !== 'string' ||
        Buffer.byteLength(rosterRow.binding_json) > 256 * 1024) {
        throw new Error('hosted-root-sandbox-roster-invalid')
      }
      const roster = exact(JSON.parse(rosterRow.binding_json),
        ['schemaVersion', 'operationId', 'planSha256', 'lanes'])
      if (roster.schemaVersion !== 1 || roster.operationId !== reservation.promotionOperationId ||
        roster.planSha256 !== reservation.planSha256 ||
        sha(JSON.stringify(roster)) !== reservation.rosterBindingSha256 ||
        !Array.isArray(roster.lanes) || roster.lanes.length < 1 || roster.lanes.length > 32) {
        throw new Error('hosted-root-sandbox-roster-invalid')
      }
      const selected = new Map<string, HostedProductMemberBinding>()
      for (const laneValue of roster.lanes) {
        const lane = exact(laneValue, ['laneOrdinal', 'laneId', 'members'])
        if (typeof lane.laneId !== 'string' || !LANE.test(lane.laneId) ||
          !Array.isArray(lane.members)) throw new Error('hosted-root-sandbox-roster-invalid')
        for (const memberValue of lane.members) {
          const member = exact(memberValue, ['memberOrdinal', 'memberId', 'name', 'model', 'promptSha256'])
          if (!pins.memberIds.includes(member.memberId as string)) continue
          if (selected.has(member.memberId as string) || !MEMBER.test(member.memberId as string)) {
            throw new Error('hosted-root-sandbox-roster-invalid')
          }
          selected.set(member.memberId as string, Object.freeze({ runId: pins.runId,
            memberId: member.memberId as string, teamId: reservation.teamId as string,
            laneId: lane.laneId as string, deploymentId: pins.deploymentId,
            runtimeWorkspaceId: reservation.runtimeWorkspaceId as string,
            planSha256: reservation.planSha256 as string,
            rosterBindingSha256: reservation.rosterBindingSha256 as string,
            restoreGeneration: reservation.restoreGeneration as number,
            mountGeneration: reservation.mountGeneration as number }))
        }
      }
      if (selected.size !== pins.memberIds.length) throw new Error('hosted-root-sandbox-member-unbound')
      const members = new Map<string, Member>()
      for (const memberId of pins.memberIds) {
        const binding = selected.get(memberId)!
        const authority = new HostedRootSingleMemberAuthority(product, { binding,
          workspaceParent: pins.workspaceParent, sandboxWorkspaceRoot: pins.sandboxWorkspaceRoot,
          bootId: pins.bootId, ownerGeneration: pins.ownerGeneration,
          ownerSessionId: pins.ownerSessionId }, current =>
          HostedRootSandboxMemberComposition.readIncarnation(reader!, pins, databaseIdentity, current))
        const request = Object.freeze({ operationId: hostedMemberStartOperationId(binding.runId,
          binding.memberId, binding.planSha256), planTeamId: binding.teamId,
        planFingerprint: binding.planSha256, runId: binding.runId, teamId: binding.teamId,
        laneId: binding.laneId, memberId: binding.memberId })
        members.set(memberId, Object.freeze({ binding, request, authority }))
      }
      return new HostedRootSandboxMemberComposition(product, reader, pins, databaseIdentity, members)
    } catch (error) { reader?.close(); product.close(); throw error }
  }

  private static readIncarnation(reader: Database, pins: RootPins,
    expected: Readonly<{ dev: number; ino: number }>, current: HostedProductCurrentMember):
    HostedRootCurrentIncarnation | null {
    if (JSON.stringify(identity(pins.databasePath, pins.expectedProductUid)) !== JSON.stringify(expected)) {
      throw new Error('hosted-root-sandbox-product-file-substituted')
    }
    const row = reader.query(`SELECT authority.boot_id AS bootId,
      authority.owner_authority AS ownerAuthority, authority.owner_generation AS ownerGeneration,
      authority.owner_session_id AS ownerSessionId, authority.state AS authorityState,
      authority.restore_generation AS restoreGeneration,
      authority.mount_generation AS mountGeneration,
      run.run_id AS runId, run.team_id AS teamId, run.state AS runState,
      run.boot_id AS runBootId, run.owner_authority AS runOwnerAuthority,
      run.owner_generation AS runOwnerGeneration, run.owner_session_id AS runOwnerSessionId,
      run.restore_generation AS runRestoreGeneration, run.mount_generation AS runMountGeneration
      FROM main.hosted_lifecycle_deployment_authorities authority
      JOIN main.hosted_lifecycle_current_runs run ON run.deployment_id = authority.deployment_id
      WHERE authority.deployment_id = ? AND run.run_id = ?`).get(pins.deploymentId, pins.runId) as Row | null
    if (!row || row.bootId !== current.bootId || row.bootId !== pins.bootId ||
      row.ownerAuthority !== pins.ownerAuthority || row.ownerGeneration !== pins.ownerGeneration ||
      row.ownerSessionId !== pins.ownerSessionId || row.runId !== current.runId ||
      row.teamId !== current.teamId || row.authorityState !== 'active' || row.runState !== 'eligible' ||
      row.restoreGeneration !== current.restoreGeneration ||
      row.mountGeneration !== current.mountGeneration || row.runBootId !== row.bootId ||
      row.runOwnerAuthority !== row.ownerAuthority || row.runOwnerGeneration !== row.ownerGeneration ||
      row.runOwnerSessionId !== row.ownerSessionId ||
      row.runRestoreGeneration !== row.restoreGeneration ||
      row.runMountGeneration !== row.mountGeneration) {
      return null
    }
    const retired = reader.query(`SELECT 1 FROM main.hosted_lifecycle_retired_members
      WHERE run_id = ? AND member_id = ?`).get(current.runId, current.memberId)
    if (retired) return null
    return Object.freeze({ runId: current.runId, bootId: row.bootId as string,
      ownerGeneration: row.ownerGeneration as number, ownerSessionId: row.ownerSessionId as string,
      state: 'active' })
  }

  /** Exact root-selected member only. No Owner-provided selector is accepted here. */
  member(memberId: string): Member {
    const member = this.members.get(memberId)
    if (!member) throw new Error('hosted-root-sandbox-member-unbound')
    return member
  }

  private async read(memberId: string, kind: 'prepare' | 'observe'):
    Promise<Readonly<{ memberName: string; model: string;
    promptSha256: string; admittedWorkspaceRoot: string }>> {
    const member = this.member(memberId)
    return member.authority.withCurrentMemberDecision(member.binding, kind, current =>
      Object.freeze({ memberName: current.memberName, model: current.model,
        promptSha256: current.promptSha256, admittedWorkspaceRoot: current.admittedWorkspaceRoot }))
  }

  /** Read-only preparation proof. It cannot issue Docker, HTTP, FD3 or tool effects. */
  prepareProof(memberId: string) { return this.read(memberId, 'prepare') }

  /** Read-only current-member proof. */
  observe(memberId: string) { return this.read(memberId, 'observe') }

  close(): void { this.product.close(); this.reader.close() }
}
