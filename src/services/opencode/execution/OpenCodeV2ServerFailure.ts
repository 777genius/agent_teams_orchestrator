import { types } from 'node:util'

const kinds = ['Fail', 'Die', 'Interrupt', 'unknown'] as const
const openCodeV2ServerFailureFields = {
  tag: ['PlatformError', 'AppProcessError', 'SqlError', 'SchemaError', 'FileSystem.DirectoryAccessDeniedError',
    'FileSystem.DirectoryNotFoundError', 'PluginModule.LoadError', 'Provider.LoadError'],
  name: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError'],
  module: ['FileSystem', 'ChildProcess'],
  method: ['access', 'chmod', 'chown', 'copy', 'copyFile', 'glob', 'link', 'makeDirectory', 'readDirectory', 'readFile',
    'readLink', 'realPath', 'rename', 'stat', 'symlink', 'sync', 'truncate', 'utime', 'writeFile', 'close', 'endStdin',
    'identity', 'kill', 'outputLimit', 'readOutput', 'resolve', 'retire', 'spawn', 'status', 'stdinAlreadyBound',
    'unsupportedCommand', 'unsupportedDescriptor', 'unsupportedSignal', 'unsupportedUnref', 'validateOutput', 'writeStdin'],
  reason: ['BadArgument', 'NotFound', 'PermissionDenied', 'AlreadyExists', 'BadResource', 'Busy', 'Unknown', 'ConnectionError',
    'AuthenticationError', 'AuthorizationError', 'SqlSyntaxError', 'UniqueViolation', 'ConstraintError', 'DeadlockError',
    'SerializationError', 'LockTimeoutError', 'StatementTimeoutError', 'UnknownError'],
  errno: ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS', 'EBUSY', 'EEXIST', 'ELOOP'],
  sqlCode: ['SQLITE_AUTH', 'SQLITE_PERM', 'SQLITE_CONSTRAINT', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CANTOPEN', 'SQLITE_CONSTRAINT_UNIQUE'],
} as const
type Fields = typeof openCodeV2ServerFailureFields
export type OpenCodeV2ServerFailure = Readonly<{ operation: 'location'; kind: typeof kinds[number] } &
  { [K in keyof Fields]?: Fields[K][number] }>
const object = (value: unknown): value is object => value !== null && typeof value === 'object' && !types.isProxy(value)
function data(value: unknown, key: string): unknown {
  if (!object(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
/** Fixed finite projection only; this observation never qualifies a lease or request. */
export function readOpenCodeV2ServerFailure(value: unknown): OpenCodeV2ServerFailure | undefined {
  try {
    if (!object(value) || data(value, 'operation') !== 'location') return undefined
    const kind = kinds.find(kind => kind === data(value, 'kind'))
    if (!kind) return undefined
    const result: Record<string, unknown> = { operation: 'location', kind }
    for (const key of Object.keys(openCodeV2ServerFailureFields)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) continue
      const allowed = Object.getOwnPropertyDescriptor(openCodeV2ServerFailureFields, key)!.value as readonly string[]
      const scalar = 'value' in descriptor ? descriptor.value : undefined
      if (typeof scalar !== 'string' || !allowed.includes(scalar)) return undefined
      result[key] = scalar
    }
    return Object.freeze(result) as OpenCodeV2ServerFailure
  } catch { return undefined }
}

/** The selected Effect graph supplies Cause.reasons. Inspect one reason only,
 * then its own-data reason/cause chain; no messages, getters or prototype walks. */
export function projectOpenCodeV2LocationCause(cause: unknown): OpenCodeV2ServerFailure {
  const result: Record<string, unknown> = { operation: 'location', kind: 'unknown' }
  try {
    const reasons = data(cause, 'reasons')
    let chosen: unknown, interrupt: unknown
    if (object(reasons) && Array.isArray(reasons)) {
      const length = data(reasons, 'length')
      if (Number.isSafeInteger(length)) for (let index = 0; index < Math.min(Number(length), 4); index++) {
        const candidate = data(reasons, String(index)), kind = data(candidate, '_tag')
        if (kind === 'Fail' || kind === 'Die') { chosen = candidate; break }
        if (kind === 'Interrupt' && interrupt === undefined) interrupt = candidate
      }
    }
    chosen ??= interrupt
    const kind = data(chosen, '_tag')
    if (kind === 'Fail' || kind === 'Die' || kind === 'Interrupt') result.kind = kind
    let value = data(chosen, kind === 'Fail' ? 'error' : 'defect')
    const seen = new Set<object>()
    const put = (key: keyof Fields, value: unknown) => {
      if (result[key] !== undefined) return
      const allowed: readonly string[] = openCodeV2ServerFailureFields[key]
      if (typeof value === 'string' && allowed.includes(value)) result[key] = value
    }
    for (let depth = 0; depth <= 4; depth++) {
      if (!object(value) || seen.has(value)) break
      seen.add(value)
      put('tag', data(value, '_tag')); put('reason', data(value, '_tag'))
      put('module', data(value, 'module')); put('method', data(value, 'method'))
      put('errno', data(value, 'code')); put('sqlCode', data(value, 'code')); put('name', data(value, 'name'))
      const prototype = Object.getPrototypeOf(value)
      for (const Constructor of [Error, TypeError, ReferenceError, RangeError, SyntaxError, AggregateError])
        if (prototype === Constructor.prototype) put('name', Constructor.name)
      const reason = data(value, 'reason')
      value = object(reason) ? reason : data(value, 'cause')
    }
  } catch { /* Projection cannot replace a failed official handler. */ }
  return readOpenCodeV2ServerFailure(result) ?? Object.freeze({ operation: 'location', kind: 'unknown' })
}

/** One cold relay request and one sole handler entry. Concurrent or unrelayed
 * entries disarm metadata without changing any request or response behavior. */
export function createOpenCodeV2ColdLocationObservation() {
  let phase: 'idle' | 'pending' | 'done' = 'idle', requestId: string | undefined
  let entry: object | undefined, failure: OpenCodeV2ServerFailure | undefined
  const finish = () => { phase = 'done'; requestId = undefined; entry = undefined; failure = undefined }
  return Object.freeze({
    begin(id: string) {
      if (phase === 'pending') { finish(); return }
      if (phase === 'idle') { phase = 'pending'; requestId = id }
    },
    enter(): object | undefined {
      if (phase !== 'pending') return undefined
      if (entry) { finish(); return undefined }
      return entry = Object.freeze({})
    },
    retain(token: object | undefined, cause: unknown) {
      if (phase === 'pending' && token !== undefined && token === entry && !failure) failure = projectOpenCodeV2LocationCause(cause)
    },
    consume(id: string, status: number): OpenCodeV2ServerFailure | undefined {
      if (phase !== 'pending' || id !== requestId) return undefined
      const retained = status === 500 ? failure : undefined
      finish(); return retained
    },
    end(id: string) { if (phase === 'pending' && id === requestId) finish() },
  })
}
