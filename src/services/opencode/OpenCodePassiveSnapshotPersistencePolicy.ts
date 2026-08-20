export const OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE = 'EUNSUPPORTED_SAFE_PERSISTENCE' as const

export type OpenCodePassiveSnapshotPersistenceCapability =
  | Readonly<{ supported: true; implementation: 'descriptor-root' }>
  | Readonly<{ supported: false; implementation: 'unavailable' }>

/** Pure platform policy. Native Windows needs handle-relative primitives that Node does not expose. */
export function getOpenCodePassiveSnapshotPersistenceCapability(
  platform: NodeJS.Platform = process.platform,
): OpenCodePassiveSnapshotPersistenceCapability {
  return platform === 'linux' || platform === 'darwin'
    ? Object.freeze({ supported: true, implementation: 'descriptor-root' })
    : Object.freeze({ supported: false, implementation: 'unavailable' })
}

export class OpenCodeUnsupportedSafePersistenceError extends Error {
  readonly code = OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE
  readonly transient = true

  constructor() {
    super('Durable passive snapshot persistence is unavailable on this platform [redacted]')
    this.name = 'OpenCodeUnsupportedSafePersistenceError'
  }
}

export function assertOpenCodePassiveSnapshotPersistenceSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!getOpenCodePassiveSnapshotPersistenceCapability(platform).supported) {
    throw new OpenCodeUnsupportedSafePersistenceError()
  }
}

export function isOpenCodeUnsupportedSafePersistenceError(
  error: unknown,
): error is OpenCodeUnsupportedSafePersistenceError {
  return error instanceof OpenCodeUnsupportedSafePersistenceError
    && error.code === OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE
}
