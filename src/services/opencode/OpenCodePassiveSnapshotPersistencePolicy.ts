export const OPEN_CODE_UNSUPPORTED_SAFE_PERSISTENCE_CODE = 'EUNSUPPORTED_SAFE_PERSISTENCE' as const

export type OpenCodePassiveSnapshotPersistenceCapability =
  | Readonly<{ supported: true; implementation: 'descriptor-root' }>
  | Readonly<{ supported: true; implementation: 'verified-windows-path' }>
  | Readonly<{ supported: false; implementation: 'unavailable' }>

/** Pure platform policy for the app-owned, identity-verified snapshot store. */
export function getOpenCodePassiveSnapshotPersistenceCapability(
  platform: NodeJS.Platform = process.platform,
): OpenCodePassiveSnapshotPersistenceCapability {
  if (platform === 'linux' || platform === 'darwin') {
    return Object.freeze({ supported: true, implementation: 'descriptor-root' })
  }
  return platform === 'win32'
    ? Object.freeze({ supported: true, implementation: 'verified-windows-path' })
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
