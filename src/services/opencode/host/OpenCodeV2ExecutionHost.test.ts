import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { acquireExecutionLease } from './OpenCodeV2ExecutionHost.js'
import { validateExecutionProfile, type ExecutionBirth, type SelectedExecutionProfile, type ValidatedExecutionNative } from './OpenCodeV2ExecutionBinding.js'
import { executionClosedAck, retireExecutionChild, type ExecutionRetirementPort } from './OpenCodeV2ExecutionLifecycle.js'

const birth: ExecutionBirth = { format: 'linux-start-ticks', value: '420', bootId: 'TEST-boot-domain' }
const context = { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'TEST-member', deadline: Number.MAX_SAFE_INTEGER }
const native: ValidatedExecutionNative = { generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21',
  runtimeMode: 'packaged', entrySha256: 'd'.repeat(64), executablePath: '/TEST-missing-selection', executableSha256: 'a'.repeat(64), packageName: '@opencode/cli-linux-x64',
  bun: { path: '/TEST-missing-bun', sha256: 'b'.repeat(64) }, graph: { sha256: 'c'.repeat(64), files: [] } }
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-execution-host-')))
  const env = Object.fromEntries(Object.entries({ HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' })
    .map(([key, relative]) => [key, path.join(root, relative)]))
  await Promise.all([...new Set(Object.values(env))].map(directory => mkdir(directory, { mode: 0o700 })))
  const databasePath = path.join(root, 'data', 'execution.sqlite')
  await writeFile(databasePath, 'TEST-retained-journal')
  const profile: SelectedExecutionProfile = { root, epoch: 'TEST-epoch', directory: root, databasePath, env, envSha256: executionHash(env),
    config: { directory: env.XDG_CONFIG_HOME!, content: '{}', sha256: createHash('sha256').update('{}').digest('hex') },
    selection: { agent: 'build', model: { providerID: 'TEST', id: 'model' }, permissions: [] } }
  return { profile, remove: () => rm(root, { recursive: true, force: true }) }
}
function retirement(overrides: Partial<ExecutionRetirementPort> = {}): ExecutionRetirementPort {
  return { pid: 73, birth, exited: () => true, acknowledged: () => true, disposeTransport: async () => undefined,
    sendClose: () => undefined, waitExit: Promise.resolve(), readBirth: async () => null, kill: () => undefined,
    retireOwnedDescendants: async () => undefined, ...overrides }
}

describe('execution host ownership and cleanup', () => {
  // A packaged source fallback would reach missing binaries or change caller data.
  test('packaged receipt cannot fall back to source execution before identity reads or data changes', async () => {
    const { profile, remove } = await fixture()
    try {
      await expect(acquireExecutionLease(native, profile, context)).rejects.toThrow('v2_execution_delivery_mismatch')
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-retained-journal')
    } finally { await remove() }
  })
  // Binding only the path would accept a mutated environment/config after owner validation.
  test('changed selected profile bytes are refused without altering the execution DB', async () => {
    const { profile, remove } = await fixture()
    try {
      await expect(validateExecutionProfile({ ...profile, env: { ...profile.env, HOME: '/foreign' } })).rejects.toThrow('execution_profile_changed')
      await expect(validateExecutionProfile({ ...profile, config: { ...profile.config, content: '{"foreign":true}' } })).rejects.toThrow('execution_profile_changed')
      expect(await readFile(profile.databasePath, 'utf8')).toBe('TEST-retained-journal')
    } finally { await remove() }
  })
  // PID-only ACK or scope-only completion could falsely retire a reused process.
  test('close acknowledgment requires nonce, pid, birth, boot domain and actual Scope close', () => {
    const row = { type: 'closed', nonce: 'lease', pid: 73, birth, scopeClosed: true }
    expect(executionClosedAck(row, 'lease', 73, birth)).toBe(true)
    for (const altered of [{ ...row, nonce: 'foreign' }, { ...row, pid: 74 }, { ...row, scopeClosed: false },
      { ...row, birth: { ...birth, bootId: 'other-boot' } }]) expect(executionClosedAck(altered, 'lease', 73, birth)).toBe(false)
  })
  // A failed wire dispose must still send Scope close and check process retirement.
  test('transport failure does not skip independent close or birth checks', async () => {
    const calls: string[] = []
    await expect(retireExecutionChild(retirement({ exited: () => false,
      disposeTransport: async () => { calls.push('wire'); throw new Error('wire') },
      sendClose: () => { calls.push('scope') }, readBirth: async () => { calls.push('birth'); return null } }))).rejects.toThrow('cleanup_unknown')
    expect(calls).toEqual(['wire', 'scope', 'birth'])
  })
  test('leader disappearance without Scope acknowledgment retains unknown cleanup', async () => {
    await expect(retireExecutionChild(retirement({ acknowledged: () => false }))).rejects.toThrow('cleanup_unknown')
    await expect(retireExecutionChild(retirement({ readBirth: async () => birth }))).rejects.toThrow('cleanup_unknown')
  })
  test('descendant retirement failure cannot become a successful lease close', async () => {
    await expect(retireExecutionChild(retirement({ retireOwnedDescendants: async () => { throw new Error('escaped') } }))).rejects.toThrow('cleanup_unknown')
  })
  // A caller can report every successful close field, but only a concrete
  // launch-owned kernel receipt may authorize freeing the durable profile/DB.
  test('caller supplied native retirement fields cannot mint a cleanup receipt', async () => {
    const bun = { hostPID: 73, nativePID: 1, birth, executablePath: '/TEST-bun', executableSha256: 'a'.repeat(64) }
    const mapping = { bun, init: bun, supervisor: bun, leaseOwnerId: 'TEST-lease',
      namespace: { name: 'pid:[73]', inode: '73', device: '1' } }
    const forged = { pid: 73, birth, scopeClosed: true, processRetired: true, descendantsRetired: true, mapping }
    await expect(retireExecutionChild(retirement({ retireOwnedDescendants: async () => forged }))).rejects.toThrow('cleanup_unknown')
  })
  // Even late Scope ACK + leader disappearance cannot certify unqualified descendants.
  test('late close acquisition is joined while unqualified cleanup remains unknown', async () => {
    let exited = false, ack = false, resolveExit: () => void = () => undefined
    const waitExit = new Promise<void>(resolve => { resolveExit = resolve })
    await expect(retireExecutionChild(retirement({ exited: () => exited, acknowledged: () => ack, waitExit,
      sendClose: () => { queueMicrotask(() => { ack = true; exited = true; resolveExit() }) } }))).rejects.toThrow('cleanup_unknown')
    expect(exited).toBe(true)
    expect(ack).toBe(true)
  })
})
