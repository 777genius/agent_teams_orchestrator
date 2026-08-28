import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeHostLeaseRetentionOutcome } from './OpenCodeHostManager.js'

export type OpenCodeRetainedHostLeaseOutcome = OpenCodeHostLeaseRetentionOutcome

/** A durable lease CAS proved that this caller no longer owns host custody. */
export class OpenCodeRetainedHostLeaseForeignError extends Error {
  readonly code = 'OPENCODE_RETAINED_HOST_LEASE_FOREIGN'
  readonly outcome = 'foreign' as const

  constructor() {
    super('OpenCode retained host lease custody changed [redacted]')
    this.name = 'OpenCodeRetainedHostLeaseForeignError'
  }
}

export function assertOpenCodeRetainedHostLeaseOutcome(
  outcome: OpenCodeRetainedHostLeaseOutcome | void,
): Exclude<OpenCodeRetainedHostLeaseOutcome, 'foreign'> {
  const exactOutcome = outcome ?? 'applied'
  if (exactOutcome === 'foreign') throw new OpenCodeRetainedHostLeaseForeignError()
  return exactOutcome
}

/** Joins exactly as received. In particular, whitespace is proof data. */
export function readOpenCodeExactMessageText(message: { parts?: Array<{ text?: unknown }> }): string {
  return (message.parts ?? []).map(part => typeof part.text === 'string' ? part.text : '').join('\n')
}

/** Tracks the operation-reference transfer to durable member host leases. */
export class OpenCodeLaunchRetainedHostLeases {
  private readonly members = new Set<OpenCodeOpaqueIdentity>()

  commit(memberIdentity: OpenCodeOpaqueIdentity): void { this.members.add(memberIdentity) }
  remove(memberIdentity: OpenCodeOpaqueIdentity): void { this.members.delete(memberIdentity) }
  shouldKeepHostAlive(): boolean { return this.members.size > 0 }
}

export type OpenCodeRecoveredSessionLease = {
  hostKey: string
  teamId: string
  laneId?: string
  memberName: string
  opencodeSessionId: string
}

/** Hydrates durable ownership before any continuation cleanup decision. */
export async function hydrateOpenCodeRecoveredSessionLease(input: {
  record: OpenCodeRecoveredSessionLease
  memberIdentity: OpenCodeOpaqueIdentity
  runId: string
  leases: OpenCodeLaunchRetainedHostLeases
  retainHostLease(hostKey: string, owner: {
    teamId: string
    laneId?: string
    memberName: string
    runId: string
    sessionId: string
  }): Promise<OpenCodeRetainedHostLeaseOutcome | void>
}): Promise<Exclude<OpenCodeRetainedHostLeaseOutcome, 'foreign'>> {
  const { record } = input
  const outcome = assertOpenCodeRetainedHostLeaseOutcome(await input.retainHostLease(record.hostKey, {
    teamId: record.teamId,
    laneId: record.laneId,
    memberName: record.memberName,
    runId: input.runId,
    sessionId: record.opencodeSessionId,
  }))
  input.leases.commit(input.memberIdentity)
  return outcome
}
