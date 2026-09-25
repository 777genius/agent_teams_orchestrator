import { describe, expect, test } from 'bun:test'

import { decodeHostedLifecycleRunReservation } from './HostedLifecycleRunReservation.js'
import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import type { HostedControlOwnerBinding } from './protocol.js'

const authority: HostedLifecycleAuthority = {
  actorId: 'actor_test-actor', workspaceId: `workspace_${'1'.repeat(32)}`,
  teamId: `team_${'2'.repeat(32)}`, deploymentId: 'deployment_test-deployment',
  bootId: 'boot_test-boot', restoreGeneration: 3, mountGeneration: 4,
  resourceRevision: null,
  ownerEffectFence: { grantRevision: 'a'.repeat(64), identityChecksum: 'b'.repeat(64) },
}
const owner: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_test-owner', ownerGeneration: 5,
  ownerSessionId: 'owner-session_test-session',
  socketIdentity: { device: '1', inode: '2', uid: 1000, gid: 1000, mode: 0o600 },
}
const command = {
  commandId: 'lifecycle-command_test-launch', idempotencyKey: 'idempotency_test-launch',
  expectedRevision: `revision_${'c'.repeat(64)}`,
}
const receipt = {
  schemaVersion: 1, workspaceId: `workspace_${'3'.repeat(32)}`,
  runtimeWorkspaceId: authority.workspaceId, teamId: authority.teamId,
  actorId: authority.actorId, deploymentId: authority.deploymentId, bootId: authority.bootId,
  ...command, expectedPlanGeneration: `plan-generation_${'d'.repeat(64)}`,
  ownerAuthority: owner.ownerAuthority, ownerGeneration: owner.ownerGeneration,
  ownerSessionId: owner.ownerSessionId,
  restoreGeneration: authority.restoreGeneration, mountGeneration: authority.mountGeneration,
  ownerEffectFence: authority.ownerEffectFence,
  authorityEvidence: { userId: 'user_test-user', sessionId: 'session_test-user', grantGeneration: 3 },
  runId: `run_${'e'.repeat(32)}`, promotionOperationId: `promotion_${'f'.repeat(32)}`,
  planSha256: 'd'.repeat(64), rosterBindingSha256: '9'.repeat(64), createdAtMs: 1000,
}

describe('hosted lifecycle Product run reservation', () => {
  test('accepts the exact Product receipt and rejects scope, owner, or plan substitution', () => {
    expect(decodeHostedLifecycleRunReservation(receipt, command, authority, owner).runId).toBe(receipt.runId)
    for (const changed of [
      { ...receipt, actorId: 'actor_other-actor' },
      { ...receipt, runtimeWorkspaceId: `workspace_${'4'.repeat(32)}` },
      { ...receipt, ownerSessionId: 'owner-session_other-session' },
      { ...receipt, expectedRevision: `revision_${'0'.repeat(64)}` },
      { ...receipt, planSha256: '0'.repeat(64) },
      { ...receipt, authorityEvidence: { ...receipt.authorityEvidence, grantGeneration: 2 } },
    ]) {
      expect(() => decodeHostedLifecycleRunReservation(changed, command, authority, owner)).toThrow()
    }
  })
})
