import { createHash } from 'node:crypto'
import {
  chmodSync,
  fchmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  computeHostedNativeEnvelopeDigest,
  type HostedNativeLaunchEnvelope,
} from '../../src/services/teamBootstrap/hostedNativeLaunch.js'
import { issueHostedCanonicalAuthority } from './issue-canonical-authority.js'

const cleanup: string[] = []
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture(): HostedNativeLaunchEnvelope {
  const data = mkdtempSync(join(tmpdir(), 'hosted-issuer-'))
  cleanup.push(data)
  chmodSync(data, 0o700)
  const legacyKey = 'exact-team'
  const teams = join(data, 'teams')
  const team = join(teams, legacyKey)
  const tasks = join(data, 'tasks', legacyKey)
  const cwd = join(data, 'cwd')
  const registry = join(data, 'registry')
  for (const path of [teams, team, tasks, cwd, registry]) mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const path of [teams, team, tasks, registry]) chmodSync(path, 0o700)
  const settingsPath = join(data, 'settings.json')
  const mcpConfigPath = join(data, 'mcp.json')
  const bootstrapSpecPath = join(data, 'spec.json')
  const userPromptFilePath = join(data, 'prompt.txt')
  for (const [path, value] of [[settingsPath, '{}'], [mcpConfigPath, '{}'],
    [bootstrapSpecPath, '{}'], [userPromptFilePath, 'prompt']] as const) writeFileSync(path, value)
  const [dataStat, teamStat, tasksStat] = [statSync(data), statSync(team), statSync(tasks)]
  const unsigned: Omit<HostedNativeLaunchEnvelope, 'envelopeDigest'> = {
    version: 1, role: 'native-lead', publicTeamId: 'public-1', legacyKey,
    canonicalDataRoot: data, canonicalTeamRoot: team, canonicalTasksRoot: tasks,
    canonicalCwd: cwd, dataRootIdentity: `${dataStat.dev}:${dataStat.ino}`,
    teamRootIdentity: `${teamStat.dev}:${teamStat.ino}`,
    tasksRootIdentity: `${tasksStat.dev}:${tasksStat.ino}`, runId: 'run-1',
    primary: { displayName: 'captain', agentId: 'captain@exact-team', provider: 'codex', model: 'gpt-5' },
    primaryAlias: 'team-lead', launchIdentityToken: 'launch-token',
    materialDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
    settingsDigest: digest('{}'), mcpDigest: digest('{}'), settingsPath, mcpConfigPath,
    bootstrapSpecPath, bootstrapSpecDigest: digest('{}'), userPromptFilePath,
    userPromptDigest: digest('prompt'), permissionMode: 'bypassPermissions',
    readyAckPath: join(data, 'ready.json'),
    canonicalAuthority: {
      version: 1, registrationId: 'registration-1', storageGeneration: 'storage-1',
      admittedWriterImage: `sha256:${'c'.repeat(64)}`, registryRoot: registry,
      anchorName: 'registration-1.lock', bindingRecordName: 'registration-1.json',
    },
  }
  return { ...unsigned, envelopeDigest: computeHostedNativeEnvelopeDigest(unsigned) }
}

function artifactPaths(envelope: HostedNativeLaunchEnvelope) {
  return {
    anchor: join(envelope.canonicalAuthority.registryRoot, envelope.canonicalAuthority.anchorName),
    record: join(envelope.canonicalAuthority.registryRoot, envelope.canonicalAuthority.bindingRecordName),
  }
}

describe('canonical authority issuer resource custody', () => {
  test('closes earlier descriptors and compensates owned artifacts at every open boundary', () => {
    if (process.geteuid?.() !== 0) return
    for (let failAt = 1; failAt <= 6; failAt++) {
      const envelope = fixture()
      const opened = new Set<number>()
      let calls = 0
      const failure = new Error(`open-${failAt}`)
      expect(() => issueHostedCanonicalAuthority({
        envelope,
        effects: {
          open: ((...args: Parameters<typeof openSync>) => {
            if (++calls === failAt) throw failure
            const fd = openSync(...args)
            opened.add(fd)
            return fd
          }) as typeof openSync,
          close(fd) { closeSync(fd); opened.delete(fd) },
        },
      })).toThrow(failure.message)
      expect(opened.size).toBe(0)
      const paths = artifactPaths(envelope)
      expect(existsSync(paths.anchor)).toBe(false)
      expect(existsSync(paths.record)).toBe(false)
    }
  })

  test('owns the anchor immediately after O_EXCL and cleans create/write/close failures', () => {
    if (process.geteuid?.() !== 0) return
    for (const boundary of ['anchor-chmod', 'anchor-close', 'record-write'] as const) {
      const envelope = fixture()
      let chmodCalls = 0
      let closeCalls = 0
      let thrown: unknown
      try { issueHostedCanonicalAuthority({
        envelope,
        effects: {
          chmod(fd, mode) {
            if (boundary === 'anchor-chmod' && ++chmodCalls === 1) throw new Error(boundary)
            fchmodSync(fd, mode)
          },
          close(fd) {
            if (boundary === 'anchor-close' && ++closeCalls === 1) throw new Error(boundary)
            closeSync(fd)
          },
          write: ((...args: Parameters<typeof writeSync>) => {
            if (boundary === 'record-write') throw new Error(boundary)
            return writeSync(...args)
          }) as typeof writeSync,
        },
      }) } catch (error) { thrown = error }
      const messages = (error: unknown): string => error instanceof AggregateError
        ? [error.message, ...error.errors.map(messages)].join(' | ')
        : String(error)
      expect(messages(thrown)).toContain(boundary)
      const paths = artifactPaths(envelope)
      expect(existsSync(paths.anchor)).toBe(false)
      expect(existsSync(paths.record)).toBe(false)
    }
  })

  test('preserves original and cleanup failures while attempting every descriptor close', () => {
    if (process.geteuid?.() !== 0) return
    const envelope = fixture()
    const original = new Error('original write failure')
    const cleanupFailure = new Error('cleanup unlink failure')
    const closeFailure = new Error('one close failure')
    let closeCalls = 0
    let unlinkCalls = 0
    let thrown: unknown
    try {
      issueHostedCanonicalAuthority({
        envelope,
        effects: {
          write: (() => { throw original }) as typeof writeSync,
          unlink() { unlinkCalls++; throw cleanupFailure },
          close(fd) {
            closeCalls++
            if (closeCalls === 3) throw closeFailure
            closeSync(fd)
          },
        },
      })
    } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(AggregateError)
    const rendered = String((thrown as AggregateError).errors.map(error => String(error)))
    expect(rendered).toContain(original.message)
    expect(rendered).toContain(cleanupFailure.message)
    expect(rendered).toContain(closeFailure.message)
    expect(unlinkCalls).toBe(2)
    expect(closeCalls).toBeGreaterThanOrEqual(6)
  })

  test('duplicate issuance preserves the original registration artifacts', () => {
    if (process.geteuid?.() !== 0) return
    const envelope = fixture()
    const first = issueHostedCanonicalAuthority({ envelope })
    const anchorBefore = lstatSync(first.anchorPath)
    const recordBefore = readFileSync(first.bindingRecordPath)
    expect(() => issueHostedCanonicalAuthority({ envelope })).toThrow()
    const anchorAfter = lstatSync(first.anchorPath)
    expect(`${anchorAfter.dev}:${anchorAfter.ino}`).toBe(`${anchorBefore.dev}:${anchorBefore.ino}`)
    expect(readFileSync(first.bindingRecordPath)).toEqual(recordBefore)
  })
})
