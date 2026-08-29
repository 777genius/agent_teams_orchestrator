import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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

  test('fresh one-shot handlers recover a known cancelled create and only recreate missing member two', async () => {
    const failed = await persistent.invokeOneShot({ cancelAfterKnownCreate: 'two' })
    expect(failed).toMatchObject({ status: 'stopped', committedMemberIds: ['one'] })

    const afterFailure = await persistent.sessions()
    expect(afterFailure.find(record => record.memberName === 'one')).toMatchObject({
      opencodeSessionId: 'session-one-1',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
    })
    const incompleteTwo = afterFailure.find(record => record.memberName === 'two')
    expect(incompleteTwo?.opencodeSessionId).toBe('session-two-2')
    expect(incompleteTwo?.bootstrapEvidenceSource).toBeUndefined()

    const retried = await persistent.invokeOneShot()
    expect(retried).toMatchObject({ status: 'committed', committedMemberIds: ['one', 'two'] })
    expect(retried.projections.map(projection => projection.member)).toEqual(['one', 'two'])

    const evidence = await persistent.evidence()
    expect(evidence.managerInvocations).toEqual([1, 2])
    expect(evidence.creates).toEqual([
      { managerId: 1, member: 'one', sessionId: 'session-one-1' },
      { managerId: 1, member: 'two', sessionId: 'session-two-2' },
      { managerId: 2, member: 'two', sessionId: 'session-two-3' },
    ])
    const sessions = await persistent.sessions()
    expect(sessions.map(record => [record.memberName, record.opencodeSessionId]).sort()).toEqual([
      ['one', 'session-one-1'],
      ['two', 'session-two-3'],
    ])
  })

  test('one retained host carries App MCP, exact proof, profile identity, and committed members', async () => {
    const harness = new Issue443Harness()
    const result = await coordinateStrictLaunch(harness.strictRequest(), harness)

    expect(result).toMatchObject({ status: 'committed', committedMemberIds: ['one', 'two'] })
    expect(harness.profiles).toEqual([{
      purpose: 'launch_runtime', providerId: 'deepinfra', modelId: harness.catalogModel,
    }])
    expect(harness.hosts).toEqual([{
      hostId: 'launch-host', baseUrl: 'http://fake-host.invalid', retained: true,
      purpose: 'launch_runtime',
    }])
    expect(harness.mcp).toEqual([
      { hostId: 'launch-host', action: 'attach' },
      { hostId: 'launch-host', action: 'probe' },
    ])
    expect(harness.proofs[0]).toMatchObject({
      input: { nonce: 'nonce-443', expectedHostId: 'launch-host', providerId: 'deepinfra' },
      output: { nonce: 'nonce-443', hostId: 'launch-host', providerId: 'deepinfra' },
    })
    expect(harness.timeline).toEqual([
      'host:launch-host', 'mcp:launch-host', 'proof:nonce-443', 'member:one', 'member:two',
    ])
    expect(harness.releases).toEqual([{ leaseId: 'lease-443', keepAlive: true, at: 0 }])
    expect(harness.processTrees).toEqual([{ pid: 44301, parentPid: null, owner: 'attempt-443:7' }])
    expect(harness.commands).toEqual([])
    expect(harness.plugins).toEqual([])
    harness.assertSafe()
  })

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
