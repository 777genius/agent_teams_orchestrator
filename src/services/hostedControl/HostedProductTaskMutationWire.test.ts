import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedControlDispatcher, type HostedTeamMessagePort } from './HostedControlDispatcher.js'
import { HOSTED_TEAM_MESSAGE_PROOF_DOMAIN } from './HostedControlServer.js'
import { isProductOwnerBoundEnvelope } from './HostedProductOwnerBoundEnvelope.js'
import { HostedTaskMutationService } from './HostedTaskMutationService.js'
import { HostedTaskMutationWal } from './HostedTaskMutationWal.js'
import { createHostedTeamIdentityFenceVerifier } from './HostedTeamIdentityFence.js'
import {
  fingerprintHostedTaskCommand,
  type HostedControlOwnerBinding,
  type HostedControlStableAuthority,
  type HostedTaskMutationCommand,
} from './protocol.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const secret = Buffer.alloc(32, 7)
const ownerBinding: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_product-task',
  ownerGeneration: 3,
  ownerSessionId: 'owner-session_product-task',
  socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 },
}
const stableAuthority: HostedControlStableAuthority = {
  deploymentId: `deployment_${'3'.repeat(32)}`,
  bootId: `boot_${'4'.repeat(32)}`,
  restoreGeneration: 2,
  workspaceId: `workspace_${'1'.repeat(32)}`,
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'c'.repeat(32)}`,
}
const teamIdentityBytes = `${JSON.stringify({ schemaVersion: 1, teamId: stableAuthority.teamId, createdAt: '2026-09-25T00:00:00.000Z' }, null, 2)}\n`
const identityChecksum = createHash('sha256').update(teamIdentityBytes).digest('hex')

type Operation = 'task_mutate' | 'message_persist' | 'message_deliver'

/** Mirrors Product hostedTeamMessageOrchestratorAuthority.proof: the operation is signed. */
function productProof(operation: Operation, direction: 'request' | 'response', envelope: Record<string, unknown>): string {
  return createHmac('sha256', secret)
    .update(`${HOSTED_TEAM_MESSAGE_PROOF_DOMAIN}\u0000${operation}\u0000${direction}\u0000${JSON.stringify(envelope)}`)
    .digest('hex')
}

/** Mirrors Product exchangeOwnerMutation: the browser grant fence rides inside the authority. */
function productRequest(operation: Operation, payload: Record<string, unknown>, fence = { grantRevision: 'd'.repeat(64), identityChecksum }) {
  const { deploymentId, bootId, restoreGeneration, workspaceId, mountBinding, teamId } = stableAuthority
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `${operation === 'task_mutate' ? 'task' : 'message'}-request_${'9'.repeat(32)}`,
    operation,
    ownerBinding,
    authority: { actorId: 'actor_product', deploymentId, bootId, restoreGeneration, workspaceId, mountBinding, teamId, ownerEffectFence: fence },
    payload,
  }
  return { ...unsigned, ownerProof: productProof(operation, 'request', unsigned) }
}

function taskRequest(command: HostedTaskMutationCommand, fence?: { grantRevision: string; identityChecksum: string }) {
  return productRequest('task_mutate', { command, payloadFingerprint: fingerprintHostedTaskCommand(command) }, fence)
}

/** The response checks Product applies before parsing the payload. */
function productVerifiedPayload(request: Record<string, unknown>, response: Record<string, unknown>): Record<string, unknown> {
  expect(Object.keys(response).sort()).toEqual(['authority', 'exchangeId', 'operation', 'ownerBinding', 'ownerProof', 'payload', 'schemaVersion'])
  expect(response.exchangeId).toBe(request.exchangeId)
  expect(response.operation).toBe(request.operation)
  expect(JSON.stringify(response.authority)).toBe(JSON.stringify(request.authority))
  const { ownerProof, ...unsigned } = response
  expect(ownerProof).toBe(productProof(request.operation as Operation, 'response', {
    schemaVersion: unsigned.schemaVersion, exchangeId: unsigned.exchangeId, operation: unsigned.operation,
    ownerBinding: unsigned.ownerBinding, authority: unsigned.authority, payload: unsigned.payload,
  }))
  return response.payload as Record<string, unknown>
}

async function fixture(options: { denyOwnerLocalWrites: boolean; messages?: HostedTeamMessagePort }) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-product-owner-bound-')); roots.push(root)
  await mkdir(join(root, 'teams', 'legacy'), { recursive: true })
  await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
  await writeFile(join(root, 'teams', 'legacy', 'team.identity.json'), teamIdentityBytes)
  const tasks = new HostedTaskMutationService({
    claudeRoot: root, legacyKey: 'legacy', authority: stableAuthority, denyOwnerLocalWrites: options.denyOwnerLocalWrites,
    wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), stableAuthority.teamId),
  })
  const messageCalls: unknown[] = []
  const dispatcher = new HostedControlDispatcher({
    secret,
    authority: stableAuthority,
    getOwnerBinding: () => ownerBinding,
    lifecycle: { dispatch: async () => { throw new Error('unexpected lifecycle dispatch') } },
    messages: options.messages ?? { dispatch: async input => { messageCalls.push(input); throw new Error('unexpected message dispatch') } },
    tasks,
    verifyOwnerEffectFence: createHostedTeamIdentityFenceVerifier({ claudeRoot: root, legacyKey: 'legacy', teamId: stableAuthority.teamId }),
  })
  return { root, dispatcher, messageCalls }
}

function createCommand(): HostedTaskMutationCommand {
  return { schemaVersion: 1, kind: 'create_task', commandId: 'command_product_wire', idempotencyKey: 'idem:product-wire', teamId: stableAuthority.teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'From the browser', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
}

describe('Product task_mutate envelope', () => {
  test('commits a Product-signed create and returns the Product task-board payload with exact self-write effects', async () => {
    const { root, dispatcher } = await fixture({ denyOwnerLocalWrites: false })
    let command = createCommand()
    let payload: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = taskRequest(command)
      expect(isProductOwnerBoundEnvelope(request)).toBe(true)
      payload = productVerifiedPayload(request, (await dispatcher.dispatch(request))!)
      if (payload.kind === 'stale_generation') { command = { ...command, expectedSourceGeneration: payload.currentSourceGeneration as string }; continue }
      if (payload.kind === 'stale_revision') { command = { ...command, expectedRevision: payload.currentRevision as string }; continue }
      break
    }
    expect(payload.kind).toBe('committed')
    expect(Object.keys(payload).sort()).toEqual(['currentSourceGeneration', 'kind', 'payloadFingerprint', 'receipt', 'schemaVersion', 'selfWriteEffects'])
    expect(payload).toMatchObject({ schemaVersion: 1, currentSourceGeneration: command.expectedSourceGeneration, payloadFingerprint: fingerprintHostedTaskCommand(command) })
    const receipt = payload.receipt as Record<string, unknown>
    expect(Object.keys(receipt).sort()).toEqual(['affectedTaskIds', 'commandId', 'outcome', 'revision', 'schemaVersion', 'sourceGeneration', 'teamId'])
    expect(receipt.revision).toMatch(/^revision_[0-9a-f]{64}$/)
    const taskFiles = (await readdir(join(root, 'tasks', 'legacy'))).filter(name => name.endsWith('.json'))
    expect(taskFiles).toHaveLength(1)
    const bytes = await readFile(join(root, 'tasks', 'legacy', taskFiles[0]!))
    expect(payload.selfWriteEffects).toEqual([{ fileKey: taskFiles[0]!.slice(0, -'.json'.length), expectedChecksum: createHash('sha256').update(bytes).digest('hex') }])

    const replay = productVerifiedPayload(taskRequest(command), (await dispatcher.dispatch(taskRequest(command)))!)
    expect(Object.keys(replay).sort()).toEqual(['currentSourceGeneration', 'kind', 'payloadFingerprint', 'receipt', 'schemaVersion'])
    expect(replay.kind).toBe('idempotent_replay')
  })

  test('keeps the Owner read-only outside personal-host and answers with Product unavailable', async () => {
    const { root, dispatcher } = await fixture({ denyOwnerLocalWrites: true })
    const request = taskRequest(createCommand())
    expect(productVerifiedPayload(request, (await dispatcher.dispatch(request))!)).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null })
    expect(await readdir(join(root, 'tasks', 'legacy'))).toEqual([])
  })

  test('rejects a forged proof, an unsigned operation, and a foreign authority before any write', async () => {
    const { root, dispatcher } = await fixture({ denyOwnerLocalWrites: false })
    await expect(dispatcher.dispatch({ ...taskRequest(createCommand()), ownerProof: 'f'.repeat(64) })).rejects.toThrow('proof')
    const { ownerProof: _, ...unsigned } = taskRequest(createCommand())
    const withoutOperation = { ...unsigned, ownerProof: createHmac('sha256', secret).update(`${HOSTED_TEAM_MESSAGE_PROOF_DOMAIN}\u0000request\u0000${JSON.stringify(unsigned)}`).digest('hex') }
    await expect(dispatcher.dispatch(withoutOperation)).rejects.toThrow('proof')
    const foreignUnsigned = { ...unsigned, authority: { ...unsigned.authority, restoreGeneration: 99 } }
    await expect(dispatcher.dispatch({ ...foreignUnsigned, ownerProof: productProof('task_mutate', 'request', foreignUnsigned) })).rejects.toThrow('authority')
    expect(await readdir(join(root, 'tasks', 'legacy'))).toEqual([])
  })

  test('rejects a fence for any other published team identity before any write', async () => {
    const { root, dispatcher } = await fixture({ denyOwnerLocalWrites: false })
    await expect(dispatcher.dispatch(taskRequest(createCommand(), { grantRevision: 'd'.repeat(64), identityChecksum: 'e'.repeat(64) }))).rejects.toThrow('team identity')
    const republished = `${JSON.stringify({ schemaVersion: 1, teamId: `team_${'f'.repeat(32)}`, createdAt: '2026-09-25T00:00:00.000Z' }, null, 2)}\n`
    await writeFile(join(root, 'teams', 'legacy', 'team.identity.json'), republished)
    const republishedFence = { grantRevision: 'd'.repeat(64), identityChecksum: createHash('sha256').update(republished).digest('hex') }
    await expect(dispatcher.dispatch(taskRequest(createCommand(), republishedFence))).rejects.toThrow('team identity')
    await rm(join(root, 'teams', 'legacy', 'team.identity.json'))
    await expect(dispatcher.dispatch(taskRequest(createCommand()))).rejects.toThrow('team identity')
    expect(await readdir(join(root, 'tasks', 'legacy'))).toEqual([])
  })

  test('leaves the legacy control envelope on its own route', () => {
    const legacy = taskRequest(createCommand())
    const { ownerEffectFence: _, ...authority } = legacy.authority
    expect(isProductOwnerBoundEnvelope({ ...legacy, authority })).toBe(false)
  })
})

describe('Product message envelopes', () => {
  const persistPayload = { schemaVersion: 1, teamId: stableAuthority.teamId, clientMessageId: 'client_message_product-wire', text: 'hello from the browser' }
  const deliverPayload = { teamId: stableAuthority.teamId, messageId: `message_${'5'.repeat(32)}`, clientMessageId: 'client_message_product-wire', text: 'hello from the browser' }

  test('persists and delivers through the message port and signs Product responses', async () => {
    const calls: Parameters<HostedTeamMessagePort['dispatch']>[0][] = []
    const { dispatcher } = await fixture({
      denyOwnerLocalWrites: true,
      messages: { dispatch: async input => {
        calls.push(input)
        return input.operation === 'message_persist'
          ? { schemaVersion: 2, kind: 'persisted', receipt: { schemaVersion: 1, teamId: stableAuthority.teamId, messageId: deliverPayload.messageId, clientMessageId: persistPayload.clientMessageId, persistence: 'durable' } }
          : { schemaVersion: 2, kind: 'delivered' }
      } },
    })
    const persist = productRequest('message_persist', persistPayload)
    expect(productVerifiedPayload(persist, (await dispatcher.dispatch(persist))!)).toMatchObject({ schemaVersion: 2, kind: 'persisted' })
    const deliver = productRequest('message_deliver', deliverPayload)
    expect(productVerifiedPayload(deliver, (await dispatcher.dispatch(deliver))!)).toEqual({ schemaVersion: 2, kind: 'delivered' })
    expect(calls.map(call => call.operation)).toEqual(['message_persist', 'message_deliver'])
    expect(calls[0]!.authority).toEqual({ actorId: 'actor_product', ...stableAuthority })
    expect(calls[0]!.payload).toEqual(persistPayload)
  })

  test('never reaches the message port with a stale identity fence or a wrong exchange id', async () => {
    const { dispatcher, messageCalls } = await fixture({ denyOwnerLocalWrites: true })
    await expect(dispatcher.dispatch(productRequest('message_persist', persistPayload, { grantRevision: 'd'.repeat(64), identityChecksum: 'e'.repeat(64) }))).rejects.toThrow('team identity')
    const { ownerProof: _, ...unsigned } = productRequest('message_deliver', deliverPayload)
    const taskIdForMessage = { ...unsigned, exchangeId: `task-request_${'9'.repeat(32)}` }
    await expect(dispatcher.dispatch({ ...taskIdForMessage, ownerProof: productProof('message_deliver', 'request', taskIdForMessage) })).rejects.toThrow('owner-bound request')
    expect(messageCalls).toEqual([])
  })
})
