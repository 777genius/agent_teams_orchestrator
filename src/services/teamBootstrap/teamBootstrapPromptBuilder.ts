import { TEAM_LEAD_NAME } from 'src/utils/swarm/constants.js'
import { readTeamFileAsync, sanitizeName } from 'src/utils/swarm/teamHelpers.js'
import { listTasks } from 'src/utils/tasks.js'
import { normalizeBootstrapModelSelection } from './teamBootstrapModelSelection.js'
import type { TeamBootstrapSpec } from './teamBootstrapTypes.js'

export function buildAgentLanguageInstruction(agentLanguage?: string): string {
  const trimmed = agentLanguage?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system') {
    return ''
  }
  return `IMPORTANT: Communicate in ${trimmed}. All messages, summaries, and task descriptions MUST be in ${trimmed}.`
}

export async function resolveBootstrapLeadName(
  spec: TeamBootstrapSpec,
): Promise<string> {
  const explicitLead = spec.members.find(member =>
    member.role?.toLowerCase().includes('lead'),
  )
  if (explicitLead) {
    return explicitLead.name
  }

  if (spec.mode === 'launch') {
    const existingTeam = await readTeamFileAsync(spec.team.name)
    const lead = existingTeam?.members.find(
      member => member.agentId === existingTeam.leadAgentId,
    )
    if (lead?.name?.trim()) {
      return lead.name.trim()
    }
  }

  return TEAM_LEAD_NAME
}

export async function getMembersWithAssignedBoardWork(
  teamName: string,
): Promise<Set<string>> {
  const taskListId = sanitizeName(teamName)
  const tasks = await listTasks(taskListId)
  return new Set(
    tasks
      .filter(task => !task.id.startsWith('_internal') && task.owner)
      .map(task => task.owner as string),
  )
}

function buildMemberIdentityLine(params: {
  member: TeamBootstrapSpec['members'][number]
  displayName: string
  teamName: string
}): string {
  const role = params.member.role?.trim() || 'team member'
  const providerLine =
    params.member.provider && params.member.provider !== 'anthropic'
      ? ` Provider override: ${params.member.provider}.`
      : ''
  const model = normalizeBootstrapModelSelection(params.member.model)
  const modelLine = model
    ? ` Model override: ${model}.`
    : ''
  const effortLine = params.member.effort
    ? ` Effort override: ${params.member.effort}.`
    : ''

  return `You are ${params.member.name}, a ${role} on team "${params.displayName}" (${params.teamName}).${providerLine}${modelLine}${effortLine}`
}

function buildWorkflowBlock(
  member: TeamBootstrapSpec['members'][number],
): string[] {
  return member.workflow?.trim()
    ? ['', 'Workflow:', member.workflow.trim()]
    : []
}

function buildReviewFlowReminder(): string[] {
  return [
    'Review flow rule: review is a state transition on the SAME work task, not a separate task.',
    'If task #X needs review and a reviewer exists or has been named, finish the work on #X, call task_complete on #X, then use review_request on #X for that reviewer. If no reviewer exists, leave #X completed. Do NOT create a separate "review task".',
    'If you are reviewing task #X, call review_start on #X first, then review_approve or review_request_changes on #X itself.',
    'If review requests changes, resume the SAME task #X, implement the fixes, call task_complete on #X again, and send #X back through review_request when ready.',
  ]
}

export async function buildDeterministicBootstrapMemberPrompt(params: {
  spec: TeamBootstrapSpec
  member: TeamBootstrapSpec['members'][number]
  leadName?: string
  assignedWorkMembers?: Set<string>
}): Promise<string> {
  const displayName = params.spec.team.displayName?.trim() || params.spec.team.name
  const leadName = params.leadName ?? (await resolveBootstrapLeadName(params.spec))
  const agentLanguageInstruction = buildAgentLanguageInstruction(
    params.spec.lead.agentLanguage,
  )
  const assignedWorkMembers =
    params.assignedWorkMembers ??
    (params.spec.mode === 'launch'
      ? await getMembersWithAssignedBoardWork(params.spec.team.name)
      : new Set<string>())
  const hasAssignedBoardWork = assignedWorkMembers.has(params.member.name)

  const lines = [
    buildMemberIdentityLine({
      member: params.member,
      displayName,
      teamName: params.spec.team.name,
    }),
    ...buildWorkflowBlock(params.member),
    agentLanguageInstruction,
    params.spec.mode === 'launch'
      ? 'The team has already been reconnected and you are being re-attached as a persistent teammate.'
      : 'The team has already been created and you are being attached as a persistent teammate.',
    'Your FIRST action: call MCP tool member_briefing on the "agent-teams" server with:',
    `{ teamName: "${params.spec.team.name}", memberName: "${params.member.name}" }`,
    'If tool search shows the prefixed MCP tool name instead, use mcp__agent-teams__member_briefing.',
    'Call the MCP tool directly yourself. Do NOT run a shell command named member_briefing. Do NOT use Agent, any subagent, or a delegated helper for this bootstrap step.',
    `If member_briefing fails, send one short natural-language message to "${leadName}" with the exact error text.`,
    hasAssignedBoardWork
      ? 'After member_briefing succeeds, resume your queue normally and prioritize already-assigned board work before taking new blocking work.'
      : 'After member_briefing succeeds, wait for instructions from the lead and use team mailbox/task tools normally.',
    'Do NOT send acknowledgement-only messages such as "ready" or "online".',
    ...buildReviewFlowReminder(),
  ].filter(Boolean)

  return lines.join('\n')
}
