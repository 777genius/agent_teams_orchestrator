import { createHash } from 'node:crypto'

import type { OpenCodeLaunchOwnedResources } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

function sessionIdentity(id: string): OpenCodeOpaqueIdentity {
  return `sha256:${createHash('sha256').update(JSON.stringify({ kind: 'opencode-session', id })).digest('hex')}`
}

export async function createOpenCodeOwnedMemberSession<T>(input: {
  memberIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string
  registerRecord(): void
  registerOwned(resources: OpenCodeLaunchOwnedResources): void
  createSession(): Promise<T>
}): Promise<{ session: T; owned: OpenCodeLaunchOwnedResources }> {
  const owned: OpenCodeLaunchOwnedResources = {
    memberIdentity: input.memberIdentity,
    sessionIdentity: sessionIdentity(input.authoritativeSessionId),
  }
  // Both cleanup metadata and port ownership precede the first transport
  // mutation. This ordering is part of the production adapter contract.
  input.registerRecord()
  input.registerOwned(owned)
  return { session: await input.createSession(), owned }
}
