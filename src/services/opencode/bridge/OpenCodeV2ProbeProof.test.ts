import { expect, test } from 'bun:test'

// The endpoint stub is confined to a child, so it cannot replace the registered
// lease boundary in other tests. No native server, model or real auth is used.
for (const pin of ['2.0.0', '2.0.21'] as const) {
  test(`${pin} original native terminal cuts preserve probe failures and success`, async () => {
    const script = `
      import { mock } from 'bun:test'
      import assert from 'node:assert/strict'
      import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
      import path from 'node:path'
      import os from 'node:os'
      import { createHash } from 'node:crypto'
      const pin = ${JSON.stringify(pin)}
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-probe-cut-')))
      Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root })
      const project = path.join(root, 'project'), data = path.join(root, 'data/opencode')
      await mkdir(project); await mkdir(data, { recursive: true })
      const authPath = path.join(data, 'auth.json')
      await writeFile(authPath, '{}', { mode: 0o600 })
      const host = { generation: 'v2', pin, dialect: 'v2-' + pin,
        graphSha256: 'a'.repeat(64), selectedCli: { path: path.join(root, 'TEST-binary'), sha256: 'a'.repeat(64), version: pin },
        child: { pid: 42, birth: { format: 'utc-ms', value: '42', bootId: null }, executablePath: '/TEST-bun', sha256: 'a'.repeat(64) },
        hostInstanceId: 'TEST-host', profileEpoch: 'TEST-epoch', profileRoot: root,
        directory: project, leaseOwnerId: 'TEST-owner' }
      const endpointModule = ${JSON.stringify(import.meta.resolve('../host/OpenCodeV2ExecutionHost.ts'))}
      const endpoints = await import(endpointModule)
      mock.module(endpointModule, () => ({ ...endpoints, requireExecutionEndpoint: authority => {
        assert.equal(authority, host)
        return { baseUrl: 'http://127.0.0.1:1', nativePID: 42 }
      } }))
      const { executionHash } = await import(${JSON.stringify(import.meta.resolve('../execution/OpenCodeV2ExecutionContracts.ts'))})
      const { readOriginalTerminal, isOriginalTerminalProof, requireOriginalTerminalCut } = await import(${JSON.stringify(import.meta.resolve('../execution/OpenCodeV2TerminalSettlement.ts'))})
      const { captureOwnedV2ProbeAuthority, buildOwnedV2ProbeProof } = await import(${JSON.stringify(import.meta.resolve('./OpenCodeV2ProbeProof.ts'))})
      const { parseOpenCodeExecutionProof } = await import(${JSON.stringify(import.meta.resolve('../OpenCodeExecutionProof.ts'))})
      const authority = { host, teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'probe',
        sessionID: 'ses_TESToriginal', agent: 'build', model: { providerID: 'test-provider', id: 'test-model', variant: 'default' } }
      const intent = { identity: { requestId: 'TEST-request', deliveryAttemptId: 'TEST-attempt', localMessageId: 'TEST-local', nativeInputID: 'msg_TESTinput' },
        delivery: 'queue', input: { nativeInputID: 'msg_TESTinput', text: 'Output the TEST readiness token', resume: true } }
      const profile = { projectPath: project, canonicalProjectPath: project, workingDirectoryPath: project, scopeToken: null,
        profileRootKey: 'TEST-profile', profileRootPath: root, projectBehaviorFingerprint: 'b'.repeat(64), behaviorSources: [],
        managedConfig: {}, managedConfigFingerprint: executionHash({}), homePath: root, tmpPath: root,
        xdgConfigHome: root, xdgDataHome: root, xdgCacheHome: root, managedAuthPath: authPath,
        sourceAuthPath: null, sourceAuthFingerprint: null, managedAuthFingerprint: createHash('sha256').update('{}').digest('hex'),
        authState: 'missing', env: {} }
      const expectedText = 'TEST_READY_EXACT'
      const rawError = { type: 'provider.auth', message: 'TEST_RAW_SECRET_MUST_NOT_ESCAPE', body: 'TEST_RAW_PROVIDER_BODY' }
      function fixture(state) {
        const id = authority.sessionID, userID = intent.identity.nativeInputID
        const event = (type, seq, extra = {}) => ({ id: 'evt_TEST' + seq, type, seq, aggregateID: id, data: { sessionID: id, ...extra } })
        const events = [event('session.created', 1), event('session.inbox.enqueued', 2,
          { inboxID: userID, item: { type: 'user', delivery: 'queue', payload: { text: intent.input.text } } }),
          event('session.execution.started', 3), event('session.inbox.delivered', 4, { inboxID: userID })]
        const messages = [{ id: userID, type: 'user', timeCreated: 1, data: { id: userID, type: 'user', text: intent.input.text } }]
        if (state === 'cancelled') {
          events.push(event('session.execution.interrupted', 5, { reason: 'interrupt' }))
        } else {
          events.push(event('session.step.started', 5, { assistantMessageID: 'msg_TESTassistant', agent: authority.agent, model: authority.model }))
          const assistant = { id: 'msg_TESTassistant', type: 'assistant', agent: authority.agent, model: authority.model,
            time: { created: 1, completed: 2 }, content: [] }
          if (state === 'failed') {
            assistant.error = rawError
            events.push(event('session.step.failed', 6, { assistantMessageID: assistant.id, error: rawError }),
              event('session.execution.failed', 7, { error: rawError }))
          } else {
            assistant.finish = 'stop'; assistant.content = [{ type: 'text', text: expectedText }]
            events.push(event('session.text.ended', 6, { assistantMessageID: assistant.id, text: expectedText }),
              event('session.step.ended', 7, { assistantMessageID: assistant.id, finish: 'stop' }), event('session.execution.succeeded', 8))
          }
          messages.push({ id: assistant.id, type: 'assistant', timeCreated: 1, data: assistant })
        }
        if (pin === '2.0.21') messages.push({ id: events.at(-1).id.replace(/^evt_/, 'msg_'), type: 'idle', timeCreated: 1,
          data: { outcome: state === 'cancelled' ? 'interrupted' : state } })
        const log = { synced: true, watermark: events.at(-1).seq, events }
        const client = { authority: host, getSession: async () => ({ id, directory: project, agent: authority.agent, model: authority.model }),
          config: async () => [{ type: 'document', info: {} }], log: async () => structuredClone(log),
          messages: async (_id, cursor) => cursor === undefined
            ? { data: structuredClone(messages), previous: 'TEST-newest', next: 'TEST-oldest' } : { data: [], previous: null, next: null } }
        const admission = { identity: intent.identity, payloadHash: executionHash(intent), authority, state: 'accepted', disposition: 'accepted',
          returnedInboxID: userID, projectedUserID: userID, nativePayloadHash: executionHash({ text: intent.input.text }),
          beforeCursor: 1, beforeUserIDs: [], cursor: 4, complete: true, revision: 1 }
        return { client, admission, log, messages }
      }
      let cases = 0
      try {
        const captured = await captureOwnedV2ProbeAuthority(fixture('failed').client, profile)
        const build = f => buildOwnedV2ProbeProof({ client: f.client, authority, captured, intent, admission: f.admission,
          expectedText, capabilitySnapshotId: 'TEST-capability' })
        for (const [state, failure] of [['failed', 'native_execution_failed'], ['cancelled', 'native_execution_cancelled']]) {
          const f = fixture(state), terminal = await readOriginalTerminal(f.client, authority, intent, f.admission)
          assert.equal(isOriginalTerminalProof(terminal), true)
          assert.equal(terminal.state, state); assert.equal(requireOriginalTerminalCut(terminal).log.watermark, f.log.watermark)
          const result = await build(f)
          assert.deepEqual(result, { proof: null, failure })
          assert.ok(!JSON.stringify(result).includes('TEST_RAW_')); cases++
        }
        const success = await build(fixture('succeeded'))
        assert.equal(success.failure, null); assert.equal(success.proof.modelId, 'test-provider/test-model')
        assert.equal(success.proof.projectPath, project); assert.equal(success.proof.opencodeVersion, pin)
        assert.equal(success.proof.capabilitySnapshotId, 'TEST-capability')
        assert.deepEqual(parseOpenCodeExecutionProof(success.proof), success.proof); cases++
        const unrelated = fixture('failed')
        unrelated.admission.authority = { ...authority, runId: 'TEST-unrelated-run' }
        await assert.rejects(build(unrelated), /terminal_authority_conflict/); cases++
        const foreignSession = fixture('failed')
        foreignSession.log.events.at(-1).aggregateID = 'ses_TESTforeign'
        await assert.rejects(build(foreignSession), /incomplete_log/); cases++
        const foreignModel = fixture('failed')
        foreignModel.messages[1].data.model = { ...authority.model, id: 'test-other-model' }
        await assert.rejects(build(foreignModel), /terminal_assistant_selection_changed/); cases++
        const incomplete = fixture('failed')
        incomplete.log.events.pop(); incomplete.log.watermark = incomplete.log.events.at(-1).seq
        assert.deepEqual(await build(incomplete), { proof: null, failure: null }); cases++
        const mutable = fixture('failed'); let reads = 0
        mutable.client.log = async () => { const log = structuredClone(mutable.log)
          if (++reads > 1) log.events.at(-1).data.error = { type: 'provider.other', message: 'TEST-changed-cut' }
          return log }
        await assert.rejects(build(mutable), /mutable_readback/); cases++
        await assert.rejects(buildOwnedV2ProbeProof({ client: fixture('failed').client, authority,
          captured: structuredClone(captured), intent, admission: fixture('failed').admission, expectedText,
          capabilitySnapshotId: 'TEST-capability' }), /probe_capture_not_owned/); cases++
        if (pin === '2.0.21') {
          const missingIdle = fixture('failed'); missingIdle.messages.pop()
          assert.deepEqual(await build(missingIdle), { proof: null, failure: null }); cases++
        }
      } finally { await rm(root, { recursive: true, force: true }) }
      console.log(JSON.stringify({ pin, cases, fixtureRemoved: true }))
    `
    const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } })
    const [exit, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({ pin, cases: pin === '2.0.21' ? 10 : 9, fixtureRemoved: true })
  }, 15_000)
}
