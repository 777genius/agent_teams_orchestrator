import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getTeamFilePath } from './swarm/teamHelpers.js'
import { getTeammateStatuses } from './teamDiscovery.js'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempConfigDir: string | undefined

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = undefined
  }
})

describe('getTeammateStatuses', () => {
  it('preserves process backend metadata so UI teardown can kill the runtime', async () => {
    tempConfigDir = await mkdtemp(join(tmpdir(), 'team-discovery-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir

    const teamFilePath = getTeamFilePath('atlas-hq')
    await mkdir(dirname(teamFilePath), { recursive: true })
    await writeFile(
      teamFilePath,
      JSON.stringify(
        {
          name: 'atlas-hq',
          createdAt: 0,
          leadAgentId: 'team-lead@atlas-hq',
          hiddenPaneIds: ['process:4242'],
          members: [
            {
              agentId: 'team-lead@atlas-hq',
              name: 'team-lead',
              joinedAt: 0,
              tmuxPaneId: '',
              cwd: '/tmp/project',
              subscriptions: [],
            },
            {
              agentId: 'alice@atlas-hq',
              name: 'alice',
              joinedAt: 1,
              tmuxPaneId: 'process:4242',
              runtimePid: 4242,
              cwd: '/tmp/project',
              subscriptions: [],
              backendType: 'process',
            },
            {
              agentId: 'bob@atlas-hq',
              name: 'bob',
              joinedAt: 2,
              tmuxPaneId: '  process:4343  ',
              runtimePid: 4343,
              cwd: '/tmp/project',
              subscriptions: [],
            },
            {
              agentId: 'carol@atlas-hq',
              name: 'carol',
              joinedAt: 3,
              tmuxPaneId: 'in-process',
              cwd: '/tmp/project',
              subscriptions: [],
              backendType: 'in-process',
            },
            {
              agentId: 'dave@atlas-hq',
              name: 'dave',
              joinedAt: 4,
              runtimePid: 4444,
              cwd: '/tmp/project',
              subscriptions: [],
            },
            {
              agentId: 'erin@atlas-hq',
              name: 'erin',
              joinedAt: 5,
              tmuxPaneId: '%1.2',
              runtimePid: 5555,
              cwd: '/tmp/project',
              subscriptions: [],
              backendType: 'tmux',
            },
          ],
        },
        null,
        2,
      ),
    )

    expect(getTeammateStatuses('atlas-hq')).toEqual([
      expect.objectContaining({
        agentId: 'alice@atlas-hq',
        backendType: 'process',
        tmuxPaneId: 'process:4242',
        isHidden: true,
      }),
      expect.objectContaining({
        agentId: 'bob@atlas-hq',
        backendType: 'process',
        tmuxPaneId: 'process:4343',
      }),
      expect.objectContaining({
        agentId: 'carol@atlas-hq',
        backendType: 'in-process',
        tmuxPaneId: 'in-process',
      }),
      expect.objectContaining({
        agentId: 'dave@atlas-hq',
        backendType: 'process',
      }),
      expect.objectContaining({
        agentId: 'erin@atlas-hq',
        backendType: 'tmux',
        tmuxPaneId: '%1.2',
      }),
    ])
  })
})
