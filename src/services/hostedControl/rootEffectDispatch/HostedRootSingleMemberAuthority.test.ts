import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'

import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import { HostedProductCurrentMemberDecision, type HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority, type HostedRootSingleMemberPins } from
  './HostedRootSingleMemberAuthority.js'

const FIXTURES = path.join(import.meta.dir, '../productAuthority/fixtures')
const START_DOMAIN = 'agent-teams.hosted-opencode-member-start/v1\0'

type Fixture = { directory: string; db: Database; decision: HostedProductCurrentMemberDecision;
  authority: HostedRootSingleMemberAuthority; binding: HostedProductMemberBinding;
  pins: HostedRootSingleMemberPins; request: HostedMemberNetworkRequest }

async function fixture(sandboxWorkspaceRoot?: string): Promise<Fixture> {
  const directory = await realpath(await mkdtemp('/tmp/hosted-root-single-member-'))
  await chmod(directory, 0o700)
  const databasePath = path.join(directory, 'product.sqlite')
  const bytes = await readFile(path.join(FIXTURES, 'product-v35-current-member.sqlite.gz'))
  await writeFile(databasePath, gunzipSync(bytes), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(FIXTURES,
    'product-v35-current-member.metadata.json'), 'utf8')) as {
      now: number; expectedName: string; runId: string; memberId: string; runtimeWorkspaceId: string;
      binding: { deploymentId: string; bootId: string; ownerGeneration: number;
        ownerSessionId: string; restoreGeneration: number; mountGeneration: number }
    }
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reservation = JSON.parse((db.query('SELECT record_json FROM hosted_lifecycle_run_reservations WHERE run_id = ?')
    .get(metadata.runId) as { record_json: string }).record_json) as {
      teamId: string; promotionOperationId: string; planSha256: string; rosterBindingSha256: string }
  const roster = JSON.parse((db.query('SELECT binding_json FROM hosted_promotion_roster_bindings WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { binding_json: string }).binding_json) as {
      lanes: Array<{ laneId: string; members: Array<{ memberId: string }> }> }
  const lane = roster.lanes.find(entry => entry.members.some(member => member.memberId === metadata.memberId))
  if (!lane) throw new Error('fixture-member-missing')
  const binding: HostedProductMemberBinding = { runId: metadata.runId, memberId: metadata.memberId,
    teamId: reservation.teamId, laneId: lane.laneId, deploymentId: metadata.binding.deploymentId,
    runtimeWorkspaceId: metadata.runtimeWorkspaceId, planSha256: reservation.planSha256,
    rosterBindingSha256: reservation.rosterBindingSha256,
    restoreGeneration: metadata.binding.restoreGeneration,
    mountGeneration: metadata.binding.mountGeneration }
  const decision = await HostedProductCurrentMemberDecision.create({ databasePath,
    expectedUid: process.getuid!(), now: () => metadata.now, testOnlyAllowNonRoot: true })
  const admittedWorkspaceRoot = await decision.withCurrentMemberDecision(binding, 'observe',
    current => current.admittedWorkspaceRoot)
  const pinnedWorkspaceRoot = sandboxWorkspaceRoot ?? admittedWorkspaceRoot
  const pins = { binding, workspaceParent: path.dirname(pinnedWorkspaceRoot),
    sandboxWorkspaceRoot: pinnedWorkspaceRoot, bootId: metadata.binding.bootId,
    ownerGeneration: metadata.binding.ownerGeneration,
    ownerSessionId: metadata.binding.ownerSessionId }
  const authority = new HostedRootSingleMemberAuthority(decision, pins, current => ({
    runId: current.runId, bootId: metadata.binding.bootId,
    ownerGeneration: metadata.binding.ownerGeneration,
    ownerSessionId: metadata.binding.ownerSessionId, state: 'active',
  }))
  const operationId = `start_${createHash('sha256').update(START_DOMAIN +
    JSON.stringify([binding.runId, binding.memberId, binding.planSha256])).digest('hex')}`
  const request: HostedMemberNetworkRequest = { operationId, planTeamId: binding.teamId,
    planFingerprint: binding.planSha256, runId: binding.runId, teamId: binding.teamId,
    laneId: binding.laneId, memberId: binding.memberId }
  return { directory, db, decision, authority, binding, pins, request }
}

async function close(f: Fixture): Promise<void> {
  f.decision.close()
  f.db.close()
  await rm(f.directory, { recursive: true, force: true })
}

test('one root-owned sandbox member binds the canonical Product plan and one managed selector', async () => {
  const f = await fixture()
  try {
    expect(f.authority.matchesManagedRequest(f.request)).toBe(true)
    expect(await f.authority.assertCurrent()).toBe(true)
    expect(await f.authority.withCurrentMemberDecision(f.binding, 'start', current =>
      [current.memberName, current.admittedWorkspaceRoot])).toEqual(['builder', f.pins.sandboxWorkspaceRoot])
    for (const request of [
      { ...f.request, operationId: `start_${'a'.repeat(64)}` },
      { ...f.request, planFingerprint: 'a'.repeat(64) },
      { ...f.request, planTeamId: `team_${'a'.repeat(32)}` },
      { ...f.request, memberId: `member_${'a'.repeat(32)}` },
    ]) expect(f.authority.matchesManagedRequest(request)).toBe(false)
    await expect(f.authority.withCurrentMemberDecision({ ...f.binding,
      mountGeneration: f.binding.mountGeneration + 1 }, 'start', () => true))
      .rejects.toThrow('binding-denied')
  } finally { await close(f) }
})

test('Product revocation or different admitted workspace prevents the callback', async () => {
  const f = await fixture()
  try {
    f.db.query("UPDATE operator_sessions SET status = 'revoked'").run()
    let called = false
    await expect(f.authority.withCurrentMemberDecision(f.binding, 'start', () => {
      called = true
      return true
    })).rejects.toThrow('member-not-current')
    expect(called).toBe(false)
  } finally { await close(f) }
  const g = await fixture('/sandbox/different-member')
  try {
    let called = false
    await expect(g.authority.withCurrentMemberDecision(g.binding, 'prepare', () => {
      called = true
      return true
    })).rejects.toThrow('sandbox-denied')
    expect(called).toBe(false)
  } finally { await close(g) }
})

test('single-member root pins refuse roots outside the configured sandbox parent', async () => {
  const f = await fixture()
  try {
    expect(() => new HostedRootSingleMemberAuthority(f.decision, { binding: f.binding,
      workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/real/user-project',
      bootId: 'boot_fixture', ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234' },
    () => null))
      .toThrow('pins-invalid')
    expect(() => new HostedRootSingleMemberAuthority(f.decision, { binding: f.binding,
      workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/../real',
      bootId: 'boot_fixture', ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234' },
    () => null))
      .toThrow('pins-invalid')
  } finally { await close(f) }
})

test('historical Product reservation alone cannot authorize a retired Owner incarnation', async () => {
  const f = await fixture()
  try {
    let callbackRan = false
    const retired = new HostedRootSingleMemberAuthority(f.decision, f.pins, current => ({
      runId: current.runId, bootId: f.pins.bootId, ownerGeneration: f.pins.ownerGeneration + 1,
      ownerSessionId: f.pins.ownerSessionId, state: 'active',
    }))
    await expect(retired.withCurrentMemberDecision(f.binding, 'start', () => {
      callbackRan = true
      return true
    })).rejects.toThrow('incarnation-denied')
    expect(callbackRan).toBe(false)
    const missing = new HostedRootSingleMemberAuthority(f.decision, f.pins, () => null)
    await expect(missing.assertCurrent()).rejects.toThrow('incarnation-denied')
  } finally { await close(f) }
})
