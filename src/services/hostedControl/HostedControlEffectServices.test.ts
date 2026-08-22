import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostedControlEffectServices } from './HostedControlEffectServices.js'
import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const lifecycleAuthority: HostedLifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: 'workspace-a',
  teamId,
  deploymentId: 'deployment-a',
  restoreGeneration: 1,
  bootId: 'boot-a',
  resourceRevision: 'revision_1',
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('createHostedControlEffectServices', () => {
  test('keeps lifecycle unavailable until the sole authority installs atomic effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-effect-services-'))
    roots.push(root)
    const services = createHostedControlEffectServices({
      messageDirectory: join(root, 'messages'),
      teamId,
      lifecycleGuard: { isCurrent: () => true },
      messageGuard: { isCurrent: () => true },
      messageDelivery: { deliver: async () => ({ kind: 'delivered' }) },
    })
    await expect(services.lifecycle.dispatch({
      operation: 'control_state',
      payload: {
        request: { schemaVersion: 1, workspaceId: 'workspace-a', teamId },
        context: {
          actorId: 'actor-a',
          sessionId: 'session-a',
          deploymentId: 'deployment-a',
          bootId: 'boot-a',
          requestId: 'request-a',
          authorizedScope: 'scope_team-lifecycle.write',
          deadlineAtMs: Date.now() + 10_000,
        },
        authority: lifecycleAuthority,
      },
      authority: lifecycleAuthority,
    })).resolves.toEqual({
      payload: { schemaVersion: 1, kind: 'unavailable', retryAfterMs: null },
      resourceRevision: null,
    })
  })
})
