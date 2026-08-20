import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

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
  }): Promise<void>
}): Promise<void> {
  const { record } = input
  await input.retainHostLease(record.hostKey, {
    teamId: record.teamId,
    laneId: record.laneId,
    memberName: record.memberName,
    runId: input.runId,
    sessionId: record.opencodeSessionId,
  })
  input.leases.commit(input.memberIdentity)
}
