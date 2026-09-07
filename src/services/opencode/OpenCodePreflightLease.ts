import { randomUUID } from 'node:crypto'
import type { OpenCodeHostLeaseInput } from './OpenCodeHostManager.js'
export const OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID = '__opencode_preflight__'
const OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID = 'preflight'

const generated = new WeakSet<object>()
export function createOpenCodePreflightHostLeaseInput(scope: string): OpenCodeHostLeaseInput {
  const normalizedScope =
    scope
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96) || 'probe'
  const lease = {
    teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
    laneId: OPEN_CODE_PREFLIGHT_HOST_LEASE_LANE_ID,
    memberName: `${normalizedScope}-${process.pid}-${randomUUID()}`,
    runId: `preflight_${process.pid}_${randomUUID()}`,
    sessionId: null,
  }
  generated.add(lease)
  return lease
}


function exactLeaseKey(lease: OpenCodeHostLeaseInput): string {
  return JSON.stringify([lease.teamId, lease.laneId ?? null, lease.memberName, lease.runId ?? null, lease.sessionId ?? null])
}
/** Local generated-lease registration, not string-prefix authorization. The
 * native source holds this registry and still checks activation per token. */
export class OpenCodePreflightLeaseRegistry {
  #registered = new Set<string>()
  register(lease: OpenCodeHostLeaseInput): void {
    const key = exactLeaseKey(lease)
    if (!generated.has(lease) || !Object.isFrozen(lease) || this.#registered.has(key) || this.#registered.size >= 16) {
      throw new Error('OpenCode preflight registration unavailable')
    }
    this.#registered.add(key)
  }
  has(lease: OpenCodeHostLeaseInput): boolean { return this.#registered.has(exactLeaseKey(lease)) }
  release(lease: OpenCodeHostLeaseInput): void { this.#registered.delete(exactLeaseKey(lease)) }
  clear(): void { this.#registered.clear() }
}
