import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTeamBootstrapRequestFromSpec } from './teamBootstrapSpec.js'
import type { TeamBootstrapSpec } from './teamBootstrapTypes.js'

describe('team bootstrap spec normalization', () => {
  let tempRoot: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'team-bootstrap-spec-test-'))
    process.env.CLAUDE_CONFIG_DIR = tempRoot
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('builds deterministic member prompts when omitted', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-1',
      mode: 'create',
      initiator: {
        kind: 'tool',
        source: 'TeamBootstrap',
      },
      team: {
        name: 'forge-labs',
        cwd: workspaceDir,
      },
      lead: {
        agentLanguage: 'English',
      },
      members: [
        {
          name: 'alice',
          role: 'reviewer',
          workflow: 'Review the final implementation.',
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members).toHaveLength(1)
    expect(request.members[0]?.prompt).toContain('member_briefing')
    expect(request.members[0]?.prompt).toContain('forge-labs')
    expect(request.members[0]?.prompt).toContain('Communicate in English')
  })

  test('preserves explicit member prompts when provided', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-2',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_freecode',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'bob',
          prompt: 'custom bootstrap prompt',
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members[0]?.prompt).toBe('custom bootstrap prompt')
  })

  test('builds launch prompts using assigned board work when prompts are omitted', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const tasksDir = join(tempRoot, 'tasks', 'signal-ops')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(tasksDir, { recursive: true })
    await writeFile(
      join(tasksDir, '1.json'),
      JSON.stringify({
        id: '1',
        subject: 'Resume task',
        description: 'Continue implementation',
        status: 'in_progress',
        owner: 'jack',
        blocks: [],
        blockedBy: [],
      }),
      'utf8',
    )

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-3',
      mode: 'launch',
      initiator: {
        kind: 'tool',
        source: 'TeamBootstrap',
      },
      team: {
        name: 'signal-ops',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'jack',
          role: 'developer',
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members[0]?.prompt).toContain('resume your queue normally')
  })
})
