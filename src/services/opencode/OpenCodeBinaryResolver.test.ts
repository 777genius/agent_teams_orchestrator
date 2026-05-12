import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'

describe('OpenCodeBinaryResolver', () => {
  let tempRoot: string
  let originalAppManagedPath: string | undefined
  let originalOpenCodePath: string | undefined
  let originalWhich: typeof Bun.which

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-bin-resolver-'))
    originalAppManagedPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    originalOpenCodePath = process.env.OPENCODE_BIN_PATH
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
})
