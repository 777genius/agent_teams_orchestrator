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
import { normalizeBootstrapModelSelection } from './teamBootstrapModelSelection.js'
import { isWindowsReservedBasename } from '../../utils/windowsReservedNames.js'
import { hashNativeBootstrapText } from './nativeAppManagedBootstrapContext.js'

const MAX_BOOTSTRAP_SPEC_BYTES = 256 * 1024
const MAX_BOOTSTRAP_MEMBERS = 20
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 120_000
const MAX_BOOTSTRAP_TIMEOUT_MS = 600_000

const nativeAppManagedBootstrapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal('startup_context_file'),
  contextText: z.string().trim().min(1).max(24_000),
  contextHash: z.string().trim().regex(/^[a-f0-9]{64}$/),
  briefingHash: z.string().trim().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().trim().min(1),
})

const bootstrapMcpSettingSourcesSchema = z
  .string()
  .trim()
  .regex(/^(user|project|local)(,(user|project|local))*$/)

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
  mcpConfigPath: z.string().trim().min(1).optional(),
  mcpSettingSources: bootstrapMcpSettingSourcesSchema.optional(),
  strictMcpConfig: z.boolean().optional(),
  nativeAppManagedBootstrap: nativeAppManagedBootstrapSchema.optional(),
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
  members: z.array(bootstrapMemberSchema).max(MAX_BOOTSTRAP_MEMBERS),
  launch: z
    .strictObject({
      bootstrapTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_BOOTSTRAP_TIMEOUT_MS)
        .optional(),
      continueOnPartialFailure: z.boolean().optional(),
    })
    .optional(),
  ui: z
    .strictObject({
      emitStructuredEvents: z.boolean().optional(),
    })
    .optional(),
}).superRefine((spec, ctx) => {
  if (isWindowsReservedBasename(spec.team.name)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['team', 'name'],
      message: `Team name "${spec.team.name}" is reserved on Windows`,
    })
  }

  const seenNormalizedNames = new Map<string, number>()
  for (const [index, member] of spec.members.entries()) {
    const trimmedName = member.name.trim()
    const loweredName = trimmedName.toLowerCase()
    if (
      loweredName === 'team-lead' ||
      loweredName === 'user' ||
      isWindowsReservedBasename(trimmedName)
    ) {
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

    if (member.nativeAppManagedBootstrap) {
      if (member.provider && member.provider !== 'anthropic' && member.provider !== 'codex') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', index, 'nativeAppManagedBootstrap'],
          message: 'Native app-managed bootstrap is only supported for anthropic/codex members',
        })
      }
      if (
        hashNativeBootstrapText(member.nativeAppManagedBootstrap.contextText) !==
        member.nativeAppManagedBootstrap.contextHash
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', index, 'nativeAppManagedBootstrap', 'contextHash'],
          message: 'Native app-managed bootstrap contextHash does not match contextText',
        })
      }
      if (!Number.isFinite(Date.parse(member.nativeAppManagedBootstrap.generatedAt))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['members', index, 'nativeAppManagedBootstrap', 'generatedAt'],
          message: 'Native app-managed bootstrap generatedAt must be a valid ISO timestamp',
        })
      }
    }
  }
})

function normalizeMember(
  member: TeamBootstrapSpec['members'][number],
): NormalizedBootstrapMember {
  const isWorktreeIsolated = member.isolation === 'worktree'
  const model = normalizeBootstrapModelSelection(member.model)
  return {
    originalName: member.name,
    displayName: member.name,
    normalizedName: sanitizeName(member.name),
    prompt: member.prompt ?? '',
    ...(member.role ? { role: member.role } : {}),
    ...(member.workflow ? { workflow: member.workflow } : {}),
    ...(member.agentType ? { agentType: member.agentType } : {}),
    ...(member.provider ? { provider: member.provider } : {}),
    ...(model ? { model } : {}),
    ...(member.effort ? { effort: member.effort } : {}),
    ...(isWorktreeIsolated ? { isolation: 'worktree' as const } : {}),
    ...(member.cwd && !isWorktreeIsolated ? { cwd: member.cwd } : {}),
    ...(member.useSplitPane !== undefined ? { useSplitPane: member.useSplitPane } : {}),
    ...(member.planModeRequired
      ? { planModeRequired: member.planModeRequired }
      : {}),
    ...(member.description ? { description: member.description } : {}),
    ...(member.mcpConfigPath ? { mcpConfigPath: member.mcpConfigPath } : {}),
    ...(member.mcpSettingSources ? { mcpSettingSources: member.mcpSettingSources } : {}),
    ...(member.strictMcpConfig !== undefined
      ? { strictMcpConfig: member.strictMcpConfig }
      : {}),
    ...(member.nativeAppManagedBootstrap
      ? { nativeAppManagedBootstrap: member.nativeAppManagedBootstrap }
      : {}),
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
      model: normalizeBootstrapModelSelection(member.model) ?? null,
      effort: member.effort ?? null,
      isolation: member.isolation ?? null,
      cwd: member.cwd ?? null,
      useSplitPane: member.useSplitPane ?? false,
      planModeRequired: member.planModeRequired ?? false,
      description: member.description ?? null,
      mcpConfigPath: member.mcpConfigPath ?? null,
      mcpSettingSources: member.mcpSettingSources ?? null,
      strictMcpConfig: member.strictMcpConfig ?? null,
      nativeAppManagedBootstrap: member.nativeAppManagedBootstrap
        ? {
            mode: member.nativeAppManagedBootstrap.mode,
            contextHash: member.nativeAppManagedBootstrap.contextHash,
            briefingHash: member.nativeAppManagedBootstrap.briefingHash,
          }
        : null,
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
    bootstrapTimeoutMs: parsed.launch?.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
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
