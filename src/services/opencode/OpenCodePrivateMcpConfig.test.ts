import { expect, test } from 'bun:test'
import { privateMcpConfigurationMatches } from './OpenCodePrivateMcpConfig.js'
import { buildResolvedConfigFingerprint } from './OpenCodeResolvedConfigFingerprint.js'
import { OpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { OpenCodeMcpManager } from './OpenCodeMcpManager.js'
import { OPEN_CODE_APP_MCP_SERVER_NAME } from './OpenCodeAppMcpName.js'
import { supervisedFixture, supervisedTestStage } from './OpenCodeSupervisedCustody.test-fixture.js'

const config = () => ({ mcp: { [OPEN_CODE_APP_MCP_SERVER_NAME]: {
  type: 'local' as const, command: ['node', '/admitted/mcp.cjs'], enabled: true,
  environment: { TOKEN: 'private-token-one', PATH: '/admitted/bin', EMPTY: '' },
} } })

test('private MCP equality includes every value, key, field presence and array order', () => {
  const expected = config()
  expect(privateMcpConfigurationMatches(expected, structuredClone(expected))).toBe(true)
  const changes = [
    (value: any) => { value.environment.TOKEN = 'private-token-two' },
    (value: any) => { value.environment.PATH = '/other/bin' },
    (value: any) => { delete value.environment.EMPTY },
    (value: any) => { value.environment.EXTRA = 'extra' },
    (value: any) => { delete value.environment },
    (value: any) => { delete value.command },
    (value: any) => { value.command.reverse() },
    (value: any) => { value.enabled = false },
    (value: any) => { value.url = 'https://other.invalid/private' },
  ]
  for (const change of changes) {
    const actual = config(); change(actual.mcp[OPEN_CODE_APP_MCP_SERVER_NAME])
    expect(privateMcpConfigurationMatches(expected, actual)).toBe(false)
  }
  expect(privateMcpConfigurationMatches({}, { mcp: {} })).toBe(false)
  expect(privateMcpConfigurationMatches({ mcp: { one: {} } }, { mcp: { one: { environment: {} } } })).toBe(false)
  const actual = config(); actual.mcp[OPEN_CODE_APP_MCP_SERVER_NAME].environment.TOKEN = 'collision'
  const observations = (data: unknown) => ({ config: { status: 200, data },
    configProviders: { status: 200, data: {} }, agents: { status: 200, data: [] }, mcp: { status: 200, data: {} } })
  expect(buildResolvedConfigFingerprint(observations(expected))).toBe(buildResolvedConfigFingerprint(observations(actual)))
  expect(privateMcpConfigurationMatches(expected, actual)).toBe(false)
})

test('supervised manager reads complete live private configuration despite matching MCP status', async () => {
  let live = config()
  const fixture = await supervisedFixture({ handle(request, response) {
    response.end(JSON.stringify(request.url === '/config' ? live :
      { [OPEN_CODE_APP_MCP_SERVER_NAME]: { status: 'connected' } }))
  } })
  fixture.profile.managedConfig = config()
  try {
    const custody = await fixture.acquire()
    const policy = { mode: 'supervisor-adopt-only' as const, custody }
    const factory = new OpenCodeClientFactory({ acquisitionPolicy: policy })
    const manager = new OpenCodeMcpManager({ acquisitionPolicy: policy, clientFactory: factory })
    const params = { baseUrl: custody.expected.endpoint.baseUrl, attachIfMissing: true }
    expect((await manager.ensureAppMcp(params)).summary.status).toBe('present')
    const token = await custody.prepareEffectToken()
    live = config(); live.mcp[OPEN_CODE_APP_MCP_SERVER_NAME].environment.TOKEN = 'private-token-two'
    const error = await manager.ensureAppMcp(params).catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain('private-token')
    expect(token!.consume()).toBe(false)
    expect(fixture.requests.some(request => request.method === 'POST')).toBe(false)
  } finally { await fixture.close() }
}, 120_000)

test('same-process MCP mutation revokes prepared dispatch authority synchronously before any HTTP write', async () => {
  const fixture = await supervisedFixture()
  try {
    const custody = await fixture.acquire()
    const token = await custody.prepareOperationToken({ kind: 'provider', name: 'session-create', method: 'POST', path: '/session' })
    const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
      .create(custody.expected.endpoint.baseUrl)
    const mutation = client.addMcp('other', { type: 'local', command: ['node', '/other.cjs'], environment: { TOKEN: 'private' } })
    expect(token!.consume()).toBe(false)
    await expect(mutation).rejects.toThrow()
    expect(fixture.requests).toHaveLength(0)
    expect(fixture.connections).toHaveLength(0)
  } finally { await fixture.close() }
}, 120_000)

test('a concurrent mutation cancels an exchange paused after retention and before socket dispatch', async () => {
  let entered!: () => void, release!: () => void
  const staged = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const fixture = await supervisedFixture({ async sync(observation) {
    if (observation?.phase === 'request') { entered(); await held }
  } })
  try {
    const custody = await fixture.acquire()
    const client = new OpenCodeClientFactory({ acquisitionPolicy: { mode: 'supervisor-adopt-only', custody } })
      .create(custody.expected.endpoint.baseUrl)
    const pending = client.getMcp().catch(error => error)
    await supervisedTestStage(staged, pending, 'MCP observation retention')
    const mutation = client.addMcp('other', { type: 'local', command: ['node', '/other.cjs'] }).catch(error => error)
    release()
    expect(await pending).toBeInstanceOf(Error)
    expect(await mutation).toBeInstanceOf(Error)
    expect(fixture.requests).toHaveLength(0)
    expect(fixture.connections).toHaveLength(0)
  } finally { release(); await fixture.close() }
}, 120_000)
