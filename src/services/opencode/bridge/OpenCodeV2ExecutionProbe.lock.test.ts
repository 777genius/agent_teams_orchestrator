import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as lockfile from '../../../utils/lockfile.js'
import * as profiles from '../OpenCodeProfileManager.js'
import * as plans from './OpenCodeV2LaunchPlan.js'
import * as owners from './OpenCodeV2RunOwner.js'
import { resolveOpenCodeV2ExecutionProbe } from './OpenCodeV2ExecutionProbe.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'

type Selection = Awaited<ReturnType<typeof plans.inspectOpenCodeV2SourceAvailability>>
let root: string, previousDataHome: string | undefined
const restores: { mockRestore(): void }[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-probe-lock-')))
  previousDataHome = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(root, 'data')
  restores.push(spyOn(profiles, 'collectProjectBehaviorMetadata').mockImplementation(async () => ({
    projectBehaviorFingerprint: 'b'.repeat(64), behaviorSources: [],
  })))
})
afterEach(async () => {
  for (const restore of restores.splice(0)) restore.mockRestore()
  if (previousDataHome === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
  else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previousDataHome
  await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const project = path.join(root, 'TEST-project')
  await mkdir(project)
  const request: BridgeEnvelope = { schemaVersion: 1, requestId: 'TEST-lock', command: 'opencode.readiness',
    cwd: project, startedAt: new Date().toISOString(), timeoutMs: 30_000,
    body: { selectedModel: 'openrouter/nvidia/TEST-model:free', requireExecutionProbe: true } }
  // The selected source is a fixture; no native source discovery or provider request runs.
  const selection: Selection = {
    project, model: { providerID: 'openrouter', id: 'nvidia/TEST-model:free' },
    scope: { purpose: 'launch_runtime', providerId: 'openrouter', scopeToken: 'TEST-scope',
      configFingerprint: 'c'.repeat(64), selectedAuthIdentity: 'absent' },
    controller: { type: 'remote', url: 'http://127.0.0.1:1/mcp', oauth: false },
    behaviorFingerprint: 'd'.repeat(64), capabilitySnapshotId: 'TEST-capability',
    installedGraphSHA256: 'e'.repeat(64), installedGraphFiles: 1,
    native: { generation: 'v2', version: '2.1.4', dialect: 'v2-2.1.4', executablePath: '/TEST/opencode',
      executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-darwin-arm64', runtimeMode: 'source',
      entrySha256: 'a'.repeat(64), bun: { path: '/TEST/bun', sha256: 'a'.repeat(64) },
      graph: { sha256: 'e'.repeat(64), files: [{ path: '/TEST/entry', sha256: 'a'.repeat(64) }] } },
  }
  let key = ''
  const initial = await resolveOpenCodeV2ExecutionProbe(request, selection, false,
    { onPrepared: async value => { key = value } })
  expect(initial.state).toBe('pending')
  const directory = path.join(root, 'data/opencode/v2/execution-probes', key)
  return { request, selection, directory, guard: path.join(directory, 'owner.lock') }
}

test('concurrent model checks defer without another native owner, input or execution proof', async () => {
  const f = await fixture()
  const build = spyOn(plans, 'buildOpenCodeV2InternalRunPlan').mockImplementation(async () => {
    throw new Error('TEST native plan forbidden')
  })
  const launch = spyOn(owners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
    throw new Error('TEST native owner forbidden')
  })
  restores.push(build, launch)
  const release = await lockfile.lock(f.guard, { retries: 0 })
  try {
    for (const run of [false, true]) {
      const result = await resolveOpenCodeV2ExecutionProbe(f.request, f.selection, run)
      expect(result.state).toBe('pending')
      expect(result.proof).toBeNull()
      expect(result.reason).toContain('provider busy')
      expect(result.reason).not.toContain('Lock file')
    }
    expect(build).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(await lockfile.check(f.guard)).toBe(true)
    await expect(lstat(path.join(f.directory, 'probe.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await release() }
  // The busy answer was never saved as a failed model or reused after release.
  expect(await resolveOpenCodeV2ExecutionProbe(f.request, f.selection, false)).toEqual({
    state: 'pending', proof: null, reason: 'Selected-model execution proof was not requested.',
  })
})

test('non-contention lock failures and cancellation remain refusals', async () => {
  const f = await fixture()
  for (const code of ['ECOMPROMISED', 'EACCES']) {
    const failure = Object.assign(new Error('TEST lock failure'), { code })
    const lock = spyOn(lockfile, 'lock').mockImplementation(async () => { throw failure })
    try { await expect(resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).rejects.toBe(failure) }
    finally { lock.mockRestore() }
  }
  const controller = new AbortController(), cancellation = new Error('TEST cancelled')
  const lock = spyOn(lockfile, 'lock').mockImplementation(async () => {
    controller.abort(cancellation)
    throw Object.assign(new Error('TEST occupied'), { code: 'ELOCKED' })
  })
  try {
    await expect(resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
      { signal: controller.signal })).rejects.toBe(cancellation)
  } finally { lock.mockRestore() }
})
