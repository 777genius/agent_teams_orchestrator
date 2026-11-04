import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveOpenCodeBinaryPath, resolveAppManagedOpenCodeBinaryPath, readCapturedOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'

describe('OpenCodeBinaryResolver', () => {
  let tempRoot: string
  let originalAppManagedPath: string | undefined
  let originalOpenCodePath: string | undefined
  let originalAppData: string | undefined
  let originalWhich: typeof Bun.which

  beforeEach(async () => {
    tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-bin-resolver-')))
    originalAppManagedPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    originalOpenCodePath = process.env.OPENCODE_BIN_PATH
    originalAppData = process.env.APPDATA
    originalWhich = Bun.which
  })

  afterEach(async () => {
    if (originalAppManagedPath === undefined) {
      delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    } else {
      process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = originalAppManagedPath
    }
    if (originalOpenCodePath === undefined) {
      delete process.env.OPENCODE_BIN_PATH
    } else {
      process.env.OPENCODE_BIN_PATH = originalOpenCodePath
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = originalAppData
    }
    Bun.which = originalWhich
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('prefers the app-managed binary env path before OPENCODE_BIN_PATH and PATH', async () => {
    const appManagedBinary = path.join(tempRoot, 'app-managed-opencode')
    const explicitBinary = path.join(tempRoot, 'explicit-opencode')
    await writeFile(appManagedBinary, 'app-managed')
    await writeFile(explicitBinary, 'explicit')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = appManagedBinary
    process.env.OPENCODE_BIN_PATH = explicitBinary
    Bun.which = ((binaryName: string) => (
      binaryName === 'opencode' ? path.join(tempRoot, 'path-opencode') : null
    )) as typeof Bun.which

    expect(await resolveOpenCodeBinaryPath()).toBe(appManagedBinary)
  })

  test('falls back to OPENCODE_BIN_PATH and then PATH', async () => {
    const explicitBinary = path.join(tempRoot, 'explicit-opencode')
    await writeFile(explicitBinary, 'explicit')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = path.join(tempRoot, 'missing-opencode')
    process.env.OPENCODE_BIN_PATH = explicitBinary
    Bun.which = ((binaryName: string) => (
      binaryName === 'opencode' ? path.join(tempRoot, 'path-opencode') : null
    )) as typeof Bun.which

    expect(await resolveOpenCodeBinaryPath()).toBe(explicitBinary)

    process.env.OPENCODE_BIN_PATH = path.join(tempRoot, 'also-missing-opencode')

    expect(await resolveOpenCodeBinaryPath()).toBe(path.join(tempRoot, 'path-opencode'))
  })

  test('selects an app-managed UI runtime matching supplied execution facts', async () => {
    const appData = path.join(tempRoot, 'appdata')
    const binaryPath = path.join(
      appData,
      'claude-agent-teams-ui',
      'data',
      'runtimes',
      'opencode',
      'versions',
      '1.14.48',
      'opencode-windows-x64',
      'opencode.exe',
    )
    await mkdir(path.dirname(binaryPath), { recursive: true })
    await writeFile(binaryPath, 'app-managed-runtime')
    delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    delete process.env.OPENCODE_BIN_PATH
    process.env.APPDATA = appData
    Bun.which = (() => null) as typeof Bun.which

    expect(resolveAppManagedOpenCodeBinaryPath({ platform: 'win32', arch: 'x64', libc: null, avx2: 'yes' })).toBe(binaryPath)
  })
  test('ranks same-version packages before mtime and refuses wrong or unknown Linux ABI', async () => {
    process.env.APPDATA = path.join(tempRoot, 'appdata')
    const root = path.join(process.env.APPDATA, 'claude-agent-teams-ui', 'data', 'runtimes', 'opencode', 'versions', '1.18.34')
    const standard = path.join(root, 'opencode-linux-x64', 'opencode')
    const baseline = path.join(root, 'opencode-linux-x64-baseline', 'opencode')
    const musl = path.join(root, 'opencode-linux-x64-musl', 'opencode')
    for (const file of [standard, baseline, musl]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'TEST-selection-only') }
    const old = new Date(1_000), recent = new Date(100_000)
    await utimes(standard, old, old); await utimes(baseline, recent, recent)
    const facts = { platform: 'linux', arch: 'x64', libc: 'glibc' as const, avx2: 'yes' as const }
    expect(resolveAppManagedOpenCodeBinaryPath(facts)).toBe(standard)
    expect(resolveAppManagedOpenCodeBinaryPath({ ...facts, avx2: 'unknown' })).toBe(baseline)
    expect(resolveAppManagedOpenCodeBinaryPath({ ...facts, libc: 'musl' })).toBe(musl)
    expect(resolveAppManagedOpenCodeBinaryPath({ ...facts, libc: 'unknown' })).toBeNull()
    await rm(baseline)
    expect(resolveAppManagedOpenCodeBinaryPath({ ...facts, avx2: 'no' })).toBeNull()
  })

  test.each(['darwin', 'win32'])('keeps a standard-only AVX2 %s delivery discoverable', async (platform) => {
    process.env.APPDATA = path.join(tempRoot, 'appdata')
    const name = `opencode-${platform === 'win32' ? 'windows' : platform}-x64`
    const file = path.join(process.env.APPDATA, 'claude-agent-teams-ui', 'data', 'runtimes', 'opencode', 'versions', '1.18.34', name, platform === 'win32' ? 'opencode.exe' : 'opencode')
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'TEST-selection-only')
    expect(resolveAppManagedOpenCodeBinaryPath({ platform, arch: 'x64', libc: null, avx2: 'yes' })).toBe(file)
    expect(resolveAppManagedOpenCodeBinaryPath({ platform, arch: 'x64', libc: null, avx2: 'unknown' })).toBeNull()
  })

  test('canceled selection rejects and timeout projection never starts new discovery', async () => {
    const file = path.join(tempRoot, 'TEST-captured-opencode')
    await writeFile(file, 'TEST-selection-only')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = file
    expect(readCapturedOpenCodeBinaryPath()).toBeNull()
    expect(await resolveOpenCodeBinaryPath()).toBe(file)
    expect(readCapturedOpenCodeBinaryPath()).toBe(file)
    const controller = new AbortController(); controller.abort(new Error('TEST-selection-canceled'))
    await expect(resolveOpenCodeBinaryPath(controller.signal)).rejects.toThrow('TEST-selection-canceled')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = path.join(tempRoot, 'missing')
    expect(readCapturedOpenCodeBinaryPath()).toBeNull()
  })

})
