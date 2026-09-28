import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'

import { HostedRootSandboxMemberComposition } from './HostedRootSandboxMemberComposition.js'

const FIXTURES = path.join(import.meta.dir, '../productAuthority/fixtures')
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp('/tmp/hosted-root-sandbox-composition-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const databasePath = path.join(directory, 'product.sqlite')
  const bytes = await readFile(path.join(FIXTURES, 'product-v35-current-member.sqlite.gz'))
  await writeFile(databasePath, gunzipSync(bytes), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(FIXTURES,
    'product-v35-current-member.metadata.json'), 'utf8')) as {
      now: number; expectedName: string; runId: string; memberId: string;
      binding: { deploymentId: string; bootId: string; ownerAuthority: string;
        ownerGeneration: number; ownerSessionId: string }
    }
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reservation = JSON.parse((db.query('SELECT record_json FROM hosted_lifecycle_run_reservations WHERE run_id = ?')
    .get(metadata.runId) as { record_json: string }).record_json) as {
      promotionOperationId: string; teamId: string }
  const promotion = JSON.parse((db.query('SELECT record_json FROM hosted_team_configuration_promotions WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { record_json: string }).record_json) as {
      admittedWorkspaceRoot: string }
  const pins = { databasePath, expectedProductUid: process.getuid!(),
    workspaceParent: path.dirname(promotion.admittedWorkspaceRoot),
    sandboxWorkspaceRoot: promotion.admittedWorkspaceRoot,
    deploymentId: metadata.binding.deploymentId, bootId: metadata.binding.bootId,
    ownerAuthority: metadata.binding.ownerAuthority,
    ownerGeneration: metadata.binding.ownerGeneration,
    ownerSessionId: metadata.binding.ownerSessionId,
    runId: metadata.runId, memberIds: [metadata.memberId], now: () => metadata.now,
    testOnlyAllowNonRoot: true }
  return { db, pins, metadata, reservation }
}

test('root-only v35 composition derives one exact member from immutable roster and observes current epoch', async () => {
  const f = await fixture()
  const composed = await HostedRootSandboxMemberComposition.create(f.pins)
  try {
    const member = composed.member(f.metadata.memberId)
    expect(member.binding.runId).toBe(f.metadata.runId)
    expect(member.binding.memberId).toBe(f.metadata.memberId)
    expect(member.request.planFingerprint).toBe(member.binding.planSha256)
    expect(member.authority.matchesManagedRequest(member.request)).toBe(true)
    expect(await composed.prepareProof(f.metadata.memberId)).toMatchObject({
      memberName: f.metadata.expectedName,
      admittedWorkspaceRoot: f.pins.sandboxWorkspaceRoot,
    })
    expect(await composed.observe(f.metadata.memberId)).toMatchObject({
      memberName: f.metadata.expectedName,
      admittedWorkspaceRoot: f.pins.sandboxWorkspaceRoot,
    })
    expect(() => composed.member(`member_${'a'.repeat(32)}`)).toThrow('member-unbound')
  } finally { composed.close(); f.db.close() }
})

test('cleanup-pending or retired run and retired member cannot pass root observe', async () => {
  const f = await fixture()
  const composed = await HostedRootSandboxMemberComposition.create(f.pins)
  try {
    f.db.query("UPDATE hosted_lifecycle_current_runs SET state = 'cleanup_pending' WHERE run_id = ?")
      .run(f.metadata.runId)
    await expect(composed.observe(f.metadata.memberId)).rejects.toThrow('member-not-current')
    f.db.query("UPDATE hosted_lifecycle_current_runs SET state = 'retired' WHERE run_id = ?")
      .run(f.metadata.runId)
    await expect(composed.observe(f.metadata.memberId)).rejects.toThrow('member-not-current')
  } finally { composed.close(); f.db.close() }

  const g = await fixture()
  const another = await HostedRootSandboxMemberComposition.create(g.pins)
  try {
    g.db.query('INSERT INTO hosted_lifecycle_retired_members (run_id, member_id) VALUES (?, ?)')
      .run(g.metadata.runId, g.metadata.memberId)
    await expect(another.observe(g.metadata.memberId)).rejects.toThrow('member-not-current')
  } finally { another.close(); g.db.close() }
})

test('root selector refuses a fabricated peer or stale Owner incarnation before effects', async () => {
  const f = await fixture()
  try {
    await expect(HostedRootSandboxMemberComposition.create({ ...f.pins,
      memberIds: [f.metadata.memberId, `member_${'a'.repeat(32)}`] }))
      .rejects.toThrow('member-unbound')
    await expect(HostedRootSandboxMemberComposition.create({ ...f.pins,
      ownerGeneration: f.pins.ownerGeneration + 1 }))
      .rejects.toThrow('reservation-invalid')
    await expect(HostedRootSandboxMemberComposition.create({ ...f.pins,
      sandboxWorkspaceRoot: '/real/user-project' }))
      .rejects.toThrow('pins-invalid')
  } finally { f.db.close() }
})
