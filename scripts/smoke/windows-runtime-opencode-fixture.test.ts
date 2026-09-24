import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'bun:test'
import { OpenCodeClientFactory } from '../../src/services/opencode/OpenCodeClientFactory.ts'
import { OpenCodeMcpManager } from '../../src/services/opencode/OpenCodeMcpManager.ts'

const { createFixtureServer } = createRequire(import.meta.url)('./windows-runtime-opencode-fixture.cjs')
const config = {
  type: 'local' as const, enabled: true,
  command: ['fixture-only-never-execute', 'project with spaces 世界/not-a-real-mcp-server.cjs'],
  environment: { CLAUDE_MULTIMODEL_DATA_HOME: '/fixture/data' },
  timeout: 30_000,
}

// Deliver HTTP requests to the actual Node server listener in memory: this
// sandbox forbids loopback networking. Production client serialization/parsing
// and the fixture request handler still run; this is not native socket evidence.
async function withServer(server: Server, run: (baseUrl: string, factory: OpenCodeClientFactory, request: typeof fetch) => Promise<void>) {
  const baseUrl = 'http://fixture.invalid'
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.origin, baseUrl, 'focused test must never use an external endpoint')
    return new Promise<Response>((resolve, reject) => {
      // Fragment UTF-8 across chunks, as a real HTTP request may do on Windows
      // paths containing Unicode. The fixture must preserve the exact config.
      const bytes = Buffer.from(init?.body ? String(init.body) : '')
      const req = Object.assign(Readable.from(Array.from(bytes, byte => Buffer.from([byte]))), {
        method: init?.method ?? 'GET', url: url.pathname + url.search,
      })
      const headers: Record<string, string> = {}
      const res = {
        statusCode: 200,
        setHeader(name: string, value: string) { headers[name] = value },
        end(body: string) { resolve(new Response(body, { status: this.statusCode, headers })) },
      }
      Promise.resolve(server.listeners('request')[0]!(req, res)).catch(reject)
    })
  }) as typeof fetch
  try {
    await run(baseUrl, new OpenCodeClientFactory({ fetchImpl: request }), request)
  } finally {
    server.close()
    assert.equal(server.listening, false)
  }
}

test('production MCP manager attaches, reads back, reuses and replaces the simulated HTTP config', async () => {
  const server = createFixtureServer()
  await withServer(server, async (baseUrl, factory) => {
    const client = factory.create(baseUrl)
    let desired = structuredClone(config)
    const manager = new OpenCodeMcpManager({
      clientFactory: factory, env: config.environment,
      resolveLaunchConfig: async () => ({ source: 'env-override', config: desired }),
      verifyTimeoutMs: 20, verifyPollMs: 1,
    })
    const ensure = () => manager.ensureAppMcp({ baseUrl, attachIfMissing: true })
    assert.deepEqual(await client.getMcp(), {})
    assert.equal((await manager.ensureAppMcp({ baseUrl })).summary.status, 'missing')
    const attached = await ensure()
    assert.equal(attached.summary.status, 'attached')
    assert.equal(attached.summary.connected, true)
    assert.deepEqual(attached.summary.diagnostics, [])
    assert.deepEqual(await client.getMcp(), { 'agent-teams': { status: 'connected' } })
    assert.deepEqual((await client.getConfig()).mcp, { 'agent-teams': config })
    assert.equal((await ensure()).summary.status, 'present')
    desired = { ...desired, environment: { CLAUDE_MULTIMODEL_DATA_HOME: '/fixture/new-data' } }
    assert.equal((await ensure()).summary.status, 'attached')
    assert.deepEqual((await client.getConfig()).mcp, { 'agent-teams': desired })
    assert.deepEqual(await client.connectMcp!('agent-teams'), await client.getMcp())
    // OpenCode's experimental tool endpoints are not direct MCP contract proof.
    assert.deepEqual(await client.listExperimentalToolIds({ directory: 'project with spaces' }), [])
    assert.deepEqual(await client.listExperimentalTools({ provider: 'opencode', model: 'big-pickle' }), [])
  })
  await withServer(createFixtureServer(), async (baseUrl, factory) => {
    assert.deepEqual(await factory.create(baseUrl).getMcp(), {}, 'no state leaks between hosts')
  })
})

test('production manager rejects the original always-empty /mcp despite HTTP 200 attach', async () => {
  await withServer(createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  }), async (baseUrl, factory) => {
    const result = await new OpenCodeMcpManager({
      clientFactory: factory, env: {}, resolveLaunchConfig: async () => ({ source: 'env-override', config }),
      verifyTimeoutMs: 20, verifyPollMs: 1,
    }).ensureAppMcp({ baseUrl, attachIfMissing: true })
    assert.equal(result.summary.status, 'attach_failed')
    assert.equal(result.summary.connected, null)
    assert.match(result.summary.diagnostics.join('\n'), /still absent from \/mcp/)
  })
})

test('production selected provisioning keeps hostHealthy gated on MCP attach and releases the host', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'windows-mcp-attach-probe-'))
  const original = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, {
      HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      XDG_CONFIG_HOME: root, XDG_DATA_HOME: root, XDG_CACHE_HOME: root,
      XDG_STATE_HOME: root, TMPDIR: root, TMP: root, TEMP: root,
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'managed-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'managed-cache'),
      PATH: '', CI: '1',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'fixture-only-never-execute',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["fixture.cjs"]',
    })
    const { OpenCodeProvisioningProbe } = await import('../../src/services/opencode/OpenCodeProvisioningProbe.ts')
    const { buildManagedConfigFingerprint } = await import('../../src/services/opencode/OpenCodeProfileManager.ts')
    // Inventory and OS host acquisition are injected. MCP manager, HTTP
    // contracts and selected provisioning gates run unchanged. Native process
    // identity remains the separate Windows acceptance test's responsibility.
    for (const missing of [false, true]) {
      const server = missing ? createServer((_req, res) => res.end('{}')) : createFixtureServer()
      await withServer(server, async (baseUrl, factory) => {
        let released = 0
        const probe = new OpenCodeProvisioningProbe({
          inventoryService: {
            probe: async (projectPath, options) => {
              const scope = options!.profileScope!
              const profile = {
                projectPath: projectPath!, canonicalProjectPath: projectPath!, workingDirectoryPath: projectPath!,
                scopeToken: scope.scopeToken, profileScope: scope, profileRootKey: 'fixture', profileRootPath: root,
                projectBehaviorFingerprint: 'fixture', behaviorSources: [], managedConfig: {},
                managedConfigFingerprint: buildManagedConfigFingerprint({}),
                selectedSourceAuthIdentity: scope.selectedAuthIdentity,
                selectedManagedAuthIdentity: scope.selectedAuthIdentity,
                authState: 'ok' as const, env: {}, homePath: root, tmpPath: root,
                xdgConfigHome: root, xdgDataHome: root, xdgCacheHome: root,
                managedAuthPath: path.join(root, 'never-read-auth.json'), sourceAuthPath: null,
                sourceAuthFingerprint: null, managedAuthFingerprint: null,
              }
              return { detected: true, binaryPath: 'never-execute', version: '1.15.10', projectPath: projectPath!,
                profile, connectedProviders: [], availableProviders: [], models: [], agents: [],
                authStorePath: null, probeError: null, diagnostics: [] }
            },
          },
          hostManager: {
            ensureHost: async input => ({
              hostKey: 'fixture-host', profileRootKey: input.preparedProfile!.profileRootKey,
              projectPath: input.preparedProfile!.projectPath, projectBehaviorFingerprint: 'fixture',
              baseUrl, port: 0, pid: 123, version: '1.15.10', state: 'healthy', diagnostics: [],
              profile: input.preparedProfile!, resolvedConfigFingerprint: input.preparedProfile!.managedConfigFingerprint,
            }),
            releaseHost: async () => { released++ },
            refreshResolvedConfigFingerprint: async () => { throw new Error('unexpected broad probe') },
          },
          clientFactory: factory,
          mcpManager: new OpenCodeMcpManager({
            clientFactory: factory, env: {},
            resolveLaunchConfig: async () => ({ source: 'env-override', config }),
            verifyTimeoutMs: 20, verifyPollMs: 1,
          }),
        })
        const retained = await probe.probeRetainingHost(root, { selectedModel: 'opencode/big-pickle' })
        try {
          assert.equal(retained.snapshot.hostHealthy, !missing)
          assert.equal(retained.snapshot.appMcp?.status, missing ? 'attach_failed' : 'attached')
          assert.equal(retained.snapshot.probeError, missing ? 'OpenCode App MCP is unavailable' : null)
        } finally {
          await retained.release()
          await retained.release()
        }
        assert.equal(released, 1)
      })
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    rmSync(root, { recursive: true, force: true })
  }
})

test('fixture rejects malformed, unsupported and tool execution requests without attaching', async () => {
  await withServer(createFixtureServer(), async (baseUrl, factory, request) => {
    const client = factory.create(baseUrl)
    await assert.rejects(client.connectMcp!('agent-teams'), /404/)
    for (const body of [
      '{', 'null', '[]', JSON.stringify({ name: 'agent-teams' }),
      ...[
        { name: 'other', config },
        { name: '__proto__', config },
        { name: 'agent-teams', config: { ...config, enabled: false } },
        { name: 'agent-teams', config: { type: 'remote', url: 'http://127.0.0.1:1', enabled: true } },
        { name: 'agent-teams', config: { ...config, command: [] } },
        { name: 'agent-teams', config: { ...config, command: [42] } },
        { name: 'agent-teams', config: { ...config, environment: { bad: false } } },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task_create' } },
      ].map(value => JSON.stringify(value)),
    ]) {
      const response = await request(`${baseUrl}/mcp`, { method: 'POST', body })
      assert.equal(response.status, 400, body)
      assert.deepEqual(await client.getMcp(), {})
    }
    assert.equal((await request(`${baseUrl}/mcp`, { method: 'DELETE' })).status, 405)
    assert.equal((await request(`${baseUrl}/unexpected`)).status, 404)
    await client.addMcp!('agent-teams', config)
    await assert.rejects(client.addMcp!('agent-teams', { ...config, command: [] }), /400/)
    assert.deepEqual((await client.getConfig()).mcp, { 'agent-teams': config }, 'invalid reattach preserves prior config')
  })
})

test('fixture disposal invokes the same shutdown callback used by the bounded CLI', async () => {
  let disposed = false
  let resolveDisposed: () => void
  const closed = new Promise<void>(resolve => { resolveDisposed = resolve })
  const server = createFixtureServer(() => { disposed = true; resolveDisposed() })
  await withServer(server, async (baseUrl, _factory, request) => {
    assert.equal(await (await request(`${baseUrl}/global/dispose`, { method: 'POST' })).json(), true)
    await closed
    assert.equal(disposed, true)
  })
})
