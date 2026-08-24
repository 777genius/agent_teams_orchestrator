import { describe, expect, test } from 'bun:test'
import { createHostedControlProof } from './ownerProof.js'
import {
  decodeHostedTaskMutationCommand,
  decodeHostedTaskMutationRequest,
  decodeHostedTaskMutationResponse,
  fingerprintHostedTaskCommand,
  hostedControlGoldenRequestFixture,
  OWNER_PROOF_ALGORITHM,
  OWNER_PROOF_DOMAIN,
  type HostedTaskMutationCommand,
} from './protocol.js'

describe('hosted control request protocol', () => {
  test('keeps the golden request and exact proof domain/direction vector stable', () => {
    const unsigned = hostedControlGoldenRequestFixture()
    const secret = Buffer.alloc(32, 9)
    const request = { ...unsigned, ownerProof: createHostedControlProof(secret, 'request', unsigned) }
    expect(OWNER_PROOF_ALGORITHM).toBe('hmac-sha256')
    expect(OWNER_PROOF_DOMAIN).toBe('agent-teams.hosted-task-board.owner-proof/v1')
    expect(request.ownerProof).toBe('e9f67daf6a97c080775ad9d983e1d730334488e09ed5414f2dc82700d58ff82f')
    expect(createHostedControlProof(secret, 'response', unsigned)).toBe('1c155dfe6fd35d851506224432b11833e16c9440fcedde1deec6efd7377a9346')
    expect(decodeHostedTaskMutationRequest(request)).toEqual(request)
  })

  test('keeps fingerprint arrays stable for all six command operations', () => {
    const base = { schemaVersion: 1 as const, commandId: 'command_vector-1', idempotencyKey: 'vector:key:1', teamId: `team_${'1'.repeat(32)}`, expectedSourceGeneration: 'generation_vector-1', expectedRevision: 'revision_vector-1' }
    const taskId = `task_${'2'.repeat(32)}`; const memberId = `member_${'3'.repeat(32)}`
    const vectors: Array<[HostedTaskMutationCommand, string]> = [
      [{ ...base, kind: 'create_task', subject: 'Vector', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }, 'KPErnvUORzw6tcIhzJW8buVyMZSE1QWrUJLV4iX4jM4'],
      [{ ...base, kind: 'update_details', taskId, subject: 'Updated', description: 'Details' }, 'SLgK1MxXU1Y4dQ2Wig_cFSW8ksxRBVbOp2RuLliut8Q'],
      [{ ...base, kind: 'update_owner', taskId, ownerId: memberId }, '-w3dQzIA5FYLDCQufdWeyFujwKQqrevF6bwr31efjHg'],
      [{ ...base, kind: 'update_status', taskId, status: 'completed' }, 'uIxjRGB-wlp-ZMLm3arbs8J-ahCmz9FUbDALJ9iKss8'],
      [{ ...base, kind: 'move_task', taskId, column: 'review', order: 7 }, 'KB9UQG9HowIwmpfXSf-MkTNF8HUkPeNtsB1GLqQq1iY'],
      [{ ...base, kind: 'reorder_column', column: 'todo', orderedTaskIds: [taskId] }, 'RqALq7BBl-9wjuKpYic7F-tYtBIQPOKwRTtVZfOXaUw'],
    ]
    for (const [command, fingerprint] of vectors) expect(fingerprintHostedTaskCommand(command)).toBe(fingerprint)
  })

  test('rejects request and command extension keys plus legacy vocabulary', () => {
    const unsigned = hostedControlGoldenRequestFixture(); const secret = Buffer.alloc(32, 9)
    const request = { ...unsigned, ownerProof: createHostedControlProof(secret, 'request', unsigned) }
    expect(() => decodeHostedTaskMutationRequest({ ...request, extra: true })).toThrow('request keys')
    expect(() => decodeHostedTaskMutationCommand({ ...unsigned.payload.command, extra: true })).toThrow('create_task keys')
    expect(() => decodeHostedTaskMutationRequest({ ...request, operation: 'taskMutation' })).toThrow('request header')
    expect(() => decodeHostedTaskMutationCommand({ ...unsigned.payload.command, kind: 'createTask' })).toThrow('command.kind')
    expect(() => decodeHostedTaskMutationCommand({ ...unsigned.payload.command, status: 'open' })).toThrow('status')
    expect(() => decodeHostedTaskMutationCommand({ ...unsigned.payload.command, column: 'backlog' })).toThrow('column')
    expect(() => decodeHostedTaskMutationRequest({
      ...request,
      ownerBinding: { ...request.ownerBinding, ownerAuthority: 'owner_authority1' },
    })).toThrow('ownerAuthority')
    expect(() => decodeHostedTaskMutationRequest({
      ...request,
      ownerBinding: { ...request.ownerBinding, ownerSessionId: `owner_session_${'3'.repeat(32)}` },
    })).toThrow('ownerSessionId')
  })

  test('allows TAB/LF/CR in descriptions but rejects every other C0 byte and DEL', () => {
    const command = hostedControlGoldenRequestFixture().payload.command
    expect(decodeHostedTaskMutationCommand({ ...command, description: 'tab\tline\nreturn\r' })).toHaveProperty('description', 'tab\tline\nreturn\r')
    for (const code of [...Array.from({ length: 32 }, (_, index) => index).filter(code => code !== 9 && code !== 10 && code !== 13), 127]) {
      expect(() => decodeHostedTaskMutationCommand({ ...command, description: `before${String.fromCharCode(code)}after` })).toThrow('description')
    }
  })
})

describe('hosted control response decoding', () => {
  test('normalizes every exact terminal response variant and rejects extra payload keys', () => {
    const request = hostedControlGoldenRequestFixture()
    const generation = request.payload.command.expectedSourceGeneration
    const revision = request.payload.command.expectedRevision
    const fingerprint = request.payload.payloadFingerprint
    const receipt = { schemaVersion: 1, outcome: 'committed', commandId: request.payload.command.commandId, teamId: request.authority.teamId, sourceGeneration: generation, revision, affectedTaskIds: [] }
    const variants: Record<string, unknown>[] = [
      { kind: 'committed', currentSourceGeneration: generation, payloadFingerprint: fingerprint, receipt },
      { kind: 'idempotent_replay', currentSourceGeneration: generation, payloadFingerprint: fingerprint, receipt: { ...receipt, outcome: 'idempotent_replay' } },
      { kind: 'stale_generation', currentSourceGeneration: generation },
      { kind: 'stale_revision', currentSourceGeneration: generation, currentRevision: revision },
      { kind: 'conflict', reason: 'idempotency_mismatch', currentSourceGeneration: generation },
      { kind: 'conflict', reason: 'relationship_conflict', currentSourceGeneration: generation },
      { kind: 'conflict', reason: 'relationship_conflict', currentSourceGeneration: generation, currentRevision: revision },
      { kind: 'conflict', reason: 'state_conflict', currentSourceGeneration: generation, currentRevision: revision },
      { kind: 'not_found' },
      { kind: 'unsafe_active' },
      { kind: 'unavailable' },
      { kind: 'unavailable', retryAfterMs: 5_000 },
    ]
    for (const payload of variants) {
      const response = { schemaVersion: 2, exchangeId: request.exchangeId, operation: 'task_mutate', ownerBinding: request.ownerBinding, authority: request.authority, payload, ownerProof: 'a'.repeat(64) }
      expect(decodeHostedTaskMutationResponse(response).payload as unknown).toEqual(payload)
      expect(() => decodeHostedTaskMutationResponse({ ...response, payload: { ...payload, extra: true } })).toThrow('keys')
    }
  })

  test('rejects malformed nested receipts and extra envelope fields', () => {
    const request = hostedControlGoldenRequestFixture()
    const response = { schemaVersion: 2, exchangeId: request.exchangeId, operation: 'task_mutate', ownerBinding: request.ownerBinding, authority: request.authority, payload: { kind: 'not_found' }, ownerProof: 'a'.repeat(64) }
    expect(() => decodeHostedTaskMutationResponse({ ...response, extra: true })).toThrow('response keys')
    expect(() => decodeHostedTaskMutationResponse({ ...response, payload: { kind: 'committed', currentSourceGeneration: request.payload.command.expectedSourceGeneration, payloadFingerprint: request.payload.payloadFingerprint, receipt: { unexpected: true } } })).toThrow()
  })
})
