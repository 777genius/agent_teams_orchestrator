import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { OpenCodeLaunchMutationLedger, type OpenCodeLaunchMutationIdentity } from './OpenCodeLaunchMutationLedger.js'
import { OpenCodeLaunchFileJournalPersistence } from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import { normalizeOpenCodeLogicalMemberIdentity } from './OpenCodeLogicalMemberKey.js'

const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
const memberIdentity = oid('1')
const logicalMember = { teamId: 'team', laneId: 'primary', projectIdentity: '/fake/project', memberName: 'alice' }
const target = OpenCodeLaunchMutationLedger.targetDigest({
  ...logicalMember,
})
const identity = (attemptId: string, claimToken: string): OpenCodeLaunchMutationIdentity => ({
  attemptId, payloadHash: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
  immutableDigest: 'c'.repeat(64),
  generation: 1, fence: 1, acquisitionToken: `acquisition-${claimToken}`,
  claimToken, memberIdentity, logicalMember,
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
      expect(paths).toEqual([
        join(directory, '.logical-member-index-v2'),
        join(directory, '.logical-member-index-v2'),
        join(directory, `${target}.claim`),
      ])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rejects member and project identity substitutions before claim publication', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-binding-'))
    try {
      const ledger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      for (const substituted of [
        { ...logicalMember, memberName: 'bob' },
        { ...logicalMember, projectIdentity: '/fake/foreign' },
      ]) {
        await expect(ledger.claim(target, { ...identity(
          '123e4567-e89b-42d3-a456-426614174010', 'claim-substituted'),
        logicalMember: substituted }, context())).rejects.toThrow(
          'OpenCode launch mutation logical member claim mismatch')
      }
      expect(await ledger.read(target, context())).toBeNull()
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

  test('distinct valid envelope identities normalize to one claim and exactly one provisioning effect', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-logical-race-'))
    try {
      const firstLedger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const secondLedger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const firstEnvelope = { ...logicalMember, memberName: 'Alice', projectIdentity: '/fake/project' }
      const secondEnvelope = { ...logicalMember, memberName: ' alice ', projectIdentity: '/fake/other/../project' }
      const firstLogical = normalizeOpenCodeLogicalMemberIdentity(firstEnvelope)
      const secondLogical = normalizeOpenCodeLogicalMemberIdentity(secondEnvelope)
      const firstTarget = OpenCodeLaunchMutationLedger.targetDigest(firstEnvelope)
      const secondTarget = OpenCodeLaunchMutationLedger.targetDigest(secondEnvelope)
      expect(secondTarget).toBe(firstTarget)
      let provisioningEffects = 0
      const contend = async (ledger: OpenCodeLaunchMutationLedger, authority: OpenCodeLaunchMutationIdentity) => {
        const outcome = await ledger.claim(firstTarget, authority, context())
        if (outcome === 'claimed') provisioningEffects += 1
        return outcome
      }
      const outcomes = await Promise.all([
        contend(firstLedger, { ...identity('123e4567-e89b-42d3-a456-426614174011', 'claim-one'),
          memberIdentity: oid('8'), logicalMember: firstLogical }),
        contend(secondLedger, { ...identity('123e4567-e89b-42d3-a456-426614174012', 'claim-two'),
          memberIdentity: oid('9'), logicalMember: secondLogical }),
      ])
      expect(outcomes.filter(outcome => outcome === 'claimed')).toHaveLength(1)
      expect(outcomes.filter(outcome => outcome === 'reconciliation_required')).toHaveLength(1)
      expect(provisioningEffects).toBe(1)
      // A final authority read is also the deterministic physical-settlement
      // barrier before the disposable namespace is removed.
      expect(await firstLedger.read(firstTarget, context())).not.toBeNull()
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

  test('proven no-effect reconciliation is reclaimable by the exact generation or its continuation only', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-claim-known-'))
    try {
      const ledger = new OpenCodeLaunchMutationLedger(join(root, 'claims'))
      const first = identity('123e4567-e89b-42d3-a456-426614174001', 'claim-a')
      expect(await ledger.claim(target, first, context())).toBe('claimed')
      expect(await ledger.transition(target, first, 'known_failure', undefined, context())).toBe('cancelled')
      const resumed = { ...first, acquisitionToken: 'acquisition-claim-resumed', claimToken: 'claim-resumed' }
      expect(await ledger.claim(target, { ...resumed, inputDigest: 'e'.repeat(64) }, context()))
        .toBe('reconciliation_required')
      expect(await ledger.claim(target, resumed, context())).toBe('claimed')
      expect(await ledger.transition(target, resumed, 'known_failure', undefined, context())).toBe('cancelled')
      const next = { ...identity(first.attemptId, 'claim-b'), inputDigest: 'd'.repeat(64),
        generation: 2, fence: 2 }
      expect(await ledger.claim(target, { ...next, generation: 3, fence: 3 }, context()))
        .toBe('reconciliation_required')
      expect(await ledger.claim(target, { ...next, immutableDigest: 'e'.repeat(64) }, context()))
        .toBe('reconciliation_required')
      expect(await ledger.claim(target, next, context())).toBe('claimed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('migrates exact predecessor claimed fixture and fences crash/restart with a distinct claim identity', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-legacy-claimed-'))
    const directory = join(root, 'claims')
    try {
      const legacy = await writePredecessorFixture(directory, 'claimed', oid('8'))
      const contender = { ...identity('123e4567-e89b-42d3-a456-426614174021', 'claim-new'),
        memberIdentity: oid('9') }
      const firstRestart = new OpenCodeLaunchMutationLedger(directory)
      expect(await firstRestart.claim(target, contender, context())).toBe('reconciliation_required')
      await expect(firstRestart.read(target, context())).rejects.toThrow(
        'unresolved predecessor launch mutation authority requires reconciliation')
      const secondRestart = new OpenCodeLaunchMutationLedger(directory)
      expect(await secondRestart.claim(target, contender, context())).toBe('reconciliation_required')
      expect(legacy.targetDigest).not.toBe(target)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('a predecessor claim appearing after an initial scan is indexed under lock before a new claim', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-legacy-late-'))
    const directory = join(root, 'claims')
    try {
      const ledger = new OpenCodeLaunchMutationLedger(directory)
      expect(await ledger.read(target, context())).toBeNull()
      await writePredecessorBytes(directory, 'f'.repeat(64), new TextEncoder().encode('{broken'))
      expect(await ledger.claim(target, identity(
        '123e4567-e89b-42d3-a456-426614174025', 'claim-after-scan'), context()))
        .toBe('reconciliation_required')
      await expect(ledger.read(target, context())).rejects.toThrow(
        'unresolved predecessor launch mutation authority requires reconciliation')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('migrates exact predecessor claimed and unknown fixtures for the matching old claim identity', async () => {
    for (const state of ['claimed', 'unknown'] as const) {
      const root = await mkdtemp(join(process.cwd(), `src/services/opencode/.launch-legacy-${state}-`))
      const directory = join(root, 'claims')
      try {
        const legacy = await writePredecessorFixture(directory, state, memberIdentity)
        const ledger = new OpenCodeLaunchMutationLedger(directory)
        const result = await ledger.claim(target, identity(
          '123e4567-e89b-42d3-a456-426614174022', 'claim-current'), context())
        expect(result).toBe(state === 'unknown' ? 'unknown' : 'reconciliation_required')
        expect(await ledger.read(target, context())).toMatchObject({
          version: 2, targetDigest: target, legacyTargetDigest: legacy.targetDigest, state,
        })
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })

  test('reconciles exact predecessor committed fixture by recovery metadata for a distinct current claim identity', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-legacy-committed-'))
    const directory = join(root, 'claims')
    try {
      const legacy = await writePredecessorFixture(directory, 'committed', oid('8'))
      const ledger = new OpenCodeLaunchMutationLedger(directory)
      const contender = { ...identity('123e4567-e89b-42d3-a456-426614174023', 'claim-current'),
        memberIdentity: oid('9') }
      expect(await ledger.claim(target, contender, context())).toBe('already_committed')
      expect(await ledger.read(target, context())).toMatchObject({
        version: 2, targetDigest: target, legacyTargetDigest: legacy.targetDigest,
        idempotencyIdentity: legacy.idempotencyIdentity, state: 'committed',
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('migrated predecessor known failure preserves exact-authority retry semantics', async () => {
    const root = await mkdtemp(join(process.cwd(), 'src/services/opencode/.launch-legacy-known-failure-'))
    const directory = join(root, 'claims')
    try {
      const legacy = await writePredecessorFixture(directory, 'known_failure', memberIdentity)
      const ledger = new OpenCodeLaunchMutationLedger(directory)
      const retry = { ...identity(legacy.attemptId, 'claim-retry'), payloadHash: legacy.payloadHash,
        inputDigest: legacy.inputDigest, immutableDigest: legacy.immutableDigest }
      expect(await ledger.claim(target, retry, context())).toBe('claimed')
      expect(await ledger.read(target, context())).toMatchObject({
        version: 2, state: 'claimed', legacyTargetDigest: legacy.targetDigest,
        claimToken: 'claim-retry',
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('corrupt and unclassifiable exact predecessor fixtures remain durable global fences', async () => {
    for (const fixture of ['corrupt', 'committed-without-recovery'] as const) {
      const root = await mkdtemp(join(process.cwd(), `src/services/opencode/.launch-legacy-${fixture}-`))
      const directory = join(root, 'claims')
      try {
        if (fixture === 'corrupt') {
          await writePredecessorBytes(directory, 'f'.repeat(64), new TextEncoder().encode('{broken'))
        } else {
          const bob = { ...logicalMember, memberName: 'bob' }
          const legacyIdentity = oid('8')
          await writePredecessorFixture(directory, 'committed', legacyIdentity, false, bob)
        }
        const ledger = new OpenCodeLaunchMutationLedger(directory)
        expect(await ledger.claim(target, { ...identity(
          '123e4567-e89b-42d3-a456-426614174024', 'claim-current'), memberIdentity: oid('9') }, context()))
          .toBe('reconciliation_required')
        await expect(ledger.read(target, context())).rejects.toThrow(
          'unresolved predecessor launch mutation authority requires reconciliation')
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
})

async function writePredecessorFixture(directory: string,
  state: 'claimed' | 'known_failure' | 'unknown' | 'committed', legacyMemberIdentity: OpenCodeOpaqueIdentity,
  includeRecovery = true, digestLogicalMember = logicalMember) {
  const targetDigest = createHash('sha256').update(JSON.stringify({ teamId: digestLogicalMember.teamId,
    laneId: digestLogicalMember.laneId, projectIdentity: digestLogicalMember.projectIdentity,
    memberIdentity: legacyMemberIdentity })).digest('hex')
  const idempotencyIdentity = `ses_${targetDigest.slice(0, 26)}`
  const legacyLinkage = { ...linkage, memberIdentity: legacyMemberIdentity }
  const legacyRecovery = { ...recovery, sessionRecord: { ...recovery.sessionRecord,
    opencodeSessionId: idempotencyIdentity } }
  const record = {
    version: 1 as const, targetDigest, idempotencyIdentity, state,
    attemptId: '123e4567-e89b-42d3-a456-426614174020', payloadHash: 'a'.repeat(64),
    inputDigest: 'b'.repeat(64), immutableDigest: 'c'.repeat(64), generation: 1, fence: 1,
    acquisitionToken: 'acquisition-legacy', claimToken: 'claim-legacy',
    memberIdentity: legacyMemberIdentity,
    ...(state === 'committed' ? { linkage: legacyLinkage,
      ...(includeRecovery ? { recovery: legacyRecovery } : {}) } : {}),
  }
  await writePredecessorBytes(directory, targetDigest,
    new TextEncoder().encode(JSON.stringify(record)))
  return record
}

async function writePredecessorBytes(directory: string, targetDigest: string, bytes: Uint8Array): Promise<void> {
  const persistence = new OpenCodeLaunchFileJournalPersistence(join(directory, `${targetDigest}.claim`))
  const fixtureContext = context()
  const release = await persistence.acquireExclusive(fixtureContext)
  try { await persistence.replaceAndSync(bytes, fixtureContext) } finally { await release(fixtureContext) }
}
