export const OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES = 64 * 1024

export type OpenCodeWindowsPublicationRequest =
  | { version: 1; id: string; op: 'OPEN_ROOT'; wait_ms: number; root_path: string; create_missing: boolean; durable_ancestors: boolean }
  | { version: 1; id: string; op: 'VALIDATE_ROOT' | 'SYNC_ROOT' | 'CLOSE'; wait_ms: number }
  | { version: 1; id: string; op: 'PIN_REGULAR'; wait_ms: number; name: string }

export function validOpenCodePublicationLeaf(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
    && !/[\\/\0]/.test(name) && !/[. ]$/.test(name)
}

export function decodeOpenCodeWindowsPublicationReply(line: string, id: string): unknown {
  if (new TextEncoder().encode(line).byteLength > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw new Error('OpenCode Windows publication authority failed [redacted]')
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('OpenCode Windows publication authority failed [redacted]') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenCode Windows publication authority failed [redacted]')
  const reply = value as Record<string, unknown>
  if (reply.version !== 1 || reply.id !== id || typeof reply.ok !== 'boolean') throw new Error('OpenCode Windows publication authority failed [redacted]')
  if (!reply.ok) throw new Error('OpenCode Windows publication authority failed [redacted]')
  return reply.value
}
