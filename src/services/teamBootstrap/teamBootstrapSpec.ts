import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import { z } from 'zod/v4'
import { sanitizeName } from 'src/utils/swarm/teamHelpers.js'
import type {
  NormalizedBootstrapMember,
  TeamBootstrapRequest,
  TeamBootstrapSpec,
} from './teamBootstrapTypes.js'

const bootstrapMemberSchema = z.strictObject({
  name: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
  workflow: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.enum(['anthropic', 'codex', 'gemini']).optional(),
  effort: z.string().trim().min(1).optional(),
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
    kind: z.literal('app'),
    source: z.literal('claude_team_freecode'),
  }),
  team: z.strictObject({
    name: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    color: z.string().trim().min(1).optional(),
    cwd: z.string().trim().min(1),
  }),
  lead: z.strictObject({
    providerId: z.enum(['anthropic', 'codex', 'gemini']).optional(),
    model: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    skipPermissions: z.boolean().optional(),
    worktree: z.string().trim().min(1).nullable().optional(),
    extraCliArgs: z.array(z.string()).optional(),
  }),
  members: z.array(bootstrapMemberSchema).min(1).max(8),
  launch: z
    .strictObject({
      initialUserPrompt: z.string().nullable().optional(),
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
  return {
    originalName: member.name,
    displayName: member.name,
    normalizedName: sanitizeName(member.name),
    prompt: member.prompt,
    ...(member.role ? { role: member.role } : {}),
    ...(member.workflow ? { workflow: member.workflow } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.provider ? { provider: member.provider } : {}),
    ...(member.model ? { model: member.model } : {}),
    ...(member.effort ? { effort: member.effort } : {}),
    ...(member.cwd ? { cwd: member.cwd } : {}),
    ...(member.useSplitPane ? { useSplitPane: member.useSplitPane } : {}),
    ...(member.planModeRequired
      ? { planModeRequired: member.planModeRequired }
      : {}),
    ...(member.description ? { description: member.description } : {}),
  }
}

function buildRequestHash(
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
      cwd: member.cwd ?? null,
      useSplitPane: member.useSplitPane ?? false,
      planModeRequired: member.planModeRequired ?? false,
      description: member.description ?? null,
    }))
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))

  const stableIntent = {
    version: request.version,
    mode: request.mode,
    teamName: request.teamName,
    teamDisplayName: request.teamDisplayName ?? null,
    description: request.description ?? null,
    color: request.color ?? null,
    cwd: request.cwd,
    bootstrapTimeoutMs: request.bootstrapTimeoutMs,
    continueOnPartialFailure: request.continueOnPartialFailure,
    policy: request.policy,
    initiator: request.initiator,
    members: stableMembers,
  }

  return createHash('sha256')
    .update(JSON.stringify(stableIntent))
    .digest('hex')
}

export async function readTeamBootstrapSpec(
  specPath: string,
): Promise<TeamBootstrapRequest> {
  const stat = await fs.lstat(specPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      'team bootstrap spec must be a regular file and must not be a symlink',
    )
  }

  const raw = await fs.readFile(specPath, 'utf8')
  const parsed = bootstrapSpecSchema.parse(JSON.parse(raw))
  const cwd = await fs.realpath(parsed.team.cwd)

  const members = await Promise.all(
    parsed.members.map(async member => {
      const normalized = normalizeMember(member)
      if (normalized.cwd) {
        normalized.cwd = await fs.realpath(normalized.cwd)
      }
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
