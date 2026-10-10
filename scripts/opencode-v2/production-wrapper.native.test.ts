import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfigEntry as FloorEntry } from '@opencode/client-v2-floor'
import type { ConfigEntry as CurrentEntry } from '@opencode/client'
import { privateOpenCodeReadEnvironment } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { readRecord } from '../../src/services/opencode/catalog/OpenCodeV2ReadStatus.js'

const workspace = path.resolve(import.meta.dir, '../..')

// Requires a real production build first. This regression fails if the wrapper
// depends on src, a parent node_modules, a missing child, or mixed pin graphs.
for (const pin of ['2.0.0', '2.0.21'] as const) test(`sourceless production wrapper reads official ${pin} and keeps summary passive`, async () => {
  if (process.platform !== 'linux') throw new Error('This packaging gate qualifies Linux only')
  const binary = process.env[pin === '2.0.0' ? 'TEST_OPENCODE_V2_FLOOR_BINARY' : 'TEST_OPENCODE_V2_CURRENT_BINARY']
  if (!binary || !path.isAbsolute(binary)) throw new Error(`Required verified ${pin} native binary missing`)
  const git = Bun.which('git')
  if (!git) throw new Error('Required git executable missing')
  // Keep all test artifacts in the owned workspace. Resolution checks below
  // require the selected graphs inside the copied installation. The root operator
  // additionally bounds and verifies the subprocess namespace after this test.
  const scratch = path.join(workspace, '.r188-handoff/packaging-tests')
  await mkdir(scratch, { recursive: true })
  const root = await realpath(await mkdtemp(path.join(scratch, `TEST-${pin}-`)))
  const installation = path.join(root, 'installation'), project = path.join(root, 'TEST-project')
  let requests = 0, qualified = false
  const sentinel = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch() { requests++; return new Response('unexpected model request', { status: 500 }) } })
  try {
    for (const directory of ['installation', 'TEST-project', 'home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']) {
      await mkdir(path.join(root, directory))
    }
    await writeFile(path.join(root, '.test-project-owner.json'), JSON.stringify({ task: 'r188-packaging', pin, root }))
    await cp(path.join(workspace, 'cli'), path.join(installation, 'cli'))
    await cp(path.join(workspace, 'dist/local-cli'), path.join(installation, 'dist/local-cli'), {
      recursive: true, dereference: false, verbatimSymlinks: true,
    })
    expect(await lstat(path.join(installation, 'src')).then(() => true, () => false)).toBe(false)
    const graphRoot = path.join(installation, 'dist/local-cli')
    for (const specifier of ['@opencode/server/process', '@opencode/server-v2-floor/process', '@opencode/client', '@opencode/client-v2-floor']) {
      const resolved = await realpath(Bun.resolveSync(specifier, graphRoot))
      expect(resolved.startsWith(graphRoot + path.sep)).toBe(true)
    }
    const env = { ...privateOpenCodeReadEnvironment(root), CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: binary }
    await promisify(execFile)(git, ['init', '--quiet', project], { cwd: root, env })
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
    const original = JSON.stringify(config), configPath = path.join(project, 'opencode.json')
    await writeFile(configPath, original)
    const run = async (summary: boolean, selected = binary) => {
      const child = Bun.spawn([path.join(installation, 'cli'), 'runtime', 'status', '--provider', 'opencode',
        ...(summary ? ['--summary'] : []), '--json'], {
        cwd: project, env: { ...env, CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: selected },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 75_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        expect(timedOut).toBe(false)
        expect(code).toBe(0)
        expect(stdout + stderr).not.toContain(secret)
        const result = readRecord(JSON.parse(stdout))
        expect(result.schemaVersion).toBe(2)
        return readRecord(readRecord(result.providers).opencode)
      } finally { clearTimeout(timer) }
    }
    const status = await run(false)
    expect(status).toMatchObject({ authenticated: false, verificationState: 'unknown',
      capabilities: { teamLaunch: false, oneShot: false }, modelCatalog: { status: 'ready' } })
    const read = readRecord(status.openCodeReadStatus)
    expect(read).toMatchObject({ version: pin, catalog: 'ready', authentication: 'unknown', teamLaunch: false, oneShot: false })
    expect(read.models).toContainEqual(expect.objectContaining({ providerId: 'TEST-provider', catalogId: 'TEST-catalog',
      upstreamModelId: 'TEST-upstream', variants: ['TEST-variant'] }))
    expect(read.agents).toContainEqual({ id: 'TEST-agent', mode: 'primary' })
    expect(requests).toBe(0)
    expect(await readFile(configPath, 'utf8')).toBe(original)
    // Successfully closed leases must leave no private version-probe/server roots.
    expect((await readdir(path.join(root, 'tmp'))).filter(name => name.startsWith('opencode-v2-read-'))).toEqual([])
    expect(await run(true)).toMatchObject({ authenticated: false, capabilities: { teamLaunch: false } })
    // This executable sentinel makes a summary version probe observable without
    // modifying the installed official executable. There is no server entry to
    // rescue an accidental summary acquisition either.
    const trap = path.join(root, 'summary-native-trap'), marker = path.join(root, 'summary-native-started')
    await writeFile(trap, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)}, 'started'); console.log(${JSON.stringify(pin)});\n`)
    await chmod(trap, 0o755)
    await rm(path.join(installation, 'dist/local-cli/opencodeV2Server.js'))
    await run(true, trap)
    expect(await lstat(marker).then(() => true, () => false)).toBe(false)
    expect(requests).toBe(0)
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect((await readdir(path.join(root, 'tmp'))).filter(name => name.startsWith('opencode-v2-read-'))).toEqual([])
    qualified = true
  } finally {
    await sentinel.stop(true)
    // Preserve unqualified roots for the outer owned-process verifier.
    if (qualified) await rm(root, { recursive: true, force: true })
  }
}, 180_000)
