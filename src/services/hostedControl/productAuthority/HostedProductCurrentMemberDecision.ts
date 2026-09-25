import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { PRODUCT_V30_V33_SCHEMA } from './ProductV30V33Schema.js'

const SHA = /^[a-f0-9]{64}$/
const RUN = /^run_[a-f0-9]{32}$/
const MEMBER = /^member_[a-f0-9]{32}$/
const ID = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const DEPLOYMENT = /^deployment_[A-Za-z0-9][A-Za-z0-9._-]*$/
const PHASE_ONE = (prefix: string, value: unknown): boolean => typeof value === 'string' &&
  value.length <= 128 && new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9._-]*$`).test(value)
const REVISION = /^revision_[A-Za-z0-9][A-Za-z0-9._-]*$/
const IDEMPOTENCY = /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const PROMOTION = /^promotion_[a-f0-9]{32}$/
const ADOPTION = /^adoption_[a-f0-9]{32}$/
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
    [value.teamId, value.laneId, value.runtimeWorkspaceId]
      .every(id => typeof id === 'string' && ID.test(id)) &&
    typeof value.deploymentId === 'string' && value.deploymentId.length <= 128 &&
    DEPLOYMENT.test(value.deploymentId) &&
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

function initialMemberName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value)) return false
  const lower = value.toLowerCase()
  const stem = lower.split('.')[0]
  const suffix = /^(.+)-(\d+)$/.exec(value)
  return lower !== 'user' && lower !== 'team-lead' && !lower.endsWith('-provisioner') &&
    !new Set(['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]).has(stem) &&
    !(suffix && Number(suffix[2]) >= 2)
}

function qualifiedModel(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(value) || /^[A-Za-z]:/.test(value) ||
    value.split('/').some(part => part === '.' || part === '..')) return false
  const slash = value.indexOf('/')
  return slash > 0 && slash < value.length - 1 && /^[a-z0-9._-]+$/i.test(value.slice(0, slash))
}

function validEffort(value: unknown): boolean {
  return value === undefined || value === 'low' || value === 'medium' || value === 'high'
}

function frozenSnapshot(promotion: Row): { lanes: Row[] } {
  if (typeof promotion.frozenDraftJson !== 'string' || typeof promotion.frozenRosterJson !== 'string' ||
    typeof promotion.planJson !== 'string' || typeof promotion.planSha256 !== 'string' ||
    typeof promotion.admittedWorkspaceRoot !== 'string' ||
    !promotion.admittedWorkspaceRoot.startsWith('/') ||
    promotion.admittedWorkspaceRoot.includes('\0') || promotion.admittedWorkspaceRoot.length > 4096) {
    throw new Error('hosted-product-promotion-snapshot-corrupt')
  }
  const draft = exact(parsed(promotion.frozenDraftJson, 256 * 1024),
    ['workspaceId', 'teamId', 'revision', 'metadata', 'members', 'configuration'])
  const envelope = exact(parsed(promotion.frozenRosterJson, 256 * 1024),
    ['schemaVersion', 'members', 'configuration'])
  if (draft.workspaceId !== promotion.workspaceId || draft.teamId !== promotion.teamId ||
    draft.revision !== promotion.expectedRevision || envelope.schemaVersion !== 1 ||
    JSON.stringify(draft.members) !== JSON.stringify(envelope.members) ||
    JSON.stringify(draft.configuration) !== JSON.stringify(envelope.configuration) ||
    !Array.isArray(promotion.laneIds) || !Array.isArray(draft.members)) {
    throw new Error('hosted-product-promotion-snapshot-corrupt')
  }
  const metadata = object(draft.metadata)
  const metadataLimits: Readonly<Record<string, number>> = {
    name: 128, description: 4000, color: 64, language: 64,
  }
  if (Object.keys(metadata).length < 1 || Object.entries(metadata).some(([key, value]) =>
    !Object.hasOwn(metadataLimits, key) || typeof value !== 'string' || !value ||
    value.length > metadataLimits[key] || value.trim() !== value) ||
    !Object.hasOwn(metadata, 'name') ||
    draft.members.some(value => !initialMemberName(exact(value, ['name']).name))) {
    throw new Error('hosted-product-promotion-snapshot-corrupt')
  }
  const configuration = exact(draft.configuration, ['schemaVersion', 'toolApprovalMode', 'lanes'])
  if (configuration.schemaVersion !== 1 || configuration.toolApprovalMode !== 'auto' ||
    !Array.isArray(configuration.lanes) || configuration.lanes.length < 1 ||
    configuration.lanes.length > 32 || configuration.lanes.length !== promotion.laneIds.length ||
    draft.members.length < 1 || draft.members.length > 32 ||
    Buffer.byteLength(JSON.stringify(configuration)) > 192 * 1024 ||
    new Set(promotion.laneIds).size !== promotion.laneIds.length) {
    throw new Error('hosted-product-promotion-snapshot-corrupt')
  }
  const seenNames = new Set<string>()
  const orderedNames: string[] = []
  const lanes = configuration.lanes.map((value: unknown, index: number) => {
    const lane = object(value)
    const optionalEffort = Object.hasOwn(lane, 'effort') ? ['effort'] : []
    exact(lane, ['kind', 'provider', 'selectedModel', 'members', ...optionalEffort])
    if (lane.kind !== 'opencode' || lane.provider !== 'opencode' ||
      !qualifiedModel(lane.selectedModel) || !validEffort(lane.effort) || !Array.isArray(lane.members) ||
      lane.members.length < 1 || lane.members.length > 32 ||
      typeof promotion.laneIds[index] !== 'string' ||
      !/^lane_[a-f0-9]{32}$/.test(promotion.laneIds[index] as string)) {
      throw new Error('hosted-product-promotion-snapshot-corrupt')
    }
    return lane
  })
  const planLanes = lanes.map((lane, index) => ({
    laneId: promotion.laneIds[index], kind: lane.kind, provider: lane.provider,
    selectedModel: lane.selectedModel,
    ...(lane.effort === undefined ? {} : { effort: lane.effort }),
    members: (lane.members as unknown[]).map(value => {
      const member = object(value)
      exact(member, ['name', 'prompt', ...(Object.hasOwn(member, 'model') ? ['model'] : []),
        ...(Object.hasOwn(member, 'effort') ? ['effort'] : [])])
      if (typeof member.name !== 'string' || !member.name ||
        !initialMemberName(member.name) || seenNames.has(member.name.toLowerCase()) ||
        typeof member.prompt !== 'string' || !member.prompt ||
        member.prompt.trim() !== member.prompt || member.prompt.includes('\0') ||
        Buffer.byteLength(member.prompt) > 64 * 1024 ||
        !validEffort(member.effort) ||
        member.model !== undefined && !qualifiedModel(member.model)) {
        throw new Error('hosted-product-promotion-snapshot-corrupt')
      }
      seenNames.add(member.name.toLowerCase())
      orderedNames.push(member.name)
      if (seenNames.size > 32) throw new Error('hosted-product-promotion-snapshot-corrupt')
      return { name: member.name, prompt: member.prompt,
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.effort === undefined ? {} : { effort: member.effort }) }
    }),
  }))
  const expectedPlanJson = JSON.stringify({ schemaVersion: 2,
    workspaceId: promotion.runtimeWorkspaceId, teamId: promotion.teamId,
    workspaceRoot: promotion.admittedWorkspaceRoot,
    toolApprovalMode: configuration.toolApprovalMode, lanes: planLanes })
  if (orderedNames.length !== draft.members.length || orderedNames.some((name, index) =>
    name !== object(draft.members[index]).name)) throw new Error('hosted-product-promotion-snapshot-corrupt')
  if (expectedPlanJson !== promotion.planJson || sha(expectedPlanJson) !== promotion.planSha256 ||
    promotion.planGeneration !== `plan-generation_${promotion.planSha256}`) {
    throw new Error('hosted-product-promotion-snapshot-corrupt')
  }
  return { lanes }
}

// Exact Product v35 DDL snapshot for cross-process schema admission.
const PRODUCT_V35_SCHEMA = {
  version: 35,
  statements: [
    `CREATE TABLE hosted_lifecycle_deployment_authorities (
      deployment_id TEXT PRIMARY KEY,
      boot_id TEXT NOT NULL,
      owner_authority TEXT NOT NULL,
      owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
      owner_session_id TEXT NOT NULL,
      restore_generation INTEGER NOT NULL CHECK (restore_generation >= 0),
      mount_generation INTEGER NOT NULL CHECK (mount_generation > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'retired'))
    )`,
    `CREATE TRIGGER hosted_lifecycle_authorities_no_replace BEFORE INSERT ON hosted_lifecycle_deployment_authorities
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_deployment_authorities a
        WHERE a.rowid = NEW.rowid OR a.deployment_id = NEW.deployment_id)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority is retained'); END`,
    `CREATE TRIGGER hosted_lifecycle_authorities_no_delete BEFORE DELETE ON hosted_lifecycle_deployment_authorities
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority is retained'); END`,
    `CREATE TRIGGER hosted_lifecycle_authorities_guard_update BEFORE UPDATE ON hosted_lifecycle_deployment_authorities
      WHEN NEW.deployment_id != OLD.deployment_id OR NEW.revision != OLD.revision + 1
        OR NEW.owner_generation < OLD.owner_generation
        OR NEW.owner_authority != OLD.owner_authority
        OR (NEW.owner_generation = OLD.owner_generation AND
          (NEW.boot_id != OLD.boot_id OR NEW.owner_authority != OLD.owner_authority OR
           NEW.owner_session_id != OLD.owner_session_id OR
           NEW.restore_generation != OLD.restore_generation OR
           NEW.mount_generation != OLD.mount_generation))
        OR (OLD.state = 'retired' AND NEW.owner_generation = OLD.owner_generation)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle authority transition invalid'); END`,
    `CREATE TABLE hosted_lifecycle_current_runs (
      run_id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      owner_authority TEXT NOT NULL,
      owner_generation INTEGER NOT NULL,
      owner_session_id TEXT NOT NULL,
      restore_generation INTEGER NOT NULL,
      mount_generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('eligible', 'retired')),
      FOREIGN KEY (run_id) REFERENCES hosted_lifecycle_run_reservations(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE UNIQUE INDEX hosted_lifecycle_one_eligible_run_per_team
      ON hosted_lifecycle_current_runs (deployment_id, team_id) WHERE state = 'eligible'`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_no_replace BEFORE INSERT ON hosted_lifecycle_current_runs
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_current_runs r
        WHERE r.rowid = NEW.rowid OR r.run_id = NEW.run_id OR
          (r.deployment_id = NEW.deployment_id AND r.team_id = NEW.team_id AND r.state = 'eligible'))
        OR NOT EXISTS (SELECT 1 FROM hosted_lifecycle_deployment_authorities a
          WHERE a.deployment_id = NEW.deployment_id AND a.boot_id = NEW.boot_id
            AND a.owner_authority = NEW.owner_authority AND a.owner_generation = NEW.owner_generation
            AND a.owner_session_id = NEW.owner_session_id
            AND a.restore_generation = NEW.restore_generation
            AND a.mount_generation = NEW.mount_generation AND a.state = 'active')
        OR NOT EXISTS (SELECT 1 FROM hosted_lifecycle_run_reservations r
          WHERE r.run_id = NEW.run_id AND r.deployment_id = NEW.deployment_id
            AND r.boot_id = NEW.boot_id AND r.team_id = NEW.team_id)
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle current run binding invalid'); END`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_guard_update BEFORE UPDATE ON hosted_lifecycle_current_runs
      WHEN OLD.state != 'eligible' OR NEW.state != 'retired' OR NEW.run_id != OLD.run_id
        OR NEW.deployment_id != OLD.deployment_id OR NEW.boot_id != OLD.boot_id
        OR NEW.team_id != OLD.team_id OR NEW.owner_authority != OLD.owner_authority
        OR NEW.owner_generation != OLD.owner_generation OR NEW.owner_session_id != OLD.owner_session_id
        OR NEW.restore_generation != OLD.restore_generation OR NEW.mount_generation != OLD.mount_generation
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle run transition invalid'); END`,
    `CREATE TRIGGER hosted_lifecycle_current_runs_no_delete BEFORE DELETE ON hosted_lifecycle_current_runs
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle run is retained'); END`,
    `CREATE TABLE hosted_lifecycle_retired_members (
      run_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      PRIMARY KEY (run_id, member_id),
      FOREIGN KEY (run_id) REFERENCES hosted_lifecycle_current_runs(run_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
    )`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_replace BEFORE INSERT ON hosted_lifecycle_retired_members
      WHEN EXISTS (SELECT 1 FROM hosted_lifecycle_retired_members m
        WHERE m.rowid = NEW.rowid OR (m.run_id = NEW.run_id AND m.member_id = NEW.member_id))
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is immutable'); END`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_update BEFORE UPDATE ON hosted_lifecycle_retired_members
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is immutable'); END`,
    `CREATE TRIGGER hosted_lifecycle_retired_members_no_delete BEFORE DELETE ON hosted_lifecycle_retired_members
      BEGIN SELECT RAISE(ABORT, 'hosted lifecycle member retirement is retained'); END`,
  ],
} as const


/** Root process reads the Product v35 writer DB. This is a current decision, never a launch permit. */
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
    if ((db.query('PRAGMA user_version').get() as Row | null)?.user_version !== 35 ||
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
      hosted_lifecycle_deployment_authorities: ['deployment_id', 'boot_id', 'owner_authority',
        'owner_generation', 'owner_session_id', 'restore_generation', 'mount_generation', 'revision', 'state'],
      hosted_lifecycle_current_runs: ['run_id', 'deployment_id', 'boot_id', 'team_id',
        'owner_authority', 'owner_generation', 'owner_session_id', 'restore_generation',
        'mount_generation', 'state'],
      hosted_lifecycle_retired_members: ['run_id', 'member_id'],
    }
    for (const [table, columns] of Object.entries(required)) {
      const schema = db.query('SELECT type FROM main.sqlite_schema WHERE name = ?').get(table) as Row | null
      const present = db.query(`PRAGMA main.table_info(${table})`).all() as Row[]
      if (schema?.type !== 'table' || columns.some(column => !present.some(row => row.name === column))) {
        throw new Error('hosted-product-schema-incompatible')
      }
    }
    for (const [version, table, triggerPrefix, autoindexes] of [
      ['v30', 'hosted_team_configuration_promotions', 'hosted_promotions_', 3],
      ['v32', 'hosted_promotion_roster_bindings', 'hosted_roster_bindings_', 1],
      ['v33', 'hosted_lifecycle_run_reservations', 'hosted_run_reservations_', 4],
    ] as const) {
      const statements = PRODUCT_V30_V33_SCHEMA[version]
      const expected: Array<{ type: string; name: string; tableName: string; sql: string | null }> =
        statements.map(sql => {
          const match = /^CREATE (TABLE|TRIGGER) ([a-z_]+)/u.exec(sql)
          if (!match) throw new Error('hosted-product-schema-contract-invalid')
          const tableName = match[1] === 'TABLE' ? match[2] : / ON ([a-z_]+)\n/u.exec(sql)?.[1]
          if (!tableName) throw new Error('hosted-product-schema-contract-invalid')
          return { type: match[1].toLowerCase(), name: match[2],
            tableName, sql }
        })
      for (let index = 1; index <= autoindexes; index++) {
        expected.push({ type: 'index', name: `sqlite_autoindex_${table}_${index}`, tableName: table,
          sql: null })
      }
      const records = (schema: 'main' | 'temp') => (db.query(
        `SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`).all() as Row[])
        .filter(row => row.tableName === table ||
          typeof row.name === 'string' && (row.name.startsWith(triggerPrefix) ||
            version === 'v30' && row.name.startsWith(table) ||
            row.name.startsWith(`sqlite_autoindex_${table}`)))
      const actual = records('main')
      if (records('temp').length || actual.length !== expected.length ||
        expected.some(wanted => !actual.some(row => row.type === wanted.type &&
          row.name === wanted.name && row.tableName === wanted.tableName && row.sql === wanted.sql))) {
        throw new Error('hosted-product-schema-incompatible')
      }
    }
    const v35Tables = ['hosted_lifecycle_deployment_authorities',
      'hosted_lifecycle_current_runs', 'hosted_lifecycle_retired_members'] as const
    const v35Expected: Array<{ type: string; name: string; tableName: string; sql: string | null }> =
      PRODUCT_V35_SCHEMA.statements.map(sql => {
        const match = /^CREATE (TABLE|TRIGGER|UNIQUE INDEX) ([a-z_]+)/u.exec(sql)
        const type = match?.[1] === 'UNIQUE INDEX' ? 'index' : match?.[1]?.toLowerCase()
        const tableName = type === 'table' ? match?.[2] : / ON ([a-z_]+)/u.exec(sql)?.[1]
        if (!match || !type || !tableName) throw new Error('hosted-product-schema-contract-invalid')
        return { type, name: match[2], tableName, sql }
      })
    for (const table of v35Tables) {
      v35Expected.push({ type: 'index', name: `sqlite_autoindex_${table}_1`,
        tableName: table, sql: null })
    }
    const v35Records = (schema: 'main' | 'temp') => (db.query(
      `SELECT type, name, tbl_name AS tableName, sql FROM ${schema}.sqlite_schema`).all() as Row[])
      .filter(row => {
        const name = row.name
        return v35Tables.includes(row.tableName as typeof v35Tables[number]) ||
          typeof name === 'string' && (
            name.startsWith('hosted_lifecycle_authorities_') ||
            name.startsWith('hosted_lifecycle_current_runs_') ||
            name.startsWith('hosted_lifecycle_retired_members_') ||
            name === 'hosted_lifecycle_one_eligible_run_per_team' ||
            v35Tables.some(table => name.startsWith(`sqlite_autoindex_${table}_`)))
      })
    const actualV35 = v35Records('main')
    if (v35Records('temp').length || actualV35.length !== v35Expected.length ||
      v35Expected.some(wanted => !actualV35.some(row => row.type === wanted.type &&
        row.name === wanted.name && row.tableName === wanted.tableName && row.sql === wanted.sql))) {
      throw new Error('hosted-product-schema-incompatible')
    }
    if ((db.query('PRAGMA ignore_check_constraints').get() as Row | null)?.ignore_check_constraints !== 0 ||
      (db.query('PRAGMA main.foreign_key_check').all() as Row[]).length !== 0 ||
      (db.query('PRAGMA main.integrity_check').get() as Row | null)?.integrity_check !== 'ok') {
      throw new Error('hosted-product-schema-incompatible')
    }
  }

  private current(binding: HostedProductMemberBinding): HostedProductCurrentMember | null {
    const db = this.database
    const reservationRow = db.query(`SELECT run_id, promotion_operation_id, deployment_id, actor_id,
      boot_id, team_id, expected_revision, command_id, idempotency_key, record_json
      FROM main.hosted_lifecycle_run_reservations WHERE run_id = ?`)
      .get(binding.runId) as Row | null
    if (!reservationRow) return null
    const reservation = exact(parsed(reservationRow.record_json, 16 * 1024), [
      'schemaVersion', 'workspaceId', 'runtimeWorkspaceId', 'teamId', 'actorId',
      'deploymentId', 'bootId', 'commandId', 'idempotencyKey', 'expectedRevision',
      'expectedPlanGeneration', 'ownerAuthority', 'ownerGeneration', 'ownerSessionId',
      'restoreGeneration', 'mountGeneration', 'ownerEffectFence', 'authorityEvidence',
      'runId', 'promotionOperationId', 'planSha256', 'rosterBindingSha256', 'createdAtMs',
    ])
    for (const [column, field] of [['run_id', 'runId'], ['promotion_operation_id', 'promotionOperationId'],
      ['deployment_id', 'deploymentId'], ['actor_id', 'actorId'], ['boot_id', 'bootId'],
      ['team_id', 'teamId'], ['expected_revision', 'expectedRevision'],
      ['command_id', 'commandId'], ['idempotency_key', 'idempotencyKey']] as const) {
      if (!same(reservationRow[column], reservation[field])) throw new Error('hosted-product-reservation-corrupt')
    }
    if (reservation.schemaVersion !== 1 || !Number.isSafeInteger(reservation.createdAtMs) ||
      (reservation.createdAtMs as number) < 0 ||
      !/^workspace_[a-f0-9]{32}$/.test(reservation.workspaceId as string) ||
      !/^workspace_[a-f0-9]{32}$/.test(reservation.runtimeWorkspaceId as string) ||
      !/^team_[a-f0-9]{32}$/.test(reservation.teamId as string) ||
      !PHASE_ONE('actor', reservation.actorId) || !PHASE_ONE('boot', reservation.bootId) ||
      !PHASE_ONE('deployment', reservation.deploymentId) ||
      !PROMOTION.test(reservation.promotionOperationId as string) ||
      !/^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(reservation.commandId as string) ||
      !IDEMPOTENCY.test(reservation.idempotencyKey as string) ||
      typeof reservation.expectedRevision !== 'string' ||
      reservation.expectedRevision.length > 256 || !REVISION.test(reservation.expectedRevision) ||
      typeof reservation.ownerAuthority !== 'string' ||
      !/^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(reservation.ownerAuthority) ||
      typeof reservation.ownerSessionId !== 'string' ||
      !/^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(reservation.ownerSessionId) ||
      !Number.isSafeInteger(reservation.ownerGeneration) || (reservation.ownerGeneration as number) < 1) {
      throw new Error('hosted-product-reservation-corrupt')
    }
    if (reservation.runId !== binding.runId || reservation.teamId !== binding.teamId ||
      reservation.deploymentId !== binding.deploymentId ||
      reservation.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
      reservation.planSha256 !== binding.planSha256 ||
      reservation.rosterBindingSha256 !== binding.rosterBindingSha256 ||
      reservation.restoreGeneration !== binding.restoreGeneration ||
      reservation.mountGeneration !== binding.mountGeneration ||
      reservation.expectedPlanGeneration !== `plan-generation_${binding.planSha256}`) return null
    if (!this.currentLifecycleEpoch(reservation, binding)) return null
    const evidence = exact(reservation.authorityEvidence, ['userId', 'sessionId', 'grantGeneration'])
    const fence = exact(reservation.ownerEffectFence, ['grantRevision', 'identityChecksum'])
    if (typeof evidence.userId !== 'string' || !ID.test(evidence.userId) ||
      !ID.test(evidence.sessionId as string) || !SHA.test(fence.grantRevision as string) ||
      !SHA.test(fence.identityChecksum as string) ||
      !Number.isSafeInteger(evidence.grantGeneration) || (evidence.grantGeneration as number) < 0 ||
      evidence.grantGeneration !== reservation.restoreGeneration) {
      throw new Error('hosted-product-reservation-corrupt')
    }
    const promotionRow = db.query(`SELECT operation_id, workspace_id, team_id, actor_id, deployment_id,
      idempotency_key,
      record_json FROM main.hosted_team_configuration_promotions WHERE operation_id = ?`)
      .get(reservation.promotionOperationId as string) as Row | null
    if (!promotionRow) return null
    const promotion = exact(parsed(promotionRow.record_json, 2 * 1024 * 1024), [
      'workspaceId', 'teamId', 'actorId', 'deploymentId', 'createOperationId',
      'runtimeWorkspaceId', 'bindingGeneration', 'expectedRevision', 'idempotencyKey',
      'admittedWorkspaceRoot', 'operationId', 'frozenRosterJson', 'frozenDraftJson',
      'laneIds', 'planJson', 'planSha256', 'planGeneration', 'createdAtMs', 'state',
    ])
    for (const [column, field] of [['operation_id', 'operationId'], ['workspace_id', 'workspaceId'],
      ['team_id', 'teamId'], ['actor_id', 'actorId'], ['deployment_id', 'deploymentId'],
      ['idempotency_key', 'idempotencyKey']] as const) {
      if (!same(promotionRow[column], promotion[field])) throw new Error('hosted-product-promotion-corrupt')
    }
    if (!PROMOTION.test(promotion.operationId as string) ||
      !ADOPTION.test(promotion.createOperationId as string) ||
      !IDEMPOTENCY.test(promotion.idempotencyKey as string) ||
      !Number.isSafeInteger(promotion.bindingGeneration) || (promotion.bindingGeneration as number) < 1 ||
      !Number.isSafeInteger(promotion.createdAtMs) || (promotion.createdAtMs as number) < 0 ||
      typeof promotion.expectedRevision !== 'string' ||
      promotion.expectedRevision.length > 256 || !REVISION.test(promotion.expectedRevision) ||
      !/^workspace_[a-f0-9]{32}$/.test(promotion.workspaceId as string) ||
      !/^workspace_[a-f0-9]{32}$/.test(promotion.runtimeWorkspaceId as string) ||
      !/^team_[a-f0-9]{32}$/.test(promotion.teamId as string) ||
      !PHASE_ONE('actor', promotion.actorId) ||
      !PHASE_ONE('deployment', promotion.deploymentId)) {
      throw new Error('hosted-product-promotion-corrupt')
    }
    if (promotion.state !== 'frozen' || promotion.operationId !== reservation.promotionOperationId ||
      promotion.workspaceId !== reservation.workspaceId || promotion.teamId !== binding.teamId ||
      promotion.actorId !== reservation.actorId || promotion.deploymentId !== binding.deploymentId ||
      promotion.runtimeWorkspaceId !== binding.runtimeWorkspaceId ||
      promotion.planSha256 !== binding.planSha256 ||
      promotion.planGeneration !== reservation.expectedPlanGeneration) return null
    const snapshot = frozenSnapshot(promotion)
    const rosterRow = db.query(`SELECT plan_sha256, binding_json FROM main.hosted_promotion_roster_bindings
      WHERE operation_id = ?`).get(promotion.operationId as string) as Row | null
    if (!rosterRow || rosterRow.plan_sha256 !== binding.planSha256) return null
    const roster = exact(parsed(rosterRow.binding_json, 256 * 1024),
      ['schemaVersion', 'operationId', 'planSha256', 'lanes'])
    if (roster.schemaVersion !== 1 || roster.operationId !== promotion.operationId ||
      roster.planSha256 !== binding.planSha256 ||
      sha(JSON.stringify(roster)) !== binding.rosterBindingSha256 ||
      !Array.isArray(roster.lanes) || roster.lanes.length < 1 || roster.lanes.length > 32) return null
    if (roster.lanes.length !== snapshot.lanes.length) return null
    const memberIds = new Set<string>()
    const found = roster.lanes.flatMap((lane: unknown, laneOrdinal: number) => {
      const row = exact(lane, ['laneOrdinal', 'laneId', 'members'])
      const source = snapshot.lanes[laneOrdinal]
      if (row.laneOrdinal !== laneOrdinal || typeof row.laneId !== 'string' ||
        row.laneId !== promotion.laneIds?.[laneOrdinal] || !Array.isArray(row.members) ||
        row.members.length !== (source.members as unknown[]).length) {
        throw new Error('hosted-product-roster-corrupt')
      }
      return row.members.map((value: unknown, memberOrdinal: number) => {
        const member = exact(value, ['memberOrdinal', 'memberId', 'name', 'model', 'promptSha256'])
        const original = object((source.members as unknown[])[memberOrdinal])
        if (member.memberOrdinal !== memberOrdinal || typeof member.memberId !== 'string' ||
          !MEMBER.test(member.memberId) || memberIds.has(member.memberId) ||
          member.name !== original.name || member.model !== (original.model ?? source.selectedModel) ||
          typeof original.prompt !== 'string' || member.promptSha256 !== sha(original.prompt)) {
          throw new Error('hosted-product-roster-corrupt')
        }
        memberIds.add(member.memberId)
        return { lane: row, member }
      }).filter(({ member }) => member.memberId === binding.memberId)
    })
    if (found.length !== 1 || found[0].lane.laneId !== binding.laneId) return null
    const publication = db.query(`SELECT operation_id, runtime_workspace_id, binding_generation,
      legacy_key, directory_fingerprint, initial_revision FROM main.hosted_team_configuration_publications
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
    const createKeys = db.query(`SELECT initial_revision FROM main.hosted_team_configuration_create_keys
      WHERE workspace_id = ? AND team_id = ?`).all(reservation.workspaceId as string,
      binding.teamId) as Row[]
    if (createKeys.length !== 1 || createKeys[0].initial_revision !== publication.initial_revision) return null
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

  /** Called only inside the caller's BEGIN IMMEDIATE, serializing with Product retire writes. */
  private currentLifecycleEpoch(reservation: Row, binding: HostedProductMemberBinding): boolean {
    const current = this.database.query(`SELECT 1 FROM main.hosted_lifecycle_deployment_authorities authority
      JOIN main.hosted_lifecycle_current_runs run ON run.deployment_id = authority.deployment_id
      WHERE authority.deployment_id = ? AND authority.state = 'active'
        AND authority.boot_id = ? AND authority.owner_authority = ?
        AND authority.owner_generation = ? AND authority.owner_session_id = ?
        AND authority.restore_generation = ? AND authority.mount_generation = ?
        AND run.run_id = ? AND run.team_id = ? AND run.state = 'eligible'
        AND run.boot_id = authority.boot_id AND run.owner_authority = authority.owner_authority
        AND run.owner_generation = authority.owner_generation
        AND run.owner_session_id = authority.owner_session_id
        AND run.restore_generation = authority.restore_generation
        AND run.mount_generation = authority.mount_generation
        AND NOT EXISTS (SELECT 1 FROM main.hosted_lifecycle_retired_members retired
          WHERE retired.run_id = run.run_id AND retired.member_id = ?)
      LIMIT 1`).get(binding.deploymentId, reservation.bootId as string,
      reservation.ownerAuthority as string, reservation.ownerGeneration as number,
      reservation.ownerSessionId as string, binding.restoreGeneration,
      binding.mountGeneration, binding.runId, binding.teamId, binding.memberId)
    return current !== null
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
