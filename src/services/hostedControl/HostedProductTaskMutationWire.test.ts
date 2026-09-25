import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import { HOSTED_TEAM_MESSAGE_PROOF_DOMAIN } from './HostedControlServer.js'
import { isProductTaskMutationEnvelope } from './HostedProductTaskMutationWire.js'
import { HostedTaskMutationService } from './HostedTaskMutationService.js'
import { HostedTaskMutationWal } from './HostedTaskMutationWal.js'
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

/** Mirrors Product hostedTeamMessageOrchestratorAuthority.proof: the operation is signed. */
function productProof(direction: 'request' | 'response', envelope: Record<string, unknown>): string {
  return createHmac('sha256', secret)
    .update(`${HOSTED_TEAM_MESSAGE_PROOF_DOMAIN}\u0000task_mutate\u0000${direction}\u0000${JSON.stringify(envelope)}`)
    .digest('hex')
}

/** Mirrors Product exchangeOwnerMutation: the browser grant fence rides inside the authority. */
function productRequest(command: HostedTaskMutationCommand, patch: Record<string, unknown> = {}) {
  const { deploymentId, bootId, restoreGeneration, workspaceId, mountBinding, teamId } = stableAuthority
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `task-request_${'9'.repeat(32)}`,
    operation: 'task_mutate',
    ownerBinding,
    authority: {
      actorId: 'actor_product',
      deploymentId, bootId, restoreGeneration, workspaceId, mountBinding, teamId,
      ownerEffectFence: { grantRevision: 'd'.repeat(64), identityChecksum: 'e'.repeat(64) },
    },
    payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) },
    ...patch,
  }
  return { ...unsigned, ownerProof: productProof('request', unsigned) }
}

/** The response checks Product applies before parsing the task-board payload. */
function productVerifiedPayload(request: Record<string, unknown>, response: Record<string, unknown>): Record<string, unknown> {
  expect(Object.keys(response).sort()).toEqual(['authority', 'exchangeId', 'operation', 'ownerBinding', 'ownerProof', 'payload', 'schemaVersion'])
  expect(response.exchangeId).toBe(request.exchangeId)
  expect(JSON.stringify(response.authority)).toBe(JSON.stringify(request.authority))
  const { ownerProof, ...unsigned } = response
  expect(ownerProof).toBe(productProof('response', {
    schemaVersion: unsigned.schemaVersion, exchangeId: unsigned.exchangeId, operation: unsigned.operation,
    ownerBinding: unsigned.ownerBinding, authority: unsigned.authority, payload: unsigned.payload,
  }))
  return response.payload as Record<string, unknown>
}

async function fixture(denyOwnerLocalWrites: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-product-task-wire-')); roots.push(root)
  await mkdir(join(root, 'teams', 'legacy'), { recursive: true })
  await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
  const tasks = new HostedTaskMutationService({
    claudeRoot: root, legacyKey: 'legacy', authority: stableAuthority, denyOwnerLocalWrites,
    wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), stableAuthority.teamId),
  })
  const dispatcher = new HostedControlDispatcher({
    secret,
    authority: stableAuthority,
    getOwnerBinding: () => ownerBinding,
    lifecycle: { dispatch: async () => { throw new Error('unexpected lifecycle dispatch') } },
    messages: { dispatch: async () => { throw new Error('unexpected message dispatch') } },
    tasks,
  })
  return { root, dispatcher }
}

function createCommand(): HostedTaskMutationCommand {
  return { schemaVersion: 1, kind: 'create_task', commandId: 'command_product_wire', idempotencyKey: 'idem:product-wire', teamId: stableAuthority.teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'From the browser', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
}

describe('Product task_mutate envelope', () => {
  test('commits a Product-signed create and returns the Product task-board payload with exact self-write effects', async () => {
    const { root, dispatcher } = await fixture(false)
    let command = createCommand()
    let payload: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = productRequest(command)
      expect(isProductTaskMutationEnvelope(request)).toBe(true)
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

    const replay = productVerifiedPayload(productRequest(command), (await dispatcher.dispatch(productRequest(command)))!)
    expect(Object.keys(replay).sort()).toEqual(['currentSourceGeneration', 'kind', 'payloadFingerprint', 'receipt', 'schemaVersion'])
    expect(replay.kind).toBe('idempotent_replay')
  })

  test('keeps the Owner read-only outside personal-host and answers with Product unavailable', async () => {
    const { root, dispatcher } = await fixture(true)
    const request = productRequest(createCommand())
    expect(productVerifiedPayload(request, (await dispatcher.dispatch(request))!)).toEqual({ schemaVersion: 1, kind: 'unavailable', retryAfterMs: null })
    expect(await readdir(join(root, 'tasks', 'legacy'))).toEqual([])
  })

  test('rejects a forged proof, an unsigned operation, and a foreign authority before any write', async () => {
    const { root, dispatcher } = await fixture(false)
    const forged = { ...productRequest(createCommand()), ownerProof: 'f'.repeat(64) }
    await expect(dispatcher.dispatch(forged)).rejects.toThrow('proof')
    const legacyProof = productRequest(createCommand())
    const { ownerProof: _, ...unsigned } = legacyProof
    const withoutOperation = { ...unsigned, ownerProof: createHmac('sha256', secret).update(`${HOSTED_TEAM_MESSAGE_PROOF_DOMAIN}\u0000request\u0000${JSON.stringify(unsigned)}`).digest('hex') }
    await expect(dispatcher.dispatch(withoutOperation)).rejects.toThrow('proof')
    const foreign = productRequest(createCommand(), { authority: { ...legacyProof.authority, restoreGeneration: 99 } })
    await expect(dispatcher.dispatch(foreign)).rejects.toThrow('authority')
    expect(await readdir(join(root, 'tasks', 'legacy'))).toEqual([])
  })

  test('leaves the legacy control envelope on its own route', () => {
    const legacy = productRequest(createCommand())
    const { ownerEffectFence: _, ...authority } = legacy.authority
    expect(isProductTaskMutationEnvelope({ ...legacy, authority })).toBe(false)
  })
})
