import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Opt-in protocol1 team E2E, using genuine native processes, sessions and proof.
 * TEST_OPENCODE_V2_NATIVE_BINARY=/absolute/path/to/opencode bun scripts/opencode-v2-team-native-e2e.ts
 * Optional: TEST_EVIDENCE_DIR=/absolute/output, TEST_KEEP_NATIVE_PROFILES=1.
 * Only the model HTTP and controller MCP peers are fixtures. Public production
 * readiness/launch/send/observe/transcript/stop use their normal implementations.
 * This covers the runtime protocol boundary; it does not drive the desktop UI or
 * the app's adapter/command-lease store, or claim a live external Zen response.
 */
const repo = process.env.TEST_RUNTIME_REPO ?? path.resolve(import.meta.dir, '..')
const binary = process.env.TEST_OPENCODE_V2_NATIVE_BINARY
assert(binary && path.isAbsolute(binary), 'Set TEST_OPENCODE_V2_NATIVE_BINARY to a genuine supported CLI')
assert.equal(process.platform, 'linux', 'This opt-in lane verifies Linux process-group retirement')
const load = (relative: string) => import(pathToFileURL(path.join(repo, relative)).href)
const modelId = 'opencode/big-pickle', upstreamModel = 'TEST-team-native-upstream'
const evidenceDirectory = process.env.TEST_EVIDENCE_DIR
const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 })
const read = (file: string) => readFile(file, 'utf8').then(JSON.parse)

if (process.argv[2] !== 'child') {
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const { createOpenCodeV2ReadRoots } = await load('src/services/opencode/profile/OpenCodeV2ManagedConfig.ts')
  const roots = await createOpenCodeV2ReadRoots()
  const project = path.join(roots.root, 'TEST-team-project'), fixtureFile = path.join(roots.root, 'TEST-team-fixture.json')
  const nonce = crypto.randomUUID()
  const fixture = { project, root: roots.root, teamId: `TEST-native-team-${nonce}`, runId: crypto.randomUUID(), laneId: 'primary',
    members: ['TEST-alpha', 'TEST-beta'].map(name => ({ name, messageId: crypto.randomUUID(), replyId: crypto.randomUUID(),
      bootstrap: `TEST_BOOTSTRAP_${name}_${nonce}`, reply: `TEST_NATIVE_REPLY_${name}_${nonce}` })) }
  await mkdir(project)
  const gitBinary = Bun.which('git'); assert(gitBinary, 'Install git for the isolated TEST project')
  const git = Bun.spawn([gitBinary, 'init', '--quiet', project], { env: roots.env, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await git.exited, 0)
  await save(fixtureFile, fixture)
  const requests: any[] = [], fixtureFailures: string[] = [], mcpCalls: any[] = [], mcpMethods: Record<string, number> = {}
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/mcp') {
        if (request.method !== 'POST') return new Response(null, { status: request.method === 'GET' ? 405 : 200 })
        const body: any = await request.json()
        mcpMethods[body.method ?? 'unknown'] = (mcpMethods[body.method ?? 'unknown'] ?? 0) + 1
        if (body.id === undefined) return new Response(null, { status: 202 })
        let result: unknown
        if (body.method === 'initialize') result = { protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} }, serverInfo: { name: 'TEST-native-team-controller', version: '1' } }
        else if (body.method === 'tools/list') result = { tools: [{ name: 'message_send', description: 'Deliver a TEST member reply to the fixture controller.',
          inputSchema: { type: 'object', properties: Object.fromEntries(['teamName', 'from', 'to', 'text', 'messageId', 'relayOfMessageId'].map(key => [key, { type: 'string' }])),
            required: ['teamName', 'from', 'to', 'text', 'messageId', 'relayOfMessageId'], additionalProperties: false } }] }
        else if (body.method === 'ping') result = {}
        else if (body.method === 'tools/call') {
          assert.equal(body.params?.name, 'message_send')
          const input = body.params.arguments
          const member = fixture.members.find(row => row.name === input.from); assert(member)
          assert.deepEqual(input, { teamName: fixture.teamId, from: member.name, to: 'user', text: member.reply,
            messageId: member.replyId, relayOfMessageId: member.messageId })
          assert(!mcpCalls.some(row => row.from === member.name), 'Native delivery may not duplicate the controller effect')
          mcpCalls.push(input)
          // This is the controller peer's synthetic business response, never a
          // native session, execution proof, owner, admission or cleanup receipt.
          result = { content: [{ type: 'text', text: JSON.stringify({ accepted: true, deliveredToInbox: true,
            message: { messageId: member.replyId, relayOfMessageId: member.messageId, text: member.reply } }) }] }
        } else throw new Error(`Unexpected MCP ${body.method}`)
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }
      assert.equal(url.pathname, '/v1/chat/completions'); assert.equal(request.method, 'POST')
      assert.equal(request.headers.get('authorization'), 'Bearer public')
      assert.equal(request.headers.get('x-opencode-client'), 'agent-teams-execution')
      const body: any = await request.json(); assert.equal(body.stream, true)
      const messages = JSON.stringify(body.messages), tools: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name).sort()
      const title = messages.includes('Reply with only the title.')
      let kind: 'title' | 'readiness' | 'member-tool' | 'member-terminal', member: typeof fixture.members[number] | undefined
      let content: string | undefined, toolCall: unknown
      if (title) {
        kind = 'title'; content = 'TEST native team'
        assert(requests.filter(row => row.kind === 'title').length < 2, 'At most one genuine automatic title per team member')
      } else {
        assert.equal(body.model, upstreamModel)
        for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'shell']) assert(tools.includes(name), `Missing native standard tool ${name}`)
        assert(!tools.includes('question'), 'Unattended proof and team must disable question')
        const controllerTool = tools.find(name => name.endsWith('_message_send')); assert(controllerTool)
        const tokens = messages.match(/STRICT_LAUNCH_[0-9a-f-]{36}/g) ?? []
        if (tokens.length) {
          kind = 'readiness'; content = tokens.at(-1)
          assert.equal(requests.filter(row => row.kind === 'readiness').length, 0, 'Launch may only reuse its original unattended proof')
        } else {
          member = fixture.members.find(row => messages.includes(`TEST_TEAM_TURN:${row.name}:${row.messageId}`)); assert(member)
          assert(messages.includes(member.bootstrap), 'Actual model input must include the verified member bootstrap')
          const toolResults = body.messages.filter((row: any) => row.role === 'tool')
          if (toolResults.length) {
            kind = 'member-terminal'; content = member.reply
            assert.equal(toolResults.length, 1)
            assert(JSON.stringify(toolResults[0]).includes(member.replyId), 'Native must return the actual MCP reply to its model')
            assert(mcpCalls.some(row => row.from === member!.name))
          } else {
            kind = 'member-tool'
            toolCall = { index: 0, id: `call_TEST_${member.name}`, type: 'function', function: { name: controllerTool,
              arguments: JSON.stringify({ teamName: fixture.teamId, from: member.name, to: 'user', text: member.reply,
                messageId: member.replyId, relayOfMessageId: member.messageId }) } }
          }
          assert(!requests.some(row => row.kind === kind && row.member === member!.name), 'Same member input may not replay')
        }
      }
      requests.push({ kind, member: member?.name ?? null, model: body.model, stream: true, publicSentinel: true,
        client: request.headers.get('x-opencode-client'), tools })
      const id = `chatcmpl_TEST_${requests.length}`
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      const chunks = [chunk({ role: 'assistant' }), chunk(toolCall ? { tool_calls: [toolCall] } : { content }),
        chunk({}, toolCall ? 'tool_calls' : 'stop'), { id, object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }]
      return new Response(chunks.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    } catch (error) { fixtureFailures.push(String(error)); return new Response('TEST fixture mismatch', { status: 400 }) }
  } })
  const url = `http://127.0.0.1:${server.port}`
  const config = { model: modelId, provider: { opencode: { options: { baseURL: `${url}/v1` }, models: { 'big-pickle': {
    id: upstreamModel, name: 'TEST native team', cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 16384, output: 512 },
  } } } } }
  const env = { ...roots.env, NODE_ENV: 'test', TEST_RUNTIME_REPO: repo, TEST_OPENCODE_V2_NATIVE_BINARY: binary,
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binary, CLAUDE_MULTIMODEL_DATA_HOME: path.join(roots.root, 'data/runtime'),
    CLAUDE_MULTIMODEL_CACHE_HOME: path.join(roots.root, 'cache/runtime'), CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: `${url}/mcp`,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }
  const children: any[] = []
  const run = async (stage: string) => {
    const child = Bun.spawn([process.execPath, import.meta.path, 'child', fixtureFile, stage], { cwd: project, env, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), stage === 'stop' ? 120_000 : 300_000)
    const pipe = async (stream: ReadableStream<Uint8Array>, target: typeof process.stdout) => {
      const reader = stream.getReader(), decoder = new TextDecoder(); let tail = ''
      for (;;) { const row = await reader.read(); if (row.done) break; const value = decoder.decode(row.value); tail = (tail + value).slice(-20000); target.write(value) }
      return tail
    }
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, pipe(child.stdout, process.stdout), pipe(child.stderr, process.stderr)])
      children.push({ stage, code, stdout, stderr }); assert.equal(code, 0, `TEST native team ${stage} child`)
    } finally { clearTimeout(timer) }
  }
  let success = false, failure: unknown, stopFailure: unknown
  try {
    await run('launch')
    assert.equal(requests.length, 1, 'Session creation and silent bootstrap must not infer')
    assert.equal(requests[0].kind, 'readiness'); assert.equal(mcpCalls.length, 0)
    await run('interact') // Separate controller process; it can only rediscover original ownership.
    assert.equal(requests.filter(row => row.kind === 'readiness').length, 1)
    assert.equal(requests.filter(row => row.kind === 'member-tool').length, 2)
    assert.equal(requests.filter(row => row.kind === 'member-terminal').length, 2)
    assert.equal(mcpCalls.length, 2); assert.equal(fixtureFailures.length, 0)
  } catch (error) { failure = error }
  finally {
    try { await run('stop') } catch (error) { stopFailure = error }
    await server.stop(true)
    success = failure === undefined && stopFailure === undefined && fixtureFailures.length === 0
    const stages = Object.fromEntries(await Promise.all(['launch', 'interact', 'stop'].map(async stage =>
      [stage, await read(path.join(roots.root, `TEST-${stage}-result.json`)).catch(() => null)])))
    if (evidenceDirectory) await save(path.join(evidenceDirectory, 'team-native-proof.json'), { success,
      sourceHead: process.env.PR_HEAD_SHA ?? process.env.GITHUB_SHA ?? null, bunVersion: Bun.version,
      boundary: 'runtime-protocol1-real-native-with-loopback-model-and-MCP', root: roots.root, fixture,
      requests, mcpCalls, mcpMethods, fixtureFailures, children, stages,
      failure: failure ? String(failure) : null, stopFailure: stopFailure ? String(stopFailure) : null })
    const retained = !success || process.env.TEST_KEEP_NATIVE_PROFILES === '1'
    if (!retained) await roots.remove()
    console.log(JSON.stringify({ event: 'TEST-native-team-complete', success, root: roots.root, retained,
      modelRequests: requests.length, mcpCalls: mcpCalls.length, fixtureFailures }))
  }
  if (failure) throw failure
  if (stopFailure) throw stopFailure
  assert(success)
} else {
  const fixture = await read(process.argv[3]!), stage = process.argv[4]!
  const { project, root, teamId, runId, laneId } = fixture
  const { executeSelectedOpenCodeBridgeCommandEnvelope } = await load('src/services/opencode/bridge/OpenCodeV2TeamBridge.ts')
  const { executeOpenCodeBridgeCommandEnvelope, createBridgeServerIdentity } = await load('src/services/opencode/OpenCodeBridgeCommandHandler.ts')
  const { discoverOpenCodeV2Run, readOpenCodeV2RunStop, requestOpenCodeV2Run } = await load('src/services/opencode/bridge/OpenCodeV2RunControl.ts')
  const { resolveClaudeMultimodelPaths } = await load('src/services/opencode/OpenCodeManagedPaths.ts')
  const dataRoot = resolveClaudeMultimodelPaths().data
  const client = { ...createBridgeServerIdentity(null), peer: 'claude_team' }
  const common = { teamId, teamName: teamId, runId, laneId, projectPath: project, selectedModel: modelId,
    skipPermissions: true, toolApprovalMode: 'auto', effort: 'default' }
  const envelope = (command: string, body: Record<string, unknown> = {}, timeoutMs = 30_000) => ({ schemaVersion: 1,
    requestId: crypto.randomUUID(), command, cwd: project, startedAt: new Date().toISOString(), timeoutMs, body: { ...common, ...body } })
  const execute = (value: unknown) => executeSelectedOpenCodeBridgeCommandEnvelope(value, executeOpenCodeBridgeCommandEnvelope)
  const call = async (value: unknown): Promise<any> => {
    const result = await execute(value); assert.equal(result.ok, true, JSON.stringify(result)); return result
  }
  const preconditions = (handshake: any) => ({ handshakeIdentityHash: handshake.identityHash, laneId, expectedRunId: runId,
    expectedCapabilitySnapshotId: handshake.server.runtime.capabilitySnapshotId,
    expectedBehaviorFingerprint: handshake.expectedBehaviorFingerprint, expectedManifestHighWatermark: null,
    // These are caller-owned lease/correlation IDs, not runtime execution evidence.
    commandLeaseId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() })
  const resultFile = path.join(root, `TEST-${stage}-result.json`)
  if (stage === 'launch') {
    const readiness = await call(envelope('opencode.readiness', { client, requireExecutionProbe: true,
      freshExecutionProofRequestId: crypto.randomUUID() }, 150_000))
    await save(resultFile, { readiness })
    assert.equal(readiness.data.state, 'ready'); assert.equal(readiness.data.launchAllowed, true)
    const proof = readiness.data.executionProof, handshake = readiness.data.launchHandshake
    assert(proof && handshake); assert.equal(proof.credentialMode, 'none'); assert.equal(proof.reusable, true)
    assert.equal(proof.modelId, modelId); assert.equal(handshake.sourceCapabilities.teamLaunch, true)
    assert.equal(handshake.server.runtime.capabilitySnapshotId, proof.capabilitySnapshotId)
    assert.equal(handshake.expectedBehaviorFingerprint, proof.expectedBehaviorEvidence.expectedBehaviorFingerprint)
    const conditions = preconditions(handshake)
    const launch = await call(envelope('opencode.launchTeam', { executionProof: proof, preconditions: conditions,
      members: fixture.members.map((member: any) => ({ name: member.name, prompt: member.bootstrap })) }, 150_000))
    assert.equal(launch.runtime.version, readiness.runtime.version)
    assert.equal(launch.data.expectedBehaviorFingerprint, handshake.expectedBehaviorFingerprint)
    assert.deepEqual(Object.keys(launch.data.members).sort(), fixture.members.map((row: any) => row.name).sort())
    const members: any[] = Object.values(launch.data.members)
    assert.equal(new Set(members.map(row => row.sessionId)).size, 2)
    assert.equal(new Set(members.map(row => row.runtimePid)).size, 2)
    for (const member of members) {
      assert.equal(member.launchState, 'confirmed_alive'); assert(Number.isSafeInteger(member.runtimePid) && member.runtimePid > 0)
      assert.equal(member.model, modelId); assert.equal(member.bootstrap?.verified, true)
      assert.equal(member.bootstrap.strategy, 'instruction-entry'); assert.equal(member.bootstrap.nativeMessageID, null)
      assert(member.evidence.some((row: any) => row.kind === 'member_ready' && /^[a-f0-9]{64}$/.test(row.schemasHash)))
      process.kill(member.runtimePid, 0)
    }
    const control = await discoverOpenCodeV2Run(dataRoot, teamId, runId); assert(control)
    assert.equal(control.binding.controllerInstanceId, conditions.commandLeaseId)
    const owned = await requestOpenCodeV2Run(control, { operation: 'status' }, 8000)
    assert.equal(owned.state, 'active'); assert.equal(owned.members.length, 2)
    for (const member of owned.members) {
      assert.equal(member.originalSessionId, launch.data.members[member.memberId].sessionId)
      assert.equal(member.runtimePid, launch.data.members[member.memberId].runtimePid)
      assert(member.controllerTools.nativeNames.some((name: string) => name.endsWith('message_send')))
    }
    // Proof must itself have a real submitted and physically retired producer.
    const probes = []
    for (const name of await readdir(path.join(dataRoot, 'opencode/v2/execution-probes'))) {
      const row = await read(path.join(dataRoot, 'opencode/v2/execution-probes', name, 'probe.json')).catch(() => null)
      if (row) probes.push(row)
    }
    const producer = probes.filter(row => row.proof?.proofHash === proof.proofHash)
    assert.equal(producer.length, 1); assert.equal(producer[0].submitted, true); assert.equal(producer[0].retired, true); assert.equal(producer[0].failure, null)
    await save(resultFile, { readiness, launch, control, owned, producer: producer[0] })
    console.log(JSON.stringify({ event: 'TEST-native-team-launched', nativeVersion: launch.runtime.version,
      engineVersion: owned.qualification.engineVersion, members: members.map(row => ({ sessionId: row.sessionId, pid: row.runtimePid })),
      proofHash: proof.proofHash, proofProducerRetired: true }))
  } else if (stage === 'interact') {
    const launch = await read(path.join(root, 'TEST-launch-result.json'))
    const handshake = (await call(envelope('opencode.handshake', { client, requiredCommand: 'opencode.sendMessage' }))).data
    assert.equal(handshake.sourceCapabilities.memberSession, true)
    assert.equal(handshake.expectedBehaviorFingerprint, launch.readiness.data.launchHandshake.expectedBehaviorFingerprint)
    const before = (await call(envelope('opencode.reconcileTeam'))).data
    assert.deepEqual(before.members, launch.launch.data.members)
    const deliveries = []
    for (const member of fixture.members) {
      const sessionId = before.members[member.name].sessionId, deliveryAttemptId = crypto.randomUUID()
      const base = { memberName: member.name, runtimeSessionId: sessionId, messageId: member.messageId, deliveryAttemptId }
      const sendEnvelope = envelope('opencode.sendMessage', { ...base, preconditions: preconditions(handshake),
        text: `TEST_TEAM_TURN:${member.name}:${member.messageId}\nSend the requested TEST controller reply, then finish with ${member.reply}.` })
      const sent = await call(sendEnvelope); assert.equal(sent.data.accepted, true)
      assert.equal(sent.data.sessionId, sessionId); assert.match(sent.data.runtimePromptMessageId, /^msg_[a-f0-9]{64}$/)
      const observe = { ...base, originalRequestId: sendEnvelope.requestId, runtimePromptMessageId: sent.data.runtimePromptMessageId }
      const deadline = Date.now() + 60_000
      let observed: any
      do {
        observed = await call(envelope('opencode.observeMessageDelivery', observe))
        if (observed.data.responseObservation.state !== 'pending') break
        await Bun.sleep(100)
      } while (Date.now() < deadline)
      const terminal = observed.data.responseObservation
      assert.equal(terminal.state, 'responded_visible_message', JSON.stringify(observed))
      assert.equal(terminal.deliveredUserMessageId, sent.data.runtimePromptMessageId)
      assert.equal(terminal.visibleReplyMessageId, member.replyId); assert.equal(terminal.visibleReplyCorrelation, 'relayOfMessageId')
      assert.equal(terminal.latestAssistantPreview, member.reply)
      const transcript = await call(envelope('opencode.getRuntimeTranscript', { ...base, messageLimit: 100 }))
      assert.equal(transcript.data.sessionId, sessionId); assert.equal(transcript.data.durableState, 'idle')
      assert.equal(transcript.data.messages.filter((row: any) => row.id === sent.data.runtimePromptMessageId && row.role === 'user').length, 1)
      const toolCalls = transcript.data.messages.flatMap((row: any) => row.toolCalls)
      assert.equal(toolCalls.length, 1); assert.equal(toolCalls[0].status, 'completed'); assert.equal(toolCalls[0].isError, false)
      assert.equal(toolCalls[0].input.relayOfMessageId, member.messageId)
      assert(transcript.data.messages.some((row: any) => row.role === 'assistant' && row.text === member.reply))
      const repeated = await call(sendEnvelope)
      assert.equal(repeated.data.runtimePromptMessageId, sent.data.runtimePromptMessageId)
      assert.equal(repeated.data.responseObservation.visibleReplyMessageId, member.replyId)
      const status = await call(envelope('opencode.commandStatus', { ...base, originalRequestId: sendEnvelope.requestId }))
      assert.equal(status.data.accepted, true); assert.equal(status.data.safeToRetry, false)
      const permissions = await call(envelope('opencode.listRuntimePermissions', base))
      assert.deepEqual(permissions.data.permissions, [])
      deliveries.push({ member: member.name, sent, observed, transcript, repeated, status, permissions })
      await save(resultFile, { handshake, deliveries })
    }
    console.log(JSON.stringify({ event: 'TEST-native-team-interacted', freshController: true, deliveries: deliveries.length,
      visibleReplies: deliveries.map(row => row.observed.data.responseObservation.visibleReplyMessageId), replayed: false }))
  } else if (stage === 'stop') {
    let teamFailure: unknown
    let result: Record<string, unknown> = {}
    const probeCleanup: unknown[] = [], probeCleanupFailures: string[] = []
    try {
    const control = await discoverOpenCodeV2Run(dataRoot, teamId, runId)
    assert(control, 'Exact original team owner must exist to prove physical retirement')
    const handshake = (await call(envelope('opencode.handshake', { client, requiredCommand: 'opencode.stopTeam' }))).data
    const stopped = await call(envelope('opencode.stopTeam', { preconditions: preconditions(handshake) }, 45_000))
    result = { stopped }; await save(resultFile, result)
    assert.equal(stopped.data.stopped, true)
    assert.equal(Object.keys(stopped.data.members).length, 2)
    assert(Object.values(stopped.data.members).every((row: any) => row.stopped && row.diagnostics.length === 0))
    const physical = await readOpenCodeV2RunStop(control)
    assert(physical); assert.equal(physical.state, 'stopped'); assert.equal(physical.ownerRetired, true)
    assert.equal(physical.members.length, 2)
    const launch = await read(path.join(root, 'TEST-launch-result.json'))
    for (const member of physical.members) {
      assert.deepEqual(member.errors, []); assert(member.cleanup)
      assert.equal(member.cleanup.scopeClosed, true); assert.equal(member.cleanup.processRetired, true); assert.equal(member.cleanup.descendantsRetired, true)
      assert.equal(member.cleanup.pid, launch.launch.data.members[member.memberId].runtimePid)
    }
    const lateSend = await execute(envelope('opencode.sendMessage', { memberName: fixture.members[0].name,
      runtimeSessionId: launch.launch.data.members[fixture.members[0].name].sessionId,
      messageId: crypto.randomUUID(), deliveryAttemptId: crypto.randomUUID(), text: 'TEST after-stop must be refused' }))
    assert.equal(lateSend.ok, false, 'A stopped run cannot mint a replacement member or replay an input')
    const retained = await discoverOpenCodeV2Run(dataRoot, teamId, runId)
    assert.deepEqual(retained, control, 'The original tombstone must retain ownership')
    const mirror = await read(path.join(dataRoot, 'opencode/auth.json')).catch((error: NodeJS.ErrnoException) => { assert.equal(error.code, 'ENOENT'); return {} })
    assert.deepEqual(mirror, {})
    result = { stopped, physical, lateSend, ownerRetired: true, mirrorEmpty: true }
    console.log(JSON.stringify({ event: 'TEST-native-team-retired', ownerRetired: physical.ownerRetired,
      members: physical.members.map((row: any) => ({ member: row.memberId, ...row.cleanup })), afterStopRefused: true }))
    } catch (error) { teamFailure = error }
    finally {
      // Readiness owns a different real run. If it failed before launch or the
      // controller died, clean that exact persisted binding too; never infer an
      // owner from a PID or mint a replacement probe/receipt to make cleanup pass.
      const probeRoot = path.join(dataRoot, 'opencode/v2/execution-probes')
      try {
        const names = await readdir(probeRoot).catch((error: NodeJS.ErrnoException) => { assert.equal(error.code, 'ENOENT'); return [] })
        const candidates = names.filter(name => /^[a-f0-9]{64}$/.test(name))
        assert(candidates.length <= 4, 'Fresh fixture has an unexpectedly large probe history; retain it for review')
        for (const name of candidates) {
          try {
            const record = await read(path.join(probeRoot, name, 'probe.json'))
            assert.equal(record.sourceKey, name)
            const original = await discoverOpenCodeV2Run(dataRoot, record.binding.teamId, record.binding.runId)
            assert(original, 'Persisted probe has no verifiable original run owner')
            assert.deepEqual(original.binding, record.binding)
            let physical = await readOpenCodeV2RunStop(original)
            if (!physical || physical.state !== 'stopped' || physical.ownerRetired !== true) {
              await requestOpenCodeV2Run(original, { operation: 'stop' }, 45_000)
              physical = await readOpenCodeV2RunStop(original)
            }
            assert(physical); assert.equal(physical.state, 'stopped'); assert.equal(physical.ownerRetired, true)
            assert.equal(physical.members.length, 1)
            for (const member of physical.members) {
              assert.deepEqual(member.errors, []); assert(member.cleanup)
              assert.equal(member.cleanup.scopeClosed, true); assert.equal(member.cleanup.processRetired, true)
              assert.equal(member.cleanup.descendantsRetired, true)
            }
            probeCleanup.push({ sourceKey: name, binding: record.binding, producerRetired: record.retired, physical })
          } catch (error) { probeCleanupFailures.push(`${name}: ${String(error)}`) }
        }
      } catch (error) { probeCleanupFailures.push(String(error)) }
      await save(resultFile, { ...result, probeCleanup, probeCleanupFailures, teamFailure: teamFailure ? String(teamFailure) : null })
    }
    if (teamFailure) throw teamFailure
    assert.equal(probeCleanupFailures.length, 0, JSON.stringify(probeCleanupFailures))
    assert.equal(probeCleanup.length, 1, 'The exact unattended proof producer must also be physically retired')
  } else throw new Error(`Unknown TEST stage ${stage}`)
}
