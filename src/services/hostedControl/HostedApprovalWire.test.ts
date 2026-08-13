import { describe, expect, test } from 'bun:test'

import { createHostedRawDomainProof } from './ownerProof.js'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import {
  fingerprintHostedApprovalDelivery,
  HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES,
  HOSTED_APPROVAL_MAX_PAYLOAD_JSON_BYTES,
  HOSTED_APPROVAL_PROOF_DOMAIN,
  HostedApprovalWireDispatcher,
  type HostedApprovalDeliveryRequest,
  type HostedApprovalIngressAuthority,
  type HostedApprovalWirePort,
} from './HostedApprovalWire.js'

const secret = Buffer.alloc(32, 0x2a)
const teamId = `team_${'1'.repeat(32)}`
const runId = `run_${'2'.repeat(32)}`
const workspaceId = `workspace_${'3'.repeat(32)}`
const ownerBinding = {
  ownerAuthority: 'owner-authority_approval-wire',
  ownerGeneration: 7,
  ownerSessionId: 'owner-session_approval-wire',
  socketIdentity: { device: '11', inode: '12', uid: 501, gid: 20, mode: 0o600 },
}
const authority = {
  actorId: 'actor_approval-wire',
  deploymentId: 'deployment_approval-wire',
  bootId: 'boot_approval-wire',
  restoreGeneration: 4,
  workspaceId,
  mountBinding: { mountGeneration: 9, declaredRootHash: 'a'.repeat(64) },
  teamId,
}
const ingressAuthority: HostedApprovalIngressAuthority = {
  deploymentId: authority.deploymentId,
  teamId,
  runId,
  planGeneration: 8,
  laneId: 'secondary:opencode:worker',
  providerId: 'opencode',
  credentialGeneration: 6,
  credentialId: 'credential_approval-wire',
  sessionId: 'session_approval-wire',
  runtimeInstanceId: 'runtime_approval-wire',
  deliveryOwnerId: `member_${'4'.repeat(32)}`,
}

describe('HostedApprovalWireDispatcher', () => {
  test('routes through HostedControlDispatcher only when an approval owner port exists', async () => {
    const request = signed('approval_ingress_ack', {
      outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
      generation: 3,
      ownerId: 'owner_approval-wire',
      leaseToken: 'lease_approval-wire',
    })
    const base = {
      secret,
      authority,
      getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
      messages: { dispatch: async () => ({}) },
    }
    await expect(new HostedControlDispatcher(base).dispatch(request.value, request.line))
      .rejects.toThrow('unavailable')
    await expect(new HostedControlDispatcher({
      ...base,
      approvals: {
        ...ports(),
        acknowledgeIngress: async () => ({ status: 'acknowledged' as const }),
      },
    }).dispatch(request.value, request.line)).resolves.toMatchObject({
      operation: 'approval_ingress_ack', payload: { status: 'acknowledged' },
    })
  })

  test('keeps the canonical raw proof-last golden vector and exact outer envelope', async () => {
    const request = signed('approval_ingress_ack', {
      outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
      generation: 3,
      ownerId: 'owner_approval-wire',
      leaseToken: 'lease_approval-wire',
    })
    expect(request.line.replace(/[0-9a-f]{64}(?="}$)/, 'GOLDEN')).toBe(
      '{"schemaVersion":2,"exchangeId":"approval-request_66666666666666666666666666666666","operation":"approval_ingress_ack","ownerBinding":{"ownerAuthority":"owner-authority_approval-wire","ownerGeneration":7,"ownerSessionId":"owner-session_approval-wire","socketIdentity":{"device":"11","inode":"12","uid":501,"gid":20,"mode":384}},"authority":{"actorId":"actor_approval-wire","deploymentId":"deployment_approval-wire","bootId":"boot_approval-wire","restoreGeneration":4,"workspaceId":"workspace_33333333333333333333333333333333","mountBinding":{"mountGeneration":9,"declaredRootHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"teamId":"team_11111111111111111111111111111111"},"payload":{"outboxId":"runtime_permission:effect:5555555555555555555555555555555555555555555555555555555555555555","generation":3,"ownerId":"owner_approval-wire","leaseToken":"lease_approval-wire"},"ownerProof":"GOLDEN"}',
    )
    const response = await dispatcher({
      ...ports(),
      acknowledgeIngress: async () => ({ status: 'acknowledged' }),
    }).dispatch(request.value, request.line)
    expect(Object.keys(response)).toEqual([
      'schemaVersion', 'exchangeId', 'operation', 'ownerBinding', 'authority',
      'payload', 'ownerProof',
    ])
    expect(response.payload).toEqual({ status: 'acknowledged' })
    const { ownerProof, ...unsignedResponse } = response
    expect(ownerProof).toBe(
      createHostedRawDomainProof(
        secret,
        HOSTED_APPROVAL_PROOF_DOMAIN,
        'response',
        JSON.stringify(unsignedResponse),
      ),
    )
  })

  test('dispatches all four exact product payloads through narrow ports', async () => {
    const calls: string[] = []
    const delivery = deliveryRequest()
    const wire = dispatcher({
      claimIngress: async ({ request, maximumAggregateBytes }) => {
        calls.push(`claim:${request.limit}:${maximumAggregateBytes}`)
        return [ingressRecord()]
      },
      getAdmittedIngressAuthority: async () => ingressAuthority,
      acknowledgeIngress: async (request) => {
        calls.push(`ack:${request.generation}`)
        return { status: 'already_acknowledged' }
      },
      resolveIngressAuthority: async (input) => {
        calls.push(`resolve:${input.laneId}`)
        return {
          status: 'resolved',
          scope: {
            principalId: 'actor_approval-owner', workspaceId, teamId,
            authorityGeneration: 'generation_approval-wire', restoreGeneration: 4,
          },
        }
      },
      authorizeDecision: async (input) => {
        calls.push(`authorize:${input.payloadFingerprint}`)
        return {
          status: 'authorized',
          authorization: {
            token: 'approval_authorization_wire', persistedAuthority: ingressAuthority,
          },
        }
      },
      deliverDecision: async (input) => {
        calls.push(`deliver:${input.payloadFingerprint}`)
        expect(input.request).toEqual(delivery)
        expect(input.payloadFingerprint).toBe(fingerprintHostedApprovalDelivery(delivery))
        return { status: 'idempotent_replay' }
      },
    })

    expect((await dispatch(wire, 'approval_ingress_claim', {
      ownerId: 'owner_approval-wire', leaseToken: 'lease_approval-wire',
      leaseDurationMs: 30_000, limit: 1,
    })).payload).toHaveLength(1)
    expect((await dispatch(wire, 'approval_ingress_ack', {
      outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
      generation: 3, ownerId: 'owner_approval-wire', leaseToken: 'lease_approval-wire',
    })).payload).toEqual({ status: 'already_acknowledged' })
    expect((await dispatch(wire, 'approval_ingress_authority_resolve', ingressAuthority)).payload)
      .toMatchObject({ status: 'resolved', scope: { restoreGeneration: 4 } })
    expect((await dispatch(wire, 'approval_decision_deliver', delivery)).payload)
      .toEqual({ status: 'idempotent_replay' })
    expect(calls).toEqual([
      `claim:1:${8 * 1024 * 1024 - 8 * 1024}`, 'ack:3', `resolve:${ingressAuthority.laneId}`,
      `authorize:${fingerprintHostedApprovalDelivery(delivery)}`,
      `deliver:${fingerprintHostedApprovalDelivery(delivery)}`,
    ])
  })

  test('fails closed before ports on proof, owner, mount, restore, inner authority, and exact-key drift', async () => {
    let calls = 0
    const wire = dispatcher({
      ...ports(),
      resolveIngressAuthority: async () => { calls += 1; return { status: 'unavailable' } },
    })
    const valid = signed('approval_ingress_authority_resolve', ingressAuthority)
    const cases = [
      valid.line.replace(/[0-9a-f](?="}$)/, (digit) => digit === '0' ? '1' : '0'),
      mutate(valid.value, { ownerBinding: { ...ownerBinding, ownerGeneration: 8 } }),
      mutate(valid.value, { authority: { ...authority, restoreGeneration: 5 } }),
      mutate(valid.value, { authority: { ...authority, mountBinding: { ...authority.mountBinding, mountGeneration: 10 } } }),
      mutate(valid.value, { payload: { ...ingressAuthority, teamId: `team_${'9'.repeat(32)}` } }),
      mutate(valid.value, { extra: true }),
    ]
    for (const line of cases) {
      const value = JSON.parse(line) as Record<string, unknown>
      await expect(wire.dispatch(value, line)).rejects.toThrow()
    }
    expect(calls).toBe(0)
  })

  test('bounds claim records and validates deliveryRef rebind in payloadJson', async () => {
    const tooMany = Array.from({ length: 2 }, () => ingressRecord())
    await expect(dispatch(dispatcher({
      ...ports(), claimIngress: async () => tooMany,
    }), 'approval_ingress_claim', {
      ownerId: 'owner_approval-wire', leaseToken: 'lease_approval-wire',
      leaseDurationMs: 30_000, limit: 1,
    })).rejects.toThrow('count')

    await expect(dispatch(dispatcher({
      ...ports(),
      claimIngress: async () => [{
        ...ingressRecord(),
        payloadJson: JSON.stringify({
          ...JSON.parse(ingressRecord().payloadJson),
          deliveryRef: 'delivery_ref_substituted',
        }),
      }],
    }), 'approval_ingress_claim', {
      ownerId: 'owner_approval-wire', leaseToken: 'lease_approval-wire',
      leaseDurationMs: 30_000, limit: 1,
    })).rejects.toThrow('payload')
  })

  test('never serializes a stable delivery ID fingerprint conflict', async () => {
    await expect(dispatch(dispatcher({
      ...ports(), deliverDecision: async () => ({ status: 'conflict' }),
    }), 'approval_decision_deliver', deliveryRequest()))
      .rejects.toThrow('idempotency conflict')
  })

  test('surfaces a durable ambiguous provider call as operator_required', async () => {
    expect((await dispatch(dispatcher({
      ...ports(), authorizeDecision: async () => ({ status: 'operator_required' }),
    }), 'approval_decision_deliver', deliveryRequest())).payload)
      .toEqual({ status: 'operator_required' })
  })

  test('binds authenticated principal into the delivery fingerprint and rejects its omission', async () => {
    const delivery = deliveryRequest()
    const changed = { ...delivery, principal: { kind: 'operator' as const, actorId: 'actor_other-approver' } }
    expect(fingerprintHostedApprovalDelivery(changed))
      .not.toBe(fingerprintHostedApprovalDelivery(delivery))

    const missing = { ...delivery } as Record<string, unknown>
    delete missing.principal
    await expect(dispatch(dispatcher(ports()), 'approval_decision_deliver', missing))
      .rejects.toThrow('keys')
  })

  test('uses an explicit system timeout principal and never a magic synthetic actor', async () => {
    const timeout = {
      ...deliveryRequest(),
      principal: { kind: 'system_timeout' as const },
      decision: 'timeout' as const,
    }
    await expect(dispatch(dispatcher(ports()), 'approval_decision_deliver', timeout))
      .resolves.toMatchObject({ payload: { status: 'unavailable' } })
    await expect(dispatch(dispatcher(ports()), 'approval_decision_deliver', {
      ...timeout, principal: { kind: 'operator', actorId: 'actor_timeout' },
    })).rejects.toThrow('principal')
    await expect(dispatch(dispatcher(ports()), 'approval_decision_deliver', {
      ...deliveryRequest(), principal: { kind: 'system_timeout' },
    })).rejects.toThrow('principal')
  })

  test('rejects every persisted authority drift before delivery effect', async () => {
    for (const field of Object.keys(ingressAuthority) as Array<keyof HostedApprovalIngressAuthority>) {
      let effects = 0
      const persistedAuthority = {
        ...ingressAuthority,
        [field]: alternateAuthorityField(field),
      } as HostedApprovalIngressAuthority
      const pending = dispatch(dispatcher({
        ...ports(),
        authorizeDecision: async () => ({
          status: 'authorized',
          authorization: { token: 'approval_authorization_drift', persistedAuthority },
        }),
        getAdmittedIngressAuthority: async () => ingressAuthority,
        deliverDecision: async () => { effects += 1; return { status: 'delivered' } },
      }), 'approval_decision_deliver', deliveryRequest())
      if (field === 'deploymentId' || field === 'teamId') {
        await expect(pending).rejects.toThrow('binding')
      } else {
        expect((await pending).payload).toEqual({ status: 'unavailable' })
      }
      expect(effects).toBe(0)
    }
  })

  test('passes opaque authorization and fresh exact authority for atomic pre-effect revalidation', async () => {
    const request = deliveryRequest()
    const fingerprint = fingerprintHostedApprovalDelivery(request)
    let effects = 0
    const response = await dispatch(dispatcher({
      ...ports(),
      authorizeDecision: async () => ({
        status: 'authorized',
        authorization: { token: 'approval_authorization_exact', persistedAuthority: ingressAuthority },
      }),
      deliverDecision: async (input) => {
        expect(input.authorization.token).toBe('approval_authorization_exact')
        expect(input.admittedAuthority).toEqual(ingressAuthority)
        expect(input.request.deliveryRef).toBe('delivery_ref_approval-wire')
        expect(input.payloadFingerprint).toBe(fingerprint)
        effects += 1
        return { status: 'delivered' }
      },
    }), 'approval_decision_deliver', request)
    expect(response.payload).toEqual({ status: 'delivered' })
    expect(effects).toBe(1)
  })

  test('returns unavailable without effect when authority changes between authorize and delivery', async () => {
    let effects = 0
    const response = await dispatch(dispatcher({
      ...ports(),
      authorizeDecision: async () => ({
        status: 'authorized',
        authorization: { token: 'approval_authorization_stale', persistedAuthority: ingressAuthority },
      }),
      getAdmittedIngressAuthority: async () => ({ ...ingressAuthority, sessionId: 'session_replaced' }),
      deliverDecision: async () => { effects += 1; return { status: 'delivered' } },
    }), 'approval_decision_deliver', deliveryRequest())
    expect(response.payload).toEqual({ status: 'unavailable' })
    expect(effects).toBe(0)
  })

  test('does not deliver a substituted persisted deliveryRef authorization', async () => {
    let effects = 0
    const pending = dispatch(dispatcher({
      ...ports(),
      authorizeDecision: async ({ request }) => request.deliveryRef === 'delivery_ref_approval-wire'
        ? { status: 'unavailable' as const }
        : { status: 'conflict' as const },
      deliverDecision: async () => { effects += 1; return { status: 'delivered' } },
    }), 'approval_decision_deliver', {
      ...deliveryRequest(), deliveryRef: 'delivery_ref_substituted',
    })
    await expect(pending).rejects.toThrow('idempotency conflict')
    expect(effects).toBe(0)
  })

  test('requires raw bytes and a separately admitted exact eleven-field authority', async () => {
    const request = signed('approval_ingress_authority_resolve', ingressAuthority)
    const approvals = {
      ...ports(),
      getAdmittedIngressAuthority: async () => ingressAuthority,
      resolveIngressAuthority: async () => ({ status: 'unavailable' as const }),
    }
    await expect(new HostedControlDispatcher({
      secret, authority, getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({ payload: {}, resourceRevision: null }) },
      messages: { dispatch: async () => ({}) }, approvals,
    }).dispatch(request.value)).rejects.toThrow('raw frame')

    for (const field of (Object.keys(ingressAuthority) as Array<keyof HostedApprovalIngressAuthority>)
      .filter((key) => key !== 'deploymentId' && key !== 'teamId')) {
      const changed = { ...ingressAuthority, [field]: alternateAuthorityField(field) }
      expect((await dispatch(dispatcher(approvals), 'approval_ingress_authority_resolve', changed)).payload)
        .toEqual({ status: 'unavailable' })
    }
  })

  test('accepts maximal UTF-8 preview serialization and rejects byte overflow, host paths, and summary newlines', async () => {
    const maximal = ingressRecord('\\'.repeat(64 * 1024), 'maximal summary')
    expect(Buffer.byteLength(maximal.payloadJson, 'utf8')).toBeLessThanOrEqual(HOSTED_APPROVAL_MAX_PAYLOAD_JSON_BYTES)
    await expect(dispatch(dispatcher({
      ...ports(), claimIngress: async ({ maximumAggregateBytes }) => {
        expect(maximumAggregateBytes).toBe(HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES)
        return [maximal]
      },
    }), 'approval_ingress_claim', claimRequest())).resolves.toBeDefined()

    for (const record of [
      ingressRecord('😀'.repeat(16_385), 'summary'),
      ingressRecord('safe', 'open /Users/alice/private.txt'),
      ingressRecord('safe', 'line one\nline two'),
    ]) {
      await expect(dispatch(dispatcher({
        ...ports(), claimIngress: async () => [record],
      }), 'approval_ingress_claim', claimRequest())).rejects.toThrow()
    }
  })

  test('accepts a maximal aggregate claim below the reserved frame budget', async () => {
    const records = Array.from({ length: 30 }, (_, index) => {
      const hex = index.toString(16).padStart(64, '0')
      return {
        ...ingressRecord('\\'.repeat(64 * 1024), `record ${index}`),
        outboxId: `runtime_permission:effect:${hex}`,
        effectRef: `effect:${hex}`,
      }
    })
    expect(Buffer.byteLength(JSON.stringify(records), 'utf8'))
      .toBeLessThanOrEqual(HOSTED_APPROVAL_MAX_CLAIM_AGGREGATE_BYTES)
    const response = await dispatch(dispatcher({
      ...ports(), claimIngress: async () => records,
    }), 'approval_ingress_claim', { ...claimRequest(), limit: 100 })
    expect((response.payload as unknown[]).length).toBe(30)
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8') + 1).toBeLessThan(8 * 1024 * 1024)
  })

  test('correlates every claimed record to the lease request and rejects duplicate IDs', async () => {
    const base = ingressRecord()
    for (const records of [
      [{ ...base, lease: null }],
      [{ ...base, lease: { ...base.lease!, ownerId: 'owner_other' } }],
      [{ ...base, acknowledgedAtIso: '2026-08-13T10:00:03.000Z' }],
      [base, base],
    ]) {
      await expect(dispatch(dispatcher({
        ...ports(), claimIngress: async () => records,
      }), 'approval_ingress_claim', { ...claimRequest(), limit: 2 })).rejects.toThrow()
    }
  })
})

function dispatcher(approvals: HostedApprovalWirePort): HostedApprovalWireDispatcher {
  return new HostedApprovalWireDispatcher({
    secret, authority, getOwnerBinding: () => ownerBinding, approvals,
  })
}

function ports(): HostedApprovalWirePort {
  return {
    claimIngress: async () => [],
    acknowledgeIngress: async () => ({ status: 'unavailable' }),
    getAdmittedIngressAuthority: async () => ingressAuthority,
    resolveIngressAuthority: async () => ({ status: 'unavailable' }),
    authorizeDecision: async () => ({
      status: 'authorized',
      authorization: { token: 'approval_authorization_wire', persistedAuthority: ingressAuthority },
    }),
    deliverDecision: async () => ({ status: 'unavailable' }),
  }
}

function signed(operation: Parameters<typeof dispatch>[1], payload: unknown): {
  value: Record<string, unknown>
  line: string
} {
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `approval-request_${'6'.repeat(32)}`,
    operation,
    ownerBinding,
    authority,
    payload,
  }
  const serialized = JSON.stringify(unsigned)
  const ownerProof = createHostedRawDomainProof(
    secret, HOSTED_APPROVAL_PROOF_DOMAIN, 'request', serialized,
  )
  const value = { ...unsigned, ownerProof }
  return { value, line: JSON.stringify(value) }
}

async function dispatch(
  wire: HostedApprovalWireDispatcher,
  operation:
    | 'approval_ingress_claim'
    | 'approval_ingress_ack'
    | 'approval_ingress_authority_resolve'
    | 'approval_decision_deliver',
  payload: unknown,
): Promise<Record<string, unknown>> {
  const request = signed(operation, payload)
  return wire.dispatch(request.value, request.line)
}

function mutate(value: Record<string, unknown>, patch: Record<string, unknown>): string {
  const unsigned = { ...value, ...patch }
  delete unsigned.ownerProof
  const serialized = JSON.stringify(unsigned)
  return JSON.stringify({
    ...unsigned,
    ownerProof: createHostedRawDomainProof(
      secret, HOSTED_APPROVAL_PROOF_DOMAIN, 'request', serialized,
    ),
  })
}

function deliveryRequest(): HostedApprovalDeliveryRequest {
  return {
    providerDeliveryId: 'provider_delivery_approval-wire',
    principal: { kind: 'operator', actorId: 'actor_approval-owner' },
    deliveryRef: 'delivery_ref_approval-wire',
    approvalId: `approval_${'7'.repeat(32)}`,
    approvalGeneration: `generation_runtime-permission-${'8'.repeat(64)}`,
    decision: 'allow',
    partition: { teamId, runId },
    requestId: 'request_approval-wire',
  }
}

function claimRequest() {
  return {
    ownerId: 'owner_approval-wire', leaseToken: 'lease_approval-wire',
    leaseDurationMs: 30_000, limit: 1,
  }
}

function alternateAuthorityField(field: keyof HostedApprovalIngressAuthority): string | number {
  if (field === 'planGeneration' || field === 'credentialGeneration') return 999
  if (field === 'teamId') return `team_${'9'.repeat(32)}`
  if (field === 'runId') return `run_${'9'.repeat(32)}`
  if (field === 'deliveryOwnerId') return `member_${'9'.repeat(32)}`
  if (field === 'deploymentId') return 'deployment_other'
  if (field === 'providerId') return 'codex'
  return `${String(ingressAuthority[field])}-other`
}

function ingressRecord(content = 'bun test', summary = 'Run the bounded test command?') {
  const deliveryRef = 'delivery_ref_approval-wire'
  return {
    outboxVersion: 1 as const,
    outboxId: `runtime_permission:effect:${'5'.repeat(64)}`,
    commandId: 'request_approval-wire',
    effectRef: `effect:${'5'.repeat(64)}`,
    deliveryRef,
    authority: ingressAuthority,
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      deliveryRef,
      category: 'command',
      summary,
      expiresAtMs: 1_800_000_000_000,
      preview: {
        previewRef: 'approval_preview_wire',
        content, byteLength: Buffer.byteLength(content, 'utf8'), truncated: false, isBinary: false,
      },
    }),
    observedAtIso: '2026-08-13T10:00:00.000Z',
    acceptedAtIso: '2026-08-13T10:00:01.000Z',
    lease: {
      generation: 3,
      ownerId: 'owner_approval-wire',
      leaseToken: 'lease_approval-wire',
      claimedAtIso: '2026-08-13T10:00:02.000Z',
      leaseExpiresAtIso: '2026-08-13T10:01:02.000Z',
    },
    acknowledgedAtIso: null,
  }
}
