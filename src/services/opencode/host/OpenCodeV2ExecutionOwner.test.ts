import { describe, expect, spyOn, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, link, lstat, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireExecutionProfileOwner, readExecutionProfileOwner } from './OpenCodeV2ExecutionOwner.js'
import { readExecutionBirth, type SelectedExecutionProfile } from './OpenCodeV2ExecutionBinding.js'
import { canonicalExecutionJSON, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import * as executionPlatform from './OpenCodeV2ExecutionPlatform.js'

const identity = () => ({ hostInstanceId: randomUUID(), leaseOwnerId: randomUUID(), graphSha256: 'a'.repeat(64) })
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-exclusive-owner-')))
  await mkdir(path.join(root, 'data'), { mode: 0o700 })
  const profile: SelectedExecutionProfile = { root, epoch: 'TEST-epoch', directory: root,
    databasePath: path.join(root, 'data', 'execution.sqlite'), env: {}, envSha256: executionHash({}),
    config: { directory: root, content: '{}', sha256: 'b'.repeat(64) },
    selection: { agent: 'build', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
  await writeFile(profile.databasePath, 'TEST-original-database')
  return { profile, remove: () => rm(root, { recursive: true, force: true }) }
}
function peer(root: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./OpenCodeV2ExecutionOwner.peer.ts', import.meta.url))],
    { cwd: root, env: { TMPDIR: root }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const rows: Record<string, unknown>[] = []
  let notify: (() => void) | undefined
  let ended = false
  child.on('message', message => { rows.push(executionRecord(message)); notify?.() })
  child.on('error', () => { ended = true; notify?.() })
  const exit = new Promise<void>(resolve => child.once('close', () => { ended = true; notify?.(); resolve() }))
  async function next(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 8000
    while (!rows.length) {
      if (ended) throw new Error('peer_exited')
      if (Date.now() >= deadline) throw new Error('peer_timeout')
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, deadline - Date.now())
        notify = () => { clearTimeout(timer); resolve() }
      })
      notify = undefined
    }
    return rows.shift()!
  }
  return { child, exit, next, async close() { if (child.connected) child.disconnect(); await exit } }
}

describe('canonical durable execution owner', () => {
  // Persistence seam only: the synthetic native port and mapping brand below
  // cannot qualify a native launch, ownership or physical retirement receipt.

  // The old host created independent nonces/fences for one profile. Two actual
  // processes now race at one barrier; only the winner crosses the mutation port.
  test('two processes share one owner; loser mutates zero; process exit never permits takeover', async () => {
    const { profile, remove } = await fixture()
    const peers = [peer(profile.root), peer(profile.root)]
    try {
      expect((await peers[0]!.next()).type).toBe('barrier')
      expect((await peers[1]!.next()).type).toBe('barrier')
      const ids = [identity(), identity()]
      peers.forEach((p, index) => p.child.send({ profile, identity: ids[index] }))
      const results = await Promise.all(peers.map(p => p.next()))
      expect(results.filter(row => row.type === 'owned')).toHaveLength(1)
      expect(results.filter(row => row.type === 'refused' && row.code === 'execution_profile_owned')).toHaveLength(1)
      const winner = results.findIndex(row => row.type === 'owned')
      expect(await readFile(path.join(profile.root, 'TEST-mutation-boundary.log'), 'utf8')).toBe(ids[winner]!.hostInstanceId + '\n')
      const retained = await readExecutionProfileOwner(profile.root)
      expect(retained.hostInstanceId).toBe(ids[winner]!.hostInstanceId)
      expect(retained.leaseOwnerId).toBe(ids[winner]!.leaseOwnerId)
      await peers[winner]!.close()
      await expect(acquireExecutionProfileOwner({ ...profile, epoch: 'TEST-new-epoch' }, identity())).rejects.toThrow('execution_profile_owned')
      expect(await readExecutionProfileOwner(profile.root)).toEqual(retained)
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-original-database')
    } finally { await Promise.all(peers.map(p => p.close())); await remove() }
  }, 20_000)

  // A spawn that dies before binding its child still owns both fences. Only the
  // launch-owned empty-scope retirement may free them; without that branded
  // claim the fence stays and blocks every later acquisition indefinitely.
  test('unbound spawn frees its fences only through a branded retirement of its process', async () => {
    const { profile, remove } = await fixture()
    const proof = Object.freeze({ pid: 4242, scopeClosed: true })
    const open = Object.freeze({ pid: 4242, scopeClosed: false })
    const brand = spyOn(executionPlatform, 'isExecutionUnboundRetirement').mockImplementation(
      (value: unknown): value is executionPlatform.ExecutionUnboundRetirement => value === proof || value === open)
    try {
      const owner = await acquireExecutionProfileOwner(profile, identity())
      await owner.beforeSpawn()
      await expect(owner.abandonBeforeSpawn()).rejects.toThrow('execution_owner_unknown')
      // Caller-supplied claims without the launch-owned brand never release.
      await expect(owner.abandonAfterUnboundSpawn({ pid: 4242, scopeClosed: true })).rejects.toThrow('execution_owner_unknown')
      // A branded retirement that could not close the scope keeps the fence.
      await expect(owner.abandonAfterUnboundSpawn(open)).rejects.toThrow('execution_owner_unknown')
      await owner.abandonAfterUnboundSpawn(proof)
      await expect(owner.abandonAfterUnboundSpawn(proof)).rejects.toThrow('execution_owner_released')
      const archive = path.join(profile.root, `.opencode-v2-execution-owner.released.${owner.record.leaseOwnerId}`, 'release.json')
      expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual({ state: 'spawn_unbound',
        hostInstanceId: owner.record.hostInstanceId, leaseOwnerId: owner.record.leaseOwnerId,
        retirement: { pid: 4242, processExited: true, scopeClosed: true } })
      // The freed fence admits the retry's fresh acquisition.
      const successor = await acquireExecutionProfileOwner(profile, identity())
      expect((await readExecutionProfileOwner(profile.root)).hostInstanceId).toBe(successor.record.hostInstanceId)
      await successor.abandonBeforeSpawn()
    } finally { brand.mockRestore(); await remove() }
  })

  test('future and partially committed ownership bytes veto acquisition without repair', async () => {
    const { profile, remove } = await fixture()
    try {
      const directory = path.join(profile.root, '.opencode-v2-execution-owner')
      await mkdir(directory, { mode: 0o700 })
      await expect(acquireExecutionProfileOwner(profile, identity())).rejects.toThrow('execution_profile_owned')
      const future = '{"schema":987,"foreign":"keep these exact bytes"}'
      await writeFile(path.join(directory, 'owner.json'), future)
      await expect(readExecutionProfileOwner(profile.root)).rejects.toThrow('execution_owner_unknown')
      await expect(acquireExecutionProfileOwner(profile, identity())).rejects.toThrow('execution_profile_owned')
      expect(await readFile(path.join(directory, 'owner.json'), 'utf8')).toBe(future)
    } finally { await remove() }
  })

  test('pre-spawn release retains original IDs and a late release cannot remove successor', async () => {
    const { profile, remove } = await fixture()
    try {
      const first = await acquireExecutionProfileOwner(profile, identity())
      await first.abandonBeforeSpawn()
      const second = await acquireExecutionProfileOwner(profile, identity())
      await expect(first.abandonBeforeSpawn()).rejects.toThrow('execution_owner_released')
      expect((await readExecutionProfileOwner(profile.root)).hostInstanceId).toBe(second.record.hostInstanceId)
      const archive = path.join(profile.root, `.opencode-v2-execution-owner.released.${first.record.leaseOwnerId}`, 'owner.json')
      expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(first.record)
      await second.beforeSpawn()
      await expect(second.abandonBeforeSpawn()).rejects.toThrow('execution_owner_unknown')
    } finally { await remove() }
  })

  test('database-first archive blocks cross-process reacquisition until profile-last publication', async () => {
    const { profile, remove } = await fixture()
    const contender = peer(profile.root)
    let resume: () => void = () => undefined, reached: () => void = () => undefined
    const barrier = new Promise<void>(resolve => { reached = resolve })
    const proceed = new Promise<void>(resolve => { resume = resolve })
    let renames = 0, release: Promise<void> | undefined
    try {
      expect((await contender.next()).type).toBe('barrier')
      const first = await acquireExecutionProfileOwner(profile, identity(), { rename: async (from, to) => {
        await rename(from, to)
        if (++renames === 1) { reached(); await proceed }
      } })
      release = first.abandonBeforeSpawn()
      await barrier
      contender.child.send({ profile, identity: identity() })
      // Old profile-first code publishes a new permanent partial profile owner,
      // then refuses with execution_database_owned. This assertion fails there.
      expect(await contender.next()).toMatchObject({ type: 'refused', code: 'execution_profile_owned' })
      expect(await readExecutionProfileOwner(profile.root)).toEqual(first.record)
      const aliasRoot = path.join(profile.root, 'TEST-alias')
      await symlink(profile.root, aliasRoot)
      contender.child.send({ profile: { ...profile, root: aliasRoot }, identity: identity() })
      expect(await contender.next()).toMatchObject({ type: 'refused', code: 'execution_identity_mismatch' })
      expect(await readExecutionProfileOwner(profile.root)).toEqual(first.record)
      resume(); await release
      const successor = await acquireExecutionProfileOwner(profile, identity())
      expect(await readExecutionProfileOwner(profile.root)).toEqual(successor.record)
      for (const directory of [path.join(profile.root, '.opencode-v2-execution-owner'),
        path.join(path.dirname(profile.databasePath), '.execution.sqlite.opencode-v2-execution-owner')]) {
        expect(JSON.parse(await readFile(`${directory}.released.${first.record.leaseOwnerId}/owner.json`, 'utf8'))).toEqual(first.record)
      }
      await successor.abandonBeforeSpawn()
    } finally { resume(); await release?.catch(() => undefined); await contender.close(); await remove() }
  }, 15_000)

  test('concurrent release and launch serialize without freeing a launchable fence', async () => {
    for (const releaseFirst of [true, false]) {
      const { profile, remove } = await fixture()
      try {
        const owner = await acquireExecutionProfileOwner(profile, identity())
        const operations = releaseFirst
          ? [owner.abandonBeforeSpawn(), owner.beforeSpawn()]
          : [owner.beforeSpawn(), owner.abandonBeforeSpawn()]
        const results = await Promise.allSettled(operations)
        expect(results[0]!.status).toBe('fulfilled')
        expect(results[1]!.status).toBe('rejected')
        if (releaseFirst) {
          const successor = await acquireExecutionProfileOwner(profile, identity())
          expect((await readExecutionProfileOwner(profile.root)).hostInstanceId).toBe(successor.record.hostInstanceId)
        } else {
          await expect(acquireExecutionProfileOwner(profile, identity())).rejects.toThrow('execution_profile_owned')
          expect((await readExecutionProfileOwner(profile.root)).hostInstanceId).toBe(owner.record.hostInstanceId)
        }
      } finally { await remove() }
    }
  })

  test('caller mutation cannot redirect acquisition or retirement from original authority', async () => {
    const original = await fixture(), alternate = await fixture()
    try {
      const selected = { ...original.profile }, ids = identity(), expectedIds = { ...ids }
      // Unsupported runtime identity fields must never overwrite durable authority.
      const suppliedIds = { ...ids, schema: 987, profileRoot: alternate.profile.root, databasePath: alternate.profile.databasePath }
      const pending = acquireExecutionProfileOwner(selected, suppliedIds)
      selected.root = alternate.profile.root
      selected.databasePath = alternate.profile.databasePath
      selected.epoch = 'TEST-mutated-epoch'
      Object.assign(suppliedIds, identity())
      const owner = await pending
      expect(owner.record).toMatchObject({ schema: 1, profileRoot: original.profile.root,
        databasePath: original.profile.databasePath, profileEpoch: original.profile.epoch, ...expectedIds })
      // Mutating after acquisition also must not change the retained archive path.
      suppliedIds.leaseOwnerId = randomUUID()
      await owner.abandonBeforeSpawn()
      const archive = path.join(original.profile.root, `.opencode-v2-execution-owner.released.${expectedIds.leaseOwnerId}`, 'owner.json')
      expect(JSON.parse(await readFile(archive, 'utf8'))).toEqual(owner.record)
      await expect(lstat(path.join(alternate.profile.root, '.opencode-v2-execution-owner'))).rejects.toMatchObject({ code: 'ENOENT' })
      const successor = await acquireExecutionProfileOwner(original.profile, identity())
      expect((await readExecutionProfileOwner(original.profile.root)).hostInstanceId).toBe(successor.record.hostInstanceId)
      expect(await readFile(original.profile.databasePath, 'utf8')).toBe('TEST-original-database')
      expect(await readFile(alternate.profile.databasePath, 'utf8')).toBe('TEST-original-database')
    } finally { await original.remove(); await alternate.remove() }
  })

  test('queued child binding captures birth before caller mutation', async () => {
    const { profile, remove } = await fixture()
    try {
      const owner = await acquireExecutionProfileOwner(profile, identity())
      await owner.beforeSpawn()
      const originalBirth = await readExecutionBirth(process.pid)
      if (!originalBirth) throw new Error('TEST-controller-birth-missing')
      const suppliedBirth = { ...originalBirth }
      const pending = owner.bindChild(process.pid, suppliedBirth)
      suppliedBirth.value = '0'
      suppliedBirth.bootId = randomUUID()
      await pending
      const row = JSON.parse(await readFile(path.join(profile.root, '.opencode-v2-execution-owner', 'child.json'), 'utf8'))
      expect(row).toEqual({ pid: process.pid, birth: originalBirth })
      await expect(owner.abandonBeforeSpawn()).rejects.toThrow('execution_owner_unknown')
      await expect(owner.abandonAfterUnboundSpawn({ scopeEmpty: true, heldProcessExited: true, scopeClosed: false })).rejects.toThrow('execution_owner_unknown')
    } finally { await remove() }
  })

  test('different nested canonical profiles cannot own the same canonical database', async () => {
    const { profile, remove } = await fixture()
    try {
      const first = await acquireExecutionProfileOwner(profile, identity())
      const nested = { ...profile, root: path.dirname(profile.databasePath), epoch: 'TEST-nested-profile' }
      await expect(acquireExecutionProfileOwner(nested, identity())).rejects.toThrow('execution_database_owned')
      expect((await readExecutionProfileOwner(profile.root)).hostInstanceId).toBe(first.record.hostInstanceId)
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-original-database')
    } finally { await remove() }
  })

  test('physical database hardlink aliases are refused', async () => {
    const { profile, remove } = await fixture()
    try {
      await link(profile.databasePath, path.join(profile.root, 'data', 'alias.sqlite'))
      await expect(acquireExecutionProfileOwner(profile, identity())).rejects.toThrow('execution_database_alias')
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-original-database')
    } finally { await remove() }
  })
})
