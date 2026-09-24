import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'

describe('OpenCodeBinaryResolver', () => {
  let tempRoot: string
  let originalAppManagedPath: string | undefined
  let originalOpenCodePath: string | undefined
  let originalAppData: string | undefined
  let originalWhich: typeof Bun.which
  let originalHostedMode: string | undefined
  let originalHostedBinaryPath: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-bin-resolver-'))
    originalAppManagedPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    originalOpenCodePath = process.env.OPENCODE_BIN_PATH
    originalAppData = process.env.APPDATA
    originalWhich = Bun.which
    originalHostedMode = process.env.HOSTED_OPENCODE_RUNTIME_MODE
    originalHostedBinaryPath = process.env.HOSTED_OPENCODE_BIN_PATH
    delete process.env.HOSTED_OPENCODE_RUNTIME_MODE
    delete process.env.HOSTED_OPENCODE_BIN_PATH
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
    if (originalHostedMode === undefined) delete process.env.HOSTED_OPENCODE_RUNTIME_MODE
    else process.env.HOSTED_OPENCODE_RUNTIME_MODE = originalHostedMode
    if (originalHostedBinaryPath === undefined) delete process.env.HOSTED_OPENCODE_BIN_PATH
    else process.env.HOSTED_OPENCODE_BIN_PATH = originalHostedBinaryPath
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

    expect(resolveOpenCodeBinaryPath()).toBe(appManagedBinary)
  })

  test('falls back to OPENCODE_BIN_PATH and then PATH', async () => {
    const explicitBinary = path.join(tempRoot, 'explicit-opencode')
    await writeFile(explicitBinary, 'explicit')
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = path.join(tempRoot, 'missing-opencode')
    process.env.OPENCODE_BIN_PATH = explicitBinary
    Bun.which = ((binaryName: string) => (
      binaryName === 'opencode' ? path.join(tempRoot, 'path-opencode') : null
    )) as typeof Bun.which

    expect(resolveOpenCodeBinaryPath()).toBe(explicitBinary)

    process.env.OPENCODE_BIN_PATH = path.join(tempRoot, 'also-missing-opencode')

    expect(resolveOpenCodeBinaryPath()).toBe(path.join(tempRoot, 'path-opencode'))
  })

  test('falls back to the app-managed UI runtime cache when env and PATH are unavailable', async () => {
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

    expect(resolveOpenCodeBinaryPath()).toBe(binaryPath)
  })

  test('hosted mode requires its explicit absolute path without PATH fallback', async () => {
    const binaryPath = path.join(tempRoot, 'hosted-opencode')
    await writeFile(binaryPath, 'test fixture')
    process.env.HOSTED_OPENCODE_RUNTIME_MODE = 'official-v1.18.32'
    process.env.OPENCODE_BIN_PATH = binaryPath
    Bun.which = (() => binaryPath) as typeof Bun.which

    expect(() => resolveOpenCodeBinaryPath()).toThrow('HOSTED_OPENCODE_BIN_PATH')
    process.env.HOSTED_OPENCODE_BIN_PATH = 'relative/opencode'
    expect(() => resolveOpenCodeBinaryPath()).toThrow('HOSTED_OPENCODE_BIN_PATH')
    process.env.HOSTED_OPENCODE_BIN_PATH = binaryPath
    expect(resolveOpenCodeBinaryPath()).toBe(binaryPath)
    process.env.HOSTED_OPENCODE_RUNTIME_MODE = 'fork-v1.18.32'
    expect(() => resolveOpenCodeBinaryPath()).toThrow('Unsupported hosted OpenCode runtime mode')
  })
})
