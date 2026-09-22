import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  buildCursorAgentResourceExhaustedPreloadScript,
  patchCursorAgentResourceExhaustedClassification,
} from './OpenCodeCursorResourceExhaustedPatch.js'
import { buildCursorAgentPreloadRequireOption } from './OpenCodeProfileManager.js'
import {
  PROCESS_ATTRIBUTION_DIRECTORY_ENV,
  PROCESS_ATTRIBUTION_ID_ENV,
  PROCESS_ATTRIBUTION_KIND_ENV,
  buildCursorAgentAttributionPreloadScript,
  mintProcessAttributionId,
  processAttributionAgentDirectoryPath,
  pruneStaleAttributionRecords,
  readAttributionRecords,
} from './OpenCodeProcessAttributionStore.js'

const CURSOR_CLASSIFIER_FIXTURE = [
  'const c={yM:{',
  "FREE_USER_USAGE_LIMIT:'free',",
  "GENERIC_RATE_LIMIT_EXCEEDED:'generic',",
  "RESOURCE_EXHAUSTED:'resource'",
  '}};',
  'R=new Set([c.yM.FREE_USER_USAGE_LIMIT,c.yM.GENERIC_RATE_LIMIT_EXCEEDED]);',
].join('')

describe('OpenCodeCursorResourceExhaustedPatch', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(tempDir =>
      rm(tempDir, { recursive: true, force: true })
    ))
  })

  test('adds RESOURCE_EXHAUSTED to the unique Cursor action-required set', () => {
    const result = patchCursorAgentResourceExhaustedClassification(
      CURSOR_CLASSIFIER_FIXTURE,
    )

    expect(result).toMatchObject({ applied: true, compatible: true })
    expect(result.source).toContain(
      'c.yM.GENERIC_RATE_LIMIT_EXCEEDED,c.yM.RESOURCE_EXHAUSTED',
    )
    expect(
      patchCursorAgentResourceExhaustedClassification(result.source),
    ).toMatchObject({ applied: false, compatible: true })
  })

  test('fails closed when the Cursor bundle shape is ambiguous', () => {
    const result = patchCursorAgentResourceExhaustedClassification(
      `${CURSOR_CLASSIFIER_FIXTURE}${CURSOR_CLASSIFIER_FIXTURE}`,
    )

    expect(result).toEqual({
      source: `${CURSOR_CLASSIFIER_FIXTURE}${CURSOR_CLASSIFIER_FIXTURE}`,
      applied: false,
      compatible: false,
    })
  })

  test('preload patches the entry module and does not leak itself through NODE_OPTIONS', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-resource-patch-'))
    tempDirs.push(tempDir)
    const preloadPath = path.join(tempDir, 'resource-exhausted-preload.cjs')
    const entryPath = path.join(tempDir, 'index.js')
    await Promise.all([
      writeFile(preloadPath, buildCursorAgentResourceExhaustedPreloadScript(), 'utf8'),
      writeFile(
        entryPath,
        `${CURSOR_CLASSIFIER_FIXTURE}process.stdout.write(JSON.stringify({patched:R.has(c.yM.RESOURCE_EXHAUSTED),nodeOptions:process.env.NODE_OPTIONS||null}))`,
        'utf8',
      ),
    ])

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [entryPath], {
        env: {
          ...process.env,
          NODE_OPTIONS: `${buildCursorAgentPreloadRequireOption(preloadPath)} --no-warnings`,
          AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '--no-warnings',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`node exited with ${code}: ${stderr}`))
      })
    })

    expect(JSON.parse(output)).toEqual({
      patched: true,
      nodeOptions: '--no-warnings',
    })
  })

  test('preload restores the loader after an incompatible entry module', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-resource-patch-'))
    tempDirs.push(tempDir)
    const preloadPath = path.join(tempDir, 'resource-exhausted-preload.cjs')
    const entryPath = path.join(tempDir, 'index.js')
    const secondaryPath = path.join(tempDir, 'secondary.js')
    await Promise.all([
      writeFile(preloadPath, buildCursorAgentResourceExhaustedPreloadScript(), 'utf8'),
      writeFile(
        entryPath,
        "process.stdout.write(JSON.stringify({patched:require('./secondary.js')}))",
        'utf8',
      ),
      writeFile(
        secondaryPath,
        `${CURSOR_CLASSIFIER_FIXTURE}module.exports=R.has(c.yM.RESOURCE_EXHAUSTED)`,
        'utf8',
      ),
    ])

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [entryPath], {
        env: {
          ...process.env,
          NODE_OPTIONS: buildCursorAgentPreloadRequireOption(preloadPath),
          AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`node exited with ${code}: ${stderr}`))
      })
    })

    expect(JSON.parse(output)).toEqual({ patched: false })
  })

  // The generated shim publishes one preload file with both responsibilities;
  // the tests below run it the same way the shim does.
  function buildCursorAgentPreloadSource(): string {
    return [
      buildCursorAgentAttributionPreloadScript(),
      buildCursorAgentResourceExhaustedPreloadScript(),
    ].join('\n')
  }

  // The preload clears AGENT_TEAMS_PROCESS_ATTRIBUTION_* once it has written,
  // so the fixture reads the store through copies under names it never touches
  // and reports the real names as the agent's descendants would see them.
  const AGENT_ENTRY_SOURCE = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    'const report = () => {',
    "  const directory = process.env.ATTRIBUTION_FIXTURE_DIR || ''",
    "  const attributionId = process.env.ATTRIBUTION_FIXTURE_ID || ''",
    '  let records = []',
    '  if (directory && attributionId) {',
    "    const recordDirectory = path.join(directory, 'v1', 'agents', attributionId)",
    '    try {',
    '      records = fs.readdirSync(recordDirectory).map(name => ({',
    '        name: name,',
    "        record: JSON.parse(fs.readFileSync(path.join(recordDirectory, name), 'utf8')),",
    '      }))',
    '    } catch (error) { records = [] }',
    '  }',
    '  return {',
    '    pid: process.pid,',
    '    records: records,',
    '    nodeOptions: process.env.NODE_OPTIONS || null,',
    '    attributionEnv: {',
    '      directory: process.env.AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR || null,',
    '      id: process.env.AGENT_TEAMS_PROCESS_ATTRIBUTION_ID || null,',
    '      kind: process.env.AGENT_TEAMS_PROCESS_ATTRIBUTION_KIND || null,',
    '    },',
    '  }',
    '}',
  ].join('\n')

  async function writeAgentFixture(input: {
    tempDir: string
    entrySource: string
  }): Promise<{ preloadPath: string; entryPath: string }> {
    const preloadPath = path.join(input.tempDir, 'cursor-agent-preload.cjs')
    const entryPath = path.join(input.tempDir, 'index.js')
    await Promise.all([
      writeFile(preloadPath, buildCursorAgentPreloadSource(), 'utf8'),
      writeFile(entryPath, input.entrySource, 'utf8'),
    ])
    return { preloadPath, entryPath }
  }

  function spawnAgent(input: {
    preloadPath: string
    entryPath: string
    args?: string[]
    env?: NodeJS.ProcessEnv
  }): ReturnType<typeof spawn> {
    return spawn('node', [input.entryPath, ...(input.args ?? [])], {
      env: {
        ...process.env,
        NODE_OPTIONS: buildCursorAgentPreloadRequireOption(input.preloadPath),
        AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '',
        ATTRIBUTION_FIXTURE_DIR: input.env?.[PROCESS_ATTRIBUTION_DIRECTORY_ENV] ?? '',
        ATTRIBUTION_FIXTURE_ID: input.env?.[PROCESS_ATTRIBUTION_ID_ENV] ?? '',
        ...input.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  async function collectAgentOutput(child: ReturnType<typeof spawn>): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`node exited with ${code}: ${stderr}`))
      })
    })
  }

  async function waitForAgentReport(child: ReturnType<typeof spawn>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once('data', () => resolve())
      child.once('error', reject)
      child.once('close', () => reject(new Error('agent exited before reporting')))
    })
  }

  async function killAgent(child: ReturnType<typeof spawn>): Promise<void> {
    child.kill('SIGKILL')
    await new Promise<void>(resolve => { child.once('close', () => resolve()) })
  }

  test('records the spawned agent tree with its own pid and its exact workspace argument', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-attribution-'))
    tempDirs.push(tempDir)
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const attributionId = mintProcessAttributionId()
    // A joined command line cannot decide where this argument ends; argv can.
    const workspacePath = path.join(tempDir, 'app - backup -- copy')
    const { preloadPath, entryPath } = await writeAgentFixture({
      tempDir,
      entrySource: `${AGENT_ENTRY_SOURCE}\nprocess.stdout.write(JSON.stringify(report()))`,
    })

    const child = spawnAgent({
      preloadPath,
      entryPath,
      args: ['--print', '--workspace', workspacePath, '--model', 'auto'],
      env: {
        [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: attributionDirectory,
        [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
        CLAUDE_TEAM_APP_INSTANCE_ID: 'app-instance-1',
        CLAUDE_TEAM_APP_PROFILE_SCOPE: 'scope-a',
        AGENT_TEAMS_PROCESS_ATTRIBUTION_RUNTIME_VERSION: '0.0.95',
      },
    })
    const childPid = child.pid
    const observed = JSON.parse(await collectAgentOutput(child)) as {
      pid: number
      nodeOptions: string | null
      records: Array<{ name: string; record: Record<string, unknown> }>
      attributionEnv: { directory: string | null; id: string | null; kind: string | null }
    }

    expect(observed.pid).toBe(childPid ?? -1)
    expect(observed.records).toHaveLength(1)
    const written = observed.records[0]
    expect(written?.record).toMatchObject({
      schemaVersion: 1,
      kind: 'cursor-agent',
      attributionId,
      pid: childPid,
      parentPid: process.pid,
      workspacePath,
      appInstanceId: 'app-instance-1',
      appProfileScope: 'scope-a',
      runtimeVersion: '0.0.95',
      exitedAtMs: null,
    })
    expect(written?.name).toBe(`${childPid}-${written?.record.startedAtMs}.json`)
    expect(Math.abs(Number(written?.record.startedAtMs) - Date.now())).toBeLessThan(60_000)
    // The preload must not leak itself into anything the agent spawns: neither
    // its own --require nor the identity that would let a descendant record
    // itself as a second agent under the same id.
    expect(observed.nodeOptions).toBeNull()
    expect(observed.attributionEnv).toEqual({ directory: null, id: null, kind: null })

    // A normal exit takes the record with it.
    expect(await readAttributionRecords(attributionDirectory)).toMatchObject({
      hosts: [],
      agents: [],
    })
  })

  test('leaves a killed agent record behind for the reader to judge stale', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-attribution-'))
    tempDirs.push(tempDir)
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const attributionId = mintProcessAttributionId()
    const { preloadPath, entryPath } = await writeAgentFixture({
      tempDir,
      entrySource: [
        AGENT_ENTRY_SOURCE,
        'process.stdout.write(JSON.stringify(report()))',
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    })

    const child = spawnAgent({
      preloadPath,
      entryPath,
      args: ['--workspace', tempDir],
      env: {
        [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: attributionDirectory,
        [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
      },
    })
    await waitForAgentReport(child)
    const killedPid = child.pid ?? -1
    await killAgent(child)

    const survived = await readAttributionRecords(attributionDirectory)
    expect(survived.agents.map(agent => agent.record.pid)).toEqual([killedPid])

    // The record is identity, never liveness: the reader has to judge it.
    const pruned = await pruneStaleAttributionRecords(attributionDirectory, {
      isProcessAlive: pid => pid !== killedPid,
    })
    expect(pruned.prunedAgents).toBe(1)
    expect((await readAttributionRecords(attributionDirectory)).agents).toEqual([])
  })

  test('writes nothing and still runs the agent when no directory is designated', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-attribution-'))
    tempDirs.push(tempDir)
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const { preloadPath, entryPath } = await writeAgentFixture({
      tempDir,
      entrySource: `${AGENT_ENTRY_SOURCE}\nprocess.stdout.write(JSON.stringify(report()))`,
    })

    const observed = JSON.parse(await collectAgentOutput(spawnAgent({
      preloadPath,
      entryPath,
      args: ['--workspace', tempDir],
      env: {
        [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: '',
        [PROCESS_ATTRIBUTION_ID_ENV]: mintProcessAttributionId(),
      },
    }))) as { records: unknown[]; nodeOptions: string | null }

    expect(observed.records).toEqual([])
    expect(observed.nodeOptions).toBeNull()
    expect(await readAttributionRecords(attributionDirectory)).toMatchObject({ agents: [] })
  })

  test('keeps recording attribution when the classification patch is disabled', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-attribution-'))
    tempDirs.push(tempDir)
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const attributionId = mintProcessAttributionId()
    const { preloadPath, entryPath } = await writeAgentFixture({
      tempDir,
      entrySource: [
        AGENT_ENTRY_SOURCE,
        CURSOR_CLASSIFIER_FIXTURE,
        'process.stdout.write(JSON.stringify(Object.assign(report(), {',
        '  patched: R.has(c.yM.RESOURCE_EXHAUSTED),',
        '})))',
      ].join('\n'),
    })

    const observed = JSON.parse(await collectAgentOutput(spawnAgent({
      preloadPath,
      entryPath,
      args: ['--workspace', tempDir],
      env: {
        [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: attributionDirectory,
        [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
        AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED: '1',
      },
    }))) as {
      patched: boolean
      nodeOptions: string | null
      records: Array<{ record: Record<string, unknown> }>
    }

    expect(observed.patched).toBe(false)
    expect(observed.nodeOptions).toBeNull()
    expect(observed.records).toHaveLength(1)
    expect(observed.records[0]?.record).toMatchObject({ attributionId, kind: 'cursor-agent' })
  })

  test('records the readiness probe under its own kind with the scope that spawned it', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-attribution-'))
    tempDirs.push(tempDir)
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const attributionId = mintProcessAttributionId()
    const { preloadPath, entryPath } = await writeAgentFixture({
      tempDir,
      entrySource: [
        AGENT_ENTRY_SOURCE,
        'process.stdout.write(JSON.stringify(report()))',
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    })

    const child = spawnAgent({
      preloadPath,
      entryPath,
      args: ['--workspace', tempDir],
      env: {
        [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: attributionDirectory,
        [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
        [PROCESS_ATTRIBUTION_KIND_ENV]: 'readiness-probe',
        CLAUDE_TEAM_APP_PROFILE_SCOPE: 'other-install',
      },
    })
    await waitForAgentReport(child)

    try {
      const written = await readAttributionRecords(attributionDirectory)
      expect(written.agents).toHaveLength(1)
      // The one cursor-agent the runtime spawns itself is never a team's tree,
      // and the record names the install it was spawned for; which install a
      // reader speaks for is the reader's question, not the store's.
      expect(written.agents[0]?.record).toMatchObject({
        kind: 'readiness-probe',
        appProfileScope: 'other-install',
      })
      expect(await readdir(processAttributionAgentDirectoryPath(
        attributionDirectory,
        attributionId,
      ))).toHaveLength(1)
    } finally {
      await killAgent(child)
    }
  })
})
