import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildTeamBootstrapRequestFromSpec,
  readTeamBootstrapSpec,
} from './teamBootstrapSpec.js'
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

  test('rejects symlink bootstrap spec paths', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const realSpecPath = join(tempRoot, 'bootstrap-real.json')
    const linkSpecPath = join(tempRoot, 'bootstrap-link.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      realSpecPath,
      JSON.stringify({
        version: 1,
        runId: 'run-link',
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
        members: [{ name: 'alice' }],
      } satisfies TeamBootstrapSpec),
      'utf8',
    )
    await symlink(realSpecPath, linkSpecPath)

    await expect(readTeamBootstrapSpec(linkSpecPath)).rejects.toThrow(
      'team bootstrap spec must be a regular file and must not be a symlink',
    )
  })

  test('rejects oversized bootstrap specs before parsing', async () => {
    const oversizedSpecPath = join(tempRoot, 'bootstrap-oversized.json')
    await writeFile(oversizedSpecPath, 'x'.repeat(256 * 1024 + 1), 'utf8')

    await expect(readTeamBootstrapSpec(oversizedSpecPath)).rejects.toThrow(
      'team bootstrap spec is too large',
    )
  })
})
