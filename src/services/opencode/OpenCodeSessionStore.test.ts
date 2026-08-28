import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as lockfile from '../../utils/lockfile.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeLogicalMemberKey } from './OpenCodeLogicalMemberKey.js'

const baseRecord = {
  version: 2 as const,
  teamId: 'team-a',
  laneId: 'primary',
  memberName: 'alice',
  providerId: 'opencode' as const,
  selectedModel: 'openai/gpt-5.4',
  projectIdentity: '/tmp/project',
  projectPath: '/tmp/project',
  runId: null,
  profileRootKey: 'profile-root',
  hostKey: 'host-key',
  resolvedBehaviorFingerprint: null,
  opencodeSessionId: 'session-1',
  lastCanonicalCursor: null,
  lastKnownRawStatus: null,
  lastKnownDurableState: null,
  sourceAuthFingerprint: null,
  managedAuthFingerprint: null,
  projectBehaviorFingerprint: 'behavior-v1',
  staleReason: null,
  createdAt: '2026-04-21T00:00:00.000Z',
  updatedAt: '2026-04-21T00:00:00.000Z',
}

function asLegacyRecord(record: typeof baseRecord = baseRecord) {
  const { version: _version, projectIdentity: _projectIdentity, runId: _runId, ...legacy } = record
  return legacy
}

function reservationFor(projectIdentity: string, overrides: Record<string, string> = {}) {
  const logical = { teamId: 'team-a', laneId: 'primary', projectIdentity, memberName: 'alice' }
  return {
    version: 1,
    logicalMemberKey: openCodeLogicalMemberKey(logical),
    ...logical,
    reservationIdentity: 'reservation-a',
    expectedOpencodeSessionId: 'session-1',
    createdAt: '2026-04-21T00:00:00.000Z',
    ...overrides,
  }
}

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-session-store-test-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe('OpenCodeSessionStore', () => {
  test('upserts and reads records', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    expect(await store.upsert(baseRecord)).toBe('created')
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toEqual(baseRecord)
    expect(await store.list()).toEqual([baseRecord])
  })

  test('atomically publishes only one session for a normalized logical member', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    const contender = { ...baseRecord, memberName: 'Alice', projectIdentity: '/tmp/project',
      projectPath: '/tmp/project',
      opencodeSessionId: 'session-2' }
    const outcomes = await Promise.all([
      first.publishIfAbsentOrExact(baseRecord),
      second.publishIfAbsentOrExact(contender),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'inserted')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'conflict')).toHaveLength(1)
    expect(await first.list()).toHaveLength(1)
  })

  test('publishes a successor only over the exact predecessor and retries idempotently', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const predecessor = { ...baseRecord, runId: 'run-old' }
    const successor = { ...baseRecord, opencodeSessionId: 'session-2', runId: 'run-new',
      updatedAt: '2026-04-21T01:00:00.000Z' }
    await store.upsert(predecessor)

    expect(await store.publishSuccessorIfExact(successor, 'session-1', 'run-old'))
      .toEqual({ status: 'replaced', record: successor })
    expect(await store.publishSuccessorIfExact(successor, 'session-1', 'run-old'))
      .toEqual({ status: 'exact', record: successor })
    expect(await store.publishSuccessorIfExact({ ...successor, opencodeSessionId: 'session-3' },
      'session-1', 'run-old')).toEqual({ status: 'conflict', record: successor })
  })

  test('persists and exactly fences every durable successor transition phase across restart', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const predecessor = { ...baseRecord, runId: 'run-old' }
    const attemptIdentity = 'a'.repeat(64)
    const successor = {
      ...baseRecord,
      opencodeSessionId: 'session-2',
      runId: 'run-new',
      updatedAt: '2026-04-21T01:00:00.000Z',
      successorTransition: {
        version: 1 as const,
        attemptIdentity,
        phase: 'successor_lease_pending' as const,
        predecessorHostKey: predecessor.hostKey,
        predecessorOpencodeSessionId: predecessor.opencodeSessionId,
        predecessorRunId: predecessor.runId,
      },
    }
    const first = new OpenCodeSessionStore(filePath)
    await first.upsert(predecessor)
    expect(await first.publishSuccessorIfExact(successor, 'session-1', 'run-old'))
      .toEqual({ status: 'replaced', record: successor })

    const logical = { teamId: successor.teamId, laneId: successor.laneId,
      projectIdentity: successor.projectIdentity, memberName: successor.memberName }
    const restarted = new OpenCodeSessionStore(filePath)
    expect(await restarted.getByLogicalMember(logical)).toEqual(successor)
    const predecessorPending = await restarted.advanceSuccessorTransitionIfExact(
      logical, 'session-2', 'run-new', attemptIdentity,
      'successor_lease_pending', 'predecessor_release_pending')
    expect(predecessorPending).toMatchObject({ status: 'applied', record: {
      successorTransition: { phase: 'predecessor_release_pending' },
    } })
    const complete = await restarted.advanceSuccessorTransitionIfExact(
      logical, 'session-2', 'run-new', attemptIdentity,
      'predecessor_release_pending', 'transition_complete')
    expect(complete).toMatchObject({ status: 'applied', record: {
      successorTransition: { phase: 'transition_complete' },
    } })
    const cleared = await restarted.advanceSuccessorTransitionIfExact(
      logical, 'session-2', 'run-new', attemptIdentity,
      'transition_complete', null)
    expect(cleared).toMatchObject({ status: 'applied' })
    expect(cleared.status === 'applied' && cleared.record.successorTransition).toBeUndefined()
    expect((await new OpenCodeSessionStore(filePath).getByLogicalMember(logical))
      ?.successorTransition).toBeUndefined()
  })

  test('foreign successor owners and attempts cannot advance or clear a transition', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const store = new OpenCodeSessionStore(filePath)
    const transition = {
      version: 1 as const,
      attemptIdentity: 'b'.repeat(64),
      phase: 'transition_complete' as const,
      predecessorHostKey: 'old-host',
      predecessorOpencodeSessionId: 'old-session',
      predecessorRunId: 'old-run',
    }
    const successor = { ...baseRecord, opencodeSessionId: 'session-2', runId: 'run-new',
      successorTransition: transition }
    await store.upsert(successor)
    const logical = { teamId: successor.teamId, laneId: successor.laneId,
      projectIdentity: successor.projectIdentity, memberName: successor.memberName }

    expect((await store.advanceSuccessorTransitionIfExact(logical, 'foreign-session',
      'run-new', transition.attemptIdentity, 'transition_complete', null)).status).toBe('foreign')
    expect((await store.advanceSuccessorTransitionIfExact(logical, 'session-2',
      'run-new', 'c'.repeat(64), 'transition_complete', null)).status).toBe('foreign')
    expect((await store.getByLogicalMember(logical))?.successorTransition).toEqual(transition)
  })

  test('successor publication returns absent and rejects the same deterministic session from another run', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const successor = { ...baseRecord, runId: 'run-new', updatedAt: '2026-04-21T01:00:00.000Z' }
    expect(await store.publishSuccessorIfExact(successor, 'session-1', 'run-old'))
      .toEqual({ status: 'absent' })
    const current = { ...baseRecord, runId: 'run-other' }
    await store.upsert(current)
    expect(await store.publishSuccessorIfExact(successor, 'session-1', 'run-old'))
      .toEqual({ status: 'conflict', record: current })
  })

  test('successor publication is project-isolated', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const projectA = { ...baseRecord, projectIdentity: '/tmp/project-a', projectPath: '/tmp/project-a',
      runId: 'run-a' }
    const projectB = { ...baseRecord, projectIdentity: '/tmp/project-b', projectPath: '/tmp/project-b',
      opencodeSessionId: 'session-b', runId: 'run-b' }
    const successorA = { ...projectA, opencodeSessionId: 'session-a2', runId: 'run-a2',
      updatedAt: '2026-04-21T01:00:00.000Z' }
    await store.upsert(projectA)
    await store.upsert(projectB)

    expect((await store.publishSuccessorIfExact(successorA, 'session-1', 'run-a')).status).toBe('replaced')
    expect(await store.getByLogicalMember({ teamId: projectB.teamId, laneId: projectB.laneId,
      projectIdentity: projectB.projectIdentity, memberName: projectB.memberName })).toEqual(projectB)
  })

  test('concurrent successor replacements cannot overwrite the winner', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    const predecessor = { ...baseRecord, runId: 'run-old' }
    const successorA = { ...predecessor, opencodeSessionId: 'session-a', runId: 'run-a' }
    const successorB = { ...predecessor, opencodeSessionId: 'session-b', runId: 'run-b' }
    await first.upsert(predecessor)
    const outcomes = await Promise.all([
      first.publishSuccessorIfExact(successorA, 'session-1', 'run-old'),
      second.publishSuccessorIfExact(successorB, 'session-1', 'run-old'),
    ])
    expect(outcomes.filter(result => result.status === 'replaced')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'conflict')).toHaveLength(1)
    const persisted = await first.getByLogicalMember({ teamId: baseRecord.teamId, laneId: baseRecord.laneId,
      projectIdentity: baseRecord.projectIdentity, memberName: baseRecord.memberName })
    expect(['session-a', 'session-b']).toContain(persisted?.opencodeSessionId)
  })

  test('successor publication cannot bypass durable reservation authority', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logical = { teamId: baseRecord.teamId, laneId: baseRecord.laneId,
      projectIdentity: baseRecord.projectIdentity, memberName: baseRecord.memberName }
    const reservation = reservationFor(baseRecord.projectIdentity)
    await writeFile(filePath, JSON.stringify({ schemaVersion: 3, records: {
      [openCodeLogicalMemberKey(logical)]: baseRecord,
    }, reservations: { [reservation.logicalMemberKey]: reservation } }))
    const store = new OpenCodeSessionStore(filePath)
    const successor = { ...baseRecord, opencodeSessionId: 'session-2' }

    expect(await store.publishSuccessorIfExact(successor, 'session-1', null)).toEqual({
      status: 'conflict', record: baseRecord, reservation,
    })
    expect(await store.getByLogicalMember(logical)).toEqual(baseRecord)
  })

  test('uses normalized member lookup consistently for legacy Alice versus alice records', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, records: {
      'team-a::primary::Alice': { ...asLegacyRecord(), memberName: 'Alice' },
    } }))
    const store = new OpenCodeSessionStore(filePath)
    expect(await store.get('team-a', 'primary', 'alice')).toMatchObject({ memberName: 'Alice' })
    expect(await store.get('team-a', 'primary', ' ALICE ')).toMatchObject({ memberName: 'Alice' })
  })

  test('atomically reserves normalized logical member before effects and fences a restart contender', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)
    const alice = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'Alice' }
    const normalized = { ...alice, memberName: ' alice ', projectIdentity: '/tmp/other/../project' }
    const outcomes = await Promise.all([
      first.reserveLogicalMember(alice, 'reservation-a', 'session-a'),
      second.reserveLogicalMember(normalized, 'reservation-b', 'session-b'),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'reserved')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'conflict')).toHaveLength(1)
    const winner = outcomes.find(outcome => outcome.status === 'reserved')!
    const restarted = new OpenCodeSessionStore(filePath)
    expect((await restarted.reserveLogicalMember(normalized, 'reservation-c', 'session-c')).status)
      .toBe('conflict')
    expect(await restarted.list()).toEqual([])
    expect(winner.status).toBe('reserved')
  })

  test('crash after remote effect reuses exact reservation and publishes only its exact session', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logical = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'Alice' }
    const beforeCrash = new OpenCodeSessionStore(filePath)
    expect((await beforeCrash.reserveLogicalMember(logical, 'reservation-a', 'session-1')).status).toBe('reserved')
    const restarted = new OpenCodeSessionStore(filePath)
    expect((await restarted.reserveLogicalMember({ ...logical, memberName: 'alice' },
      'reservation-a', 'session-1')).status).toBe('exact')
    expect((await restarted.publishReserved(baseRecord, 'reservation-a')).status).toBe('inserted')
    expect(await restarted.get('team-a', 'primary', 'ALICE')).toEqual(baseRecord)
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion: number;
      reservations: Record<string, unknown> }
    expect(persisted.schemaVersion).toBe(3)
    expect(persisted.reservations).toEqual({})
  })

  test('concurrent projects reserve and publish the same team lane member without overwrite or ABA', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const projectA = { ...baseRecord, projectIdentity: '/tmp/project-a', projectPath: '/tmp/project-a', opencodeSessionId: 'session-a' }
    const projectB = { ...baseRecord, projectIdentity: '/tmp/project-b', projectPath: '/tmp/project-b', opencodeSessionId: 'session-b' }
    const first = new OpenCodeSessionStore(filePath)
    const second = new OpenCodeSessionStore(filePath)

    const reservations = await Promise.all([
      first.reserveLogicalMember({ teamId: projectA.teamId, laneId: projectA.laneId,
        projectIdentity: projectA.projectPath, memberName: projectA.memberName },
      'reservation-a', projectA.opencodeSessionId),
      second.reserveLogicalMember({ teamId: projectB.teamId, laneId: projectB.laneId,
        projectIdentity: projectB.projectPath, memberName: projectB.memberName },
      'reservation-b', projectB.opencodeSessionId),
    ])
    expect(reservations.map(result => result.status)).toEqual(['reserved', 'reserved'])

    const publications = await Promise.all([
      second.publishReserved(projectB, 'reservation-b'),
      first.publishReserved(projectA, 'reservation-a'),
    ])
    expect(publications.map(result => result.status)).toEqual(['inserted', 'inserted'])

    const restarted = new OpenCodeSessionStore(filePath)
    expect(await restarted.list()).toEqual(expect.arrayContaining([projectA, projectB]))
    expect(await restarted.list()).toHaveLength(2)
    expect(await restarted.get(projectA.teamId, projectA.laneId, projectA.memberName)).toBeNull()
    expect(await restarted.getByLogicalMember({ teamId: projectA.teamId, laneId: projectA.laneId,
      projectIdentity: projectA.projectPath, memberName: projectA.memberName })).toEqual(projectA)
    expect(await restarted.getByLogicalMember({ teamId: projectB.teamId, laneId: projectB.laneId,
      projectIdentity: projectB.projectPath, memberName: projectB.memberName })).toEqual(projectB)

    // A delayed cleanup for A must select A by its session fence. It cannot
    // observe B as a replacement or erase B merely because their legacy
    // team/lane/member lookup identity is the same.
    expect(await restarted.deleteIfSessionMatchesLogicalMember({ teamId: projectA.teamId,
      laneId: projectA.laneId, projectIdentity: projectA.projectPath, memberName: projectA.memberName },
    projectA.opencodeSessionId)).toEqual({ status: 'applied', record: projectA })
    expect(await restarted.list()).toEqual([projectB])
    expect(await restarted.deleteIfSessionMatchesLogicalMember({ teamId: projectA.teamId,
      laneId: projectA.laneId, projectIdentity: projectA.projectPath, memberName: projectA.memberName },
    projectA.opencodeSessionId)).toEqual({ status: 'absent' })
    expect(await restarted.list()).toEqual([projectB])
  })

  test('project-qualified stale and delete mutations isolate ambiguous legacy members', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const projectA = { ...baseRecord, projectIdentity: '/tmp/project-a', projectPath: '/tmp/project-a', opencodeSessionId: 'session-a' }
    const projectB = { ...baseRecord, projectIdentity: '/tmp/project-b', projectPath: '/tmp/project-b', opencodeSessionId: 'session-b' }
    await store.upsert(projectA)
    await store.upsert(projectB)

    expect(await store.markStale(projectA.teamId, projectA.laneId, projectA.memberName,
      'legacy-stale')).toBeNull()
    await expect(store.markStaleIfSessionMatches(projectA.teamId, projectA.laneId,
      projectA.memberName, projectA.opencodeSessionId, 'legacy-stale')).rejects.toThrow('ambiguous')
    expect(await store.markStaleIfSessionMatchesLogicalMember({ teamId: projectA.teamId,
      laneId: projectA.laneId, projectIdentity: projectA.projectPath, memberName: projectA.memberName },
    projectA.opencodeSessionId, 'project-a-stale')).toMatchObject({ status: 'applied' })
    expect(await store.getByLogicalMember({ teamId: projectB.teamId, laneId: projectB.laneId,
      projectIdentity: projectB.projectPath, memberName: projectB.memberName })).toEqual(projectB)
    expect(await store.delete(projectA.teamId, projectA.laneId, projectA.memberName)).toBe(false)
    await expect(store.deleteIfSessionMatches(projectA.teamId, projectA.laneId,
      projectA.memberName, projectA.opencodeSessionId)).rejects.toThrow('ambiguous')
  })

  test('restart migrates colliding legacy record keys into project-scoped projections', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const projectA = { ...baseRecord, projectIdentity: '/tmp/project-a', projectPath: '/tmp/project-a', opencodeSessionId: 'session-a' }
    const projectB = { ...baseRecord, projectIdentity: '/tmp/project-b', projectPath: '/tmp/project-b', opencodeSessionId: 'session-b' }
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: {
      [openCodeLogicalMemberKey({ teamId: projectA.teamId, laneId: projectA.laneId,
        projectIdentity: projectA.projectIdentity, memberName: projectA.memberName })]: asLegacyRecord(projectA),
      [openCodeLogicalMemberKey({ teamId: projectB.teamId, laneId: projectB.laneId,
        projectIdentity: projectB.projectIdentity, memberName: projectB.memberName })]: asLegacyRecord(projectB),
    }, reservations: {} }))

    const restarted = new OpenCodeSessionStore(filePath)
    expect(await restarted.list()).toEqual([projectA, projectB])
    expect(await restarted.upsert({ ...projectA, updatedAt: '2026-04-21T01:00:00.000Z' })).toBe('updated')

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      records: Record<string, typeof baseRecord>
    }
    expect(Object.values(persisted.records)).toEqual(expect.arrayContaining([
      { ...projectA, updatedAt: '2026-04-21T01:00:00.000Z' }, projectB,
    ]))
    expect(Object.values(persisted.records)).toHaveLength(2)
  })

  test('post-effect publication conflict stays reserved for durable reconciliation authority', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logical = { teamId: 'team-a', laneId: 'primary', projectIdentity: '/tmp/project', memberName: 'alice' }
    const store = new OpenCodeSessionStore(filePath)
    await store.reserveLogicalMember(logical, 'reservation-a', 'session-1')
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: 3; records: Record<string, typeof baseRecord>; reservations: Record<string, unknown> }
    persisted.records[openCodeLogicalMemberKey(logical)] = {
      ...baseRecord, opencodeSessionId: 'foreign-session',
    }
    await writeFile(filePath, JSON.stringify(persisted))
    expect((await store.publishReserved(baseRecord, 'reservation-a')).status).toBe('conflict')
    const after = JSON.parse(await readFile(filePath, 'utf8')) as { reservations: Record<string, unknown> }
    expect(Object.keys(after.reservations)).toHaveLength(1)
    expect((await store.reserveLogicalMember(logical, 'reservation-b', 'session-2')).status).toBe('conflict')
  })

  test('corrupt persisted reservation fails closed instead of becoming apparent absence', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: {}, reservations: {
      bad: { version: 1, logicalMemberKey: 'bad' },
    } }))
    const store = new OpenCodeSessionStore(filePath)
    await expect(store.get('team-a', 'primary', 'alice')).rejects.toThrow(
      'invalid OpenCode session reservation')
    await expect(store.reserveLogicalMember({ teamId: 'team-a', laneId: 'primary',
      projectIdentity: '/tmp/project', memberName: 'alice' }, 'reservation', 'session')).rejects.toThrow(
      'invalid OpenCode session reservation')
  })

  test('migrates a schema-2 symlink reservation key on the next locked mutation but not passive read', async () => {
    const project = path.join(tempDir, 'project')
    const alias = path.join(tempDir, 'project-alias')
    const filePath = path.join(tempDir, 'session-store.json')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    const reservation = reservationFor(alias)
    const original = JSON.stringify({ schemaVersion: 2, records: {}, reservations: {
      [reservation.logicalMemberKey]: reservation,
    } })
    await writeFile(filePath, original)
    const store = new OpenCodeSessionStore(filePath)

    expect(await store.list()).toEqual([])
    expect(await readFile(filePath, 'utf8')).toBe(original)
    expect((await store.reserveLogicalMember({ teamId: 'team-a', laneId: 'primary',
      projectIdentity: project, memberName: 'alice' }, 'reservation-a', 'session-1')).status).toBe('exact')
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      schemaVersion: number; reservations: Record<string, ReturnType<typeof reservationFor>> }
    const canonicalKey = openCodeLogicalMemberKey({ teamId: 'team-a', laneId: 'primary',
      projectIdentity: project, memberName: 'alice' })
    expect(persisted.schemaVersion).toBe(3)
    expect(Object.keys(persisted.reservations)).toEqual([canonicalKey])
    expect(persisted.reservations[canonicalKey]?.projectIdentity).toBe(project)
  })

  test('coalesces identical schema-2 reservations that collide after canonicalization', async () => {
    const project = path.join(tempDir, 'project')
    const alias = path.join(tempDir, 'project-alias')
    const filePath = path.join(tempDir, 'session-store.json')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    const canonical = reservationFor(project)
    const aliased = reservationFor(alias, { createdAt: '2026-04-20T00:00:00.000Z' })
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: {}, reservations: {
      [aliased.logicalMemberKey]: aliased, [canonical.logicalMemberKey]: canonical,
    } }))
    const store = new OpenCodeSessionStore(filePath)

    expect((await store.reserveLogicalMember({ teamId: 'team-a', laneId: 'primary',
      projectIdentity: project, memberName: 'alice' }, 'reservation-a', 'session-1')).status).toBe('exact')
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as { reservations: Record<string, unknown> }
    expect(Object.keys(persisted.reservations)).toEqual([canonical.logicalMemberKey])
    expect(persisted.reservations[canonical.logicalMemberKey]).toMatchObject({
      createdAt: '2026-04-20T00:00:00.000Z',
    })
  })

  test('rejects conflicting schema-2 reservation collisions after canonicalization', async () => {
    const project = path.join(tempDir, 'project')
    const alias = path.join(tempDir, 'project-alias')
    const filePath = path.join(tempDir, 'session-store.json')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    const canonical = reservationFor(project)
    const aliased = reservationFor(alias, { reservationIdentity: 'reservation-foreign' })
    await writeFile(filePath, JSON.stringify({ schemaVersion: 2, records: {}, reservations: {
      [aliased.logicalMemberKey]: aliased, [canonical.logicalMemberKey]: canonical,
    } }))
    const store = new OpenCodeSessionStore(filePath)

    await expect(store.list()).rejects.toThrow('conflicting normalized OpenCode session reservations')
  })

  test('rejects a noncanonical schema-3 reservation instead of rewriting it', async () => {
    const project = path.join(tempDir, 'project')
    const alias = path.join(tempDir, 'project-alias')
    const filePath = path.join(tempDir, 'session-store.json')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    const reservation = reservationFor(alias)
    await writeFile(filePath, JSON.stringify({ schemaVersion: 3, records: {}, reservations: {
      [reservation.logicalMemberKey]: reservation,
    } }))
    const store = new OpenCodeSessionStore(filePath)

    await expect(store.list()).rejects.toThrow('reservation project identity is not canonical')
  })

  test('returns unchanged for identical record and marks stale explicitly', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    expect(await store.upsert(baseRecord)).toBe('created')
    expect(await store.upsert(baseRecord)).toBe('unchanged')

    const stale = await store.markStale(baseRecord.teamId, baseRecord.memberName, 'auth_stale')
    expect(stale?.staleReason).toBe('auth_stale')
    expect(stale?.updatedAt).not.toBe(baseRecord.updatedAt)
  })

  test('deletes records cleanly', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))

    await store.upsert(baseRecord)
    expect(await store.delete(baseRecord.teamId, baseRecord.memberName)).toBe(true)
    expect(await store.get(baseRecord.teamId, baseRecord.memberName)).toBeNull()
  })

  test('stores sibling OpenCode lanes independently for the same team/member pair', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const primary = { ...baseRecord, laneId: 'primary', opencodeSessionId: 'session-primary' }
    const secondary = {
      ...baseRecord,
      laneId: 'secondary:opencode:alice',
      opencodeSessionId: 'session-secondary',
    }

    expect(await store.upsert(primary)).toBe('created')
    expect(await store.upsert(secondary)).toBe('created')
    expect(await store.get(baseRecord.teamId, 'primary', baseRecord.memberName)).toEqual(primary)
    expect(
      await store.get(baseRecord.teamId, 'secondary:opencode:alice', baseRecord.memberName),
    ).toEqual(secondary)
    expect(await store.list()).toHaveLength(2)
  })

  test('conditionally marks stale only for the exact session', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    await store.upsert(baseRecord)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result.status).toBe('applied')
    expect(
      await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName),
    ).toMatchObject({
      opencodeSessionId: baseRecord.opencodeSessionId,
      staleReason: 'cleanup_failed',
    })
  })

  test('conditional stale marking preserves and reports a foreign replacement', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(replacement)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('conditional stale marking is idempotent when the exact reason is already stored', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const alreadyStale = { ...baseRecord, staleReason: 'cleanup_failed' }
    await store.upsert(alreadyStale)

    const result = await store.markStaleIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
      'cleanup_failed',
    )

    expect(result).toEqual({ status: 'already-satisfied', record: alreadyStale })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      alreadyStale,
    )
  })

  test('conditionally deletes only the exact session and is idempotent once absent', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    await store.upsert(baseRecord)

    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        baseRecord.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'applied', record: baseRecord })
    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        baseRecord.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'absent' })
  })

  test('conditional delete preserves and reports a foreign replacement', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(replacement)

    const result = await store.deleteIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
    )

    expect(result).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('replacement installed before conditional delete obtains the lock is preserved', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const store = new OpenCodeSessionStore(filePath)
    const replacement = { ...baseRecord, opencodeSessionId: 'session-replacement' }
    await store.upsert(baseRecord)
    const release = await lockfile.lock(`${filePath}.lock`)

    const deletion = store.deleteIfSessionMatches(
      baseRecord.teamId,
      baseRecord.laneId,
      baseRecord.memberName,
      baseRecord.opencodeSessionId,
    )
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        records: {
          [`${baseRecord.teamId}::${baseRecord.laneId}::${baseRecord.memberName}`]: asLegacyRecord(replacement),
        },
      }),
    )
    await release()

    expect(await deletion).toEqual({ status: 'foreign', record: replacement })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      replacement,
    )
  })

  test('conditional mutations scope identity to the exact lane', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const secondary = {
      ...baseRecord,
      laneId: 'secondary:opencode:alice',
      opencodeSessionId: 'session-secondary',
    }
    await store.upsert(baseRecord)
    await store.upsert(secondary)

    expect(
      await store.markStaleIfSessionMatches(
        baseRecord.teamId,
        secondary.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
        'wrong-lane',
      ),
    ).toEqual({ status: 'foreign', record: secondary })
    expect(
      await store.deleteIfSessionMatches(
        baseRecord.teamId,
        secondary.laneId,
        baseRecord.memberName,
        baseRecord.opencodeSessionId,
      ),
    ).toEqual({ status: 'foreign', record: secondary })
    expect(await store.get(baseRecord.teamId, baseRecord.laneId, baseRecord.memberName)).toEqual(
      baseRecord,
    )
    expect(await store.get(baseRecord.teamId, secondary.laneId, baseRecord.memberName)).toEqual(
      secondary,
    )
  })

  test('fails closed for tampered persisted keys and project identities', async () => {
    const filePath = path.join(tempDir, 'session-store.json')
    const logicalKey = openCodeLogicalMemberKey({
      teamId: baseRecord.teamId, laneId: baseRecord.laneId,
      projectIdentity: baseRecord.projectIdentity, memberName: baseRecord.memberName,
    })
    await writeFile(filePath, JSON.stringify({ schemaVersion: 3, records: {
      [logicalKey]: { ...baseRecord, projectIdentity: '/tmp/other-project' },
    }, reservations: {} }))
    await expect(new OpenCodeSessionStore(filePath).list()).rejects.toThrow('project identity mismatch')

    await writeFile(filePath, JSON.stringify({ schemaVersion: 3, records: {
      tampered: baseRecord,
    }, reservations: {} }))
    await expect(new OpenCodeSessionStore(filePath).list()).rejects.toThrow('record key mismatch')
  })

  test('stale metadata updates cannot overwrite a replacement run or session', async () => {
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    const original = { ...baseRecord, runId: 'run-old' }
    const replacement = {
      ...baseRecord, runId: 'run-new', opencodeSessionId: 'session-replacement',
    }
    await store.upsert(original)
    await store.upsert(replacement)
    const staleProjection = { ...original, lastKnownRawStatus: 'busy', updatedAt: new Date().toISOString() }

    expect(await store.upsertIfSessionMatches(
      staleProjection, original.opencodeSessionId, original.runId,
    )).toEqual({ status: 'foreign', record: replacement })
    expect(await store.markStaleIfSessionMatchesLogicalMember({
      teamId: original.teamId, laneId: original.laneId,
      projectIdentity: original.projectIdentity, memberName: original.memberName,
    }, original.opencodeSessionId, 'old-cleanup', original.runId)).toEqual({
      status: 'foreign', record: replacement,
    })
    expect(await store.list()).toEqual([replacement])
  })

  test('canonicalizes a symlink alias before lookup and mutation', async () => {
    const project = path.join(tempDir, 'project')
    const alias = path.join(tempDir, 'alias')
    await mkdir(project)
    await symlink(project, alias, 'dir')
    const record = { ...baseRecord, projectIdentity: project, projectPath: project }
    const store = new OpenCodeSessionStore(path.join(tempDir, 'session-store.json'))
    await store.upsert(record)
    const logicalAlias = {
      teamId: record.teamId, laneId: record.laneId,
      projectIdentity: alias, memberName: record.memberName,
    }
    expect(await store.getByLogicalMember(logicalAlias)).toEqual(record)
    expect(await store.markStaleIfSessionMatchesLogicalMember(
      logicalAlias, record.opencodeSessionId, 'alias-cleanup', record.runId,
    )).toMatchObject({ status: 'applied', record: { staleReason: 'alias-cleanup' } })
  })
})
