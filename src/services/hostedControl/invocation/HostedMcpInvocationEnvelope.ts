import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const HOSTED_MCP_INVOCATION_DOMAIN = 'agent-teams.hosted-mcp-invocation.owner-proof/v1'
export const HOSTED_MCP_INVOCATION_MAX_FRAME_BYTES = 4 * 1024
export const HOSTED_MCP_ARGUMENTS_MAX_BYTES = 256 * 1024
export const HOSTED_MCP_INVOCATION_MAX_TTL_MS = 60_000

type Sha256 = `sha256:${string}`

export type HostedMcpInvocationBinding = Readonly<{
  schemaVersion: 1
  operation: 'mcp_invocation'
  ownerIncarnation: string
  ownerLeaseId: string
  workspaceId: string
  teamId: string
  runId: string
  laneId: string
  memberId: string
  planGeneration: number
  admissionGeneration: number
  hostId: string
  sessionId: string
  callId: string
  toolName: string
  argumentsSha256: Sha256
  canonicalTeamRootSha256: Sha256
  selectedConfigSha256: Sha256
}>

export type HostedMcpInvocationUnsigned = HostedMcpInvocationBinding & Readonly<{
  issuedAtMs: number
  expiresAtMs: number
}>

export type HostedMcpInvocationEnvelope = HostedMcpInvocationUnsigned & Readonly<{
  ownerProof: string
}>

const BINDING_KEYS = [
  'schemaVersion', 'operation', 'ownerIncarnation', 'ownerLeaseId',
  'workspaceId', 'teamId', 'runId', 'laneId', 'memberId',
  'planGeneration', 'admissionGeneration', 'hostId', 'sessionId', 'callId',
  'toolName', 'argumentsSha256',
  'canonicalTeamRootSha256', 'selectedConfigSha256',
] as const
const UNSIGNED_KEYS = [...BINDING_KEYS, 'issuedAtMs', 'expiresAtMs'] as const
const WIRE_KEYS = [...UNSIGNED_KEYS, 'ownerProof'] as const
const SHA256 = /^sha256:[0-9a-f]{64}$/
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function fail(): never { throw new TypeError('Invalid hosted MCP invocation envelope') }

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail()
}

function field(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail()
  return value
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail()
  return value as number
}

function binding(value: Record<string, unknown>): HostedMcpInvocationBinding {
  if (value.schemaVersion !== 1 || value.operation !== 'mcp_invocation') fail()
  return {
    schemaVersion: 1,
    operation: 'mcp_invocation',
    ownerIncarnation: field(value.ownerIncarnation, OPAQUE_ID),
    ownerLeaseId: field(value.ownerLeaseId, OPAQUE_ID),
    workspaceId: field(value.workspaceId, OPAQUE_ID),
    teamId: field(value.teamId, OPAQUE_ID),
    runId: field(value.runId, OPAQUE_ID),
    laneId: field(value.laneId, OPAQUE_ID),
    memberId: field(value.memberId, OPAQUE_ID),
    planGeneration: timestamp(value.planGeneration),
    admissionGeneration: timestamp(value.admissionGeneration),
    hostId: field(value.hostId, OPAQUE_ID),
    sessionId: field(value.sessionId, OPAQUE_ID),
    callId: field(value.callId, OPAQUE_ID),
    toolName: field(value.toolName, TOOL_NAME),
    argumentsSha256: field(value.argumentsSha256, SHA256) as Sha256,
    canonicalTeamRootSha256: field(value.canonicalTeamRootSha256, SHA256) as Sha256,
    selectedConfigSha256: field(value.selectedConfigSha256, SHA256) as Sha256,
  }
}

function unsigned(value: Record<string, unknown>): HostedMcpInvocationUnsigned {
  const result = {
    ...binding(value),
    issuedAtMs: timestamp(value.issuedAtMs),
    expiresAtMs: timestamp(value.expiresAtMs),
  }
  if (result.expiresAtMs <= result.issuedAtMs ||
    result.expiresAtMs - result.issuedAtMs > HOSTED_MCP_INVOCATION_MAX_TTL_MS) fail()
  return result
}

function proof(secret: Uint8Array, canonicalUnsigned: string): string {
  if (secret.byteLength !== 32) fail()
  return createHmac('sha256', secret)
    .update(`${HOSTED_MCP_INVOCATION_DOMAIN}\0${canonicalUnsigned}`)
    .digest('hex')
}

/** Canonical JSON for a JSON-compatible MCP arguments value. Key order is normalized. */
export function canonicalHostedMcpArguments(value: unknown): string {
  const seen = new Set<object>()
  const chunks: string[] = []
  let bytes = 0
  const append = (part: string): void => {
    bytes += Buffer.byteLength(part, 'utf8')
    if (bytes > HOSTED_MCP_ARGUMENTS_MAX_BYTES) fail()
    chunks.push(part)
  }
  const encode = (item: unknown, depth: number): void => {
    if (depth > 32) fail()
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      append(JSON.stringify(item)); return
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail()
      append(JSON.stringify(item)); return
    }
    if (typeof item !== 'object' || seen.has(item)) fail()
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > HOSTED_MCP_ARGUMENTS_MAX_BYTES) fail()
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) fail()
      append('[')
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail()
        if (index > 0) append(',')
        encode(descriptor.value, depth + 1)
      }
      append(']')
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail()
      const object = item as Record<string, unknown>
      const keys = Object.keys(object).sort()
      if (keys.length > HOSTED_MCP_ARGUMENTS_MAX_BYTES || Reflect.ownKeys(object).length !== keys.length) fail()
      append('{')
      for (const [index, key] of keys.entries()) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail()
        if (index > 0) append(',')
        append(JSON.stringify(key))
        append(':')
        encode(descriptor.value, depth + 1)
      }
      append('}')
    }
    seen.delete(item)
  }
  encode(value, 0)
  return chunks.join('')
}

export function digestHostedMcpArguments(value: unknown): Sha256 {
  return `sha256:${createHash('sha256').update(canonicalHostedMcpArguments(value)).digest('hex')}`
}

/** Same callId in the same Owner lease maps to one slot even if its payload conflicts. */
export function hostedMcpInvocationReplayIdentity(value: HostedMcpInvocationBinding): Sha256 {
  const normalized = binding(value as unknown as Record<string, unknown>)
  const identity = {
    schemaVersion: normalized.schemaVersion,
    operation: normalized.operation,
    ownerIncarnation: normalized.ownerIncarnation,
    ownerLeaseId: normalized.ownerLeaseId,
    workspaceId: normalized.workspaceId,
    teamId: normalized.teamId,
    runId: normalized.runId,
    laneId: normalized.laneId,
    memberId: normalized.memberId,
    hostId: normalized.hostId,
    sessionId: normalized.sessionId,
    callId: normalized.callId,
  }
  return `sha256:${createHash('sha256').update(`${HOSTED_MCP_INVOCATION_DOMAIN}\0replay\0${JSON.stringify(identity)}`).digest('hex')}`
}

/** Persist beside replay identity and reject any reused slot with a different fingerprint. */
export function hostedMcpInvocationBindingFingerprint(value: HostedMcpInvocationBinding): Sha256 {
  const normalized = binding(value as unknown as Record<string, unknown>)
  return `sha256:${createHash('sha256').update(`${HOSTED_MCP_INVOCATION_DOMAIN}\0binding\0${JSON.stringify(normalized)}`).digest('hex')}`
}

/** Only the Owner may call this with its private 32-byte proof key. */
export function mintHostedMcpInvocationEnvelope(input: HostedMcpInvocationUnsigned, secret: Uint8Array): string {
  exactKeys(input as unknown as Record<string, unknown>, UNSIGNED_KEYS)
  const normalized = unsigned(input as unknown as Record<string, unknown>)
  const canonicalUnsigned = JSON.stringify(normalized)
  const frame = `${canonicalUnsigned.slice(0, -1)},"ownerProof":"${proof(secret, canonicalUnsigned)}"}`
  if (Buffer.byteLength(frame, 'utf8') > HOSTED_MCP_INVOCATION_MAX_FRAME_BYTES) fail()
  return frame
}

/** Authenticates the exact canonical frame; current lease and call matching remain caller duties. */
export function decodeHostedMcpInvocationEnvelope(frame: string, secret: Uint8Array): HostedMcpInvocationEnvelope {
  if (Buffer.byteLength(frame, 'utf8') > HOSTED_MCP_INVOCATION_MAX_FRAME_BYTES ||
    frame.includes('\n') || frame.includes('\r')) fail()
  let parsed: unknown
  try { parsed = JSON.parse(frame) } catch { fail() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail()
  const value = parsed as Record<string, unknown>
  exactKeys(value, WIRE_KEYS)
  const normalized = unsigned(value)
  const ownerProof = field(value.ownerProof, /^[0-9a-f]{64}$/)
  const canonicalUnsigned = JSON.stringify(normalized)
  const expectedFrame = `${canonicalUnsigned.slice(0, -1)},"ownerProof":"${ownerProof}"}`
  if (frame !== expectedFrame) fail()
  const expectedProof = Buffer.from(proof(secret, canonicalUnsigned), 'hex')
  if (!timingSafeEqual(expectedProof, Buffer.from(ownerProof, 'hex'))) fail()
  return { ...normalized, ownerProof }
}

/** Exact live binding comparison is required immediately before a future effect edge. */
export function verifyHostedMcpInvocationEnvelope(
  frame: string,
  secret: Uint8Array,
  expected: HostedMcpInvocationBinding,
  nowMs: number,
): HostedMcpInvocationEnvelope {
  const envelope = decodeHostedMcpInvocationEnvelope(frame, secret)
  if (!Number.isSafeInteger(nowMs) || nowMs < envelope.issuedAtMs || nowMs >= envelope.expiresAtMs) fail()
  if (JSON.stringify(binding(expected as unknown as Record<string, unknown>)) !==
    JSON.stringify(binding(envelope as unknown as Record<string, unknown>))) fail()
  return envelope
}
