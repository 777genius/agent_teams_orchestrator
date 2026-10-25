import { expect, mock, test } from 'bun:test'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import { stagedOpenCodeV2Pins } from '../compatibility/fixtures/stagedOpenCodeV2Pins.js'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionGraph, SelectedExecutionProfile } from './OpenCodeV2ExecutionBinding.js'
import type { ExecutionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { attachOpenCodeV2SelectedKey, initializeOpenCodeV2ExecutionAuth } from './OpenCodeV2ExecutionAuth.js'
import { importOpenCodeV2SelectedOAuth } from './OpenCodeV2ExecutionOAuth.js'

const legacy = { type: 'oauth', access: 'TEST-DUMMY-ACCESS', refresh: 'TEST-DUMMY-REFRESH', expires: 4_000_000_000_000,
  accountId: 'TEST-DUMMY-ACCOUNT', enterpriseUrl: 'https://TEST.invalid' }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-oauth-')))
  const env: Record<string, string> = {}
  for (const [key, relative] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp' })) {
    env[key] = path.join(root, relative); await mkdir(env[key]!, { recursive: true, mode: 0o700 })
  }
  const data = path.join(root, 'data/opencode'); await mkdir(data, { mode: 0o700 })
  const content = JSON.stringify({ openai: legacy }), auth = path.join(data, 'auth.json')
  await writeFile(auth, content, { mode: 0o600 })
  const profile: SelectedExecutionProfile = { root, epoch: 'TEST', directory: root, databasePath: path.join(data, 'opencode.db'),
    authSha256: digest(content), env, envSha256: executionHash(env),
    config: { directory: env.XDG_CONFIG_HOME!, content: '{}', sha256: digest('{}') },
    selection: { agent: 'build', model: { providerID: 'openai', id: 'gpt-5.5', variant: 'default' }, permissions: [] } }
  return { profile, auth, content, remove: () => rm(root, { recursive: true, force: true }) }
}

async function official(pin: OpenCodeV2Pin) {
  const modulePath = await realpath(Bun.resolveSync(`@opencode/server-v${pin}/process`, import.meta.dir))
  const locate = async (name: string) => realpath(Bun.resolveSync(name, modulePath))
  const effect: typeof import('effect') = await import(pathToFileURL(await locate('effect')).href)
  const { Database }: typeof import('@opencode/core/database/database') = await import(pathToFileURL(await locate('@opencode/core/database/database')).href)
  const { Credential }: typeof import('@opencode/core/credential') = await import(pathToFileURL(await locate('@opencode/core/credential')).href)
  const { Global }: typeof import('@opencode/util/global') = await import(pathToFileURL(await locate('@opencode/util/global')).href)
  const { LayerNode }: typeof import('@opencode/util/effect/layer-node') = await import(pathToFileURL(await locate('@opencode/util/effect/layer-node')).href)
  const { Integration }: typeof import('@opencode/schema/integration') = await import(pathToFileURL(await locate('@opencode/schema/integration')).href)
  const files = await Promise.all(['@opencode/core/database/database', '@opencode/core/credential', '@opencode/util/global',
    '@opencode/util/effect/layer-node', '@opencode/schema/integration',
    '@opencode/core/database/migration/20260805200742_import_legacy_credentials'].map(async name => {
    const file = await locate(name); return { path: file, sha256: await hashOpenCodeFile(file) }
  }))
  const graph: ExecutionGraph = { files, sha256: executionHash(files) }
  const { Effect } = effect
  async function records(profile: SelectedExecutionProfile, foreign = false) {
    const data = path.dirname(profile.databasePath)
    const layer = LayerNode.compile(LayerNode.group([Database.node, Credential.node]), { replacements: [
      Database.node.replace(Database.configured({ path: profile.databasePath })),
      Global.node.replace(Global.layerWith({ data, home: profile.env.HOME!, config: profile.config.directory,
        cache: profile.env.XDG_CACHE_HOME!, state: profile.env.XDG_STATE_HOME!, tmp: profile.env.TMPDIR!,
        bin: path.join(data, 'bin'), log: path.join(data, 'log'), repos: path.join(data, 'repos') })),
    ] })
    return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const credentials = yield* Credential.Service
      if (foreign) yield* credentials.create({ integrationID: Integration.ID.make('TEST-foreign'),
        value: Credential.Key.make({ type: 'key', key: 'TEST-DUMMY-FOREIGN' }) })
      return yield* credentials.all()
    }).pipe(Effect.provide(layer))))
  }
  return { graph, modulePath, effect, records }
}

for (const pin of stagedOpenCodeV2Pins) {
  test(`${pin}: official OAuth importer binds a fresh DB, preserves exact reuse and refuses recovery mismatches`, async () => {
    const f = await fixture(), native = await official(pin)
    try {
      await importOpenCodeV2SelectedOAuth(f.profile, native.graph, native.modulePath, native.effect)
      const first = await native.records(f.profile)
      expect(first.length).toBe(1)
      expect(String(first[0]!.integrationID)).toBe('openai')
      const imported: unknown = first[0]!.value
      expect(imported).toEqual({ type: 'oauth', methodID: 'chatgpt-browser', access: legacy.access,
        refresh: legacy.refresh, expires: legacy.expires,
        metadata: { accountID: legacy.accountId, enterpriseUrl: legacy.enterpriseUrl } })
      await importOpenCodeV2SelectedOAuth(f.profile, native.graph, native.modulePath, native.effect)
      expect((await native.records(f.profile)).map(row => row.id)).toEqual([first[0]!.id])
      expect(await readFile(f.auth, 'utf8')).toBe(f.content)
      const changed = JSON.stringify({ openai: { ...legacy, access: 'TEST-DUMMY-DIFFERENT' } })
      await writeFile(f.auth, changed)
      await expect(importOpenCodeV2SelectedOAuth(f.profile, native.graph, native.modulePath, native.effect))
        .rejects.toThrow('execution_selected_auth_changed')
      // A different bound selection cannot overwrite a native value, including a value changed by refresh.
      await expect(importOpenCodeV2SelectedOAuth({ ...f.profile, authSha256: digest(changed) },
        native.graph, native.modulePath, native.effect)).rejects.toThrow('execution_selected_oauth_recovery_required')
      expect((await native.records(f.profile)).map(row => ({ id: row.id, value: row.value })))
        .toEqual([{ id: first[0]!.id, value: first[0]!.value }])
    } finally { await f.remove() }
  }, 20_000)

  test(`${pin}: an existing empty or foreign native DB and an unsealed importer entry never permit OAuth import`, async () => {
    const f = await fixture(), native = await official(pin)
    try {
      const files = native.graph.files.filter(row => !row.path.includes('20260805200742_import_legacy_credentials'))
      await expect(importOpenCodeV2SelectedOAuth(f.profile, { files, sha256: executionHash(files) }, native.modulePath, native.effect))
        .rejects.toThrow('execution_graph_incomplete')
      expect(await readFile(f.profile.databasePath).then(() => true, () => false)).toBe(false)
      expect(await native.records(f.profile)).toEqual([])
      await expect(importOpenCodeV2SelectedOAuth(f.profile, native.graph, native.modulePath, native.effect))
        .rejects.toThrow('execution_selected_oauth_recovery_required')
      expect(await native.records(f.profile)).toEqual([])
      const foreign = await native.records(f.profile, true)
      await expect(importOpenCodeV2SelectedOAuth(f.profile, native.graph, native.modulePath, native.effect))
        .rejects.toThrow('execution_selected_oauth_recovery_required')
      expect((await native.records(f.profile)).map(row => ({ id: row.id, value: row.value })))
        .toEqual(foreign.map(row => ({ id: row.id, value: row.value })))
    } finally { await f.remove() }
  }, 20_000)
}

test('OAuth admission accepts optional public Codex settings and requires one connection and the exact enabled model', async () => {
  const f = await fixture(), location = { directory: f.profile.directory }
  let mutations = 0
  const provider = { id: 'openai', integrationID: 'openai', activation: 'enabled',
    settings: { baseURL: 'https://chatgpt.com/backend-api/codex' } }
  const model = { providerID: 'openai', id: 'gpt-5.5', enabled: true, status: 'active' }
  const connection = { type: 'credential', id: 'cred_TESToriginal' }
  const integration = { id: 'openai', methods: [{ type: 'oauth', id: 'chatgpt-browser' }], connections: [connection] }
  const port = {
    providers: async () => ({ location, data: [provider] }), integration: async () => ({ location, data: integration }),
    models: async () => ({ location, data: [model] }), connect: async () => { mutations++ },
  }
  const autoPort = { ...port, providers: async () => ({ location, data: [{ ...provider, activation: 'auto' }] }) }
  try {
    await attachOpenCodeV2SelectedKey(f.profile, port) // floor metadata omits method
    await attachOpenCodeV2SelectedKey(f.profile, { ...port, integration: async () =>
      ({ location, data: { ...integration, connections: [{ ...connection, method: 'oauth' }] } }) })
    await attachOpenCodeV2SelectedKey(f.profile, autoPort)
    await attachOpenCodeV2SelectedKey(f.profile, { ...autoPort, integration: async () =>
      ({ location, data: { ...integration, connections: [{ ...connection, method: 'oauth' }] } }) })
    for (const settings of [{}, undefined]) {
      const publicPort = { ...autoPort, providers: async () =>
        ({ location, data: [{ ...provider, activation: 'auto', settings }] }) }
      await attachOpenCodeV2SelectedKey(f.profile, publicPort) // floor metadata omits connection method
      await attachOpenCodeV2SelectedKey(f.profile, { ...publicPort, integration: async () =>
        ({ location, data: { ...integration, connections: [{ ...connection, method: 'oauth' }] } }) })
    }
    for (const [changed, code] of [
      [{ ...autoPort, providers: async () => ({ location, data: [{ ...provider, activation: 'disabled' }] }) }, 'execution_selected_oauth_provider_unknown'],
      [{ ...autoPort, providers: async () => ({ location, data: [{ ...provider, settings: { baseURL: 'https://TEST.invalid' } }] }) }, 'execution_selected_oauth_provider_unknown'],
      [{ ...autoPort, providers: async () => ({ location, data: [{ ...provider, settings: { baseURL: 'https://api.openai.com/v1' } }] }) }, 'execution_selected_oauth_provider_unknown'],
      [{ ...autoPort, providers: async () => ({ location, data: [{ ...provider, settings: { baseURL: null } }] }) }, 'execution_selected_oauth_provider_unknown'],
      [{ ...autoPort, integration: async () => ({ location, data: { ...integration, connections: [] } }) }, 'execution_selected_oauth_connection_unknown'],
      [{ ...autoPort, integration: async () => ({ location, data: { ...integration, connections: [connection, connection] } }) }, 'execution_selected_oauth_connection_unknown'],
      [{ ...autoPort, integration: async () => ({ location, data: { ...integration, connections: [{ ...connection, method: 'key' }] } }) }, 'execution_selected_oauth_connection_unknown'],
      [{ ...autoPort, integration: async () => ({ location, data: { ...integration, methods: [{ type: 'key' }] } }) }, 'execution_selected_oauth_integration_unknown'],
      [{ ...autoPort, models: async () => ({ location, data: [{ ...model, enabled: false }] }) }, 'execution_selected_oauth_model_unknown'],
      [{ ...autoPort, models: async () => ({ location, data: [{ ...model, id: 'other' }] }) }, 'execution_selected_oauth_model_unknown'],
      [{ ...autoPort, models: async () => ({ location: { directory: f.profile.directory + '-other' }, data: [model] }) }, 'execution_selected_auth_location_changed'],
    ] as const) await expect(attachOpenCodeV2SelectedKey(f.profile, changed)).rejects.toThrow(code)
    expect(mutations).toBe(0)
    expect(await readFile(f.auth, 'utf8')).toBe(f.content)
  } finally { await f.remove() }
})

test('initial auth waits for the pin-specific native activation barrier before reading OAuth metadata', async () => {
  const pin = process.env.TEST_OPENCODE_V2_AUTH_BARRIER_PIN
  if (pin !== '2.0.0' && pin !== '2.0.32') {
    // The endpoint mock stays in isolated processes, matching the existing Wire test seam.
    for (const selected of ['2.0.32', '2.0.0']) {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', 'initial auth waits'], {
        env: { ...process.env, TEST_OPENCODE_V2_AUTH_BARRIER_PIN: selected }, stdout: 'pipe', stderr: 'pipe',
      })
      try {
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect({ selected, exit, output: exit === 0 ? '' : stdout + stderr }).toEqual({ selected, exit: 0, output: '' })
      } finally { if (child.exitCode === null) child.kill(); await child.exited }
    }
    return
  }
  const f = await fixture(), seen = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const location = { directory: f.profile.directory }, calls: string[] = []
  const integration = { id: 'openai', methods: [{ type: 'oauth', id: 'chatgpt-browser' }],
    connections: [{ type: 'credential', id: 'cred_TESToriginal', ...(pin === '2.0.32' ? { method: 'oauth' } : {}) }] }
  const expectedBarrier = pin === '2.0.0' ? 'POST /api/plugin/await-activation' : 'GET /api/integration'
  let activated = false, disposers = 0
  const endpoint = { baseUrl: 'http://127.0.0.1:1', password: 'TEST-DUMMY-ENDPOINT', signal: new AbortController().signal,
    fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init)
      const url = new URL(request.url), call = request.method + ' ' + url.pathname
      expect(url.searchParams.get('location[directory]')).toBe(f.profile.directory)
      calls.push(call)
      if (call === expectedBarrier) {
        seen.resolve(); await release.promise; activated = true
        if (pin === '2.0.0') return new Response(null, { status: 204 })
      }
      if (!activated) throw new Error('TEST-metadata-before-activation')
      const data = url.pathname === '/api/integration' ? [integration] : url.pathname === '/api/integration/openai' ? integration
        : url.pathname === '/api/provider' ? [{ id: 'openai', integrationID: 'openai', activation: 'auto',
          settings: {} }]
        : url.pathname === '/api/model' ? [{ providerID: 'openai', id: 'gpt-5.5', enabled: true, status: 'active' }] : null
      expect(data).not.toBeNull()
      return Response.json({ location, data })
    }, { preconnect() { throw new Error('TEST-preconnect-forbidden') } }),
  }
  const authority: ExecutionAuthority = { generation: 'v2', pin, dialect: `v2-${pin}`, graphSha256: 'a'.repeat(64),
    selectedCli: { path: '/TEST-native', sha256: 'b'.repeat(64), version: pin },
    child: { pid: 1, birth: { format: 'utc-ms', value: '1', bootId: null }, executablePath: '/TEST-bun', sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileRoot: f.profile.root, profileEpoch: f.profile.epoch,
    directory: f.profile.directory, leaseOwnerId: 'TEST-owner' }
  const hostModuleUrl = pathToFileURL(import.meta.dir + '/OpenCodeV2ExecutionHost.ts').href
  const originalHostModule = await import(hostModuleUrl)
  mock.module(hostModuleUrl, () => ({
    requireExecutionEndpoint: () => endpoint,
    registerExecutionDisposer: () => { disposers++; return () => { disposers-- } },
  }))
  let work: Promise<void> | undefined
  try {
    work = initializeOpenCodeV2ExecutionAuth(authority, f.profile,
      { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'TEST-member', deadline: Date.now() + 3000 })
    await Promise.race([seen.promise, work.then(() => { throw new Error('TEST-activation-barrier-omitted') })])
    expect(calls).toEqual([expectedBarrier])
    release.resolve(); await work
    expect(calls).toEqual([expectedBarrier, 'GET /api/provider', 'GET /api/integration/openai', 'GET /api/model'])
    expect(disposers).toBe(0)
  } finally {
    release.resolve()
    await work?.catch(() => undefined)
    mock.module(hostModuleUrl, () => originalHostModule)
    await f.remove()
  }
}, 15_000)



test('selected auth SHA metadata gates consumption and never leaks credential fragments', async () => {
  const f = await fixture()
  let providerCalls = 0, connectCalls = 0
  const port = {
    providers: async () => { providerCalls++; throw new Error('TEST-connect-before-qualification') },
    integration: async () => { throw new Error('TEST-connect-before-qualification') },
    models: async () => { throw new Error('TEST-connect-before-qualification') },
    connect: async () => { connectCalls++ },
  }
  try {
    let message = ''
    try {
      await attachOpenCodeV2SelectedKey(f.profile, port, {
        metadata: { read: async () => ({ sha256: digest(f.content), bytes: f.content.length + 1 }) }, deadline: Date.now() + 1000,
      })
    } catch (error) { message = error instanceof Error ? error.message : String(error) }
    expect(message).toBe('execution_selected_auth_changed')
    expect(message).not.toContain('TEST-DUMMY-ACCESS')
    expect(providerCalls).toBe(0)
    expect(connectCalls).toBe(0)

    await writeFile(f.auth, `${f.content}TEST-LOCAL-CHANGE`)
    await expect(attachOpenCodeV2SelectedKey(f.profile, port, {
      metadata: { read: async () => ({ sha256: digest(f.content), bytes: f.content.length }) }, deadline: Date.now() + 1000,
    })).rejects.toThrow('execution_selected_auth_changed')
    expect(providerCalls).toBe(0)
    expect(connectCalls).toBe(0)

    const apiContent = JSON.stringify({ openai: { type: 'api', key: 'TEST-DUMMY-KEY' } })
    await writeFile(f.auth, apiContent)
    const profile = { ...f.profile, authSha256: digest(apiContent) }
    let connected: Record<string, unknown> | null = null, integrationCalls = 0, metadataCalls = 0
    await attachOpenCodeV2SelectedKey(profile, {
      providers: async () => ({ location: { directory: profile.directory }, data: [{ id: 'openai', integrationID: 'openai', activation: 'enabled' }] }),
      integration: async () => {
        integrationCalls++
        return { location: { directory: profile.directory }, data: {
          id: 'openai', methods: [{ type: 'key' }], connections: connected ? [connected] : [],
        } }
      },
      connect: async (_id, key) => {
        expect(key).toBe('TEST-DUMMY-KEY')
        expect(connected).toBeNull()
        connected = { type: 'credential', id: 'cred_TESTselected' }
        connectCalls++
      },
    }, { metadata: { read: async () => {
      metadataCalls++
      return { sha256: digest(apiContent), bytes: apiContent.length }
    } }, deadline: Date.now() + 1000 })
    expect(connectCalls).toBe(1)
    expect(integrationCalls).toBe(2)
    expect(metadataCalls).toBeGreaterThanOrEqual(4)

    connected = null
    let freshnessMetadataCalls = 0
    await expect(attachOpenCodeV2SelectedKey(profile, {
      providers: async () => ({ location: { directory: profile.directory }, data: [{ id: 'openai', integrationID: 'openai', activation: 'enabled' }] }),
      integration: async () => ({ location: { directory: profile.directory }, data: {
        id: 'openai', methods: [{ type: 'key' }], connections: connected ? [connected] : [],
      } }),
      connect: async () => { connected = { type: 'credential', id: 'cred_TESTunexpected' }; connectCalls++ },
    }, { metadata: { read: async () => {
      freshnessMetadataCalls++
      return freshnessMetadataCalls < 3
        ? { sha256: digest(apiContent), bytes: apiContent.length }
        : { sha256: digest(apiContent), bytes: apiContent.length + 1 }
    } }, deadline: Date.now() + 1000 })).rejects.toThrow('execution_selected_auth_changed')
    expect(connectCalls).toBe(1)
  } finally { await f.remove() }
})
