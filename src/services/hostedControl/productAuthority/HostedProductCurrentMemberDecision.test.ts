import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import { HostedProductCurrentMemberDecision, type HostedProductMemberBinding } from './HostedProductCurrentMemberDecision.js'
import { PRODUCT_V30_V33_SCHEMA } from './ProductV30V33Schema.js'

type Fixture = { directory: string; databasePath: string; db: Database;
  reader: HostedProductCurrentMemberDecision; binding: HostedProductMemberBinding; expectedName: string }

async function fixture(): Promise<Fixture> {
  const directory = await realpath(await mkdtemp('/tmp/hosted-product-v35-member-'))
  await chmod(directory, 0o700)
  const databasePath = path.join(directory, 'product.sqlite')
  // Product WorkerCore created, promoted, reserved, adopted and activated this test member.
  const compressed = await readFile(path.join(import.meta.dir, 'fixtures/product-v35-current-member.sqlite.gz'))
  await writeFile(databasePath, gunzipSync(compressed), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(import.meta.dir,
    'fixtures/product-v35-current-member.metadata.json'), 'utf8')) as {
      now: number; expectedName: string; runId: string; memberId: string; runtimeWorkspaceId: string;
      binding: { deploymentId: string; restoreGeneration: number; mountGeneration: number }
    }
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reservationRow = db.query('SELECT record_json FROM hosted_lifecycle_run_reservations WHERE run_id = ?')
    .get(metadata.runId) as { record_json: string }
  const reservation = JSON.parse(reservationRow.record_json) as {
    teamId: string; promotionOperationId: string; planSha256: string; rosterBindingSha256: string }
  const rosterRow = db.query('SELECT binding_json FROM hosted_promotion_roster_bindings WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { binding_json: string }
  const roster = JSON.parse(rosterRow.binding_json) as {
    lanes: Array<{ laneId: string; members: Array<{ memberId: string }> }> }
  const lane = roster.lanes.find(entry => entry.members.some(member => member.memberId === metadata.memberId))
  if (!lane) throw new Error('fixture-member-missing')
  const binding: HostedProductMemberBinding = {
    runId: metadata.runId, memberId: metadata.memberId, teamId: reservation.teamId,
    laneId: lane.laneId, deploymentId: metadata.binding.deploymentId,
    runtimeWorkspaceId: metadata.runtimeWorkspaceId, planSha256: reservation.planSha256,
    rosterBindingSha256: reservation.rosterBindingSha256,
    restoreGeneration: metadata.binding.restoreGeneration,
    mountGeneration: metadata.binding.mountGeneration,
  }
  const reader = await HostedProductCurrentMemberDecision.create({ databasePath,
    expectedUid: process.getuid!(), now: () => metadata.now, testOnlyAllowNonRoot: true })
  return { directory, databasePath, db, reader, binding, expectedName: metadata.expectedName }
}

async function close(f: Fixture): Promise<void> {
  f.reader.close()
  f.db.close()
  await rm(f.directory, { recursive: true, force: true })
}

test('Product v35 current member is admitted, forged bindings and revoked grant/session are denied', async () => {
  const f = await fixture()
  try {
    expect(await f.reader.withCurrentMemberDecision(f.binding, 'prepare', current => current.memberName))
      .toBe(f.expectedName)
    for (const forged of [
      { ...f.binding, runId: `run_${'f'.repeat(32)}` },
      { ...f.binding, memberId: `member_${'f'.repeat(32)}` },
      { ...f.binding, teamId: `team_${'f'.repeat(32)}` },
      { ...f.binding, planSha256: 'f'.repeat(64) },
      { ...f.binding, deploymentId: 'deployment_other.1234' },
    ]) {
      await expect(f.reader.withCurrentMemberDecision(forged, 'start', () => true))
        .rejects.toThrow('member-not-current')
    }
    const original = f.db.query('SELECT grant_revision FROM hosted_workspace_grants').get() as {
      grant_revision: string }
    f.db.query('UPDATE hosted_workspace_grants SET grant_revision = ?').run('e'.repeat(64))
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => true))
      .rejects.toThrow('member-not-current')
    f.db.query('UPDATE hosted_workspace_grants SET grant_revision = ?').run(original.grant_revision)
    f.db.query("UPDATE operator_sessions SET status = 'revoked'").run()
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => true))
      .rejects.toThrow('member-not-current')
  } finally { await close(f) }
})

test('old boot and Owner session cannot authorize a member after an epoch change', async () => {
  for (const [column, next] of [
    ['boot_id', 'boot_new-epoch'],
    ['owner_session_id', 'owner-session_new-epoch'],
  ] as const) {
    const f = await fixture()
    try {
      let effects = 0
      await f.reader.withCurrentMemberDecision(f.binding, 'prepare', () => { effects++; return true })
      f.db.query(`UPDATE hosted_lifecycle_deployment_authorities
        SET ${column} = ?, owner_generation = owner_generation + 1, revision = revision + 1`)
        .run(next)
      await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => {
        effects++; return true
      })).rejects.toThrow('member-not-current')
      expect(effects).toBe(1)
    } finally { await close(f) }
  }
})

test('committed authority, pending cleanup, run and member retirement each deny later effects', async () => {
  for (const retire of [
    (f: Fixture) => f.db.query(`UPDATE hosted_lifecycle_deployment_authorities
      SET state = 'retired', revision = revision + 1`).run(),
    (f: Fixture) => f.db.query(`UPDATE hosted_lifecycle_current_runs
      SET state = 'cleanup_pending' WHERE run_id = ?`).run(f.binding.runId),
    (f: Fixture) => {
      f.db.query(`UPDATE hosted_lifecycle_current_runs
        SET state = 'cleanup_pending' WHERE run_id = ?`).run(f.binding.runId)
      f.db.query(`UPDATE hosted_lifecycle_current_runs
        SET state = 'retired' WHERE run_id = ?`).run(f.binding.runId)
    },
    (f: Fixture) => f.db.query(`INSERT INTO hosted_lifecycle_retired_members
      (run_id, member_id) VALUES (?, ?)`).run(f.binding.runId, f.binding.memberId),
  ]) {
    const f = await fixture()
    try {
      let effects = 0
      await f.reader.withCurrentMemberDecision(f.binding, 'start', () => { effects++; return true })
      retire(f)
      await expect(f.reader.withCurrentMemberDecision(f.binding, 'start', () => {
        effects++; return true
      })).rejects.toThrow('member-not-current')
      expect(effects).toBe(1)
    } finally { await close(f) }
  }
})

test('missing or replaced Product database is refused before callback', async () => {
  const f = await fixture()
  try {
    await unlink(f.databasePath)
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'observe', () => true)).rejects.toThrow()
  } finally { await close(f) }
  const g = await fixture()
  try {
    const moved = path.join(g.directory, 'old.sqlite')
    await rename(g.databasePath, moved)
    const replacementPath = path.join(g.directory, 'replacement.sqlite')
    const replacement = new Database(replacementPath)
    replacement.exec('PRAGMA user_version = 35')
    replacement.close()
    await rename(replacementPath, g.databasePath)
    await chmod(g.databasePath, 0o600)
    await expect(g.reader.withCurrentMemberDecision(g.binding, 'observe', () => true))
      .rejects.toThrow('database-substituted')
  } finally { await close(g) }
})

test('Product v33 marker and altered immutable schema objects fail closed', async () => {
  const f = await fixture()
  try {
    f.db.exec('DROP TRIGGER hosted_promotions_no_update')
    await expect(f.reader.withCurrentMemberDecision(f.binding, 'observe', () => true))
      .rejects.toThrow('schema-incompatible')
  } finally { await close(f) }
  const g = await fixture()
  try {
    g.db.exec('DROP TRIGGER hosted_run_reservations_no_update')
    await expect(g.reader.withCurrentMemberDecision(g.binding, 'observe', () => true))
      .rejects.toThrow('schema-incompatible')
  } finally { await close(g) }
  const v35 = await fixture()
  try {
    v35.db.exec('DROP TRIGGER hosted_lifecycle_current_runs_guard_update')
    await expect(v35.reader.withCurrentMemberDecision(v35.binding, 'observe', () => true))
      .rejects.toThrow('schema-incompatible')
  } finally { await close(v35) }
  const h = await fixture()
  try {
    h.reader.close()
    h.db.exec('PRAGMA user_version = 33')
    await expect(HostedProductCurrentMemberDecision.create({ databasePath: h.databasePath,
      expectedUid: process.getuid!(), testOnlyAllowNonRoot: true }))
      .rejects.toThrow('schema-incompatible')
    h.db.close()
    await rm(h.directory, { recursive: true, force: true })
  } catch (error) { h.db.close(); await rm(h.directory, { recursive: true, force: true }); throw error }
  const directory = await realpath(await mkdtemp('/tmp/hosted-product-historical-v33-'))
  try {
    const databasePath = path.join(directory, 'product.sqlite')
    const historical = await readFile(path.join(import.meta.dir,
      'fixtures/product-v33-current-member.sqlite.gz'))
    await writeFile(databasePath, gunzipSync(historical), { mode: 0o600 })
    await expect(HostedProductCurrentMemberDecision.create({ databasePath,
      expectedUid: process.getuid!(), testOnlyAllowNonRoot: true }))
      .rejects.toThrow('schema-incompatible')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('tampered frozen mount or plan fails despite a current grant', async () => {
  for (const change of [
    (record: Record<string, unknown>) => ({ ...record, admittedWorkspaceRoot: '/sandbox/other' }),
    (record: Record<string, unknown>) => ({ ...record, planJson: `${record.planJson} ` }),
  ]) {
    const f = await fixture()
    try {
      const saved = f.db.query('SELECT record_json FROM hosted_team_configuration_promotions').get() as {
        record_json: string }
      const promotion = JSON.parse(saved.record_json) as Record<string, unknown>
      f.db.exec('DROP TRIGGER hosted_promotions_no_update')
      f.db.query('UPDATE hosted_team_configuration_promotions SET record_json = ?')
        .run(JSON.stringify(change(promotion)))
      const restore = PRODUCT_V30_V33_SCHEMA.v30.find(sql =>
        sql.startsWith('CREATE TRIGGER hosted_promotions_no_update'))
      if (!restore) throw new Error('test-v30-trigger-missing')
      f.db.exec(restore)
      await expect(f.reader.withCurrentMemberDecision(f.binding, 'prepare', () => true))
        .rejects.toThrow('promotion-snapshot-corrupt')
    } finally { await close(f) }
  }
})

test('Product record parsers reject malformed reservation scalars and metadata', async () => {
  for (const [table, triggerName, column, mutate, error] of [
    ['hosted_lifecycle_run_reservations', 'hosted_run_reservations_no_update',
      'record_json', (record: Record<string, unknown>) => ({ ...record, createdAtMs: -1 }),
      'reservation-corrupt'],
    ['hosted_team_configuration_promotions', 'hosted_promotions_no_update',
      'record_json', (record: Record<string, unknown>) => {
        const draft = JSON.parse(record.frozenDraftJson as string) as Record<string, unknown>
        draft.metadata = { name: 'x'.repeat(129) }
        return { ...record, frozenDraftJson: JSON.stringify(draft) }
      }, 'promotion-snapshot-corrupt'],
  ] as const) {
    const f = await fixture()
    try {
      const saved = f.db.query(`SELECT ${column} AS value FROM ${table}`).get() as { value: string }
      const schema = table === 'hosted_lifecycle_run_reservations'
        ? PRODUCT_V30_V33_SCHEMA.v33 : PRODUCT_V30_V33_SCHEMA.v30
      const restore = schema.find(sql => sql.startsWith(`CREATE TRIGGER ${triggerName}`))
      if (!restore) throw new Error('test-immutable-trigger-missing')
      f.db.exec(`DROP TRIGGER ${triggerName}`)
      f.db.query(`UPDATE ${table} SET ${column} = ?`)
        .run(JSON.stringify(mutate(JSON.parse(saved.value) as Record<string, unknown>)))
      f.db.exec(restore)
      await expect(f.reader.withCurrentMemberDecision(f.binding, 'prepare', () => true))
        .rejects.toThrow(error)
    } finally { await close(f) }
  }
})

test('BEGIN IMMEDIATE blocks a competing writer and nested decision rejects without deadlock', async () => {
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
  } finally { await close(f) }
})
