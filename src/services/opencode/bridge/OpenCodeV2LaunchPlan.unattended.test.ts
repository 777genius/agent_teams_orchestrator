import { claimOpenCodeV2FreshProofRequest } from './OpenCodeV2FreshProofRequest.js'
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
import * as runOwners from './OpenCodeV2RunOwner.js'
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
async function proof(prepared: OpenCodePreparedProfile, capabilitySnapshotId: string, platform?: NodeJS.Platform, verifiedAt?: string) {
  const snapshot = { projectPath: project, profile: prepared, hostHealthy: true, host: { profile: prepared, version: pin,
    resolvedConfigFingerprint: prepared.managedConfigFingerprint } } as OpenCodeProvisioningSnapshot
  return buildOpenCodeExecutionProof({ selectedModel: 'provider/model', snapshot, capabilitySnapshotId, verifiedAt }, {
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
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
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
    // Windows execution ships for x64 only.
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
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
    // No V2 version is qualified on Windows arm64, so launch refuses before any process work.
    await expect(launchExplicitOpenCodeV2Run(plan)).rejects.toThrow('opencode_v2_version_unqualified')
    await expect(startOpenCodeV2RunSupervisor(plan, '/TEST-unqualified', 'TEST')).rejects.toThrow('execution_platform_unsupported')
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
