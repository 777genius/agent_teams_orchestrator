import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'

import type { HostedLifecycleScope } from '../hostedControl/HostedLifecycleProviderRegistry.js'

export const NATIVE_TEAM_LIFECYCLE_PROVIDERS = ['anthropic', 'codex', 'gemini'] as const
export type NativeTeamLifecycleProvider = (typeof NATIVE_TEAM_LIFECYCLE_PROVIDERS)[number]

export type TeamLifecycleLaunchMember = {
  name: string
  prompt: string
  model?: string
  effort?: string
}

export type TeamLifecycleLaunchLane =
  | {
      laneId: string
      kind: 'native'
      provider: NativeTeamLifecycleProvider
      members: readonly TeamLifecycleLaunchMember[]
    }
  | {
      laneId: string
      kind: 'opencode'
      provider: 'opencode'
      selectedModel: string
      effort?: string
      members: readonly TeamLifecycleLaunchMember[]
    }

export type TeamLifecycleLaunchPlan = {
  schemaVersion: 1
  workspaceId: string
  teamId: string
  workspaceRoot: string
  lanes: readonly TeamLifecycleLaunchLane[]
}

export interface TeamLifecycleLaunchPlanStore {
  load(scope: HostedLifecycleScope): Promise<TeamLifecycleLaunchPlanAdmission | null>
}

export type TeamLifecycleLaunchPlanAdmission = {
  plan: TeamLifecycleLaunchPlan
  /** Exact digest of the privately admitted bytes, bound into the public provider generation. */
  planGeneration: string
  /** Revalidates that the canonical path still names the admitted file contents. */
  isCurrent(): Promise<boolean>
}

/** Loads an admission snapshot that is mounted privately into the owner process. */
export class PrivateFileTeamLifecycleLaunchPlanStore implements TeamLifecycleLaunchPlanStore {
  constructor(private readonly filePath: string) {
    if (!path.isAbsolute(filePath) || filePath.includes('\0')) {
      throw new TypeError('Team lifecycle launch-plan path must be absolute')
    }
  }

  async load(scope: HostedLifecycleScope): Promise<TeamLifecycleLaunchPlanAdmission | null> {
    const handle = await fs.open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: Buffer
    try {
      const [stat, current, canonical] = await Promise.all([
        handle.stat(),
        fs.lstat(this.filePath),
        fs.realpath(this.filePath),
      ])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || canonical !== this.filePath ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) ||
        (stat.mode & 0o777) !== 0o600) {
        throw new Error('Team lifecycle launch-plan snapshot is not a canonical private regular file')
      }
      if (stat.size < 2 || stat.size > 256 * 1024) {
        throw new Error('Team lifecycle launch-plan snapshot size is invalid')
      }
      raw = await handle.readFile()
    } finally {
      await handle.close()
    }
    if (raw.byteLength < 2 || raw.byteLength > 256 * 1024) {
      throw new Error('Team lifecycle launch-plan snapshot size changed during admission')
    }
    const value: unknown = JSON.parse(decodePlan(raw))
    const plan = parseTeamLifecycleLaunchPlan(value)
    if (plan.workspaceId !== scope.workspaceId || plan.teamId !== scope.teamId) return null
    const planGeneration = digestPlan(raw)
    return {
      plan,
      planGeneration,
      isCurrent: async () => {
        try {
          return (await this.#readCurrentGeneration()) === planGeneration
        } catch {
          return false
        }
      },
    }
  }

  async #readCurrentGeneration(): Promise<string> {
    const handle = await fs.open(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const [stat, current, canonical] = await Promise.all([
        handle.stat(), fs.lstat(this.filePath), fs.realpath(this.filePath),
      ])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || canonical !== this.filePath ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > 256 * 1024) {
        throw new Error('Unsafe team lifecycle launch-plan replacement')
      }
      const raw = await handle.readFile()
      if (raw.byteLength < 2 || raw.byteLength > 256 * 1024) {
        throw new Error('Unsafe team lifecycle launch-plan replacement')
      }
      return digestPlan(raw)
    } finally {
      await handle.close()
    }
  }
}

function digestPlan(raw: Uint8Array): string {
  return `plan-generation_${createHash('sha256').update(raw).digest('hex')}`
}

function decodePlan(raw: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(raw)
}

export function parseTeamLifecycleLaunchPlan(value: unknown): TeamLifecycleLaunchPlan {
  const record = asRecord(value, 'launch plan')
  assertExactKeys(record, ['schemaVersion', 'workspaceId', 'teamId', 'workspaceRoot', 'lanes'], 'launch plan')
  if (record.schemaVersion !== 1) throw new TypeError('Unsupported team lifecycle launch-plan schema')
  const workspaceId = identifier(record.workspaceId, 'workspaceId')
  const teamId = identifier(record.teamId, 'teamId')
  if (typeof record.workspaceRoot !== 'string' || !path.isAbsolute(record.workspaceRoot) || record.workspaceRoot.includes('\0')) {
    throw new TypeError('Invalid launch-plan workspaceRoot')
  }
  if (!Array.isArray(record.lanes) || record.lanes.length === 0 || record.lanes.length > 64) {
    throw new TypeError('Launch plan requires 1-64 lanes')
  }
  const lanes = record.lanes.map((raw, index): TeamLifecycleLaunchLane => {
    const lane = asRecord(raw, `lane ${index}`)
    const laneId = identifier(lane.laneId, `lane ${index} laneId`)
    if (lane.kind === 'native' && NATIVE_TEAM_LIFECYCLE_PROVIDERS.includes(lane.provider as NativeTeamLifecycleProvider)) {
      assertExactKeys(lane, ['laneId', 'kind', 'provider', 'members'], `lane ${index}`)
      return {
        laneId,
        kind: 'native',
        provider: lane.provider as NativeTeamLifecycleProvider,
        members: parseMembers(lane.members, index),
      }
    }
    if (lane.kind === 'opencode' && lane.provider === 'opencode') {
      const hasEffort = Object.prototype.hasOwnProperty.call(lane, 'effort')
      assertExactKeys(
        lane,
        hasEffort
          ? ['laneId', 'kind', 'provider', 'selectedModel', 'effort', 'members']
          : ['laneId', 'kind', 'provider', 'selectedModel', 'members'],
        `lane ${index}`,
      )
      return {
        laneId,
        kind: 'opencode',
        provider: 'opencode',
        selectedModel: boundedString(lane.selectedModel, `lane ${index} selectedModel`, 256),
        ...(hasEffort ? { effort: boundedString(lane.effort, `lane ${index} effort`, 64) } : {}),
        members: parseMembers(lane.members, index),
      }
    }
    throw new TypeError(`Unsupported provider for lane ${index}`)
  })
  if (new Set(lanes.map(lane => lane.laneId)).size !== lanes.length) {
    throw new TypeError('Duplicate launch-plan laneId')
  }
  return { schemaVersion: 1, workspaceId, teamId, workspaceRoot: record.workspaceRoot, lanes }
}

function parseMembers(value: unknown, laneIndex: number): readonly TeamLifecycleLaunchMember[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new TypeError(`Lane ${laneIndex} requires 1-64 members`)
  }
  const members = value.map((raw, memberIndex): TeamLifecycleLaunchMember => {
    const member = asRecord(raw, `lane ${laneIndex} member ${memberIndex}`)
    const hasModel = Object.prototype.hasOwnProperty.call(member, 'model')
    const hasEffort = Object.prototype.hasOwnProperty.call(member, 'effort')
    assertExactKeys(
      member,
      ['name', 'prompt', ...(hasModel ? ['model'] : []), ...(hasEffort ? ['effort'] : [])],
      `lane ${laneIndex} member ${memberIndex}`,
    )
    return {
      name: identifier(member.name, `lane ${laneIndex} member ${memberIndex} name`),
      prompt: boundedString(member.prompt, `lane ${laneIndex} member ${memberIndex} prompt`, 64 * 1024),
      ...(hasModel ? { model: boundedString(member.model, `lane ${laneIndex} member ${memberIndex} model`, 256) } : {}),
      ...(hasEffort ? { effort: boundedString(member.effort, `lane ${laneIndex} member ${memberIndex} effort`, 64) } : {}),
    }
  })
  if (new Set(members.map(member => member.name.toLowerCase())).size !== members.length) {
    throw new TypeError(`Duplicate member name in lane ${laneIndex}`)
  }
  return members
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Unexpected ${label} fields`)
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}
