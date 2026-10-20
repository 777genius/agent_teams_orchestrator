import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as profiles from '../OpenCodeProfileManager.js'
import * as nativeIdentity from '../compatibility/OpenCodeNativeIdentity.js'
import * as receipts from '../profile/OpenCodeV2ExecutionReceipt.js'
import * as mcp from '../OpenCodeMcpManager.js'
import * as probes from './OpenCodeV2ExecutionProbe.js'
import * as launchPlans from './OpenCodeV2LaunchPlan.js'
import * as privateDirectories from '../profile/OpenCodePrivateDirectories.js'
import * as windowsBroker from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import * as windowsFilesystem from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import * as projectIdentity from '../OpenCodeProjectIdentity.js'
import { buildOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { attachOpenCodeV2SelectedKey } from '../host/OpenCodeV2ExecutionAuth.js'
import { createOpenCodeV2PreparedMember, createOpenCodeV2LaunchPlan, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run, startOpenCodeV2RunSupervisor } from './OpenCodeV2RunOwner.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { OpenCodePreparedProfile, OpenCodeProfileScope, OpenCodeProvisioningSnapshot } from '../types.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'

let root: string, project: string, pin: '2.0.0' | '2.0.32' = '2.0.32'
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
  return { generation: 'v2', version: pin, dialect: pin === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.32',
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
async function proof(prepared: OpenCodePreparedProfile, capabilitySnapshotId: string, platform?: NodeJS.Platform) {
  const snapshot = { projectPath: project, profile: prepared, hostHealthy: true, host: { profile: prepared, version: pin,
    resolvedConfigFingerprint: prepared.managedConfigFingerprint } } as OpenCodeProvisioningSnapshot
  return buildOpenCodeExecutionProof({ selectedModel: 'provider/model', snapshot, capabilitySnapshotId }, {
    resolveBinaryPath: () => native().executablePath, resolveBinaryIdentity: async () => 'TEST-native-identity', readCredential: async () => null, platform })
}
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
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun')!
  try {
    for (const host of ['linux', 'darwin'] as const) {
      Object.defineProperty(process, 'platform', { ...platform, value: host })
      const selection = await inspectOpenCodeV2SourceAvailability(envelope())
      expect(selection.native.version).toBe(version)
      expect(selection.installedGraphFiles).toBeGreaterThan(0)
      expect(selection.model).toEqual({ providerID: 'provider', id: 'model' })
    }
    expect(nativeSelectionCalls).toBe(2)
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('execution_containment_platform_pending')
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    Object.defineProperty(process.versions, 'bun', { ...bun, value: '1.3.10' })
    await expect(inspectOpenCodeV2SourceAvailability(envelope())).rejects.toThrow('run_source_bun_required')
    expect(nativeSelectionCalls).toBe(2)
  } finally {
    Object.defineProperty(process, 'platform', platform)
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
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    await expect(launchExplicitOpenCodeV2Run(plan)).rejects.toThrow('execution_containment_platform_pending')
    await expect(startOpenCodeV2RunSupervisor(plan, '/TEST-unqualified', 'TEST')).rejects.toThrow('execution_containment_platform_pending')
  } finally { Object.defineProperty(process, 'platform', platform) }
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

for (const refuse of [false, true]) for (const cleanupRefused of [false, true]) test(`Windows prepared member creates its database before closing native publishers (refused=${refuse}, cleanupRefused=${cleanupRefused})`, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const events: string[] = []
  const refusal = new Error('execution_owner_unknown:prepared_database_exists:80')
  const closeData = windowsBroker.decodeWindowsNativeFailure({ error: 'execution_native_unknown', stage: 'owner_metadata_cleanup', nativeCode: 5 }, 'ownerCloseDirectory')
  const closeConfig = new Error('execution_owner_unknown'), closeBroker = new Error('cleanup_unknown')
  let databasePath: string | undefined
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    const selection = await inspectOpenCodeV2SourceAvailability(envelope())
    const parent = path.join(root, 'profiles'); await mkdir(parent)
    const unused = async (): Promise<never> => { throw new Error('TEST unexpected owner operation') }
    const unusedFilesystem = windowsFilesystem.createWindowsOwnerFilesystem(unused)
    restores.push(
      spyOn(privateDirectories, 'ensureWindowsPrivateDirectories').mockImplementation(async directories => {
        for (const directory of directories) await mkdir(directory, { recursive: true })
      }),
      spyOn(windowsBroker, 'resolveWindowsNativeArtifact').mockResolvedValue({ path: '/TEST/helper.exe', sha256: 'a'.repeat(64), arch: 'x64' }),
      spyOn(windowsBroker, 'createWindowsNativeBroker').mockReturnValue({
        events: new EventEmitter(), ended: () => false,
        request: async () => { throw new Error('TEST unexpected native request') },
        close: async () => { events.push('broker-close'); if (cleanupRefused) throw closeBroker },
      }),
      spyOn(windowsFilesystem, 'createWindowsOwnerFilesystem').mockReturnValue({
        ...unusedFilesystem,
        createDirectory: async (directory: string) => {
          await mkdir(directory)
          const role = directory.endsWith(path.join('config', 'opencode')) ? 'config' : 'data'
          return {
            identity: { volumeSerial: '1', fileId: '1'.repeat(32), ownerSid: 'S-1-5-21-1' },
            assertOwned: unused, writeExclusive: unused, writePreparedAuth: unused,
            readRecord: unused, readMetadata: unused, writeMetadata: unused, archive: unused,
            writePreparedConfig: async (content: string) => {
              events.push('config'); await writeFile(path.join(directory, 'opencode.json'), content, { flag: 'wx' })
            },
            createPreparedDatabase: async () => {
              expect(role).toBe('data')
              expect(await readFile(path.join(directory, 'auth.json'), 'utf8')).toBe(authContent)
              expect(events).toEqual(['config'])
              events.push('database')
              databasePath = path.join(directory, 'opencode.db')
              if (refuse) throw refusal
              await writeFile(databasePath, '', { flag: 'wx' })
            },
            close: async () => { events.push(`close-${role}`); if (cleanupRefused) throw role === 'data' ? closeData : closeConfig },
          } satisfies windowsFilesystem.WindowsOwnerDirectory
        },
      }),
    )
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const prepared = createOpenCodeV2PreparedMember(selection, native(), parent,
      { teamId: 'TEST-team', runId: 'TEST-run', memberId: 'worker', unattendedTeam: true })
    if (cleanupRefused) {
      const failure = await prepared.catch(error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.message).toBe('cleanup_unknown')
      expect(failure.cause).toBe(refuse ? refusal : closeData)
      expect(failure.errors).toEqual([...(refuse ? [refusal] : []), closeData, closeConfig, closeBroker])
      expect(failure.errors[refuse ? 1 : 0]).toBe(closeData)
      expect(Reflect.get(closeData, 'nativeOperation')).toBe('ownerCloseDirectory')
    } else if (refuse) await expect(prepared).rejects.toBe(refusal)
    else {
      const result = await prepared
      if (databasePath === undefined) throw new Error('TEST native database creation was not called')
      expect(result.profile.databasePath).toBe(databasePath)
      expect(await readFile(result.profile.databasePath)).toHaveLength(0)
    }
    expect(events).toEqual(['config', 'database', 'close-data', 'close-config', 'broker-close'])
  } finally { Object.defineProperty(process, 'platform', platform) }
})

for (const refuse of [false, true]) for (const cleanupRefused of [false, true]) test(`Windows probe privately creates only its two exclusive controller leaves before planning (refused=${refuse}, cleanupRefused=${cleanupRefused})`, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const stoppedBeforeLaunch = new Error('TEST complete controller preparation')
  const refusal = new Error('execution_profile_owned')
  const closeDirectory = windowsBroker.decodeWindowsNativeFailure({ error: 'execution_native_unknown', stage: 'owner_metadata_cleanup', nativeCode: 6 }, 'ownerCloseDirectory')
  const closeBroker = new Error('cleanup_unknown')
  const identity = { volumeSerial: '1', fileId: '1'.repeat(32), ownerSid: 'S-1-5-21-1' }
  let allocations = 0, planned = 0, closed = false
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    const selection = await inspectOpenCodeV2SourceAvailability(envelope())
    const controller = path.join(root, 'controller'); await mkdir(controller)
    for (const kind of ['teams', 'tasks']) await mkdir(path.join(controller, kind))
    const unused = async (): Promise<never> => { throw new Error('TEST unexpected owner operation') }
    const filesystem = windowsFilesystem.createWindowsOwnerFilesystem(unused)
    restores.push(
      spyOn(windowsBroker, 'resolveWindowsNativeArtifact').mockResolvedValue({ path: '/TEST/helper.exe', sha256: 'a'.repeat(64), arch: 'x64' }),
      spyOn(windowsBroker, 'createWindowsNativeBroker').mockReturnValue({
        events: new EventEmitter(), ended: () => closed, request: unused,
        close: async () => { closed = true; if (cleanupRefused) throw closeBroker },
      }),
      spyOn(windowsFilesystem, 'createWindowsOwnerFilesystem').mockReturnValue({ ...filesystem,
        prepareDirectory: async (directory: string) => {
          await mkdir(directory, { recursive: true })
          return { identity, assertOwned: async () => {}, close: async () => { if (cleanupRefused) throw closeDirectory },
            writeMetadata: async (purpose) => {
              if (purpose !== 'ProbeGuard') throw new Error('TEST unexpected probe submission')
              await writeFile(path.join(directory, 'owner.lock'), '', { flag: 'wx' })
            },
            readMetadata: async (purpose) => ({ purpose, directoryIdentity: identity,
              path: path.join(directory, purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json'),
              fileIdentity: purpose === 'ProbeGuard' ? identity : null, bytes: 0,
              ...(purpose === 'ProbeRecord' ? { absent: true as const } : {}) }),
            writeExclusive: unused, createPreparedDatabase: unused, writePreparedConfig: unused,
            writePreparedAuth: unused, readRecord: unused, archive: unused,
          } satisfies windowsFilesystem.WindowsOwnerDirectory
        },
      }),
      spyOn(privateDirectories, 'ensureWindowsPrivateDirectories').mockImplementation(async (leaves, exclusive) => {
        allocations++
        if (!exclusive) throw new Error('TEST exclusive controller leaves required')
        expect(leaves).toEqual(exclusive)
        expect(leaves).toHaveLength(2)
        expect(leaves.map(leaf => path.dirname(leaf))).toEqual([path.join(controller, 'teams'), path.join(controller, 'tasks')])
        expect(path.basename(leaves[0]!)).toMatch(/^TEST-execution-probe-[a-f0-9]{32}$/)
        expect(path.basename(leaves[1]!)).toBe(path.basename(leaves[0]!))
        if (refuse) throw refusal
        for (const leaf of leaves) await mkdir(leaf) // Exclusive: the fixture never repairs an existing leaf.
      }),
      spyOn(launchPlans, 'buildOpenCodeV2InternalRunPlan').mockImplementation(async (_selection, body) => {
        planned++
        expect(allocations).toBe(1)
        for (const kind of ['teams', 'tasks']) expect(await readdir(path.join(controller, kind))).toEqual([body.teamId as string])
        throw stoppedBeforeLaunch
      }),
    )
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const result = probes.resolveOpenCodeV2ExecutionProbe(envelope(), { ...selection,
      controller: { type: 'local', command: [process.execPath, '/TEST/controller.mjs'],
        environment: { AGENT_TEAMS_MCP_CLAUDE_DIR: controller } } }, true)
    if (cleanupRefused) {
      const failure = await result.catch(error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect(failure.cause).toBe(refuse ? refusal : stoppedBeforeLaunch)
      expect(failure.errors[0]).toBe(failure.cause)
      const cleanup = failure.errors[1]
      expect(cleanup).toBeInstanceOf(AggregateError)
      expect(cleanup.cause).toBe(closeDirectory)
      expect(cleanup.errors.length).toBeGreaterThan(1)
      expect(cleanup.errors.slice(0, -1).every((error: unknown) => error === closeDirectory)).toBe(true)
      expect(cleanup.errors.at(-1)).toBe(closeBroker)
    } else await expect(result).rejects.toBe(refuse ? refusal : stoppedBeforeLaunch)
    expect(allocations).toBe(1); expect(planned).toBe(refuse ? 0 : 1); expect(closed).toBe(true)
  } finally { Object.defineProperty(process, 'platform', platform) }
})
