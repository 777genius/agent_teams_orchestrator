import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { executionAssert, executionHash, executionRecord } from '../../../../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeV2ProbeIntent } from '../../../../services/opencode/bridge/OpenCodeV2ExecutionProbe.js'

type Native = { path: string; sha256: string; version: string }
export type OpenCodeV2ConnectIntent = {
  schemaVersion?: 2;
  state: 'pending'; providerId: string; project: string; profileRoot: string; integrationID: string;
  phase?: 'credential-intent' | 'credential-published' | 'verification-prepared' | 'probe-owned';
  credentialID?: string; mirrorIdentity?: string;
  verification?: { modelId: string; native: Native; sourceKey?: string; probe?: OpenCodeV2ProbeIntent };
}
const windows = process.platform === 'win32'
async function privatePath(file: string, kind: 'file' | 'directory') {
  const info = await lstat(file)
  executionAssert(!info.isSymbolicLink() && await realpath(file) === file &&
    (kind === 'file' ? info.isFile() && info.nlink === 1 && info.size < 64 * 1024 : info.isDirectory()) &&
    (windows || info.uid === process.getuid?.() && (info.mode & 0o077) === 0), 'provider_intent_foreign')
  return info
}
async function privateJSON(file: string): Promise<Record<string, unknown>> {
  const before = await privatePath(file, 'file')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    executionAssert(current.dev === before.dev && current.ino === before.ino && current.size < 64 * 1024, 'provider_intent_foreign')
    const bytes = await handle.readFile()
    executionAssert(bytes.length < 64 * 1024, 'provider_intent_foreign')
    return executionRecord(JSON.parse(bytes.toString('utf8')))
  } finally { await handle.close() }
}
async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

/** Only absence of the marker itself authorizes a new connection transaction. */
export async function readOpenCodeV2ConnectIntent(file: string): Promise<Record<string, unknown> | undefined> {
  await privatePath(path.dirname(file), 'directory')
  try { await lstat(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return privateJSON(file)
}

/** Keep the original marker and its identities; publication is one atomic replacement. */
export async function writeOpenCodeV2ConnectIntent(file: string, value: unknown, create = false): Promise<void> {
  await privatePath(path.dirname(file), 'directory')
  if (!create) await privatePath(file, 'file')
  const bytes = Buffer.from(JSON.stringify(value))
  executionAssert(bytes.length < 64 * 1024, 'provider_intent_foreign')
  const temporary = create ? file : path.join(path.dirname(file), `.intent-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  if (!create) await rename(temporary, file)
  if (!windows) {
    const parent = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await parent.sync() } finally { await parent.close() }
  }
}

/** A former catalog may be read again only after its original physical owner retired.
 * Durable released files were written by the branded retirement path; none are fabricated here. */
export async function readRetiredOpenCodeV2CatalogProfile(dataRoot: string, root: string, providerId: string,
  graphSha256: string): Promise<{ root: string; directory: string; databasePath: string; content: string }> {
  for (const ancestor of [dataRoot, path.join(dataRoot, 'opencode')]) {
    const info = await lstat(ancestor)
    executionAssert(info.isDirectory() && !info.isSymbolicLink() && await realpath(ancestor) === ancestor &&
      (windows || info.uid === process.getuid?.() && (info.mode & 0o022) === 0), 'provider_intent_foreign')
  }
  await privatePath(path.join(dataRoot, 'opencode/v2'), 'directory')
  const parent = path.join(dataRoot, 'opencode/v2/provider-profiles')
  executionAssert(path.dirname(root) === parent && /^catalog-[A-Za-z0-9]+$/.test(path.basename(root)), 'provider_original_profile_changed')
  await privatePath(parent, 'directory'); await privatePath(root, 'directory')
  const databasePath = path.join(root, 'data/opencode/opencode.db')
  executionAssert(await absent(path.join(root, '.opencode-v2-execution-owner')) &&
    await absent(path.join(path.dirname(databasePath), '.opencode.db.opencode-v2-execution-owner')), 'provider_original_owner_unknown')
  const releases = (await readdir(root)).filter(name => /^\.opencode-v2-execution-owner\.released\.[a-f0-9-]{36}$/.test(name))
  executionAssert(releases.length > 0 && releases.length <= 32, 'provider_original_owner_unknown')
  let retired = false
  for (const name of releases) {
    const directory = path.join(root, name); await privatePath(directory, 'directory')
    const owner = await privateJSON(path.join(directory, 'owner.json'))
    const release = await privateJSON(path.join(directory, 'release.json'))
    executionAssert(owner.profileRoot === root && owner.databasePath === databasePath &&
      owner.graphSha256 === graphSha256 && name.endsWith(String(owner.leaseOwnerId)), 'provider_original_owner_unknown')
    if (release.state !== 'retired') continue
    const child = await privateJSON(path.join(directory, 'child.json')), receipt = executionRecord(release.receipt)
    executionAssert(receipt.pid === child.pid && executionHash(receipt.birth) === executionHash(child.birth) &&
      receipt.scopeClosed === true && receipt.processRetired === true &&
      (receipt.descendantsRetired === true || windows), 'provider_original_owner_unknown')
    retired = true
  }
  executionAssert(retired, 'provider_original_owner_unknown')
  const directory = path.join(root, 'config/opencode')
  await privatePath(directory, 'directory')
  const configFile = path.join(directory, 'opencode.json'), config = await privateJSON(configFile)
  const providers = executionRecord(config.providers)
  executionAssert(Object.keys(providers).length === 1 && Object.hasOwn(providers, providerId) &&
    Array.isArray(config.plugins) && config.plugins.length === 0, 'provider_original_profile_changed')
  // Preserve exact config bytes rather than synthesizing a replacement profile.
  const handle = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { return { root, directory, databasePath, content: await handle.readFile('utf8') } }
  finally { await handle.close() }
}

/** No connect/remove port exists here. Resumption can only verify the original publication. */
export async function prepareOpenCodeV2ConnectVerification(input: {
  saved: Record<string, unknown>; providerId: string; project: string; integrationID: string;
  mirrorIdentity: string; native: Native; selectedModel: string;
  readOriginalCredential(): Promise<string>; proveLegacyPreEffect(): Promise<void>;
}): Promise<OpenCodeV2ConnectIntent> {
  const saved = input.saved
  executionAssert(saved.state === 'pending' && saved.providerId === input.providerId && saved.project === input.project &&
    saved.integrationID === input.integrationID && typeof saved.profileRoot === 'string', 'provider_original_intent_changed')
  executionAssert(saved.schemaVersion === undefined || saved.schemaVersion === 2, 'provider_original_intent_changed')
  if (saved.schemaVersion === undefined) executionAssert(Object.keys(saved).sort().join(',') ===
    ['state', 'providerId', 'project', 'profileRoot', 'integrationID'].sort().join(','), 'provider_original_execution_unknown')
  if (saved.mirrorIdentity !== undefined) executionAssert(saved.mirrorIdentity === input.mirrorIdentity, 'provider_auth_publication_changed')
  const credentialID = await input.readOriginalCredential()
  executionAssert(/^cred_[A-Za-z0-9]+$/.test(credentialID) &&
    (saved.credentialID === undefined || saved.credentialID === credentialID), 'provider_owned_connection_unknown')
  if (saved.verification !== undefined) {
    executionAssert(saved.schemaVersion === 2, 'provider_original_execution_unknown')
    const verification = executionRecord(saved.verification)
    executionAssert(typeof verification.modelId === 'string' && verification.modelId.startsWith(input.providerId + '/') &&
      executionHash(verification.native) === executionHash(input.native) &&
      (saved.phase === 'verification-prepared' || saved.phase === 'probe-owned'), 'provider_execution_target_changed')
    if (saved.phase === 'probe-owned') executionAssert(verification.probe && verification.sourceKey, 'provider_original_execution_unknown')
    return { ...saved, credentialID, mirrorIdentity: input.mirrorIdentity } as OpenCodeV2ConnectIntent
  }
  // Only the historical 0755-root failure is migrated. Other uncertain old effects stay fenced.
  if (saved.schemaVersion === 2) executionAssert(saved.phase === 'credential-intent' ||
    saved.phase === 'credential-published', 'provider_original_execution_unknown')
  else await input.proveLegacyPreEffect()
  executionAssert(input.selectedModel.startsWith(input.providerId + '/'), 'provider_execution_target_changed')
  return { schemaVersion: 2, state: 'pending', providerId: input.providerId, project: input.project, profileRoot: String(saved.profileRoot),
    integrationID: input.integrationID, credentialID, mirrorIdentity: input.mirrorIdentity,
    phase: 'verification-prepared', verification: { modelId: input.selectedModel, native: { ...input.native } } }
}
