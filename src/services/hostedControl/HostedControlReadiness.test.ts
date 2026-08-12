import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { createHostedDomainProof, createHostedRawDomainProof } from './ownerProof.js'
import {
  decodeHostedReadinessRequest,
  HOSTED_LIFECYCLE_PROOF_DOMAIN,
} from './HostedControlServer.js'
import type { HostedControlOwnerBinding, HostedControlStableAuthority } from './protocol.js'

const secret = Buffer.alloc(32, 9)
const authority: HostedControlStableAuthority = {
  deploymentId: 'deployment-a', bootId: 'boot-a', restoreGeneration: 3,
  workspaceId: 'workspace-a', teamId: `team_${'a'.repeat(32)}`,
  mountBinding: { mountGeneration: 4, declaredRootHash: 'b'.repeat(64) },
}
const ownerBinding: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_readiness', ownerGeneration: 5,
  ownerSessionId: 'owner-session_readiness',
  socketIdentity: { device: '10', inode: '20', uid: 1000, gid: 1000, mode: 0o600 },
}

describe('hosted readiness codec', () => {
  test('authenticates canonical controller bytes and binds bootstrap, owner, and mount', () => {
    const bootstrapBinding = {
      deploymentId: authority.deploymentId, bootId: authority.bootId,
      workspaceId: authority.workspaceId, mountGeneration: authority.mountBinding.mountGeneration,
      bootstrapDigest: 'c'.repeat(64), ownerArtifactDigest: `sha256:${'d'.repeat(64)}`,
      proofKeyId: createHash('sha256').update(secret).digest('hex'),
    }
    const unsigned = {
      schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command',
      socketIdentity: ownerBinding.socketIdentity, challenge: 'e'.repeat(64),
      bootstrapBinding, expectedOwnerBinding: ownerBinding,
    }
    const serialized = JSON.stringify(unsigned)
    const controllerProof = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized)
    const line = `${serialized.slice(0, -1)},"controllerProof":"${controllerProof}"}`
    const message = JSON.parse(line) as Record<string, unknown>
    expect(decodeHostedReadinessRequest({ secret, authority, ownerBinding, line, message })).toEqual({
      protocol: 'canonical', challenge: unsigned.challenge, bootstrapDigest: bootstrapBinding.bootstrapDigest,
    })

    for (const changed of [
      { ...unsigned, expectedOwnerBinding: { ...ownerBinding, ownerGeneration: 6 } },
      { ...unsigned, bootstrapBinding: { ...bootstrapBinding, mountGeneration: 5 } },
      { ...unsigned, bootstrapBinding: { ...bootstrapBinding, proofKeyId: '0'.repeat(64) } },
    ]) {
      const changedSerialized = JSON.stringify(changed)
      const changedProof = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', changedSerialized)
      const changedLine = `${changedSerialized.slice(0, -1)},"controllerProof":"${changedProof}"}`
      expect(() => decodeHostedReadinessRequest({
        secret, authority, ownerBinding, line: changedLine,
        message: JSON.parse(changedLine) as Record<string, unknown>,
      })).toThrow()
    }
  })

  test('rejects noncanonical controller frames and preserves the authenticated legacy handshake', () => {
    const canonicalUnsigned = {
      schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command',
      socketIdentity: ownerBinding.socketIdentity, challenge: 'f'.repeat(64),
      bootstrapBinding: {
        deploymentId: authority.deploymentId, bootId: authority.bootId,
        workspaceId: authority.workspaceId, mountGeneration: authority.mountBinding.mountGeneration,
        bootstrapDigest: '1'.repeat(64), ownerArtifactDigest: `sha256:${'2'.repeat(64)}`,
        proofKeyId: createHash('sha256').update(secret).digest('hex'),
      },
      expectedOwnerBinding: ownerBinding,
    }
    const serialized = JSON.stringify(canonicalUnsigned)
    const proof = createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', serialized)
    const noncanonical = `{ ${serialized.slice(1, -1)},"controllerProof":"${proof}"}`
    expect(() => decodeHostedReadinessRequest({
      secret, authority, ownerBinding, line: noncanonical,
      message: JSON.parse(noncanonical) as Record<string, unknown>,
    })).toThrow('canonical')

    const legacyUnsigned = {
      schemaVersion: 2, operation: 'readiness', capability: 'hosted-lifecycle-command',
      socketIdentity: ownerBinding.socketIdentity, challenge: '3'.repeat(64),
    }
    const legacy = {
      ...legacyUnsigned,
      ownerProof: createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'readiness-request', legacyUnsigned),
    }
    const legacyLine = JSON.stringify(legacy)
    expect(decodeHostedReadinessRequest({ secret, authority, ownerBinding, line: legacyLine, message: legacy })).toEqual({
      protocol: 'legacy', challenge: legacyUnsigned.challenge,
    })
  })
})
