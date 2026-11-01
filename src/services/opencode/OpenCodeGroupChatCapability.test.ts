import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { buildOpenCodeGroupChatRunProof, readOwnedOAuthGroupControlBinding } from './OpenCodeGroupChatCapability.js'
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
    profileScope: { purpose: 'launch_runtime', providerId: 'xai',
      scopeToken: 'owned-xai-test', configFingerprint: 'owned-xai-config', selectedAuthIdentity: 'absent' },
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

  test('never treats a host-less observation from another OpenCode provider as an xAI owned session', () => {
    for (const providerId of ['openrouter', 'openai', 'github-copilot', 'zai', 'cursor-acp', 'kiro']) {
      const record = makeRecord()
      record.selectedModel = `${providerId}/synthetic-model`
      record.profileScope = { ...record.profileScope!, providerId }
      expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), record, groupTools, ownedHost)).toBeUndefined()
    }
    const record = makeRecord()
    record.profileScope = { ...record.profileScope!, purpose: 'catalog' }
    expect(buildOpenCodeGroupChatRunProof(makeSnapshot(), record, groupTools, ownedHost)).toBeUndefined()
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

describe('owned xAI MCP app-control provenance', () => {
  test('local MCP requires matching bound environment from loaded configuration', async () => {
    const appEnv = {
      AGENT_TEAMS_BOUND_CONTROL_URL: ownedHost.controlUrl,
      AGENT_TEAMS_BOUND_CONTEXT_JSON: ownedHost.controlContext,
    }
    const configuration = { type: 'local' as const, environment: appEnv }
    expect(await readOwnedOAuthGroupControlBinding(configuration, appEnv)).toEqual({
      controlUrl: ownedHost.controlUrl, context: ownedHost.controlContext,
    })
    expect(await readOwnedOAuthGroupControlBinding(configuration, { ...appEnv,
      AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify({ appInstanceId: 'foreign', dataRootFingerprint: 'foreign-root', connectionGeneration: 1 }),
    })).toBeNull()
    expect(await readOwnedOAuthGroupControlBinding({ type: 'local', environment: {} }, appEnv)).toBeNull()
  })

  test('desktop HTTP MCP must attest its own live transport, root and app-scoped URL', async () => {
    const root = '/synthetic/agent-teams-claude-root'
    const appInstanceId = 'owned-app-1'
    const profileScope = 'e'.repeat(64)
    let healthyOwner = 'http-server-owner'
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== '/health') return new Response('Not found', { status: 404 })
        return Response.json({
          schemaVersion: 1, service: 'agent-teams-mcp-http', transport: 'httpStream',
          host: '127.0.0.1', port: server.port, endpoint: '/mcp',
          claudeDirHash: createHash('sha256').update(root).digest('hex'),
          launchSpecHash: 'c'.repeat(64), ownerInstanceId: healthyOwner,
        })
      },
    })
    try {
      const scoped = new URL(server.url.origin + '/mcp')
      scoped.hash = new URLSearchParams({
        'agent-teams-app-instance': appInstanceId,
        'agent-teams-app-profile': profileScope,
      }).toString()
      const bound = {
        ...{
          AGENT_TEAMS_BOUND_CONTROL_URL: ownedHost.controlUrl,
          AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify({
            appInstanceId, dataRootFingerprint: 'root-fingerprint', connectionGeneration: 1,
          }),
        },
        CLAUDE_TEAM_APP_INSTANCE_ID: appInstanceId,
        CLAUDE_TEAM_APP_PROFILE_SCOPE: profileScope,
        AGENT_TEAMS_MCP_CLAUDE_DIR: root,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH:
          createHash('sha256').update(server.url.origin + '/mcp').digest('hex'),
      }
      const remote = { type: 'remote' as const, url: scoped.toString() }
      expect(await readOwnedOAuthGroupControlBinding(remote, bound)).toEqual({
        controlUrl: bound.AGENT_TEAMS_BOUND_CONTROL_URL,
        context: bound.AGENT_TEAMS_BOUND_CONTEXT_JSON,
      })
      const wrongScope = new URL(scoped)
      wrongScope.hash = new URLSearchParams({
        'agent-teams-app-instance': appInstanceId, 'agent-teams-app-profile': 'f'.repeat(64),
      }).toString()
      expect(await readOwnedOAuthGroupControlBinding({ ...remote, url: wrongScope.toString() }, bound)).toBeNull()
      expect(await readOwnedOAuthGroupControlBinding(remote, {
        ...bound, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL_HASH: 'a'.repeat(64),
      })).toBeNull()
      expect(await readOwnedOAuthGroupControlBinding(remote, {
        ...bound, CLAUDE_TEAM_APP_INSTANCE_ID: 'foreign-app',
      })).toBeNull()
      healthyOwner = ''
      expect(await readOwnedOAuthGroupControlBinding(remote, bound)).toBeNull()
      expect(await readOwnedOAuthGroupControlBinding({ type: 'remote', url: 'https://other.example/mcp' }, bound)).toBeNull()
    } finally {
      server.stop(true)
    }
  })
})
