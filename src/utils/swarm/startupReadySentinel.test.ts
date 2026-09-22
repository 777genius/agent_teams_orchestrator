import { afterEach, describe, expect, it } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cleanupSpawnReadySentinelDir,
  createSpawnReadySentinel,
  shouldWriteTeammateStartupReadySentinel,
  tryReadStartupReadySentinel,
  writeStartupReadySentinel,
} from './startupReadySentinel.js'

const tempDirs = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...tempDirs].map(async dir => {
      await rm(dir, { recursive: true, force: true })
      tempDirs.delete(dir)
    }),
  )
})

describe('startupReadySentinel helpers', () => {
  it('creates a unique sentinel path per spawn attempt', async () => {
    const first = await createSpawnReadySentinel()
    const second = await createSpawnReadySentinel()
    tempDirs.add(first.dir)
    tempDirs.add(second.dir)

    expect(first.dir).not.toBe(second.dir)
    expect(first.filePath).toContain(first.dir)
    expect(second.filePath).toContain(second.dir)
  })

  it('writes and reads a valid startup-ready payload', async () => {
    const sentinel = await createSpawnReadySentinel()
    tempDirs.add(sentinel.dir)

    await writeStartupReadySentinel({
      filePath: sentinel.filePath,
      teamName: 'mission-control',
      agentName: 'alice',
      sessionId: 'session-1',
    })

    const raw = await readFile(sentinel.filePath, 'utf8')
    expect(raw).toContain('"kind":"startup_ready"')

    const parsed = await tryReadStartupReadySentinel(sentinel.filePath)
    expect(parsed).toMatchObject({
      version: 1,
      kind: 'startup_ready',
      teamName: 'mission-control',
      agentName: 'alice',
      sessionId: 'session-1',
    })
    expect(parsed?.pid).toBeTypeOf('number')
    expect(parsed?.ts).toBeTypeOf('string')
  })

  it('ignores invalid sentinel payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'startup-ready-invalid-'))
    tempDirs.add(dir)
    const filePath = join(dir, 'startup-ready.json')
    await Bun.write(filePath, JSON.stringify({ kind: 'wrong' }))

    expect(await tryReadStartupReadySentinel(filePath)).toBeNull()
  })

  it('returns best-effort write behavior when the sentinel dir is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'startup-ready-missing-'))
    const filePath = join(dir, 'startup-ready.json')
    await rm(dir, { recursive: true, force: true })

    await expect(
      writeStartupReadySentinel({
        filePath,
        teamName: 'mission-control',
        agentName: 'alice',
        sessionId: 'session-1',
      }),
    ).resolves.toBeUndefined()
  })

  it('cleans up the sentinel directory best-effort', async () => {
    const sentinel = await createSpawnReadySentinel()

    await cleanupSpawnReadySentinelDir(sentinel.dir)

    await expect(access(sentinel.dir)).rejects.toThrow()
  })

  it('only allows teammate sessions with a sentinel path to write readiness', () => {
    expect(
      shouldWriteTeammateStartupReadySentinel({
        enabled: true,
        didWriteAlready: false,
        sentinelPath: '/tmp/sentinel.json',
        teamContext: {
          teamName: 'mission-control',
          teamFilePath: '/tmp/team.json',
          leadAgentId: 'lead-id',
          selfAgentId: 'alice-id',
          selfAgentName: 'alice',
          isLeader: false,
          teammates: {},
        },
      }),
    ).toBe(true)

    expect(
      shouldWriteTeammateStartupReadySentinel({
        enabled: true,
        didWriteAlready: false,
        sentinelPath: '/tmp/sentinel.json',
        teamContext: {
          teamName: 'mission-control',
          teamFilePath: '/tmp/team.json',
          leadAgentId: 'lead-id',
          selfAgentId: undefined,
          selfAgentName: 'lead',
          isLeader: true,
          teammates: {},
        },
      }),
    ).toBe(false)
  })
})
