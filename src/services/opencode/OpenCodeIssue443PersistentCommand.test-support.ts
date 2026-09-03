import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import { buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore, openCodeSessionStore } from './OpenCodeSessionStore.js'

import type {
  OpenCodeHostHandle,
  OpenCodePreparedProfile,
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
} from './types.js'

const teamId = 'team-443'
const laneId = 'lane-443'
const runId = 'run-443'
const providerId = 'deepinfra'
const modelId = 'deepinfra/meta-llama/Llama-3.3-70B-Instruct'
const appMcpLaunchSource = 'env-override' as const
const managedConfig = {
  mcp: {
    'agent-teams': {
      type: 'local' as const,
      command: [process.execPath, '-e', 'process.stdin.resume()'],
      environment: {},
      enabled: true,
      timeout: 30_000,
    },
  },
}
const managedConfigFingerprint = buildManagedConfigFingerprint(managedConfig)
const projectBehaviorFingerprint = 'b'.repeat(64)
const childFlag = 'OPENCODE_ISSUE443_COMMAND_CHILD'

export type PersistentInvocationMode = 'first-unknown' | 'restart' | 'stale' | 'unknown-proof'

export type PersistentFakeEvent = {
  type: 'adopt-profile' | 'authority' | 'proof' | 'member' | 'inject' | 'release-host' | 'release-session'
  requestId: string
  hostId?: string
  projectPath?: string
  purpose?: string
  providerId?: string
  modelId?: string
  nonce?: string
  attemptId?: string
  generation?: number
  fingerprint?: string
  memberFingerprint?: string
  member?: string
  sessionId?: string
  keepAlive?: boolean
}

export type PersistedFakeState = {
  host: OpenCodeHostHandle
  expectedBehaviorFingerprint: string
  invocations: Array<{ requestId: string; pid: number; mode: PersistentInvocationMode }>
  creates: Array<{ requestId: string; member: string; sessionId: string }>
  events: PersistentFakeEvent[]
}

type ChildResult = Awaited<ReturnType<typeof executeOpenCodeBridgeCommandEnvelope>>

function profileFor(root: string): OpenCodePreparedProfile {
  const projectPath = path.join(root, 'project')
  const profileRoot = path.join(root, 'profile')
  return {
    projectPath,
    canonicalProjectPath: projectPath,
    workingDirectoryPath: projectPath,
    scopeToken: 'launch-scope-443',
    profileRootKey: 'fake-profile-443',
    profileRootPath: profileRoot,
    profileScope: {
      purpose: 'launch_runtime',
      providerId,
      configFingerprint: managedConfigFingerprint,
      selectedAuthIdentity: 'absent',
      scopeToken: 'launch-scope-443',
    },
    projectDefaultModelId: null,
    allProjectsDefaultModelId: null,
    effectiveManagedDefaultModelId: null,
    effectiveManagedDefaultSource: null,
    projectBehaviorFingerprint,
    behaviorSources: [],
    managedConfig,
    managedConfigFingerprint,
    appMcpLaunchSource,
    homePath: path.join(profileRoot, 'home'),
    tmpPath: path.join(profileRoot, 'tmp'),
    xdgConfigHome: path.join(profileRoot, 'config'),
    xdgDataHome: path.join(profileRoot, 'data'),
    xdgCacheHome: path.join(profileRoot, 'cache'),
    globalAuthPath: path.join(root, 'source-auth.json'),
    managedAuthPath: path.join(profileRoot, 'data/opencode/auth.json'),
    sourceAuthPath: path.join(root, 'source-auth.json'),
    sourceAuthFingerprint: 'source-auth-443',
    managedAuthFingerprint: 'managed-auth-443',
    authState: 'ok',
    env: {},
  }
}

function hostFor(root: string): OpenCodeHostHandle {
  const profile = profileFor(root)
  return {
    hostKey: 'fake-retained-host-443',
    profileRootKey: profile.profileRootKey,
    projectPath: profile.projectPath,
    projectBehaviorFingerprint,
    baseUrl: 'http://fake-host.invalid',
    port: 443,
    pid: 44301,
    version: 'fake-443',
    state: 'healthy',
    profile,
    resolvedConfigFingerprint: managedConfigFingerprint,
    diagnostics: [],
  }
}

function snapshotFor(state: PersistedFakeState): OpenCodeProvisioningSnapshot {
  return {
    detected: true,
    hostHealthy: true,
    projectPath: state.host.projectPath,
    profile: state.host.profile,
    host: state.host,
    config: null,
    configProviders: {
      providers: [{
        id: providerId,
        models: { 'meta-llama/Llama-3.3-70B-Instruct': {} },
      }],
      default: { [providerId]: 'meta-llama/Llama-3.3-70B-Instruct' },
    },
    providers: {
      connected: [providerId],
      default: { [providerId]: 'meta-llama/Llama-3.3-70B-Instruct' },
    },
    providerAuth: null,
    agents: [],
    mcp: {},
    appMcp: {
      serverName: 'agent-teams', matchedServerName: 'agent-teams', status: 'present',
      connected: true, launchSource: appMcpLaunchSource,
      availableServerNames: ['agent-teams'],
      diagnostics: [],
    },
    probeError: null,
    diagnostics: [],
  }
}

function incompleteRecord(
  state: PersistedFakeState,
  member: string,
  sessionId: string,
): OpenCodeSessionRecord {
  return {
    teamId,
    runId,
    laneId,
    memberName: member,
    providerId: 'opencode',
    selectedModel: modelId,
    projectPath: state.host.projectPath,
    profileRootKey: state.host.profileRootKey,
    profileScope: state.host.profile.profileScope,
    hostKey: state.host.hostKey,
    toolApprovalMode: 'auto',
    resolvedBehaviorFingerprint: state.host.resolvedConfigFingerprint,
    opencodeSessionId: sessionId,
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: state.host.profile.sourceAuthFingerprint,
    managedAuthFingerprint: state.host.profile.managedAuthFingerprint,
    projectBehaviorFingerprint: state.host.projectBehaviorFingerprint,
    managedConfigFingerprint: state.host.profile.managedConfigFingerprint,
    expectedBehaviorFingerprint: state.expectedBehaviorFingerprint,
    staleReason: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  }
}

const requiredMcpTools = [
  'cross_team_get_outbox', 'cross_team_list_targets', 'cross_team_send', 'member_briefing',
  'message_send', 'process_list', 'process_register', 'process_stop', 'process_unregister',
  'review_approve', 'review_request', 'review_request_changes', 'review_start',
  'runtime_bootstrap_checkin', 'runtime_deliver_message', 'runtime_task_event',
  'runtime_heartbeat', 'task_add_comment', 'task_attach_comment_file', 'task_attach_file',
  'task_briefing', 'task_complete', 'task_create', 'task_create_from_message', 'task_get',
  'task_get_comment', 'task_link', 'task_list', 'task_set_clarification', 'task_set_owner',
  'task_set_status', 'task_start', 'task_unlink',
]

async function runChild(root: string, requestId: string, mode: PersistentInvocationMode): Promise<ChildResult> {
  // The production deadline/scheduler boundary sees a fixed clock. Child exit,
  // durable file writes, and awaited process completion are the only barriers.
  Date.now = () => Date.parse('2026-08-29T00:00:00.000Z')
  const statePath = path.join(root, 'fake-state.json')
  const store = new OpenCodeSessionStore(path.join(root, 'session-store.json'))
  const readState = async () => JSON.parse(await readFile(statePath, 'utf8')) as PersistedFakeState
  const writeState = async (state: PersistedFakeState) => {
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
  const recordEvent = async (event: PersistentFakeEvent) => {
    const state = await readState()
    state.events.push(event)
    await writeState(state)
  }

  const initial = await readState()
  initial.invocations.push({ requestId, pid: process.pid, mode })
  await writeState(initial)

  ;(Client.prototype.connect as unknown as () => Promise<void>) = async () => {}
  ;(Client.prototype.listTools as unknown as () => Promise<{ tools: Array<{ name: string }> }>) =
    async () => ({ tools: requiredMcpTools.map(name => ({ name })) })
  ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}

  openCodeProvisioningProbe.probeRetainingHost = (async (projectPath, options) => {
    const state = await readState()
    if (projectPath !== state.host.projectPath || options.selectedModel !== modelId) {
      throw new Error('fake command escaped its adopted project/model profile')
    }
    await recordEvent({
      type: 'adopt-profile', requestId, hostId: state.host.hostKey, projectPath,
      purpose: state.host.profile.profileScope?.purpose,
      providerId: state.host.profile.profileScope?.providerId,
      modelId: options.selectedModel,
      attemptId: requestId,
      generation: 1,
      fingerprint: state.expectedBehaviorFingerprint,
    })
    return {
      snapshot: snapshotFor(state),
      host: state.host,
      release: async (keepAlive?: boolean) => recordEvent({
        type: 'release-host', requestId, hostId: state.host.hostKey, keepAlive,
      }),
    }
  }) as typeof openCodeProvisioningProbe.probeRetainingHost

  openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async input => {
    const state = await readState()
    await recordEvent({
      type: 'authority', requestId, hostId: input.host.hostKey,
      projectPath: input.host.projectPath, providerId, modelId: input.selectedModel,
      attemptId: requestId, generation: 1, fingerprint: input.expectedBehaviorFingerprint,
    })
    return mode === 'stale' ? null : state.host.profile
  }) as typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority

  openCodeExecutionProbe.probeModelOnHost = (async input => {
    const nonce = input.expectedOutput?.replace(/^STRICT_LAUNCH_/, '') ?? ''
    const state = await readState()
    await recordEvent({
      type: 'proof', requestId, hostId: input.host.hostKey, projectPath: input.host.projectPath,
      providerId, modelId: input.selectedModel, nonce, attemptId: requestId, generation: 1,
      fingerprint: state.expectedBehaviorFingerprint,
    })
    const common = {
      providerId: 'opencode' as const,
      modelId: input.selectedModel,
      observedProviderId: providerId,
      observedModelId: modelId.slice(providerId.length + 1),
      probePrompt: input.prompt ?? '',
      expectedOutput: input.expectedOutput ?? '',
      durationMs: 0,
      rawStatus: 'idle',
      durableState: 'idle' as const,
      latestAssistantPreview: input.expectedOutput ?? null,
      toolCallCount: 0,
      errorCount: 0,
      diagnostics: [],
      verifiedAt: '2026-08-29T00:00:00.000Z',
    }
    if (mode === 'unknown-proof') return {
      ...common, outcome: 'unknown' as const, reason: 'fake proof acknowledgement unknown',
      latestAssistantText: null,
    }
    return {
      ...common, outcome: 'available' as const, reason: null,
      latestAssistantText: input.expectedOutput ?? null,
    }
  }) as typeof openCodeExecutionProbe.probeModelOnHost

  openCodeSessionStore.get = store.get.bind(store)
  openCodeSessionStore.observeMaterialization = store.observeMaterialization.bind(store)
  openCodeSessionStore.isMaterializationOwnerActive = store.isMaterializationOwnerActive.bind(store)
  openCodeSessionStore.releaseInactiveMaterializationOwner =
    store.releaseInactiveMaterializationOwner.bind(store)
  openCodeSessionStore.upsert = store.upsert.bind(store)
  openCodeSessionStore.releaseMaterializationOwner = store.releaseMaterializationOwner.bind(store)
  openCodeSessionStore.markStaleIfSession = store.markStaleIfSession.bind(store)
  openCodeSessionStore.deleteIfSession = store.deleteIfSession.bind(store)

  openCodeSessionBridge.materializeSessionOnHost = (async input => {
    const state = await readState()
    const proof = [...state.events].reverse().find(event =>
      event.requestId === requestId && event.type === 'proof')
    if (!proof || proof.hostId !== state.host.hostKey || proof.modelId !== modelId || !proof.nonce) {
      throw new Error('member side effect attempted before exact retained-host proof')
    }
    const attemptId = input.attemptId ?? input.runId
    const identity = { teamId, laneId, memberName: input.memberName }
    const claim = await store.claimMaterialization(
      identity,
      attemptId,
      input.runId,
      input.signal,
    )
    if (claim.kind === 'owned_by_other' || claim.kind === 'already_owned') {
      throw new Error(`fake materialization claim unavailable: ${claim.kind}`)
    }
    const existing = claim.kind === 'existing' ? claim.record : null
    if (existing) {
      const ownerToken = await store.acquireMaterializationOwner(
        existing, attemptId, input.signal,
        claim.kind === 'existing' ? claim.ownerToken : undefined,
      )
      if (!ownerToken) throw new Error('fake resume reservation unavailable')
      const expectedBootstrap = input.expectedBootstrapForSession(existing.opencodeSessionId)
      await recordEvent({
        type: 'member', requestId, hostId: input.host.hostKey, member: input.memberName,
        sessionId: existing.opencodeSessionId, attemptId: requestId, generation: 1,
        providerId, modelId, fingerprint: input.expectedBehaviorFingerprint,
        memberFingerprint: expectedBootstrap.briefingHash,
      })
      return { record: existing, ownerToken, created: false, resumeBootstrap: true }
    }
    const next = await readState()
    const sessionId = `session-${input.memberName}-${next.creates.length + 1}`
    const record = incompleteRecord(next, input.memberName, sessionId)
    const expectedBootstrap = input.expectedBootstrapForSession(sessionId)
    next.creates.push({ requestId, member: input.memberName, sessionId })
    next.events.push({
      type: 'member', requestId, hostId: input.host.hostKey, member: input.memberName,
      sessionId, attemptId: requestId, generation: 1, providerId, modelId,
      fingerprint: input.expectedBehaviorFingerprint,
      memberFingerprint: expectedBootstrap.briefingHash,
    })
    await writeState(next)
    const ownerToken = claim.kind === 'claimed'
      ? await store.commitMaterialization(record, claim.ownerToken, input.signal)
      : null
    if (!ownerToken) throw new Error('fake materialization claim was lost before commit')
    if (mode === 'first-unknown' && input.memberName === 'two') {
      throw new Error('fake create acknowledgement unknown')
    }
    return { record, ownerToken, created: true }
  }) as typeof openCodeSessionBridge.materializeSessionOnHost

  openCodeSessionBridge.ensureSessionAppMcpReady = (async record => ({
    ok: true, status: 'present', connected: true, runtimePid: record.runtimePid, diagnostics: [],
  })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
  openCodeSessionBridge.injectAppManagedBootstrapContext = (async (record, input) => {
    await recordEvent({
      type: 'inject', requestId, hostId: record.hostKey, member: record.memberName,
      sessionId: record.opencodeSessionId, attemptId: requestId, generation: 1,
      providerId, modelId: record.selectedModel, fingerprint: record.expectedBehaviorFingerprint,
    })
    return {
      messageID: input.messageID,
      runtimeSessionId: record.opencodeSessionId,
      contextHash: input.contextHash,
      briefingHash: input.briefingHash,
      injectionVerifiedAt: '2026-08-29T00:00:00.000Z',
      alreadyPresent: false,
    }
  }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
  openCodeSessionBridge.releaseSession = (async record => {
    await recordEvent({
      type: 'release-session', requestId, member: record.memberName,
      sessionId: record.opencodeSessionId,
    })
  }) as typeof openCodeSessionBridge.releaseSession

  return executeOpenCodeBridgeCommandEnvelope({
    schemaVersion: 1,
    requestId,
    command: 'opencode.launchTeam',
    cwd: initial.host.projectPath,
    startedAt: '2026-08-29T00:00:00.000Z',
    timeoutMs: 60_000,
    body: {
      runId,
      laneId,
      teamId,
      teamName: teamId,
      projectPath: initial.host.projectPath,
      selectedModel: modelId,
      members: [
        { name: 'one', prompt: 'One joins the fake team.' },
        { name: 'two', prompt: 'Two joins the fake team.' },
      ],
      preconditions: {
        handshakeIdentityHash: 'fake-handshake-443',
        laneId,
        expectedRunId: runId,
        expectedCapabilitySnapshotId: null,
        expectedBehaviorFingerprint: initial.expectedBehaviorFingerprint,
        expectedManifestHighWatermark: 0,
        commandLeaseId: 'lease-443',
        idempotencyKey: `launch:${runId}`,
      },
    },
  })
}

export class Issue443PersistentCommandFake {
  root = ''
  storePath = ''
  statePath = ''
  private invocation = 0

  async open(): Promise<void> {
    this.root = await mkdtemp(path.join(os.tmpdir(), 'opencode-issue443-command-boundary-'))
    this.storePath = path.join(this.root, 'session-store.json')
    this.statePath = path.join(this.root, 'fake-state.json')
    const host = hostFor(this.root)
    await mkdir(host.profile.projectPath, { recursive: true })
    const expectedBehaviorFingerprint = (await buildOpenCodeExpectedBehaviorEvidence({
      profile: host.profile,
      fullModelId: modelId,
      effectiveConfigFingerprint: host.resolvedConfigFingerprint,
    })).expectedBehaviorFingerprint
    await writeFile(this.statePath, `${JSON.stringify({
      host, expectedBehaviorFingerprint, invocations: [], creates: [], events: [],
    } satisfies PersistedFakeState, null, 2)}\n`)
  }

  async close(): Promise<void> {
    if (!path.basename(this.root).startsWith('opencode-issue443-command-boundary-')) {
      throw new Error(`refusing non-owned cleanup: ${this.root}`)
    }
    await rm(this.root, { recursive: true, force: true })
  }

  async invokeOneShot(mode: PersistentInvocationMode): Promise<ChildResult> {
    const requestId = `request-${++this.invocation}`
    const source = fileURLToPath(import.meta.url)
    const child = Bun.spawn([process.execPath, source], {
      cwd: this.root,
      env: {
        ...process.env,
        [childFlag]: '1',
        OPENCODE_ISSUE443_ROOT: this.root,
        OPENCODE_ISSUE443_REQUEST_ID: requestId,
        OPENCODE_ISSUE443_MODE: mode,
        HOME: path.join(this.root, 'home'),
        XDG_CONFIG_HOME: path.join(this.root, 'xdg-config'),
        XDG_DATA_HOME: path.join(this.root, 'xdg-data'),
        XDG_CACHE_HOME: path.join(this.root, 'xdg-cache'),
        TMPDIR: path.join(this.root, 'tmp'),
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: source,
        AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH: path.join(this.root, `mcp-proof-${requestId}.json`),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`fake command child exited ${exitCode}: ${stderr}`)
    return JSON.parse(stdout) as ChildResult
  }

  async sessions(): Promise<OpenCodeSessionRecord[]> {
    return new OpenCodeSessionStore(this.storePath).list()
  }

  async evidence(): Promise<PersistedFakeState> {
    return JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedFakeState
  }
}

if (process.env[childFlag] === '1') {
  const root = process.env.OPENCODE_ISSUE443_ROOT
  const requestId = process.env.OPENCODE_ISSUE443_REQUEST_ID
  const mode = process.env.OPENCODE_ISSUE443_MODE as PersistentInvocationMode | undefined
  if (!root || !requestId || !mode) throw new Error('incomplete issue443 fake child contract')
  process.stdout.write(JSON.stringify(await runChild(root, requestId, mode)))
}
