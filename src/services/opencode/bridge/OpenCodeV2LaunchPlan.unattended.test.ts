import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as profiles from '../OpenCodeProfileManager.js'
import * as nativeIdentity from '../compatibility/OpenCodeNativeIdentity.js'
import * as receipts from '../profile/OpenCodeV2ExecutionReceipt.js'
import * as mcp from '../OpenCodeMcpManager.js'
import * as probes from './OpenCodeV2ExecutionProbe.js'
import { buildOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { attachOpenCodeV2SelectedKey } from '../host/OpenCodeV2ExecutionAuth.js'
import { createOpenCodeV2PreparedMember, createOpenCodeV2LaunchPlan, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run, startOpenCodeV2RunSupervisor } from './OpenCodeV2RunOwner.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { OpenCodePreparedProfile, OpenCodeProfileScope, OpenCodeProvisioningSnapshot } from '../types.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'

let root: string, project: string, pin: '2.0.0' | '2.0.21' = '2.0.21'
let saved: NodeJS.ProcessEnv
let nativeSelectionCalls = 0, nativeReceiptCalls = 0
let authContent = '{}\n'
let metadataAuthIdentity: OpenCodeProfileScope['selectedAuthIdentity'] = 'absent'
const restores: { mockRestore(): void }[] = []
const behavior = 'b'.repeat(64)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function native(): ValidatedExecutionNative {
  return { generation: 'v2', version: pin, dialect: pin === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.21',
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
  nativeSelectionCalls = 0; nativeReceiptCalls = 0
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
    spyOn(receipts, 'createOpenCodeV2ExecutionReceipt').mockImplementation(async () => { nativeReceiptCalls++; return native() }),
    spyOn(mcp, 'resolveOpenCodeAppMcpLaunchConfig').mockImplementation(async () => ({ config: {
      type: 'remote', enabled: true, url: 'http://127.0.0.1:1/mcp' }, source: 'env-override' })))
})
afterEach(async () => {
  for (const restore of restores.splice(0)) restore.mockRestore()
  for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  await rm(root, { recursive: true, force: true })
})
async function proof(prepared: OpenCodePreparedProfile, capabilitySnapshotId: string) {
  const snapshot = { projectPath: project, profile: prepared, hostHealthy: true, host: { profile: prepared, version: pin,
    resolvedConfigFingerprint: prepared.managedConfigFingerprint } } as OpenCodeProvisioningSnapshot
  return buildOpenCodeExecutionProof({ selectedModel: 'provider/model', snapshot, capabilitySnapshotId }, {
    resolveBinaryPath: () => native().executablePath, resolveBinaryIdentity: async () => 'TEST-native-identity', readCredential: async () => null })
}
for (const version of ['2.0.0', '2.0.21'] as const) test(`${version} absent selected auth routes prepared profiles through native free-model readback while sealing paid keys`, async () => {
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
for (const version of ['2.0.0', '2.0.21'] as const) test(`${version} admits Linux and Darwin selection but fences unsupported hosts before identity reads`, async () => {
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
for (const version of ['2.0.0', '2.0.21'] as const) test(`${version} team launch requires the same unattended profile as its strict proof`, async () => {
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
