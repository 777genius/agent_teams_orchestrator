import { describe, expect, test } from 'bun:test'
import {
  canonicalHostedMcpArguments,
  decodeHostedMcpInvocationEnvelope,
  digestHostedMcpArguments,
  hostedMcpInvocationBindingFingerprint,
  hostedMcpInvocationReplayIdentity,
  mintHostedMcpInvocationEnvelope,
  verifyHostedMcpInvocationEnvelope,
  type HostedMcpInvocationBinding,
  type HostedMcpInvocationUnsigned,
} from './HostedMcpInvocationEnvelope.js'

const secret = Buffer.alloc(32, 0x42)
const invocation: HostedMcpInvocationUnsigned = {
  schemaVersion: 1,
  operation: 'mcp_invocation',
  ownerIncarnation: 'owner-2026-09-24-a',
  ownerLeaseId: 'lease-1',
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  runId: 'run-1',
  laneId: 'lane-1',
  memberId: 'member-1',
  planGeneration: 2,
  admissionGeneration: 3,
  hostId: 'host-1',
  sessionId: 'ses_1',
  callId: 'call_1',
  toolName: 'mcp__agent-teams__send_message',
  argumentsSha256: digestHostedMcpArguments({ b: [true, null], a: 1 }),
  canonicalTeamRootSha256: `sha256:${'1'.repeat(64)}`,
  selectedConfigSha256: `sha256:${'2'.repeat(64)}`,
  issuedAtMs: 1_000,
  expiresAtMs: 61_000,
}

describe('Hosted MCP invocation contract', () => {
  test('has a stable canonical arguments digest independent of object insertion order', () => {
    expect(canonicalHostedMcpArguments({ b: [true, null], a: 1 })).toBe('{"a":1,"b":[true,null]}')
    expect(invocation.argumentsSha256).toBe('sha256:1cc69c7fa23616ca2ec3ee70d24390a6225c8832db8a4c814c7e0e7f942f8668')
    expect(digestHostedMcpArguments({ a: 1, b: [true, null] })).toBe(invocation.argumentsSha256)
    expect(() => digestHostedMcpArguments({ value: undefined })).toThrow()
    expect(() => digestHostedMcpArguments({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => digestHostedMcpArguments(cyclic)).toThrow()
    expect(() => digestHostedMcpArguments([, 1])).toThrow()
    expect(() => digestHostedMcpArguments({ get value() { return 1 } })).toThrow()
  })

  test('mints a proof-last canonical frame and verifies exact live binding and expiry', () => {
    const frame = mintHostedMcpInvocationEnvelope(invocation, secret)
    expect(decodeHostedMcpInvocationEnvelope(frame, secret).ownerProof).toBe('aac15e493ed7b8d8fe1229defbe2951e0fdc6208ddd93ba9898c5008d67e43e4')
    expect(frame).toEndWith(',"ownerProof":"' + decodeHostedMcpInvocationEnvelope(frame, secret).ownerProof + '"}')
    expect(verifyHostedMcpInvocationEnvelope(frame, secret, invocation, 1_000)).toMatchObject(invocation)
    expect(verifyHostedMcpInvocationEnvelope(frame, secret, invocation, 60_999)).toMatchObject(invocation)
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, invocation, 61_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, ownerLeaseId: 'lease-2' }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, memberId: 'member-2' }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, planGeneration: 3 }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, admissionGeneration: 4 }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, argumentsSha256: `sha256:${'3'.repeat(64)}` }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, selectedConfigSha256: `sha256:${'3'.repeat(64)}` }, 2_000)).toThrow()
    expect(() => verifyHostedMcpInvocationEnvelope(frame, secret, { ...invocation, canonicalTeamRootSha256: `sha256:${'3'.repeat(64)}` }, 2_000)).toThrow()
  })

  test('rejects altered, duplicated, reordered and oversized signed frames', () => {
    const frame = mintHostedMcpInvocationEnvelope(invocation, secret)
    expect(() => decodeHostedMcpInvocationEnvelope(frame.replace('call_1', 'call_2'), secret)).toThrow()
    expect(() => decodeHostedMcpInvocationEnvelope(frame.replace('"callId":"call_1",', '"callId":"call_1","callId":"call_1",'), secret)).toThrow()
    expect(() => decodeHostedMcpInvocationEnvelope(frame.replace('"hostId":"host-1","sessionId":"ses_1"', '"sessionId":"ses_1","hostId":"host-1"'), secret)).toThrow()
    expect(() => decodeHostedMcpInvocationEnvelope(frame.replace('"schemaVersion":1', '"schemaVersion":1.0'), secret)).toThrow()
    expect(() => decodeHostedMcpInvocationEnvelope(frame.replace('"ownerProof":', '"extra":1,"ownerProof":'), secret)).toThrow()
    expect(() => decodeHostedMcpInvocationEnvelope(frame + ' '.repeat(4096), secret)).toThrow()
    expect(() => mintHostedMcpInvocationEnvelope({ ...invocation, expiresAtMs: 61_001 }, secret)).toThrow()
  })

  test('replay slot detects conflicting payloads under the same call identity', () => {
    const replay = hostedMcpInvocationReplayIdentity(invocation)
    const fingerprint = hostedMcpInvocationBindingFingerprint(invocation)
    expect(replay).toBe('sha256:cbdeb1d1942995c51a62d57a1bd2ac46cdd5d2714cbe20600d6c1c3be6de3675')
    expect(fingerprint).toBe('sha256:5bb063a0006414d0209c34b908d4aa0737a889fde5494009d9cbbf4fd071ac99')
    const renewed = { ...invocation, expiresAtMs: 40_000 }
    expect(hostedMcpInvocationReplayIdentity(renewed)).toBe(replay)
    expect(hostedMcpInvocationBindingFingerprint(renewed)).toBe(fingerprint)
    const identityChanges: Array<Partial<HostedMcpInvocationBinding>> = [
      { ownerIncarnation: 'owner-2026-09-24-b' }, { ownerLeaseId: 'lease-2' },
      { workspaceId: 'workspace-2' }, { teamId: 'team-2' }, { runId: 'run-2' },
      { laneId: 'lane-2' }, { memberId: 'member-2' },
      { hostId: 'host-2' }, { sessionId: 'ses_2' }, { callId: 'call_2' },
    ]
    for (const changed of identityChanges) expect(hostedMcpInvocationReplayIdentity({ ...invocation, ...changed })).not.toBe(replay)
    const payloadChanges: Array<Partial<HostedMcpInvocationBinding>> = [
      { toolName: 'mcp__agent-teams__create_task' },
      { argumentsSha256: `sha256:${'3'.repeat(64)}` },
      { canonicalTeamRootSha256: `sha256:${'3'.repeat(64)}` },
      { selectedConfigSha256: `sha256:${'3'.repeat(64)}` },
      { planGeneration: 3 }, { admissionGeneration: 4 },
    ]
    for (const changed of payloadChanges) {
      expect(hostedMcpInvocationReplayIdentity({ ...invocation, ...changed })).toBe(replay)
      expect(hostedMcpInvocationBindingFingerprint({ ...invocation, ...changed })).not.toBe(fingerprint)
    }
  })
})
