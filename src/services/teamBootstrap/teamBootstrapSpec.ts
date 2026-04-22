import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import { z } from 'zod/v4'
import { sanitizeName } from 'src/utils/swarm/teamHelpers.js'
import { readBoundRegularUtf8File } from './teamBootstrapBoundFileRead.js'
import type {
  NormalizedBootstrapMember,
  TeamBootstrapRequest,
  TeamBootstrapSpec,
} from './teamBootstrapTypes.js'
import {
  buildDeterministicBootstrapMemberPrompt,
  getMembersWithAssignedBoardWork,
  resolveBootstrapLeadName,
} from './teamBootstrapPromptBuilder.js'

const MAX_BOOTSTRAP_SPEC_BYTES = 256 * 1024

const bootstrapMemberSchema = z.strictObject({
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  workflow: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.enum(['anthropic', 'codex', 'gemini']).optional(),
  effort: z.string().trim().min(1).optional(),
  isolation: z.enum(['worktree']).optional(),
  agentType: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  useSplitPane: z.boolean().optional(),
  planModeRequired: z.boolean().optional(),
})

const bootstrapSpecSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().trim().min(1),
  mode: z.enum(['create', 'launch']),
  initiator: z.strictObject({
    kind: z.enum(['app', 'tool']),
    source: z.enum(['claude_team_agent_teams_orchestrator', 'TeamBootstrap']),
  }),
  team: z.strictObject({
    name: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    color: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1),
  }),
  lead: z.strictObject({
    agentLanguage: z.string().trim().min(1).optional(),
    permissionSeedTools: z
      .array(z.string().trim().min(1))
      .max(64)
      .optional(),
  }),
  members: z.array(bootstrapMemberSchema).min(1).max(8),
  launch: z
    .strictObject({
      bootstrapTimeoutMs: z.number().int().positive().max(120_000).optional(),
      continueOnPartialFailure: z.boolean().optional(),
    })
    .optional(),
  ui: z
    .strictObject({
      emitStructuredEvents: z.boolean().optional(),
    })
    .optional(),
}).superRefine((spec, ctx) => {
  const seenNormalizedNames = new Map<string, number>()
  for (const [index, member] of spec.members.entries()) {
    const trimmedName = member.name.trim()
    const loweredName = trimmedName.toLowerCase()
    if (loweredName === 'team-lead' || loweredName === 'user') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'name'],
        message: `Member name "${trimmedName}" is reserved`,
      })
      continue
    }
    const normalizedName = sanitizeName(trimmedName)
    if (!normalizedName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'name'],
        message: `Member name "${trimmedName}" becomes empty after normalization`,
      })
      continue
    }
    const existingIndex = seenNormalizedNames.get(normalizedName)
    if (existingIndex !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['members', index, 'name'],
        message: `Member name "${trimmedName}" collides with "${spec.members[existingIndex]?.name ?? trimmedName}" after normalization`,
      })
      continue
    }
    seenNormalizedNames.set(normalizedName, index)
  }
})

function normalizeMember(
  member: TeamBootstrapSpec['members'][number],
): NormalizedBootstrapMember {
  const isWorktreeIsolated = member.isolation === 'worktree'
  return {
    originalName: member.name,
    displayName: member.name,
    normalizedName: sanitizeName(member.name),
    prompt: member.prompt ?? '',
    ...(member.role ? { role: member.role } : {}),
    ...(member.workflow ? { workflow: member.workflow } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.provider ? { provider: member.provider } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.effort ? { effort: member.effort } : {}),
    ...(isWorktreeIsolated ? { isolation: 'worktree' as const } : {}),
    ...(member.cwd && !isWorktreeIsolated ? { cwd: member.cwd } : {}),
    ...(member.useSplitPane ? { useSplitPane: member.useSplitPane } : {}),
    ...(member.planModeRequired
      ? { planModeRequired: member.planModeRequired }
      : {}),
    ...(member.description ? { description: member.description } : {}),
  }
}

function compareStableStrings(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}

function normalizePermissionSeedTools(tools: string[] | undefined): string[] {
  if (!tools || tools.length === 0) {
    return []
  }

  return [...new Set(tools.map(tool => tool.trim()).filter(tool => tool.length > 0))].sort(
    compareStableStrings,
  )
}

export function buildRequestHash(
  request: Omit<TeamBootstrapRequest, 'requestHash'>,
): string {
  const stableMembers = [...request.members]
    .map(member => ({
      normalizedName: member.normalizedName,
      prompt: member.prompt,
      role: member.role ?? null,
      workflow: member.workflow ?? null,
      agentType: member.agentType ?? null,
      provider: member.provider ?? null,
      model: member.model ?? null,
      effort: member.effort ?? null,
      isolation: member.isolation ?? null,
      cwd: member.cwd ?? null,
      useSplitPane: member.useSplitPane ?? false,
      planModeRequired: member.planModeRequired ?? false,
      description: member.description ?? null,
    }))
    .sort((a, b) => compareStableStrings(a.normalizedName, b.normalizedName))

  const stableIntent = {
    version: request.version,
    mode: request.mode,
    teamName: request.teamName,
    description: request.description ?? null,
    cwd: request.cwd,
    bootstrapTimeoutMs: request.bootstrapTimeoutMs,
    continueOnPartialFailure: request.continueOnPartialFailure,
    permissionSeedTools: [...request.permissionSeedTools].sort(compareStableStrings),
    policy: request.policy,
    members: stableMembers,
  }

  return createHash('sha256')
    .update(JSON.stringify(stableIntent))
    .digest('hex')
}

export async function buildTeamBootstrapRequestFromSpec(
  parsed: TeamBootstrapSpec,
): Promise<TeamBootstrapRequest> {
  const cwd = await fs.realpath(parsed.team.cwd)
  const leadName = await resolveBootstrapLeadName(parsed)
  const assignedWorkMembers =
    parsed.mode === 'launch'
      ? await getMembersWithAssignedBoardWork(parsed.team.name)
      : new Set<string>()

  const members = await Promise.all(
    parsed.members.map(async member => {
      const normalized = normalizeMember(member)
      if (normalized.cwd) {
        normalized.cwd = await fs.realpath(normalized.cwd)
      }
      normalized.prompt =
        member.prompt?.trim() ||
        (await buildDeterministicBootstrapMemberPrompt({
          spec: parsed,
          member,
          leadName,
          assignedWorkMembers,
        }))
      return normalized
    }),
  )

  const requestBase: Omit<TeamBootstrapRequest, 'requestHash'> = {
    version: 1,
    runId: parsed.runId,
    mode: parsed.mode,
    teamName: parsed.team.name,
    ...(parsed.team.displayName
      ? { teamDisplayName: parsed.team.displayName }
      : {}),
    ...(parsed.team.description ? { description: parsed.team.description } : {}),
    ...(parsed.team.color ? { color: parsed.team.color } : {}),
    cwd,
    members,
    bootstrapTimeoutMs: parsed.launch?.bootstrapTimeoutMs ?? 120_000,
    continueOnPartialFailure:
      parsed.launch?.continueOnPartialFailure !== false,
    permissionSeedTools: normalizePermissionSeedTools(
      parsed.lead.permissionSeedTools,
    ),
    emitStructuredEvents: parsed.ui?.emitStructuredEvents !== false,
    policy: {
      persistentTeam: true,
      registerForSessionCleanup: false,
      writeConversationSummaryMessage: false,
    },
    initiator: parsed.initiator,
  }

  return {
    ...requestBase,
    requestHash: buildRequestHash(requestBase),
  }
}

export async function readTeamBootstrapSpec(
  specPath: string,
): Promise<TeamBootstrapRequest> {
  const raw = await readBoundRegularUtf8File({
    filePath: specPath,
    maxBytes: MAX_BOOTSTRAP_SPEC_BYTES,
    messages: {
      notRegular:
        'team bootstrap spec must be a regular file and must not be a symlink',
      oversized: 'team bootstrap spec is too large',
      invalid:
        'team bootstrap spec changed while being validated or could not be read safely',
    },
  })
  const parsed = bootstrapSpecSchema.parse(JSON.parse(raw))
  return buildTeamBootstrapRequestFromSpec(parsed)
}
