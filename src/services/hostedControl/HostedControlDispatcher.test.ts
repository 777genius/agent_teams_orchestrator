import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import { HostedLifecycleCommandService } from './HostedLifecycleCommandService.js'
import { HOSTED_LIFECYCLE_PROOF_DOMAIN, HOSTED_TEAM_MESSAGE_PROOF_DOMAIN } from './HostedControlServer.js'
import { productOwnerBoundProof } from './HostedProductOwnerBoundEnvelope.js'
import { createHostedRawDomainProof } from './ownerProof.js'
import type { HostedControlOwnerBinding, HostedControlStableAuthority } from './protocol.js'

const secret = Buffer.alloc(32, 3)
const ownerBinding: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_dispatcher',
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_dispatcher',
  socketIdentity: { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 },
}
const authority: HostedControlStableAuthority = {
  deploymentId: `deployment_${'3'.repeat(32)}`,
  bootId: `boot_${'4'.repeat(32)}`,
  restoreGeneration: 0,
  workspaceId: `workspace_${'1'.repeat(32)}`,
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'b'.repeat(32)}`,
}
const publishedTeamIdentity = {
  schemaVersion: 1,
  teamId: authority.teamId,
  createdAt: '2026-09-24T00:00:00.000Z',
  originDeploymentId: authority.deploymentId,
}
const publishedIdentityChecksum = createHash('sha256')
  .update(`${JSON.stringify(publishedTeamIdentity, null, 2)}\n`)
  .digest('hex')
const lifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: authority.workspaceId,
  teamId: authority.teamId,
  deploymentId: authority.deploymentId,
  restoreGeneration: authority.restoreGeneration,
  bootId: authority.bootId,
  resourceRevision: 'revision_admitted',
  mountGeneration: authority.mountBinding.mountGeneration,
  ownerEffectFence: {
    grantRevision: '1'.repeat(64),
    identityChecksum: publishedIdentityChecksum,
  },
}
const lifecycleContext = {
  actorId: lifecycleAuthority.actorId,
  sessionId: 'session-a',
  deploymentId: lifecycleAuthority.deploymentId,
  bootId: lifecycleAuthority.bootId,
  requestId: 'request-a',
  authorizedScope: 'owner',
  deadlineAtMs: 1,
}
const lifecycleAuthorization = {
  grantId: 'grant_command01',
  authorizationGeneration: 'authorization-generation_command01',
  deploymentId: lifecycleAuthority.deploymentId,
  bootId: lifecycleAuthority.bootId,
  resourceRevision: 'revision_admitted',
  actorId: lifecycleAuthority.actorId,
  workspaceId: lifecycleAuthority.workspaceId,
  teamId: lifecycleAuthority.teamId,
  restoreGeneration: lifecycleAuthority.restoreGeneration,
  mountGeneration: lifecycleAuthority.mountGeneration,
  ownerEffectFence: lifecycleAuthority.ownerEffectFence,
}

describe('HostedControlDispatcher response decoding', () => {
  test('accepts the Product published canonical TeamIdentity checksum as the signed lifecycle fence', async () => {
    await expect(lifecycleDispatcher({
      payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null,
    }).dispatch(signedLifecycleRequest())).resolves.toMatchObject({
      ownerEffectFence: { identityChecksum: publishedIdentityChecksum },
    })
  })

  test('accepts exact signed launch-plan admission and rejects extra request or response fields', async () => {
    const planGeneration = `plan-generation_${'a'.repeat(64)}`
    const response = {
      payload: { schemaVersion: 1, kind: 'admitted', workspaceId: authority.workspaceId,
        teamId: authority.teamId, planGeneration },
      resourceRevision: null,
    }
    const valid = signedPlanAdmissionRequest(planGeneration)
    await expect(lifecycleDispatcher(response).dispatch(valid)).resolves.toMatchObject({
      operation: 'admit_launch_plan', payload: { kind: 'admitted', planGeneration },
    })
    const extended = signedPlanAdmissionRequest(planGeneration, { planJson: '{}' })
    await expect(lifecycleDispatcher(response).dispatch(extended)).rejects.toThrow('keys')
    await expect(lifecycleDispatcher({
      payload: { ...response.payload, planJson: '{}' }, resourceRevision: null,
    }).dispatch(valid)).rejects.toThrow('keys')
  })

  test('rejects lifecycle extension fields before creating a response proof', async () => {
    const dispatcher = new HostedControlDispatcher({
      secret,
      authority,
      getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({
        payload: { schemaVersion: 1, kind: 'not_found', extension: true },
        resourceRevision: null,
      }) },
      messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'not_found' }) },
    })
    await expect(dispatcher.dispatch(signedLifecycleRequest())).rejects.toThrow('keys')
  })

  test('rejects malformed message receipts before creating a response proof', async () => {
    const dispatcher = new HostedControlDispatcher({
      secret,
      authority,
      getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({ payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null }) },
      verifyOwnerEffectFence: async () => 'current',
      messages: { dispatch: async () => ({
        schemaVersion: 2,
        kind: 'persisted',
        receipt: { schemaVersion: 1, teamId: authority.teamId, extension: true },
        runtimeDelivery: 'delivered',
      }) },
    })
    await expect(dispatcher.dispatch(signedMessageRequest())).rejects.toThrow('keys')
  })

  test('binds the persistence receipt and invalid_recipient to the requested recipient', async () => {
    const receipt = {
      schemaVersion: 1, teamId: authority.teamId, messageId: `message_${'e'.repeat(32)}`,
      clientMessageId: 'client_message_dispatcher', persistence: 'durable',
    }
    const respond = (payload: Record<string, unknown>) => new HostedControlDispatcher({
      secret,
      authority,
      getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({ payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null }) },
      messages: { dispatch: async () => payload },
      verifyOwnerEffectFence: async () => 'current',
    })
    const persisted = (extra: Record<string, unknown>) =>
      ({ schemaVersion: 2, kind: 'persisted', receipt: { ...receipt, ...extra }, runtimeDelivery: 'delivered' })

    await expect(respond(persisted({ recipient: 'alice' })).dispatch(signedMessageRequest('alice')))
      .resolves.toMatchObject({ payload: { receipt: { recipient: 'alice' } } })
    await expect(respond(persisted({})).dispatch(signedMessageRequest('alice'))).rejects.toThrow('keys')
    await expect(respond(persisted({ recipient: 'bob' })).dispatch(signedMessageRequest('alice')))
      .rejects.toThrow('recipient')
    await expect(respond(persisted({ recipient: 'alice' })).dispatch(signedMessageRequest())).rejects.toThrow('keys')

    const invalid = { schemaVersion: 2, kind: 'invalid_recipient' }
    await expect(respond(invalid).dispatch(signedMessageRequest('alice')))
      .resolves.toMatchObject({ payload: invalid })
    await expect(respond(invalid).dispatch(signedMessageRequest())).rejects.toThrow('Invalid message persistence response')
  })

  test('rejects substituted lifecycle receipt revisions and response authorizations', async () => {
    for (const response of [
      lifecycleExecutionResponse({ resultRevision: 'revision_substituted' }),
      lifecycleExecutionResponse({ authorizationRevision: 'revision_substituted', resultRevision: 'revision_substituted' }),
    ]) {
      const dispatcher = lifecycleDispatcher(response)
      await expect(dispatcher.dispatch(signedExecuteRequest('launch'))).rejects.toThrow(/revision|correlation/)
    }
  })

  test('rejects a non-launch receipt for a run other than the commanded run', async () => {
    const dispatcher = lifecycleDispatcher(lifecycleExecutionResponse({ action: 'recover', runId: 'run_replacement' }))
    await expect(dispatcher.dispatch(signedExecuteRequest('recover'))).rejects.toThrow('correlation')
  })

  test('rejects a nested execution conflict whose revision differs from its authorization', async () => {
    const rejected = lifecycleDispatcher(lifecycleConflictExecutionResponse('revision_substituted'))
    await expect(rejected.dispatch(signedExecuteRequest('launch'))).rejects.toThrow()

    const rejectedCorrelated = lifecycleDispatcher(lifecycleConflictExecutionResponse(lifecycleAuthorization.resourceRevision))
    await expect(rejectedCorrelated.dispatch(signedExecuteRequest('launch'))).rejects.toThrow()
  })

  test('accepts only null or a positive retryAfterMs no greater than 60 seconds', async () => {
    for (const retryAfterMs of [60_001, 0, -1, Number.MAX_SAFE_INTEGER]) {
      const dispatcher = lifecycleDispatcher({
        payload: { schemaVersion: 1, kind: 'unavailable', retryAfterMs },
        resourceRevision: null,
      })
      await expect(dispatcher.dispatch(signedLifecycleRequest())).rejects.toThrow('retryAfterMs')
    }
    const accepted = lifecycleDispatcher({
      payload: { schemaVersion: 1, kind: 'unavailable', retryAfterMs: 60_000 },
      resourceRevision: null,
    })
    await expect(accepted.dispatch(signedLifecycleRequest())).resolves.toMatchObject({
      payload: { kind: 'unavailable', retryAfterMs: 60_000 },
    })
  })

  test('does not apply the lifecycle retry cap to hosted message responses', async () => {
    const dispatcher = new HostedControlDispatcher({
      secret,
      authority,
      getOwnerBinding: () => ownerBinding,
      lifecycle: { dispatch: async () => ({ payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null }) },
      messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: 60_001 }) },
      verifyOwnerEffectFence: async () => 'current',
    })
    await expect(dispatcher.dispatch(signedMessageRequest())).resolves.toMatchObject({
      payload: { kind: 'unavailable', retryAfterMs: 60_001 },
    })
  })

  test('accepts canonical prepare and get_status operation names', async () => {
    const common = {
      schemaVersion: 1, workspaceId: lifecycleAuthority.workspaceId, teamId: lifecycleAuthority.teamId,
      deploymentId: lifecycleAuthority.deploymentId, bootId: lifecycleAuthority.bootId,
      runId: null, resourceRevision: lifecycleAuthorization.resourceRevision, availableActions: ['launch'],
    }
    await expect(lifecycleDispatcher({
      payload: { ...common, kind: 'prepared', lanes: [{ laneKey: `owner:${authority.teamId}`, backend: 'opencode', status: 'ready' }] },
      resourceRevision: lifecycleAuthorization.resourceRevision,
    }).dispatch(signedLifecycleRequest('prepare'))).resolves.toMatchObject({ operation: 'prepare', payload: { kind: 'prepared' } })
    await expect(lifecycleDispatcher({
      payload: { ...common, kind: 'status', recentCommands: [] },
      resourceRevision: lifecycleAuthorization.resourceRevision,
    }).dispatch(signedLifecycleRequest('get_status'))).resolves.toMatchObject({ operation: 'get_status', payload: { kind: 'status' } })
  })

  test('pins the recent commands golden to the Desktop identifier contract', async () => {
    const bytes = await readFile(new URL(
      './fixtures/hosted-lifecycle-recent-commands-v1.json', import.meta.url,
    ))
    expect(bytes.byteLength).toBe(739)
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('4a94e072a308173fb921f8644ebdc7ea94e3cd9e8d3e40cb1084da5b256b11b5')
    const golden = JSON.parse(bytes.toString('utf8'))
    expect(golden).toMatchObject({ schemaVersion: 1, contract: 'hosted-lifecycle-recent-commands-v1' })
    expect(authority.deploymentId).toBe('deployment_33333333333333333333333333333333')
    expect(authority.bootId).toBe('boot_44444444444444444444444444444444')
    expect(golden.recentCommands[0].result.workspaceId)
      .toBe('workspace_11111111111111111111111111111111')
    expect(golden.recentCommands[0].result.runId).toBe('run_22222222222222222222222222222222')
    expect(golden.recentCommands[1].result.workspaceId)
      .toBe('workspace_11111111111111111111111111111111')
  })

  test('accepts the versioned recent commands golden', async () => {
    const golden = JSON.parse(await readFile(new URL(
      './fixtures/hosted-lifecycle-recent-commands-v1.json', import.meta.url,
    ), 'utf8'))
    await expect(lifecycleDispatcher(statusResponse(golden.recentCommands))
      .dispatch(signedLifecycleRequest('get_status'))).resolves.toMatchObject({
      payload: { recentCommands: golden.recentCommands },
    })
  })

  test('rejects operator_required as a settled execute or replay result', async () => {
    for (const operation of ['execute', 'replay_lookup'] as const) {
      const response = lifecycleExecutionResponse()
      const payload = {
        ...response.payload,
        result: {
          schemaVersion: 1, kind: 'operator_required', action: 'launch',
          commandId: 'lifecycle-command_command01', workspaceId: lifecycleAuthority.workspaceId,
          teamId: lifecycleAuthority.teamId,
        },
      }
      await expect(lifecycleDispatcher({ ...response, payload })
        .dispatch(signedDurableRequest(operation))).rejects.toThrow('result kind')
    }
  })

  test('rejects duplicate IDs, non-exact keys, and recent result correlation mismatches', async () => {
    const base = recentCommand()
    const invalid = [
      [base, { ...base }],
      [{ ...base, extension: true }],
      [{ action: base.action, commandId: base.commandId }],
      [{ ...base, result: { ...base.result, extension: true } }],
      [{ ...base, result: { schemaVersion: 1, kind: 'operator_required' } }],
      [{ ...base, result: { ...base.result, workspaceId: 'workspace-substituted' } }],
      [{ ...base, result: { ...base.result, teamId: `team_${'c'.repeat(32)}` } }],
      [{ ...base, result: { ...base.result, action: 'stop' } }],
      [{ ...base, result: { ...base.result, commandId: 'lifecycle-command_command02' } }],
    ]
    for (const recentCommands of invalid) {
      await expect(lifecycleDispatcher(statusResponse(recentCommands))
        .dispatch(signedLifecycleRequest('get_status'))).rejects.toThrow()
    }
  })

  test('rejects a signed identity fence that differs from the lifecycle authority', async () => {
    const request = signedLifecycleRequest()
    const unsigned = { ...request, ownerEffectFence: { ...lifecycleAuthority.ownerEffectFence, identityChecksum: '0'.repeat(64) } }
    delete (unsigned as Record<string, unknown>).ownerProof
    const forged = rawSigned(unsigned)
    await expect(lifecycleDispatcher({
      payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null,
    }).dispatch(forged)).rejects.toThrow('authority')
  })

  test('rejects a signed grant revision that differs from the lifecycle authority', async () => {
    const request = signedLifecycleRequest()
    const unsigned = { ...request, ownerEffectFence: { ...lifecycleAuthority.ownerEffectFence, grantRevision: '0'.repeat(64) } }
    delete (unsigned as Record<string, unknown>).ownerProof
    await expect(lifecycleDispatcher({
      payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null,
    }).dispatch(rawSigned(unsigned))).rejects.toThrow('authority')
  })

  test('rejects a signed lifecycle request after active Owner binding changes', async () => {
    const dispatcher = new HostedControlDispatcher({
      secret,
      authority,
      getOwnerBinding: () => ({ ...ownerBinding, ownerGeneration: ownerBinding.ownerGeneration + 1 }),
      lifecycle: { dispatch: async () => ({ payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null }) },
      messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'not_found' }) },
    })
    await expect(dispatcher.dispatch(signedLifecycleRequest())).rejects.toThrow('owner binding')
  })

  test('rejects a stale identity even when its envelope and authority agree if the proof is stale', async () => {
    const request = signedLifecycleRequest()
    const staleFence = { ...lifecycleAuthority.ownerEffectFence, identityChecksum: '0'.repeat(64) }
    request.ownerEffectFence = staleFence
    const payload = request.payload as Record<string, unknown>
    payload.authority = { ...(payload.authority as Record<string, unknown>), ownerEffectFence: staleFence }
    await expect(lifecycleDispatcher({
      payload: { schemaVersion: 1, kind: 'not_found' }, resourceRevision: null,
    }).dispatch(request)).rejects.toThrow('proof')
  })

  test('preserves the durable expected revision across execute and replay lookup decisions', async () => {
    for (const operation of ['execute', 'replay_lookup'] as const) {
      for (const kind of ['not_started', 'started', 'operator_required', 'idempotency_mismatch'] as const) {
        const dispatcher = lifecycleServiceDispatcher(operation, kind)
        await expect(dispatcher.dispatch(signedDurableRequest(operation))).resolves.toMatchObject({
          operation,
          payload: { kind, durableCommand: wireDurable(lifecycleCommand('launch')) },
        })
      }
    }
  })
})

function lifecycleDispatcher(response: {
  payload: Record<string, unknown>
  resourceRevision: string | null
}): HostedControlDispatcher {
  return new HostedControlDispatcher({
    secret,
    authority,
    getOwnerBinding: () => ownerBinding,
    lifecycle: { dispatch: async () => response },
    messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'not_found' }) },
  })
}

function recentCommand() {
  return {
    action: 'launch', commandId: 'lifecycle-command_command01',
    result: {
      schemaVersion: 1, kind: 'accepted', action: 'launch', commandId: 'lifecycle-command_command01',
      workspaceId: authority.workspaceId, teamId: authority.teamId,
      runId: 'run_created', resourceRevision: lifecycleAuthorization.resourceRevision,
    },
  }
}

function statusResponse(recentCommands: unknown[]) {
  return {
    payload: {
      schemaVersion: 1, kind: 'status', workspaceId: authority.workspaceId, teamId: authority.teamId,
      deploymentId: authority.deploymentId, bootId: authority.bootId, runId: null,
      resourceRevision: lifecycleAuthorization.resourceRevision, availableActions: ['launch'], recentCommands,
    },
    resourceRevision: lifecycleAuthorization.resourceRevision,
  }
}

function lifecycleServiceDispatcher(
  operation: 'execute' | 'replay_lookup',
  kind: 'not_started' | 'started' | 'operator_required' | 'idempotency_mismatch',
): HostedControlDispatcher {
  const decision = async (input: { durableCommand: Record<string, unknown> }) => ({
    kind,
    durableCommand: input.durableCommand,
  })
  const lifecycle = new HostedLifecycleCommandService({
    getControlState: async () => ({ schemaVersion: 1, kind: 'not_found' }),
    authorize: async () => ({ kind: 'authorized', authorization: lifecycleAuthorization }),
    revalidate: async () => ({ kind: 'valid', authorization: lifecycleAuthorization }),
    execute: operation === 'execute' ? decision : async () => ({ kind: 'unavailable', retryAfterMs: null }),
    replayLookup: operation === 'replay_lookup' ? decision : undefined,
    release: async () => ({ kind: 'released' }),
  }, { isCurrent: () => true }, () => 0)
  return new HostedControlDispatcher({
    secret,
    authority,
    getOwnerBinding: () => ownerBinding,
    lifecycle,
    messages: { dispatch: async () => ({ schemaVersion: 2, kind: 'not_found' }) },
  })
}

function lifecycleExecutionResponse(input: {
  action?: 'launch' | 'recover'
  runId?: string
  authorizationRevision?: string
  resultRevision?: string
} = {}) {
  const action = input.action ?? 'launch'
  const authorization = {
    ...lifecycleAuthorization,
    resourceRevision: input.authorizationRevision ?? lifecycleAuthorization.resourceRevision,
  }
  const command = lifecycleCommand(action)
  const durableCommand = wireDurable(command)
  return {
    payload: {
      schemaVersion: 2,
      kind: 'settled',
      durableCommand,
      authorization,
      result: {
        schemaVersion: 1,
        kind: 'accepted',
        action,
        commandId: 'lifecycle-command_command01',
        workspaceId: lifecycleAuthority.workspaceId,
        teamId: lifecycleAuthority.teamId,
        runId: input.runId ?? (action === 'launch' ? 'run_created' : 'run_original'),
        resourceRevision: input.resultRevision ?? lifecycleAuthorization.resourceRevision,
      },
    },
    resourceRevision: authorization.resourceRevision,
  }
}

function lifecycleConflictExecutionResponse(currentRevision: string) {
  return {
    payload: {
      schemaVersion: 2,
      kind: 'result',
      authorization: lifecycleAuthorization,
      result: {
        schemaVersion: 1,
        kind: 'conflict',
        action: 'launch',
        commandId: 'lifecycle-command_command01',
        workspaceId: lifecycleAuthority.workspaceId,
        teamId: lifecycleAuthority.teamId,
        reason: 'stale_revision',
        currentRevision,
      },
    },
    resourceRevision: lifecycleAuthorization.resourceRevision,
  }
}

function signedLifecycleRequest(operation: 'control_state' | 'prepare' | 'get_status' = 'control_state'): Record<string, unknown> {
  const exchangeId = `lifecycle-request_${'c'.repeat(32)}`
  const unsigned = {
    schemaVersion: 2,
    exchangeId,
    operation,
    provenance: provenance(exchangeId, operation),
    ownerBinding,
    ownerEffectFence: lifecycleAuthority.ownerEffectFence,
    payload: {
      request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId },
      context: lifecycleContext,
      authority: { ...lifecycleAuthority, resourceRevision: null },
    },
  }
  return rawSigned(unsigned)
}

function signedPlanAdmissionRequest(
  expectedPlanGeneration: string,
  extraRequest: Record<string, unknown> = {},
): Record<string, unknown> {
  const operation = 'admit_launch_plan'
  const exchangeId = `lifecycle-request_${'d'.repeat(32)}`
  return rawSigned({
    schemaVersion: 2,
    exchangeId,
    operation,
    provenance: provenance(exchangeId, operation),
    ownerBinding,
    ownerEffectFence: lifecycleAuthority.ownerEffectFence,
    payload: {
      request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId,
        workspaceRoot: '/sandbox/workspace', expectedPlanGeneration, ...extraRequest },
      context: lifecycleContext,
      authority: { ...lifecycleAuthority, resourceRevision: null },
    },
  })
}

function signedExecuteRequest(action: 'launch' | 'recover'): Record<string, unknown> {
  return signedDurableRequest('execute', action)
}

function signedDurableRequest(
  operation: 'execute' | 'replay_lookup',
  action: 'launch' | 'recover' = 'launch',
): Record<string, unknown> {
  const command = lifecycleCommand(action)
  const exchangeId = `lifecycle-request_${'e'.repeat(32)}`
  const unsigned = {
    schemaVersion: 2,
    exchangeId,
    operation,
    provenance: provenance(exchangeId, operation),
    ownerBinding,
    ownerEffectFence: lifecycleAuthority.ownerEffectFence,
    payload: {
      command,
      authorization: lifecycleAuthorization,
      durableCommand: wireDurable(command),
      context: lifecycleContext,
      authority: lifecycleAuthority,
    },
  }
  return rawSigned(unsigned)
}

function lifecycleCommand(action: 'launch' | 'recover') {
  return {
    schemaVersion: 1,
    action,
    commandId: 'lifecycle-command_command01',
    idempotencyKey: 'idempotency_command01',
    workspaceId: lifecycleAuthority.workspaceId,
    teamId: lifecycleAuthority.teamId,
    expectedRevision: lifecycleAuthorization.resourceRevision,
    ...(action === 'recover' ? { runId: 'run_original' } : {}),
  }
}

function wireDurable(command: ReturnType<typeof lifecycleCommand>) {
  const digest = createHash('sha256').update(JSON.stringify([
    'agent-teams.hosted-lifecycle-command/v1', command.schemaVersion, command.action,
    command.commandId, command.idempotencyKey, command.workspaceId, command.teamId,
    command.expectedRevision, command.action === 'launch' ? null : command.runId,
    lifecycleAuthority.ownerEffectFence.grantRevision, lifecycleAuthority.ownerEffectFence.identityChecksum,
  ])).digest('hex')
  return {
    schemaVersion: 1,
    commandFingerprint: { algorithm: 'sha256', version: 1, digest },
    idempotency: { deploymentId: lifecycleAuthority.deploymentId, actorId: lifecycleAuthority.actorId, action: command.action, idempotencyKey: command.idempotencyKey },
    resource: { bootId: lifecycleAuthority.bootId, workspaceId: command.workspaceId, teamId: command.teamId, runId: command.action === 'launch' ? null : command.runId, expectedRevision: command.expectedRevision, restoreGeneration: lifecycleAuthority.restoreGeneration, mountGeneration: lifecycleAuthority.mountGeneration, ownerEffectFence: lifecycleAuthority.ownerEffectFence },
  }
}

function provenance(exchangeId: string, operation: string) {
  return {
    from: { kind: 'controller', deploymentId: lifecycleContext.deploymentId, bootId: lifecycleContext.bootId, actorId: lifecycleContext.actorId, sessionId: lifecycleContext.sessionId },
    to: { kind: 'owner', ownerAuthority: ownerBinding.ownerAuthority, ownerGeneration: ownerBinding.ownerGeneration, ownerSessionId: ownerBinding.ownerSessionId },
    target: { capability: 'hosted-lifecycle-command', exchangeId, operation, workspaceId: lifecycleAuthority.workspaceId, teamId: lifecycleAuthority.teamId },
  }
}

function rawSigned(unsigned: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(unsigned)
  return { ...unsigned, ownerProof: createHostedRawDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', serialized) }
}

/** Product's fenced message envelope; the operation is part of the signed input. */
function signedMessageRequest(recipient?: string): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `message-request_${'d'.repeat(32)}`,
    operation: 'message_send',
    ownerBinding,
    authority: { actorId: 'actor-a', ...authority, ownerEffectFence: lifecycleAuthority.ownerEffectFence },
    payload: {
      schemaVersion: 1,
      teamId: authority.teamId,
      clientMessageId: 'client_message_dispatcher',
      text: 'hello',
      ...(recipient === undefined ? {} : { recipient }),
    },
  }
  return {
    ...unsigned,
    ownerProof: productOwnerBoundProof(secret, HOSTED_TEAM_MESSAGE_PROOF_DOMAIN, 'message_send', 'request', unsigned),
  }
}
