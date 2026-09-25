import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const SHA = /^[a-f0-9]{64}$/
const RUN = /^run_[a-f0-9]{32}$/
const MEMBER = /^member_[a-f0-9]{32}$/
const ID = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const MAX_CALLBACK_MS = 1000

export type HostedProductMemberBinding = Readonly<{
  runId: string
  memberId: string
  teamId: string
  laneId: string
  deploymentId: string
  runtimeWorkspaceId: string
  planSha256: string
  rosterBindingSha256: string
  restoreGeneration: number
  mountGeneration: number
}>

export type HostedProductDecisionKind = 'prepare' | 'start' | 'observe' | 'stop'

export type HostedProductCurrentMember = Readonly<HostedProductMemberBinding & {
  workspaceId: string
  actorId: string
  bootId: string
  promotionOperationId: string
  memberName: string
  model: string
  promptSha256: string
  admittedWorkspaceRoot: string
  grantRevision: string
  grantGeneration: number
  laneOrdinal: number
  memberOrdinal: number
}>

type Row = Record<string, unknown>
type FileIdentity = Readonly<{ dev: number; ino: number }>

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('hosted-product-record-invalid')
  return value as Row
}

function exact(value: unknown, keys: readonly string[]): Row {
  const row = object(value)
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('hosted-product-record-invalid')
  }
  return row
}

function parsed(text: unknown, maxBytes: number): Row {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new Error('hosted-product-record-invalid')
  return object(JSON.parse(text))
}

function sha(text: string): string { return createHash('sha256').update(text).digest('hex') }

function same(left: unknown, right: unknown): boolean { return left === right }

function bindingValid(value: HostedProductMemberBinding): boolean {
  return !!value && Object.keys(value).sort().join(',') === [
    'runId', 'memberId', 'teamId', 'laneId', 'deploymentId', 'runtimeWorkspaceId',
    'planSha256', 'rosterBindingSha256', 'restoreGeneration', 'mountGeneration',
  ].sort().join(',') && RUN.test(value.runId) && MEMBER.test(value.memberId) &&
    [value.teamId, value.laneId, value.deploymentId, value.runtimeWorkspaceId]
      .every(id => typeof id === 'string' && ID.test(id)) &&
    SHA.test(value.planSha256) && SHA.test(value.rosterBindingSha256) &&
    Number.isSafeInteger(value.restoreGeneration) && value.restoreGeneration >= 0 &&
    Number.isSafeInteger(value.mountGeneration) && value.mountGeneration >= 1
}

function actorId(userId: string): string {
  const domain = Buffer.from('agent-teams/hosted-query-context/actor/v1')
  const user = Buffer.from(userId)
  const frame = Buffer.allocUnsafe(8 + domain.length + user.length)
  frame.writeUInt32BE(domain.length, 0)
  domain.copy(frame, 4)
  frame.writeUInt32BE(user.length, 4 + domain.length)
  user.copy(frame, 8 + domain.length)
  return `actor_${createHash('sha256').update(frame).digest('hex')}`
}

/** Root process reads the Product v33 writer DB. This is a current decision, never a launch permit. */
export class HostedProductCurrentMemberDecision {
  private busy = false

  private constructor(private readonly databasePath: string, private readonly database: Database,
    private readonly identity: FileIdentity, private readonly expectedUid: number,
    private readonly now: () => number) {}

  static async create(options: { databasePath: string; expectedUid: number; now?: () => number;
    testOnlyAllowNonRoot?: boolean }): Promise<HostedProductCurrentMemberDecision> {
    if (!options.testOnlyAllowNonRoot && (process.platform !== 'linux' || process.getuid?.() !== 0) ||
      options.testOnlyAllowNonRoot && process.env.NODE_ENV !== 'test' ||
      !Number.isSafeInteger(options.expectedUid) || options.expectedUid < 0 ||
      !path.isAbsolute(options.databasePath) || path.normalize(options.databasePath) !== options.databasePath ||
      /[,=]/.test(options.databasePath)) throw new Error('hosted-product-reader-policy-invalid')
    const parent = path.dirname(options.databasePath)
    const [file, directory] = await Promise.all([lstat(options.databasePath), lstat(parent)])
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== options.expectedUid ||
      (file.mode & 0o022) !== 0 || !directory.isDirectory() || directory.isSymbolicLink() ||
      directory.uid !== options.expectedUid || (directory.mode & 0o022) !== 0 ||
      await realpath(options.databasePath) !== options.databasePath || await realpath(parent) !== parent) {
      throw new Error('hosted-product-database-identity-invalid')
    }
    const handle = await open(options.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (opened.dev !== file.dev || opened.ino !== file.ino) throw new Error('hosted-product-database-substituted')
    } finally { await handle.close() }
    const database = new Database(options.databasePath, { create: false, readwrite: true })
    try {
      const current = await lstat(options.databasePath)
      if (current.dev !== file.dev || current.ino !== file.ino) throw new Error('hosted-product-database-substituted')
      database.exec('PRAGMA busy_timeout = 1000')
      const reader = new HostedProductCurrentMemberDecision(options.databasePath, database,
        { dev: file.dev, ino: file.ino }, options.expectedUid, options.now ?? Date.now)
      reader.assertSchema()
      // A read-only open can pass schema checks but cannot fence Product revokers.
      database.exec('BEGIN IMMEDIATE; ROLLBACK')
      return reader
    } catch (error) { database.close(); throw error }
  }

  close(): void { if (this.busy) throw new Error('hosted-product-decision-active'); this.database.close() }

  /** Callback must be synchronous and bounded. This checks point-in-time authority only.
   * A crash after callback execution, or any later async Docker/HTTP dispatch, is outside this transaction.
   */
  async withCurrentMemberDecision<T>(binding: HostedProductMemberBinding, decisionKind: HostedProductDecisionKind,
    callback: (current: HostedProductCurrentMember) => T): Promise<T> {
    if (!bindingValid(binding) || !['prepare', 'start', 'observe', 'stop'].includes(decisionKind) ||
      typeof callback !== 'function') throw new Error('hosted-product-decision-input-invalid')
    if (this.busy || this.database.inTransaction) throw new Error('hosted-product-decision-nested')
    this.busy = true
    let transaction = false
    try {
      await this.assertFileIdentity()
      this.database.exec('BEGIN IMMEDIATE')
      transaction = true
      this.assertSchema()
      const current = this.current(binding)
      if (!current) throw new Error('hosted-product-member-not-current')
      const started = performance.now()
      const result = callback(current)
      if (result && typeof result === 'object' && 'then' in result &&
        typeof result.then === 'function') throw new Error('hosted-product-async-effect-forbidden')
      if (performance.now() - started > MAX_CALLBACK_MS) throw new Error('hosted-product-decision-timeout')
      await this.assertFileIdentity()
      this.database.exec('COMMIT')
      transaction = false
      return result
    } catch (error) {
      if (transaction) this.database.exec('ROLLBACK')
      throw error
    } finally { this.busy = false }
  }

  private async assertFileIdentity(): Promise<void> {
    const stat = await lstat(this.databasePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== this.expectedUid ||
      (stat.mode & 0o022) !== 0 || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino ||
      await realpath(this.databasePath) !== this.databasePath) {
      throw new Error('hosted-product-database-substituted')
    }
  }

  private assertSchema(): void {
    const db = this.database
    if ((db.query('PRAGMA user_version').get() as Row | null)?.user_version !== 33 ||
      (db.query('PRAGMA journal_mode').get() as Row | null)?.journal_mode !== 'wal') {
      throw new Error('hosted-product-schema-incompatible')
    }
    const required: Readonly<Record<string, readonly string[]>> = {
      hosted_lifecycle_run_reservations: ['run_id', 'promotion_operation_id', 'record_json', 'deployment_id',
        'actor_id', 'boot_id', 'team_id'],
      hosted_team_configuration_promotions: ['operation_id', 'record_json', 'workspace_id', 'team_id',
        'actor_id', 'deployment_id'],
      hosted_promotion_roster_bindings: ['operation_id', 'plan_sha256', 'binding_json'],
      hosted_team_configuration_publications: ['operation_id', 'workspace_id', 'team_id', 'actor_id',
        'deployment_id', 'runtime_workspace_id', 'binding_generation', 'legacy_key', 'directory_fingerprint', 'state'],
      team_identity_records: ['team_id', 'state', 'legacy_key', 'directory_fingerprint', 'workspace_id',
        'workspace_binding_generation', 'adoption_intent_id', 'identity_checksum'],
      hosted_workspace_grants: ['user_id', 'runtime_workspace_id', 'grant_generation', 'grant_revision'],
      hosted_workspaces: ['runtime_workspace_id', 'public_workspace_id', 'status'],
      users: ['user_id', 'status'],
      hosted_auth_configuration: ['singleton', 'auth_mode'],
    }
    for (const [table, columns] of Object.entries(required)) {
      const schema = db.query('SELECT type FROM main.sqlite_schema WHERE name = ?').get(table) as Row | null
      const present = db.query(`PRAGMA main.table_info(${table})`).all() as Row[]
      if (schema?.type !== 'table' || columns.some(column => !present.some(row => row.name === column))) {
        throw new Error('hosted-product-schema-incompatible')
      }
    }
  }

  private current(binding: HostedProductMemberBinding): HostedProductCurrentMember | null {
    const db = this.database
    const reservationRow = db.query(`SELECT run_id, promotion_operation_id, deployment_id, actor_id,
      boot_id, team_id, record_json FROM main.hosted_lifecycle_run_reservations WHERE run_id = ?`)
      .get(binding.runId) as Row | null
    if (!reservationRow) return null
    const reservation = parsed(reservationRow.record_json, 16 * 1024)
    for (const [column, field] of [['run_id', 'runId'], ['promotion_operation_id', 'promotionOperationId'],
      ['deployment_id', 'deploymentId'], ['actor_id', 'actorId'], ['boot_id', 'bootId'],
      ['team_id', 'teamId']] as const) {
      if (!same(reservationRow[column], reservation[field])) throw new Error('hosted-product-reservation-corrupt')
    }
    if (reservation.runId !== binding.runId || reservation.teamId !== binding.teamId ||
      reservation.deploymentId !== binding.deploymentId ||
      reservation.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
      reservation.planSha256 !== binding.planSha256 ||
      reservation.rosterBindingSha256 !== binding.rosterBindingSha256 ||
      reservation.restoreGeneration !== binding.restoreGeneration ||
      reservation.mountGeneration !== binding.mountGeneration ||
      reservation.expectedPlanGeneration !== `plan-generation_${binding.planSha256}`) return null
    const evidence = exact(reservation.authorityEvidence, ['userId', 'sessionId', 'grantGeneration'])
    const fence = exact(reservation.ownerEffectFence, ['grantRevision', 'identityChecksum'])
    const promotionRow = db.query(`SELECT operation_id, workspace_id, team_id, actor_id, deployment_id,
      record_json FROM main.hosted_team_configuration_promotions WHERE operation_id = ?`)
      .get(reservation.promotionOperationId as string) as Row | null
    if (!promotionRow) return null
    const promotion = parsed(promotionRow.record_json, 2 * 1024 * 1024)
    for (const [column, field] of [['operation_id', 'operationId'], ['workspace_id', 'workspaceId'],
      ['team_id', 'teamId'], ['actor_id', 'actorId'], ['deployment_id', 'deploymentId']] as const) {
      if (!same(promotionRow[column], promotion[field])) throw new Error('hosted-product-promotion-corrupt')
    }
    if (promotion.state !== 'frozen' || promotion.operationId !== reservation.promotionOperationId ||
      promotion.workspaceId !== reservation.workspaceId || promotion.teamId !== binding.teamId ||
      promotion.actorId !== reservation.actorId || promotion.deploymentId !== binding.deploymentId ||
      promotion.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
      promotion.planSha256 !== binding.planSha256 ||
      promotion.planGeneration !== reservation.expectedPlanGeneration) return null
    const rosterRow = db.query(`SELECT plan_sha256, binding_json FROM main.hosted_promotion_roster_bindings
      WHERE operation_id = ?`).get(promotion.operationId as string) as Row | null
    if (!rosterRow || rosterRow.plan_sha256 !== binding.planSha256) return null
    const roster = parsed(rosterRow.binding_json, 256 * 1024)
    if (roster.schemaVersion !== 1 || roster.operationId !== promotion.operationId ||
      roster.planSha256 !== binding.planSha256 ||
      sha(JSON.stringify(roster)) !== binding.rosterBindingSha256 ||
      !Array.isArray(roster.lanes) || roster.lanes.length < 1 || roster.lanes.length > 32) return null
    const memberIds = new Set<string>()
    const found = roster.lanes.flatMap((lane: unknown, laneOrdinal: number) => {
      const row = exact(lane, ['laneOrdinal', 'laneId', 'members'])
      if (row.laneOrdinal !== laneOrdinal || typeof row.laneId !== 'string' ||
        !/^lane_[a-f0-9]{32}$/.test(row.laneId) || !Array.isArray(row.members) ||
        row.members.length < 1 || row.members.length > 32) throw new Error('hosted-product-roster-corrupt')
      return row.members.map((value: unknown, memberOrdinal: number) => {
        const member = exact(value, ['memberOrdinal', 'memberId', 'name', 'model', 'promptSha256'])
        if (member.memberOrdinal !== memberOrdinal || typeof member.memberId !== 'string' ||
          !MEMBER.test(member.memberId) || memberIds.has(member.memberId) ||
          typeof member.name !== 'string' || !member.name || typeof member.model !== 'string' ||
          !member.model || typeof member.promptSha256 !== 'string' || !SHA.test(member.promptSha256)) {
          throw new Error('hosted-product-roster-corrupt')
        }
        memberIds.add(member.memberId)
        return { lane: row, member }
      }).filter(({ member }) => member.memberId === binding.memberId)
    })
    if (found.length !== 1 || found[0].lane.laneId !== binding.laneId) return null
    const publication = db.query(`SELECT operation_id, runtime_workspace_id, binding_generation,
      legacy_key, directory_fingerprint FROM main.hosted_team_configuration_publications
      WHERE workspace_id = ? AND team_id = ? AND actor_id = ? AND deployment_id = ? AND state = 'published'`)
      .get(reservation.workspaceId as string, binding.teamId, reservation.actorId as string,
        binding.deploymentId) as Row | null
    const identity = db.query(`SELECT state, legacy_key, directory_fingerprint, workspace_id,
      workspace_binding_generation, adoption_intent_id, identity_checksum FROM main.team_identity_records
      WHERE team_id = ?`).get(binding.teamId) as Row | null
    if (!publication || !identity || publication.operation_id !== promotion.createOperationId ||
      publication.runtime_workspace_id !== binding.runtimeWorkspaceId ||
      publication.binding_generation !== promotion.bindingGeneration || identity.state !== 'active' ||
      identity.legacy_key !== publication.legacy_key ||
      identity.directory_fingerprint !== publication.directory_fingerprint ||
      identity.workspace_id !== binding.runtimeWorkspaceId ||
      identity.workspace_binding_generation !== publication.binding_generation ||
      identity.adoption_intent_id !== publication.operation_id ||
      identity.identity_checksum !== fence.identityChecksum) return null
    if (!this.currentGrantAndSession(reservation, evidence, fence)) return null
    const { lane, member } = found[0]
    return Object.freeze({ ...binding, workspaceId: reservation.workspaceId as string,
      actorId: reservation.actorId as string, bootId: reservation.bootId as string,
      promotionOperationId: promotion.operationId as string, memberName: member.name as string,
      model: member.model as string, promptSha256: member.promptSha256 as string,
      admittedWorkspaceRoot: promotion.admittedWorkspaceRoot as string,
      grantRevision: fence.grantRevision as string, grantGeneration: evidence.grantGeneration as number,
      laneOrdinal: lane.laneOrdinal as number, memberOrdinal: member.memberOrdinal as number })
  }

  private currentGrantAndSession(reservation: Row, evidence: Row, fence: Row): boolean {
    const db = this.database
    if (typeof evidence.userId !== 'string' || typeof evidence.sessionId !== 'string' ||
      !Number.isSafeInteger(evidence.grantGeneration) || evidence.grantGeneration !== reservation.restoreGeneration ||
      typeof fence.grantRevision !== 'string' || !SHA.test(fence.grantRevision) ||
      actorId(evidence.userId) !== reservation.actorId) return false
    const grant = db.query(`SELECT grants.grant_revision AS revision FROM main.hosted_workspace_grants grants
      JOIN main.hosted_workspaces workspaces ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
      JOIN main.users ON users.user_id = grants.user_id
      WHERE grants.user_id = ? AND grants.runtime_workspace_id = ? AND grants.grant_generation = ?
        AND workspaces.public_workspace_id = ? AND workspaces.status = 'active' AND users.status = 'active'`)
      .get(evidence.userId as string, reservation.runtimeWorkspaceId as string,
        evidence.grantGeneration as number, reservation.workspaceId as string) as Row | null
    if (grant?.revision !== fence.grantRevision) return false
    const mode = db.query('SELECT auth_mode FROM main.hosted_auth_configuration WHERE singleton = 1').get() as Row | null
    if (mode?.auth_mode === 'oidc') {
      const session = db.query(`SELECT sessions.status, sessions.idle_expires_at, sessions.absolute_expires_at,
        roles.role FROM main.operator_sessions sessions
        JOIN main.role_snapshots roles ON roles.session_id = sessions.session_id
        WHERE sessions.session_id = ? AND sessions.user_id = ?`)
        .get(evidence.sessionId as string, evidence.userId as string) as Row | null
      return !!session && session.status === 'active' && session.role !== 'viewer' &&
        typeof session.idle_expires_at === 'number' && session.idle_expires_at > this.now() &&
        typeof session.absolute_expires_at === 'number' && session.absolute_expires_at > this.now()
    }
    if (mode?.auth_mode !== 'personal') return false
    const owner = db.query(`SELECT owners.operator_id FROM main.personal_owners owners
      JOIN main.users ON users.user_id = owners.user_id
      WHERE owners.user_id = ? AND users.status = 'active' AND owners.singleton = 1`)
      .get(evidence.userId) as Row | null
    const access = db.query('SELECT state_json FROM main.hosted_access_authority WHERE singleton = 1').get() as Row | null
    if (!owner || !access) return false
    const state = parsed(access.state_json, 256 * 1024)
    const stateBinding = object(state.binding)
    const session = Array.isArray(state.sessions) ? state.sessions.map(object)
      .find(row => row.sessionId === evidence.sessionId) : undefined
    const family = Array.isArray(state.deviceFamilies) ? state.deviceFamilies.map(object)
      .find(row => row.familyId === session?.familyId) : undefined
    const deadlines = session ? object(session.deadlines) : null
    const validDeadline = (value: unknown) => Number.isSafeInteger(value) && (value as number) > this.now()
    return state.operatorId === owner.operator_id && stateBinding.deploymentId === reservation.deploymentId &&
      stateBinding.restoreGeneration === reservation.restoreGeneration && state.resetIntent === null &&
      session?.operatorId === owner.operator_id && session.status === 'active' &&
      !!deadlines && validDeadline(deadlines.idleExpiresAt) && validDeadline(deadlines.absoluteExpiresAt) &&
      validDeadline(deadlines.renewalExpiresAt) && family?.operatorId === owner.operator_id &&
      family.status === 'active' && validDeadline(family.idleExpiresAt) && validDeadline(family.absoluteExpiresAt)
  }
}
