import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { HostedMemberSessionBridge, hostedMemberAttempt, type HostedMemberDelivery } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import { HostedDurableContainerAttemptClaims, HostedDurableMemberSessionClaims } from './HostedDurableClaims.js'

const roots: string[] = []
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hosted-claims-test-')))
  await chmod(path, 0o700)
  roots.push(path)
  return path
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const hex = (char: string) => char.repeat(64)
const binding = {
  key: hex('a'), fingerprint: hex('b'), operationId: `start_${hex('c')}`,
  runId: `run_${hex('d')}`, teamId: `team_${hex('e')}`, laneId: `lane_${hex('f')}`,
  memberId: `member_${'a'.repeat(32)}`, memberName: 'coder', model: 'qwen/test',
  promptSha256: hex('1'),
}
const container = { fingerprint: binding.fingerprint, handle: `opencode_${'2'.repeat(32)}`,
  generation: '3'.repeat(32) }
const attempt = hostedMemberAttempt({ teamId: binding.teamId, runId: binding.runId,
  laneId: binding.laneId, memberId: binding.memberId, memberName: binding.memberName,
  model: binding.model, promptSha256: createHash('sha256').update('prompt').digest('hex'),
  planFingerprint: binding.fingerprint, containerHandle: container.handle,
  containerGeneration: container.generation })
const delivery: HostedMemberDelivery = { attempt, deliveryId: 'delivery_test12345', kind: 'message',
  text: 'hello', taskId: null, taskRevision: null }
const deliveryFingerprint = (input: HostedMemberDelivery) => createHash('sha256').update(JSON.stringify([
  input.attempt.attemptId, input.deliveryId, input.kind, input.text, input.taskId, input.taskRevision,
])).digest('hex')

describe('durable hosted claims', () => {
  test('concurrent lane claims and process recreation permit one launch only', async () => {
    const path = await root()
    const stores = Array.from({ length: 12 }, () => new HostedDurableContainerAttemptClaims(path))
    const results = await Promise.all(stores.map(store => store.claimLane({ key: binding.key, fingerprint: binding.fingerprint })))
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(results.every(result => result.fingerprint === binding.fingerprint)).toBe(true)
    expect(await new HostedDurableContainerAttemptClaims(path).claimLane({ key: binding.key,
      fingerprint: hex('9') })).toEqual({ created: false, fingerprint: binding.fingerprint })
  })

  test('close before claim tombstones lane; stopped evidence survives restart and rejects changed binding', async () => {
    const path = await root()
    const first = new HostedDurableContainerAttemptClaims(path)
    expect(await first.closeLane({ key: hex('4'), fingerprint: binding.fingerprint })).toEqual({
      closed: true, fingerprint: binding.fingerprint })
    expect(await new HostedDurableContainerAttemptClaims(path).claimLane({ key: hex('4'),
      fingerprint: binding.fingerprint })).toEqual({ created: false, fingerprint: binding.fingerprint })
    expect(await first.claim(binding)).toEqual({ created: true, fingerprint: binding.fingerprint })
    expect(await first.markStopped(binding, { ...container, generation: 'bad' })).toBe(false)
    expect(await first.read(binding)).toEqual({ state: 'claimed', fingerprint: binding.fingerprint })
    expect(await first.markStopped(binding, container)).toBe(true)
    const restarted = new HostedDurableContainerAttemptClaims(path)
    expect(await restarted.read(binding)).toEqual({ state: 'stopped', fingerprint: binding.fingerprint })
    expect(await restarted.markStopped({ ...binding, model: 'changed' }, container)).toBe(false)
    expect(await restarted.claim({ ...binding, fingerprint: hex('7') })).toEqual({
      created: false, fingerprint: binding.fingerprint })
  })

  test('orphaned terminal markers cannot be bypassed by recreating primary claims', async () => {
    const path = await root()
    const store = new HostedDurableContainerAttemptClaims(path)
    expect(await store.claimLane({ key: binding.key, fingerprint: binding.fingerprint })).toEqual({
      created: true, fingerprint: binding.fingerprint })
    expect(await store.closeLane({ key: binding.key, fingerprint: binding.fingerprint })).toEqual({
      closed: true, fingerprint: binding.fingerprint })
    await unlink(join(path, `lane-${binding.key}.json`))
    await expect(new HostedDurableContainerAttemptClaims(path).claimLane({ key: binding.key,
      fingerprint: binding.fingerprint })).rejects.toThrow('Orphaned hosted lane closure')

    expect(await store.claim(binding)).toEqual({ created: true, fingerprint: binding.fingerprint })
    expect(await store.markStopped(binding, container)).toBe(true)
    await unlink(join(path, `member-${binding.key}.json`))
    await expect(new HostedDurableContainerAttemptClaims(path).claim(binding))
      .rejects.toThrow('Orphaned hosted stop evidence')
  })

  test('stopped evidence missing or changing container fingerprint is rejected', async () => {
    const path = await root()
    const store = new HostedDurableContainerAttemptClaims(path)
    await store.claim(binding)
    await store.markStopped(binding, container)
    const markerPath = join(path, `member-${binding.key}.stopped.json`)
    const original = JSON.parse(await readFile(markerPath, 'utf8')) as { container: Record<string, unknown> }
    delete original.container.fingerprint
    await writeFile(markerPath, JSON.stringify(original))
    await expect(new HostedDurableContainerAttemptClaims(path).read(binding))
      .rejects.toThrow('Invalid hosted stop evidence')
    original.container.fingerprint = hex('9')
    await writeFile(markerPath, JSON.stringify(original))
    await expect(new HostedDurableContainerAttemptClaims(path).read(binding))
      .rejects.toThrow('Invalid hosted stop evidence')
  })

  test('ambiguous session Start and delivery Post are observed after recreation, changed payload conflicts', async () => {
    const path = await root()
    const first = new HostedDurableMemberSessionClaims(path)
    expect(await first.claimStart(attempt)).toEqual({ created: true, fingerprint: attempt.planFingerprint })
    const restarted = new HostedDurableMemberSessionClaims(path)
    expect(await restarted.claimStart(attempt)).toEqual({ created: false, fingerprint: attempt.planFingerprint })
    const { attemptId: _attemptId, ...attemptInput } = attempt
    const changed = hostedMemberAttempt({ ...attemptInput, containerGeneration: '4'.repeat(32) })
    expect(await restarted.claimStart(changed)).toEqual({ created: false, fingerprint: attempt.planFingerprint })
    expect(await first.claimDelivery(delivery, deliveryFingerprint(delivery))).toEqual({
      created: true, fingerprint: deliveryFingerprint(delivery) })
    expect(await restarted.claimDelivery(delivery, deliveryFingerprint(delivery))).toEqual({
      created: false, fingerprint: deliveryFingerprint(delivery) })
    const changedDelivery = { ...delivery, text: 'changed' }
    expect(await restarted.claimDelivery(changedDelivery, deliveryFingerprint(changedDelivery))).toEqual({
      created: false, fingerprint: deliveryFingerprint(delivery) })
    expect(await restarted.readDelivery(delivery.deliveryId)).toEqual({ fingerprint: deliveryFingerprint(delivery) })
  })

  test('bridge restart observes ambiguous Start and Post without replaying either effect', async () => {
    const path = await root()
    let starts = 0
    let posts = 0
    const ready = { ...attempt, state: 'ready', sessionId: 'ses_test12345',
      initialMessageId: 'msg_initial12345', observedInitialMessageId: 'msg_initial12345' }
    const posted = { attemptId: attempt.attemptId, containerGeneration: attempt.containerGeneration,
      sessionId: ready.sessionId, deliveryId: delivery.deliveryId,
      observedUserMessageId: 'msg_user12345' }
    const port = {
      async start() { starts++; throw new Error('response lost after Start') },
      async observe() { return ready },
      async post() { posts++; throw new Error('response lost after Post') },
      async observeDelivery() { return posted },
      async observeReply() { return null },
    }
    const first = new HostedMemberSessionBridge(port, new HostedDurableMemberSessionClaims(path))
    expect(await first.start(attempt, 'prompt')).toBe('failed')
    expect(await first.deliver(delivery)).toBe('operator_required')
    const restarted = new HostedMemberSessionBridge(port, new HostedDurableMemberSessionClaims(path))
    expect(await restarted.start(attempt, 'prompt')).toBe('ready')
    expect(await restarted.deliver(delivery)).toBe('delivered')
    expect({ starts, posts }).toEqual({ starts: 1, posts: 1 })
  })

  test('unsafe roots and corrupt records fail closed', async () => {
    const path = await root()
    await chmod(path, 0o755)
    await expect(new HostedDurableContainerAttemptClaims(path).claimLane({ key: binding.key,
      fingerprint: binding.fingerprint })).rejects.toThrow('Owner-private')
    await chmod(path, 0o700)
    const target = await root()
    await symlink(target, join(path, 'link'))
    await expect(new HostedDurableContainerAttemptClaims(join(path, 'link')).claimLane({
      key: binding.key, fingerprint: binding.fingerprint })).rejects.toThrow('Unsafe')
    await writeFile(join(path, `lane-${binding.key}.json`), 'partial')
    await expect(new HostedDurableContainerAttemptClaims(path).claimLane({ key: binding.key,
      fingerprint: binding.fingerprint })).rejects.toThrow()
    expect(await readFile(join(path, `lane-${binding.key}.json`), 'utf8')).toBe('partial')
  })
})
