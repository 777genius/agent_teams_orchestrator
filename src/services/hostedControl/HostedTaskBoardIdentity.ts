import { createHash } from 'node:crypto'

/**
 * Board identities shared byte-for-byte with Product's hosted task board
 * (hostedTaskBoardKanbanState.ts): the browser reads the board through Product and sends these
 * values back to the Owner writer. docs/hosted-owner-bound-envelope-golden.json pins them.
 */
export function hostedTaskBoardSourceGeneration(input: {
  deploymentId: string
  bootId: string
  workspaceId: string
  mountGeneration: number
  teamId: string
  /** Decimal device and inode strings; bigint-exact like Product's descriptor identity. */
  teamDirectory: readonly [string, string]
  tasksDirectory: readonly [string, string]
}): string {
  return `generation_${sha256(JSON.stringify({
    domain: 'hosted-task-board-source/v2',
    deploymentId: input.deploymentId,
    bootId: input.bootId,
    workspaceId: input.workspaceId,
    mountGeneration: input.mountGeneration,
    teamId: input.teamId,
    teamDirectory: input.teamDirectory,
    tasksDirectory: input.tasksDirectory,
  }))}`
}

export function hostedTaskBoardRevision(input: {
  sourceGeneration: string
  taskTexts: ReadonlyMap<string, string>
  kanbanText: string | null
  /** Roster file name and SHA-256 of its text, or null when the file is absent. */
  rosterHashes: ReadonlyArray<readonly [string, string | null]>
}): string {
  const taskFiles = [...input.taskTexts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, sha256(text)])
  const roster = [...input.rosterHashes].sort(([a], [b]) => a.localeCompare(b))
  return `revision_${sha256(JSON.stringify({
    domain: 'hosted-task-board-revision/v3',
    sourceGeneration: input.sourceGeneration,
    taskFiles,
    kanban: input.kanbanText === null ? null : sha256(input.kanbanText),
    roster,
  }))}`
}

export function hostedTaskBoardTaskId(teamId: string, rawTaskId: string): string {
  return `task_${sha256(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId })).slice(0, 32)}`
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
