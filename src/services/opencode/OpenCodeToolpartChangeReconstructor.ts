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
  operation: 'create' | 'modify' | 'delete'
  confidence: 'exact' | 'high'
  attributionMethod: 'delivery-ledger-taskrefs'
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
  metadataOnly?: boolean
  operationOverride?: ReconstructedOpenCodeToolChange['operation']
  warnings?: string[]
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
const OPENCODE_APP_DELIVERY_START = '<opencode_app_message_delivery>'
const OPENCODE_APP_DELIVERY_END = '</opencode_app_message_delivery>'
const OPENCODE_DELIVERY_CONTEXT_START = '<opencode_delivery_context>'
const OPENCODE_DELIVERY_CONTEXT_END = '</opencode_delivery_context>'

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

function getOpenCodeAppDeliveryBlockText(text: string): string | null {
  const start = text.indexOf(OPENCODE_APP_DELIVERY_START)
  if (start < 0) {
    return null
  }
  const contentStart = start + OPENCODE_APP_DELIVERY_START.length
  const end = text.indexOf(OPENCODE_APP_DELIVERY_END, contentStart)
  if (end < 0) {
    return null
  }
  return text.slice(contentStart, end)
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

function extractStructuredDeliveryTaskRefs(input: {
  text: string
  teamName: string
  memberName: string
  laneId?: string | null
  inboxMessageId: string | null | undefined
  requestedTask: OpenCodeTaskRef
}): OpenCodeTaskRef[] {
  const refs: OpenCodeTaskRef[] = []
  let cursor = 0
  while (cursor < input.text.length) {
    const start = input.text.indexOf(OPENCODE_DELIVERY_CONTEXT_START, cursor)
    if (start < 0) {
      break
    }
    const jsonStart = start + OPENCODE_DELIVERY_CONTEXT_START.length
    const end = input.text.indexOf(OPENCODE_DELIVERY_CONTEXT_END, jsonStart)
    if (end < 0) {
      break
    }
    cursor = end + OPENCODE_DELIVERY_CONTEXT_END.length
    const raw = input.text.slice(jsonStart, end).trim()
    if (raw.length === 0 || byteLength(raw) > 16 * 1024) {
      continue
    }
    const record = safeParseJsonRecord(raw)
    if (
      record?.schemaVersion !== 1 ||
      record.kind !== 'opencode-delivery-context' ||
      record.teamName !== input.teamName ||
      record.memberName !== input.memberName ||
      record.inboundMessageId !== input.inboxMessageId
    ) {
      continue
    }
    const markerLaneId = asString(record.laneId)
    if (input.laneId && markerLaneId !== input.laneId) {
      continue
    }
    const markerTaskRefs = Array.isArray(record.taskRefs)
      ? record.taskRefs.filter(isValidTaskRef)
      : []
    const taskRef = getSingleRequestedTeamRef(
      markerTaskRefs,
      input.teamName,
      input.requestedTask.taskId,
    )
    if (taskRef) {
      refs.push(taskRef)
    }
  }
  return refs
}

function getSingleRequestedTeamRef(
  refs: OpenCodeTaskRef[],
  teamName: string,
  taskId: string,
): OpenCodeTaskRef | null {
  const teamRefs = refs.filter(ref => ref.teamName === teamName)
  if (teamRefs.length !== 1 || teamRefs[0]?.taskId !== taskId) {
    return null
  }
  return teamRefs[0]
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

function extractUnifiedDiffLines(patch: string | null, marker: '+' | '-'): string | null {
  if (!patch) {
    return null
  }
  const lines: string[] = []
  let inHunk = false
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk || !line.startsWith(marker)) {
      continue
    }
    if (
      (marker === '+' && line.startsWith('+++')) ||
      (marker === '-' && line.startsWith('---'))
    ) {
      continue
    }
    lines.push(line.slice(1))
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : null
}

function getApplyPatchOperation(type: string | null): ReconstructedOpenCodeToolChange['operation'] | null {
  if (type === 'add') {
    return 'create'
  }
  if (type === 'delete') {
    return 'delete'
  }
  if (type === 'update') {
    return 'modify'
  }
  return null
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

      if (toolpart.metadataOnly) {
        const operation = toolpart.operationOverride ?? (toolpart.tool === 'write' ? 'create' : 'modify')
        fileStates.set(normalizedPath.comparisonKey, {
          text: null,
          textAvailability: 'metadata-only',
          exists: operation !== 'delete',
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
          sourceTool: toolpart.tool,
          sourceImportKey: buildSourceImportKey({
            sessionId: params.sessionId,
            partId: toolpart.partId,
            normalizedPath,
          }),
          filePath: normalizedPath.absolutePath,
          relativePath: normalizedPath.relativePath,
          beforeContent: null,
          afterContent: null,
          operation,
          confidence: 'high',
          attributionMethod: taskContext.method,
          ...(toolpart.oldString !== undefined ? { oldString: toolpart.oldString } : {}),
          ...(toolpart.newString !== undefined ? { newString: toolpart.newString } : {}),
          beforeState:
            operation === 'create'
              ? { exists: false, sizeBytes: 0 }
              : { exists: true, unavailableReason: 'opencode-apply-patch-before-content-unavailable' },
          afterState:
            operation === 'delete'
              ? { exists: false, sizeBytes: 0 }
              : { exists: true, unavailableReason: 'opencode-apply-patch-after-content-unavailable' },
          timestamp: toolpart.timestamp,
          warnings: [
            'OpenCode apply_patch was captured without full before/after text; review is manual-only.',
            ...(toolpart.warnings ?? []),
            ...(taskContext.warning ? [taskContext.warning] : []),
          ],
        })
        continue
      }

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
          operation: toolpart.operationOverride ?? (beforeKind === 'known-absent' ? 'create' : 'modify'),
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
            ...(toolpart.warnings ?? []),
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
            ...(toolpart.warnings ?? []),
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
        warnings: [
          ...(toolpart.warnings ?? []),
          ...(taskContext.warning ? [taskContext.warning] : []),
        ].filter(Boolean),
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
      if (tool !== 'write' && tool !== 'edit' && tool !== 'apply_patch') {
        continue
      }
      const state = asRecord(data.state)
      if (!state) {
        diagnostics.push(`OpenCode ${tool} toolpart ${row.id} missing state.`)
        continue
      }
      const status = asString(state.status)?.toLowerCase() ?? 'unknown'
      if (status !== 'completed') {
        continue
      }
      const input = asRecord(state?.input)
      const metadata = asRecord(state?.metadata)
      const assistantMessage = messagesById.get(row.message_id)
      if (tool === 'apply_patch') {
        const files = Array.isArray(metadata?.files)
          ? metadata.files.map(asRecord).filter((file): file is Record<string, unknown> => file !== null)
          : []
        if (files.length === 0) {
          diagnostics.push(`OpenCode apply_patch toolpart ${row.id} missing metadata.files.`)
          continue
        }
        for (const file of files) {
          const filePath = asString(file.filePath)
          const operation = getApplyPatchOperation(asString(file.type))
          if (!filePath || !operation) {
            diagnostics.push(`OpenCode apply_patch toolpart ${row.id} contained an unsupported file entry.`)
            continue
          }
          const patch = asStringValue(file.patch)
          const content = operation === 'create'
            ? extractUnifiedDiffLines(patch, '+') ?? undefined
            : undefined
          const oldString = operation === 'modify' || operation === 'delete'
            ? extractUnifiedDiffLines(patch, '-') ?? undefined
            : undefined
          const newString = operation === 'modify'
            ? extractUnifiedDiffLines(patch, '+') ?? undefined
            : undefined
          const hasReplacement = typeof oldString === 'string' && typeof newString === 'string'
          toolparts.push({
            partId: row.id,
            messageId: row.message_id,
            parentUserMessageId: asString(assistantMessage?.parentID),
            tool: operation === 'create' ? 'write' : 'edit',
            callId: asString(data.callID) ?? undefined,
            status,
            filePath,
            content,
            oldString,
            newString,
            metadataExists: operation !== 'create',
            metadataOnly:
              (operation === 'create' && !content) ||
              (operation === 'modify' && !hasReplacement) ||
              operation === 'delete',
            operationOverride: operation,
            warnings: ['OpenCode apply_patch toolpart imported from patch metadata.'],
            truncated: false,
            partTimeCreated: row.time_created,
            messageTimeCreated: messageTimeById.get(row.message_id) ?? row.time_created,
            messageIdSort: row.message_id,
            timestamp: toIsoTimestamp(
              asNumber(asRecord(state.time)?.end) ?? asNumber(asRecord(state.time)?.start),
              row.time_created,
            ),
          })
        }
        continue
      }
      const filePath = asString(input?.filePath)
      if (!input || !filePath) {
        diagnostics.push(`OpenCode ${tool} toolpart ${row.id} missing state/input/filePath.`)
        continue
      }
      toolparts.push({
        partId: row.id,
        messageId: row.message_id,
        parentUserMessageId: asString(assistantMessage?.parentID),
        tool,
        callId: asString(data.callID) ?? undefined,
        status,
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
    const parentParts = input.toolpart.parentUserMessageId
      ? input.partsByMessageId.get(input.toolpart.parentUserMessageId) ?? []
      : []
    const parentText = getTextFromParts(parentParts)
    const deliveryRefs = this.lookupStrictDeliveryRefs({
      deliveryContext: input.params.deliveryContext,
      parentUserMessageId: input.toolpart.parentUserMessageId,
      parentText,
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
      input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} delivery context contained multiple matching task refs.`)
    } else {
      input.diagnostics.push(`OpenCode toolpart ${input.toolpart.partId} skipped because no delivery record matched its parent message.`)
    }
    return { type: 'skipped' }
  }

  private lookupStrictDeliveryRefs(input: {
    deliveryContext: OpenCodeDeliveryContextV1 | null | undefined
    parentUserMessageId: string | undefined
    parentText: string
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
    const parentDeliveryBlockText = getOpenCodeAppDeliveryBlockText(input.parentText)
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
      const recordTaskRef = getSingleRequestedTeamRef(
        record.taskRefs,
        input.teamName,
        input.requestedTask.taskId,
      )
      if (!recordTaskRef) {
        continue
      }
      const structuredDeliveryRefs = parentDeliveryBlockText
        ? extractStructuredDeliveryTaskRefs({
            text: parentDeliveryBlockText,
            teamName: input.teamName,
            memberName: input.memberName,
            laneId: input.laneId,
            inboxMessageId: record.inboxMessageId,
            requestedTask: input.requestedTask,
          })
        : []
      const matchesDirectMessageId =
        record.deliveredUserMessageId === input.parentUserMessageId ||
        record.inboxMessageId === input.parentUserMessageId
      const matchesStructuredRetryPrompt = structuredDeliveryRefs.length === 1
      if (!matchesDirectMessageId && !matchesStructuredRetryPrompt) {
        continue
      }
      refs.push(recordTaskRef)
    }
    return refs
  }
}
