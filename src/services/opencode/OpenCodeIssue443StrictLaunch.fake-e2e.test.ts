import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { coordinateStrictLaunch } from './OpenCodeStrictLaunchCoordinator.js'
import { validateOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { deferred, Issue443Harness } from './OpenCodeIssue443FakeE2E.test-support.js'
import { Issue443PersistentCommandFake } from './OpenCodeIssue443PersistentCommand.test-support.js'
import type { StrictProof } from './OpenCodeStrictLaunchCoordinator.js'

async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

describe('issue #443 strict launch fake E2E', () => {
  let persistent: Issue443PersistentCommandFake

  beforeEach(async () => {
    persistent = new Issue443PersistentCommandFake()
    await persistent.open()
  })

  afterEach(async () => {
    await persistent.close()
  })

  test('production command envelope adopts one retained fake profile and replays across Bun processes', async () => {
    const failed = await persistent.invokeOneShot('first-unknown')
    expect(failed.ok).toBe(true)
    if (!failed.ok) throw new Error(JSON.stringify(failed))
    expect(Object.keys(failed.data.members)).toEqual(['one'])
    expect(failed.data.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'opencode_strict_launch_unknown' }),
    ]))

    const afterFailure = await persistent.sessions()
    expect(afterFailure.find(record => record.memberName === 'one')).toMatchObject({
      opencodeSessionId: 'session-one-1',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
    })
    const incompleteTwo = afterFailure.find(record => record.memberName === 'two')
    expect(incompleteTwo?.opencodeSessionId).toBe('session-two-2')
    expect(incompleteTwo?.bootstrapEvidenceSource).toBeUndefined()

    const retried = await persistent.invokeOneShot('restart')
    expect(retried.ok).toBe(true)
    if (!retried.ok) throw new Error(JSON.stringify(retried))
    expect(Object.keys(retried.data.members)).toEqual(['one', 'two'])
    expect(retried.data.members.two?.sessionId).toBe('session-two-2')

    const evidence = await persistent.evidence()
    expect(evidence.invocations.map(item => [item.requestId, item.mode])).toEqual([
      ['request-1', 'first-unknown'],
      ['request-2', 'restart'],
    ])
    expect(new Set(evidence.invocations.map(item => item.pid)).size).toBe(2)
    expect(evidence.invocations.every(item => item.pid !== process.pid)).toBe(true)
    expect(evidence.creates).toEqual([
      { requestId: 'request-1', member: 'one', sessionId: 'session-one-1' },
      { requestId: 'request-1', member: 'two', sessionId: 'session-two-2' },
    ])
    const sessions = await persistent.sessions()
    expect(sessions.map(record => [record.memberName, record.opencodeSessionId]).sort()).toEqual([
      ['one', 'session-one-1'],
      ['two', 'session-two-2'],
    ])
    const adoptions = evidence.events.filter(event => event.type === 'adopt-profile')
    expect(adoptions).toHaveLength(2)
    expect(adoptions).toEqual(adoptions.map(event => expect.objectContaining({
      hostId: 'fake-retained-host-443',
      projectPath: evidence.host.projectPath,
      purpose: 'launch_runtime',
      providerId: 'deepinfra',
      modelId: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
      generation: 1,
      fingerprint: evidence.expectedBehaviorFingerprint,
    })))
    for (const requestId of ['request-1', 'request-2']) {
      const events = evidence.events.filter(event => event.requestId === requestId)
      const proofIndex = events.findIndex(event => event.type === 'proof')
      const memberIndex = events.findIndex(event => event.type === 'member')
      expect(proofIndex).toBeGreaterThanOrEqual(0)
      expect(memberIndex).toBeGreaterThan(proofIndex)
      const proof = events[proofIndex]!
      expect(proof).toMatchObject({
        hostId: 'fake-retained-host-443',
        projectPath: evidence.host.projectPath,
        providerId: 'deepinfra',
        modelId: 'deepinfra/meta-llama/Llama-3.3-70B-Instruct',
        attemptId: requestId,
        generation: 1,
        fingerprint: evidence.expectedBehaviorFingerprint,
      })
      expect(proof.nonce).toMatch(/^[0-9a-f-]{36}$/)
      for (const member of events.filter(event => event.type === 'member')) {
        expect(member.memberFingerprint).toMatch(/^[0-9a-f]{64}$/)
      }
    }
    const replayedTwo = evidence.events.filter(event =>
      event.requestId === 'request-2' && event.type === 'member')
    expect(replayedTwo).toEqual([
      expect.objectContaining({ member: 'two', sessionId: 'session-two-2' }),
    ])
    expect(replayedTwo[0]?.memberFingerprint).toBe(evidence.events.find(event =>
      event.requestId === 'request-1' && event.type === 'member' && event.member === 'two',
    )?.memberFingerprint)
    expect(evidence.events.filter(event => event.type === 'release-session')).toEqual([])
    expect(evidence.events.filter(event => event.type === 'release-host')).toEqual([
      expect.objectContaining({ requestId: 'request-1', hostId: 'fake-retained-host-443', keepAlive: true }),
      expect.objectContaining({ requestId: 'request-2', hostId: 'fake-retained-host-443', keepAlive: true }),
    ])

    for (const mode of ['stale', 'unknown-proof'] as const) {
      const before = (await persistent.evidence()).events.length
      const rejected = await persistent.invokeOneShot(mode)
      expect(rejected.ok, mode).toBe(false)
      const events = (await persistent.evidence()).events.slice(before)
      expect(events.some(event => event.type === 'member' || event.type === 'inject'), mode).toBe(false)
    }

    const ownedRoot = persistent.root
    await persistent.close()
    await expect(stat(ownedRoot)).rejects.toThrow()
  }, 20_000)

  test('non-exact behavior evidence rejects before every member boundary', async () => {
    const variants: Array<[string, Partial<StrictProof>]> = [
      ['nonce', { nonce: 'wrong' }],
      ['provider', { providerId: 'kiro' }],
      ['model', { modelId: 'deepinfra/wrong' }],
      ['host', { hostId: 'other-host' }],
      ['digest', { behaviorFingerprint: 'wrong-digest' }],
      ['malformed behavior', { behaviorFingerprint: undefined as unknown as string }],
      ['non-exact proof', { mcpTools: [] }],
    ]
    for (const [label, proofOverride] of variants) {
      const harness = new Issue443Harness()
      harness.proofOverride = proofOverride
      const result = await coordinateStrictLaunch(harness.strictRequest(), harness)
      expect(result.status, label).toBe('invalid-proof')
      expect(harness.members, label).toEqual([])
      expect(harness.cleanupEvents, label).toEqual([[]])
      expect(harness.releases[0], label).toMatchObject({ keepAlive: false })
    }
  })

  test('unknown materialization is not automatically retried or cleaned', async () => {
    const harness = new Issue443Harness()
    harness.materializeResults.set('one', {
      kind: 'unknown', error: 'acknowledgement lost',
      resources: [{ attemptId: 'attempt-443', generation: 7, resourceId: 'maybe-one', committed: false }],
    })
    const result = await coordinateStrictLaunch(harness.strictRequest(), harness)
    expect(result).toMatchObject({ status: 'unknown', reason: 'acknowledgement lost' })
    expect(harness.members).toEqual(['one'])
    expect(harness.cleanupEvents).toEqual([[]])
    expect(harness.releases[0]).toMatchObject({ keepAlive: true })
  })

  test('deadline cancels a hung exact proof and preserves the cleanup reserve for owned release', async () => {
    const harness = new Issue443Harness()
    const late = deferred<{ kind: 'ok'; value: StrictProof }>()
    harness.requestProof = async () => late.promise
    const running = coordinateStrictLaunch(harness.strictRequest(), harness)
    await drain()
    harness.scheduler.advanceTo(80)
    await drain()
    const result = await running

    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' })
    expect(harness.members).toEqual([])
    expect(harness.releases).toEqual([{ leaseId: 'lease-443', keepAlive: false, at: 80 }])
    late.resolve({
      kind: 'ok', value: {
        attemptId: 'attempt-443', generation: 7, nonce: 'nonce-443', hostId: 'launch-host',
        providerId: 'deepinfra', modelId: harness.catalogModel,
        behaviorFingerprint: 'digest-443', mcpTools: ['app_status'],
      },
    })
    await drain()
    expect(harness.members).toEqual([])
  })
})

describe('issue #443 canonical contract fixture', () => {
  test('uses the canonical v2 SHA, rejects v1, and binds every tuple component', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/expected-behavior-fingerprint-v2.json', import.meta.url))
    const bytes = await readFile(fixturePath)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'ab20af8704ba9bcdbc04e6f2bd288f68645cb62c3a6aa35e948a76503bf34fd9',
    )
    const fixture = JSON.parse(bytes.toString()) as { cases: Array<Record<string, string>> }
    const [baseline, ...mutations] = fixture.cases
    expect(validateOpenCodeExpectedBehaviorEvidence({
      ...baseline!, expectedBehaviorFingerprint: '24c90d07dabd7df2da360970e41f28657b043649c4028e50f78ec986bafaf501',
    })).toBe(false)
    expect(mutations.slice(0, 6).map(item => item.name)).toEqual([
      'project-path-changed', 'provider-changed', 'model-changed',
      'project-behavior-changed', 'config-changed', 'auth-changed',
    ])
    for (const mutation of mutations.slice(0, 6)) {
      const { name: _name, ...evidence } = mutation
      expect(validateOpenCodeExpectedBehaviorEvidence({
        ...evidence, expectedBehaviorFingerprint: baseline!.expectedBehaviorFingerprint,
      })).toBe(false)
    }
  })
})
