import { describe, expect, test } from 'bun:test'
import { buildOpenCodeGroupChatRunProof } from './OpenCodeGroupChatCapability.js'
import type { OpenCodeProvisioningSnapshot, OpenCodeSessionRecord } from './types.js'

const controlContext = JSON.stringify({
  appInstanceId: 'group-proof-test',
  dataRootFingerprint: 'group-proof-root',
  connectionGeneration: 1,
})
const ownedHost = {
  hostKey: 'owned-xai-host',
  pid: process.pid,
  controlUrl: 'http://127.0.0.1:41571',
  controlContext,
}
const groupTools = ['agent-teams_group_chat_list', 'agent-teams_group_chat_send']

function makeRecord(): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    memberName: 'grok',
    providerId: 'opencode',
    selectedModel: 'xai/grok-4.5',
    projectPath: '/synthetic/workspace',
    profileRootKey: 'owned-xai-profile',
    hostKey: ownedHost.hostKey,
    laneId: 'xai-lane',
    runId: 'current-run',
    runtimePid: process.pid,
    resolvedBehaviorFingerprint: null,
    opencodeSessionId: 'owned-session',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'behavior',
    appManagedBootstrap: {
      schemaVersion: 1,
      messageID: 'msg_current',
      contextHash: 'a'.repeat(64),
      briefingHash: 'b'.repeat(64),
      injectionVerifiedAt: '2026-10-31T12:00:00.000Z',
    },
    staleReason: null,
    createdAt: '2026-10-31T12:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z',
  }
}
function makeSnapshot(): OpenCodeProvisioningSnapshot {
  return {
    detected: true,
    hostHealthy: false,
    projectPath: '/synthetic/workspace',
    profile: null,
    host: null,
    config: null,
    configProviders: null,
    providers: null,
    providerAuth: null,
    agents: [],
    mcp: { 'agent-teams': { status: 'connected' } },
    appMcp: null,
    probeError: null,
    diagnostics: [],
  }
}

describe('owned xAI OAuth named-group proof', () => {
  test('accepts an owned live endpoint without manufacturing a retained host', () => {
    const proof = buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), groupTools, ownedHost)
    expect(proof).toEqual({
      teamName: 'team-a',
      memberName: 'grok',
      runId: 'current-run',
      runKey: 'current-run',
      laneId: 'xai-lane',
      runtimePid: process.pid,
      runtimeSessionId: 'owned-session',
      processorReady: true,
      groupReactionProtocolVersion: 1,
    })
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), groupTools)).toBeUndefined()
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(),
      { ...makeRecord(), runtimePid: undefined }, groupTools)).toBeUndefined()
  })

  test('fails closed for mismatched host and process identity', () => {
    for (const host of [
      { ...ownedHost, hostKey: 'foreign-host' },
      { ...ownedHost, pid: process.pid + 1 },
    ]) {
      expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), groupTools, host)).toBeUndefined()
    }
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), { ...makeRecord(), runtimePid: 0 }, groupTools, ownedHost)).toBeUndefined()
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), { ...makeRecord(), hostKey: 'foreign-host' }, groupTools, ownedHost)).toBeUndefined()
  })

  test('fails closed for stale, stopped or unbootstrapped sessions', () => {
    for (const patch of [
      { runId: undefined },
      { staleReason: 'session_changed' },
      { stoppedAt: '2026-10-31T13:00:00.000Z' },
      { appManagedBootstrap: undefined },
      { opencodeSessionId: '' },
    ] as const) {
      expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), { ...makeRecord(), ...patch }, groupTools, ownedHost)).toBeUndefined()
    }
  })

  test('fails closed without connected MCP, fresh group tools and a valid app binding', () => {
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), ['agent-teams_group_chat_list'], ownedHost)).toBeUndefined()
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), groupTools,
      { ...ownedHost, controlContext: '{}' })).toBeUndefined()
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), makeRecord(), groupTools,
      { ...ownedHost, controlUrl: 'http://remote.example:41571' })).toBeUndefined()
    expect(buildOpenCodeGroupChatRunProof({ ...makeSnapshot(), mcp: null }, makeRecord(), groupTools, ownedHost)).toBeUndefined()
  })
})
