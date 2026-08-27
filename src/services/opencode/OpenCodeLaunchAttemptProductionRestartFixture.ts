/**
 * Separate-process production composition fixture for issue #443 tests.
 * It is invoked directly by Bun, never by the application or a real provider.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { computeOpenCodeLaunchRequestCorrelationDigest,
  type OpenCodeLaunchAttemptBridgePort } from './OpenCodeLaunchAttemptBridge.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { OpenCodeProfileManager } from './OpenCodeProfileManager.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { createOpenCodeLaunchAttemptProductionTestBridge,
  OpenCodeLaunchHostReleaseLedger } from './OpenCodeLaunchAttemptProduction.js'

const root = process.env.OPENCODE_RESTART_FIXTURE_ROOT
const phase = process.argv[2]
if (!root || (phase !== 'acquire' && phase !== 'replay'
  && phase !== 'crash-after-receipt' && phase !== 'crash-before-disposition')) {
  throw new Error('restart fixture requires a supported acquisition/replay phase')
}

const project = path.join(root, 'project')
const data = path.join(root, 'data')
const cache = path.join(root, 'cache')
const userHome = path.join(root, 'home')
const fixtureName = `opencode-host-fixture${process.platform === 'win32' ? '.exe' : ''}`
const fixtureBinary = path.resolve(import.meta.dir, '../../../native/opencode-host-fixture/target/debug', fixtureName)
Object.assign(process.env, {
  CLAUDE_MULTIMODEL_DATA_HOME: data,
  CLAUDE_MULTIMODEL_CACHE_HOME: cache,
  CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: fixtureBinary,
  HOME: userHome,
  USERPROFILE: userHome,
  XDG_CONFIG_HOME: path.join(root, 'user-config'),
  XDG_DATA_HOME: path.join(root, 'user-data'),
  DEEPINFRA_API_KEY: 'static-fixture-key',
  ...(process.platform === 'win32' ? {} : {
    PATH: ['/usr/bin', '/bin', process.env.PATH ?? ''].join(path.delimiter),
  }),
})
delete process.env.OPENCODE_CONFIG
delete process.env.OPENCODE_CONFIG_CONTENT

const identity = (character: string) => `sha256:${character.repeat(64)}` as const
const profileManager = new OpenCodeProfileManager()
const current = await profileManager.captureCurrentScopedProfilePlan({
  purpose: 'launch', providerId: 'deepinfra', modelId: 'deepinfra/static-model',
  runtimeInstanceId: '018f47a2-4a13-7c2f-8d44-c0ffee777777', projectPath: project,
})
const command: Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0] = {
  request: { launchContractVersion: 1, launchAttempt: {
    attemptId: '018f47a2-4a13-7c2f-8d44-c0ffee777777', payloadHash: '7'.repeat(64),
    generation: 1, proofNonce: 'BwcHBwcHBwcHBwcHBwcHBw',
    parent: { sessionIdentity: identity('6'), messageIdentity: identity('7') },
    providerId: 'deepinfra', modelId: 'deepinfra/static-model',
    requiredMcpTools: ['agent-teams.message_send'], requireFreshRetainedHostProof: true,
  } },
  members: [{ name: 'restart-native', memberIdentity: identity('7') }],
  runId: 'run', laneId: 'primary', teamId: 'team', projectPath: project,
  selectedModel: 'deepinfra/static-model', toolApprovalMode: 'auto', continuation: false,
  requestedBudgetMs: 10_000,
  preconditions: {
    handshakeIdentityHash: '1'.repeat(64), laneId: 'primary', expectedRunId: 'run',
    expectedCapabilitySnapshotId: null,
    expectedBehaviorFingerprint: current.evidence.projectBehaviorFingerprint,
    expectedManifestHighWatermark: null, commandLeaseId: 'lease-restart-native',
    idempotencyKey: '018f47a2-4a13-7c2f-8d44-c0ffee777777',
  },
}
command.request.launchAttempt.requestCorrelationDigest =
  computeOpenCodeLaunchRequestCorrelationDigest(command)
const registryPath = path.join(data, 'opencode', 'hosts.json')
const owner = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
const hostManager = phase === 'acquire' ? new Proxy(owner, {
  get(target, property, receiver) {
    if (property === 'reconcileHostReleaseReceipt') return async () => {
      throw new Error('deterministic process boundary before native containment release')
    }
    const member = Reflect.get(target, property, receiver)
    return typeof member === 'function' ? member.bind(target) : member
  },
}) : owner
const disconnectedMcp = { ensureAppMcp: async () => ({ mcp: {}, summary: {
  serverName: 'agent-teams', matchedServerName: null, status: 'missing', connected: false,
  launchSource: null, availableServerNames: [], diagnostics: ['static process fixture boundary'],
} }) }
const bridge = createOpenCodeLaunchAttemptProductionTestBridge({ dataDirectory: data,
  profileManager, sessionStore: new OpenCodeSessionStore(path.join(root, 'sessions.json')),
  hostManager, mcpManager: disconnectedMcp as never,
  ...(phase === 'crash-after-receipt' || phase === 'crash-before-disposition'
    ? { crashBoundary: boundary => {
      if ((phase === 'crash-after-receipt' && boundary === 'after_host_receipt_publication')
        || (phase === 'crash-before-disposition'
          && boundary === 'before_host_disposition_publication')) process.exit(86)
    } } : {}),
})
const result = await bridge.execute(command)
const ledger = new OpenCodeLaunchHostReleaseLedger(path.join(data, 'opencode', 'launch-attempts',
  `${command.request.launchAttempt.attemptId}.host-release.json`))
const receipt = await ledger.read({ attemptId: command.request.launchAttempt.attemptId,
  payloadHash: command.request.launchAttempt.payloadHash, generation: 1 }).catch(async () =>
  (await ledger.readAllPending({ attemptId: command.request.launchAttempt.attemptId,
    payloadHash: command.request.launchAttempt.payloadHash, currentGeneration: 1 }))[0] ?? null)
const projected = (result.data as { launchAttempt?: { launchAttempt?: { outcome?: string } } } | undefined)
  ?.launchAttempt
await writeFile(path.join(root, `restart-${phase}.json`), `${JSON.stringify({
  outcome: projected?.launchAttempt?.outcome,
  disposition: receipt?.disposition,
  releaseState: receipt?.releaseState,
  pid: receipt?.receipt.pid,
  processBirthToken: receipt?.receipt.processBirthToken,
  obligationId: receipt?.obligationId,
  reservationDigest: receipt?.reservationDigest,
  receiptIdentityDigest: receipt?.receiptIdentityDigest,
})}\n`)
process.exit(0)
