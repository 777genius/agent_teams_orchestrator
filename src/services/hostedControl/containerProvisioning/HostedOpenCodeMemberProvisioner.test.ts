import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { HostedOpenCodeMemberProvisioner, type HostedMemberProvisionRequest } from './HostedOpenCodeMemberProvisioner.js'

const request: HostedMemberProvisionRequest = {
  operationId: 'provision_12345678', planTeamId: 'plan_12345678', planFingerprint: 'a'.repeat(64),
  runId: 'run_12345678', teamId: 'team_12345678', laneId: 'lane_12345678', memberId: 'member_12345678',
}
const configBytes = Buffer.from('{"provider":{}}\n')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
const previousNodeEnv = process.env.NODE_ENV
process.env.NODE_ENV = 'test'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    for (const name of await readdir(path.join(root, 'profile')).catch(() => [])) {
      const profile = path.join(root, 'profile', name)
      await chmod(profile, 0o700)
      await chmod(path.join(profile, 'config'), 0o700)
    }
    for (const name of await readdir(path.join(root, 'config')).catch(() => [])) {
      await chmod(path.join(root, 'config', name), 0o700)
    }
    await rm(root, { recursive: true, force: true })
  }))
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
})

async function fixture() {
  process.env.NODE_ENV = 'test'
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hosted-provision-test-')))
  roots.push(root)
  const [workspaceParent, profileParent, configParent, stateDirectory] =
    ['workspace', 'profile', 'config', 'state'].map(name => path.join(root, name))
  for (const directory of [workspaceParent, profileParent, configParent, stateDirectory]) {
    await mkdir(directory, { mode: 0o700 })
  }
  const configTemplatePath = path.join(root, 'template.json')
  await writeFile(configTemplatePath, configBytes, { mode: 0o400 })
  const leaseCalls: unknown[] = []
  let admitted = true
  const options = {
    workspaceParent, profileParent, configParent, stateDirectory, configTemplatePath,
    configTemplateSha256: sha(configBytes), testOnlyAllowNonRoot: true,
    admitMember: async (value: HostedMemberProvisionRequest) => admitted &&
      value.planFingerprint === request.planFingerprint && value.memberId === request.memberId,
    supervisor: { issueLease: async (input: unknown) => { leaseCalls.push(input); return 'lease_12345678' } },
  }
  return { options, root, leaseCalls, setAdmitted: (value: boolean) => { admitted = value } }
}

describe('root-owned hosted member provisioning', () => {
  test('admits one exact member into fresh pinned layout and returns only opaque lease', async () => {
    const f = await fixture()
    const provisioner = await HostedOpenCodeMemberProvisioner.create(f.options)
    const oldUmask = process.umask(0o077)
    try { expect(await provisioner.issueLease(request)).toBe('lease_12345678') }
    finally { process.umask(oldUmask) }
    expect(f.leaseCalls).toHaveLength(1)
    const lease = f.leaseCalls[0] as Record<string, string>
    expect(path.dirname(lease.workspace)).toBe(f.options.workspaceParent)
    expect(path.dirname(lease.profile)).toBe(f.options.profileParent)
    expect(path.dirname(lease.config)).toBe(f.options.configParent)
    expect(await readdir(lease.workspace)).toEqual([])
    expect((await lstat(lease.workspace)).mode & 0o777).toBe(0o700)
    expect((await lstat(lease.profile)).mode & 0o777).toBe(0o555)
    expect((await readdir(lease.profile)).sort()).toEqual(['cache', 'config', 'data', 'home', 'state', 'tmp'])
    for (const name of ['data', 'cache', 'state', 'tmp']) {
      expect((await lstat(path.join(lease.profile, name))).mode & 0o777).toBe(0o700)
    }
    expect((await lstat(lease.config)).mode & 0o777).toBe(0o555)
    expect((await lstat(path.join(lease.config, 'opencode.json'))).mode & 0o777).toBe(0o444)
    expect(await readFile(path.join(lease.config, 'opencode.json'))).toEqual(configBytes)
    expect(lease.configSha256).toBe(sha(configBytes))
    expect(await provisioner.readClaim(request.operationId)).toEqual({
      requestSha256: sha(Buffer.from(JSON.stringify(request))),
      workspace: lease.workspace, profile: lease.profile, config: lease.config,
    })
  })

  test('denied member creates no claim or directories', async () => {
    const f = await fixture()
    f.setAdmitted(false)
    const provisioner = await HostedOpenCodeMemberProvisioner.create(f.options)
    await expect(provisioner.issueLease(request)).rejects.toThrow('hosted-provision-member-not-admitted')
    expect(await provisioner.readClaim(request.operationId)).toBeNull()
    expect(await readdir(f.options.workspaceParent)).toEqual([])
    expect(f.leaseCalls).toHaveLength(0)
  })

  test('durable claim blocks duplicate and uncertain lease outcome after restart', async () => {
    const f = await fixture()
    f.options.supervisor.issueLease = async (input: unknown) => {
      f.leaseCalls.push(input)
      throw new Error('reply lost')
    }
    const first = await HostedOpenCodeMemberProvisioner.create(f.options)
    await expect(first.issueLease(request)).rejects.toThrow('reply lost')
    const second = await HostedOpenCodeMemberProvisioner.create(f.options)
    await expect(second.issueLease(request)).rejects.toThrow('hosted-provision-operation-already-claimed')
    expect(f.leaseCalls).toHaveLength(1)
    expect(await readdir(f.options.workspaceParent)).toHaveLength(1)
  })

  test('rejects substituted template before claim', async () => {
    const f = await fixture()
    const provisioner = await HostedOpenCodeMemberProvisioner.create(f.options)
    await chmod(f.options.configTemplatePath, 0o600)
    await expect(provisioner.issueLease(request)).rejects.toThrow('hosted-provision-template-invalid')
    expect(await provisioner.readClaim(request.operationId)).toBeNull()
    expect(f.leaseCalls).toHaveLength(0)
  })
})
