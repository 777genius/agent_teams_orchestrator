import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as profiles from '../OpenCodeProfileManager.js'
import * as nativeIdentity from '../compatibility/OpenCodeNativeIdentity.js'
import * as receipts from '../profile/OpenCodeV2ExecutionReceipt.js'
import * as mcp from '../OpenCodeMcpManager.js'
import * as probes from './OpenCodeV2ExecutionProbe.js'
import { buildOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createOpenCodeV2PreparedMember, createOpenCodeV2LaunchPlan, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { OpenCodePreparedProfile, OpenCodeProfileScope, OpenCodeProvisioningSnapshot } from '../types.js'
import type { ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'

let root: string, project: string, pin: '2.0.0' | '2.0.21' = '2.0.21'
let saved: NodeJS.ProcessEnv
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
    startedAt: new Date().toISOString(), timeoutMs: 8000,
    body: { teamId: 'TEST-team', teamName: 'TEST-team', runId: 'TEST-run', laneId: 'primary',
      selectedModel: 'provider/model', skipPermissions: true, members: [{ name: 'worker' }] } }
}
beforeEach(async () => {
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
      await writeFile(authPath, '{}\n', { mode: 0o600 }); return {}
    }),
    spyOn(profiles, 'readOpenCodeSelectedScopeMetadata').mockImplementation(async () => ({ projectBehaviorFingerprint: behavior,
      behaviorSources: [], selectedAuthIdentity: 'absent', authoritySourceFingerprint: 'd'.repeat(64) })),
    spyOn(profiles, 'collectProjectBehaviorMetadata').mockImplementation(async () => ({ projectBehaviorFingerprint: behavior, behaviorSources: [] })),
    spyOn(nativeIdentity, 'inspectOpenCodeReadSelection').mockImplementation(async () => ({ path: native().executablePath,
      policy: { generation: 'v2', version: pin, dialect: native().dialect }, native: native(), fingerprint: native().executableSha256 })),
    spyOn(receipts, 'createOpenCodeV2ExecutionReceipt').mockImplementation(async () => native()),
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
  const plan = await createOpenCodeV2LaunchPlan(launch)
  expect(plan.members[0]?.profile.config.sha256).toBe(samePolicyProof.managedConfigFingerprint)
  const changedPolicyProof = await proof(generic.prepared, selection.capabilitySnapshotId)
  probe.mockImplementation(async () => ({ state: 'available', proof: changedPolicyProof, reason: null }))
  await expect(createOpenCodeV2LaunchPlan({ ...launch, body: { ...launch.body, executionProof: changedPolicyProof,
    preconditions: { ...preconditions, expectedBehaviorFingerprint: changedPolicyProof.expectedBehaviorEvidence.expectedBehaviorFingerprint } } }))
    .rejects.toThrow('run_launch_config_variant_changed')
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
