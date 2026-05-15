import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildRequestHash,
  buildTeamBootstrapRequestFromSpec,
  readTeamBootstrapSpec,
} from './teamBootstrapSpec.js'
import { hashNativeBootstrapText } from './nativeAppManagedBootstrapContext.js'
import { PROVIDER_DEFAULT_MODEL_SELECTION } from './teamBootstrapModelSelection.js'
import type { TeamBootstrapRequest, TeamBootstrapSpec } from './teamBootstrapTypes.js'

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
    expect(request.members[0]?.prompt).toContain(
      'retry tool search at most once',
    )
    expect(request.members[0]?.prompt).toContain(
      'Do NOT keep searching for member_briefing',
    )
    expect(request.members[0]?.prompt).toContain('Communicate in English')
    expect(request.members[0]?.prompt).toContain(
      'Review flow rule: review is a state transition on the SAME work task'
    )
    expect(request.members[0]?.prompt).toContain(
      'Do NOT create a separate "review task"'
    )
    expect(request.members[0]?.prompt).toContain(
      'If no reviewer exists, leave #X completed.'
    )
  })

  test('allows startup bootstrap specs with zero teammates for lead-only primary lanes', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-zero-members',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'forge-labs',
        cwd: workspaceDir,
      },
      lead: {
        agentLanguage: 'English',
      },
      members: [],
    } satisfies TeamBootstrapSpec)

    expect(request.members).toEqual([])
  })

  test('accepts large startup bootstrap specs up to sixteen teammates', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-sixteen-members.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-sixteen-members',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'sixteen-ready-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: Array.from({ length: 16 }, (_, index) => ({
          name: `member-${index + 1}`,
          role: 'developer',
          workflow: 'Handle assigned work.',
        })),
      }),
      'utf8',
    )

    const request = await readTeamBootstrapSpec(specPath)

    expect(request.members).toHaveLength(16)
  })

  test('rejects startup bootstrap specs above sixteen teammates', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-too-many-members.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-too-many-members',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'too-many-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: Array.from({ length: 17 }, (_, index) => ({
          name: `member-${index + 1}`,
          role: 'developer',
          workflow: 'Handle assigned work.',
        })),
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /expected array to have <=16 items/,
    )
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
        source: 'claude_team_agent_teams_orchestrator',
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

  test('preserves teammate worktree isolation in normalized bootstrap requests', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const workspaceRealpath = await realpath(workspaceDir)

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-worktree-isolation',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'alice',
          prompt: 'custom bootstrap prompt',
          cwd: workspaceDir,
          isolation: 'worktree',
        },
        {
          name: 'bob',
          prompt: 'custom bootstrap prompt',
          cwd: workspaceDir,
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members[0]?.isolation).toBe('worktree')
    expect(request.members[0]?.cwd).toBeUndefined()
    expect(request.members[1]?.isolation).toBeUndefined()
    expect(request.members[1]?.cwd).toBe(workspaceRealpath)
  })

  test('preserves mixed teammate provider runtime selections for spawn', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const bobCwd = join(tempRoot, 'bob-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(bobCwd, { recursive: true })
    const workspaceRealpath = await realpath(workspaceDir)
    const bobCwdRealpath = await realpath(bobCwd)

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-mixed-providers',
      mode: 'launch',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'mixed-runtime-team',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'alice',
          prompt: 'Alice bootstrap',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          effort: 'high',
        },
        {
          name: 'bob',
          prompt: 'Bob bootstrap',
          provider: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          cwd: bobCwd,
        },
        {
          name: 'zoe',
          prompt: 'Zoe bootstrap',
          provider: 'gemini',
          model: 'gemini-2.5-flash',
          effort: 'low',
          cwd: workspaceDir,
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.cwd).toBe(workspaceRealpath)
    expect(request.members).toMatchObject([
      {
        displayName: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        displayName: 'bob',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
        cwd: bobCwdRealpath,
      },
      {
        displayName: 'zoe',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'low',
        cwd: workspaceRealpath,
      },
    ])
  })

  test('normalizes provider-default model sentinel as no model override', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const baseSpec = {
      version: 1,
      runId: 'run-provider-default-sentinel',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {},
    } satisfies Omit<TeamBootstrapSpec, 'members'>
    const request = await buildTeamBootstrapRequestFromSpec({
      ...baseSpec,
      members: [
        {
          name: 'bob',
          role: 'developer',
          provider: 'codex',
          model: PROVIDER_DEFAULT_MODEL_SELECTION,
        },
      ],
    })
    const omittedModelRequest = await buildTeamBootstrapRequestFromSpec({
      ...baseSpec,
      members: [
        {
          name: 'bob',
          role: 'developer',
          provider: 'codex',
        },
      ],
    })

    expect(request.members[0]?.model).toBeUndefined()
    expect(request.members[0]?.prompt).not.toContain(PROVIDER_DEFAULT_MODEL_SELECTION)
    expect(request.members[0]?.prompt).not.toContain('Model override')
    expect(request.requestHash).toBe(omittedModelRequest.requestHash)
  })

  test('accepts native app-managed bootstrap for anthropic and codex members', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const anthropicContext = 'anthropic native context'
    const codexContext = 'codex native context'

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-native-context',
      mode: 'launch',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'native-ready-team',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'alice',
          provider: 'anthropic',
          nativeAppManagedBootstrap: {
            schemaVersion: 1,
            mode: 'startup_context_file',
            contextText: anthropicContext,
            contextHash: hashNativeBootstrapText(anthropicContext),
            briefingHash: hashNativeBootstrapText('alice briefing'),
            generatedAt: '2026-05-06T00:00:00.000Z',
          },
        },
        {
          name: 'bob',
          provider: 'codex',
          nativeAppManagedBootstrap: {
            schemaVersion: 1,
            mode: 'startup_context_file',
            contextText: codexContext,
            contextHash: hashNativeBootstrapText(codexContext),
            briefingHash: hashNativeBootstrapText('bob briefing'),
            generatedAt: '2026-05-06T00:00:00.000Z',
          },
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members[0]?.nativeAppManagedBootstrap?.contextText).toBe(
      anthropicContext,
    )
    expect(request.members[0]?.prompt).toContain(
      '<agent_teams_native_app_managed_bootstrap_check>',
    )
    expect(request.members[0]?.prompt).not.toContain('Your FIRST action')
    expect(request.members[1]?.nativeAppManagedBootstrap?.contextText).toBe(
      codexContext,
    )
  })

  test('rejects native app-managed bootstrap for unsupported providers', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-native-gemini.json')
    const contextText = 'gemini native context'
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-native-gemini',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'native-ready-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: [
          {
            name: 'zoe',
            provider: 'gemini',
            nativeAppManagedBootstrap: {
              schemaVersion: 1,
              mode: 'startup_context_file',
              contextText,
              contextHash: hashNativeBootstrapText(contextText),
              briefingHash: hashNativeBootstrapText('zoe briefing'),
              generatedAt: '2026-05-06T00:00:00.000Z',
            },
          },
        ],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /only supported for anthropic\/codex/,
    )
  })

  test('rejects native app-managed bootstrap hash mismatch and invalid generatedAt', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-native-invalid.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-native-invalid',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'native-ready-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: [
          {
            name: 'alice',
            provider: 'anthropic',
            nativeAppManagedBootstrap: {
              schemaVersion: 1,
              mode: 'startup_context_file',
              contextText: 'native context',
              contextHash: '0'.repeat(64),
              briefingHash: hashNativeBootstrapText('alice briefing'),
              generatedAt: 'not-a-date',
            },
          },
        ],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /contextHash does not match contextText|generatedAt must be a valid ISO timestamp/,
    )
  })

  test('request hash changes when native app-managed context hash changes', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    const baseSpec = {
      version: 1,
      runId: 'run-native-hash',
      mode: 'launch',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'native-ready-team',
        cwd: workspaceDir,
      },
      lead: {},
    } satisfies Omit<TeamBootstrapSpec, 'members'>

    const requestA = await buildTeamBootstrapRequestFromSpec({
      ...baseSpec,
      members: [
        {
          name: 'alice',
          provider: 'codex',
          nativeAppManagedBootstrap: {
            schemaVersion: 1,
            mode: 'startup_context_file',
            contextText: 'native context A',
            contextHash: hashNativeBootstrapText('native context A'),
            briefingHash: hashNativeBootstrapText('alice briefing'),
            generatedAt: '2026-05-06T00:00:00.000Z',
          },
        },
      ],
    })
    const requestB = await buildTeamBootstrapRequestFromSpec({
      ...baseSpec,
      members: [
        {
          name: 'alice',
          provider: 'codex',
          nativeAppManagedBootstrap: {
            schemaVersion: 1,
            mode: 'startup_context_file',
            contextText: 'native context B',
            contextHash: hashNativeBootstrapText('native context B'),
            briefingHash: hashNativeBootstrapText('alice briefing'),
            generatedAt: '2026-05-06T00:00:00.000Z',
          },
        },
      ],
    })

    expect(requestA.requestHash).not.toBe(requestB.requestHash)
  })

  test('rejects OpenCode teammates in primary bootstrap specs so they use bridge lanes', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-opencode-in-primary.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-opencode-primary',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'mixed-runtime-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: [
          {
            name: 'bob',
            prompt: 'Bob OpenCode bootstrap',
            provider: 'opencode',
            model: 'openrouter/minimax-m2.5-free',
          },
        ],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /Invalid option: expected one of/i,
    )
  })

  test('rejects duplicate teammate identities after name normalization', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-duplicate-member.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-duplicate-member',
        mode: 'launch',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'mixed-runtime-team',
          cwd: workspaceDir,
        },
        lead: {},
        members: [
          {
            name: 'Bob Smith',
            prompt: 'Bob first bootstrap',
            provider: 'codex',
            model: 'gpt-5.4-mini',
          },
          {
            name: 'bob-smith',
            prompt: 'Bob duplicate bootstrap',
            provider: 'gemini',
            model: 'gemini-2.5-flash',
          },
        ],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(/collides/i)
  })

  test('preserves explicit split-pane false through normalized bootstrap requests', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-split-pane-false',
      mode: 'launch',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'mixed-runtime-team',
        cwd: workspaceDir,
      },
      lead: {},
      members: [
        {
          name: 'bob',
          prompt: 'Bob bootstrap',
          provider: 'codex',
          model: 'gpt-5.4-mini',
          useSplitPane: false,
        },
      ],
    } satisfies TeamBootstrapSpec)

    expect(request.members[0]?.useSplitPane).toBe(false)
  })

  test('readTeamBootstrapSpec accepts the current claude_team initiator source', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const specPath = join(tempRoot, 'bootstrap-spec.json')
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-current-source',
        mode: 'create',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
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

    const request = await readTeamBootstrapSpec(specPath)
    expect(request.initiator.source).toBe('claude_team_agent_teams_orchestrator')
    expect(request.members[0]?.prompt).toContain('member_briefing')
  })

  test('readTeamBootstrapSpec accepts hidden tool initiator values', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const specPath = join(tempRoot, 'bootstrap-tool-spec.json')
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-tool-source',
        mode: 'create',
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
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

    const request = await readTeamBootstrapSpec(specPath)
    expect(request.initiator).toEqual({
      kind: 'tool',
      source: 'TeamBootstrap',
    })
    expect(request.members[0]?.prompt).toContain('member_briefing')
  })

  test('normalizes permission seed tools deterministically', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-perms',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {
        permissionSeedTools: ['Write', 'Edit', 'Write', 'NotebookEdit', 'Edit'],
      },
      members: [{ name: 'alice' }],
    } satisfies TeamBootstrapSpec)

    expect(request.permissionSeedTools).toEqual(['Edit', 'NotebookEdit', 'Write'])
  })

  test('defaults structured bootstrap events to enabled', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-events-default',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {},
      members: [{ name: 'alice' }],
    } satisfies TeamBootstrapSpec)

    expect(request.emitStructuredEvents).toBe(true)
  })

  test('allows startup bootstrap specs to disable structured bootstrap events', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    await mkdir(workspaceDir, { recursive: true })

    const request = await buildTeamBootstrapRequestFromSpec({
      version: 1,
      runId: 'run-events-off',
      mode: 'create',
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
      team: {
        name: 'atlas-hq',
        cwd: workspaceDir,
      },
      lead: {},
      members: [{ name: 'alice' }],
      ui: {
        emitStructuredEvents: false,
      },
    } satisfies TeamBootstrapSpec)

    expect(request.emitStructuredEvents).toBe(false)
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
          source: 'claude_team_agent_teams_orchestrator',
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

  test('rejects embedding the first real user prompt into the bootstrap spec', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-invalid-prompt.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-invalid-prompt',
        mode: 'create',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'atlas-hq',
          cwd: workspaceDir,
        },
        lead: {},
        members: [{ name: 'alice' }],
        launch: {
          initialUserPrompt: 'do the real task now',
        },
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /initialUserPrompt/i,
    )
  })

  test('rejects embedding legacy skipPermissions into the bootstrap spec', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-invalid-skip-perms.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-invalid-skip-perms',
        mode: 'create',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'atlas-hq',
          cwd: workspaceDir,
        },
        lead: {
          skipPermissions: false,
        },
        members: [{ name: 'alice' }],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /skipPermissions/i,
    )
  })

  test('rejects embedding lead runtime launch settings into the bootstrap spec', async () => {
    const workspaceDir = join(tempRoot, 'workspace')
    const specPath = join(tempRoot, 'bootstrap-invalid-lead-runtime.json')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        runId: 'run-invalid-lead-runtime',
        mode: 'create',
        initiator: {
          kind: 'app',
          source: 'claude_team_agent_teams_orchestrator',
        },
        team: {
          name: 'atlas-hq',
          cwd: workspaceDir,
        },
        lead: {
          providerId: 'gemini',
          model: 'gemini-2.5-flash',
          effort: 'medium',
          worktree: '/tmp/worktree',
          extraCliArgs: ['--foo'],
        },
        members: [{ name: 'alice' }],
      }),
      'utf8',
    )

    await expect(readTeamBootstrapSpec(specPath)).rejects.toThrow(
      /providerId|model|effort|worktree|extraCliArgs/i,
    )
  })

  test('request hash stays stable across app and hidden-tool entrypoints', () => {
    const requestBase: Omit<TeamBootstrapRequest, 'requestHash'> = {
      version: 1,
      runId: 'run-4',
      mode: 'launch',
      teamName: 'atlas-hq',
      teamDisplayName: 'Atlas HQ',
      description: 'Example team',
      color: '#123456',
      cwd: '/tmp/workspace',
      members: [
        {
          originalName: 'alice',
          displayName: 'alice',
          normalizedName: 'alice',
          prompt: 'Prompt A',
          role: 'reviewer',
        },
        {
          originalName: 'bob',
          displayName: 'bob',
          normalizedName: 'bob',
          prompt: 'Prompt B',
          role: 'developer',
        },
      ],
      bootstrapTimeoutMs: 30_000,
      continueOnPartialFailure: true,
      permissionSeedTools: ['Edit', 'Write'],
      emitStructuredEvents: true,
      policy: {
        persistentTeam: true,
        registerForSessionCleanup: false,
        writeConversationSummaryMessage: false,
      },
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
    }

    const appHash = buildRequestHash(requestBase)
    const toolHash = buildRequestHash({
      ...requestBase,
      initiator: {
        kind: 'tool',
        source: 'TeamBootstrap',
      },
    })

    expect(appHash).toBe(toolHash)
  })

  test('request hash stays stable across member and permission-seed ordering', () => {
    const baseRequest: Omit<TeamBootstrapRequest, 'requestHash'> = {
      version: 1,
      runId: 'run-5',
      mode: 'launch',
      teamName: 'atlas-hq',
      cwd: '/tmp/workspace',
      members: [
        {
          originalName: 'bob',
          displayName: 'bob',
          normalizedName: 'bob',
          prompt: 'Prompt B',
        },
        {
          originalName: 'alice',
          displayName: 'alice',
          normalizedName: 'alice',
          prompt: 'Prompt A',
        },
      ],
      bootstrapTimeoutMs: 30_000,
      continueOnPartialFailure: true,
      permissionSeedTools: ['Write', 'Edit', 'NotebookEdit'],
      emitStructuredEvents: true,
      policy: {
        persistentTeam: true,
        registerForSessionCleanup: false,
        writeConversationSummaryMessage: false,
      },
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
    }

    const hashA = buildRequestHash(baseRequest)
    const hashB = buildRequestHash({
      ...baseRequest,
      members: [...baseRequest.members].reverse(),
      permissionSeedTools: [...baseRequest.permissionSeedTools].reverse(),
    })

    expect(hashA).toBe(hashB)
  })

  test('request hash ignores UI-only team metadata that runtime bootstrap does not use', () => {
    const baseRequest: Omit<TeamBootstrapRequest, 'requestHash'> = {
      version: 1,
      runId: 'run-6',
      mode: 'create',
      teamName: 'atlas-hq',
      teamDisplayName: 'Atlas HQ',
      description: 'Create the team',
      color: '#123456',
      cwd: '/tmp/workspace',
      members: [
        {
          originalName: 'alice',
          displayName: 'alice',
          normalizedName: 'alice',
          prompt: 'Prompt A',
        },
      ],
      bootstrapTimeoutMs: 30_000,
      continueOnPartialFailure: true,
      permissionSeedTools: ['Edit', 'Write'],
      emitStructuredEvents: true,
      policy: {
        persistentTeam: true,
        registerForSessionCleanup: false,
        writeConversationSummaryMessage: false,
      },
      initiator: {
        kind: 'app',
        source: 'claude_team_agent_teams_orchestrator',
      },
    }

    const hashA = buildRequestHash(baseRequest)
    const hashB = buildRequestHash({
      ...baseRequest,
      teamDisplayName: 'Atlas HQ Renamed',
      color: '#abcdef',
    })

    expect(hashA).toBe(hashB)
  })
})
