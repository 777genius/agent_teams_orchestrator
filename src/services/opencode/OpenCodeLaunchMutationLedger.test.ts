import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { OpenCodeLaunchMutationLedger, type OpenCodeLaunchMutationIdentity } from './OpenCodeLaunchMutationLedger.js'
import { OpenCodeLaunchFileJournalPersistence } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
const memberIdentity = oid('1')
const target = OpenCodeLaunchMutationLedger.targetDigest({
  teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberIdentity,
})
const identity = (attemptId: string, claimToken: string): OpenCodeLaunchMutationIdentity => ({
  attemptId, payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
  immutableDigest: 'c'.repeat(64),
  generation: 1, fence: 1, acquisitionToken: `acquisition-${claimToken}`,
  claimToken, memberIdentity,
})
const context = () => ({
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
  monotonicNow: Date.now,
})
const linkage: OpenCodeLaunchMemberLinkage = {
  memberIdentity, sessionIdentity: oid('2'), bootstrapMessageIdentity: oid('3'), commitIdentity: oid('4'),
}
const recovery = {
  ownershipTitle: 'agent-teams-launch:owned',
  sessionRecord: {
    teamId: 'team', laneId: 'primary', memberName: 'alice', providerId: 'opencode' as const,
    selectedModel: 'openrouter/model', projectPath: '/fake/project', profileRootKey: 'profile', hostKey: 'host',
    resolvedBehaviorFingerprint: null, opencodeSessionId: OpenCodeLaunchMutationLedger.idempotencyIdentity(target),
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
    sourceAuthFingerprint: null, managedAuthFingerprint: null, projectBehaviorFingerprint: 'behavior',
    appManagedBootstrap: { schemaVersion: 1 as const, messageID: 'msg', contextHash: 'a'.repeat(64),
      briefingHash: 'b'.repeat(64), injectionVerifiedAt: new Date(0).toISOString(),
      model: 'openrouter/model', agent: 'teammate-bootstrap' },
    staleReason: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  },
}

describe('OpenCodeLaunchMutationLedger', () => {
  test('fresh install securely creates its namespace and permits the first durable claim', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-fresh-'))
    const directory = join(root, 'new', 'member-claims')
    try {
      const ledger = new OpenCodeLaunchMutationLedger(directory)
      expect(await ledger.claim(target, identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a'), context())).toBe('claimed')
      expect((await ledger.read(target, context()))?.idempotencyIdentity)
        .toBe(OpenCodeLaunchMutationLedger.idempotencyIdentity(target))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('routes every global claim through the supplied attempt-authority persistence factory', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-authority-'))
    const directory = join(root, 'member-claims')
    const paths: string[] = []
    try {
      const ledger = new OpenCodeLaunchMutationLedger(directory, filePath => {
        paths.push(filePath)
        return new OpenCodeLaunchFileJournalPersistence(filePath)
      })
      await ledger.read(target, context())
      expect(paths).toEqual([join(directory, `${target}.claim`)])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('two concurrent attempt journals cannot both own the same member mutation', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-race-'))
    try {
      const first = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const second = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const outcomes = await Promise.all([
        first.claim(target, identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a'), context()),
        second.claim(target, identity('123e4567-e89b-42d3-a456-426614174002', 'claim-b'), context()),
      ])
      expect(outcomes.filter(outcome => outcome === 'claimed')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome === 'reconciliation_required')).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('crash after remote creation preserves one reconciliation identity and never reclaims', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-crash-'))
    try {
      const first = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      expect(await first.claim(target, identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a'), context())).toBe('claimed')
      const durable = await first.read(target, context())
      expect(durable?.idempotencyIdentity).toBe(`ses_${target.slice(0, 26)}`)

      const afterCrash = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      expect(await afterCrash.claim(target, identity('123e4567-e89b-42d3-a456-426614174002', 'claim-b'), context()))
        .toBe('reconciliation_required')
      expect(await afterCrash.transition(target, identity('123e4567-e89b-42d3-a456-426614174002', 'claim-b'), 'commit', linkage, context(), recovery))
        .toBe('fenced')
      expect(await first.transition(target, identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a'), 'commit', linkage, context(), recovery))
        .toBe('committed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('an uncertain claim is tombstoned and cannot be automatically resent', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-unknown-'))
    try {
      const ledger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const owner = identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a')
      expect(await ledger.claim(target, owner, context())).toBe('claimed')
      expect(await ledger.transition(target, owner, 'unknown', undefined, context())).toBe('cancelled')
      expect(await ledger.claim(target, identity('123e4567-e89b-42d3-a456-426614174002', 'claim-b'), context())).toBe('unknown')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('known no-effect failure is reclaimable only by exact immutable authority at the next generation', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-known-'))
    try {
      const ledger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const first = identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a')
      expect(await ledger.claim(target, first, context())).toBe('claimed')
      expect(await ledger.transition(target, first, 'known_failure', undefined, context())).toBe('cancelled')
      const next = { ...identity(first.attemptId, 'claim-b'), inputDigest: 'd'.repeat(64),
        generation: 2, fence: 2 }
      expect(await ledger.claim(target, { ...next, generation: 3, fence: 3 }, context()))
        .toBe('reconciliation_required')
      expect(await ledger.claim(target, { ...next, immutableDigest: 'e'.repeat(64) }, context()))
        .toBe('reconciliation_required')
      expect(await ledger.claim(target, next, context())).toBe('claimed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
