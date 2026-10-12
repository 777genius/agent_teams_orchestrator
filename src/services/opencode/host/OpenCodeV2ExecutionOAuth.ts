import path from 'node:path'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionGraph, OwnedNativeProfile } from './OpenCodeV2ExecutionBinding.js'

type SelectedCredential = Readonly<{ type: 'api'; key: string }> | Readonly<{
  type: 'oauth'; access: string; refresh: string; expires: number; accountId?: string; enterpriseUrl?: string
}>

/** Both the parent admission guard and sealed child consume the same bound file. */
export async function readOpenCodeV2SelectedAuth(profile: OwnedNativeProfile) {
  executionAssert(!('purpose' in profile.selection), 'execution_selected_auth_required')
  const providerId = profile.selection.model.providerID
  const file = path.join(profile.root, 'data/opencode/auth.json'), fingerprint = profile.authSha256
  executionAssert(typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint), 'execution_selected_auth_unbound')
  const check = async () => {
    const stat = await lstat(file)
    executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() &&
      (stat.mode & 0o077) === 0 && stat.size <= 128 * 1024 && await realpath(file) === file &&
      await hashOpenCodeFile(file) === fingerprint, 'execution_selected_auth_changed')
  }
  await check()
  const bytes = await readFile(file)
  executionAssert(createHash('sha256').update(bytes).digest('hex') === fingerprint, 'execution_selected_auth_changed')
  const store = executionRecord(JSON.parse(bytes.toString('utf8')))
  executionAssert(Object.keys(store).length === 1 && Object.hasOwn(store, providerId), 'execution_selected_auth_missing')
  const row = executionRecord(store[providerId])
  let credential: SelectedCredential
  if (row.type === 'api') {
    executionAssert(typeof row.key === 'string' && row.key.length > 0 &&
      Object.keys(row).every(key => key === 'type' || key === 'key'), 'execution_selected_auth_unsupported')
    credential = { type: 'api', key: row.key }
  } else {
    executionAssert(providerId === 'openai' && row.type === 'oauth' &&
      typeof row.access === 'string' && row.access.length > 0 && typeof row.refresh === 'string' && row.refresh.length > 0 &&
      typeof row.expires === 'number' && Number.isSafeInteger(row.expires) && row.expires >= 0 &&
      ['accountId', 'enterpriseUrl'].every(key => !Object.hasOwn(row, key) || typeof row[key] === 'string') &&
      Object.keys(row).every(key => ['type', 'access', 'refresh', 'expires', 'accountId', 'enterpriseUrl'].includes(key)),
    'execution_selected_auth_unsupported')
    credential = { type: 'oauth', access: row.access, refresh: row.refresh, expires: row.expires,
      ...(typeof row.accountId === 'string' ? { accountId: row.accountId } : {}),
      ...(typeof row.enterpriseUrl === 'string' ? { enterpriseUrl: row.enterpriseUrl } : {}) }
  }
  return { file, credential, check }
}

/** POSIX only: run the official migration before native plugins can cache or refresh OAuth.
 * Existing native values are never overwritten. Refreshed values need explicit recovery. */
export async function importOpenCodeV2SelectedOAuth(profile: OwnedNativeProfile, graph: ExecutionGraph,
  modulePath: string, effect: typeof import('effect'), signal?: AbortSignal): Promise<void> {
  if ('purpose' in profile.selection || profile.authSha256 === undefined) return
  const selected = await readOpenCodeV2SelectedAuth(profile)
  if (selected.credential.type === 'api') return
  executionAssert(process.platform !== 'win32', 'execution_selected_oauth_windows_unqualified')
  executionAssert(profile.databasePath.startsWith(profile.root + path.sep) &&
    await realpath(path.dirname(profile.databasePath)) === path.dirname(profile.databasePath), 'execution_profile_changed')
  const parent = await lstat(path.dirname(profile.databasePath))
  executionAssert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() &&
    (parent.mode & 0o077) === 0, 'execution_profile_changed')
  const database = await lstat(profile.databasePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  })
  executionAssert(!database || (database.isFile() && !database.isSymbolicLink() && database.nlink === 1 &&
    database.uid === process.getuid?.() &&
    await realpath(profile.databasePath) === profile.databasePath), 'execution_profile_changed')
  const locate = async (specifier: string) => {
    const file = await realpath(Bun.resolveSync(specifier, modulePath))
    const row = graph.files.find(value => value.path === file)
    executionAssert(row && await hashOpenCodeFile(file) === row.sha256, 'execution_graph_incomplete')
    signal?.throwIfAborted()
    return pathToFileURL(file).href
  }
  // Resolve each entry from the selected official server, including the floor's nested core.
  const { Database }: typeof import('@opencode/core/database/database') = await import(await locate('@opencode/core/database/database'))
  const { Credential }: typeof import('@opencode/core/credential') = await import(await locate('@opencode/core/credential'))
  const { Global }: typeof import('@opencode/util/global') = await import(await locate('@opencode/util/global'))
  const { LayerNode }: typeof import('@opencode/util/effect/layer-node') = await import(await locate('@opencode/util/effect/layer-node'))
  const { Integration }: typeof import('@opencode/schema/integration') = await import(await locate('@opencode/schema/integration'))
  const { importLegacyCredentials }: typeof import('@opencode/core/database/migration/20260805200742_import_legacy_credentials') =
    await import(await locate('@opencode/core/database/migration/20260805200742_import_legacy_credentials'))
  const legacy = selected.credential
  const expected = Credential.OAuth.make({ type: 'oauth', methodID: Integration.MethodID.make('chatgpt-browser'),
    access: legacy.access, refresh: legacy.refresh, expires: legacy.expires,
    metadata: legacy.accountId || legacy.enterpriseUrl ? {
      ...(legacy.accountId ? { accountID: legacy.accountId } : {}),
      ...(legacy.enterpriseUrl ? { enterpriseUrl: legacy.enterpriseUrl } : {}),
    } : undefined })
  // Schema optional fields may be materialized as undefined; compare their JSON values internally.
  const valueHash = (value: unknown) => executionHash(JSON.parse(JSON.stringify(value)))
  const expectedHash = valueHash(expected), data = path.dirname(profile.databasePath)
  const { Effect } = effect
  const layer = LayerNode.compile(LayerNode.group([Database.node, Credential.node]), { replacements: [
    Database.node.replace(Database.configured({ path: profile.databasePath })),
    Global.node.replace(Global.layerWith({ data, home: profile.env.HOME!, config: profile.config.directory,
      cache: profile.env.XDG_CACHE_HOME!, state: profile.env.XDG_STATE_HOME!, tmp: profile.env.TMPDIR!,
      bin: path.join(data, 'bin'), log: path.join(data, 'log'), repos: path.join(data, 'repos') })),
  ] })
  await selected.check()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { db } = yield* Database.Service
    const credentials = yield* Credential.Service
    const before = yield* credentials.all()
    if (before.length === 0) {
      executionAssert(database === null, 'execution_selected_oauth_recovery_required')
      yield* db.transaction(tx => importLegacyCredentials(tx, selected.file).pipe(
        Effect.tap(() => Effect.tryPromise(() => selected.check())),
      ))
    }
    const after = yield* credentials.all()
    executionAssert(after.length === 1 && after[0]!.integrationID === 'openai' && after[0]!.value.type === 'oauth' &&
      after[0]!.value.methodID === 'chatgpt-browser' && valueHash(after[0]!.value) === expectedHash,
    'execution_selected_oauth_recovery_required')
  }).pipe(Effect.provide(layer))), { signal })
  await selected.check()
}
