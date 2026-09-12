import { afterEach, describe, expect, test } from 'bun:test'
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanonicalTeamLockAuthority, RetainedHostCanonicalTeamLockRegistration } from 'src/utils/swarm/canonicalTeamLockAuthority.js'
import {
  admitHostedCanonicalAuthorityAtStartup,
  type HostedCanonicalAuthorityLaunch,
  type HostedCanonicalAuthorityProtectedRecord,
} from './hostedCanonicalAuthorityStartup.js'

const cleanup: string[] = []
const originalConfig = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function mountId(fd: number): number {
  const match = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
  if (!match) throw new Error('missing mount identity')
  return Number(match[1])
}

function identity(path: string, directory: boolean) {
  const fd = openSync(path, constants.O_RDONLY | (directory ? constants.O_DIRECTORY : 0))
  try {
    const value = fstatSync(fd)
    return { dev: value.dev, ino: value.ino, mountId: mountId(fd) }
  } finally { closeSync(fd) }
}

async function fixture(registrationId: string): Promise<{
  envelope: HostedCanonicalAuthorityLaunch
  recordPath: string
}> {
  const data = await mkdtemp(join(tmpdir(), 'hosted-authority-startup-'))
  cleanup.push(data)
  await chmod(data, 0o700)
  process.env.CLAUDE_CONFIG_DIR = data
  const legacyKey = 'exact-team'
  const teams = join(data, 'teams')
  const team = join(teams, legacyKey)
  const tasks = join(data, 'tasks', legacyKey)
  const cwd = join(data, 'cwd')
  const registry = join(data, 'registry')
  await Promise.all([team, tasks, cwd, registry].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const [dataStats, teamStats, taskStats] = await Promise.all([stat(data), stat(team), stat(tasks)])
  const anchorName = `${registrationId}.lock`
  const bindingRecordName = `${registrationId}.json`
  const anchor = join(registry, anchorName)
  const recordPath = join(registry, bindingRecordName)
  await writeFile(anchor, '', { mode: 0o444 })
  const envelope: HostedCanonicalAuthorityLaunch = {
    version: 1, role: 'native-lead',
    publicTeamId: 'public-team-1', legacyKey,
    canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks,
    canonicalCwd: cwd,
    dataRootIdentity: `${dataStats.dev}:${dataStats.ino}`,
    teamRootIdentity: `${teamStats.dev}:${teamStats.ino}`,
    tasksRootIdentity: `${taskStats.dev}:${taskStats.ino}`,
    runId: 'run-1',
    primary: { displayName: 'captain', agentId: 'captain@exact-team', provider: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    primaryAlias: 'team-lead', launchIdentityToken: 'launch-token-1',
    materialDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    settingsDigest: 'c'.repeat(64), mcpDigest: 'd'.repeat(64),
    settingsPath: join(data, 'settings.json'), mcpConfigPath: join(data, 'mcp.json'),
    bootstrapSpecPath: join(data, 'spec.json'),
    bootstrapSpecDigest: 'e'.repeat(64), userPromptDigest: 'f'.repeat(64),
    userPromptFilePath: join(data, 'prompt.txt'),
    permissionMode: 'bypassPermissions', envelopeDigest: '1'.repeat(64),
    readyAckPath: join(data, 'ready.json'),
    canonicalAuthority: {
      version: 1, registrationId, storageGeneration: 'storage-1',
      admittedWriterImage: `sha256:${'2'.repeat(64)}`, registryRoot: registry,
      anchorName, bindingRecordName,
    },
  }
  const record: HostedCanonicalAuthorityProtectedRecord = {
    protocolVersion: 1, registrationId, publicTeamId: envelope.publicTeamId,
    legacyKey, storageGeneration: envelope.canonicalAuthority.storageGeneration,
    admittedWriterImage: envelope.canonicalAuthority.admittedWriterImage,
    canonicalTeamRoot: team,
    root: identity(team, true), rootParent: identity(teams, true),
    anchor: identity(anchor, false), anchorParent: identity(registry, true),
    recordVersion: 1,
    registration: envelope.canonicalAuthority,
    launch: {
      version: envelope.version, role: envelope.role,
      publicTeamId: envelope.publicTeamId, legacyKey: envelope.legacyKey,
      canonicalDataRoot: data, canonicalTasksRoot: tasks, canonicalCwd: cwd,
      canonicalTeamRoot: team,
      dataRootIdentity: envelope.dataRootIdentity,
      teamRootIdentity: envelope.teamRootIdentity,
      tasksRootIdentity: envelope.tasksRootIdentity,
      runId: envelope.runId, primary: envelope.primary, primaryAlias: envelope.primaryAlias,
      launchIdentityToken: envelope.launchIdentityToken,
      materialDigest: envelope.materialDigest, profileDigest: envelope.profileDigest,
      settingsDigest: envelope.settingsDigest, mcpDigest: envelope.mcpDigest,
      settingsPath: envelope.settingsPath, mcpConfigPath: envelope.mcpConfigPath,
      bootstrapSpecPath: envelope.bootstrapSpecPath,
      bootstrapSpecDigest: envelope.bootstrapSpecDigest,
      userPromptFilePath: envelope.userPromptFilePath,
      userPromptDigest: envelope.userPromptDigest,
      permissionMode: envelope.permissionMode, readyAckPath: envelope.readyAckPath,
      envelopeDigest: envelope.envelopeDigest,
    },
  }
  await writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o444 })
  return { envelope, recordPath }
}

describe('hosted canonical authority startup admission', () => {
  test('opens and retains exact descriptors only after full protected launch binding matches', async () => {
    const { envelope } = await fixture('registration-success')
    let admitted: RetainedHostCanonicalTeamLockRegistration | undefined
    const authority = Object.freeze({}) as CanonicalTeamLockAuthority
    const result = await admitHostedCanonicalAuthorityAtStartup(envelope, {
      admit: async input => { admitted = input; return authority },
    })
    expect(result).toBe(authority)
    expect(admitted?.binding).toEqual({
      protocolVersion: 1,
      registrationId: 'registration-success',
      publicTeamId: envelope.publicTeamId,
      legacyKey: envelope.legacyKey,
      storageGeneration: envelope.canonicalAuthority.storageGeneration,
      admittedWriterImage: envelope.canonicalAuthority.admittedWriterImage,
      canonicalTeamRoot: envelope.canonicalTeamRoot,
    })
    for (const fd of [admitted!.rootFd, admitted!.rootParentFd, admitted!.anchorFd,
      admitted!.anchorParentFd, admitted!.bindingRecordFd]) {
      const flags = /^flags:\s+([0-7]+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
      expect(flags).not.toBeNull()
      expect(Number.parseInt(flags![1]!, 8) & 0o2000000).not.toBe(0)
    }
  })

  test('rejects a substituted launch token even when paths and authority names match', async () => {
    const { envelope } = await fixture('registration-substitution')
    let calls = 0
    await expect(admitHostedCanonicalAuthorityAtStartup({
      ...envelope,
      launchIdentityToken: 'substituted-token',
    }, {
      admit: async () => { calls++; return Object.freeze({}) as CanonicalTeamLockAuthority },
    })).rejects.toThrow('does not exactly bind')
    expect(calls).toBe(0)
  })

  test('fails closed when the protected binding record is malformed', async () => {
    const { envelope, recordPath } = await fixture('registration-malformed')
    await writeFile(recordPath, '{not-json', { mode: 0o444 })
    await expect(admitHostedCanonicalAuthorityAtStartup(envelope, {
      admit: async () => Object.freeze({}) as CanonicalTeamLockAuthority,
    })).rejects.toThrow('malformed')
  })

  test('rejects authority when conventional task derivation differs from the envelope', async () => {
    const { envelope } = await fixture('registration-layout')
    await expect(admitHostedCanonicalAuthorityAtStartup({
      ...envelope,
      canonicalTasksRoot: join(envelope.canonicalDataRoot, 'tasks', 'other-team'),
    }, {
      admit: async () => Object.freeze({}) as CanonicalTeamLockAuthority,
    })).rejects.toThrow('conventional team/tasks derivation')
  })
})
