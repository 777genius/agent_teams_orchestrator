import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'

import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@agent-teams/owner-anchor-library'

import type { HostedLifecycleScope } from '../hostedControl/HostedLifecycleProviderRegistry.js'

export const NATIVE_TEAM_LIFECYCLE_PROVIDERS = ['anthropic', 'codex', 'gemini'] as const
export type NativeTeamLifecycleProvider = (typeof NATIVE_TEAM_LIFECYCLE_PROVIDERS)[number]

export type TeamLifecycleLaunchMember = {
  name: string
  prompt: string
  model?: string
  effort?: string
}

export type TeamLifecycleLaunchMemberV3 = Readonly<TeamLifecycleLaunchMember & {
  ordinal: number
  agentId: string
}>

type TeamLifecycleLaunchLaneFor<Member> =
  | { laneId: string; kind: 'native'; provider: NativeTeamLifecycleProvider; members: readonly Member[] }
  | { laneId: string; kind: 'opencode'; provider: 'opencode'; selectedModel: string; effort?: string; members: readonly Member[] }
type ReadonlyUnion<Value> = Value extends unknown ? Readonly<Value> : never

export type TeamLifecycleLaunchLaneV2 = TeamLifecycleLaunchLaneFor<TeamLifecycleLaunchMember>
export type TeamLifecycleLaunchLaneV3 = ReadonlyUnion<TeamLifecycleLaunchLaneFor<TeamLifecycleLaunchMemberV3>>
export type TeamLifecycleLaunchLane = TeamLifecycleLaunchLaneV2 | TeamLifecycleLaunchLaneV3

export type TeamLifecycleLaunchPlanV2 = {
  schemaVersion: 2
  workspaceId: string
  teamId: string
  workspaceRoot: string
  toolApprovalMode: 'manual' | 'auto'
  lanes: readonly TeamLifecycleLaunchLaneV2[]
}

export type TeamLifecycleRuntimePlanRefV3 = Readonly<{
  teamId: string
  runId: string
  generation: number
  planHash: `sha256:${string}`
}>

export type TeamLifecycleLaunchPlanV3 = Readonly<{
  schemaVersion: 3
  workspaceId: string
  teamId: string
  workspaceRoot: string
  toolApprovalMode: 'manual' | 'auto'
  lanes: readonly TeamLifecycleLaunchLaneV3[]
  runtimePlanRef: TeamLifecycleRuntimePlanRefV3
  primaryOrdinal: number
}>

export type TeamLifecycleLaunchPlan = TeamLifecycleLaunchPlanV2 | TeamLifecycleLaunchPlanV3

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
  if (record.schemaVersion === 2) return parseV2(record)
  if (record.schemaVersion === 3) return parseV3(strictRecord(value, 'launch plan'))
  // Preserve schema 2's exact-key-first failure for legacy-shaped unsupported input.
  assertExactKeys(record, ['schemaVersion', 'workspaceId', 'teamId', 'workspaceRoot', 'toolApprovalMode', 'lanes'], 'launch plan')
  throw new TypeError('Unsupported team lifecycle launch-plan schema')
}

function parseV2(record: Record<string, unknown>): TeamLifecycleLaunchPlanV2 {
  assertExactKeys(record, ['schemaVersion', 'workspaceId', 'teamId', 'workspaceRoot', 'toolApprovalMode', 'lanes'], 'launch plan')
  return { schemaVersion: 2, ...parseCommon(record, false), lanes: parseLanes(record.lanes, false) as readonly TeamLifecycleLaunchLaneV2[] }
}

function parseV3(record: Record<string, unknown>): TeamLifecycleLaunchPlanV3 {
  assertExactKeys(record, ['schemaVersion', 'workspaceId', 'teamId', 'workspaceRoot', 'toolApprovalMode', 'lanes', 'runtimePlanRef', 'primaryOrdinal'], 'launch plan')
  const common = parseCommon(record, true)
  const reference = strictRecord(record.runtimePlanRef, 'runtimePlanRef')
  assertExactKeys(reference, ['teamId', 'runId', 'generation', 'planHash'], 'runtimePlanRef')
  const runtimePlanRef: TeamLifecycleRuntimePlanRefV3 = {
    teamId: parseTeamId(reference.teamId),
    runId: parseRunId(reference.runId),
    generation: positiveSafeInteger(reference.generation, 'runtimePlanRef.generation'),
    planHash: taggedHash(reference.planHash),
  }
  if (runtimePlanRef.teamId !== common.teamId) throw new TypeError('Launch-plan runtimePlanRef.teamId does not match teamId')
  const lanes = parseLanes(record.lanes, true) as readonly TeamLifecycleLaunchLaneV3[]
  const members = lanes.flatMap(lane => lane.members)
  if (members.length > 256) throw new TypeError('Schema 3 launch plan supports at most 256 members')
  const ordinals = new Set(members.map(member => member.ordinal))
  if (ordinals.size !== members.length || members.some((_, ordinal) => !ordinals.has(ordinal))) {
    throw new TypeError('Schema 3 member ordinals must cover 0..N-1 exactly once')
  }
  if (new Set(members.map(member => member.agentId)).size !== members.length) throw new TypeError('Duplicate schema 3 member agentId')
  const foldedNames = members.map(member => member.name.toLocaleLowerCase('en-US'))
  if (new Set(foldedNames).size !== members.length) throw new TypeError('Globally ambiguous schema 3 member name')
  const primaryOrdinal = nonNegativeSafeInteger(record.primaryOrdinal, 'primaryOrdinal')
  if (!ordinals.has(primaryOrdinal)) throw new TypeError('Schema 3 primaryOrdinal does not identify a member')
  return deepFreeze({ schemaVersion: 3, ...common, lanes, runtimePlanRef, primaryOrdinal })
}

function parseCommon(record: Record<string, unknown>, schema3: boolean): Omit<TeamLifecycleLaunchPlanV2, 'schemaVersion' | 'lanes'> {
  const workspaceId = identifier(record.workspaceId, 'workspaceId')
  const teamId = schema3 ? parseTeamId(record.teamId) : identifier(record.teamId, 'teamId')
  if (typeof record.workspaceRoot !== 'string' || !path.isAbsolute(record.workspaceRoot) || record.workspaceRoot.includes('\0')) {
    throw new TypeError('Invalid launch-plan workspaceRoot')
  }
  if (record.toolApprovalMode !== 'manual' && record.toolApprovalMode !== 'auto') throw new TypeError('Invalid launch-plan toolApprovalMode')
  return { workspaceId, teamId, workspaceRoot: record.workspaceRoot, toolApprovalMode: record.toolApprovalMode }
}

function parseLanes(value: unknown, schema3: boolean): readonly TeamLifecycleLaunchLane[] {
  requireDenseArray(value, 'lanes', schema3)
  const lanes = value.map((raw, index): TeamLifecycleLaunchLane => {
    const lane = schema3 ? strictRecord(raw, `lane ${index}`) : asRecord(raw, `lane ${index}`)
    const laneId = identifier(lane.laneId, `lane ${index} laneId`)
    if (lane.kind === 'native' && NATIVE_TEAM_LIFECYCLE_PROVIDERS.includes(lane.provider as NativeTeamLifecycleProvider)) {
      assertExactKeys(lane, ['laneId', 'kind', 'provider', 'members'], `lane ${index}`)
      return { laneId, kind: 'native', provider: lane.provider as NativeTeamLifecycleProvider,
        members: schema3 ? parseMembersV3(lane.members, index) : parseMembersV2(lane.members, index) }
    }
    if (lane.kind === 'opencode' && lane.provider === 'opencode') {
      const hasEffort = Object.prototype.hasOwnProperty.call(lane, 'effort')
      assertExactKeys(lane, hasEffort ? ['laneId', 'kind', 'provider', 'selectedModel', 'effort', 'members'] :
        ['laneId', 'kind', 'provider', 'selectedModel', 'members'], `lane ${index}`)
      return { laneId, kind: 'opencode', provider: 'opencode', selectedModel: boundedString(lane.selectedModel, `lane ${index} selectedModel`, 256),
        ...(hasEffort ? { effort: boundedString(lane.effort, `lane ${index} effort`, 64) } : {}),
        members: schema3 ? parseMembersV3(lane.members, index) : parseMembersV2(lane.members, index) }
    }
    throw new TypeError(`Unsupported provider for lane ${index}`)
  })
  if (new Set(lanes.map(lane => lane.laneId)).size !== lanes.length) throw new TypeError('Duplicate launch-plan laneId')
  return lanes
}

function parseMembersV2(value: unknown, laneIndex: number): readonly TeamLifecycleLaunchMember[] {
  requireDenseArray(value, `lane ${laneIndex} members`, false)
  const members = value.map((raw, memberIndex) => parseMember(raw, laneIndex, memberIndex, false) as TeamLifecycleLaunchMember)
  if (new Set(members.map(member => member.name.toLowerCase())).size !== members.length) throw new TypeError(`Duplicate member name in lane ${laneIndex}`)
  return members
}

function parseMembersV3(value: unknown, laneIndex: number): readonly TeamLifecycleLaunchMemberV3[] {
  requireDenseArray(value, `lane ${laneIndex} members`, true)
  let previousOrdinal = -1
  return value.map((raw, memberIndex): TeamLifecycleLaunchMemberV3 => {
    const member = parseMember(raw, laneIndex, memberIndex, true) as TeamLifecycleLaunchMemberV3
    if (member.ordinal <= previousOrdinal) throw new TypeError(`Lane ${laneIndex} member ordinals must be strictly increasing`)
    previousOrdinal = member.ordinal
    return member
  })
}

function parseMember(value: unknown, laneIndex: number, memberIndex: number, schema3: boolean): TeamLifecycleLaunchMember | TeamLifecycleLaunchMemberV3 {
  const label = `lane ${laneIndex} member ${memberIndex}`
  const member = schema3 ? strictRecord(value, label) : asRecord(value, label)
  const hasModel = Object.prototype.hasOwnProperty.call(member, 'model')
  const hasEffort = Object.prototype.hasOwnProperty.call(member, 'effort')
  assertExactKeys(member, ['name', 'prompt', ...(hasModel ? ['model'] : []), ...(hasEffort ? ['effort'] : []), ...(schema3 ? ['ordinal', 'agentId'] : [])], label)
  const name = schema3 ? parseLegacyMemberKey(member.name) : identifier(member.name, `${label} name`)
  if (schema3 && ['team-lead', 'user'].includes(name.toLocaleLowerCase('en-US'))) {
    throw new TypeError(`Reserved or noncanonical ${label} name`)
  }
  const common: TeamLifecycleLaunchMember = {
    name,
    prompt: boundedString(member.prompt, `${label} prompt`, 64 * 1024),
    ...(hasModel ? { model: boundedString(member.model, `${label} model`, 256) } : {}),
    ...(hasEffort ? { effort: boundedString(member.effort, `${label} effort`, 64) } : {}),
  }
  if (!schema3) return common
  return { ...common, ordinal: nonNegativeSafeInteger(member.ordinal, `${label} ordinal`),
    agentId: parseMemberId(member.agentId) }
}

function requireDenseArray(value: unknown, label: string, strict: boolean): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    const lane = /^lane (\d+) members$/.exec(label)
    throw new TypeError(label === 'lanes' ? 'Launch plan requires 1-64 lanes' : `Lane ${lane?.[1] ?? '?'} requires 1-64 members`)
  }
  if (strict && Array.from({ length: value.length }, (_, index) => Object.prototype.hasOwnProperty.call(value, index)).some(present => !present)) {
    throw new TypeError(`Sparse schema 3 ${label} array`)
  }
  if (strict) {
    const keys = Reflect.ownKeys(value)
    const expected = new Set<PropertyKey>(['length', ...Array.from({ length: value.length }, (_, index) => String(index))])
    if (keys.length !== expected.size || keys.some(key => !expected.has(key)) ||
      Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
        .some(descriptor => !descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) {
      throw new TypeError(`Invalid direct schema 3 ${label} array`)
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value, label)
  const prototype = Object.getPrototypeOf(record)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Invalid ${label}`)
  const keys = Reflect.ownKeys(record)
  if (keys.some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(record, key) ||
    !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(record, key) ?? {}, 'value'))) {
    throw new TypeError(`Invalid ${label}`)
  }
  return record
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`Unexpected ${label} fields`)
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError(`Invalid ${label}`)
  return value
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`Invalid ${label}`)
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  const integer = nonNegativeSafeInteger(value, label)
  if (integer < 1) throw new TypeError(`Invalid ${label}`)
  return integer
}

function taggedHash(value: unknown): `sha256:${string}` {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('Invalid runtimePlanRef.planHash')
  return value as `sha256:${string}`
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
