import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { OPEN_CODE_EXECUTION_PROOF_TTL_MS, parseOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { normalizeOpenCodeProjectIdentity } from '../OpenCodeProjectIdentity.js'
import { inspectOpenCodeV2SourceAvailability } from '../bridge/OpenCodeV2LaunchPlan.js'
import { resolveOpenCodeV2ExecutionProbe } from '../bridge/OpenCodeV2ExecutionProbe.js'
import { readOpenCodeV2StatusProofHint } from '../bridge/OpenCodeV2StatusProofHint.js'
import type { BridgeEnvelope } from '../bridge/OpenCodeBridgeProtocol.js'
import type { OpenCodeExecutionProof, OpenCodeInventorySnapshot } from '../types.js'

const windows = process.platform === 'win32'
async function ownedDirectory(directory: string, shared = false, lexical = false): Promise<boolean> {
  const stat = await lstat(directory)
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (lexical && windows || await realpath(directory) === directory) &&
    (windows || stat.uid === process.getuid?.() && (stat.mode & (shared ? 0o022 : 0o077)) === 0)
}
function matchesSnapshot(proof: OpenCodeExecutionProof, snapshot: OpenCodeInventorySnapshot, now: number): boolean {
  const verified = Date.parse(proof.verifiedAt), expires = Date.parse(proof.expiresAt)
  return proof.reusable && (proof.credentialMode === 'api' || proof.credentialMode === 'none') &&
    Number.isFinite(verified) && verified <= now && expires > now && expires - verified <= OPEN_CODE_EXECUTION_PROOF_TTL_MS &&
    proof.projectPath === normalizeOpenCodeProjectIdentity(snapshot.projectPath) &&
    proof.binaryPath === snapshot.binaryPath && proof.opencodeVersion === snapshot.version &&
    snapshot.readStatus?.models.some(model => model.enabled && model.status === 'active' &&
      `${model.providerId}/${model.catalogId}` === proof.modelId) === true
}

/** The per-project hint selects at most one private record regardless of the
 * number of retained probes. Neither file is projected without source validation. */
async function candidate(snapshot: OpenCodeInventorySnapshot): Promise<OpenCodeExecutionProof | null> {
  const requested = path.resolve(resolveClaudeMultimodelPaths().data)
  if (!await ownedDirectory(requested, true, true)) return null
  const data = await realpath(requested)
  for (const [suffix, shared] of [['opencode', true], ['opencode/v2', false], ['opencode/v2/execution-probes', false]] as const)
    if (!await ownedDirectory(path.join(data, suffix), shared)) return null
  const root = path.join(data, 'opencode/v2/execution-probes')
  const sourceKey = await readOpenCodeV2StatusProofHint(root, snapshot.projectPath)
  if (!sourceKey) return null
  const parent = path.join(root, sourceKey)
  if (!await ownedDirectory(parent)) return null
  const file = await open(path.join(parent, 'probe.json'), constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW))
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size >= 128 * 1024 ||
      !windows && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) return null
    const record = JSON.parse(await file.readFile('utf8'))
    if (record.sourceKey !== sourceKey || record.submitted !== true || record.retired !== true || record.failure != null) return null
    const proof = parseOpenCodeExecutionProof(record.proof)
    return proof && matchesSnapshot(proof, snapshot, Date.now()) ? proof : null
  } finally { await file.close() }
}

/** Display only the most recently verified model for this exact project/source.
 * Source selection revalidates native bytes, the installed graph, selected auth,
 * config and MCP. run:false cannot allocate a session or send another prompt. */
export async function readOpenCodeV2StatusProof(snapshot: OpenCodeInventorySnapshot,
  timeoutMs = 15_000): Promise<OpenCodeExecutionProof | null> {
  if (snapshot.readGeneration !== 'v2' || snapshot.readStatus?.catalog !== 'ready' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null
  const controller = new AbortController(), deadlineMs = Date.now() + Math.min(timeoutMs, 15_000)
  const timer = setTimeout(() => controller.abort(new DOMException('OpenCode status proof deadline', 'AbortError')), Math.max(1, deadlineMs - Date.now()))
  try {
    const hint = await candidate(snapshot)
    if (!hint) return null
    const envelope: BridgeEnvelope = { schemaVersion: 1, requestId: randomUUID(), command: 'opencode.readiness',
      cwd: snapshot.projectPath, startedAt: new Date().toISOString(), timeoutMs: 60_000,
      body: { projectPath: snapshot.projectPath, selectedModel: hint.modelId, effort: 'default', requireExecutionProbe: false } }
    const selection = await inspectOpenCodeV2SourceAvailability(envelope, { signal: controller.signal, deadlineMs })
    controller.signal.throwIfAborted()
    const result = await resolveOpenCodeV2ExecutionProbe(envelope, selection, false, { signal: controller.signal })
    controller.signal.throwIfAborted()
    return result.state === 'available' && result.proof && result.proof.modelId === hint.modelId &&
      matchesSnapshot(result.proof, snapshot, Date.now()) ? result.proof : null
  } catch { return null } // Retain honest catalog-only status when proof validation cannot finish.
  finally { clearTimeout(timer) } // Await cooperative cancellation and owned version retirement; never abandon a child.
}
