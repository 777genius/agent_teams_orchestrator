import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ConfigEntry as FloorEntry } from '@opencode/client-v2-floor'
import type { ConfigEntry as CurrentEntry } from '@opencode/client'
import { OpenCodeInventoryService } from '../OpenCodeInventoryService.js'
import { inspectOpenCodeReadSelection } from '../compatibility/OpenCodeNativeIdentity.js'
import { acquireOpenCodeV2ReadHost } from '../host/OpenCodeHostNativeAdapter.js'
import { createOpenCodeV2ReadClient } from '../transport/OpenCodeV2ClientFactory.js'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'
import { readLocation, readRecord } from './OpenCodeV2ReadStatus.js'
import { getUnifiedRuntimeStatusPayload } from '../../runtimeBackends/registry.js'
import { isProcessAlive } from '../../../utils/processKill.js'

// Required explicit root invocation with BOTH exact native platform binaries. No pass-by-skip.
for (const pin of ['2.0.0', '2.0.32'] as const) test(`native ${pin} catalog/readiness/privacy/owned close`, async () => {
  const binary = process.env[pin === '2.0.0' ? 'TEST_OPENCODE_V2_FLOOR_BINARY' : 'TEST_OPENCODE_V2_CURRENT_BINARY']
  if (!binary || !path.isAbsolute(binary)) throw new Error(`Required verified native ${pin} binary is missing`)
  const git = Bun.which('git')
  if (!git || !path.isAbsolute(git)) throw new Error('Required git executable missing')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), `TEST-r150-v2-${pin}-`)))
  const project = path.join(root, 'TEST-project')
  let requests = 0
  const sentinel = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('unexpected model call', { status: 500 }) } })
  const envKeys = ['CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'TMPDIR', 'TMP', 'TEMP'] as const
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  let host: Awaited<ReturnType<typeof acquireOpenCodeV2ReadHost>> | undefined
  let client: Awaited<ReturnType<typeof createOpenCodeV2ReadClient>> | undefined
  let cleanupQualified = false
  try {
    await mkdir(project)
    for (const dir of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']) await mkdir(path.join(root, dir))
    await writeFile(path.join(project, '.test-project-owner.json'), JSON.stringify({ task: 'r150', pin, root, project }), { mode: 0o600 })
    await promisify(execFile)(git, ['init', '--quiet', project], { cwd: root, env: privateOpenCodeReadEnvironment(root) })
    const secret = 'test-fixture-literal'
    const config = {
      update: 'disable', plugins: [], warming: false, share: 'disabled', snapshots: false,
      model: 'TEST-provider/TEST-catalog', default_agent: 'TEST-agent',
      providers: { 'TEST-provider': { name: 'TEST provider', env: [], package: 'aisdk:@ai-sdk/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${sentinel.port}/v1`, apiKey: secret },
        models: { 'TEST-catalog': { modelID: 'TEST-upstream', name: 'TEST model',
          capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 },
          variants: [{ id: 'TEST-variant', settings: { apiKey: secret } }] } } } },
      agents: { 'TEST-agent': { mode: 'primary', model: 'TEST-provider/TEST-catalog',
        permissions: [{ action: '*', resource: '*', effect: 'deny' }] } },
    } satisfies Extract<FloorEntry, { type: 'document' }>['info'] & Extract<CurrentEntry, { type: 'document' }>['info']
    const original = JSON.stringify(config)
    const configPath = path.join(project, 'opencode.json')
    await writeFile(configPath, original)
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binary
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = path.join(root, 'tmp')
    const inventory = await new OpenCodeInventoryService().probe(project, { mode: 'full', includeAppMcp: false, bypassCache: true })
    expect(inventory.probeError).toBeNull()
    expect(inventory.readStatus?.catalog).toBe('ready')
    expect(inventory.readStatus?.models.find(model => model.providerId === 'TEST-provider' && model.catalogId === 'TEST-catalog'))
      .toMatchObject({ upstreamModelId: 'TEST-upstream', variants: ['TEST-variant'] })
    expect(inventory.readStatus?.agents.some(agent => agent.id === 'TEST-agent')).toBe(true)
    const status = await getUnifiedRuntimeStatusPayload('opencode', { getOpenCodeInventorySnapshot: async () => inventory })
    expect(status.providers.opencode).toMatchObject({ authenticated: false, capabilities: { teamLaunch: false, oneShot: false } })
    expect(JSON.stringify(status)).not.toContain(secret)
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect(requests).toBe(0)
    const selection = await inspectOpenCodeReadSelection()
    if (!selection.native || selection.native.version !== pin) throw new Error('Exact selected pin missing')
    host = await acquireOpenCodeV2ReadHost(selection.native, project)
    client = await createOpenCodeV2ReadClient(host.authority)
    const identity = readRecord(await client.client.identity())
    expect(identity.pid).toBe(host.authority.pid)
    readLocation(await client.client.location(project), project)
    await client.client.ready(project)
    const pid = host.authority.pid, baseUrl = host.authority.baseUrl
    await client.dispose(); client = undefined
    await host.close(); host = undefined
    expect(isProcessAlive(pid)).toBe(false)
    await expect(fetch(baseUrl)).rejects.toBeDefined()
    expect(requests).toBe(0)
    // The independently owned sentinel remains responsive after SDK-owned close.
    expect((await fetch(`http://127.0.0.1:${sentinel.port}`)).status).toBe(500)
    expect(await readFile(configPath, 'utf8')).toBe(original)
    cleanupQualified = true
  } finally {
    try { await client?.dispose() } finally {
      try { await host?.close() } finally {
        await sentinel.stop(true)
        for (const key of envKeys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] }
        // Retain failing/unknown-close roots for the root verifier; never erase live native state.
        if (cleanupQualified) await rm(root, { recursive: true, force: true })
      }
    }
  }
}, 120_000)
