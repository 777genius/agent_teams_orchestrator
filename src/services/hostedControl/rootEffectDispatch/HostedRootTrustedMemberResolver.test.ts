import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'

import type { HostedMemberNetworkRequest } from '../containerNetworkProvisioning/HostedMemberNetworkProvisioner.js'
import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { HostedRootTrustedMemberResolver } from './HostedRootTrustedMemberResolver.js'

const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const operationId = `start_${createHash('sha256').update('agent-teams.hosted-opencode-member-start/v1\0' +
  JSON.stringify([binding.runId, binding.memberId, binding.planSha256])).digest('hex')}`
const request: HostedMemberNetworkRequest = { operationId, planTeamId: binding.teamId,
  planFingerprint: binding.planSha256, runId: binding.runId, teamId: binding.teamId,
  laneId: binding.laneId, memberId: binding.memberId }
const ownerChannel = { socketPath: `/tmp/hosted-owner/fd3-${'8'.repeat(32)}.sock`, challenge: '9'.repeat(64) }

function fixture() {
  let current = true
  let incarnation = true
  let decisions = 0
  let connectorTicks = '12345'
  const product = { async withCurrentMemberDecision<T>(_binding: HostedProductMemberBinding,
    _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (row: HostedProductCurrentMember) => T): Promise<T> {
    decisions++
    if (!current) throw new Error('product-member-revoked')
    return callback({ ...binding, admittedWorkspaceRoot: '/sandbox/member-fixture',
      bootId: 'boot_fixture1234' } as HostedProductCurrentMember)
  } }
  const authority = new HostedRootSingleMemberAuthority(product, {
    binding, workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234', ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234',
  }, row => incarnation ? { runId: row.runId, bootId: row.bootId, ownerGeneration: 1,
    ownerSessionId: 'owner-session_fixture1234', state: 'active' } : null)
  const pins = { managedRequest: request, leaseId: 'lease_12345678', ownerChannel,
    ownerSocketDirectory: '/tmp/hosted-owner' }
  const resolver = new HostedRootTrustedMemberResolver(authority, pins,
    () => ({ pid: 123, startTicks: connectorTicks }))
  return { resolver, authority, pins, revoke: () => { current = false },
    retire: () => { incarnation = false }, setTicks: (ticks: string) => { connectorTicks = ticks },
    decisions: () => decisions }
}

test('prepare and start each recheck the current Product member and Owner incarnation', async () => {
  const f = fixture()
  const prepared = await f.resolver.resolveCurrent(operationId, 'prepare')
  expect(prepared).toEqual({ request: { operationId, leaseId: f.pins.leaseId,
    runId: binding.runId, teamId: binding.teamId, laneId: binding.laneId,
    memberId: binding.memberId, ownerChannel }, connector: { pid: 123, startTicks: '12345' } })
  f.revoke()
  await expect(f.resolver.resolveCurrent(operationId, 'start')).rejects.toThrow('product-member-revoked')
  expect(f.decisions()).toBe(2)

  const retired = fixture()
  await retired.resolver.resolveCurrent(operationId, 'prepare')
  retired.retire()
  await expect(retired.resolver.resolveCurrent(operationId, 'start')).rejects.toThrow('incarnation-denied')
})

test('different operation or pending FD3 target is rejected before a Product decision', async () => {
  const f = fixture()
  await expect(f.resolver.resolveCurrent(`start_${'a'.repeat(64)}`, 'prepare'))
    .rejects.toThrow('selector-denied')
  expect(f.decisions()).toBe(0)
  expect(() => new HostedRootTrustedMemberResolver(f.authority, { ...f.pins,
    ownerChannel: { ...ownerChannel, socketPath: '/tmp/other/fd3-' + '8'.repeat(32) + '.sock' } },
  () => ({ pid: 123, startTicks: '12345' }))).toThrow('pins-invalid')
  expect(() => new HostedRootTrustedMemberResolver(f.authority, { ...f.pins,
    managedRequest: { ...request, planFingerprint: 'a'.repeat(64) } },
  () => ({ pid: 123, startTicks: '12345' }))).toThrow('selector-denied')
})

test('invalid root connector proof is rejected under the Product decision', async () => {
  const f = fixture()
  f.setTicks('changed')
  await expect(f.resolver.resolveCurrent(operationId, 'prepare')).rejects.toThrow('current-invalid')
  expect(f.decisions()).toBe(1)
})
