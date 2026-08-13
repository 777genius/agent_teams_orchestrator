import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HostedLifecycleAuthority } from './HostedControlDispatcher.js'
import { OpenCodeTeamLifecycleLane } from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import {
  createHostedControlProductionPortFactory,
  createHostedControlProductionPorts,
  HOSTED_LIFECYCLE_EXECUTION_STATE_FILE,
  HOSTED_LIFECYCLE_PLAN_FILE,
  HOSTED_MESSAGE_DIRECTORY,
} from './HostedControlProductionComposition.js'
import type { HostedControlRuntimePortFactoryContext } from './HostedControlRuntime.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const stableAuthority = {
  deploymentId: 'deployment-a',
  bootId: 'boot-a',
  restoreGeneration: 1,
  workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) },
  teamId,
}
const lifecycleAuthority: HostedLifecycleAuthority = {
  actorId: 'actor-a',
  workspaceId: stableAuthority.workspaceId,
  teamId,
  deploymentId: stableAuthority.deploymentId,
  bootId: stableAuthority.bootId,
  restoreGeneration: stableAuthority.restoreGeneration,
  resourceRevision: null,
  mountGeneration: stableAuthority.mountBinding.mountGeneration,
  ownerEffectFence: { grantRevision: '1'.repeat(64), identityChecksum: '2'.repeat(64) },
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
  )
})

describe('createHostedControlProductionPorts', () => {
  test('admits only the private OpenCode plan and roots durable state below the team root', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-composition-')
    await writePlan(teamRoot, 'opencode')
    const ports = await createHostedControlProductionPorts(context(teamRoot))

    const state = await ports.lifecycle.dispatch(controlStateInput())
    expect(state.payload).toMatchObject({ kind: 'control_state', availableActions: ['launch'] })

    const persisted = await ports.messages.dispatch({
      operation: 'message_persist',
      authority: { actorId: 'actor-a', ...stableAuthority },
      payload: {
        schemaVersion: 1,
        teamId,
        clientMessageId: 'client_message_production-test',
        text: 'persist me',
      },
    })
    expect(persisted.kind).toBe('persisted')
    expect(
      await readdir(join(teamRoot, HOSTED_MESSAGE_DIRECTORY)),
    ).toHaveLength(1)
    expect(await readdir(teamRoot)).not.toContain(
      HOSTED_LIFECYCLE_EXECUTION_STATE_FILE,
    )
  })

  test('keeps native lanes capability-false and never creates a missing plan', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-native-')
    await writePlan(teamRoot, 'native')
    const native = await createHostedControlProductionPorts(context(teamRoot))
    expect(
      (await native.lifecycle.dispatch(controlStateInput())).payload.kind,
    ).toBe('unavailable')

    await rm(join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE))
    const missing = await createHostedControlProductionPorts(context(teamRoot))
    expect(
      (await missing.lifecycle.dispatch(controlStateInput())).payload.kind,
    ).toBe('unavailable')
    expect(await readdir(teamRoot)).not.toContain(HOSTED_LIFECYCLE_PLAN_FILE)
  })

  test('keeps an admitted OpenCode plan unavailable when its live owner capability is absent', async () => {
    const teamRoot = await makeTeamRoot('hosted-production-opencode-unavailable-')
    await writePlan(teamRoot, 'opencode')
    const createPorts = createHostedControlProductionPortFactory(() => new OpenCodeTeamLifecycleLane())
    const ports = await createPorts(context(teamRoot))
    expect((await ports.lifecycle.dispatch(controlStateInput())).payload.kind).toBe('unavailable')
  })
})

async function makeTeamRoot(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix))
  roots.push(parent)
  const root = join(parent, 'legacy')
  await mkdir(root, { mode: 0o700 })
  return realpath(root)
}

function context(teamRoot: string): HostedControlRuntimePortFactoryContext {
  return {
    authority: stableAuthority,
    legacyKey: 'legacy',
    teamRoot,
    isCurrentAuthority: async () => true,
  }
}

function controlStateInput() {
  return {
    operation: 'control_state' as const,
    payload: {
      request: {
        schemaVersion: 1,
        workspaceId: stableAuthority.workspaceId,
        teamId,
      },
      context: {
        actorId: 'actor-a',
        sessionId: 'session-a',
        deploymentId: stableAuthority.deploymentId,
        bootId: stableAuthority.bootId,
        requestId: 'request-a',
        authorizedScope: 'scope_team-lifecycle.write',
        deadlineAtMs: Date.now() + 10_000,
      },
      authority: lifecycleAuthority,
    },
    authority: lifecycleAuthority,
  }
}

async function writePlan(
  teamRoot: string,
  kind: 'opencode' | 'native',
): Promise<void> {
  await mkdir(teamRoot, { recursive: true, mode: 0o700 })
  const lane =
    kind === 'opencode'
      ? {
          laneId: 'opencode-primary',
          kind: 'opencode',
          provider: 'opencode',
          selectedModel: 'openai/gpt-5',
          members: [
            { name: 'worker', prompt: 'Work only in the admitted sandbox.' },
          ],
        }
      : {
          laneId: 'codex-primary',
          kind: 'native',
          provider: 'codex',
          members: [
            { name: 'worker', prompt: 'Work only in the admitted sandbox.' },
          ],
        }
  const path = join(teamRoot, HOSTED_LIFECYCLE_PLAN_FILE)
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 2,
      workspaceId: stableAuthority.workspaceId,
      teamId,
      workspaceRoot: join(teamRoot, 'sandbox-workspace'),
      toolApprovalMode: 'manual',
      lanes: [lane],
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}
