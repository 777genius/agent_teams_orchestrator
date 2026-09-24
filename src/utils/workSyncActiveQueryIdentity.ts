export type WorkSyncActiveQueryIdentity = {
  runtimeInstanceId: string
  completedGeneration: number
}

let active: WorkSyncActiveQueryIdentity | null = null

export function bindWorkSyncActiveQueryIdentity(
  identity: WorkSyncActiveQueryIdentity,
): void {
  active = identity
}

export function readWorkSyncActiveQueryIdentity(): WorkSyncActiveQueryIdentity | null {
  return active
}

export function clearWorkSyncActiveQueryIdentity(): void {
  active = null
}
