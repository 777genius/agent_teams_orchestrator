import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 } from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'
import type { OwnerV2LaunchSelection } from '../../../src/services/hostedControl/HostedControlBootstrapV2Launch.js'
import { canonicalV2, hashV2, HEX_V2, immutableV2, pathV2, recordV2, requireV2, textV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'

export const OWNER_V2_INVOCATION = '--hosted-actual-owner-sealed-protocol=v2'
export const OWNER_V2_RUNTIME_MANIFEST = '/sandbox/runtime-manifest.json'
const CAPTURES = ['conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
  'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath'] as const
const SLOTS = { ownerWalTimeline: 9, conditionalPostLedger: 9, productTimeline: 10,
  negativeResults: 9, openCodeTimeline: 9, protectedEffectLedger: 10 } as const
export function parseOwnerV2Invocation(args: readonly string[]): typeof OWNER_V2_RUNTIME_MANIFEST {
  requireV2(args.length === 3 && args[0] === OWNER_V2_INVOCATION && args[1] === '--runtime-manifest' &&
    args[2] === OWNER_V2_RUNTIME_MANIFEST, 'invocation')
  return OWNER_V2_RUNTIME_MANIFEST
}
function json(bytes: Buffer, canonical: boolean): unknown {
  requireV2(bytes.length > 1 && bytes.length <= 1024 * 1024, 'manifest_size')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const value = JSON.parse(text)
  // Product's source contract is pretty printed and hash-pinned. Runtime
  // publications are compact JSON with at most the existing final LF.
  if (canonical) requireV2(text === JSON.stringify(value) || text === `${JSON.stringify(value)}\n`, 'manifest_canonical')
  canonicalV2(value) // Reject malformed Unicode and noncanonical numeric values.
  return value
}
/** Mirrors SupervisorPlan.runtimeManifest in Product processes.ts. It does NOT
 * parse the unrelated legacy acceptance manifest or contract-file argv. */
export function parseOwnerRuntimeManifestV2(bytes: Buffer, selection: OwnerV2LaunchSelection) {
  requireV2(hashV2(bytes) === selection.runtimeManifestSha256, 'runtime_manifest_pin')
  const r = recordV2(json(bytes, true), 'schemaVersion,purpose,runId,sandboxRoot,markerPath,evidenceRoot,driverBaseUrl,productBaseUrl,approvalPath,browser,capture,captureEmissionContract,refs')
  const e = selection.expectedHost
  requireV2(r.schemaVersion === 1 && r.purpose === 'agent-teams.hosted-actual-owner-e2e/v1' &&
    r.runId === e.activation.runId && r.sandboxRoot === '/sandbox' && r.markerPath === '/sandbox/.p3c-sandbox.json' &&
    r.evidenceRoot === '/sandbox/evidence' && r.driverBaseUrl === 'http://127.0.0.1:45130/' &&
    r.productBaseUrl === 'http://127.0.0.1:45131/' && r.approvalPath === '/api/hosted/v1/team-approvals/decisions', 'runtime_manifest_shape')
  textV2(r.runId, HEX_V2)
  const browser = recordV2(r.browser, 'workers,retries')
  requireV2(browser.workers === 1 && browser.retries === 0, 'runtime_browser')
  const capture = recordV2(r.capture, CAPTURES.join(','))
  for (const name of CAPTURES) requireV2(capture[name] === `/sandbox/capture/${name}.ndjson`, 'runtime_capture')
  const c = recordV2(r.captureEmissionContract, 'contract,version,contractSha256,environment,framing,descriptorSlots,verifierMayProduceBytes,producerNativeIdentitiesComposed')
  recordV2(c.descriptorSlots, Object.keys(SLOTS).join(','))
  requireV2(c.contract === 'claude-team/hosted-producer-provenance' && c.version === 2 &&
    c.contractSha256 === HOSTED_OWNER_PROVENANCE_CONTRACT_SHA256 && c.environment === 'CLAUDE_TEAM_PRODUCER_PROVENANCE_V2' &&
    c.framing === 'canonical-ndjson' && canonicalV2(c.descriptorSlots) === canonicalV2(SLOTS) &&
    c.verifierMayProduceBytes === false && c.producerNativeIdentitiesComposed === false, 'runtime_capture_contract')
  const refs = recordV2(r.refs, 'openCode,openCodeExecutableSha256,orchestrator,product')
  for (const name of ['openCode', 'orchestrator', 'product'] as const) {
    textV2(refs[name], /^[0-9a-f]{40}$/); requireV2(refs[name] === selection.refs[name], 'runtime_ref')
  }
  requireV2(refs.openCodeExecutableSha256 === e.executable.sha256, 'runtime_opencode_pin')
  // These flags describe Product's fixed manifest. None authorizes execution,
  // native qualification, raw custody, or a provider fallback.
  return immutableV2(r)
}
export function readOwnerRuntimeManifestV2(path: string, selection: OwnerV2LaunchSelection): void {
  requireV2(path === OWNER_V2_RUNTIME_MANIFEST, 'runtime_manifest_path')
  parseOwnerRuntimeManifestV2(readPinnedFile(path, selection.runtimeManifestSha256, 0o400), selection)
  const bytes = readPinnedFile(selection.harnessContractPath, selection.harnessContractSha256)
  const c = recordV2(json(bytes, false), 'schemaVersion,purpose,productAuthorityCommit,packetBaseCommit,integrationDescriptor,sandbox,filesystemConfinement,processOwnership,ownerChildProtocol,evidence,productionEligible,finalE2EAuthorizedByHarnessImplementation')
  requireV2(c.schemaVersion === 2 && c.purpose === 'agent-teams.p3c.actual-owner-harness/v2', 'product_contract')
  const protocol = c.ownerChildProtocol as Record<string, unknown>
  requireV2(protocol && canonicalV2(protocol.sealedArgv) === canonicalV2([OWNER_V2_INVOCATION, '--runtime-manifest', OWNER_V2_RUNTIME_MANIFEST]) &&
    protocol.compatibilityProbingPermitted === false && protocol.socketPathReconnectPermitted === false, 'product_child_protocol')
  // Do not guess the downstream map-v2/cleanup-v3 JSON field names. The selected
  // source bytes must first amend their existing FD3/4/5 declarations. r885's
  // published harness contract still says v1 and correctly fails above.
  const descriptors = protocol.descriptorContracts as Record<string, Record<string, unknown>>
  requireV2(descriptors?.fd3?.format === 'agent-teams.hosted-control.launcher-lease/v2' &&
    descriptors.fd4?.format === 'agent-teams.hosted-control.bootstrap/v2' &&
    descriptors.fd5?.protocol === 'agent-teams.hosted-approval-activation-v2', 'product_descriptor_contract')
}
function readPinnedFile(path: string, sha256: string, mode?: number): Buffer {
  pathV2(path); textV2(sha256, HEX_V2)
  let parent = dirname(path)
  for (;;) {
    const s = lstatSync(parent)
    requireV2(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022) === 0, 'manifest_parent')
    if (parent === '/') break
    parent = dirname(parent)
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | 0o2000000 /* Linux O_CLOEXEC */)
  try {
    const s = fstatSync(fd, { bigint: true })
    requireV2(s.isFile() && s.nlink === 1n && s.size > 1n && s.size <= 1024n * 1024n &&
      (s.mode & 0o022n) === 0n && (mode === undefined || Number(s.mode & 0o7777n) === mode) &&
      s.uid === BigInt(process.getuid!()), 'manifest_file')
    const bytes = Buffer.alloc(Number(s.size)); let at = 0
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); requireV2(n > 0, 'manifest_eof'); at += n }
    const after = fstatSync(fd, { bigint: true }), linked = lstatSync(path, { bigint: true })
    requireV2(after.dev === s.dev && after.ino === s.ino && after.size === s.size && after.mtimeNs === s.mtimeNs &&
      after.ctimeNs === s.ctimeNs && linked.dev === s.dev && linked.ino === s.ino && !linked.isSymbolicLink() &&
      hashV2(bytes) === sha256, 'manifest_changed')
    return bytes
  } finally { closeSync(fd) }
}
