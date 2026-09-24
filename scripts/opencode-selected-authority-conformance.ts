/** Full selected-authority conformance, no inference. Run ONLY in a clean network-none
 * Linux Docker container with this bundled script, Bun and the pinned binary mounted.
 * bun selected-authority.js /absolute/opencode 1.18.29 SHA256
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
let phase = 'isolation'
async function main() {
  assert(process.platform === 'linux', 'Clean Linux container required')
  await access('/.dockerenv')
  const [binaryArg, version, digest] = process.argv.slice(2)
  assert(binaryArg && path.isAbsolute(binaryArg), 'Absolute binary required')
  assert(['1.18.4', '1.18.29'].includes(version ?? ''), 'Pinned supported version required')
  assert(/^[a-f0-9]{64}$/i.test(digest ?? ''), 'Binary SHA256 required')
  const binary = await realpath(binaryArg)
  assert(createHash('sha256').update(await readFile(binary)).digest('hex') === digest!.toLowerCase(), 'Binary digest mismatch')
  const root = await mkdtemp('/tmp/opencode-selected-authority-TEST-')
  const children: ChildProcess[] = []
  let stopping: Promise<void> | undefined
  const stop = () => stopping ??= (async () => {
    for (const child of children) {
      if (!child.pid) continue
      // Only process groups created by this harness. Include MCP descendants even
      // when their parent has already exited.
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await Bun.sleep(200)
    for (const child of children) {
      if (!child.pid) continue
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())),
          Bun.sleep(2000).then(() => { throw new Error('Owned child teardown timed out') })])
      }
    }
    await rm(root, { recursive: true, force: true })
  })()
  const interrupted = () => { void stop().then(() => process.exit(130), () => process.exit(1)) }
  process.once('SIGTERM', interrupted)
  process.once('SIGINT', interrupted)
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    const names = ['home', 'appdata', 'localappdata', 'config', 'data', 'cache', 'state', 'runtime', 'tmp', 'app-data', 'app-cache', 'project']
    const dirs = Object.fromEntries(names.map(name => [name, path.join(root, name)]))
    await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { recursive: true })))
    Object.assign(process.env, {
      HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
      XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      CLAUDE_MULTIMODEL_DATA_HOME: dirs['app-data'], CLAUDE_MULTIMODEL_CACHE_HOME: dirs['app-cache'],
      PATH: `${path.dirname(process.execPath)}:${path.dirname(binary)}:/usr/bin:/bin`, LANG: 'C.UTF-8', CI: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', DEEPINFRA_API_KEY: 'TEST-only-no-real-credential',
    })
    phase = 'version'
    const versionChild = spawn(binary, ['--version'], { cwd: dirs.project, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(versionChild)
    let reported = ''
    versionChild.stdout!.on('data', chunk => { reported += chunk })
    const code = await Promise.race([new Promise<number | null>((resolve, reject) => {
      versionChild.once('error', reject); versionChild.once('exit', resolve)
    }), Bun.sleep(5000).then(() => { throw new Error('Version timeout') })])
    assert(code === 0 && reported.trim() === version, 'Binary version mismatch')
    const mcpEntry = path.join(root, 'mcp-fixture.js')
    const mcpLog = path.join(root, 'mcp-evidence.jsonl')
    await writeFile(mcpEntry, `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const log = ${JSON.stringify(mcpLog)};
      const reader = createInterface({ input: process.stdin });
      reader.on('line', line => {
        const request = JSON.parse(line);
        appendFileSync(log, JSON.stringify({ method: request.method, pid: process.pid }) + '\\n');
        if (request.id === undefined) return;
        let result;
        if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} }, serverInfo: { name: 'selected-authority-TEST', version: '1' } };
        else if (request.method === 'tools/list') result = { tools: [{ name: 'authority_ping',
          description: 'Test fixture; no external effects', inputSchema: { type: 'object', properties: {} } }] };
        else if (request.method === 'ping') result = {};
        else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not allowed in conformance' } }) + '\\n'); return; }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      });
      reader.on('close', () => process.exit(0));
    `)
    Object.assign(process.env, {
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: process.execPath,
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: mcpEntry,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], provider: { deepinfra: {
        options: { baseURL: 'http://127.0.0.1:1/inference-forbidden', apiKey: 'TEST-only-no-real-credential' },
        models: { chosen: { name: 'Independent imported fixture', structured_output: true,
          tool_call: true, limit: { context: 8192, output: 1024 } } },
      } } }),
    })
    await writeFile(path.join(dirs.project!, 'AGENTS.md'), 'Owned TEST fixture behavior. No inference allowed.\n')
    phase = 'prepare'
    const { OpenCodeProfileManager, resolveOpenCodeProfileScope } = await import('../src/services/opencode/OpenCodeProfileManager.js')
    const { OpenCodeHostManager } = await import('../src/services/opencode/OpenCodeHostManager.js')
    const { refreshSelectedProfileAuthority } = await import('../src/services/opencode/OpenCodeSelectedProfileAuthority.js')
    const { buildOpenCodeExpectedBehaviorEvidence } = await import('../src/services/opencode/OpenCodeExpectedBehaviorFingerprint.js')
    const { readProcessStartTimeMs } = await import('../src/utils/processKill.js')
    const selectedModel = 'deepinfra/chosen'
    const profileScope = await resolveOpenCodeProfileScope({ projectPath: dirs.project!, purpose: 'launch_runtime', selectedModel })
    const profile = await new OpenCodeProfileManager().prepareProfile(dirs.project!, { profileScope })
    const imported = profile.managedConfig.provider as Record<string, any>
    assert(imported.deepinfra.models.chosen.structured_output === true, 'Imported regression metadata missing')
    assert(Array.isArray(profile.managedConfig.plugin) && profile.managedConfig.plugin.length === 0, 'Unexpected plugins')
    const manager = new OpenCodeHostManager({ persistentRegistryPath: path.join(root, 'registry.json'), readProcessStartTimeMs,
      spawnHostProcess(prepared, port) {
        const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
          cwd: prepared.workingDirectoryPath ?? prepared.projectPath, env: prepared.env, detached: true,
          stdio: 'ignore',
        })
        children.push(child)
        return child
      },
    })
    phase = 'host'
    const host = await manager.ensureHost({ preparedProfile: profile, healthTimeoutMs: 25000,
      resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false })
    const evidence = await buildOpenCodeExpectedBehaviorEvidence({ profile, fullModelId: selectedModel,
      effectiveConfigFingerprint: profile.managedConfigFingerprint })
    const rejections: unknown[] = []
    const refresh = () => refreshSelectedProfileAuthority({ host, selectedModel,
      expectedBehaviorFingerprint: evidence.expectedBehaviorFingerprint,
      onRejection: diagnostic => { rejections.push(diagnostic) },
    })
    phase = 'full_refresh'
    const refreshed = await refresh()
    const live = await fetch(host.baseUrl + '/config').then(response => response.json()) as Record<string, any>
    if (!refreshed) {
      // Both objects are generated in this clean TEST fixture; report policy-only
      // differences, never imported config, environment or provider options.
      for (const name of ['teammate', 'teammate-bootstrap', 'teammate-model-probe']) {
        const expectedAgent = (profile.managedConfig.agent as Record<string, any>)[name]
        const actualAgent = live.agent?.[name]
        console.error(JSON.stringify({ diagnostic: 'managed-agent-policy', name,
          expected: { tools: expectedAgent?.tools, permission: expectedAgent?.permission, options: expectedAgent?.options },
          actual: { tools: actualAgent?.tools, permission: actualAgent?.permission, options: actualAgent?.options } }))
      }
    }
    assert(refreshed, `Full refresh rejected: ${JSON.stringify(rejections)}`)
    assert(live.provider.deepinfra.models.chosen.structured_output === undefined, 'Upstream did not normalize regression metadata')
    const calls = (await readFile(mcpLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert(calls.some(call => call.method === 'initialize'), 'Actual MCP initialize missing')
    assert(calls.some(call => call.method === 'tools/list'), 'Actual MCP tools/list missing')
    assert(!calls.some(call => call.method === 'tools/call'), 'Unexpected tool execution')
    phase = 'source_drift'
    await writeFile(path.join(dirs.project!, 'AGENTS.md'), 'Meaningfully changed TEST project authority.\n')
    assert(await refresh() === null, 'Project source mutation accepted')
    assert(rejections.some((item: any) => item.check === 'behavior_match'), 'Source rejection reason missing')
    phase = 'cleanup'
    await stop()
    console.log(JSON.stringify({ status: 'passed', binary: { version, sha256: digest }, platform: process.platform,
      checks: { fullRealHelper: true, realProfileAndHostManagers: true, importedDeepInfraMetadataNormalized: true,
        actualMcpInitialize: true, actualMcpToolsList: true, sourceDriftRejected: true, ownedChildrenTerminated: true },
      rejections, limitations: ['No model inference, strict launch, provider authentication or packaged proof.'] }, null, 2))
  } finally {
    await stop()
    process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted)
  }
}
if (import.meta.main) main().then(() => process.exit(0), error => {
  console.error(JSON.stringify({ status: 'failed', phase, reason: error instanceof Error ? error.message : 'Probe failed' }))
  process.exit(1)
})
