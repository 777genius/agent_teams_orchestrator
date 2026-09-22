import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'

export const BOARD_TASK_ACTIVITY_SCHEMA_VERSION = 1 as const

export type BoardTaskRefKind = 'canonical' | 'display' | 'unknown'
export type BoardTaskLinkKind = 'execution' | 'lifecycle' | 'board_action'
export type BoardTaskTargetRole = 'subject' | 'related'
export type BoardTaskPhase = 'work' | 'review'
export type BoardTaskActorRelation =
  | 'same_task'
  | 'other_active_task'
  | 'idle'
  | 'ambiguous'
export type BoardTaskArgumentSlot = 'taskId' | 'targetId'
export type BoardTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'deleted'
export type BoardTaskRelationship = 'blocked-by' | 'blocks' | 'related'

export type BoardTaskLocator = {
  ref: string
  refKind: BoardTaskRefKind
  canonicalId?: string
}

export type BoardTaskActorContext = {
  relation: BoardTaskActorRelation
  activeTask?: BoardTaskLocator
  activePhase?: BoardTaskPhase
  activeExecutionSeq?: number
}

export type BoardTaskLinkV1 = {
  schemaVersion: typeof BOARD_TASK_ACTIVITY_SCHEMA_VERSION
  toolUseId?: string
  task: BoardTaskLocator
  targetRole: BoardTaskTargetRole
  linkKind: BoardTaskLinkKind
  taskArgumentSlot?: BoardTaskArgumentSlot
  actorContext: BoardTaskActorContext
}

export type BoardTaskToolActionInput = {
  status?: BoardTaskStatus
  owner?: string | null
  clarification?: 'lead' | 'user' | null
  reviewer?: string
  relationship?: BoardTaskRelationship
  commentId?: string
}

export type BoardTaskToolActionResultRefs = {
  commentId?: string
  attachmentId?: string
  filename?: string
}

export type BoardTaskToolActionV1 = {
  schemaVersion: typeof BOARD_TASK_ACTIVITY_SCHEMA_VERSION
  toolUseId: string
  canonicalToolName: string
  input?: BoardTaskToolActionInput
  resultRefs?: BoardTaskToolActionResultRefs
}

export type BoardTaskCarrierFields = {
  boardTaskLinks?: BoardTaskLinkV1[]
  boardTaskToolActions?: BoardTaskToolActionV1[]
}

export type TaskAwareMessage = Message & BoardTaskCarrierFields
export type TaskAwareUserMessage = UserMessage & BoardTaskCarrierFields
export type TaskAwareAssistantMessage = AssistantMessage &
  Pick<BoardTaskCarrierFields, 'boardTaskLinks'>
