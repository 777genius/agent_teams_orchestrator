import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, realpath, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { HostedProductCurrentMemberDecision, type HostedProductMemberBinding } from './HostedProductCurrentMemberDecision.js'

const RUN_ID = `run_${'1'.repeat(32)}`
const MEMBER_ID = `member_${'2'.repeat(32)}`
const LANE_ID = `lane_${'3'.repeat(32)}`
const TEAM_ID = `team_${'4'.repeat(32)}`
const DEPLOYMENT_ID = `deployment_${'5'.repeat(32)}`
const WORKSPACE_ID = `workspace_${'6'.repeat(32)}`
const RUNTIME_WORKSPACE_ID = `workspace_${'7'.repeat(32)}`
const USER_ID = 'user_fixture1234'
const SESSION_ID = 'session_fixture1234'
const PROMOTION_ID = `promotion_${'8'.repeat(32)}`
const CREATE_ID = `adoption_${'9'.repeat(32)}`
const PLAN_SHA = 'a'.repeat(64)
const GRANT_REVISION = 'b'.repeat(64)
const IDENTITY_CHECKSUM = 'c'.repeat(64)
const now = 1_000_000

function actorId(userId: string): string {
  const domain = Buffer.from('agent-teams/hosted-query-context/actor/v1')
  const user = Buffer.from(userId)
  const frame = Buffer.allocUnsafe(8 + domain.length + user.length)
  frame.writeUInt32BE(domain.length, 0); domain.copy(frame, 4)
  frame.writeUInt32BE(user.length, 4 + domain.length); user.copy(frame, 8 + domain.length)
  return `actor_${createHash('sha256').update(frame).digest('hex')}`
}

const ACTOR_ID = actorId(USER_ID)

async function fixture(): Promise<{ directory: string; databasePath: string; db: Database;
  reader: HostedProductCurrentMemberDecision; binding: HostedProductMemberBinding }> {
  const directory = await realpath(await mkdtemp('/tmp/hosted-product-current-member-'))
  await chmod(directory, 0o700)
  const databasePath = path.join(directory, 'product.sqlite')
  const db = new Database(databasePath)
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA user_version = 33;
    CREATE TABLE hosted_lifecycle_run_reservations (run_id TEXT, promotion_operation_id TEXT,
      deployment_id TEXT, actor_id TEXT, boot_id TEXT, team_id TEXT, record_json TEXT);
    CREATE TABLE hosted_team_configuration_promotions (operation_id TEXT, workspace_id TEXT,
      team_id TEXT, actor_id TEXT, deployment_id TEXT, record_json TEXT);
    CREATE TABLE hosted_promotion_roster_bindings (operation_id TEXT, plan_sha256 TEXT, binding_json TEXT);
    CREATE TABLE hosted_team_configuration_publications (operation_id TEXT, workspace_id TEXT,
      team_id TEXT, actor_id TEXT, deployment_id TEXT, runtime_workspace_id TEXT,
      binding_generation INTEGER, legacy_key TEXT, directory_fingerprint TEXT, state TEXT);
    CREATE TABLE team_identity_records (team_id TEXT, state TEXT, legacy_key TEXT,
      directory_fingerprint TEXT, workspace_id TEXT, workspace_binding_generation INTEGER,
      adoption_intent_id TEXT, identity_checksum TEXT);
    CREATE TABLE hosted_workspace_grants (user_id TEXT, runtime_workspace_id TEXT,
      grant_generation INTEGER, grant_revision TEXT);
    CREATE TABLE hosted_workspaces (runtime_workspace_id TEXT, public_workspace_id TEXT, status TEXT);
    CREATE TABLE users (user_id TEXT, status TEXT);
    CREATE TABLE hosted_auth_configuration (singleton INTEGER, auth_mode TEXT);
    CREATE TABLE operator_sessions (session_id TEXT, user_id TEXT, status TEXT,
      idle_expires_at INTEGER, absolute_expires_at INTEGER);
    CREATE TABLE role_snapshots (session_id TEXT, role TEXT);`)
  const roster = { schemaVersion: 1, operationId: PROMOTION_ID, planSha256: PLAN_SHA,
    lanes: [{ laneOrdinal: 0, laneId: LANE_ID, members: [{ memberOrdinal: 0,
      memberId: MEMBER_ID, name: 'Builder', model: 'opencode', promptSha256: 'd'.repeat(64) }] }] }
  const rosterJson = JSON.stringify(roster)
  const rosterBindingSha256 = createHash('sha256').update(rosterJson).digest('hex')
  const reservation = { runId: RUN_ID, promotionOperationId: PROMOTION_ID, deploymentId: DEPLOYMENT_ID,
    actorId: ACTOR_ID, bootId: `boot_${'e'.repeat(32)}`, teamId: TEAM_ID,
    workspaceId: WORKSPACE_ID, runtimeWorkspaceId: RUNTIME_WORKSPACE_ID,
    planSha256: PLAN_SHA, rosterBindingSha256, expectedPlanGeneration: `plan-generation_${PLAN_SHA}`,
    restoreGeneration: 2, mountGeneration: 3,
    authorityEvidence: { userId: USER_ID, sessionId: SESSION_ID, grantGeneration: 2 },
    ownerEffectFence: { grantRevision: GRANT_REVISION, identityChecksum: IDENTITY_CHECKSUM } }
  const promotion = { operationId: PROMOTION_ID, createOperationId: CREATE_ID,
    workspaceId: WORKSPACE_ID, teamId: TEAM_ID, actorId: ACTOR_ID,
    deploymentId: DEPLOYMENT_ID, runtimeWorkspaceId: RUNTIME_WORKSPACE_ID,
    state: 'frozen', planSha256: PLAN_SHA, planGeneration: `plan-generation_${PLAN_SHA}`,
    bindingGeneration: 1, admittedWorkspaceRoot: '/sandbox/project' }
  db.query(`INSERT INTO hosted_lifecycle_run_reservations VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    RUN_ID, PROMOTION_ID, DEPLOYMENT_ID, ACTOR_ID, reservation.bootId, TEAM_ID, JSON.stringify(reservation))
  db.query(`INSERT INTO hosted_team_configuration_promotions VALUES (?, ?, ?, ?, ?, ?)`).run(
    PROMOTION_ID, WORKSPACE_ID, TEAM_ID, ACTOR_ID, DEPLOYMENT_ID, JSON.stringify(promotion))
  db.query(`INSERT INTO hosted_promotion_roster_bindings VALUES (?, ?, ?)`).run(PROMOTION_ID, PLAN_SHA, rosterJson)
  db.query(`INSERT INTO hosted_team_configuration_publications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    CREATE_ID, WORKSPACE_ID, TEAM_ID, ACTOR_ID, DEPLOYMENT_ID, RUNTIME_WORKSPACE_ID,
    1, 'legacy-key', 'f'.repeat(64), 'published')
  db.query(`INSERT INTO team_identity_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    TEAM_ID, 'active', 'legacy-key', 'f'.repeat(64), RUNTIME_WORKSPACE_ID,
    1, CREATE_ID, IDENTITY_CHECKSUM)
  db.query(`INSERT INTO hosted_workspace_grants VALUES (?, ?, ?, ?)`).run(
    USER_ID, RUNTIME_WORKSPACE_ID, 2, GRANT_REVISION)
  db.query(`INSERT INTO hosted_workspaces VALUES (?, ?, ?)`).run(RUNTIME_WORKSPACE_ID, WORKSPACE_ID, 'active')
  db.query(`INSERT INTO users VALUES (?, ?)`).run(USER_ID, 'active')
  db.query(`INSERT INTO hosted_auth_configuration VALUES (1, 'oidc')`).run()
  db.query(`INSERT INTO operator_sessions VALUES (?, ?, ?, ?, ?)`).run(
    SESSION_ID, USER_ID, 'active', now + 10_000, now + 20_000)
  db.query(`INSERT INTO role_snapshots VALUES (?, ?)`).run(SESSION_ID, 'member')
  await chmod(databasePath, 0o600)
  const reader = await HostedProductCurrentMemberDecision.create({ databasePath,
    expectedUid: process.getuid!(), now: () => now, testOnlyAllowNonRoot: true })
  const binding: HostedProductMemberBinding = { runId: RUN_ID, memberId: MEMBER_ID,
    teamId: TEAM_ID, laneId: LANE_ID, deploymentId: DEPLOYMENT_ID,
    runtimeWorkspaceId: RUNTIME_WORKSPACE_ID, planSha256: PLAN_SHA, rosterBindingSha256,
    restoreGeneration: 2, mountGeneration: 3 }
  return { directory, databasePath, db, reader, binding }
}

test('current Product member binding admits exactly one frozen roster member, then revocation fails closed', async () => {
  const f = await fixture()
  try {
    expect(await f.reader.withCurrentMemberDecision(f.binding, 'prepare', current => current.memberName))
      .toBe('Builder')
    for (const forged of [
      { ...f.binding, runId: `run_${'f'.repeat(32)}` },
      { ...f.binding, memberId: `member_${'f'.repeat(32)}` },
      { ...f.binding, planSha256: 'f'.repeat(64) },
      { ...f.binding, teamId: `team_${'f'.repeat(32)}` },
    ]) {
      await expect(f.reader.withCurrentMemberDecision(forged, 'start', () => true))
        .rejects.toThrow('member-not-current')
    }
    f.db.query('UPDATE hosted_workspace_grants SET grant_revision = ?').run('e'.repeat(64))
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => true))
      .rejects.toThrow('member-not-current')
    f.db.query('UPDATE hosted_workspace_grants SET grant_revision = ?').run(GRANT_REVISION)
    f.db.query("UPDATE operator_sessions SET status = 'revoked'").run()
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => true))
      .rejects.toThrow('member-not-current')
  } finally { f.reader.close(); f.db.close(); await rm(f.directory, { recursive: true, force: true }) }
})

test('missing or replaced Product DB is refused before callback', async () => {
  const f = await fixture()
  try {
    await unlink(f.databasePath)
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'observe', () => true)).rejects.toThrow()
  } finally { f.reader.close(); f.db.close(); await rm(f.directory, { recursive: true, force: true }) }
  const g = await fixture()
  try {
    const moved = path.join(g.directory, 'old.sqlite')
    await rename(g.databasePath, moved)
    const replacementPath = path.join(g.directory, 'replacement.sqlite')
    const replacement = new Database(replacementPath)
    replacement.exec('PRAGMA user_version = 33')
    replacement.close()
    await rename(replacementPath, g.databasePath)
    await chmod(g.databasePath, 0o600)
    await expect(g.reader.withCurrentMemberDecision(g.binding, 'observe', () => true))
      .rejects.toThrow('database-substituted')
  } finally { g.reader.close(); g.db.close(); await rm(g.directory, { recursive: true, force: true }) }
})

test('v32 Product schema marker is refused even with a frozen promotion and roster', async () => {
  const f = await fixture()
  try {
    f.reader.close()
    f.db.exec('PRAGMA user_version = 32')
    await expect(HostedProductCurrentMemberDecision.create({ databasePath: f.databasePath,
      expectedUid: process.getuid!(), now: () => now, testOnlyAllowNonRoot: true }))
      .rejects.toThrow('schema-incompatible')
  } finally { f.db.close(); await rm(f.directory, { recursive: true, force: true }) }
})

test('BEGIN IMMEDIATE fences a competing writer, and nested calls reject without deadlock', async () => {
  const f = await fixture()
  try {
    let nested!: Promise<unknown>
    await f.reader.withCurrentMemberDecision(f.binding, 'start', () => {
      nested = f.reader.withCurrentMemberDecision(f.binding, 'start', () => true)
      void nested.catch(() => undefined)
      const child = spawnSync(process.execPath, ['-e', `import { Database } from 'bun:sqlite';
        const db = new Database(${JSON.stringify(f.databasePath)}, {create:false,readwrite:true});
        db.exec('PRAGMA busy_timeout = 50');
        try { db.exec('BEGIN IMMEDIATE'); process.exit(2) }
        catch { process.exit(0) }`], { timeout: 500, encoding: 'utf8' })
      expect(child.status).toBe(0)
      return true
    })
    await expect(nested).rejects.toThrow('decision-nested')
    f.db.exec('BEGIN IMMEDIATE; ROLLBACK')
  } finally { f.reader.close(); f.db.close(); await rm(f.directory, { recursive: true, force: true }) }
})
