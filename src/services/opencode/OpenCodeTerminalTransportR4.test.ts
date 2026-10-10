import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OpenCodePreparedProfile, OpenCodeSessionRecord, OpenCodeProvisioningSnapshot } from './types.js'
import { OpenCodeSessionBridge, openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeCommandOutcomeStore } from './OpenCodeCommandOutcomeStore.js'
import { CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV } from './OpenCodeManagedPaths.js'
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from './OpenCodeRuntimeTurnSettledEmitter.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
const environmentKeys = ['HOME', 'USERPROFILE', 'TMPDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV, 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT',
  'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_CONFIG_CONTENT', 'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_ENVIRONMENT',
  'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_APP_MCP_LAUNCH_CONFIG', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
  'AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS', 'AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH', 'AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED', RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV,
  'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON', 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL'] as const
let originalEnvironment: Record<string, string | undefined>
let root: string
const restores: Array<() => void> = []
beforeEach(async () => {
  root = await mkdtemp(path.join(process.cwd(), 'TEST-O0-r4-env-'))
  originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]))
  for (const key of environmentKeys) delete process.env[key]
  Object.assign(process.env, { HOME: `${root}/home`, USERPROFILE: `${root}/home`, TMPDIR: `${root}/tmp`,
    XDG_DATA_HOME: `${root}/data`, XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`,
    [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: `${root}/data`, [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: `${root}/cache`,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: `${root}/TEST-mcp.ts`, CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath })
  await mkdir(`${root}/project`, { recursive: true })
  process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED = '1'
  process.env.AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS = '4'
  process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV] = `${root}/spool`
  await writeFile(`${root}/TEST-mcp.ts`, '') // Entrypoint discovery only; never executed.
})
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  try { await rm(root, { recursive: true, force: true }) }
  finally { for (const key of environmentKeys) {
    if (originalEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnvironment[key]
  } }
})
function fixtures(scoped = false): { profile: OpenCodePreparedProfile; record: OpenCodeSessionRecord; snapshot: OpenCodeProvisioningSnapshot } {
  const profile: OpenCodePreparedProfile = {
    projectPath: `${root}/project`, canonicalProjectPath: `${root}/project`, workingDirectoryPath: `${root}/project`,
    scopeToken: null, profileRootKey: 'TEST-profile', profileRootPath: `${root}/profile`,
    projectBehaviorFingerprint: 'TEST-behavior', behaviorSources: [], managedConfig: {}, managedConfigFingerprint: 'TEST-config',
    homePath: `${root}/home`, tmpPath: `${root}/tmp`, xdgConfigHome: `${root}/config`, xdgDataHome: `${root}/data`, xdgCacheHome: `${root}/cache`,
    managedAuthPath: `${root}/data/opencode/auth.json`, sourceAuthPath: `${root}/data/opencode/auth.json`,
    sourceAuthFingerprint: 'TEST-auth', managedAuthFingerprint: 'TEST-auth', authState: 'ok', env: {},
    ...(scoped ? { profileScope: { purpose: 'launch_runtime', providerId: 'opencode', scopeToken: 'TEST-scope', configFingerprint: 'TEST-config', selectedAuthIdentity: 'absent' } } : {}),
  }
  const record: OpenCodeSessionRecord = {
    teamId: 'TEST-team', laneId: 'TEST-lane', memberName: 'TEST-member', providerId: 'opencode', selectedModel: 'opencode/TEST-model',
    opencodeSessionId: 'ses_TEST_r4', hostKey: 'TEST-host', profileRootKey: profile.profileRootKey, runId: 'TEST-run',
    projectPath: profile.projectPath, lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: 'unknown',
    sourceAuthFingerprint: 'TEST-auth', managedAuthFingerprint: 'TEST-auth', projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
    resolvedBehaviorFingerprint: 'TEST-config', staleReason: null, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    ...(scoped ? { profileScope: profile.profileScope, toolApprovalMode: 'manual' } : {}),
  }
  const snapshot: OpenCodeProvisioningSnapshot = {
    detected: true, hostHealthy: true, projectPath: profile.projectPath, profile,
    host: { hostKey: record.hostKey, profileRootKey: profile.profileRootKey, projectPath: profile.projectPath,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint, baseUrl: 'http://TEST-injected', port: 0, pid: 123,
      version: '1.18.34', state: 'healthy', profile, resolvedConfigFingerprint: 'TEST-config', diagnostics: [] },
    config: null, configProviders: null, providers: null, providerAuth: null, agents: [], mcp: {},
    appMcp: { serverName: 'agent-teams', matchedServerName: 'agent-teams', status: 'present', connected: true,
      launchSource: 'workspace-src', availableServerNames: ['agent-teams'], diagnostics: [] }, probeError: null, diagnostics: [],
  }
  return { profile, record, snapshot }
}
const promptId = 'msg_TEST_retained'
function wire(sessionId: string, fallback = false) {
  return [{ info: { id: promptId, sessionID: sessionId, role: 'user', time: { created: 1 } }, parts: [] },
    { info: { id: 'msg_TEST_final', parentID: promptId, sessionID: sessionId, role: 'assistant', finish: 'stop', time: { created: 2, completed: 3 } },
      parts: fallback ? [{ id: 'prt_TEST_send', sessionID: sessionId, messageID: 'msg_TEST_final', type: 'tool', callID: 'call_TEST_send', tool: 'agent-teams_message_send',
        state: { status: 'error', input: { relayOfMessageId: 'TEST-inbound', text: 'TEST reply' }, error: 'Not connected', time: { start: 2, end: 3 } } }] : [] }]
}
function actualBridge(input: ReturnType<typeof fixtures>, fetchImpl: typeof fetch, write: () => void) {
  return new OpenCodeSessionBridge({ prepareProfile: async () => input.profile,
    hostManager: { ensureHost: async () => { if (!input.snapshot.host) throw new Error('TEST host missing'); return input.snapshot.host }, releaseHost: async () => {} },
    sessionStore: { get: async () => input.record, upsert: async () => { write(); return 'updated' }, markStale: async () => null },
    clientFactory: new OpenCodeClientFactory({ fetchImpl }),
  })
}
function envelope(command: string, record: OpenCodeSessionRecord, timeoutMs = 120) {
  return { schemaVersion: 1, requestId: 'TEST-request', command, cwd: record.projectPath, startedAt: '2026-10-07T00:00:00Z', timeoutMs,
    body: { teamId: record.teamId, laneId: record.laneId, memberName: record.memberName, runId: record.runId,
      projectPath: record.projectPath, sessionId: record.opencodeSessionId, text: 'TEST retained input', messageId: 'TEST-inbound', runtimePromptMessageId: promptId } }
}
test.each(['valid', 'terminal-deadline', 'terminal-abort'] as const)('direct actual bridge terminal transport %s fences storage and return', async phase => {
  const input = fixtures(), operation = new AbortController()
  let remaining = 1000, writes = 0, messages = 0, projections = 0
  const injected = Object.assign(async (url: RequestInfo | URL): Promise<Response> => {
    const route = new URL(String(url)).pathname
    if (route === '/session/status') return Response.json({ [input.record.opencodeSessionId]: 'idle' })
    if (!route.endsWith('/message')) return Response.json([])
    if (++messages === 2) {
      if (phase === 'terminal-deadline') remaining = 0
      if (phase === 'terminal-abort') operation.abort(new Error('TEST terminal cancellation'))
    }
    return Response.json(wire(input.record.opencodeSessionId))
  }, { preconnect: globalThis.fetch.preconnect })
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(injected); restores.push(() => fetchSpy.mockRestore())
  const translator = openCodeEventTranslator.reconcileSessionMessages.bind(openCodeEventTranslator)
  const projectionSpy = spyOn(openCodeEventTranslator, 'reconcileSessionMessages').mockImplementation(value => { projections++; return translator(value) }); restores.push(() => projectionSpy.mockRestore())
  const bridge = actualBridge(input, injected, () => writes++)
  const pending = bridge.reconcileSession(input.record, { signal: operation.signal, remainingMs: () => remaining, runtimePromptMessageId: promptId, limit: 50 })
  if (phase === 'valid') { const value = await pending; expect(value.summary.terminalEvidence?.complete).toBe(true); expect(writes).toBe(1) }
  else { const outcome = await pending.then(() => ({ resolved: true })).catch(error => ({ resolved: false, error: String(error) })); console.log('R4 direct failure', JSON.stringify({ phase, writes, outcome })); expect(writes).toBe(0); expect(outcome.resolved).toBe(false) }
  expect(messages).toBe(phase === 'valid' ? 3 : 2)
  expect(projections).toBe(phase === 'valid' ? 1 : 0)
  console.log('R4 direct', JSON.stringify({ phase, writes, messages, remaining }))
})

for (const kind of ['send', 'scoped-observe', 'legacy-observe'] as const) {
  test.each(['valid', 'late-deadline', 'caller-abort', 'fallback-valid', 'fallback-deadline', 'fallback-abort'] as const)(`public ${kind} actual transport %s keeps original operation`, async phase => {
    const fallback = phase.startsWith('fallback-')
    const failureRead = fallback ? 5 : 2
    const input = fixtures(kind === 'scoped-observe'), operation = new AbortController()
    const record = input.record
    let writes = 0, submits = 0, messageReads = 0
    const saved: { id: string | null } = { id: null }
    const contexts: Array<NonNullable<Parameters<typeof openCodeSessionBridge.reconcileSession>[1]>> = []
    let recovering = false
    let context: Parameters<typeof openCodeSessionBridge.reconcileSession>[1]
    const requests: string[] = []
    const injected = Object.assign(async (url: RequestInfo | URL): Promise<Response> => {
      const route = new URL(String(url)).pathname; requests.push(route)
      if (route === '/session/status') return Response.json({ [record.opencodeSessionId]: 'idle' })
      if (!route.endsWith('/message')) return Response.json([])
      messageReads++
      if (!recovering && messageReads === failureRead && (phase === 'late-deadline' || phase === 'fallback-deadline') && kind !== 'legacy-observe') {
        if (!context?.remainingMs) throw new Error('TEST missing public original budget')
        while (context.remainingMs() > 0) { /* Expire monotonic budget before its queued timer runs. */ }
      }
      if (!recovering && messageReads === failureRead && (phase === 'caller-abort' || phase === 'fallback-abort') && kind !== 'legacy-observe') operation.abort(new Error('TEST public caller cancelled'))
      const page = wire(record.opencodeSessionId, fallback && messageReads <= 3)
      if (fallback && messageReads > 3) {
        const reply = page[1]; if (!reply) throw new Error('TEST reply missing')
        reply.info.id = 'msg_TEST_recovered'
        return Response.json([...wire(record.opencodeSessionId, true), { ...reply, info: { ...reply.info, time: { created: 4, completed: 5 } }, parts: [{ id: 'prt_TEST_recovered', sessionID: record.opencodeSessionId, messageID: reply.info.id, type: 'text', text: 'TEST recovered response' }] }])
      }
      return Response.json(page)
    }, { preconnect: globalThis.fetch.preconnect })
    // Inject admitted host authority separately; actual reconciliation/client still read the exact public session.
    const transportInput = { ...input, record: { ...record, profileScope: null }, profile: { ...input.profile, profileScope: undefined } }
    const actual = actualBridge(transportInput, injected, () => writes++)
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(injected)
    const get = spyOn(openCodeSessionStore, 'get').mockResolvedValue(record)
    const list = spyOn(openCodeSessionStore, 'list').mockResolvedValue([record])
    const probe = spyOn(openCodeProvisioningProbe, 'probe').mockResolvedValue(input.snapshot)
    const retain = spyOn(openCodeProvisioningProbe, 'probeRetainingHost').mockResolvedValue({ snapshot: input.snapshot, host: input.snapshot.host, release: async () => {} })
    const ready = spyOn(openCodeSessionBridge, 'ensureSessionAppMcpReady').mockResolvedValue({ ok: true, status: 'present', connected: true, diagnostics: [] })
    const refresh = spyOn(openCodeSessionBridge, 'refreshSessionEnvironment').mockImplementation(async value => value)
    const reconcile = spyOn(openCodeSessionBridge, 'reconcileSession').mockImplementation(async (value, options) => { context = options; if (options) contexts.push(options); const result = await actual.reconcileSession({ ...value, profileScope: null }, options); console.log('TEST reconcile', JSON.stringify({ stale: result.summary.staleReason, diagnostics: result.summary.diagnostics })); return result })
    const query = spyOn(openCodeCommandOutcomeStore, 'query').mockResolvedValue({ record: null, diagnostics: [] })
    const outcome = spyOn(openCodeCommandOutcomeStore, 'upsert').mockImplementation(async patch => {
      if (patch.runtimePromptMessageId) saved.id = patch.runtimePromptMessageId
      return { ...patch, schemaVersion: 1, command: 'opencode.sendMessage', requestId: patch.requestId, teamName: patch.teamName ?? null,
        runId: patch.runId ?? null, projectPath: patch.projectPath, messageId: patch.messageId ?? null, payloadHash: patch.payloadHash ?? null,
        safeToRetry: false, sessionId: patch.sessionId ?? null, runtimePid: patch.runtimePid ?? null, prePromptCursor: patch.prePromptCursor ?? null,
        runtimePromptMessageId: patch.runtimePromptMessageId ?? null, acceptedAt: patch.acceptedAt ?? null, turnObservedAt: patch.turnObservedAt ?? null,
        completedAt: patch.completedAt ?? null, error: patch.error ?? null, diagnostics: patch.diagnostics ?? [], createdAt: 'TEST', updatedAt: 'TEST' }
    })
    const prompt = spyOn(openCodeSessionBridge, 'promptAsyncWithTurnSettled').mockImplementation(async (value, options) => {
      submits++
      await options.onPromptSubmitting?.({ sessionId: value.opencodeSessionId, runtimePromptMessageId: promptId, baseUrl: 'http://TEST-injected' })
      await options.onPromptAccepted?.({ sessionId: value.opencodeSessionId, runtimePromptMessageId: promptId })
      const turnSettled = { outcome: 'success' as const, sessionId: value.opencodeSessionId, runtimePromptMessageId: promptId,
        turnId: promptId, endpoint: '/event' as const, streamConnected: true, observedEventCount: 2, matchedEventCount: 2, assistantActivityCount: 1,
        promptPersisted: true, latestEventType: 'session.status', latestAssistantMessageId: 'msg_TEST_final', diagnostics: [] }
      await options.onTurnObserved?.({ sessionId: value.opencodeSessionId, runtimePromptMessageId: promptId, turnSettled })
      return { runtimePromptMessageId: promptId, turnSettled, hookDiagnostics: [] }
    })
    try {
      const result = await executeOpenCodeBridgeCommandEnvelope(envelope(kind === 'send' ? 'opencode.sendMessage' : 'opencode.observeMessageDelivery', record), { signal: operation.signal })
      const stops = await readdir(`${root}/spool/incoming`).catch(() => [])
      console.log('R4 public', JSON.stringify({ kind, phase, ok: result.ok, writes, submits, savedId: saved.id, messageReads,
        remaining: context?.remainingMs?.(), signal: Boolean(context?.signal), Stop: stops.length, requests }))
      expect(messageReads).toBeGreaterThanOrEqual(2)
      if (kind === 'legacy-observe') { expect(context?.signal).toBeUndefined(); expect(context?.remainingMs).toBeUndefined(); expect(result.ok).toBe(true) }
      else { expect(context?.signal).toBeDefined(); expect(context?.remainingMs).toBeDefined() }
      if (phase === 'valid' || phase === 'fallback-valid' || kind === 'legacy-observe') { expect(result.ok).toBe(true); expect(writes).toBe(fallback ? 2 : 1) }
      else { expect(result.ok).toBe(false); expect(writes).toBe(fallback ? 1 : 0); expect(stops).toHaveLength(0) }
      if (fallback) { expect(contexts).toHaveLength(2); expect(contexts[1]?.signal).toBe(contexts[0]?.signal); expect(messageReads).toBeGreaterThanOrEqual(5) }
      expect(submits).toBe(kind === 'send' ? 1 : 0)
      if (kind === 'send') {
        expect(saved.id).toBe(promptId)
        if (phase !== 'valid' && phase !== 'fallback-valid') {
          recovering = true
          const recoveryEnvelope = envelope('opencode.observeMessageDelivery', record)
          recoveryEnvelope.body.runtimePromptMessageId = saved.id ?? ''
          const recovered = await executeOpenCodeBridgeCommandEnvelope(recoveryEnvelope, { signal: new AbortController().signal })
          expect(recovered.ok).toBe(true)
          expect(submits).toBe(1)
          expect(saved.id).toBe(promptId)
          expect(await readdir(`${root}/spool/incoming`).catch(() => [])).toHaveLength(0)
          if (!('data' in recovered) || !('responseObservation' in recovered.data) || !recovered.data.responseObservation) throw new Error('TEST missing recovery observation')
          expect(recovered.data.responseObservation.deliveredUserMessageId).toBe(promptId)
        }
      }
    } finally {
      for (const spy of [fetchSpy, get, list, probe, retain, ready, refresh, reconcile, query, outcome, prompt]) spy.mockRestore()
      await rm(`${root}/spool`, { recursive: true, force: true })
    }
  })
}
