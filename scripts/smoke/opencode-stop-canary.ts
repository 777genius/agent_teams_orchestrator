import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

type JsonRecord = Record<string, unknown>

const outputPath = process.env.OPENCODE_STOP_CANARY_EVIDENCE_PATH?.trim()
  || path.join(process.cwd(), 'opencode-stop-canary-evidence.json')
const binaryPath = process.env.OPENCODE_BIN?.trim() || 'opencode'
const selectedModel = process.env.OPENCODE_STOP_CANARY_MODEL?.trim() || 'opencode/big-pickle'
const timeoutMs = Number(process.env.OPENCODE_STOP_CANARY_TIMEOUT_MS ?? '30000')
// Canonical checkouts resolve ../claude_team automatically. Worktrees should set
// OPENCODE_STOP_CANARY_CLAUDE_TEAM_ROOT, or override the command and entry directly.
const claudeTeamRoot = process.env.OPENCODE_STOP_CANARY_CLAUDE_TEAM_ROOT?.trim()
  || path.resolve(process.cwd(), '..', 'claude_team')
const appMcpCommand = process.env.OPENCODE_STOP_CANARY_APP_MCP_COMMAND?.trim()
  || path.join(claudeTeamRoot, 'node_modules', '.bin', 'tsx')
const appMcpEntry = process.env.OPENCODE_STOP_CANARY_APP_MCP_ENTRY?.trim()
  || path.join(claudeTeamRoot, 'mcp-server', 'src', 'index.ts')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function buildEnvelope(command: string, cwd: string, body: JsonRecord): JsonRecord {
  return {
    schemaVersion: 1,
    requestId: `stop-canary-${command}-${randomUUID()}`,
    command,
    cwd,
    startedAt: new Date().toISOString(),
    timeoutMs,
    body: { projectPath: cwd, ...body },
  }
}

async function readRegistry(filePath: string): Promise<JsonRecord> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as JsonRecord
  } catch {
    return { schemaVersion: 1, hosts: {} }
  }
}

async function main(): Promise<void> {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'OPENCODE_STOP_CANARY_TIMEOUT_MS must be positive')
  assert(existsSync(appMcpCommand), `Agent Teams MCP command was not found: ${appMcpCommand}`)
  assert(existsSync(appMcpEntry), `Agent Teams MCP entry was not found: ${appMcpEntry}`)
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-stop-canary-'))
  const projectPath = await realpath(path.join(root, 'project').replace(/$/, ''))
    .catch(async () => {
      const candidate = path.join(root, 'project')
      await mkdir(candidate, { recursive: true })
      return realpath(candidate)
    })
  const isolatedHome = path.join(root, 'home')
  const isolatedData = path.join(root, 'managed-data')
  const isolatedCache = path.join(root, 'managed-cache')
  const xdgConfig = path.join(root, 'xdg-config')
  const xdgData = path.join(root, 'xdg-data')
  const xdgCache = path.join(root, 'xdg-cache')
  const xdgState = path.join(root, 'xdg-state')
  await Promise.all(
    [isolatedHome, isolatedData, isolatedCache, xdgConfig, xdgData, xdgCache, xdgState]
      .map(directory => mkdir(directory, { recursive: true })),
  )

  // Singleton paths are resolved at module construction time, so isolate every
  // relevant root before importing production OpenCode services.
  Object.assign(process.env, {
    HOME: isolatedHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_CACHE_HOME: xdgCache,
    XDG_STATE_HOME: xdgState,
    CLAUDE_MULTIMODEL_DATA_HOME: isolatedData,
    CLAUDE_MULTIMODEL_CACHE_HOME: isolatedCache,
    OPENCODE_CONFIG_DIR: path.join(xdgConfig, 'opencode'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_BIN: binaryPath,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: appMcpCommand,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: appMcpEntry,
    AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED: '1',
  })

  const [handlerModule, bridgeModule, hostModule, storeModule, evidenceModule, outcomeModule,
    provisioningModule] =
    await Promise.all([
      import('../../src/services/opencode/OpenCodeBridgeCommandHandler.js'),
      import('../../src/services/opencode/OpenCodeSessionBridge.js'),
      import('../../src/services/opencode/OpenCodeHostManager.js'),
      import('../../src/services/opencode/OpenCodeSessionStore.js'),
      import('../../src/services/opencode/OpenCodeExpectedBehaviorFingerprint.js'),
      import('../../src/services/opencode/OpenCodeCommandOutcomeStore.js'),
      import('../../src/services/opencode/OpenCodeProvisioningProbe.js'),
    ])
  const { executeOpenCodeBridgeCommandEnvelope } = handlerModule
  const { openCodeSessionBridge } = bridgeModule
  const { openCodeHostManager } = hostModule
  const { openCodeSessionStore } = storeModule
  const { buildOpenCodeExpectedBehaviorEvidence } = evidenceModule
  const { openCodeCommandOutcomeStore } = outcomeModule
  const { openCodeProvisioningProbe } = provisioningModule

  const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const teamId = `stop-canary-team-${nonce}`
  const laneId = 'target'
  const runId = `stop-canary-run-${nonce}`
  const members = ['alice', 'bob']
  const controlLease = {
    teamId,
    laneId: 'control',
    memberName: 'control',
    runId: `control-run-${nonce}`,
    sessionId: `control-session-${nonce}`,
  }
  const deliveryRequestId = `pending-delivery-${nonce}`
  const registryPath = path.join(isolatedData, 'opencode', 'host-registry.json')
  const records: Array<any> = []
  let hostKey: string | null = null
  let hostPid: number | null = null
  let finalCleanup: any = null
  let evidence: JsonRecord = {}
  let retainedSetupHost: any = null
  let passed = false
  let controlLeaseReleased = false
  let recoveryCleanup: unknown = null

  try {
    console.error('stage=retain-authoritative-host')
    retainedSetupHost = await openCodeProvisioningProbe.probeRetainingHost(projectPath, {
      selectedModel,
      toolApprovalMode: 'auto',
      leaseId: `stop-canary-${nonce}`,
    })
    const host = retainedSetupHost.host
    assert(host, 'production provisioning probe did not retain a healthy host')
    assert(retainedSetupHost.snapshot.hostHealthy, 'production provisioning snapshot is not healthy')
    hostKey = host.hostKey
    hostPid = host.pid
    assert(hostPid > 0 && isAlive(hostPid), 'owned OpenCode host is not alive before stop')

    const behaviorEvidence = await buildOpenCodeExpectedBehaviorEvidence({
      profile: host.profile,
      fullModelId: selectedModel,
      effectiveConfigFingerprint: host.resolvedConfigFingerprint,
    })
    let authorityRejection: unknown = null
    let refreshedAuthority: unknown = null
    const authorityDeadline = Date.now() + 5_000
    while (!refreshedAuthority && Date.now() < authorityDeadline) {
      refreshedAuthority = await openCodeProvisioningProbe.refreshSelectedProfileAuthority({
        host,
        selectedModel,
        expectedBehaviorFingerprint: behaviorEvidence.expectedBehaviorFingerprint,
        onRejection: diagnostic => { authorityRejection = diagnostic },
      })
      if (!refreshedAuthority) await Bun.sleep(100)
    }
    const liveMcp = await fetch(`${host.baseUrl}/mcp`, {
      signal: AbortSignal.timeout(2_000),
    }).then(response => response.json()).catch(error => ({ error: String(error) }))
    assert(
      refreshedAuthority,
      `production selected authority refresh rejected canary host: ${JSON.stringify({
        authorityRejection,
        probeAppMcp: retainedSetupHost.snapshot.appMcp,
        liveMcp,
      })}`,
    )

    console.error('stage=create-target-sessions')
    const materializeAbort = new AbortController()
    const materializeDeadline = Date.now() + 20_000
    for (const memberName of members) {
      const materialized = await openCodeSessionBridge.materializeSessionOnHost({
        teamId,
        laneId,
        memberName,
        selectedModel,
        title: `${teamId} - ${memberName}`,
        runId,
        toolApprovalMode: 'auto',
        attemptId: `stop-canary-materialize-${memberName}-${nonce}`,
        host,
        signal: materializeAbort.signal,
        remainingMs: () => Math.max(0, materializeDeadline - Date.now()),
        expectedBehaviorFingerprint: behaviorEvidence.expectedBehaviorFingerprint,
        expectedBootstrapForSession: sessionId => ({
          messageID: `stop-canary-bootstrap-${sessionId}`,
          contextHash: behaviorEvidence.expectedBehaviorFingerprint,
          briefingHash: behaviorEvidence.projectBehaviorFingerprint,
          agent: 'teammate-bootstrap',
        }),
      })
      assert(materialized.created, `target ${memberName} was not freshly materialized`)
      if (materialized.ownerToken) {
        const released = await openCodeSessionStore.releaseMaterializationOwner(
          materialized.record,
          materialized.ownerToken,
        )
        assert(released, `target ${memberName} materialization owner was not released`)
      }
      records.push(materialized.record)
    }
    assert(records[0].hostKey === records[1].hostKey, 'target sessions must share one host')
    await retainedSetupHost.release(true)
    retainedSetupHost = null

    await openCodeHostManager.retainHostLease(hostKey, controlLease)
    await openCodeCommandOutcomeStore.upsert({
      requestId: deliveryRequestId,
      deliveryAttemptId: `attempt-${nonce}`,
      status: 'received',
      teamId,
      teamName: teamId,
      laneId,
      memberName: members[0],
      runId,
      projectPath,
      messageId: `message-${nonce}`,
      payloadHash: `fixture-${nonce}`,
      diagnostics: ['pending delivery sentinel - Stop must not mutate this record'],
    })
    const deliveryBefore = await openCodeCommandOutcomeStore.query({ requestId: deliveryRequestId })
    const registryBefore = await readRegistry(registryPath)

    console.error('stage=start-busy-shells')
    const shellStartedAt = Date.now()
    const shellResponses = records.map(async record => {
      const response = await fetch(
        `${host.baseUrl}/session/${encodeURIComponent(record.opencodeSessionId)}/shell`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agent: 'teammate',
            model: { providerID: 'opencode', modelID: selectedModel.slice('opencode/'.length) },
            command: 'sleep 60',
          }),
          signal: AbortSignal.timeout(75_000),
        },
      )
      const responseText = await response.text()
      return { status: response.status, responseText }
    })
    const busyDeadline = Date.now() + 8_000
    let statusBeforeStop: JsonRecord = {}
    while (Date.now() < busyDeadline) {
      statusBeforeStop = await fetch(`${host.baseUrl}/session/status`, {
        signal: AbortSignal.timeout(2_000),
      }).then(response => response.json()) as JsonRecord
      if (records.every(record =>
        (statusBeforeStop[record.opencodeSessionId] as JsonRecord | undefined)?.type === 'busy')) break
      await Bun.sleep(50)
    }
    assert(
      records.every(record =>
        (statusBeforeStop[record.opencodeSessionId] as JsonRecord | undefined)?.type === 'busy'),
      `both target sessions must be busy before Stop: ${JSON.stringify(statusBeforeStop)}`,
    )

    console.error('stage=handshake-stop-authority')
    const handshake: any = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(
      'opencode.handshake',
      projectPath,
      {
        requiredCommand: 'opencode.stopTeam',
        teamId,
        laneId,
        runId,
        expectedCapabilitySnapshotId: 'bootstrap-stop-canary-authority',
      },
    ))
    assert(handshake.ok === true, `stop handshake failed: ${JSON.stringify(handshake.error)}`)
    const capabilitySnapshotId = handshake.data?.server?.runtime?.capabilitySnapshotId
    assert(
      typeof capabilitySnapshotId === 'string' && /^opencode:[a-f0-9]{32}$/.test(capabilitySnapshotId),
      'stop handshake did not return a concrete capability snapshot',
    )

    console.error('stage=execute-production-stop')
    const stopStartedAt = Date.now()
    const stop: any = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(
      'opencode.stopTeam',
      projectPath,
      { teamId, laneId, runId, expectedCapabilitySnapshotId: capabilitySnapshotId },
    ))
    const stopDurationMs = Date.now() - stopStartedAt
    const busyShellElapsedUntilStopMs = Date.now() - shellStartedAt
    const stoppedRecords = await Promise.all(
      members.map(memberName => openCodeSessionStore.get(teamId, laneId, memberName)),
    )
    const registryAfterStop = await readRegistry(registryPath)
    const deliveryAfter = await openCodeCommandOutcomeStore.query({ requestId: deliveryRequestId })
    const settledShellResponses = await Promise.all(shellResponses)
    const statusAfterStop = await fetch(`${host.baseUrl}/session/status`, {
      signal: AbortSignal.timeout(5_000),
    }).then(response => response.json()) as JsonRecord
    const hostRegistryAfter = (registryAfterStop.hosts as JsonRecord | undefined)?.[hostKey] as JsonRecord | undefined
    const leasesAfter = hostRegistryAfter?.leases as JsonRecord | undefined

    const assertions = {
      stopEnvelopeSucceeded: stop.ok === true,
      stopReportedAllTargetsStopped:
        stop.data?.stopped === true
        && members.every(memberName => stop.data?.members?.[memberName]?.stopped === true),
      exactTargetRecordsTerminal: stoppedRecords.every(record =>
        record?.runId === runId
        && typeof record?.stoppedAt === 'string'
        && record?.stopAuthority?.expectedBehaviorFingerprint
          === behaviorEvidence.expectedBehaviorFingerprint),
      targetSessionsAbsentFromStatusMap:
        records.every(record => !(record.opencodeSessionId in statusAfterStop)),
      controlLeasePreserved:
        Boolean(leasesAfter?.[`${teamId}::control::control`]),
      targetLeasesReleased:
        members.every(memberName => !leasesAfter?.[`${teamId}::${laneId}::${memberName}`]),
      sharedHostPreserved: isAlive(hostPid),
      pendingDeliveryUnchanged:
        JSON.stringify(deliveryAfter) === JSON.stringify(deliveryBefore),
      shellRequestsSettledAfterAbort:
        settledShellResponses.every(response =>
          response.status === 200 && response.responseText.includes('User aborted the command')),
      stopCompletedBeforeShellTimer:
        stopDurationMs < 30_000 && busyShellElapsedUntilStopMs < 30_000,
    }
    evidence = {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      binaryPath,
      appMcpCommand,
      appMcpEntry,
      selectedModel,
      isolation: {
        root,
        projectPath,
        home: isolatedHome,
        xdgConfig,
        xdgData,
        xdgCache,
        xdgState,
        managedData: isolatedData,
        managedCache: isolatedCache,
      },
      identity: { teamId, laneId, runId, members, controlLease, hostKey, hostPid },
      setup: {
        mode: 'production retained provisioning plus strict materializeSessionOnHost',
        limitation:
          'The canary intentionally skips strict-launch model execution proof and bootstrap prompt; it validates a real busy shell interruption, Stop transport, exact-session SSE confirmation, store CAS, strict lease release, shared-host preservation, and delivery isolation.',
      },
      behaviorEvidence,
      sessionIds: records.map(record => record.opencodeSessionId),
      statusBeforeStop,
      registryBefore,
      handshake: handshake.data,
      stop: stop.data ?? stop.error,
      stopDurationMs,
      busyShellElapsedUntilStopMs,
      statusAfterStop,
      registryAfterStop,
      stoppedRecords,
      deliveryBefore,
      deliveryAfter,
      settledShellResponses: settledShellResponses.map(response => ({
        status: response.status,
        bodyLength: response.responseText.length,
      })),
      assertions,
    }
    assert(Object.values(assertions).every(Boolean), `Stop canary assertion failed: ${JSON.stringify(assertions)}`)
    console.error('stage=release-control-and-cleanup')
    await openCodeHostManager.releaseHostLease(hostKey, controlLease)
    controlLeaseReleased = true
    finalCleanup = await openCodeHostManager.reconcilePersistentHosts({
      mode: 'stale',
      reason: 'opencode_stop_canary_normal_cleanup',
      projectPath,
      staleAgeMs: 0,
      leaseStaleAgeMs: null,
      preflightLeaseStaleAgeMs: null,
    })
    const hostAliveAfterNormalCleanup = isAlive(hostPid)
    assert(
      finalCleanup.cleaned === 1 && finalCleanup.remaining === 0 && !hostAliveAfterNormalCleanup,
      `normal stale cleanup did not dispose the unleased owned host: ${JSON.stringify(finalCleanup)}`,
    )
    evidence.finalCleanup = finalCleanup
    evidence.hostAliveAfterFinalCleanup = hostAliveAfterNormalCleanup
    passed = true
  } finally {
    await retainedSetupHost?.release(true).catch(() => undefined)
    if (hostKey && !controlLeaseReleased) {
      await openCodeHostManager.releaseHostLease(hostKey, controlLease).catch(() => undefined)
      controlLeaseReleased = true
    }
    for (const record of records) {
      await openCodeSessionBridge.releaseSession(record).catch(() => undefined)
      await openCodeSessionStore.delete(record.teamId, record.laneId, record.memberName)
        .catch(() => undefined)
    }
    if (hostKey && hostPid && isAlive(hostPid)) {
      recoveryCleanup = await openCodeHostManager.reconcilePersistentHosts({
        mode: 'force',
        reason: 'opencode_stop_canary_failure_recovery',
        projectPath,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      }).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
    }
    if (Object.keys(evidence).length > 0) {
      const hostAliveAfterFinalCleanup = hostPid ? isAlive(hostPid) : false
      if (finalCleanup !== null) evidence.finalCleanup = finalCleanup
      if (recoveryCleanup !== null) evidence.recoveryCleanup = recoveryCleanup
      evidence.hostAliveAfterFinalCleanup = hostAliveAfterFinalCleanup
      evidence.passed = passed
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
      if (passed) {
        assert(!hostAliveAfterFinalCleanup, 'owned OpenCode host remained alive after final cleanup')
        console.log(JSON.stringify({
          ok: true,
          evidencePath: outputPath,
          hostPid,
          targetSessionCount: records.length,
          controlLeasePreserved: (evidence.assertions as JsonRecord).controlLeasePreserved,
          pendingDeliveryUnchanged: (evidence.assertions as JsonRecord).pendingDeliveryUnchanged,
          hostCleaned: !hostAliveAfterFinalCleanup,
        }))
      }
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
