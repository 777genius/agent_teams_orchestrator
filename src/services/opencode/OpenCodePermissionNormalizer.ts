import type { OpenCodePendingPermission } from './types.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = asString(value)
    if (stringValue) return stringValue
  }
  return null
}

export type NormalizedOpenCodePermission = {
  requestId: string
  sessionId: string | null
  tool: string | null
  title: string | null
  kind: string | null
  raw: OpenCodePendingPermission
}

export function normalizeOpenCodePermission(
  permission: OpenCodePendingPermission,
): NormalizedOpenCodePermission | null {
  const record = asRecord(permission)
  if (!record) {
    return null
  }

  const nested = asRecord(record.permission)
  const requestId = firstString(
    record.requestID,
    record.requestId,
    record.id,
    record.permissionID,
    record.permissionId,
    nested?.requestID,
    nested?.requestId,
    nested?.id,
  )
  if (!requestId) {
    return null
  }

  const metadata = asRecord(record.metadata)
  return {
    requestId,
    sessionId: firstString(
      record.sessionID,
      record.sessionId,
      record.session,
      metadata?.sessionID,
      metadata?.sessionId,
      nested?.sessionID,
      nested?.sessionId,
    ),
    tool: firstString(record.tool, record.toolName, record.name, nested?.tool, nested?.toolName),
    title: firstString(record.title, record.description, nested?.title, nested?.description),
    kind: firstString(record.kind, record.type, nested?.kind, nested?.type),
    raw: permission,
  }
}

export function normalizeOpenCodePermissions(
  permissions: OpenCodePendingPermission[],
): NormalizedOpenCodePermission[] {
  return permissions
    .map(permission => normalizeOpenCodePermission(permission))
    .filter((permission): permission is NormalizedOpenCodePermission => permission !== null)
}
