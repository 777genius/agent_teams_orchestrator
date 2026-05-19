import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isWindowsReservedBasename } from '../../utils/windowsReservedNames.js'
import { NoopTeamBootstrapProgressSink } from '../../services/teamBootstrap/teamBootstrapEvents.js'
import { getDeterministicBootstrapAvailabilityReason } from '../../services/teamBootstrap/teamBootstrapFeatureGate.js'
import { normalizeBootstrapModelSelection } from '../../services/teamBootstrap/teamBootstrapModelSelection.js'
import { runTeamBootstrap } from '../../services/teamBootstrap/teamBootstrapRunner.js'
import { buildTeamBootstrapRequestFromSpec } from '../../services/teamBootstrap/teamBootstrapSpec.js'
import type { TeamBootstrapSpec } from '../../services/teamBootstrap/teamBootstrapTypes.js'
import { TEAM_BOOTSTRAP_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const MAX_BOOTSTRAP_TIMEOUT_MS = 300_000

const memberSchema = z.strictObject({
  name: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
  workflow: z.string().trim().min(1).optional(),
  agent_type: z.string().trim().min(1).optional(),
  provider: z.enum(['anthropic', 'codex', 'gemini']).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  use_split_pane: z.boolean().optional(),
  plan_mode_required: z.boolean().optional(),
  description: z.string().trim().min(1).optional(),
})

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      mode: z.enum(['create', 'launch']).default('create'),
      team_name: z.string().trim().min(1),
      display_name: z.string().trim().min(1).optional(),
      description: z.string().trim().optional(),
      color: z.string().trim().min(1).optional(),
      cwd: z.string().trim().min(1).optional(),
      agent_language: z.string().trim().min(1).optional(),
      continue_on_partial_failure: z.boolean().optional(),
      bootstrap_timeout_ms: z
        .number()
        .int()
        .positive()
        .max(MAX_BOOTSTRAP_TIMEOUT_MS)
        .optional(),
      members: z.array(memberSchema).min(1).max(8),
    })
    .superRefine((input, ctx) => {
      if (isWindowsReservedBasename(input.team_name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['team_name'],
          message: `team_name "${input.team_name}" is reserved on Windows`,
        })
      }
      for (const [index, member] of input.members.entries()) {
        if (isWindowsReservedBasename(member.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['members', index, 'name'],
            message: `Member name "${member.name}" is reserved on Windows`,
          })
        }
      }
    }),
)

type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    runId: z.string(),
    requestHash: z.string(),
    teamName: z.string(),
    mode: z.enum(['create', 'launch']),
    createdTeam: z.boolean(),
    reusedExistingTeam: z.boolean(),
    terminalStatus: z.enum(['completed', 'partial_success', 'failed', 'canceled']),
    expectedMembers: z.array(z.string()),
    registeredMembers: z.array(z.string()),
    failedMembers: z.array(
      z.object({
        name: z.string(),
        reason: z.string(),
      }),
    ),
  }),
)

type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export function buildToolBootstrapSpec(
  input: z.infer<InputSchema>,
): TeamBootstrapSpec {
  return {
    version: 1,
    runId: randomUUID(),
    mode: input.mode,
    initiator: {
      kind: 'tool',
      source: 'TeamBootstrap',
    },
    team: {
      name: input.team_name,
      ...(input.display_name ? { displayName: input.display_name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.color ? { color: input.color } : {}),
      cwd: input.cwd ?? getCwd(),
    },
    lead: {
      ...(input.agent_language ? { agentLanguage: input.agent_language } : {}),
      permissionSeedTools: ['Edit', 'Write', 'NotebookEdit'],
    },
    members: input.members.map(member => {
      const model = normalizeBootstrapModelSelection(member.model)
      return {
        name: member.name,
        ...(member.role ? { role: member.role } : {}),
        ...(member.workflow ? { workflow: member.workflow } : {}),
        ...(member.agent_type ? { agentType: member.agent_type } : {}),
        ...(member.provider ? { provider: member.provider } : {}),
        ...(model ? { model } : {}),
        ...(member.effort ? { effort: member.effort } : {}),
        ...(member.cwd ? { cwd: member.cwd } : {}),
        ...(member.use_split_pane !== undefined
          ? { useSplitPane: member.use_split_pane }
          : {}),
        ...(member.plan_mode_required !== undefined
          ? { planModeRequired: member.plan_mode_required }
          : {}),
        ...(member.description ? { description: member.description } : {}),
      }
    }),
    launch: {
      ...(input.bootstrap_timeout_ms
        ? { bootstrapTimeoutMs: input.bootstrap_timeout_ms }
        : {}),
      ...(input.continue_on_partial_failure !== undefined
        ? { continueOnPartialFailure: input.continue_on_partial_failure }
        : {}),
    },
    ui: {
      emitStructuredEvents: false,
    },
  }
}

export const TeamBootstrapTool = buildTool({
  name: TEAM_BOOTSTRAP_TOOL_NAME,
  searchHint: 'deterministically bootstrap a persistent team',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    return (
      isAgentSwarmsEnabled() &&
      !getDeterministicBootstrapAvailabilityReason() &&
      isEnvTruthy(process.env.CLAUDE_ENABLE_TEAM_BOOTSTRAP_TOOL)
    )
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  async validateInput(input, context) {
    const unavailableReason = getDeterministicBootstrapAvailabilityReason()
    if (unavailableReason) {
      return {
        result: false,
        message: `${unavailableReason}.`,
        errorCode: 9,
      }
    }
    if (context.agentId) {
      return {
        result: false,
        message:
          'TeamBootstrap can only run from the main lead session, not from a teammate or nested agent.',
        errorCode: 9,
      }
    }
    const currentTeamName = context.getAppState().teamContext?.teamName
    if (currentTeamName && currentTeamName !== input.team_name) {
      return {
        result: false,
        message:
          `TeamBootstrap cannot switch this lead session from team "${currentTeamName}" to "${input.team_name}". ` +
          'Finish or delete the current team first, or start a fresh lead session.',
        errorCode: 9,
      }
    }
    return { result: true }
  },
  renderToolUseMessage() {
    return null
  },
  async call(input, context) {
    const unavailableReason = getDeterministicBootstrapAvailabilityReason()
    if (unavailableReason) {
      throw new Error(unavailableReason)
    }
    const request = await buildTeamBootstrapRequestFromSpec(
      buildToolBootstrapSpec(input),
    )
    const result = await runTeamBootstrap({
      request,
      context,
      emit: NoopTeamBootstrapProgressSink,
    })
    if (!result.ok) {
      throw new Error(result.error)
    }

    return {
      data: result.summary satisfies Output,
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: jsonStringify(output),
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, Output>)
