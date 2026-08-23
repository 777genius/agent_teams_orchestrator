export const OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES = 64 * 1024
export class OpenCodeWindowsPublicationRejectedError extends Error {
  constructor(readonly authorityCode: string) { super('OpenCode Windows publication authority failed [redacted]') }
}

export type OpenCodeWindowsPublicationRequest =
  | { version: 1; id: string; op: 'OPEN_ROOT'; wait_ms: number; root_path: string; create_missing: boolean; durable_ancestors: boolean }
  | { version: 1; id: string; op: 'VALIDATE_ROOT' | 'SYNC_ROOT' | 'CLOSE'; wait_ms: number }
  | { version: 1; id: string; op: 'PIN_REGULAR' | 'PIN_REGULAR_READONLY'; wait_ms: number; parent_key: string; name: string }
  | { version: 1; id: string; op: 'OPEN_CHILD_DIRECTORY'; wait_ms: number; parent_key: string; key: string; name: string }
  | { version: 1; id: string; op: 'CREATE_DIRECTORY'; wait_ms: number; name: string }
  | { version: 1; id: string; op: 'CREATE_CHILD_DIRECTORY' | 'CREATE_CHILD_FILE'; wait_ms: number; parent_key: string; key: string; name: string }
  | { version: 1; id: string; op: 'WRITE_CHILD_FILE'; wait_ms: number; key: string; offset: number; content_base64: string; finish: boolean }
  | { version: 1; id: string; op: 'RENAME_DIRECTORY'; wait_ms: number; from: string; to: string }
  | { version: 1; id: string; op: 'ROLLBACK_DIRECTORY'; wait_ms: number; root_key: string }
  | { version: 1; id: string; op: 'PREPARE_ATOMIC'; wait_ms: number; parent_key: string; final_name: string; temporary_name: string; backup_name: string; quarantine_name: string; recovery_name: string; expected_prior: string; content_base64: string }
  | { version: 1; id: string; op: 'MARK_RECOVERY_REQUIRED'; wait_ms: number }
  | { version: 1; id: string; op: 'COMMIT_ATOMIC' | 'ROLLBACK_ATOMIC'; wait_ms: number }
  | { version: 1; id: string; op: 'RECOVER_ATOMIC'; wait_ms: number; recovery_name: string; decision: 'commit' | 'rollback' }
  | { version: 1; id: string; op: 'NS_STAT'; wait_ms: number; path: string }
  | { version: 1; id: string; op: 'NS_MKDIR'; wait_ms: number; path: string }
  | { version: 1; id: string; op: 'NS_OPEN'; wait_ms: number; path: string; token: string; mode: 'read' | 'readwrite' | 'create_file' | 'directory' }
  | { version: 1; id: string; op: 'NS_READ'; wait_ms: number; token: string; offset: number; length: number }
  | { version: 1; id: string; op: 'NS_WRITE'; wait_ms: number; token: string; offset: number; truncate: boolean; content_base64: string }
  | { version: 1; id: string; op: 'NS_SYNC_HANDLE' | 'NS_CLOSE_HANDLE'; wait_ms: number; token: string }
  | { version: 1; id: string; op: 'NS_RENAME'; wait_ms: number; from: string; to: string }
  | { version: 1; id: string; op: 'NS_UNLINK'; wait_ms: number; path: string; directory: boolean }
  | { version: 1; id: string; op: 'NS_SYNC_DIRECTORY'; wait_ms: number; path: string }
  | { version: 1; id: string; op: 'NS_LIST'; wait_ms: number; path: string }
  | { version: 1; id: string; op: 'NS_MODIFIED_AT'; wait_ms: number; path: string; kind: 'file' | 'directory' }
  | { version: 1; id: string; op: 'NS_RECOVER_ATOMIC'; wait_ms: number; path: string; recovery_prefix: string }
  | { version: 1; id: string; op: 'NS_PUBLISH_IMMUTABLE'; wait_ms: number; path: string; token: string; content_base64: string }
  | { version: 1; id: string; op: 'NS_REMOVE_TREE'; wait_ms: number; path: string }
  | { version: 1; id: string; op: 'NS_ACQUIRE_LOCK'; wait_ms: number; path: string; token: string; stale_ms: number }
  | { version: 1; id: string; op: 'NS_REFRESH_LOCK' | 'NS_RELEASE_LOCK'; wait_ms: number; token: string }

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\..*)?$/i

function validWindowsComponent(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(value)
    && !/[. ]$/.test(value) && !WINDOWS_DEVICE.test(value)
}

export function validOpenCodePublicationLeaf(name: string): boolean {
  return name.length <= 255 && validWindowsComponent(name)
}

export function validOpenCodePublicationMaterializationKey(key: string): boolean {
  return key.length > 0 && key.length <= 4096 && key.split('/').every(validWindowsComponent)
}

export function validOpenCodePublicationRelativePath(value: string): boolean {
  return value === '.' || (value.length <= 4096 && value.split('/').every(validWindowsComponent))
}

/** Strict Win32 drive path accepted by the native NTFS publication boundary. */
export function validOpenCodePublicationRoot(rootPath: string): boolean {
  if (rootPath.length < 3 || rootPath.length > 32_767 || !/^[A-Za-z]:\\/.test(rootPath)
    || rootPath.startsWith('\\\\') || rootPath.includes('/') || rootPath.slice(2).includes(':')) return false
  const components = rootPath.slice(3).split('\\')
  return components.every((component, index) => component === ''
    ? index === components.length - 1
    : validWindowsComponent(component))
}

export function decodeOpenCodeWindowsPublicationReply(line: string, id: string): unknown {
  if (new TextEncoder().encode(line).byteLength > OPEN_CODE_WINDOWS_PUBLICATION_MAX_WIRE_BYTES) throw new Error('OpenCode Windows publication authority failed [redacted]')
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error('OpenCode Windows publication authority failed [redacted]') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenCode Windows publication authority failed [redacted]')
  const reply = value as Record<string, unknown>
  if (reply.version !== 1 || reply.id !== id || typeof reply.ok !== 'boolean') throw new Error('OpenCode Windows publication authority failed [redacted]')
  const keys = Object.keys(reply).sort().join(',')
  if (keys !== (reply.ok ? 'id,ok,value,version' : 'error,id,ok,version')) throw new Error('OpenCode Windows publication authority failed [redacted]')
  if (!reply.ok) throw new OpenCodeWindowsPublicationRejectedError(
    typeof reply.error === 'string' && ['NS_NOT_FOUND', 'NS_EXISTS', 'NS_NOT_EMPTY'].includes(reply.error) ? reply.error : 'REJECTED',
  )
  return reply.value
}
