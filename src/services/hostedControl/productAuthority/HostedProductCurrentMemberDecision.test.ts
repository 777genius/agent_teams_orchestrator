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
  const directory = await realpath(await mkdtemp('/tmp/hosted-product-v33-member-'))
  await chmod(directory, 0o700)
  const databasePath = path.join(directory, 'product.sqlite')
  // Product ec14cd7145: WorkerCore created/promoted/reserved/adopted this test member;
  // HostedCurrentMemberAdmissionOps.resolve accepted it under the real v33 schema.
  const compressed = await readFile(path.join(import.meta.dir, 'fixtures/product-v33-current-member.sqlite.gz'))
  await writeFile(databasePath, gunzipSync(compressed), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(import.meta.dir,
    'fixtures/product-v33-current-member.binding.json'), 'utf8')) as
    HostedProductMemberBinding & { expectedName: string; now: number }
  const { expectedName, now, ...binding } = metadata
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reader = await HostedProductCurrentMemberDecision.create({ databasePath,
    expectedUid: process.getuid!(), now: () => now, testOnlyAllowNonRoot: true })
  return { directory, databasePath, db, reader, binding, expectedName }
}

async function close(f: Fixture): Promise<void> {
  f.reader.close()
  f.db.close()
  await rm(f.directory, { recursive: true, force: true })
}

test('Product v33 current member is admitted, forged bindings and revoked grant/session are denied', async () => {
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
    replacement.exec('PRAGMA user_version = 33')
    replacement.close()
    await rename(replacementPath, g.databasePath)
    await chmod(g.databasePath, 0o600)
    await expect(g.reader.withCurrentMemberDecision(g.binding, 'observe', () => true))
      .rejects.toThrow('database-substituted')
  } finally { await close(g) }
})

test('Product v32 marker and altered v30-v33 immutable schema objects fail closed', async () => {
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
  const h = await fixture()
  try {
    h.reader.close()
    h.db.exec('PRAGMA user_version = 32')
    await expect(HostedProductCurrentMemberDecision.create({ databasePath: h.databasePath,
      expectedUid: process.getuid!(), testOnlyAllowNonRoot: true }))
      .rejects.toThrow('schema-incompatible')
    h.db.close()
    await rm(h.directory, { recursive: true, force: true })
  } catch (error) { h.db.close(); await rm(h.directory, { recursive: true, force: true }); throw error }
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
