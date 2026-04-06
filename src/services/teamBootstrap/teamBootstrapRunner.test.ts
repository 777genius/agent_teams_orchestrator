import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  assertBootstrapRuntimeWorkspace,
  deriveBootstrapTerminalStatus,
  shouldCreateTeamForBootstrap,
} from './teamBootstrapRunner.js'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
})

describe('team bootstrap partial-failure policy', () => {
  test('returns completed when no members failed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 0,
      }),
    ).toBe('completed')
  })

  test('returns partial_success when partial failures are allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: true,
        failedMembersCount: 1,
      }),
    ).toBe('partial_success')
  })

  test('returns failed when partial failures are not allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 2,
      }),
    ).toBe('failed')
  })
})

describe('team bootstrap create-vs-launch policy', () => {
  test('creates missing team during create mode', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'create',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toBe(true)
  })

  test('does not create team when already attached', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'attached_existing',
        teamName: 'atlas-hq',
      }),
    ).toBe(false)
  })

  test('throws when launch mode cannot find team config', () => {
    expect(() =>
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toThrow(
      'Deterministic bootstrap cannot launch team "atlas-hq" because the team config does not exist.',
    )
  })
})

describe('team bootstrap workspace safety', () => {
  test('accepts the current runtime workspace when it matches the request', async () => {
    const cwd = process.cwd()
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects bootstrap when requested workspace differs from runtime cwd', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-cwd-'))
    tempDirs.push(tempDir)
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd: tempDir,
      }),
    ).rejects.toThrow(
      `Deterministic bootstrap cannot start team "atlas-hq" because the runtime workspace "${process.cwd()}" does not match the requested workspace "${tempDir}".`,
    )
  })
})
