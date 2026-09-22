export function isUnpublishedProcessRecoveryBlocker(
  reservation: { processOwnerToken?: string; processRunId?: string },
  persistedPid: number | null,
): boolean {
  return persistedPid === null && Boolean(reservation.processOwnerToken?.trim()) && Boolean(reservation.processRunId?.trim())
}

export function shouldRetainProcessRecoveryBlocker(params: {
  childWasSpawned: boolean
  cleanupConfirmed: boolean
}): boolean {
  return params.childWasSpawned && !params.cleanupConfirmed
}

export type ProcessCleanupAttemptState = {
  attempted: boolean
  confirmed: boolean
}

/** Run exact process cleanup at most once and retain its authoritative result. */
export async function attemptProcessCleanupOnce(
  state: ProcessCleanupAttemptState,
  cleanup: () => Promise<boolean>,
): Promise<boolean> {
  if (state.attempted) return state.confirmed
  state.attempted = true
  state.confirmed = await cleanup().catch(() => false)
  return state.confirmed
}

export function canReplaceProcessSpawnReservation(params: {
  existingOwnerToken?: string
  nextOwnerToken: string
  existingPid: number | null
  existingPidAlive: boolean
}): boolean {
  if (!params.existingOwnerToken || params.existingOwnerToken === params.nextOwnerToken) {
    return true
  }
  return params.existingPid !== null && !params.existingPidAlive
}

export function canProveSpawnedChildExited(child: {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}): boolean {
  return child.exitCode !== null || child.signalCode !== null
}
