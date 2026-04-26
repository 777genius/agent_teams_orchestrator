import { createHash } from 'node:crypto'

import {
  normalizeOpenCodeFilePath,
  type NormalizedOpenCodeFilePath,
} from './OpenCodeBridgePath.js'

import type {
  OpenCodeSqliteMessageRow,
  OpenCodeSqlitePartRow,
} from './OpenCodeOfflineSessionReader.js'

export type OpenCodeTaskRef = {
  taskId: string
  displayId?: string
  teamName: string
}

export type OpenCodeLedgerAttributionMode = 'strict-delivery' | 'compatible'

export type OpenCodeDeliveryContextV1 = {
  schemaVersion: 1
  teamName: string
  taskId?: string
  records: Array<{
    memberName: string
    laneId?: string
    runtimeSessionId?: string | null
    inboxMessageId?: string | null
    deliveredUserMessageId?: string | null
    observedAssistantMessageId?: string | null
    prePromptCursor?: string | null
    postPromptCursor?: string | null
    taskRefs: OpenCodeTaskRef[]
  }>
}

export type ReconstructedOpenCodeToolChange = {
  taskId: string
  taskRef: string
  taskRefKind: 'canonical'
  teamName: string
  memberName: string
  sessionId: string
  parentUserMessageId?: string
  assistantMessageId?: string
  toolUseId: string
  sourcePartId: string
  sourceMessageId: string
  sourceTool: 'write' | 'edit'
  sourceImportKey: string
  filePath: string
  relativePath: string
  beforeContent: string | null
  afterContent: string | null
  beforeState?: {
    exists?: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }
  afterState?: {
    exists?: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }
  operation: 'create' | 'modify'
  confidence: 'exact' | 'high'
  attributionMethod:
    | 'parent-taskrefs-exact'
    | 'delivery-ledger-taskrefs'
    | 'requested-task-marker'
  oldString?: string
  newString?: string
  warnings?: string[]
  timestamp: string
}

type Toolpart = {
  partId: string
  messageId: string
  parentUserMessageId?: string
  tool: 'write' | 'edit'
  callId?: string
  status: string
  filePath: string
  content?: string
  oldString?: string
  newString?: string
  metadataExists?: boolean
  truncated?: boolean
  partTimeCreated: number
  messageTimeCreated: number
  messageIdSort: string
  timestamp: string
}

type TaskContext = {
  taskRef: OpenCodeTaskRef
  method: ReconstructedOpenCodeToolChange['attributionMethod']
  warning?: string
}

type TaskContextResolution =
  | { type: 'matched'; context: TaskContext }
  | { type: 'skipped'; notice?: { severity: 'warning'; message: string; code: string } }

type ReconstructedFileState = {
  text: string | null
  textAvailability: 'full-text' | 'metadata-only' | 'unavailable'
  exists: boolean
}

const MAX_TEXT_BLOB_BYTES = 1024 * 1024
const TASK_REFS_MARKER = 'include taskRefs exactly:'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function safeParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function contentStateForText(content: string): { exists: true; sha256: string; sizeBytes: number } {
  return {
    exists: true,
    sha256: sha256(content),
    sizeBytes: byteLength(content),
  }
}

function looksBinary(value: string): boolean {
  return value.includes('\0')
}

function isFullTextAvailable(content: string | undefined, truncated: boolean | undefined): content is string {
  return (
    typeof content === 'string' &&
    truncated !== true &&
    byteLength(content) <= MAX_TEXT_BLOB_BYTES &&
    !looksBinary(content)
  )
}

function readJsonArrayAfter(text: string, startIndex: number): string | null {
  const openIndex = text.indexOf('[', startIndex)
  if (openIndex < 0) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '[') {
      depth += 1
    } else if (char === ']') {
      depth -= 1
      if (depth === 0) {
        return text.slice(openIndex, index + 1)
      }
    }
  }
  return null
}

function isValidTaskRef(value: unknown): value is OpenCodeTaskRef {
  const record = asRecord(value)
  return (
    typeof record?.taskId === 'string' &&
    record.taskId.length > 0 &&
    typeof record.teamName === 'string' &&
    record.teamName.length > 0 &&
    (record.displayId === undefined || typeof record.displayId === 'string')
  )
}

function extractDeliveredTaskRefs(text: string): OpenCodeTaskRef[] {
  const index = text.indexOf(TASK_REFS_MARKER)
  if (index < 0) {
    return []
  }
  const arrayText = readJsonArrayAfter(text, index + TASK_REFS_MARKER.length)
  if (!arrayText) {
    return []
  }
  try {
    const parsed = JSON.parse(arrayText) as unknown
    return Array.isArray(parsed) ? parsed.filter(isValidTaskRef) : []
  } catch {
    return []
  }
}

function getTextFromParts(parts: Record<string, unknown>[]): string {
  return parts.map(part => asString(part.text) ?? '').filter(Boolean).join('\n')
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0
  }
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found < 0) {
      return count
    }
    count += 1
    index = found + needle.length
  }
}

function toIsoTimestamp(value: number | null, fallback: number): string {
  const millis = value && Number.isFinite(value) ? value : fallback
  return new Date(millis).toISOString()
}

function buildSourceImportKey(params: {
  sessionId: string
  partId: string
  normalizedPath: NormalizedOpenCodeFilePath
}): string {
  return ['opencode', params.sessionId, params.partId, params.normalizedPath.comparisonKey].join('\0')
}

function parentPromptReferencesRequestedTask(text: string, requested: OpenCodeTaskRef): boolean {
  if (text.includes(requested.taskId)) {
    return true
  }
  if (!requested.displayId) {
    return false
  }
  const taskMarkers = Array.from(text.matchAll(/(^|[^\w])#([a-zA-Z0-9][a-zA-Z0-9_-]{2,64})\b/g))
    .map(match => match[2])
  if (taskMarkers.length === 0) {
    return false
  }
  if (taskMarkers.some(marker => marker !== requested.displayId)) {
    return false
  }
  return taskMarkers.includes(requested.displayId)
}

export class OpenCodeToolpartChangeReconstructor {
  reconstruct(params: {
    teamName: string
    memberName: string
    sessionId: string
    projectPath: string
    rawMessages: OpenCodeSqliteMessageRow[]
    rawParts: OpenCodeSqlitePartRow[]
    requestedTask?: OpenCodeTaskRef
    deliveryContext?: OpenCodeDeliveryContextV1 | null
    attributionMode?: OpenCodeLedgerAttributionMode
    laneId?: string | null
  }): {
    changes: ReconstructedOpenCodeToolChange[]
    notices: Array<{ severity: 'warning'; message: string; code: string }>
    diagnostics: string[]
  } {
    const diagnostics: string[] = []
    const notices: Array<{ severity: 'warning'; message: string; code: string }> = []
    const messagesById = new Map<string, Record<string, unknown>>()
    const messageTimeById = new Map<string, number>()
    const partsByMessageId = new Map<string, Record<string, unknown>[]>()

    for (const row of params.rawMessages) {
      const parsed = safeParseJsonRecord(row.data)
      if (!parsed) {
        diagnostics.push(`OpenCode message row ${row.id} could not be parsed for reconstruction.`)
        continue
      }
      parsed.id = row.id
      messagesById.set(row.id, parsed)
      messageTimeById.set(row.id, row.time_created)
    }

    const parsedParts: Array<{ row: OpenCodeSqlitePartRow; data: Record<string, unknown> }> = []
    for (const row of params.rawParts) {
      const parsed = safeParseJsonRecord(row.data)
      if (!parsed) {
        diagnostics.push(`OpenCode part row ${row.id} could not be parsed for reconstruction.`)
        continue
      }
      parsed.id = row.id
      parsedParts.push({ row, data: parsed })
      const bucket = partsByMessageId.get(row.message_id) ?? []
      bucket.push(parsed)
      partsByMessageId.set(row.message_id, bucket)
    }

    const toolparts = this.extractToolparts(parsedParts, messagesById, messageTimeById, diagnostics)
    const fileStates = new Map<string, ReconstructedFileState>()
    const changes: ReconstructedOpenCodeToolChange[] = []

    for (const toolpart of toolparts.sort((left, right) => {
      return (
        left.partTimeCreated - right.partTimeCreated ||
        left.messageTimeCreated - right.messageTimeCreated ||
        left.messageIdSort.localeCompare(right.messageIdSort) ||
        left.partId.localeCompare(right.partId)
      )
    })) {
      if (toolpart.status !== 'completed') {
        continue
      }
      const normalizedPath = normalizeOpenCodeFilePath({
        projectPath: params.projectPath,
        filePath: toolpart.filePath,
      })
      if ('skipped' in normalizedPath) {
        diagnostics.push(normalizedPath.diagnostic)
        continue
      }
      const taskContextResolution = this.resolveTaskContext({
        toolpart,
        partsByMessageId,
        params,
        diagnostics,
      })
      if (taskContextResolution.type === 'skipped') {
        if (taskContextResolution.notice) {
          notices.push(taskContextResolution.notice)
        }
        continue
      }
      const taskContext = taskContextResolution.context

      if (toolpart.tool === 'write') {
        const previousState = fileStates.get(normalizedPath.comparisonKey)
        const fullTextAvailable = isFullTextAvailable(toolpart.content, toolpart.truncated)
        const beforeKind =
          previousState
            ? previousState.exists === false
              ? 'known-absent'
              : previousState.textAvailability === 'full-text'
                ? 'known-text'
                : 'unavailable-existing'
            : toolpart.metadataExists === false
              ? 'known-absent'
              : 'unavailable-existing'
        const beforeContent =
          beforeKind === 'known-text' && previousState?.textAvailability === 'full-text'
            ? previousState.text
            : null
        const afterContent = fullTextAvailable ? toolpart.content : null
        const unavailableReason =
          fullTextAvailable
            ? undefined
            : toolpart.truncated === true
              ? 'opencode-toolpart-content-truncated'
              : 'opencode-toolpart-content-unavailable-or-too-large'

        fileStates.set(normalizedPath.comparisonKey, {
          text: afterContent,
          textAvailability: afterContent === null ? 'metadata-only' : 'full-text',
          exists: true,
        })

        changes.push({
          taskId: taskContext.taskRef.taskId,
          taskRef: taskContext.taskRef.taskId,
          taskRefKind: 'canonical',
          teamName: taskContext.taskRef.teamName,
          memberName: params.memberName,
          sessionId: params.sessionId,
          ...(toolpart.parentUserMessageId ? { parentUserMessageId: toolpart.parentUserMessageId } : {}),
          assistantMessageId: toolpart.messageId,
          toolUseId: toolpart.callId ?? toolpart.partId,
          sourcePartId: toolpart.partId,
          sourceMessageId: toolpart.messageId,
          sourceTool: 'write',
          sourceImportKey: buildSourceImportKey({
            sessionId: params.sessionId,
            partId: toolpart.partId,
            normalizedPath,
          }),
          filePath: normalizedPath.absolutePath,
          relativePath: normalizedPath.relativePath,
          beforeContent,
          afterContent,
          operation: beforeKind === 'known-absent' ? 'create' : 'modify',
          confidence: beforeKind === 'known-text' || beforeKind === 'known-absent' ? 'exact' : 'high',
          attributionMethod: taskContext.method,
          timestamp: toolpart.timestamp,
          beforeState:
            beforeKind === 'known-text' && beforeContent !== null
              ? contentStateForText(beforeContent)
              : beforeKind === 'known-absent'
                ? { exists: false, sizeBytes: 0 }
                : { exists: true, unavailableReason: 'opencode-before-content-unavailable' },
          afterState:
            afterContent !== null
              ? contentStateForText(afterContent)
              : { exists: true, unavailableReason },
          warnings: [
            ...(beforeKind === 'unavailable-existing'
              ? ['OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.']
              : []),
            ...(unavailableReason ? ['OpenCode toolpart content was unavailable or too large; review is manual-only.'] : []),
            ...(taskContext.warning ? [taskContext.warning] : []),
          ].filter(Boolean),
        })
        continue
      }

      const previousState = fileStates.get(normalizedPath.comparisonKey)
      const previous = previousState?.textAvailability === 'full-text' ? previousState.text : null
      if (
        typeof toolpart.oldString === 'string' &&
        typeof toolpart.newString === 'string' &&
        toolpart.oldString === toolpart.newString
      ) {
        diagnostics.push(`OpenCode edit toolpart ${toolpart.partId} skipped because it contained no text delta.`)
        continue
      }
      if (
        typeof previous !== 'string' ||
        typeof toolpart.oldString !== 'string' ||
        typeof toolpart.newString !== 'string' ||
        countOccurrences(previous, toolpart.oldString) !== 1 ||
        toolpart.truncated === true
      ) {
        if (
          typeof toolpart.oldString !== 'string' ||
          typeof toolpart.newString !== 'string' ||
          toolpart.truncated === true
        ) {
          diagnostics.push(`OpenCode edit toolpart ${toolpart.partId} skipped because edit replacement fields were unavailable.`)
          continue
        }
        fileStates.set(normalizedPath.comparisonKey, {
          text: null,
          textAvailability: 'metadata-only',
          exists: true,
        })
        changes.push({
          taskId: taskContext.taskRef.taskId,
          taskRef: taskContext.taskRef.taskId,
          taskRefKind: 'canonical',
          teamName: taskContext.taskRef.teamName,
          memberName: params.memberName,
          sessionId: params.sessionId,
          ...(toolpart.parentUserMessageId ? { parentUserMessageId: toolpart.parentUserMessageId } : {}),
          assistantMessageId: toolpart.messageId,
          toolUseId: toolpart.callId ?? toolpart.partId,
          sourcePartId: toolpart.partId,
          sourceMessageId: toolpart.messageId,
          sourceTool: 'edit',
          sourceImportKey: buildSourceImportKey({
            sessionId: params.sessionId,
            partId: toolpart.partId,
            normalizedPath,
          }),
          filePath: normalizedPath.absolutePath,
          relativePath: normalizedPath.relativePath,
          beforeContent: null,
          afterContent: null,
          operation: 'modify',
          confidence: 'high',
          attributionMethod: taskContext.method,
          oldString: toolpart.oldString,
          newString: toolpart.newString,
          beforeState: {
            exists: true,
            unavailableReason: previousState
              ? 'opencode-edit-baseline-content-unavailable'
              : 'opencode-edit-baseline-not-captured',
          },
          afterState: {
            exists: true,
            unavailableReason: 'opencode-edit-final-content-unavailable',
          },
          timestamp: toolpart.timestamp,
          warnings: [
            'OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.',
            ...(taskContext.warning ? [taskContext.warning] : []),
          ],
        })
        continue
      }
      const afterContent = previous.replace(toolpart.oldString, toolpart.newString)
      fileStates.set(normalizedPath.comparisonKey, {
        text: afterContent,
        textAvailability: 'full-text',
        exists: true,
      })
      changes.push({
        taskId: taskContext.taskRef.taskId,
        taskRef: taskContext.taskRef.taskId,
        taskRefKind: 'canonical',
        teamName: taskContext.taskRef.teamName,
        memberName: params.memberName,
        sessionId: params.sessionId,
        ...(toolpart.parentUserMessageId ? { parentUserMessageId: toolpart.parentUserMessageId } : {}),
        assistantMessageId: toolpart.messageId,
        toolUseId: toolpart.callId ?? toolpart.partId,
        sourcePartId: toolpart.partId,
        sourceMessageId: toolpart.messageId,
        sourceTool: 'edit',
        sourceImportKey: buildSourceImportKey({
          sessionId: params.sessionId,
          partId: toolpart.partId,
          normalizedPath,
        }),
        filePath: normalizedPath.absolutePath,
        relativePath: normalizedPath.relativePath,
        beforeContent: previous,
        afterContent,
        operation: 'modify',
        confidence: 'exact',
        attributionMethod: taskContext.method,
        oldString: toolpart.oldString,
        newString: toolpart.newString,
        beforeState: contentStateForText(previous),
        afterState: contentStateForText(afterContent),
        timestamp: toolpart.timestamp,
        warnings: taskContext.warning ? [taskContext.warning] : undefined,
      })
    }

    return { changes, notices, diagnostics }
  }

  private extractToolparts(
    rows: Array<{ row: OpenCodeSqlitePartRow; data: Record<string, unknown> }>,
    messagesById: Map<string, Record<string, unknown>>,
    messageTimeById: Map<string, number>,
    diagnostics: string[],
  ): Toolpart[] {
    const toolparts: Toolpart[] = []
    for (const { row, data } of rows) {
      if (data.type !== 'tool') {
        continue
      }
      const tool = asString(data.tool)
      if (tool !== 'write' && tool !== 'edit') {
        continue
      }
      const state = asRecord(data.state)
      const input = asRecord(state?.input)
      const metadata = asRecord(state?.metadata)
      const filePath = asString(input?.filePath)
      if (!state || !input || !filePath) {
        diagnostics.push(`OpenCode ${tool} toolpart ${row.id} missing state/input/filePath.`)
        continue
      }
      const assistantMessage = messagesById.get(row.message_id)
      toolparts.push({
        partId: row.id,
        messageId: row.message_id,
        parentUserMessageId: asString(assistantMessage?.parentID),
        tool,
        callId: asString(data.callID) ?? undefined,
        status: asString(state.status)?.toLowerCase() ?? 'unknown',
        filePath,
        content: asStringValue(input.content) ?? undefined,
        oldString: asStringValue(input.oldString) ?? undefined,
        newString: asStringValue(input.newString) ?? undefined,
        metadataExists: typeof metadata?.exists === 'boolean' ? metadata.exists : undefined,
        truncated: typeof metadata?.truncated === 'boolean' ? metadata.truncated : undefined,
        partTimeCreated: row.time_created,
        messageTimeCreated: messageTimeById.get(row.message_id) ?? row.time_created,
        messageIdSort: row.message_id,
        timestamp: toIsoTimestamp(asNumber(asRecord(state.time)?.end) ?? asNumber(asRecord(state.time)?.start), row.time_created),
      })
    }
    return toolparts
  }

  private resolveTaskContext(input: {
    toolpart: Toolpart
    partsByMessageId: Map<string, Record<string, unknown>[]>
    params: {
      teamName: string
      memberName: string
      sessionId: string
      laneId?: string | null
      requestedTask?: OpenCodeTaskRef
      deliveryContext?: OpenCodeDeliveryContextV1 | null
      attributionMode?: OpenCodeLedgerAttributionMode
    }
    diagnostics: string[]
  }): TaskContextResolution {
    const attributionMode = input.params.attributionMode ?? 'compatible'
    if (attributionMode === 'strict-delivery') {
      const deliveryRefs = this.lookupStrictDeliveryRefs({
        deliveryContext: input.params.deliveryContext,
        parentUserMessageId: input.toolpart.parentUserMessageId,
        teamName: input.params.teamName,
        memberName: input.params.memberName,
        sessionId: input.params.sessionId,
        laneId: input.params.laneId,
        requestedTask: input.params.requestedTask,
      })
      if (deliveryRefs.length === 1) {
        return {
          type: 'matched',
          context: { taskRef: deliveryRefs[0], method: 'delivery-ledger-taskrefs' },
        }
      }
      if (deliveryRefs.length > 1) {
        input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} strict delivery context contained multiple matching task refs.`)
      } else {
        input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} skipped because no strict delivery record matched its parent message.`)
      }
      return { type: 'skipped' }
    }

    const parentParts = input.toolpart.parentUserMessageId
      ? input.partsByMessageId.get(input.toolpart.parentUserMessageId) ?? []
      : []
    const parentText = getTextFromParts(parentParts)
    const exactRefs = extractDeliveredTaskRefs(parentText).filter(ref => ref.teamName === input.params.teamName)
    if (exactRefs.length === 1) {
      return {
        type: 'matched',
        context: { taskRef: exactRefs[0], method: 'parent-taskrefs-exact' },
      }
    }
    if (exactRefs.length > 1) {
      input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} parent prompt contained multiple task refs.`)
      return {
        type: 'skipped',
        notice: {
          severity: 'warning',
          code: 'opencode-attribution-ambiguous',
          message: `OpenCode toolpart ${input.toolpart.partId} was skipped because task attribution was ambiguous.`,
        },
      }
    }

    const deliveryRefs = this.lookupDeliveryRefs(input.params.deliveryContext, input.toolpart.parentUserMessageId)
      .filter(ref => ref.teamName === input.params.teamName)
    if (deliveryRefs.length === 1) {
      return {
        type: 'matched',
        context: { taskRef: deliveryRefs[0], method: 'delivery-ledger-taskrefs' },
      }
    }
    if (deliveryRefs.length > 1) {
      input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} delivery context contained multiple task refs.`)
      return {
        type: 'skipped',
        notice: {
          severity: 'warning',
          code: 'opencode-attribution-ambiguous',
          message: `OpenCode toolpart ${input.toolpart.partId} was skipped because task attribution was ambiguous.`,
        },
      }
    }

    if (
      input.params.requestedTask &&
      parentPromptReferencesRequestedTask(parentText, input.params.requestedTask)
    ) {
      return {
        type: 'matched',
        context: {
          taskRef: input.params.requestedTask,
          method: 'requested-task-marker',
          warning: 'OpenCode follow-up prompt referenced the requested task but did not include exact taskRefs JSON.',
        },
      }
    }
    return {
      type: 'skipped',
      notice: {
        severity: 'warning',
        code: 'opencode-attribution-ambiguous',
        message: `OpenCode toolpart ${input.toolpart.partId} was skipped because task attribution was ambiguous.`,
      },
    }
  }

  private lookupStrictDeliveryRefs(input: {
    deliveryContext: OpenCodeDeliveryContextV1 | null | undefined
    parentUserMessageId: string | undefined
    teamName: string
    memberName: string
    sessionId: string
    laneId?: string | null
    requestedTask?: OpenCodeTaskRef
  }): OpenCodeTaskRef[] {
    if (!input.deliveryContext || !input.parentUserMessageId || !input.requestedTask) {
      return []
    }
    const refs: OpenCodeTaskRef[] = []
    for (const record of input.deliveryContext.records) {
      if (record.memberName !== input.memberName) {
        continue
      }
      if (!record.laneId || !input.laneId || record.laneId !== input.laneId) {
        continue
      }
      if (!record.runtimeSessionId || record.runtimeSessionId !== input.sessionId) {
        continue
      }
      if (
        record.deliveredUserMessageId !== input.parentUserMessageId &&
        record.inboxMessageId !== input.parentUserMessageId
      ) {
        continue
      }
      refs.push(
        ...record.taskRefs.filter(ref =>
          ref.teamName === input.teamName &&
          ref.taskId === input.requestedTask?.taskId
        ),
      )
    }
    return refs
  }

  private lookupDeliveryRefs(
    deliveryContext: OpenCodeDeliveryContextV1 | null | undefined,
    parentUserMessageId: string | undefined,
  ): OpenCodeTaskRef[] {
    if (!deliveryContext || !parentUserMessageId) {
      return []
    }
    const refs: OpenCodeTaskRef[] = []
    for (const record of deliveryContext.records) {
      if (
        record.deliveredUserMessageId === parentUserMessageId ||
        record.inboxMessageId === parentUserMessageId ||
        record.prePromptCursor === parentUserMessageId ||
        record.postPromptCursor === parentUserMessageId
      ) {
        refs.push(...record.taskRefs)
      }
    }
    return refs
  }
}
