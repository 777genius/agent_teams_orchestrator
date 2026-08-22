import { describe, expect, test } from 'bun:test'
import { HostedControlDispatcher } from './HostedControlDispatcher.js'
import { HOSTED_LIFECYCLE_PROOF_DOMAIN, HOSTED_TEAM_MESSAGE_PROOF_DOMAIN } from './HostedControlServer.js'
import { createHostedDomainProof } from './ownerProof.js'
import type { HostedControlOwnerBinding, HostedControlStableAuthority } from './protocol.js'

const secret = Buffer.alloc(32, 3)
const ownerBinding: HostedControlOwnerBinding = {
  ownerAuthority: 'owner-authority_dispatcher',
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_dispatcher',
  socketIdentity: { device: '1', inode: '2' },
}
const authority: HostedControlStableAuthority = {
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  restoreGeneration: 0,
  workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) },
  teamId: `team_${'b'.repeat(32)}`,
}
const lifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: authority.workspaceId,
  teamId: authority.teamId,
  deploymentId: authority.deploymentId,
  restoreGeneration: authority.restoreGeneration,
  bootId: authority.bootId,
  resourceRevision: 'revision_admitted',
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
}

describe('HostedControlDispatcher response decoding', () => {
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
      messages: { dispatch: async () => ({
        schemaVersion: 2,
        kind: 'persisted',
        receipt: { schemaVersion: 1, teamId: authority.teamId, extension: true },
      }) },
    })
    await expect(dispatcher.dispatch(signedMessageRequest())).rejects.toThrow('keys')
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
    await expect(rejected.dispatch(signedExecuteRequest('launch'))).rejects.toThrow('conflict correlation')

    const accepted = lifecycleDispatcher(lifecycleConflictExecutionResponse(lifecycleAuthorization.resourceRevision))
    await expect(accepted.dispatch(signedExecuteRequest('launch'))).resolves.toMatchObject({
      payload: { kind: 'result', result: { kind: 'conflict', currentRevision: lifecycleAuthorization.resourceRevision } },
    })
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
    })
    await expect(dispatcher.dispatch(signedMessageRequest())).resolves.toMatchObject({
      payload: { kind: 'unavailable', retryAfterMs: 60_001 },
    })
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
  return {
    payload: {
      schemaVersion: 2,
      kind: 'result',
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

function signedLifecycleRequest(): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `lifecycle-request_${'c'.repeat(32)}`,
    operation: 'control_state',
    ownerBinding,
    payload: {
      request: { schemaVersion: 1, workspaceId: authority.workspaceId, teamId: authority.teamId },
      context: lifecycleContext,
      authority: { ...lifecycleAuthority, resourceRevision: null },
    },
  }
  return { ...unsigned, ownerProof: createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', unsigned) }
}

function signedExecuteRequest(action: 'launch' | 'recover'): Record<string, unknown> {
  const command = {
    schemaVersion: 1,
    action,
    commandId: 'lifecycle-command_command01',
    idempotencyKey: 'idempotency_command01',
    workspaceId: lifecycleAuthority.workspaceId,
    teamId: lifecycleAuthority.teamId,
    expectedRevision: lifecycleAuthorization.resourceRevision,
    ...(action === 'recover' ? { runId: 'run_original' } : {}),
  }
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `lifecycle-request_${'e'.repeat(32)}`,
    operation: 'execute',
    ownerBinding,
    payload: {
      command,
      authorization: lifecycleAuthorization,
      context: lifecycleContext,
      authority: lifecycleAuthority,
    },
  }
  return { ...unsigned, ownerProof: createHostedDomainProof(secret, HOSTED_LIFECYCLE_PROOF_DOMAIN, 'request', unsigned) }
}

function signedMessageRequest(): Record<string, unknown> {
  const messageAuthority = { actorId: 'actor-a', ...authority }
  const unsigned = {
    schemaVersion: 2,
    exchangeId: `message-request_${'d'.repeat(32)}`,
    operation: 'message_persist',
    ownerBinding,
    authority: messageAuthority,
    payload: {
      schemaVersion: 1,
      teamId: authority.teamId,
      clientMessageId: 'client_message_dispatcher',
      text: 'hello',
    },
  }
  return { ...unsigned, ownerProof: createHostedDomainProof(secret, HOSTED_TEAM_MESSAGE_PROOF_DOMAIN, 'request', unsigned) }
}
