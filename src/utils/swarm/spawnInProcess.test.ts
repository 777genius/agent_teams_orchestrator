import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import { killInProcessTeammate } from './spawnInProcess.js'

describe('out-of-process teammate task termination', () => {
  test('false runtime termination retains task, member, and retry identity', async () => {
    let state = {
      inbox: { messages: [] },
      teamContext: {
        teamName: 'alpha',
        teamFilePath: '/tmp/alpha.json',
        leadAgentId: 'lead@alpha',
        teammates: {
          'bob@alpha': {
            name: 'bob',
            tmuxSessionName: 'process',
            tmuxPaneId: 'process:42',
            cwd: '/tmp',
            spawnedAt: 1,
            processStartedAtMs: 100,
            processOsIdentity: 'win32-job:agent-teams-job-a',
            processOwnerToken: 'owner-token',
            processRunId: 'run-a',
          },
        },
      },
      tasks: {
        'task-1': {
          type: 'in_process_teammate',
          status: 'running',
          identity: {
            agentId: 'bob@alpha',
            agentName: 'bob',
            teamName: 'alpha',
          },
          externalRuntime: {
            paneId: 'process:42',
            backendType: 'process',
            processStartedAtMs: 100,
            processOsIdentity: 'win32-job:agent-teams-job-a',
            processOwnerToken: 'owner-token',
            processRunId: 'run-a',
          },
          terminateExternalRuntime: async () => false,
        },
      },
    } as unknown as AppState

    const killed = await killInProcessTeammate('task-1', updater => {
      state = updater(state)
    })

    expect(killed).toBe(false)
    expect(state.tasks['task-1']?.status).toBe('running')
    expect(state.teamContext?.teammates?.['bob@alpha']).toMatchObject({
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
    expect(state.teammateTerminationRecovery.bob).toMatchObject({
      paneId: 'process:42',
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
  })
})
