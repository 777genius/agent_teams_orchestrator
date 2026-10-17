import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Database as SQLite } from 'bun:sqlite'
import { attachOpenCodeV2SelectedKey, initializeOpenCodeV2ExecutionAuth } from './OpenCodeV2ExecutionAuth.js'
import type { ExecutionAuthority, ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { SelectedExecutionProfile } from './OpenCodeV2ExecutionBinding.js'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(credential: unknown = { type: 'api', key: 'TEST-DUMMY-KEY' }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-auth-')))
  const data = path.join(root, 'data/opencode'); await mkdir(data, { recursive: true, mode: 0o700 })
  const content = JSON.stringify(credential === null ? {} : { groq: credential })
  const auth = path.join(data, 'auth.json'); await writeFile(auth, content, { mode: 0o600 })
  const profile: SelectedExecutionProfile = { root, epoch: 'TEST', directory: root, databasePath: path.join(data, 'opencode.db'),
    authSha256: digest(content), env: {}, envSha256: digest('{}'), config: { directory: root, content: '{}', sha256: digest('{}') },
    selection: { agent: 'build', model: { providerID: 'groq', id: 'TEST-model' }, permissions: [] } }
  return { profile, auth, content, remove: () => rm(root, { recursive: true, force: true }) }
}
// Windows admission requires the native SHA-only auth metadata. This TEST
// reader observes the same bound file, so every file and API check still runs.
const selectedAuth = (file: string) => process.platform !== 'win32' ? undefined : {
  deadline: Date.now() + 15_000,
  metadata: { read: async () => { const bytes = await readFile(file); return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } } },
}

test('execution auth module loads without importing either official client before selection', async () => {
  const f = await fixture()
  try {
    const source = new URL('./OpenCodeV2ExecutionAuth.ts', import.meta.url).href
    const script = `Bun.plugin({name:'TEST-client-selection',setup(build){
      build.onResolve({filter:/^@opencode\\/client(?:-v2-floor)?$/},()=>{throw Error('TEST_client_import_before_selection')})
      build.onLoad({filter:/[/\\\\]@opencode[/\\\\]client(?:-v2-floor)?[/\\\\]/},()=>{throw Error('TEST_client_import_before_selection')})
    }});try{const value=await import(${JSON.stringify(source)});
    if(typeof value.initializeOpenCodeV2ExecutionAuth!=='function'||typeof value.attachOpenCodeV2SelectedKey!=='function')throw Error('TEST_auth_exports_missing');
    await Bun.stdout.write('TEST-auth-module-selected-lazy');
    }catch(error){if(error instanceof Error&&error.message==='TEST_client_import_before_selection')process.exitCode=91;else throw error}`
    const env = Object.fromEntries(Object.entries({ HOME: f.profile.root, USERPROFILE: f.profile.root,
      TMPDIR: f.profile.root, TMP: f.profile.root, TEMP: f.profile.root,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }).filter((row): row is [string, string] => row[1] !== undefined))
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', script],
      { cwd: f.profile.root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code).toBe(0)
    expect(stdout).toBe('TEST-auth-module-selected-lazy')
  } finally { await f.remove() }
})

test('fresh official database skips legacy key import; native key attachment makes the selected credential available', async () => {
  const f = await fixture()
  let db: SQLite | undefined
  try {
    const server = Bun.resolveSync('@opencode/server-v2-floor/process', import.meta.dir)
    const core = Bun.resolveSync('@opencode/core/database/database', server)
    const { Database }: typeof import('@opencode/core/database/database') = await import(pathToFileURL(core).href)
    const { Global }: typeof import('@opencode/util/global') = await import(pathToFileURL(Bun.resolveSync('@opencode/util/global', core)).href)
    const { Effect }: typeof import('effect') = await import(pathToFileURL(Bun.resolveSync('effect', core)).href)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () { yield* Database.Service }).pipe(
      Effect.provide(Database.layer({ path: f.profile.databasePath })),
      Effect.provide(Global.layerWith({ data: path.dirname(f.auth), cache: f.profile.root, config: f.profile.root,
        state: f.profile.root, tmp: f.profile.root, bin: f.profile.root, log: f.profile.root, repos: f.profile.root })),
    )))
    db = new SQLite(f.profile.databasePath)
    const connections = () => (db!.query('select id from credential').all() as { id: string }[]).map(row => ({ type: 'credential', id: row.id }))
    expect(connections()).toEqual([])
    expect(db.query("select id from migration where id='20260805200742_import_legacy_credentials'").get()).not.toBeNull()
    let posts = 0
    let providerGets = 0
    const location = { directory: f.profile.directory }
    const selectedProvider = { id: 'groq', activation: 'auto' }
    const visible = { providers: async () => ({ location, data: [] }) }
    const exact = {
      ...visible,
      provider: async () => { providerGets++; return { location, data: selectedProvider } },
    }
    const strict = {
      integration: async (id: string) =>
        ({ location, data: { id, methods: [{ type: 'key' }], connections: connections() } }),
      connect: async () => { posts++ },
    }
    for (const [changed, code] of [
      ...['disabled', undefined, 'unexpected'].map(activation => [
        { ...exact, ...strict, provider: async () => ({ location, data: { ...selectedProvider, integrationID: 'groq', activation } }) },
        'execution_selected_auth_provider_unknown',
      ] as const),
      ...[null, '', 42].map(integrationID => [
        { ...exact, ...strict, provider: async () => ({ location, data: { ...selectedProvider, integrationID } }) },
        'execution_selected_auth_provider_unknown',
      ] as const),
      [{ ...exact, ...strict, provider: async () => ({ location, data: { ...selectedProvider, id: 'other' } }) },
        'execution_selected_auth_provider_unknown'],
      [{ ...exact, ...strict, provider: async () => ({ location, data: undefined }) },
        'execution_selected_auth_provider_unknown'],
      [{ ...exact, ...strict,
        provider: async () => ({ location: { directory: f.profile.directory + '-other' }, data: selectedProvider }) },
        'execution_selected_auth_location_changed'],
      [{ ...exact, ...strict, providers: async () => ({ location, data: [selectedProvider, selectedProvider] }) },
        'execution_selected_auth_provider_unknown'],
      [{ ...exact, ...strict, integration: async () =>
        ({ location, data: { id: 'groq', methods: [{ type: 'oauth' }], connections: [] } }) },
        'execution_selected_auth_existing_or_unsupported'],
    ] as const) {
      await expect(attachOpenCodeV2SelectedKey(f.profile, changed, selectedAuth(f.auth))).rejects.toThrow(code)
    }
    expect(posts).toBe(0); expect(connections()).toEqual([]); expect(providerGets).toBe(1)
    await attachOpenCodeV2SelectedKey(f.profile, {
      ...exact,
      integration: async id => ({ location: { directory: f.profile.directory }, data: { id, methods: [{ type: 'key' }], connections: connections() } }),
      connect: async (id, key) => {
        expect(id).toBe('groq'); expect(key).toBe('TEST-DUMMY-KEY'); posts++
        db!.query('insert into credential(id,integration_id,label,value,time_created,time_updated) values(?,?,?,?,?,?)')
          .run('cred_TESToriginal', id, 'API key', JSON.stringify({ type: 'key', key }), 1, 1)
      },
    }, selectedAuth(f.auth))
    expect(posts).toBe(1); expect(connections()).toEqual([{ type: 'credential', id: 'cred_TESToriginal' }])
    expect(providerGets).toBe(2)
    expect(await readFile(f.auth, 'utf8')).toBe(f.content)
    // Existing native connection never permits another POST or replacement.
    await expect(attachOpenCodeV2SelectedKey(f.profile, {
      ...exact,
      integration: async id => ({ location: { directory: f.profile.directory }, data: { id, methods: [{ type: 'key' }], connections: connections() } }),
      connect: async () => { posts++; },
    }, selectedAuth(f.auth))).rejects.toThrow('execution_selected_auth_existing_or_unsupported')
    expect(posts).toBe(1)
  } finally { db?.close(); await f.remove() }
}, 20_000)

test('changed, absent and unsupported selected auth never reach native mutation', async () => {
  for (const mode of ['changed', 'absent', 'oauth'] as const) {
    const f = await fixture(mode === 'absent' ? null : mode === 'oauth' ? { type: 'oauth', access: 'TEST-only' } : undefined)
    let calls = 0
    try {
      if (mode === 'changed') await writeFile(f.auth, '{}')
      const port = { providers: async () => { calls++; return {} }, integration: async () => { calls++; return {} }, connect: async () => { calls++; } }
      if (process.platform === 'win32') await expect(attachOpenCodeV2SelectedKey(f.profile, port))
        .rejects.toThrow('execution_selected_auth_metadata_required')
      await expect(attachOpenCodeV2SelectedKey(f.profile, port, selectedAuth(f.auth))).rejects.toThrow('execution_selected_auth_' +
        (mode === 'changed' ? 'changed' : mode === 'absent' ? 'missing' : 'unsupported'))
      expect(calls).toBe(0)
    } finally { await f.remove() }
  }
})

test('execution auth rejects a different profile before endpoint or native API access', async () => {
  const f = await fixture()
  try {
    const authority = { profileRoot: f.profile.root + '-other', profileEpoch: f.profile.epoch, directory: f.profile.directory } as ExecutionAuthority
    await expect(initializeOpenCodeV2ExecutionAuth(authority, f.profile, {} as ExecutionContext)).rejects.toThrow('execution_selected_auth_profile_changed')
  } finally { await f.remove() }
})


test('anonymous native readback admits only the exact enabled free selected model without credential mutation', async () => {
  const f = await fixture()
  const profile: SelectedExecutionProfile = { ...f.profile, authSha256: undefined }
  let posts = 0
  const location = { directory: profile.directory }
  const provider = { id: 'groq', integrationID: 'TEST-integration', activation: 'enabled', settings: { apiKey: 'public' } }
  const model = { id: 'TEST-model', providerID: 'groq', enabled: true, status: 'active', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }
  const port = {
    providers: async () => ({ location, data: [provider] }),
    integration: async () => ({ location, data: { id: 'TEST-integration', connections: [] } }),
    models: async () => ({ location, data: [model] }),
    connect: async () => { posts++ },
  }
  try {
    // The anonymous branch must not depend on an auth file or a provider-name allowlist.
    await rm(f.auth)
    await attachOpenCodeV2SelectedKey(profile, port)
    for (const changed of [
      { ...port, providers: async () => ({ location, data: [{ ...provider, activation: 'auto' }] }) },
      { ...port, providers: async () => ({ location, data: [{ ...provider, settings: {} }] }) },
      { ...port, integration: async () => ({ location, data: { id: 'TEST-integration', connections: [{ type: 'credential', id: 'cred_TEST' }] } }) },
      { ...port, models: async () => ({ location, data: [{ ...model, enabled: false }] }) },
      { ...port, models: async () => ({ location, data: [{ ...model, id: 'other' }] }) },
      { ...port, models: async () => ({ location, data: [{ ...model, cost: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }] }] }) },
      { ...port, models: async () => ({ location, data: [model, model] }) },
      { ...port, models: async () => ({ location: { directory: profile.directory + '-other' }, data: [model] }) },
    ]) await expect(attachOpenCodeV2SelectedKey(profile, changed)).rejects.toThrow('execution_selected_auth_')
    expect(posts).toBe(0)
  } finally { await f.remove() }
})
