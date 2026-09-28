import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import { HostedRootDaemonInactiveComposition } from './HostedRootDaemonInactiveComposition.js'

const FIXTURES = path.join(import.meta.dir, '../productAuthority/fixtures')
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const bootstrapSha256 = 'b'.repeat(64)
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp('/tmp/hosted-root-daemon-inactive-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const dir = (name: string) => path.join(directory, name)
  const [manager, network, effects, profile, configParent] =
    ['manager', 'network', 'effects', 'profile', 'config'].map(dir)
  for (const entry of [manager, network, effects, profile, configParent]) {
    await mkdir(entry, { mode: 0o700 })
    await chmod(entry, 0o700)
  }
  const databasePath = dir('product.sqlite')
  await writeFile(databasePath, gunzipSync(await readFile(path.join(FIXTURES,
    'product-v35-current-member.sqlite.gz'))), { mode: 0o600 })
  const metadata = JSON.parse(await readFile(path.join(FIXTURES,
    'product-v35-current-member.metadata.json'), 'utf8')) as {
      now: number; runId: string; memberId: string; binding: {
        deploymentId: string; bootId: string; ownerAuthority: string;
        ownerGeneration: number; ownerSessionId: string }
    }
  const db = new Database(databasePath, { create: false, readwrite: true })
  const reservation = JSON.parse((db.query('SELECT record_json FROM hosted_lifecycle_run_reservations WHERE run_id = ?')
    .get(metadata.runId) as { record_json: string }).record_json) as {
      teamId: string; planSha256: string; promotionOperationId: string }
  const promotion = JSON.parse((db.query('SELECT record_json FROM hosted_team_configuration_promotions WHERE operation_id = ?')
    .get(reservation.promotionOperationId) as { record_json: string }).record_json) as {
      admittedWorkspaceRoot: string }
  const operationId = hostedMemberStartOperationId(metadata.runId, metadata.memberId,
    reservation.planSha256)
  const serverPasswordKeyPath = dir('server-password-key')
  const rpcSecretPath = dir('rpc-secret')
  await writeFile(serverPasswordKeyPath, '1'.repeat(64), { mode: 0o400 })
  await writeFile(rpcSecretPath, '2'.repeat(64), { mode: 0o400 })
  const workspaceParent = path.dirname(promotion.admittedWorkspaceRoot)
  const assemblyConfigPath = dir('assembly.json')
  const assemblyConfig = { schemaVersion: 1, productDatabasePath: databasePath,
    expectedProductUid: process.getuid!(), workspaceParent,
    sandboxWorkspaceRoot: promotion.admittedWorkspaceRoot, profileParent: profile,
    configParent, deploymentId: metadata.binding.deploymentId, bootId: metadata.binding.bootId,
    ownerAuthority: metadata.binding.ownerAuthority,
    ownerGeneration: metadata.binding.ownerGeneration,
    ownerSessionId: metadata.binding.ownerSessionId, runId: metadata.runId,
    memberIds: [metadata.memberId], managerStateDirectory: manager,
    networkStateDirectory: network, effectClaimDirectory: effects,
    dockerSocketPath: dir('nonexistent-docker.sock'), image,
    imageId: `sha256:${'c'.repeat(64)}`, bootstrapSha256, serverPasswordKeyPath }
  await writeFile(assemblyConfigPath, JSON.stringify(assemblyConfig), { mode: 0o400 })
  const daemonConfigPath = dir('daemon.json')
  const daemonConfig = { schemaVersion: 3, image, bootstrapSha256, workspaceParent,
    profileParent: profile, configParent, memberManagerStateDirectory: manager,
    memberNetworkStateDirectory: network, seccompPath: dir('seccomp.json'),
    seccompSha256: 'd'.repeat(64), apparmorProfile: 'hat-sandbox',
    handoffHelperPath: dir('handoff.py'), handoffHelperSha256: 'e'.repeat(64),
    handoffPythonSha256: 'f'.repeat(64), ownerSocketDirectory: dir('owner-sockets'),
    ownerUid: process.getuid!(), ownerGid: process.getgid!(),
    rpcSocketPath: dir('rpc.sock'), rpcSecretPath, serverPasswordKeyPath,
    inactiveAssemblyConfigPath: assemblyConfigPath }
  await writeFile(daemonConfigPath, JSON.stringify(daemonConfig), { mode: 0o400 })
  return { db, directory, daemonConfigPath, daemonConfig, assemblyConfigPath,
    assemblyConfig, metadata, operationId }
}

const load = (file: string, now: number) => HostedRootDaemonInactiveComposition.load(file,
  { testOnlyAllowNonRoot: true, now: () => now })

test('root daemon loads exact current member proof without Docker or an effect route', async () => {
  const f = await fixture()
  try {
    const composition = await load(f.daemonConfigPath, f.metadata.now)
    try {
      const expected = { memberId: f.metadata.memberId, operationId: f.operationId,
        effectEnabled: false as const }
      expect(await composition.prepare(f.metadata.memberId)).toEqual(expected)
      expect(await composition.observe(f.metadata.memberId)).toEqual(expected)
      expect(composition.config.image).toBe(image)
    } finally { composition.close() }
  } finally { f.db.close() }
})

test('missing assembly and mismatched pinned image deny before daemon can bind RPC', async () => {
  const f = await fixture()
  try {
    await rm(f.assemblyConfigPath)
    await expect(load(f.daemonConfigPath, f.metadata.now)).rejects.toThrow()
    await writeFile(f.assemblyConfigPath, JSON.stringify(f.assemblyConfig), { mode: 0o400 })
    const changed = { ...f.daemonConfig,
      image: `example.invalid/opencode@sha256:${'9'.repeat(64)}` }
    await chmod(f.daemonConfigPath, 0o600)
    await writeFile(f.daemonConfigPath, JSON.stringify(changed), { mode: 0o400 })
    await chmod(f.daemonConfigPath, 0o400)
    await expect(load(f.daemonConfigPath, f.metadata.now))
      .rejects.toThrow('runtime-pins-conflict')
  } finally { f.db.close() }
})

test('Product cleanup pending member denies daemon startup proof', async () => {
  const f = await fixture()
  try {
    f.db.query("UPDATE hosted_lifecycle_current_runs SET state = 'cleanup_pending' WHERE run_id = ?")
      .run(f.metadata.runId)
    await expect(load(f.daemonConfigPath, f.metadata.now)).rejects.toThrow()
  } finally { f.db.close() }
})
