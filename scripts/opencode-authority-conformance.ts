/** No inference. Run only on disposable runners for system-settings isolation.
 * bun scripts/opencode-authority-conformance.ts /absolute/opencode 1.18.29 SHA256 [auto|manual] [inline|file]
 * Prints redacted evidence to stdout; never downloads a binary or loads auth.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, platform, release } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { isDeepStrictEqual } from 'node:util'
import { buildOpenCodeLaunchProviderContract } from '../src/services/opencode/OpenCodeLaunchProviderContract.js'
import { buildExpectedOpenCodeAgentPolicies, assertOpenCodeEffectiveAgentPolicies,
  type ExpectedOpenCodeAgentPolicies } from '../src/services/opencode/OpenCodeEffectiveAgentPolicyContract.js'
import { OPEN_CODE_TEAMMATE_AGENT_NAME } from '../src/services/opencode/OpenCodeAgentNames.js'

type Config = Record<string, any>
class ProbeError extends Error {}
let phase = 'arguments'
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new ProbeError(message) }

export function managedAgentFixtures(mode: 'auto' | 'manual'): Config {
  // Independent contract fixture from buildManagedConfig; deliberately not taken from /agent.
  const mcpAllow = { 'agent-teams_*': 'allow', 'agent_teams_*': 'allow',
    'mcp__agent-teams__*': 'allow', 'mcp__agent_teams__*': 'allow' }
  const permission = mode === 'manual'
    ? { '*': 'ask', task: { '*': 'deny' }, external_directory: 'deny', doom_loop: 'deny', ...mcpAllow }
    : { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', lsp: 'allow',
      todoread: 'allow', todowrite: 'allow', edit: 'allow', bash: 'allow', task: { '*': 'deny' },
      external_directory: 'deny', doom_loop: 'deny', ...mcpAllow }
  return {
    teammate: { mode: 'primary', description: 'Managed teammate agent for claude-multimodel runtime orchestration.', permission },
    'teammate-bootstrap': { mode: 'primary', description: 'Silent launch bootstrap agent restricted to Agent Teams MCP attach tools.',
      tools: { '*': false, 'agent-teams_*': true, 'agent_teams_*': true, 'mcp__agent-teams__*': true, 'mcp__agent_teams__*': true },
      permission: { '*': 'deny', ...mcpAllow } },
    'teammate-model-probe': { mode: 'primary', description: 'Minimal model execution probe agent with tools disabled.',
      tools: { '*': false }, permission: { '*': 'deny' } },
  }
}

export function checkManagedAgents(expected: Config, agents: any[], policies: ExpectedOpenCodeAgentPolicies): void {
  assertOpenCodeEffectiveAgentPolicies(policies, agents)
  for (const [name, config] of Object.entries(expected.agent) as [string, Config][]) {
    const actual = agents.find(agent => agent?.name === name)
    assert(actual?.mode === config.mode && actual?.description === config.description
      && isDeepStrictEqual(actual?.options, {}), `Managed agent descriptor mismatch: ${name}`)
  }
}

export function fixtureConfig(baseURL: string, mode: 'auto' | 'manual' = 'auto'): Config {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false, snapshot: true, share: 'disabled', plugin: [],
    enabled_providers: ['openrouter', 'authority-fixture'],
    username: 'authority-fixture',
    model: 'authority-fixture/fixture-model', default_agent: 'teammate',
    agent: managedAgentFixtures(mode),
    provider: {
      openrouter: { options: { baseURL: `${baseURL}/curated`, apiKey: 'fixture-only' },
        models: { 'fixture-model': { name: 'Fixture curated', limit: { context: 4096, output: 256 } } } },
      'authority-fixture': { npm: '@ai-sdk/openai-compatible', name: 'Fixture custom',
        options: { baseURL: `${baseURL}/custom`, apiKey: 'fixture-only' },
        models: { 'fixture-model': { name: 'Fixture custom', limit: { context: 4096, output: 256 }, tool_call: true } } },
    },
    mcp: { 'authority-fixture': { type: 'remote', url: `${baseURL}/mcp`, enabled: false } },
  }
}

/** Compare all effective config, not just known authority projection fields.
 * Only pinned upstream empty defaults are normalized. Unknown data fails closed.
 */
export function assertNoContamination(expected: Config, actual: Config): void {
  expected = structuredClone(expected)
  for (const agent of Object.values(expected.agent ?? {}) as Config[]) agent.options ??= {}
  const normalized = structuredClone(actual)
  for (const key of ['agent', 'mode', 'command']) {
    if (!(key in expected) && isDeepStrictEqual(normalized[key], {})) delete normalized[key]
  }
  const changed = Object.keys(expected).filter(key => !isDeepStrictEqual(normalized[key], expected[key]))
  const unknownCount = Object.keys(normalized).filter(key => !(key in expected)).length
  assert(isDeepStrictEqual(normalized, expected), `Effective config mismatch: expected fields=${changed.join(',')}; unknown field count=${unknownCount}`)
}

export function checkProviders(expected: Config, actual: Config): void {
  for (const id of ['openrouter', 'authority-fixture']) {
    assert(isDeepStrictEqual(buildOpenCodeLaunchProviderContract(expected, id),
      buildOpenCodeLaunchProviderContract(actual, id)), `Provider contract mismatch: ${id}`)
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function main(): Promise<void> {
  const [binaryArg, version, sha256, modeArg = 'auto', transport = 'inline'] = process.argv.slice(2)
  assert(transport === 'inline' || transport === 'file', 'Config transport must be inline or file')
  assert(modeArg === 'auto' || modeArg === 'manual', 'Policy mode must be auto or manual')
  assert(binaryArg && path.isAbsolute(binaryArg), 'Supply an absolute pinned binary path, version and SHA256')
  assert(['1.18.4', '1.18.29'].includes(version ?? ''), 'Supported pinned versions: 1.18.4, 1.18.29')
  assert(/^[a-f0-9]{64}$/i.test(sha256 ?? ''), 'Supply expected binary SHA256')
  const binary = await realpath(binaryArg)
  assert(createHash('sha256').update(await readFile(binary)).digest('hex') === sha256!.toLowerCase(), 'Binary SHA256 mismatch')
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-authority-conformance-TEST-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let fixture: ReturnType<typeof Bun.serve> | undefined
  let requests = 0
  let stopped = false
  const stop = async () => {
    if (stopped) return
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([child.exited, Bun.sleep(1500)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.race([child.exited, Bun.sleep(1500)])
      assert(child.exitCode !== null || child.signalCode !== null, 'Owned child did not terminate within teardown deadline')
    }
    await fixture?.stop(true)
    await rm(root, { recursive: true, force: true })
    stopped = true
  }
  const interrupted = () => { void stop().then(() => process.exit(130), () => process.exit(1)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    const roots = Object.fromEntries(['project', 'home', 'config', 'data', 'cache', 'state', 'runtime', 'tmp', 'appdata', 'localappdata']
      .map(name => [name, path.join(root, name)])) as Record<string, string>
    await Promise.all(Object.values(roots).map(dir => mkdir(dir, { recursive: true })))
    const env: Record<string, string> = {
      HOME: roots.home!, USERPROFILE: roots.home!, APPDATA: roots.appdata!, LOCALAPPDATA: roots.localappdata!,
      XDG_CONFIG_HOME: roots.config!, XDG_DATA_HOME: roots.data!, XDG_CACHE_HOME: roots.cache!, XDG_STATE_HOME: roots.state!,
      XDG_RUNTIME_DIR: roots.runtime!, TMPDIR: roots.tmp!, TMP: roots.tmp!, TEMP: roots.tmp!,
      PATH: path.dirname(binary), LANG: 'C.UTF-8', CI: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
    }
    if (process.platform === 'win32') {
      // OS executable lookup only; no user environment or credentials are inherited.
      for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!
    }
    phase = 'version'
    child = Bun.spawn([binary, '--version'], { cwd: roots.project, env, stdout: 'pipe', stderr: 'ignore' })
    const versionResult = await Promise.race([child.exited, Bun.sleep(5000).then(() => { throw new Error('Version probe timed out') })])
    assert(versionResult === 0, 'Version probe failed')
    assert(child.stdout instanceof ReadableStream, 'Version stdout unavailable')
    const reportedVersion = (await new Response(child.stdout).text()).trim()
    assert(reportedVersion === version, 'Binary version mismatch')
    fixture = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      requests++
      return Response.json({ error: 'Inference and MCP connections are forbidden in this probe' }, { status: 403 })
    } })
    const expected = fixtureConfig(`http://127.0.0.1:${fixture.port}`, modeArg)
    const expectedPolicies = buildExpectedOpenCodeAgentPolicies(expected, roots.data!)
    if (transport === 'inline') env.OPENCODE_CONFIG_CONTENT = JSON.stringify(expected)
    else await writeFile(path.join(roots.project!, 'opencode.json'), JSON.stringify(expected))
    phase = 'startup'
    const port = await unusedPort()
    child = Bun.spawn([binary, 'serve', '--hostname', '127.0.0.1', '--port', String(port)],
      { cwd: roots.project, env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    const read = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(2000) })
      assert(response.ok, `Probe failed: ${route} HTTP ${response.status}`)
      return response.json()
    }
    let config: Config | undefined
    const deadline = Date.now() + 25000
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { config = await read('/config') as Config; break } catch { await Bun.sleep(100) }
    }
    assert(config, 'OpenCode startup/config probe failed within deadline')
    phase = 'config_contamination'
    // /config encoder reorders permission object keys; effective order is checked from /agent.
    assertNoContamination(expected, config)
    phase = 'provider_contract'
    checkProviders(expected, config)
    const negative = structuredClone(config)
    negative.provider['authority-fixture'].options.baseURL += '/unexpected'
    let rejected = false
    try { checkProviders(expected, negative) } catch { rejected = true }
    assert(rejected, 'Provider checker accepted a mutated live endpoint')
    phase = 'read_endpoints'
    const providers = await read('/config/providers')
    const agents = await read('/agent')
    const mcp = await read('/mcp')
    assert(providers && typeof providers === 'object', 'Invalid provider response')
    assert(Array.isArray(agents), 'Invalid agent response')
    phase = 'effective_agent_policy'
    checkManagedAgents(expected, agents, expectedPolicies)
    const reorderedAgents = structuredClone(agents)
    const teammate = reorderedAgents.find((agent: any) => agent.name === OPEN_CODE_TEAMMATE_AGENT_NAME)
    const reset = teammate.permission.findLastIndex((rule: any) => rule.permission === '*' && rule.pattern === '*')
    ;[teammate.permission[reset + 1], teammate.permission[reset + 2]] =
      [teammate.permission[reset + 2], teammate.permission[reset + 1]]
    let policyOrderRejected = false
    try { assertOpenCodeEffectiveAgentPolicies(expectedPolicies, reorderedAgents) } catch { policyOrderRejected = true }
    assert(policyOrderRejected, 'Production policy checker accepted reordered live rules')
    assert(mcp && typeof mcp === 'object', 'Invalid MCP response')
    assert(requests === 0, 'Unexpected request to fixture: inference/connect side effect')
    phase = 'cleanup'
    await stop()
    // Return only fixture-derived config and endpoint shapes; never raw unknown config or errors.
    console.log(JSON.stringify({ schemaVersion: 1, status: 'passed', policyMode: modeArg, configTransport: transport, binary: { version, sha256, reportedVersion },
      os: { platform: platform(), release: release() }, fixture: expected,
      checks: { configUncontaminated: true, providerContracts: true, negativeEndpointRejected: rejected, managedAgentOrderedPolicies: true, negativePolicyOrderRejected: policyOrderRejected, truncateExceptionObserved: true, fixtureRequests: requests },
      responses: { configKeys: Object.keys(config), providerKeys: Object.keys(providers), agentCount: agents.length, mcpKeys: Object.keys(mcp) },
      limitations: ['Temporary HOME does not isolate system managed settings; clean disposable runner required.',
        'No model inference, permission evaluator, plugin installation, or full launch authority/E2E proven.'] }, null, 2))
  } finally {
    try { await stop() } finally {
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
    }
  }
}

if (import.meta.main) main().then(() => process.exit(0), error => {
  console.error(JSON.stringify({ status: 'failed', phase,
    reason: error instanceof ProbeError ? error.message : 'Probe operation failed; raw diagnostics withheld' }))
  // Fetch/runtime connection pools can keep Bun alive after all owned resources close.
  process.exit(1)
})
