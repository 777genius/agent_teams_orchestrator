import type { CodexNativeTurnSettledEvent } from '../services/codexNative/runtimeTurnSettledEmitter.js'
import { emitCodexNativeTurnSettledBestEffort } from '../services/codexNative/runtimeTurnSettledEmitter.js'

let ownerGateBound = false
let staged: CodexNativeTurnSettledEvent | null = null

export function bindWorkSyncTurnSettledOwnerGate(): void {
  ownerGateBound = true
  staged = null
}

export function unbindWorkSyncTurnSettledOwnerGate(): void {
  ownerGateBound = false
  staged = null
}

export function isWorkSyncTurnSettledOwnerGateBound(): boolean {
  return ownerGateBound
}

export function stageWorkSyncTurnSettledEvent(
  event: CodexNativeTurnSettledEvent,
): void {
  staged = event
}

export async function publishStagedWorkSyncTurnSettledIfOwnerReleased(
  released: boolean,
): Promise<void> {
  const event = staged
  staged = null
  if (!released || !event) {
    return
  }
  await emitCodexNativeTurnSettledBestEffort(event)
}
