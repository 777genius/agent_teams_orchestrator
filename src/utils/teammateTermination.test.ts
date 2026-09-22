import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { AppState } from '../state/AppState.js'
import { preserveTeammateAfterTerminationFailure, retryPersistedTeammateTermination } from './teammateTermination.js'
import { getTeamDir, writeTeamFileAsync } from './swarm/teamHelpers.js'

const roots: string[] = []
const previousConfig = process.env.CLAUDE_CONFIG_DIR
afterEach(async () => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('teammate termination recovery', () => {
  test('preserves the member and its full retry identity', () => {
    const state = {
      inbox: { messages: [] },
      teamContext: {
        teammates: {
          'bob@alpha': {
            name: 'bob',
            processStartedAtMs: 100,
            processOsIdentity: 'win32-job:agent-teams-job-a',
            processOwnerToken: 'owner-token',
            processRunId: 'run-a',
          },
        },
      },
    } as unknown as AppState

    const next = preserveTeammateAfterTerminationFailure(state, {
      teammateName: 'bob',
      paneId: 'process:42',
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })

    expect(next.teamContext?.teammates?.['bob@alpha']).toEqual(
      state.teamContext?.teammates?.['bob@alpha'],
    )
    expect(next.inbox.messages).toEqual([])
    expect(next.teammateTerminationRecovery.bob).toMatchObject({
      paneId: 'process:42',
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
  })

  test('never lets stale recovery kill or remove a fresh respawn generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'termination-recovery-'))
    roots.push(root)
    process.env.CLAUDE_CONFIG_DIR = root
    await mkdir(getTeamDir('alpha'), { recursive: true })
    await writeTeamFileAsync('alpha', {
      name: 'alpha', createdAt: 0, leadAgentId: 'team-lead@alpha',
      members: [{
        agentId: 'bob@alpha', name: 'bob', joinedAt: 2, cwd: '/tmp', subscriptions: [],
        backendType: 'process', tmuxPaneId: 'process:200', processStartedAtMs: 200,
        processOsIdentity: 'win32-job:fresh-job',
        processOwnerToken: 'fresh-owner', processRunId: 'fresh-run',
        terminationRecovery: {
          agentId: 'bob@alpha', backendType: 'process', paneId: 'process:100',
          processOsIdentity: 'win32-job:old-job',
          processStartedAtMs: 100, processOwnerToken: 'old-owner', processRunId: 'old-run',
          recordedAt: new Date().toISOString(),
        },
      }],
    })
    expect(await retryPersistedTeammateTermination('alpha', 'bob@alpha')).toBe(false)
  })

  test('restart reconciliation removes an exact orphaned in-process generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'termination-recovery-'))
    roots.push(root)
    process.env.CLAUDE_CONFIG_DIR = root
    await mkdir(getTeamDir('alpha'), { recursive: true })
    await writeTeamFileAsync('alpha', {
      name: 'alpha', createdAt: 0, leadAgentId: 'team-lead@alpha',
      members: [{
        agentId: 'bob@alpha', name: 'bob', joinedAt: 1, cwd: '/tmp', subscriptions: [],
        backendType: 'in-process', tmuxPaneId: 'in-process',
        terminationRecovery: {
          agentId: 'bob@alpha', backendType: 'in-process', paneId: 'in-process',
          recordedAt: new Date().toISOString(),
        },
      }],
    })
    expect(await retryPersistedTeammateTermination('alpha', 'bob@alpha')).toBe(true)
  })
})
