import { claimOpenCodeV2FreshProofRequest } from './OpenCodeV2FreshProofRequest.js'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import * as childProcesses from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import * as profiles from '../OpenCodeProfileManager.js'
import * as nativeIdentity from '../compatibility/OpenCodeNativeIdentity.js'
import * as receipts from '../profile/OpenCodeV2ExecutionReceipt.js'
import * as mcp from '../OpenCodeMcpManager.js'
import * as probes from './OpenCodeV2ExecutionProbe.js'
import * as launchPlans from './OpenCodeV2LaunchPlan.js'
import * as runOwners from './OpenCodeV2RunOwner.js'
import * as delivery from '../host/OpenCodeV2ExecutionDelivery.js'
import * as controls from './OpenCodeV2RunControl.js'
import type { RunBinding, RunControlResult } from './OpenCodeV2RunTypes.js'
import * as projectIdentity from '../OpenCodeProjectIdentity.js'
import { buildOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { attachOpenCodeV2SelectedKey } from '../host/OpenCodeV2ExecutionAuth.js'
import { stagedOpenCodeV2Client } from '../compatibility/fixtures/stagedOpenCodeV2Pins.js'
import { executionCurrentOperations } from '../transport/OpenCodeV2ExecutionCurrentClient.js'
import { executionFloorOperations } from '../transport/OpenCodeV2ExecutionFloorClient.js'
import { OpenCodeV2ExecutionFetch } from '../transport/OpenCodeV2ExecutionFetch.js'
import { createOpenCodeV2PreparedMember, createOpenCodeV2LaunchPlan, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run, startOpenCodeV2RunSupervisor } from './OpenCodeV2RunOwner.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { OpenCodePreparedProfile, OpenCodeProfileScope, OpenCodeProvisioningSnapshot } from '../types.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

let root: string, project: string, pin: '2.0.0' | '2.0.32' | '2.1.4' = '2.0.32'
let saved: NodeJS.ProcessEnv
let nativeSelectionCalls = 0, nativeReceiptCalls = 0
let receiptControllers: unknown[] = []
let launchConfig: Awaited<ReturnType<typeof mcp.resolveOpenCodeAppMcpLaunchConfig>> = {
  config: { type: 'remote', enabled: true, url: 'http://127.0.0.1:1/mcp' }, source: 'env-override' }
let authContent = '{}\n'
let metadataAuthIdentity: OpenCodeProfileScope['selectedAuthIdentity'] = 'absent'
const restores: { mockRestore(): void }[] = []
const behavior = 'b'.repeat(64)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function native(): ValidatedExecutionNative {
  return { generation: 'v2', version: pin, dialect: `v2-${pin}`,
    executablePath: '/TEST/qualified/opencode', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64',
    runtimeMode: 'source', entrySha256: 'a'.repeat(64), bun: { path: process.execPath, sha256: 'a'.repeat(64) },
    graph: { sha256: 'a'.repeat(64), files: [{ path: import.meta.path, sha256: 'a'.repeat(64) }] } }
}
function envelope(): BridgeEnvelope {
  return { schemaVersion: 1, requestId: 'TEST-request', command: 'opencode.launchTeam', cwd: project,
    startedAt: new Date().toISOString(), timeoutMs: 30_000,
    body: { teamId: 'TEST-team', teamName: 'TEST-team', runId: 'TEST-run', laneId: 'primary',
      selectedModel: 'provider/model', skipPermissions: true, members: [{ name: 'worker' }] } }
}
beforeEach(async () => {
  nativeSelectionCalls = 0; nativeReceiptCalls = 0; receiptControllers = []
  launchConfig = { config: { type: 'remote', enabled: true, url: 'http://127.0.0.1:1/mcp' }, source: 'env-override' }
  authContent = '{}\n'; metadataAuthIdentity = 'absent'
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-unattended-')))
  project = path.join(root, 'project'); await mkdir(project)
  const env = { CLAUDE_MULTIMODEL_DATA_HOME: path.join(root, 'app-data'), CLAUDE_MULTIMODEL_CACHE_HOME: path.join(root, 'app-cache') }
  saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env)
  const scope = { purpose: 'launch_runtime', providerId: 'provider', scopeToken: 'TEST-scope', configFingerprint: 'c'.repeat(64),
    selectedAuthIdentity: 'absent' } as OpenCodeProfileScope
  // Only external selection/auth boundaries are fixtures. Profile documents,
  // proof construction and the production launch's hash comparison remain real.
  restores.push(spyOn(profiles, 'canonicalizeOpenCodeProjectPath').mockImplementation(async () => project),
    spyOn(profiles, 'resolveOpenCodeProfileScope').mockImplementation(async () => scope),
    spyOn(profiles, 'materializeOpenCodeSelectedScopeAuth').mockImplementation(async (_scope, _project, authPath) => {
      await writeFile(authPath, authContent, { mode: 0o600 }); return {}
    }),
    spyOn(profiles, 'readOpenCodeSelectedScopeMetadata').mockImplementation(async () => ({ projectBehaviorFingerprint: behavior,
      behaviorSources: [], selectedAuthIdentity: metadataAuthIdentity, authoritySourceFingerprint: 'd'.repeat(64) })),
    spyOn(profiles, 'collectProjectBehaviorMetadata').mockImplementation(async () => ({ projectBehaviorFingerprint: behavior, behaviorSources: [] })),
    spyOn(nativeIdentity, 'inspectOpenCodeReadSelection').mockImplementation(async () => {
      nativeSelectionCalls += 1
      return { path: native().executablePath,
        policy: { generation: 'v2', version: pin, dialect: native().dialect }, native: native(), fingerprint: native().executableSha256 }
    }),
    spyOn(receipts, 'createOpenCodeV2ExecutionReceipt').mockImplementation(async (_root, _identity, controller) => {
      nativeReceiptCalls++; receiptControllers.push(controller); return native()
    }),
    spyOn(mcp, 'resolveOpenCodeAppMcpLaunchConfig').mockImplementation(async () => launchConfig))
})
afterEach(async () => {
  for (const restore of restores.splice(0)) restore.mockRestore()
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(root, { recursive: true, force: true })
})
async function proof(prepared: OpenCodePreparedProfile, capabilitySnapshotId: string, platform?: NodeJS.Platform, verifiedAt?: string) {
  const snapshot = { projectPath: project, profile: prepared, hostHealthy: true, host: { profile: prepared, version: pin,
    resolvedConfigFingerprint: prepared.managedConfigFingerprint } } as OpenCodeProvisioningSnapshot
  return buildOpenCodeExecutionProof({ selectedModel: 'provider/model', snapshot, capabilitySnapshotId, verifiedAt }, {
    resolveBinaryPath: () => native().executablePath, resolveBinaryIdentity: async () => 'TEST-native-identity', readCredential: async () => null, platform })
}
const titleVersions = process.platform === 'win32' ? ['2.1.4'] as const : ['2.0.0', '2.0.32', '2.1.4'] as const
for (const version of titleVersions) test(`${version} probe-owned session title prevents automatic title requests without changing team sessions`, async () => {
  pin = version
  const request = envelope()
  request.body.members = [{ name: 'probe', prompt: 'TEST-private briefing', title: 'TEST-caller-title' }]
  const selection = await inspectOpenCodeV2SourceAvailability(request)
  const intent: QueueIntent = { identity: { requestId: 'TEST-probe', deliveryAttemptId: 'TEST-probe',
    localMessageId: 'TEST-probe', nativeInputID: 'msg_TESTprobe' }, delivery: 'queue',
    input: { nativeInputID: 'msg_TESTprobe', resume: true, text: 'TEST-verification-input' } }
  const probe = await launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-probe-controller',
    { intent, expectedText: 'TEST-verification-result' })
  const team = await launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-team-controller')
  const member = probe.members[0]!
  expect(member.title).toBe('Agent Teams model verification')
  expect(probe.executionProbe?.intent).toEqual(intent)
  expect(member.profile.selection.permissions.some(rule => rule.effect === 'allow')).toBe(false)
  expect(member.profile.selection.permissions.filter(rule => rule.effect === 'ask').map(rule => rule.action))
    .toEqual(team.members[0]!.profile.selection.permissions.filter(rule => rule.effect === 'allow').map(rule => rule.action))
  const launchProbe = await launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-launch-controller',
    { intent, expectedText: 'TEST-verification-result', unattendedTeam: true })
  expect(launchProbe.members[0]!.profile.config.sha256).toBe(team.members[0]!.profile.config.sha256)
  // A name or caller-supplied title cannot turn an ordinary team member into a probe.
  expect(team.members[0]).not.toHaveProperty('title')
  expect(team.executionProbe).toBeUndefined()

  // Check the generated floor/current SDK request too: a plan-only title would
  // still leave the native engine free to issue its second, automatic request.
  const base = 'http://127.0.0.1:31999', calls: Request[] = []
  const session = { id: member.originalSessionId, directory: project, ...member.profile.selection, time: { created: 1 } }
  const fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    calls.push(new Request(input, init))
    return new Response(JSON.stringify({ data: session }), { headers: { 'content-type': 'application/json' } })
  }, { preconnect(): never { throw new Error('TEST preconnect unsupported') } })
  const wire = new OpenCodeV2ExecutionFetch(base, version, project, 'TEST-password', { deadline: Date.now() + 10_000 }, fetch)
  try {
    const client = await stagedOpenCodeV2Client(version)
    const operations = version === '2.0.0'
      ? executionFloorOperations(client, base, project, wire, fetch)
      : executionCurrentOperations(client, base, project, wire, fetch)
    await operations.create({ sessionID: member.originalSessionId, agent: member.profile.selection.agent,
      model: member.profile.selection.model, title: member.title })
    expect(calls).toHaveLength(1)
    expect(await calls[0]!.json()).toMatchObject({ id: member.originalSessionId, title: 'Agent Teams model verification' })
  } finally { await wire.dispose() }
})
for (const version of ['2.0.0', '2.0.32'] as const) test(`${version} absent selected auth routes prepared profiles through native free-model readback while sealing paid keys`, async () => {
  pin = version
  const selection = await inspectOpenCodeV2SourceAvailability(envelope())
  const parent = path.join(root, 'profiles'); await mkdir(parent)
  const member = { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', unattendedTeam: true }
  const anonymous = await createOpenCodeV2PreparedMember(selection, native(), parent, member)
  expect(anonymous.profile.authSha256).toBeUndefined()
  expect(anonymous.prepared.managedAuthFingerprint).toBe(digest(authContent))
  expect(anonymous.prepared.selectedSourceAuthIdentity).toBe('absent')
  expect(anonymous.prepared.authState).toBe('missing')
  expect(await readFile(anonymous.prepared.managedAuthPath, 'utf8')).toBe('{}\n')
  const location = { directory: project }
  const provider = { id: 'provider', integrationID: 'TEST-integration', activation: 'enabled', settings: { apiKey: 'public' } }
  const model = { id: 'model', providerID: 'provider', enabled: true, status: 'active',
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }
  let posts = 0
  const port = {
    providers: async () => ({ location, data: [provider] }),
    integration: async () => ({ location, data: { id: 'TEST-integration', connections: [] } }),
    models: async () => ({ location, data: [model] }),
    connect: async () => { posts++ },
  }
  await attachOpenCodeV2SelectedKey(anonymous.profile, port)
  for (const changed of [
    { ...port, providers: async () => ({ location, data: [{ ...provider, settings: {} }] }) },
    { ...port, integration: async () => ({ location, data: { id: 'TEST-integration', connections: [{ type: 'credential', id: 'cred_TEST' }] } }) },
    { ...port, models: async () => ({ location, data: [{ ...model, cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }] }] }) },
  ]) await expect(attachOpenCodeV2SelectedKey(anonymous.profile, changed)).rejects.toThrow('execution_selected_auth_anonymous_unproven')
  expect(posts).toBe(0)
  const selectedKey = 'TEST-only-key'
  authContent = JSON.stringify({ provider: { type: 'api', key: selectedKey } })
  await expect(createOpenCodeV2PreparedMember(selection, native(), parent, member)).rejects.toThrow('run_selected_auth_changed')
  metadataAuthIdentity = `known:${digest(authContent)}`
  const paid = await createOpenCodeV2PreparedMember({ ...selection,
    scope: { ...selection.scope, selectedAuthIdentity: metadataAuthIdentity } }, native(), parent, member)
  expect(paid.profile.authSha256).toBe(digest(authContent))
  expect(paid.prepared.managedAuthFingerprint).toBe(digest(authContent))
  expect(paid.prepared.authState).toBe('ok')
  await attachOpenCodeV2SelectedKey(paid.profile, { ...port,
    integration: async () => ({ location, data: { id: 'TEST-integration', methods: [{ type: 'key' }],
      connections: posts === 0 ? [] : [{ type: 'credential', id: 'cred_TESTselected' }] } }),
    connect: async (_id, key) => { expect(key).toBe(selectedKey); posts++ },
  })
  expect(posts).toBe(1)
  authContent = '{}\n'
  await expect(createOpenCodeV2PreparedMember(selection, native(), parent, member)).rejects.toThrow('run_selected_auth_changed')
})
test('local controller entries bind canonical real files while flags pass through unchanged', async () => {
  const packageRoot = path.join(root, 'pkg'); await mkdir(packageRoot)
  const realEntry = path.join(packageRoot, 'entry.mjs'); await writeFile(realEntry, 'export {}\n')
  const linkedEntry = path.join(packageRoot, 'linked.mjs'); await symlink(realEntry, linkedEntry)
  launchConfig = { config: { type: 'local', enabled: true, command: [process.execPath, linkedEntry, realEntry, '--no-warnings'] },
    source: 'env-override' }
  const selection = await inspectOpenCodeV2SourceAvailability(envelope())
  // The store-link path resolves to the same canonical file before the receipt
  // binds it, so fingerprint, spawned command and receipt identity agree.
  expect(selection.controller).toEqual({ type: 'local', environment: {},
    command: [await realpath(process.execPath), realEntry, realEntry, '--no-warnings'] })
  expect(receiptControllers).toEqual([selection.controller])
})
test('controller entries refuse directories, missing and non-absolute targets before receipt identity', async () => {
  const packageRoot = path.join(root, 'pkg'); await mkdir(packageRoot)
  await writeFile(path.join(packageRoot, 'entry.mjs'), 'export {}\n')
  launchConfig = { config: { type: 'local', enabled: true, command: [process.execPath, packageRoot] }, source: 'env-override' }
  await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('controller_entry_invalid')
  launchConfig = { config: { type: 'local', enabled: true, command: [process.execPath, path.join(packageRoot, 'missing.mjs')] },
    source: 'env-override' }
  await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('controller_entry_invalid')
  launchConfig = { config: { type: 'local', enabled: true, command: [process.execPath, 'entry.mjs'] }, source: 'env-override' }
  await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('controller_entry_not_absolute')
  expect(receiptControllers).toEqual([])
})
for (const version of ['2.0.0', '2.0.32'] as const) test(`${version} admits Linux and Darwin selection but fences unsupported hosts before identity reads`, async () => {
  pin = version
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun')!
  try {
    for (const host of ['linux', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { ...platform, value: host })
      Object.defineProperty(process.versions, 'bun', { ...bun, value: openCodeBunVersion(host) })
      const selection = await inspectOpenCodeV2SourceAvailability(envelope())
      expect(selection.native.version).toBe(version)
      expect(selection.installedGraphFiles).toBeGreaterThan(0)
      expect(selection.model).toEqual({ providerID: 'provider', id: 'model' })
    }
    expect(nativeSelectionCalls).toBe(2)
    // Windows execution still refuses unsupported 32-bit hosts.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'ia32' })
    await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('execution_platform_unsupported')
    Object.defineProperty(process, 'arch', arch)
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    Object.defineProperty(process.versions, 'bun', { ...bun, value: '1.3.10' })
    await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('run_source_bun_required')
    expect(nativeSelectionCalls).toBe(2)
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
    Object.defineProperty(process.versions, 'bun', bun)
  }
})
for (const version of ['2.0.0', '2.0.32'] as const) test(`${version} team launch requires the same unattended profile as its strict proof`, async () => {
  pin = version
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const parent = path.join(root, 'profiles'); await mkdir(parent)
  const generic = await createOpenCodeV2PreparedMember(selection, native(), parent, { teamId: 'TEST-probe', runId: 'TEST-probe', memberId: 'probe' })
  const team = await createOpenCodeV2PreparedMember(selection, native(), parent, { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', unattendedTeam: true })
  expect(JSON.parse(await readFile(path.join(generic.profile.config.directory, 'opencode.json'), 'utf8')).plugins).toEqual([])
  expect(JSON.parse(await readFile(path.join(team.profile.config.directory, 'opencode.json'), 'utf8')).plugins).toEqual(['-opencode.tool.question'])
  const samePolicyProof = await proof(team.prepared, selection.capabilitySnapshotId)
  const probe = spyOn(probes, 'resolveOpenCodeV2ExecutionProbe').mockImplementation(async (_envelope, _selection, run, options) => {
    expect(run).toBe(false); expect(options).toEqual({ unattendedTeam: true })
    return { state: 'available', proof: samePolicyProof, reason: null }
  }); restores.push(probe)
  const preconditions = {
    handshakeIdentityHash: 'TEST-handshake', laneId: 'primary', expectedRunId: 'TEST-run', expectedCapabilitySnapshotId: selection.capabilitySnapshotId,
    expectedBehaviorFingerprint: samePolicyProof.expectedBehaviorEvidence.expectedBehaviorFingerprint,
    expectedManifestHighWatermark: null, commandLeaseId: 'TEST-lease', idempotencyKey: 'TEST-launch' }
  const launch = { ...request, body: { ...request.body, executionProof: samePolicyProof, preconditions } }
  nativeReceiptCalls = 0
  const plan = await createOpenCodeV2LaunchPlan(launch)
  expect(nativeReceiptCalls).toBe(1)
  const nextPlan = await createOpenCodeV2LaunchPlan(launch)
  expect(nativeReceiptCalls).toBe(2) // Each command still verifies its own current graph.
  expect(nextPlan.members[0]?.native.graph).toEqual(plan.members[0]?.native.graph)
  expect(plan.members[0]?.profile.config.sha256).toBe(samePolicyProof.managedConfigFingerprint)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
    // These older engines remain unqualified on Windows ARM64; refuse before process work.
    await expect(launchExplicitOpenCodeV2Run(plan)).rejects.toThrow('opencode_v2_version_unqualified')
    await expect(startOpenCodeV2RunSupervisor(plan, '/TEST-unqualified', 'TEST')).rejects.toThrow('opencode_v2_version_unqualified')
  } finally { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch) }
  // A permitted host still cannot launch the fixture's unqualified Bun bytes.
  await expect(launchExplicitOpenCodeV2Run(plan)).rejects.toThrow('run_source_changed')
  expect(await readdir(path.join(root, 'app-data/opencode/v2'))).not.toContain('runs')
  const changedPolicyProof = await proof(generic.prepared, selection.capabilitySnapshotId)
  probe.mockImplementation(async () => ({ state: 'available', proof: changedPolicyProof, reason: null }))
  await expect(createOpenCodeV2LaunchPlan({ ...launch, body: { ...launch.body, executionProof: changedPolicyProof,
    preconditions: { ...preconditions, expectedBehaviorFingerprint: changedPolicyProof.expectedBehaviorEvidence.expectedBehaviorFingerprint } } }))
    .rejects.toThrow('run_launch_config_variant_changed')
  probe.mockImplementation(async () => ({ state: 'available', proof: samePolicyProof, reason: null }))
  const originalHash = nativeIdentity.hashOpenCodeFile
  let active = 0, maximum = 0, sourceReads = 0, expireDuringSourceRead = false
  const beforeExpiry = Date.parse(samePolicyProof.expiresAt) - 1
  let now = beforeExpiry
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const hashes = spyOn(nativeIdentity, 'hashOpenCodeFile').mockImplementation(async file => {
    const source = file.includes(`${path.sep}src${path.sep}`)
    if (!source) return originalHash(file)
    sourceReads++; active++; maximum = Math.max(maximum, active)
    if (expireDuringSourceRead) now = beforeExpiry + 1
    try { return await originalHash(file) } finally { active-- }
  })
  restores.push(clock, hashes)
  await createOpenCodeV2LaunchPlan(launch)
  expect(sourceReads).toBeGreaterThan(1)
  expect(maximum).toBeGreaterThan(1)
  expect(maximum).toBeLessThanOrEqual(16)
  expireDuringSourceRead = true
  await expect(createOpenCodeV2LaunchPlan(launch)).rejects.toThrow('run_launch_project_behavior_or_proof_changed')
  now = beforeExpiry; expireDuringSourceRead = false
  const behaviorRead = spyOn(profiles, 'collectProjectBehaviorMetadata')
    .mockImplementation(async () => ({ projectBehaviorFingerprint: 'e'.repeat(64), behaviorSources: ['AGENTS.md'] }))
  restores.push(behaviorRead)
  await expect(createOpenCodeV2LaunchPlan(launch)).rejects.toThrow('run_launch_project_behavior_or_proof_changed')
}, 30_000)

for (const platform of ['win32', 'linux'] as const) test(`${platform} cached probe and launch compare the issuer's project identity without replay`, async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const parent = path.join(root, 'profiles'); await mkdir(parent)
  const team = await createOpenCodeV2PreparedMember(selection, native(), parent,
    { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', unattendedTeam: true })
  const issued = await proof(team.prepared, selection.capabilitySnapshotId, platform)
  const normalize = projectIdentity.normalizeOpenCodeProjectIdentity
  // Exercise the real platform identity policy while keeping fixture filesystem
  // and native-adapter selection on the host platform.
  restores.push(spyOn(projectIdentity, 'normalizeOpenCodeProjectIdentity')
    .mockImplementation(value => normalize(value, platform)))
  expect(issued.projectPath).toBe(normalize(project, platform))
  if (platform === 'win32') expect(issued.projectPath).not.toBe(project)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default', unattendedTeam: true })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, 'probe.json'), nonce = 'TEST-original-qualified'
  const original = { sourceKey, binding: { teamId: 'TEST-probe', runId: nonce, controllerInstanceId: nonce, ownerId: nonce },
    sessionID: 'ses_TEST', intent: { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce, nativeInputID: 'msg_TEST' },
      delivery: 'queue', input: { nativeInputID: 'msg_TEST', resume: true, text: 'Original qualified TEST input' } },
    submitted: true, retired: true, proof: issued }
  const saved = JSON.stringify(original)
  await writeFile(file, saved, { mode: 0o600 })
  const probe = await probes.resolveOpenCodeV2ExecutionProbe(request, selection, false, { unattendedTeam: true })
  expect(probe).toEqual({ state: 'available', proof: issued, reason: null })
  const preconditions = { handshakeIdentityHash: 'TEST-handshake', laneId: 'primary', expectedRunId: 'TEST-run',
    expectedCapabilitySnapshotId: selection.capabilitySnapshotId,
    expectedBehaviorFingerprint: issued.expectedBehaviorEvidence.expectedBehaviorFingerprint,
    expectedManifestHighWatermark: null, commandLeaseId: 'TEST-lease', idempotencyKey: 'TEST-launch' }
  const launch = { ...request, body: { ...request.body, executionProof: issued, preconditions } }
  const plan = await createOpenCodeV2LaunchPlan(launch)
  expect(plan.members[0]?.profile.directory).toBe(project)
  expect(await readFile(file, 'utf8')).toBe(saved)
  expect(await readdir(path.join(root, 'app-data/opencode/v2'))).not.toContain('runs')
  for (const change of [
    { projectPath: normalize(path.join(project, 'other'), platform) },
    ...(platform === 'linux' ? [{ projectPath: project.toUpperCase() }] : []),
    { modelId: 'provider/other' }, { capabilitySnapshotId: 'TEST-other-capability' },
    { opencodeVersion: '2.0.99' }, { binaryPath: '/TEST/other/opencode' },
    { projectBehaviorFingerprint: 'e'.repeat(64) },
  ]) {
    const changed = { ...issued, ...change }
    const bytes = JSON.stringify({ ...original, proof: changed })
    await writeFile(file, bytes, { mode: 0o600 })
    await expect(probes.resolveOpenCodeV2ExecutionProbe(request, selection, false, { unattendedTeam: true }))
      .rejects.toThrow('probe_cached_target_changed')
    expect(await readFile(file, 'utf8')).toBe(bytes)
  }
}, 30_000)

test('generic unresolved probes retain their original cache key while team policy has a separate key', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken, selectedAuthIdentity: selection.scope.selectedAuthIdentity,
    source: selection.behaviorFingerprint, graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-original', intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce, nativeInputID: 'msg_TEST' },
    delivery: 'queue', input: { nativeInputID: 'msg_TEST', resume: true, text: 'Original unresolved TEST input' } }
  await writeFile(path.join(directory, 'probe.json'), JSON.stringify({ sourceKey, binding: { teamId: 'TEST-original', runId: nonce,
    controllerInstanceId: nonce, ownerId: nonce }, sessionID: 'ses_TEST', intent, submitted: true, proof: null, retired: false }), { mode: 0o600 })
  const generic = await probes.resolveOpenCodeV2ExecutionProbe(request, selection, false)
  expect(generic.reason).toBe('Original native execution proof is pending or expired.')
  const team = await probes.resolveOpenCodeV2ExecutionProbe(request, selection, false, { unattendedTeam: true })
  expect(team.reason).toBe('Selected-model execution proof was not requested.')
  expect(digest(await readFile(path.join(directory, 'probe.json'), 'utf8'))).toBe(digest(JSON.stringify({ sourceKey, binding: { teamId: 'TEST-original', runId: nonce,
    controllerInstanceId: nonce, ownerId: nonce }, sessionID: 'ses_TEST', intent, submitted: true, proof: null, retired: false })))
})

// Append in the existing OpenCodeV2LaunchPlan.unattended.test.ts fixture.
// No new mocks, model effects or synthetic cleanup qualification.
test('retired original terminal failure is retained across read and run requests without replay', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-retired-provider-failure'
  const intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce,
    nativeInputID: 'msg_TESTfailed' }, delivery: 'queue',
    input: { nativeInputID: 'msg_TESTfailed', resume: true, text: 'Original failed TEST input' } }
  const saved = JSON.stringify({ sourceKey, binding: { teamId: 'TEST-original', runId: nonce,
    controllerInstanceId: nonce, ownerId: nonce }, sessionID: 'ses_TESTfailed', intent,
    submitted: true, proof: null, retired: true, failure: 'native_execution_failed' })
  const file = path.join(directory, 'probe.json')
  await writeFile(file, saved, { mode: 0o600 })
  for (const run of [false, true]) {
    expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, run))
      .toEqual({ state: 'failed', proof: null, reason: 'native_execution_failed' })
    expect(await readFile(file, 'utf8')).toBe(saved)
  }
})

test('Connect reconciliation observes its exact submitted probe and never replaces a missing original', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-original-connect-probe'
  const intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce,
    nativeInputID: 'msg_TESTconnect' }, delivery: 'queue',
    input: { nativeInputID: 'msg_TESTconnect', resume: true, text: 'Original TEST input' } }
  const binding = { teamId: 'TEST-original', runId: nonce, controllerInstanceId: nonce, ownerId: nonce }
  const saved = JSON.stringify({ sourceKey, binding, sessionID: 'ses_TESTconnect', intent,
    submitted: true, proof: null, retired: false })
  const file = path.join(directory, 'probe.json'); await writeFile(file, saved, { mode: 0o600 })
  const original = { sourceKey, binding, sessionID: 'ses_TESTconnect', intentHash: executionHash(intent) }
  let launches = 0
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
    launches++; throw new Error('TEST-replay-forbidden')
  }))
  expect((await probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, { requireExisting: original })).state).toBe('pending')
  expect(await readFile(file, 'utf8')).toBe(saved)
  await rm(file)
  await expect(probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, { requireExisting: original })).rejects.toThrow('probe_original_intent_changed')
  expect(launches).toBe(0)
})

test('a failed Connect intent callback after saved probe cannot create another probe on resume', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-connect-checkpoint-failure'
  const intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce,
    nativeInputID: 'msg_TESTcheckpoint' }, delivery: 'queue',
    input: { nativeInputID: 'msg_TESTcheckpoint', resume: true, text: 'Original TEST input' } }
  const saved = JSON.stringify({ sourceKey, binding: { teamId: 'TEST-original', runId: nonce,
    controllerInstanceId: nonce, ownerId: nonce }, sessionID: 'ses_TESTcheckpoint', intent,
    submitted: false, proof: null, retired: false })
  const file = path.join(directory, 'probe.json'); await writeFile(file, saved, { mode: 0o600 })
  let launches = 0
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
    launches++; throw new Error('TEST-replay-forbidden')
  }))
  await expect(probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, {
    onIntentPersisted: async () => { throw Error('TEST-Connect-checkpoint-failed') },
  })).rejects.toThrow('TEST-Connect-checkpoint-failed')
  expect((await probes.resolveOpenCodeV2ExecutionProbe(request, selection, true)).state).toBe('pending')
  expect(await readFile(file, 'utf8')).toBe(saved)
  expect(launches).toBe(0)
})

test('same-command readiness probe plan consumes its validated receipt without rehashing the graph', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  expect(nativeReceiptCalls).toBe(1)
  const plan = await launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-controller')
  expect(nativeReceiptCalls).toBe(1)
  expect(plan.members[0]?.native.graph.sha256).toBe(selection.installedGraphSHA256)
  // Serialization cannot carry this private preparation to another command.
  await launchPlans.buildOpenCodeV2InternalRunPlan(JSON.parse(JSON.stringify(selection)), request.body, 'TEST-next-controller')
  expect(nativeReceiptCalls).toBe(2)
})

test('same-command receipt refuses mutated selection identity before preparing any member', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  selection.native.executableSha256 = 'f'.repeat(64)
  await expect(launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-controller'))
    .rejects.toThrow('run_prepared_selection_changed')
  expect(nativeReceiptCalls).toBe(1)
})

async function freshProbeFixture(verifiedAt = new Date().toISOString()) {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const parent = path.join(root, 'fresh-profiles'); await mkdir(parent)
  const team = await createOpenCodeV2PreparedMember(selection, native(), parent,
    { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', unattendedTeam: true })
  const issued = await proof(team.prepared, selection.capabilitySnapshotId, undefined, verifiedAt)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken, selectedAuthIdentity: selection.scope.selectedAuthIdentity,
    source: selection.behaviorFingerprint, graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default', unattendedTeam: true })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-original-fresh-probe'
  const record = { sourceKey, binding: { teamId: 'TEST-original', runId: nonce, controllerInstanceId: nonce, ownerId: nonce },
    sessionID: 'ses_TESToriginal', intent: { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce, nativeInputID: 'msg_TESToriginal' },
      delivery: 'queue', input: { nativeInputID: 'msg_TESToriginal', resume: true, text: 'Original TEST proof input' } },
    submitted: true, retired: true, proof: issued, failure: null }
  const file = path.join(directory, 'probe.json')
  return { request, selection, record, file }
}
test('explicit fresh request replaces only a retired genuine near-expiry generation once and durably pins its request ID', async () => {
  const f = await freshProbeFixture(new Date(Date.now() - 118_000).toISOString())
  await writeFile(f.file, JSON.stringify(f.record), { mode: 0o600 })
  let launches = 0
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
    launches++; throw new Error('TEST-before-any-native-input')
  }))
  const options = { unattendedTeam: true, freshExecutionProofRequestId: 'TEST-new-admission' }
  await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, options)).rejects.toThrow('TEST-before-any-native-input')
  const saved = JSON.parse(await readFile(f.file, 'utf8'))
  expect(saved.freshExecutionProofRequestId).toBe(options.freshExecutionProofRequestId)
  expect(saved.sourceKey).toBe(f.record.sourceKey)
  expect(saved.binding).not.toEqual(f.record.binding)
  expect(saved.submitted).toBe(false)
  const before = await readFile(f.file, 'utf8')
  expect((await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, options)).state).toBe('pending')
  expect(await readFile(f.file, 'utf8')).toBe(before)
  expect(launches).toBe(1)
})
for (const expired of [false, true]) test(`the same fresh request ${expired ? 'expires fail-closed' : 'reuses its own proof'} without another native input`, async () => {
  const f = await freshProbeFixture(new Date(Date.now() - (expired ? 121_000 : 0)).toISOString())
  const saved = JSON.stringify({ ...f.record, freshExecutionProofRequestId: 'TEST-same-admission' })
  await writeFile(f.file, saved, { mode: 0o600 })
  await claimOpenCodeV2FreshProofRequest(path.dirname(f.file), f.record.sourceKey, 'TEST-same-admission')
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => { throw Error('TEST-replay-forbidden') }))
  const result = await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
    { unattendedTeam: true, freshExecutionProofRequestId: 'TEST-same-admission' })
  expect(result.state).toBe(expired ? 'pending' : 'available')
  expect(result.proof).toEqual(expired ? null : f.record.proof)
  expect(await readFile(f.file, 'utf8')).toBe(saved)
})
test('explicit fresh request never replaces an UNKNOWN, unsubmitted, or unretired original', async () => {
  const f = await freshProbeFixture()
  let launches = 0
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => { launches++; throw Error('TEST-replay-forbidden') }))
  for (const submitted of [false, true]) for (const originalProof of [null, f.record.proof]) {
    const saved = JSON.stringify({ ...f.record, submitted, proof: originalProof, retired: false })
    await writeFile(f.file, saved, { mode: 0o600 })
    const result = await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
      { unattendedTeam: true, freshExecutionProofRequestId: 'TEST-new-admission' })
    expect(result).toMatchObject({ state: 'pending', proof: null })
    expect(await readFile(f.file, 'utf8')).toBe(saved)
  }
  expect(launches).toBe(0)
})


test('fresh request A then B cannot replay the old paid generation on late retry A', async () => {
  const f = await freshProbeFixture()
  await writeFile(f.file, JSON.stringify(f.record), { mode: 0o600 })
  let launches = 0
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => { launches++; throw Error('TEST-native-boundary') }))
  for (const id of ['TEST-admission-A', 'TEST-admission-B']) {
    await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
      { unattendedTeam: true, freshExecutionProofRequestId: id })).rejects.toThrow('TEST-native-boundary')
    const generation = JSON.parse(await readFile(f.file, 'utf8'))
    expect(generation.freshExecutionProofRequestId).toBe(id)
    await writeFile(f.file, JSON.stringify({ ...generation, submitted: true, retired: true, proof: f.record.proof }), { mode: 0o600 })
  }
  const before = await readFile(f.file, 'utf8')
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
    { unattendedTeam: true, freshExecutionProofRequestId: 'TEST-admission-A' })).toMatchObject({ state: 'pending', proof: null })
  expect(launches).toBe(2)
  expect(await readFile(f.file, 'utf8')).toBe(before)
})
test('fresh claim crash before the new probe record remains fail-closed without replacing the original', async () => {
  const f = await freshProbeFixture()
  const before = JSON.stringify(f.record); await writeFile(f.file, before, { mode: 0o600 })
  await claimOpenCodeV2FreshProofRequest(path.dirname(f.file), f.record.sourceKey, 'TEST-before-record-crash')
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => { throw Error('TEST-replay-forbidden') }))
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true,
    { unattendedTeam: true, freshExecutionProofRequestId: 'TEST-before-record-crash' })).toMatchObject({ state: 'pending', proof: null })
  expect(await readFile(f.file, 'utf8')).toBe(before)
})


test('a model-test tool request cancels and retires the original without approval, replay or proof', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TEST-permission-probe', sessionID = 'ses_TESTpermission'
  const binding = { teamId: nonce, runId: nonce, controllerInstanceId: nonce, ownerId: nonce }
  const intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce, nativeInputID: 'msg_TESTpermission' },
    delivery: 'queue', input: { nativeInputID: 'msg_TESTpermission', resume: true, text: 'TEST verification only' } }
  const file = path.join(directory, 'probe.json')
  await writeFile(file, JSON.stringify({ sourceKey, binding, sessionID, intent, submitted: true, proof: null, retired: false, failure: null }), { mode: 0o600 })
  const operations: string[] = []
  restores.push(spyOn(controls, 'discoverOpenCodeV2Run').mockImplementation(async () => ({ binding }) as NonNullable<Awaited<ReturnType<typeof controls.discoverOpenCodeV2Run>>>))
  restores.push(spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async (_owner, operation): Promise<RunControlResult> => {
    operations.push(operation.operation)
    if (operation.operation === 'permissions') return { kind: 'permissions', requests: [{ id: 'perm_TEST', sessionID, action: 'shell', resources: ['TEST forbidden tool'] }] } as RunControlResult
    expect(operation.operation).toBe('stop')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ failure: 'native_execution_cancelled', retired: false, proof: null })
    // Unit orchestration fixture only; the native E2E independently verifies real retirement.
    return { kind: 'stop', state: 'stopped', ownerRetired: true, members: [{ memberId: 'probe', cleanup: {}, errors: [] }] } as RunControlResult
  }))
  const expected = { state: 'failed', proof: null, reason: 'native_execution_cancelled' }
  expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, true)).toEqual(expected)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ failure: 'native_execution_cancelled', retired: true, proof: null })
  for (const run of [false, true]) expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, run)).toEqual(expected)
  expect(operations).toEqual(['permissions', 'stop'])
})

// A real owner process retires itself after a real provider wire failure during its own
// initialization. Only the provider endpoint and the replacement launch are fixture
// boundaries; no native input or model call exists.
const ownerPeer = fileURLToPath(new URL('./fixtures/OpenCodeV2RunControlPeer.ts', import.meta.url))
const providerEndpoint = fileURLToPath(new URL('./fixtures/OpenCodeV2ProviderEndpointPreload.ts', import.meta.url))
const posix = process.platform !== 'win32'
const ownerCause = { category: 'provider_response_invalid', operation: { operation: 'provider-read', stage: 'decode', status: 404 } } as const
const ownerReason = 'native_owner_retired:provider_response_invalid:provider-read:decode:404'
// A 60s envelope leaves the probe a 35s budget, so loaded runners do not expire it.
async function originalProbe(submitted: boolean, extra: Record<string, unknown> = {}, timeoutMs = 60_000) {
  const request = { ...envelope(), timeoutMs }, selection = await inspectOpenCodeV2SourceAvailability(request)
  const sourceKey = executionHash({ project, scopeToken: selection.scope.scopeToken,
    selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint,
    graph: selection.installedGraphSHA256, projectBehavior: behavior, variant: 'default' })
  const directory = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const nonce = 'TESToriginalowner'
  const binding = { teamId: `TEST-execution-probe-${nonce}`, runId: nonce, controllerInstanceId: nonce, ownerId: nonce }
  const intent = { identity: { requestId: nonce, deliveryAttemptId: nonce, localMessageId: nonce, nativeInputID: 'msg_TESTowner' },
    delivery: 'queue', input: { nativeInputID: 'msg_TESTowner', resume: true, text: 'Original TEST input' } }
  const saved = JSON.stringify({ sourceKey, binding, sessionID: 'ses_TESTowner', intent, submitted, proof: null, retired: false, failure: null, ...extra })
  const file = path.join(directory, 'probe.json'); await writeFile(file, saved, { mode: 0o600 })
  return { request, selection, sourceKey, binding, intent, file, saved, dataRoot: await realpath(path.join(root, 'app-data')) }
}
function peerReady(child: ChildProcess): Promise<void> {
  return boundOpenCodeRead(new Promise<void>((resolve, reject) => {
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk); if (output.includes('ready\n')) resolve() })
    child.once('error', reject); child.once('exit', () => reject(new Error('TEST_peer_exited_before_ready')))
  }), 45_000)
}
/** The original owner publishes its endpoint, fails its own initialization and exits. */
async function retiredOwner(dataRoot: string, binding: RunBinding): Promise<string> {
  const directory = await controls.reserveRunControlDirectory(dataRoot, binding, 'a'.repeat(64))
  const owner = spawn(process.execPath, ['--preload', providerEndpoint, ownerPeer, 'serve-fail', dataRoot, JSON.stringify(binding),
    'TEST-provider-read-404'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exit = new Promise<void>(resolve => owner.once('exit', () => resolve()))
  try {
    await peerReady(owner)
    await writeFile(path.join(directory, 'TEST-release-initialization'), '', { flag: 'wx', mode: 0o600 })
    await boundOpenCodeRead(exit, 45_000)
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL') }
  for (const name of ['tombstone.json', 'stop.json']) await lstat(path.join(directory, name))
  // The owner's own record carries the real wire stage of its failed provider read.
  expect(JSON.parse(await readFile(path.join(directory, 'owner-failure.json'), 'utf8'))).toEqual({ binding, failure: ownerCause })
  return directory
}
function countLaunches() {
  const counter = { launches: 0 }
  restores.push(spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
    counter.launches++; throw new Error('TEST-new-original-boundary')
  }))
  return counter
}

test.skipIf(!posix)('an owner-retired unsubmitted probe settles with the owner cause; without a fresh request only one replacement starts', async () => {
  const f = await originalProbe(false)
  const runDirectory = await retiredOwner(f.dataRoot, f.binding)
  const counter = countLaunches()
  const failed = { state: 'failed' as const, proof: null, reason: ownerReason }
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).toEqual(failed)
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual({ ...JSON.parse(f.saved), retired: true,
    failure: 'native_owner_retired', ownerFailure: ownerCause })
  // Passive reads only report the settled cause.
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, false)).toEqual(failed)
  expect(counter.launches).toBe(0)
  await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).rejects.toThrow('TEST-new-original-boundary')
  expect(counter.launches).toBe(1)
  const next = JSON.parse(await readFile(f.file, 'utf8'))
  expect(next).toMatchObject({ sourceKey: f.sourceKey, submitted: false, retired: false, failure: null, proof: null,
    automaticReplacementUsed: true })
  expect(next.binding).not.toEqual(f.binding)
  expect(next).not.toHaveProperty('ownerFailure')
  // Nothing of the retired original is removed.
  for (const name of ['control.json', 'tombstone.json', 'stop.json', 'owner-failure.json']) await lstat(path.join(runDirectory, name))
  // The replacement's owner fails the same way: it settles, and repeated requests
  // without a fresh request id start no further owner.
  await retiredOwner(f.dataRoot, next.binding)
  for (let attempt = 0; attempt < 3; attempt++)
    expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).toEqual(failed)
  expect(counter.launches).toBe(1)
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ binding: next.binding, failure: 'native_owner_retired',
    retired: true, automaticReplacementUsed: true })
  // A new fresh request still may start one new original; the spent budget stays recorded.
  await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { freshExecutionProofRequestId: 'TEST-fresh-retry' }))
    .rejects.toThrow('TEST-new-original-boundary')
  expect(counter.launches).toBe(2)
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ freshExecutionProofRequestId: 'TEST-fresh-retry',
    submitted: false, failure: null, automaticReplacementUsed: true })
}, 180_000)

test.skipIf(!posix)('a submitted probe whose owner retired is never settled as unsubmitted or replaced', async () => {
  const f = await originalProbe(true)
  await retiredOwner(f.dataRoot, f.binding)
  const counter = countLaunches()
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.file, 'utf8')).toBe(f.saved)
  }
  const settled = JSON.stringify({ ...JSON.parse(f.saved), retired: true, failure: 'native_execution_failed' })
  await writeFile(f.file, settled, { mode: 0o600 })
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true))
    .toEqual({ state: 'failed', proof: null, reason: 'native_execution_failed' })
  // Owner retirement can never describe an original that received input.
  for (const forged of [{ retired: true, failure: 'native_owner_retired' },
    { retired: true, failure: 'native_owner_retired', ownerFailure: ownerCause },
    { retired: true, failure: 'native_execution_failed', ownerFailure: ownerCause }]) {
    await writeFile(f.file, JSON.stringify({ ...JSON.parse(f.saved), ...forged }), { mode: 0o600 })
    await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true)).rejects.toThrow('probe_store_invalid')
  }
  expect(counter.launches).toBe(0)
}, 120_000)

test.skipIf(!posix)('an unsubmitted probe with a live starting owner stays pending without settling or replacing it', async () => {
  // A 40s envelope gives a 15s probe budget: enough for loaded runners, and the probe
  // waits the whole budget for the starting owner.
  const f = await originalProbe(false, {}, 40_000)
  const directory = await controls.reserveRunControlDirectory(f.dataRoot, f.binding, 'a'.repeat(64))
  const deadline = Date.now() + 60_000
  const status = { kind: 'status', state: 'starting', deadline, members: [{ memberId: 'probe', laneId: 'execution-probe',
    originalSessionId: 'ses_TESTowner', opencodeSessionId: 'ses_TESTowner', runtimeSessionId: 'ses_TESTowner',
    profileEpoch: 'TEST', profileRoot: '/TEST', pin: openCodeV2EngineVersion(f.selection.native), selectedModel: 'provider/model',
    selectedVariant: 'default', state: 'unknown', bootstrap: null }] } as RunControlResult
  const control = await controls.serveOpenCodeV2RunControl(directory, f.binding, deadline, 'a'.repeat(64), async () => status)
  const counter = countLaunches()
  try {
    expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true))
      .toEqual({ state: 'pending', proof: null, reason: 'execution_timeout:owner_readiness; Original native member is not ready; no input was submitted.' })
    expect(await readFile(f.file, 'utf8')).toBe(f.saved)
    expect(counter.launches).toBe(0)
  } finally { await control.close() }
}, 90_000)

test.skipIf(!posix)('a fresh request keeps its own settled owner failure while another request or Connect readback never replays it', async () => {
  const f = await originalProbe(false, { freshExecutionProofRequestId: 'TEST-fresh-A' })
  await claimOpenCodeV2FreshProofRequest(path.dirname(f.file), f.sourceKey, 'TEST-fresh-A')
  await retiredOwner(f.dataRoot, f.binding)
  const counter = countLaunches()
  const failed = { state: 'failed' as const, proof: null, reason: ownerReason }
  const original = { sourceKey: f.sourceKey, binding: f.binding, sessionID: 'ses_TESTowner', intentHash: executionHash(f.intent) }
  // Connect observes only its exact original: it settles, but never starts a successor.
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { requireExisting: original })).toEqual(failed)
  const settled = await readFile(f.file, 'utf8')
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { requireExisting: original })).toEqual(failed)
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { freshExecutionProofRequestId: 'TEST-fresh-A' })).toEqual(failed)
  expect(await readFile(f.file, 'utf8')).toBe(settled)
  expect(counter.launches).toBe(0)
  await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { freshExecutionProofRequestId: 'TEST-fresh-B' }))
    .rejects.toThrow('TEST-new-original-boundary')
  expect(counter.launches).toBe(1)
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ freshExecutionProofRequestId: 'TEST-fresh-B', submitted: false, failure: null })
}, 120_000)


test('a successful original probe re-arms automatic recovery only after physical retirement', async () => {
  const f = await freshProbeFixture()
  await writeFile(f.file, JSON.stringify({ ...f.record, proof: null, retired: false, automaticReplacementUsed: true }), { mode: 0o600 })
  const operations: string[] = []
  restores.push(spyOn(controls, 'discoverOpenCodeV2Run').mockImplementation(async () => ({ binding: f.record.binding }) as never),
    spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async (_owner, request): Promise<RunControlResult> => {
      operations.push(request.operation)
      if (request.operation === 'permissions') return { kind: 'permissions', requests: [] }
      if (request.operation === 'probeEvidence') return { kind: 'probeEvidence', proof: f.record.proof, failure: null }
      expect(request.operation).toBe('stop')
      // A terminal proof alone cannot re-arm owner replacement.
      expect(JSON.parse(await readFile(f.file, 'utf8')).automaticReplacementUsed).toBe(true)
      return { kind: 'stop', state: 'stopped', ownerRetired: true, members: [{ memberId: 'probe', errors: [],
        cleanup: { scopeClosed: true, processRetired: true, descendantsRetired: true, pid: 101,
          birth: { format: 'linux-start-ticks', value: 'TEST-birth', bootId: 'TEST-boot' } } }] }
    }))
  expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, { unattendedTeam: true }))
    .toEqual({ state: 'available', proof: f.record.proof, reason: null })
  const completed = JSON.parse(await readFile(f.file, 'utf8'))
  expect(completed).toMatchObject({ retired: true, submitted: true, proof: f.record.proof })
  expect(completed).not.toHaveProperty('automaticReplacementUsed')
  expect(operations).toEqual(['permissions', 'probeEvidence', 'stop'])
  // Passive repeated reads do not allocate another owner or submit input.
  expect((await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, false, { unattendedTeam: true })).state).toBe('available')
  expect(operations).toEqual(['permissions', 'probeEvidence', 'stop'])
})

for (const cleanup of [false, true]) test(`deadline during ${cleanup ? 'retirement preserves cleanup uncertainty' : 'observation names its phase without another input'}`, async () => {
  const f = await originalProbe(true, { automaticReplacementUsed: true })
  const operations: string[] = []
  let clock = Date.now()
  const deadline = clock + 10000
  restores.push(spyOn(Date, 'now').mockImplementation(() => clock))
  restores.push(spyOn(controls, 'discoverOpenCodeV2Run').mockImplementation(async () => ({ binding: f.binding }) as never),
    spyOn(controls, 'requestOpenCodeV2Run').mockImplementation(async (_owner, request): Promise<RunControlResult> => {
      operations.push(request.operation)
      if (cleanup && request.operation === 'permissions') return { kind: 'permissions', requests: [{}] } as RunControlResult
      clock = deadline + 1
      if (cleanup) return { kind: 'stop', state: 'cleanup_unknown', ownerRetired: false, members: [] } as RunControlResult
      throw Error('run_control_timeout')
    }))
  const options = { deadline }
  if (cleanup) {
    expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, options))
      .toEqual({ state: 'failed', proof: null, reason: 'native_execution_cancelled; probe_physical_cleanup_unknown' })
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ retired: false, automaticReplacementUsed: true })
  } else {
    await expect(probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, true, options))
      .rejects.toThrow('execution_timeout:model_observe')
    expect(await readFile(f.file, 'utf8')).toBe(f.saved)
  }
  expect(operations).toEqual(cleanup ? ['permissions', 'stop'] : ['permissions'])
})

test('cached missing-provider failure names the selected provider and passive reads cannot replace it', async () => {
  const failure = { category: 'selected_provider_not_in_v2_catalog', operation: { operation: 'provider-read', stage: 'decode', status: 404 } }
  const f = await originalProbe(false, { failure: 'native_owner_retired', retired: true, ownerFailure: failure, automaticReplacementUsed: true })
  const counter = countLaunches()
  for (const run of [false, true]) expect(await probes.resolveOpenCodeV2ExecutionProbe(f.request, f.selection, run))
    .toEqual({ state: 'failed', proof: null, reason: 'native_owner_retired:selected_provider_not_in_v2_catalog:provider-read:decode:404; provider provider is not part of this OpenCode V2 catalog' })
  expect(counter.launches).toBe(0)
  expect(await readFile(f.file, 'utf8')).toBe(f.saved)
})


test('probe planning aborts during real source hashing without launching an owner', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const abort = new AbortController(), hash = nativeIdentity.hashOpenCodeFile
  let sourceReads = 0
  restores.push(spyOn(nativeIdentity, 'hashOpenCodeFile').mockImplementation(async (file, signal) => {
    const result = await hash(file, signal)
    if (file.includes(path.sep + 'src' + path.sep)) { sourceReads++; abort.abort(Error('TEST-plan-expired')) }
    return result
  }))
  await expect(launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-controller', undefined,
    { signal: abort.signal, deadlineMs: Date.now() + 10000 })).rejects.toThrow('TEST-plan-expired')
  expect(sourceReads).toBeGreaterThan(0)
  expect(await readdir(path.join(root, 'app-data/opencode/v2'))).not.toContain('runs')
})

test('owner startup refuses a deadline spent in source validation before reserving or spawning', async () => {
  const request = envelope(), selection = await inspectOpenCodeV2SourceAvailability(request)
  const preparedPlan = await launchPlans.buildOpenCodeV2InternalRunPlan(selection, request.body, 'TEST-controller')
  const bunPath = await realpath(process.execPath), bunSha256 = await nativeIdentity.hashOpenCodeFile(bunPath)
  let clock = Date.now(), reservations = 0
  const plan = { ...preparedPlan, deadline: clock + 10000, source: { ...preparedPlan.source, bunPath, bunSha256 },
    members: preparedPlan.members.map(member => ({ ...member, native: { ...member.native, bun: { path: bunPath, sha256: bunSha256 } } })) }
  const resolve = delivery.resolveOpenCodeV2ExecutionDelivery
  restores.push(spyOn(Date, 'now').mockImplementation(() => clock),
    spyOn(delivery, 'resolveOpenCodeV2ExecutionDelivery').mockImplementation(async (...args) => {
      const result = await resolve(...args); clock = plan.deadline + 1; return result
    }),
    spyOn(controls, 'reserveRunControlDirectory').mockImplementation(async () => { reservations++; throw Error('TEST-late-effect-forbidden') }))
  const error = await runOwners.launchExplicitOpenCodeV2Run(plan).catch(error => error)
  expect(error.message).toBe('execution_timeout:owner_start')
  expect(runOwners.readOpenCodeV2RunNotStartedFailure(error)).toEqual({ bindingHash: executionHash(plan.binding) })
  expect(reservations).toBe(0)
}, 30000)


test.skipIf(!posix)('a proven no-spawn probe deadline settles after reservation and only an explicit retry can recover', async () => {
  const request = { ...envelope(), timeoutMs: 60000 }, selection = await inspectOpenCodeV2SourceAvailability(request)
  const bunPath = await realpath(process.execPath), bunSha256 = await nativeIdentity.hashOpenCodeFile(bunPath)
  const build = launchPlans.buildOpenCodeV2InternalRunPlan, launch = runOwners.launchExplicitOpenCodeV2Run
  const reserve = controls.reserveRunControlDirectory
  let clock = Date.now(), launches = 0, reservations = 0, spawns = 0, file = '', originalDirectory = ''
  let template: Awaited<ReturnType<typeof build>> | undefined
  restores.push(spyOn(Date, 'now').mockImplementation(() => clock),
    spyOn(launchPlans, 'buildOpenCodeV2InternalRunPlan').mockImplementation(async (...args) => {
      const plan = template ? { ...template, binding: { ...template.binding, teamId: String(args[1].teamId),
        runId: String(args[1].runId), controllerInstanceId: args[2] } } : await build(...args)
      template = { ...plan, source: { ...plan.source, bunPath, bunSha256,
        files: plan.source.files.filter(file => file.path === plan.source.entryPath) },
        members: plan.members.map(member => ({ ...member, native: { ...member.native, bun: { path: bunPath, sha256: bunSha256 } } })) }
      return template
    }),
    spyOn(controls, 'reserveRunControlDirectory').mockImplementation(async (...args) => {
      reservations++; originalDirectory = await reserve(...args)
      clock += 60000 // Spend the command budget only after its real private launch fence exists.
      return originalDirectory
    }),
    spyOn(childProcesses, 'spawn').mockImplementation(() => { spawns++; throw Error('TEST-native-spawn-forbidden') }),
    spyOn(runOwners, 'launchExplicitOpenCodeV2Run').mockImplementation(async plan => {
      launches++
      if (launches === 1) return launch(plan)
      // A caller-shaped timeout after launch entry has no positive no-spawn receipt.
      throw Object.assign(Error('execution_timeout:owner_start'), { bindingHash: executionHash(plan.binding) })
    }))
  const options = { unattendedTeam: true, onPrepared: async (sourceKey: string) => {
    file = path.join(root, 'app-data/opencode/v2/execution-probes', sourceKey, 'probe.json')
  } }
  await expect(probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, options)).rejects.toThrow('execution_timeout:owner_start')
  const settledBytes = await readFile(file, 'utf8'), settled = JSON.parse(settledBytes)
  expect(settled).toMatchObject({ submitted: false, retired: true, proof: null, failure: 'native_owner_not_started' })
  expect({ launches, reservations, spawns }).toEqual({ launches: 1, reservations: 1, spawns: 0 })
  const original = { sourceKey: settled.sourceKey, binding: settled.binding, sessionID: settled.sessionID, intentHash: executionHash(settled.intent) }
  for (const followup of [{ ...options, run: false }, { ...options, run: true, requireExisting: original }]) {
    expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, followup.run, followup))
      .toEqual({ state: 'failed', proof: null, reason: 'native_owner_not_started' })
  }
  expect(await readFile(file, 'utf8')).toBe(settledBytes)
  expect(launches).toBe(1)
  await lstat(path.join(originalDirectory, 'start.json')) // The old custody fence is preserved.
  await expect(probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, options)).rejects.toThrow('execution_timeout:owner_start')
  const unknownBytes = await readFile(file, 'utf8'), unknown = JSON.parse(unknownBytes)
  expect(unknown.binding).not.toEqual(settled.binding)
  expect(unknown).toMatchObject({ submitted: false, retired: false, failure: null })
  for (const run of [false, true]) {
    expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, run, options)).toMatchObject({ state: 'pending', proof: null })
    expect(await readFile(file, 'utf8')).toBe(unknownBytes)
  }
  await writeFile(file, JSON.stringify({ ...unknown, submitted: true }), { mode: 0o600 })
  expect(await probes.resolveOpenCodeV2ExecutionProbe(request, selection, true, options)).toMatchObject({ state: 'pending', proof: null })
  expect({ launches, reservations, spawns }).toEqual({ launches: 2, reservations: 1, spawns: 0 })
}, 30000)
