import { describe, expect, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import type { TeammateStatus } from '../../utils/teamDiscovery.js'
import { killTeammate } from './TeamsDialog.js'

describe('TeamsDialog process termination', () => {
  test('a false exact kill preserves member identity and exposes retry state', async () => {
    const teammate = {
      agentId: 'bob@alpha',
      name: 'bob',
      status: 'idle',
      tmuxPaneId: 'process:42',
      backendType: 'process',
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    } as TeammateStatus
    let state = {
      inbox: { messages: [] },
      teamContext: {
        teammates: {
          'bob@alpha': {
            name: 'bob',
            tmuxPaneId: 'process:42',
            processStartedAtMs: 100,
            processOsIdentity: 'win32-job:agent-teams-job-a',
            processOwnerToken: 'owner-token',
            processRunId: 'run-a',
          },
        },
      },
    } as unknown as AppState
    let removals = 0
    let taskChanges = 0
    let killOptions: Record<string, unknown> | undefined

    const removed = await killTeammate(
      teammate,
      'alpha',
      updater => { state = updater(state) },
      {
        killProcessRuntime: async (_paneId, options) => {
          killOptions = options as Record<string, unknown>
          return false
        },
        removeMember: async () => { removals += 1 },
        unassignTasks: async () => {
          taskChanges += 1
          return { notificationMessage: '' }
        },
      } as never,
    )

    expect(removed).toBe(false)
    expect(removals).toBe(0)
    expect(taskChanges).toBe(0)
    expect(state.teamContext?.teammates?.['bob@alpha']).toMatchObject({
      processStartedAtMs: 100,
      processOsIdentity: 'win32-job:agent-teams-job-a',
      processOwnerToken: 'owner-token',
      processRunId: 'run-a',
    })
    expect(state.inbox.messages).toEqual([])
    expect(state.teammateTerminationRecovery.bob).toMatchObject({
        paneId: 'process:42',
        processStartedAtMs: 100,
        processOsIdentity: 'win32-job:agent-teams-job-a',
        processOwnerToken: 'owner-token',
        processRunId: 'run-a',
    })
    expect(killOptions).toMatchObject({
      expectedOsIdentity: 'win32-job:agent-teams-job-a',
    })
  })
})
