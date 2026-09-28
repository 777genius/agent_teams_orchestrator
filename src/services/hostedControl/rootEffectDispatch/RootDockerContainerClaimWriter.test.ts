import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'bun:test'

import { hostedMemberStartOperationId } from '../../teamLifecycleOwner/HostedMemberStartOperationId.js'
import type { HostedProductCurrentMember, HostedProductMemberBinding } from
  '../productAuthority/HostedProductCurrentMemberDecision.js'
import { HostedRootSingleMemberAuthority } from './HostedRootSingleMemberAuthority.js'
import { RootDockerContainerClaimWriter } from './RootDockerContainerClaimWriter.js'

const binding: HostedProductMemberBinding = {
  runId: `run_${'1'.repeat(32)}`, memberId: `member_${'2'.repeat(32)}`,
  teamId: `team_${'3'.repeat(32)}`, laneId: `lane_${'4'.repeat(32)}`,
  deploymentId: 'deployment_fixture1234', runtimeWorkspaceId: `workspace_${'5'.repeat(32)}`,
  planSha256: '6'.repeat(64), rosterBindingSha256: '7'.repeat(64),
  restoreGeneration: 1, mountGeneration: 1,
}
const image = `example.invalid/opencode@sha256:${'a'.repeat(64)}`
const target = { memberOperationId: hostedMemberStartOperationId(binding.runId,
  binding.memberId, binding.planSha256), handle: `opencode_${'b'.repeat(32)}`,
  generation: 'c'.repeat(32), networkId: 'd'.repeat(64) }
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'root-container-writer-')))
  directories.push(directory)
  const [stateDirectory, workspaceParent, profileParent, configParent] =
    ['state', 'workspace', 'profile', 'config'].map(name => path.join(directory, name))
  for (const entry of [stateDirectory, workspaceParent, profileParent, configParent]) {
    await mkdir(entry, { mode: 0o700 })
    await chmod(entry, 0o700)
  }
  let admitted = true
  let blocked = false
  let entered: (() => void) | null = null
  let release: (() => void) | null = null
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const product = { async withCurrentMemberDecision<T>(_binding: HostedProductMemberBinding,
    _kind: 'prepare' | 'start' | 'observe' | 'stop', callback: (row: HostedProductCurrentMember) => T): Promise<T> {
    if (blocked) { entered!(); await gate }
    if (!admitted) throw new Error('product-revoked')
    return callback({ ...binding, admittedWorkspaceRoot: '/sandbox/member-fixture',
      bootId: 'boot_fixture1234' } as HostedProductCurrentMember)
  } }
  const authority = new HostedRootSingleMemberAuthority(product, { binding,
    workspaceParent: '/sandbox', sandboxWorkspaceRoot: '/sandbox/member-fixture',
    bootId: 'boot_fixture1234', ownerGeneration: 1,
    ownerSessionId: 'owner-session_fixture1234' }, row => ({ runId: row.runId,
    bootId: row.bootId, ownerGeneration: 1, ownerSessionId: 'owner-session_fixture1234', state: 'active' }))
  const writer = RootDockerContainerClaimWriter.create({ stateDirectory, authority,
    binding, image, networkId: target.networkId, workspaceParent, profileParent, configParent,
    testOnlyAllowNonRoot: true })
  const input = { target: { ...target }, workspace: path.join(workspaceParent, '1'.repeat(32)),
    profile: path.join(profileParent, '2'.repeat(32)),
    config: path.join(configParent, '3'.repeat(32)),
    seccomp: { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }, apparmorProfile: 'hosted-test' }
  return { writer, input, directory, stateDirectory, revoke: () => { admitted = false },
    block: () => { blocked = true }, waiting, release: () => release!() }
}

test('root writer publishes immutable secret-free create and exact target claims', async () => {
  const f = await fixture()
  await f.writer.writeCreate(f.input)
  const file = path.join(f.stateDirectory, `container-create-${target.memberOperationId}.json`)
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  expect(manifest).toMatchObject(target)
  expect(manifest.body).toContain('OPENCODE_SERVER_PASSWORD')
  expect(manifest.body).not.toContain('OPENCODE_SERVER_PASSWORD=')
  const labels = JSON.parse(manifest.body as string).Labels as Record<string, string>
  expect(labels['org.agentteams.hosted-opencode.member-operation-id']).toBe(target.memberOperationId)
  expect(labels['org.agentteams.hosted-opencode.run-id']).toBe(binding.runId)
  expect(labels['org.agentteams.hosted-opencode.member-id']).toBe(binding.memberId)
  expect(labels['org.agentteams.hosted-opencode.runtime-workspace-id']).toBe(binding.runtimeWorkspaceId)
  await expect(f.writer.writeCreate(f.input)).rejects.toThrow('EEXIST')
  f.revoke()
  f.writer.writeTarget({ ...target, containerId: 'e'.repeat(64) })
  const stored = JSON.parse(await readFile(path.join(f.stateDirectory,
    `container-target-${target.memberOperationId}.json`), 'utf8')) as Record<string, unknown>
  expect(stored).toEqual({ ...target, containerId: 'e'.repeat(64) })
  expect(() => f.writer.writeTarget({ ...target, containerId: 'e'.repeat(64) })).toThrow('EEXIST')
})

test('revoked Product and conflicting target cannot create a root claim', async () => {
  const f = await fixture()
  f.revoke()
  await expect(f.writer.writeCreate(f.input)).rejects.toThrow('product-revoked')
  expect(await readdir(f.stateDirectory)).toEqual([])
  await expect(f.writer.writeCreate({ ...f.input, target: { ...target,
    networkId: 'f'.repeat(64) } })).rejects.toThrow('create-invalid')
  expect(await readdir(f.stateDirectory)).toEqual([])
})

test('mutating caller target during Product wait cannot change durable claim identity', async () => {
  const f = await fixture()
  f.block()
  const pending = f.writer.writeCreate(f.input)
  await f.waiting
  f.input.target.memberOperationId = `start_${'f'.repeat(64)}`
  f.input.target.handle = `opencode_${'f'.repeat(32)}`
  f.input.target.generation = 'f'.repeat(32)
  f.release()
  await pending
  const names = await readdir(f.stateDirectory)
  expect(names).toEqual([`container-create-${target.memberOperationId}.json`])
  const manifest = JSON.parse(await readFile(path.join(f.stateDirectory, names[0]), 'utf8')) as Record<string, unknown>
  expect(manifest).toMatchObject(target)
  const body = JSON.parse(manifest.body as string) as Record<string, unknown>
  expect((body.Labels as Record<string, unknown>)['org.agentteams.hosted-opencode.generation'])
    .toBe(target.generation)
})

test('writable ancestor substitution is denied before a durable claim', async () => {
  const f = await fixture()
  await chmod(f.directory, 0o777)
  try {
    await expect(f.writer.writeCreate(f.input)).rejects.toThrow('ancestor-untrusted')
    expect(await readdir(f.stateDirectory)).toEqual([])
  } finally { await chmod(f.directory, 0o700) }
})

test('replaced ancestor symlink cannot redirect a root claim', async () => {
  const f = await fixture()
  const moved = `${f.directory}-moved`
  await rename(f.directory, moved)
  await symlink(moved, f.directory)
  try {
    await expect(f.writer.writeCreate(f.input)).rejects.toThrow('ancestor-untrusted')
    expect(await readdir(path.join(moved, 'state'))).toEqual([])
  } finally {
    await rm(f.directory)
    await rename(moved, f.directory)
  }
})
