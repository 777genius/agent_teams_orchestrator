import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeSessionBridge, isOpenCodeStrictSessionCompatible } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { coordinateStrictLaunch } from './OpenCodeStrictLaunchCoordinator.js'
import { ManualScheduler } from './OpenCodeIssue443FakeE2E.test-support.js'

import type { OpenCodeHostHandle, OpenCodeSessionRecord } from './types.js'
import type {
  StrictCommittedMember,
  StrictLaunchPorts,
  StrictLaunchResult,
  StrictMaterializedMember,
  StrictMember,
  StrictProof,
  StrictResource,
} from './OpenCodeStrictLaunchCoordinator.js'

type Projection = { member: string; sessionId: string; managerId: number }
type PersistedFakeState = {
  host: OpenCodeHostHandle
  managerInvocations: number[]
  creates: Array<{ managerId: number; member: string; sessionId: string }>
  releases: Array<{ managerId: number; keepAlive: boolean }>
}

const teamId = 'team-443'
const laneId = 'lane-443'
const runId = 'run-443'
const modelId = 'deepinfra/meta-llama/Llama-3.3-70B-Instruct'
const behaviorFingerprint = 'digest-443'

function bootstrap(member: string, sessionId: string) {
  return {
    messageID: `message-${member}-${sessionId}`,
    contextHash: `context-${member}`,
    briefingHash: `briefing-${member}`,
    agent: 'teammate',
  }
}

function completeRecord(record: OpenCodeSessionRecord, member: string): OpenCodeSessionRecord {
  const expected = bootstrap(member, record.opencodeSessionId)
  return {
    ...record,
    bootstrapEvidenceSource: 'app_managed_bootstrap',
    appManagedBootstrap: {
      schemaVersion: 1,
      ...expected,
      injectionVerifiedAt: '2026-08-29T00:00:00.000Z',
      model: modelId,
    },
    updatedAt: '2026-08-29T00:00:00.000Z',
  }
}

class PersistentLaunchManager implements StrictLaunchPorts<string, string, Projection> {
  readonly store: OpenCodeSessionStore
  readonly bridge: OpenCodeSessionBridge
  private readonly scheduler = new ManualScheduler()
  private operationSettled: Promise<void> = Promise.resolve()

  constructor(
    private readonly owner: Issue443PersistentCommandFake,
    private readonly managerId: number,
    private readonly attemptId: string,
    private readonly controller: AbortController,
    private readonly cancelAfterKnownCreate: string | null,
  ) {
    this.store = new OpenCodeSessionStore(owner.storePath)
    this.bridge = new OpenCodeSessionBridge({
      sessionStore: this.store,
      hostManager: {
        ensureHost: async () => { throw new Error('one-shot fake must use its persisted retained host') },
        releaseHost: async () => {},
        retainHostLease: async () => {},
        releaseHostLease: async () => {},
      },
      clientFactory: {
        create: baseUrl => ({
          createSession: async ({ title }: { title?: string }) => {
            const state = await owner.readState()
            if (baseUrl !== state.host.baseUrl) throw new Error('non-fake host escaped persistent harness')
            const member = title?.split(' - ').at(-1) ?? 'unknown'
            const sessionId = `session-${member}-${state.creates.length + 1}`
            state.creates.push({ managerId, member, sessionId })
            await owner.writeState(state)
            if (member === cancelAfterKnownCreate) {
              controller.abort(new Error(`cancelled after known create for ${member}`))
            }
            return { id: sessionId }
          },
        }) as never,
      },
    })
  }

  async execute(): Promise<StrictLaunchResult<Projection>> {
    const state = await this.owner.readState()
    state.managerInvocations.push(this.managerId)
    await this.owner.writeState(state)
    const result = await coordinateStrictLaunch({
      attemptId: this.attemptId,
      generation: 1,
      nonce: `nonce-${this.managerId}`,
      providerId: 'deepinfra',
      modelId,
      behaviorFingerprint,
      mcpTools: ['app_status'],
      members: [
        { memberId: 'one', memberFingerprint: 'briefing-one' },
        { memberId: 'two', memberFingerprint: 'briefing-two' },
      ],
      workContext: 'work',
      cleanupContext: 'cleanup',
      hostLease: { leaseId: `lease-${this.managerId}`, expectedHostId: state.host.hostKey },
      deadlineAt: 100,
      cleanupReserveMs: 20,
      signal: this.controller.signal,
      scheduler: this.scheduler,
    }, this)
    // The coordinator intentionally stops waiting after cancellation. The fake
    // handler still joins its known create so the next invocation is truly a
    // fresh process boundary over durable state, never a discarded promise.
    await this.operationSettled
    return result
  }

  snapshotProjection(value: Projection): Projection { return { ...value } }

  async acquireHost() {
    const state = await this.owner.readState()
    return { kind: 'ok' as const, value: { hostId: state.host.hostKey } }
  }

  async requestProof(_work: string, host: { hostId: string }, request: Omit<StrictProof, 'hostId'>) {
    return { kind: 'ok' as const, value: { ...request, hostId: host.hostId } }
  }

  async findCommitted(
    _work: string,
    member: StrictMember,
  ): Promise<{ kind: 'ok'; value: StrictCommittedMember<Projection> | null }> {
    const state = await this.owner.readState()
    const record = await this.store.get(teamId, laneId, member.memberId)
    if (!record || !isOpenCodeStrictSessionCompatible(record, {
      teamId,
      laneId,
      memberName: member.memberId,
      selectedModel: modelId,
      host: state.host,
      toolApprovalMode: 'auto',
      expectedBehaviorFingerprint: behaviorFingerprint,
      bootstrap: bootstrap(member.memberId, record.opencodeSessionId),
    })) return { kind: 'ok', value: null }
    return {
      kind: 'ok',
      value: {
        memberId: member.memberId,
        memberFingerprint: member.memberFingerprint,
        behaviorFingerprint,
        projection: { member: member.memberId, sessionId: record.opencodeSessionId, managerId: this.managerId },
      },
    }
  }

  async projectCommitted() { return { kind: 'ok' as const, value: undefined } }

  async materialize(
    _work: string,
    _host: { hostId: string },
    member: StrictMember,
  ): Promise<{ kind: 'ok'; value: StrictMaterializedMember<Projection> } | { kind: 'unknown'; error: string }> {
    const state = await this.owner.readState()
    let settle!: () => void
    this.operationSettled = new Promise<void>(resolve => { settle = resolve })
    try {
      const materialized = await this.bridge.materializeSessionOnHost({
        teamId,
        laneId,
        memberName: member.memberId,
        selectedModel: modelId,
        title: `${teamId} - ${member.memberId}`,
        runId,
        attemptId: this.attemptId,
        host: state.host,
        signal: this.controller.signal,
        remainingMs: () => 1_000,
        expectedBehaviorFingerprint: behaviorFingerprint,
        expectedBootstrapForSession: sessionId => bootstrap(member.memberId, sessionId),
      })
      if (!materialized.created) {
        return { kind: 'unknown', error: 'incomplete committed session replayed during materialization' }
      }
      const record = completeRecord(materialized.record, member.memberId)
      await this.store.upsert(record)
      return {
        kind: 'ok',
        value: {
          attemptId: this.attemptId,
          generation: 1,
          memberId: member.memberId,
          memberFingerprint: member.memberFingerprint,
          behaviorFingerprint,
          projection: { member: member.memberId, sessionId: record.opencodeSessionId, managerId: this.managerId },
          resource: {
            attemptId: this.attemptId,
            generation: 1,
            resourceId: record.opencodeSessionId,
            committed: true,
          },
        },
      }
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) }
    } finally {
      settle()
    }
  }

  async cleanup(_cleanup: string, _resources: StrictResource[]): Promise<void> {}

  async releaseHost(_cleanup: string, _lease: unknown, keepAlive: boolean): Promise<void> {
    const state = await this.owner.readState()
    state.releases.push({ managerId: this.managerId, keepAlive })
    await this.owner.writeState(state)
  }
}

export class Issue443PersistentCommandFake {
  root = ''
  storePath = ''
  private statePath = ''
  private nextManagerId = 0

  async open(): Promise<void> {
    this.root = await mkdtemp(path.join(os.tmpdir(), 'opencode-issue443-persistent-'))
    this.storePath = path.join(this.root, 'session-store.json')
    this.statePath = path.join(this.root, 'profile-host.json')
    const profileRoot = path.join(this.root, 'profile')
    const host: OpenCodeHostHandle = {
      hostKey: 'fake-retained-host',
      profileRootKey: 'fake-profile',
      projectPath: path.join(this.root, 'project'),
      projectBehaviorFingerprint: 'project-behavior-443',
      baseUrl: 'http://fake-host.invalid',
      port: 443,
      pid: 44301,
      version: 'fake-443',
      state: 'healthy',
      resolvedConfigFingerprint: 'resolved-config-443',
      diagnostics: [],
      profile: {
        projectPath: path.join(this.root, 'project'),
        canonicalProjectPath: path.join(this.root, 'project'),
        workingDirectoryPath: path.join(this.root, 'project'),
        scopeToken: null,
        profileRootKey: 'fake-profile',
        profileRootPath: profileRoot,
        projectDefaultModelId: null,
        allProjectsDefaultModelId: null,
        effectiveManagedDefaultModelId: null,
        effectiveManagedDefaultSource: null,
        projectBehaviorFingerprint: 'project-behavior-443',
        behaviorSources: [],
        managedConfig: {},
        managedConfigFingerprint: 'managed-config-443',
        homePath: path.join(profileRoot, 'home'),
        tmpPath: path.join(profileRoot, 'tmp'),
        xdgConfigHome: path.join(profileRoot, 'config'),
        xdgDataHome: path.join(profileRoot, 'data'),
        xdgCacheHome: path.join(profileRoot, 'cache'),
        globalAuthPath: path.join(this.root, 'source-auth.json'),
        managedAuthPath: path.join(profileRoot, 'data/opencode/auth.json'),
        sourceAuthPath: path.join(this.root, 'source-auth.json'),
        sourceAuthFingerprint: 'source-auth-443',
        managedAuthFingerprint: 'managed-auth-443',
        authState: 'ok',
        env: {},
      },
    }
    await this.writeState({ host, managerInvocations: [], creates: [], releases: [] })
  }

  async close(): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  async invokeOneShot(options: { cancelAfterKnownCreate?: string } = {}) {
    const managerId = ++this.nextManagerId
    const controller = new AbortController()
    const manager = new PersistentLaunchManager(
      this,
      managerId,
      `request-${managerId}`,
      controller,
      options.cancelAfterKnownCreate ?? null,
    )
    return manager.execute()
  }

  async sessions(): Promise<OpenCodeSessionRecord[]> {
    return new OpenCodeSessionStore(this.storePath).list()
  }

  async evidence(): Promise<PersistedFakeState> { return this.readState() }

  async readState(): Promise<PersistedFakeState> {
    return JSON.parse(await readFile(this.statePath, 'utf8')) as PersistedFakeState
  }

  async writeState(state: PersistedFakeState): Promise<void> {
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
}
