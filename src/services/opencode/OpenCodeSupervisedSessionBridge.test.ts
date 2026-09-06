import { describe, expect, test } from 'bun:test'
import { writeFile } from 'node:fs/promises'
import { canonicalHostedApprovalDigest, canonicalHostedApprovalJson, OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeSessionBridge, OpenCodePermissionEffectNotAuthorizedError,
  OpenCodePermissionEffectUnavailableError } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { supervisedFixture, supervisedLease } from './OpenCodeSupervisedCustody.test-fixture.js'
import type { OpenCodeSessionRecord } from './types.js'

function sessionRecord(fixture: Awaited<ReturnType<typeof supervisedFixture>>, hostKey: string): OpenCodeSessionRecord {
  return {
    teamId: supervisedLease.teamId, laneId: supervisedLease.laneId, memberName: supervisedLease.memberName,
    runId: supervisedLease.runId, opencodeSessionId: supervisedLease.sessionId,
    providerId: 'opencode', selectedModel: 'test/model', toolApprovalMode: 'manual',
    hostKey, profileRootKey: fixture.profile.profileRootKey, projectPath: fixture.profile.projectPath,
    openCodeArtifactDigest: `sha256:${fixture.expected.executable.sha256}`,
    projectBehaviorFingerprint: fixture.profile.projectBehaviorFingerprint,
    managedConfigFingerprint: fixture.profile.managedConfigFingerprint,
    sourceAuthFingerprint: fixture.profile.sourceAuthFingerprint, managedAuthFingerprint: fixture.profile.managedAuthFingerprint,
    resolvedBehaviorFingerprint: fixture.expected.profile.resolvedConfigFingerprint,
    lastCanonicalCursor: null, lastKnownRawStatus: null, lastKnownDurableState: null,
    staleReason: null, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
  }
}

describe.skipIf(process.platform !== 'linux')('OpenCode supervised session bridge', () => {
  test('snapshots the session and bound dependencies while host acquisition awaits health', async () => {
    let healthStarted!: () => void
    let releaseHealth!: () => void
    const started = new Promise<void>(resolve => { healthStarted = resolve })
    const healthGate = new Promise<void>(resolve => { releaseHealth = resolve })
    const fixture = await supervisedFixture({ handle(request, response) {
      if (request.url === '/global/health') {
        healthStarted(); void healthGate.then(() => response.end('{"healthy":true}')); return
      }
      const result = request.url === '/agent' ? [] : request.url?.endsWith('/abort') ? true :
        request.url?.endsWith('hosted-approval-capability') ? fixture.expected.hosted : {}
      response.end(canonicalHostedApprovalJson(result))
    } })
    try {
      const custody = await fixture.acquire()
      const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
      const manager = new OpenCodeHostManager({ acquisitionPolicy })
      const factory = new OpenCodeClientFactory({ acquisitionPolicy })
      const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/sessions.json`)
      const deps = { acquisitionPolicy, hostManager: manager, clientFactory: factory, sessionStore: store }
      const bridge = new OpenCodeSessionBridge(deps)
      const record = sessionRecord(fixture, custody.hostKey)
      const pending = bridge.abort(record)
      await started
      record.opencodeSessionId = 'ses_substituted'
      record.memberName = 'substituted'
      deps.hostManager = new OpenCodeHostManager()
      deps.clientFactory = new OpenCodeClientFactory({ fetchImpl: async () => { throw new Error('substituted') } })
      expect(Reflect.set(manager, 'ensureHost', async () => { throw new Error('substituted') })).toBe(false)
      expect(Reflect.set(factory, 'create', () => { throw new Error('substituted') })).toBe(false)
      releaseHealth()
      await expect(pending).resolves.toBe(true)
      expect(fixture.requests.at(-1)!.url).toBe('/session/ses_test/abort')
      expect(fixture.connections.some(connection => Buffer.concat(connection.chunks).includes(Buffer.from('ses_substituted')))).toBe(false)
      const before = fixture.requests.length
      await expect(bridge.reconcileSession(sessionRecord(fixture, custody.hostKey), { sessionId: 'ses_unadmitted' }))
        .rejects.toThrow('not the admitted session')
      expect(fixture.requests).toHaveLength(before)
      await bridge.releaseSession(sessionRecord(fixture, custody.hostKey))
    } finally { releaseHealth?.(); await fixture.close() }
  }, 120_000)

  for (const mode of ['success', 'profile-rotation', 'session-rotation'] as const) {
    test(`actual supervised observe/reply preserves final fences: ${mode}`, async () => {
      const raw = { id: 'per_test', sessionID: 'ses_test', permission: 'bash', patterns: ['echo test'],
        always: [], metadata: {} }
      const permission = { requestId: raw.id, sessionId: raw.sessionID,
        sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
        requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
        permissionDigest: canonicalHostedApprovalDigest(raw), rawPermission: raw }
      const fixture = await supervisedFixture({ handle(request, response) {
        const hosted = fixture.expected.hosted
        const runtime = { schemaVersion: hosted.schemaVersion, protocol: hosted.protocol,
          runtimeInstanceId: hosted.runtimeInstanceId, configGeneration: hosted.configGeneration }
        const result = request.url === '/global/health' ? { healthy: true } :
          request.url === '/agent' ? [] : request.url?.endsWith('hosted-approval-capability') ? hosted :
          request.url?.endsWith('/permissions') ? { ...runtime, sessionId: raw.sessionID, permissions: [permission] } :
          request.url?.endsWith('/reply') ? { ...runtime, status: 'applied', requestId: raw.id, sessionId: raw.sessionID,
            sessionIncarnation: permission.sessionIncarnation, requestIncarnation: permission.requestIncarnation,
            permissionDigest: permission.permissionDigest, decision: 'allow_once' } : {}
        response.end(canonicalHostedApprovalJson(result))
      } })
      let release!: () => void
      try {
        const custody = await fixture.acquire()
        const acquisitionPolicy = { mode: 'supervisor-adopt-only' as const, custody }
        const manager = new OpenCodeHostManager({ acquisitionPolicy })
        const store = new OpenCodeSessionStore(`${fixture.profile.profileRootPath}/sessions.json`)
        const bridge = new OpenCodeSessionBridge({ acquisitionPolicy, hostManager: manager,
          clientFactory: new OpenCodeClientFactory({ acquisitionPolicy }), sessionStore: store })
        const record = sessionRecord(fixture, custody.hostKey)
        await store.upsert(record)
        const [observed] = await bridge.observeHostedApprovalPermissions(record)
        expect(observed!.permission).toEqual(permission)
        let prepared!: () => void
        const ready = new Promise<void>(resolve => { prepared = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        const params = {
          requestId: raw.id, decision: 'allow' as const, requireAtomicConfigReply: true,
          expectedPermissionRaw: raw, expectedHostedPermission: observed!,
          validatePreparedEffect: async ({ record: snapshot }: { record: OpenCodeSessionRecord }) =>
            store.prepareEffectToken(snapshot.teamId, snapshot.laneId!, snapshot.memberName, snapshot),
          authorizeEffect: async ({ record: snapshot }: { record: OpenCodeSessionRecord }) => {
            expect(Reflect.set(snapshot, 'opencodeSessionId', 'ses_callback_substitution')).toBe(false)
            prepared(); await gate
            return custody.prepareLeaseToken({ ...supervisedLease })
          },
        }
        const pending = bridge.answerPermission(record, params).then(value => ({ value }), error => ({ error }))
        await ready
        if (mode === 'profile-rotation') await writeFile(fixture.profile.managedAuthPath, 'rotated')
        if (mode === 'session-rotation') await store.upsert({ ...record, opencodeSessionId: 'ses_recreated' })
        record.opencodeSessionId = 'ses_caller_substitution'
        params.requestId = 'per_caller_substitution'
        release()
        const result = await pending
        const posts = fixture.requests.filter(request => request.url.endsWith('/reply'))
        if (mode === 'success') {
          expect('value' in result && result.value).toMatchObject({ status: 'applied', sessionId: 'ses_test', requestId: 'per_test' })
          expect(posts).toHaveLength(1)
          expect(Object.keys(JSON.parse(posts[0]!.body.toString()))).toHaveLength(10)
        } else {
          expect('error' in result && result.error).toBeInstanceOf(mode === 'profile-rotation'
            ? OpenCodePermissionEffectNotAuthorizedError : OpenCodePermissionEffectUnavailableError)
          expect(posts).toHaveLength(0)
          await Promise.all(fixture.connections.map(connection => connection.closed))
          const wire = Buffer.concat(fixture.connections.flatMap(connection => connection.chunks)).toString()
          expect(wire).not.toContain('POST ')
        }
        for (const request of fixture.requests) {
          expect(request.headers.authorization).toBe(`Basic ${Buffer.from('opencode:fixture-secret').toString('base64')}`)
        }
        expect(fixture.observations.filter(observation => observation.phase === 'response')
          .every(observation => observation.peerOperationNonce === null && observation.correlation === 'unavailable')).toBe(true)
        await bridge.releaseSession(sessionRecord(fixture, custody.hostKey))
      } finally { release?.(); await fixture.close() }
    }, 120_000)
  }
})
