import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/** Opt-in real native E2E (no credentials or external model requests).
 * TEST_OPENCODE_V2_NATIVE_BINARY=/absolute/path/to/opencode bun scripts/opencode-v2-anonymous-native-e2e.ts
 * Optional: TEST_EVIDENCE_DIR=/absolute/output, TEST_KEEP_NATIVE_PROFILES=1.
 * The SDK, owned engine, admission, proof, retirement and runtime status are real;
 * only provider HTTP and MCP discovery use loopback fixtures. A separate tool-attempt probe verifies zero file/MCP effects. A clean synthetic
 * key catalog checks paid discovery without connecting or calling a paid model.
 */
const repo = process.env.TEST_RUNTIME_REPO ?? path.resolve(import.meta.dir, '..')
const binary = process.env.TEST_OPENCODE_V2_NATIVE_BINARY
assert(binary && path.isAbsolute(binary), 'Set TEST_OPENCODE_V2_NATIVE_BINARY to a genuine supported CLI')
const load = (relative: string) => import(pathToFileURL(path.join(repo, relative)).href)
const providerId = 'opencode', freeId = 'opencode/big-pickle', paidId = 'opencode/TEST-paid-native', toolId = 'opencode/TEST-tool-native'
const evidence = process.env.TEST_EVIDENCE_DIR

if (process.argv[2] !== 'child') {
  if (evidence) await mkdir(evidence, { recursive: true, mode: 0o700 })
  const { createOpenCodeV2ReadRoots } = await load('src/services/opencode/profile/OpenCodeV2ManagedConfig.ts')
  const roots = await createOpenCodeV2ReadRoots()
  const project = path.join(roots.root, 'TEST-free-project'), toolProject = path.join(roots.root, 'TEST-tool-project')
  await mkdir(project)
  const gitBinary = Bun.which('git'); assert(gitBinary, 'Install git for the isolated TEST project')
  const git = Bun.spawn([gitBinary, 'init', '--quiet', project], { env: roots.env, stdout: 'pipe', stderr: 'pipe' })
  assert.equal(await git.exited, 0)
  const requests: unknown[] = [], fixtureFailures: string[] = [], mcpMethods: Record<string, number> = {}
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/mcp') {
      if (request.method !== 'POST') return new Response(null, { status: request.method === 'GET' ? 405 : 200 })
      const body: any = await request.json()
      mcpMethods[body.method ?? 'unknown'] = (mcpMethods[body.method ?? 'unknown'] ?? 0) + 1
      if (body.id === undefined) return new Response(null, { status: 202 })
      let result: unknown
      if (body.method === 'initialize') result = { protocolVersion: body.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'TEST', version: '1' } }
      else if (body.method === 'tools/list') result = { tools: [{ name: 'message_send', description: 'TEST fixture; never called', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
      else if (body.method === 'ping') result = {}
      else { fixtureFailures.push(`Unexpected MCP ${body.method}`); return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'TEST forbidden' } }) }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    }
    try {
      assert.equal(url.pathname, '/v1/chat/completions'); assert.equal(request.method, 'POST')
      assert(requests.length < 2, 'One successful probe plus one separate blocked-tool probe only')
      assert.equal(request.headers.get('authorization'), 'Bearer public', 'No credential may be invented for the free route')
      assert.equal(request.headers.get('x-opencode-client'), 'agent-teams-execution', 'Use the genuine owned SDK client identity')
      const body: any = await request.json()
      assert(['TEST-free-upstream', 'TEST-tool-upstream'].includes(body.model)); assert.equal(body.stream, true)
      assert(!requests.some((row: any) => row.model === body.model), 'A model probe may not replay after success or blocked tools')
      const tools = (body.tools ?? []).map((tool: any) => tool.function?.name).sort()
      for (const name of ['read', 'glob', 'grep', 'write', 'edit', 'shell'])
        assert(tools.includes(name), `Zen free readiness must carry the native standard tool ${name}`)
      const tokens = JSON.stringify(body.messages).match(/STRICT_LAUNCH_[0-9a-f-]{36}/g) ?? []; assert(tokens.length > 0)
      requests.push({ model: body.model, stream: body.stream, publicSentinel: true,
        client: request.headers.get('x-opencode-client'), tools })
      const id = 'chatcmpl_TESTfree'
      const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })
      const mcp = tools.find((name: string) => name.endsWith('message_send'))
      assert(mcp, 'Native readiness must advertise its real controller tool')
      const chunks = body.model === 'TEST-tool-upstream'
        ? [chunk({ role: 'assistant' }), chunk({ tool_calls: [
          { index: 0, id: 'call_TESTshell', type: 'function', function: { name: 'shell',
            arguments: JSON.stringify({ command: 'echo TEST_FORBIDDEN > TEST-probe-tool-effect', workdir: toolProject }) } },
          { index: 1, id: 'call_TESTmcp', type: 'function', function: { name: mcp, arguments: '{}' } },
        ] }), chunk({}, 'tool_calls')]
        : [chunk({ role: 'assistant' }), chunk({ content: tokens.at(-1) }), chunk({}, 'stop'),
          { id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }]
      return new Response(chunks.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    } catch (error) { fixtureFailures.push(String(error)); return new Response('TEST fixture mismatch', { status: 400 }) }
  } })
  const url = `http://127.0.0.1:${server.port}`
  const model = (id: string, input: number) => ({ id, name: 'TEST native free admission', cost: { input, output: 0, cache: { read: 0, write: 0 } }, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 } })
  const config = { model: freeId, provider: { opencode: { options: { baseURL: `${url}/v1` }, models: {
    'big-pickle': model('TEST-free-upstream', 0), 'TEST-paid-native': model('TEST-paid-upstream', 1),
    'TEST-tool-native': model('TEST-tool-upstream', 0),
  } } } }
  const env = { ...roots.env, NODE_ENV: 'test', TEST_RUNTIME_REPO: repo, TEST_OPENCODE_V2_NATIVE_BINARY: binary,
    ...(evidence ? { TEST_EVIDENCE_DIR: evidence } : {}), CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binary,
    CLAUDE_MULTIMODEL_DATA_HOME: path.join(roots.root, 'data/runtime'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(roots.root, 'cache/runtime'),
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: `${url}/mcp`, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' }
  const children: unknown[] = []
  let success = false
  try {
    for (const stage of ['main', 'reload', 'tool-attempt', 'saved-key-catalog']) {
      const childProject = stage === 'tool-attempt' ? toolProject : project
      if (stage === 'tool-attempt') {
        assert.equal(requests.length, 1, 'Status refreshes must reuse the first proof without inference')
        await mkdir(toolProject)
        const setup = Bun.spawn([gitBinary, 'init', '--quiet', toolProject], { env: roots.env, stdout: 'pipe', stderr: 'pipe' })
        assert.equal(await setup.exited, 0)
      }
      const stageEnv: NodeJS.ProcessEnv = { ...env }
      if (stage === 'saved-key-catalog') {
        delete stageEnv.OPENCODE_CONFIG_CONTENT
        stageEnv.CLAUDE_MULTIMODEL_DATA_HOME = path.join(roots.root, 'data/runtime-paid')
        stageEnv.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(roots.root, 'cache/runtime-paid')
        const directory = path.join(stageEnv.CLAUDE_MULTIMODEL_DATA_HOME, 'opencode')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'TEST-only-native-catalog-key' } }), { mode: 0o600 })
      }
      const child = Bun.spawn([process.execPath, import.meta.path, 'child', childProject, stage], { cwd: childProject, env: stageEnv, stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 300_000)
      const pipe = async (stream: ReadableStream<Uint8Array>, target: typeof process.stdout) => {
        const reader = stream.getReader(), decoder = new TextDecoder(); let tail = ''
        for (;;) { const row = await reader.read(); if (row.done) break; const text = decoder.decode(row.value); tail = (tail + text).slice(-20000); target.write(text) }
        return tail
      }
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, pipe(child.stdout, process.stdout), pipe(child.stderr, process.stderr)])
        children.push({ stage, code, stdout, stderr }); assert.equal(code, 0, `TEST ${stage} child`)
      } finally { clearTimeout(timeout) }
    }
    assert.equal(requests.length, 2); assert.equal(fixtureFailures.length, 0); assert.equal(mcpMethods['tools/call'] ?? 0, 0)
    await assert.rejects(readFile(path.join(toolProject, 'TEST-probe-tool-effect')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    success = true
  } finally {
    await server.stop(true)
    if (evidence) await writeFile(path.join(evidence, 'anonymous-native-proof.json'), JSON.stringify({ success, root: roots.root, requests, fixtureFailures, mcpMethods, children }, null, 2))
    const retained = !success || process.env.TEST_KEEP_NATIVE_PROFILES === '1'
    if (!retained) await roots.remove()
    console.log(JSON.stringify({ event: 'TEST-free-e2e-complete', success, root: roots.root, retained, requests: requests.length, fixtureFailures, mcpMethods }))
  }
} else {
  const project = process.argv[3]!, stage = process.argv[4]!
  const { OpenCodeProviderManagementAdapter } = await load('src/features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.ts')
  const { resolveClaudeMultimodelPaths } = await load('src/services/opencode/OpenCodeManagedPaths.ts')
  const adapter = new OpenCodeProviderManagementAdapter(), input = { runtimeId: 'opencode', providerId, projectPath: project }
  if (stage === 'saved-key-catalog') {
    const { Database } = await import('bun:sqlite')
    const catalog = await adapter.loadModels({ ...input, limit: null }); assert(catalog.ok)
    assert(catalog.value.models.some((row: any) => row.free === false && row.availability !== 'unavailable'), 'Selected saved key must enable the native paid catalog')
    assert(catalog.value.models.every((row: any) => row.proofState === 'needs_probe'), 'Catalog key is not execution verification')
    const directory = path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-profiles'), profiles = []
    for (const name of await readdir(directory)) {
      const root = path.join(directory, name)
      const auth = JSON.parse(await readFile(path.join(root, 'data/opencode/auth.json'), 'utf8'))
      const config = JSON.parse(await readFile(path.join(root, 'config/opencode/opencode.json'), 'utf8'))
      const database = new Database(path.join(root, 'data/opencode/opencode.db'), { readonly: true })
      let count: number
      try { count = (database.query('select count(*) as count from credential').get() as { count: number }).count }
      finally { database.close() }
      assert.equal(auth.opencode?.key, 'TEST-only-native-catalog-key')
      assert.equal(config.providers?.opencode?.settings?.apiKey, 'TEST-only-native-catalog-key')
      assert.equal(count, 0, 'Catalog discovery must not create native credentials')
      profiles.push({ sealedKeyPresent: true, keyInBoundConfig: true, nativeCredentials: count })
    }
    assert.equal(profiles.length, 1)
    console.log(JSON.stringify({ event: 'TEST-saved-key-catalog', total: catalog.value.totalCount,
      free: catalog.value.models.filter((row: any) => row.free).length,
      paid: catalog.value.models.filter((row: any) => !row.free).length, profiles }))
    process.exit(0)
  }
  if (stage === 'tool-attempt') {
    const directory = path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/execution-probes')
    const before = new Set(await readdir(directory))
    const result = await adapter.testModel({ ...input, modelId: toolId })
    assert(!result.ok || !result.value.ok, 'A tool-attempting model must not pass ordinary Test')
    const added = (await readdir(directory)).filter(name => /^[a-f0-9]{64}$/.test(name) && !before.has(name))
    assert.equal(added.length, 1)
    const record = JSON.parse(await readFile(path.join(directory, added[0]!, 'probe.json'), 'utf8'))
    assert.equal(record.submitted, true); assert.equal(record.retired, true); assert.equal(record.proof, null)
    assert.equal(record.failure, 'native_execution_cancelled')
    await assert.rejects(readFile(path.join(project, 'TEST-probe-tool-effect')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    console.log(JSON.stringify({ event: 'TEST-native-tool-attempt-blocked', submitted: record.submitted,
      retired: record.retired, failure: record.failure, filesystemEffect: false }))
    process.exit(0)
  }
  if (stage === 'main') {
    const models = await adapter.loadModels({ ...input, limit: null }); assert(models.ok)
    const free = models.value.models.find((row: any) => row.modelId === freeId), paid = models.value.models.find((row: any) => row.modelId === paidId)
    assert(free); assert(paid)
    assert.equal(free.free, true); assert.equal(free.accessKind, 'builtin_free'); assert.equal(free.proofState, 'needs_probe'); assert.equal(free.availability, 'untested')
    assert.equal(paid.free, false); assert.equal(paid.accessKind, 'credentialed'); assert.equal(paid.requiresExecutionProof, true)
    const actualNative = models.value.models.filter((row: any) => row.modelId !== freeId && row.modelId !== paidId && !row.modelId.includes('/TEST-') && row.free)
    assert(actualNative.length > 0); console.log(JSON.stringify({ event: 'TEST-free-catalog', actualNativeFree: actualNative.length, free, paid }))
  }
  if (stage === 'main') {
    const { inspectOpenCodeV2SourceAvailability } = await load('src/services/opencode/bridge/OpenCodeV2LaunchPlan.ts')
    const selection = await inspectOpenCodeV2SourceAvailability({ schemaVersion: 1, requestId: crypto.randomUUID(), command: 'opencode.readiness', cwd: project,
      startedAt: new Date().toISOString(), timeoutMs: 150000, body: { projectPath: project, selectedModel: freeId, effort: 'default', requireExecutionProbe: true } })
    assert.equal(selection.scope.selectedAuthIdentity, 'absent')
    console.log(JSON.stringify({ event: 'TEST-free-selection', model: selection.model, auth: selection.scope.selectedAuthIdentity, stage,
      nativeVersion: selection.native.version, nativeExecutableSHA256: selection.native.executableSha256, installedGraphSHA256: selection.installedGraphSHA256 }))
    const result = await adapter.testModel({ ...input, modelId: freeId })
    console.log(JSON.stringify({ event: 'TEST-free-model-proof', stage, result })); assert(result.ok && result.value.ok)
  }
  // Same-process status first, then a separate process: neither may send another prompt.
  const { getUnifiedRuntimeStatusPayload } = await load('src/services/runtimeBackends/registry.ts')
  const status = (await getUnifiedRuntimeStatusPayload('opencode', {}, { detailLevel: 'full' })).providers.opencode
  const verified = status?.modelCatalog?.models.find((row: any) => row.id === freeId)
  assert.equal(verified?.metadata?.opencode?.proofState, 'verified')
  assert.equal(verified.metadata.opencode.routeKind, 'builtin_free')
  assert.equal(verified.metadata.opencode.requiresExecutionProof, true)
  assert.equal(status.authenticated, false); assert.equal(status.capabilities.teamLaunch, false)
  assert.equal(status.modelCatalog.defaultLaunchModel, null)
  assert(status.modelCatalog.models.some((row: any) => row.id !== freeId && row.metadata?.opencode?.proofState === 'needs_probe'))
  console.log(JSON.stringify({ event: 'TEST-free-status', stage, proofState: verified.metadata.opencode.proofState,
    requiresExecutionProof: verified.metadata.opencode.requiresExecutionProof, authenticated: status.authenticated }))
  const data = resolveClaudeMultimodelPaths().data, probes: any[] = []
  for (const name of await readdir(path.join(data, 'opencode/v2/execution-probes'))) {
    const record = await readFile(path.join(data, 'opencode/v2/execution-probes', name, 'probe.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (record) probes.push({ submitted: record.submitted, retired: record.retired, failure: record.failure, model: record.proof?.modelId })
  }
  const successful = probes.filter(row => row.model === freeId)
  assert.equal(successful.length, 1); assert.equal(successful[0].submitted, true); assert.equal(successful[0].retired, true)
  const mirror = await readFile(path.join(data, 'opencode/auth.json'), 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => { assert.equal(error.code, 'ENOENT'); return {} })
  assert.deepEqual(mirror, {}); console.log(JSON.stringify({ event: 'TEST-free-retirement', stage, probes, mirrorEmpty: true }))
}
