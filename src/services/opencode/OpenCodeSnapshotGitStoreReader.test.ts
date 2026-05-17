import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  OpenCodeSnapshotGitStoreReader,
  parseOpenCodeSnapshotNumstatZ,
  parseOpenCodeSnapshotRawDiffZ,
  validateOpenCodeSnapshotGitStoreArgs,
} from './OpenCodeSnapshotGitStoreReader.js'

let tempDir = ''
let worktree = ''
let profileDataDir = ''
let projectId = ''
let gitDir = ''

class FixtureOfflineReader {
  resolveDbPath(): string {
    return path.join(profileDataDir, 'opencode.db')
  }
}

function hashFast(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function runGit(args: string[], cwd = worktree): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

async function setupSnapshotRepo(): Promise<void> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-snapshot-git-store-'))
  worktree = path.join(tempDir, 'worktree')
  profileDataDir = path.join(tempDir, 'profile', 'data', 'opencode')
  projectId = 'project-fixture'
  gitDir = path.join(profileDataDir, 'snapshot', projectId, hashFast(worktree))
  await mkdir(worktree, { recursive: true })
  await mkdir(gitDir, { recursive: true })
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'init'], tempDir)
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'config', 'core.autocrlf', 'false'], tempDir)
}

function writeTree(): string {
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], tempDir)
  return runGit(['--git-dir', gitDir, '--work-tree', worktree, 'write-tree'], tempDir)
}

function reader(): OpenCodeSnapshotGitStoreReader {
  return new OpenCodeSnapshotGitStoreReader({
    offlineSessionReader: new FixtureOfflineReader(),
  })
}

function baseInput(overrides: Partial<Parameters<OpenCodeSnapshotGitStoreReader['read']>[0]> = {}) {
  return {
    profileRootKey: 'fixture-profile',
    projectId,
    worktree,
    directory: worktree,
    fromSnapshot: '0'.repeat(40),
    toSnapshot: '1'.repeat(40),
    touchedRelativePaths: ['file.txt'],
    limits: {
      maxFiles: 20,
      maxBytesPerTextFile: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
      timeoutMs: 3000,
    },
    ...overrides,
  }
}

beforeEach(async () => {
  await setupSnapshotRepo()
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe('OpenCodeSnapshotGitStoreReader', () => {
  test('returns full text evidence for modify, create, and delete without mutating the worktree', async () => {
    await writeFile(path.join(worktree, 'file.txt'), 'one\r\n')
    await writeFile(path.join(worktree, 'delete-me.txt'), 'remove me\n')
    const before = writeTree()

    await writeFile(path.join(worktree, 'file.txt'), 'one\r\ntwo\r\n')
    await writeFile(path.join(worktree, 'created.txt'), 'created\n')
    await rm(path.join(worktree, 'delete-me.txt'))
    const after = writeTree()
    const statusBeforeRead = runGit(['--git-dir', gitDir, '--work-tree', worktree, 'status', '--porcelain=v1'], tempDir)

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['file.txt', 'created.txt', 'delete-me.txt'],
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(runGit(['--git-dir', gitDir, '--work-tree', worktree, 'status', '--porcelain=v1'], tempDir)).toBe(statusBeforeRead)
    const byPath = new Map(result.files.map(file => [file.relativePath, file]))
    expect(byPath.get('file.txt')?.operation).toBe('modify')
    expect(byPath.get('file.txt')?.beforeContent).toBe('one\r\n')
    expect(byPath.get('file.txt')?.afterContent).toBe('one\r\ntwo\r\n')
    expect(byPath.get('file.txt')?.additions).toBe(1)
    expect(byPath.get('created.txt')?.operation).toBe('create')
    expect(byPath.get('created.txt')?.beforeState.exists).toBe(false)
    expect(byPath.get('created.txt')?.afterContent).toBe('created\n')
    expect(byPath.get('delete-me.txt')?.operation).toBe('delete')
    expect(byPath.get('delete-me.txt')?.beforeContent).toBe('remove me\n')
    expect(byPath.get('delete-me.txt')?.afterState.exists).toBe(false)
  })

  test('ignores snapshot paths outside the touched set', async () => {
    await writeFile(path.join(worktree, 'file.txt'), 'a\n')
    await writeFile(path.join(worktree, 'other.txt'), 'a\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'file.txt'), 'b\n')
    await writeFile(path.join(worktree, 'other.txt'), 'b\n')
    const after = writeTree()

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['file.txt'],
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(result.files.map(file => file.relativePath)).toEqual(['file.txt'])
    expect(result.diagnostics.join('\n')).toContain('snapshot-path-not-touched: other.txt')
  })

  test('does not spend blob budget on snapshot paths outside strict toolpart candidates', async () => {
    await mkdir(path.join(worktree, 'aaa-extra'), { recursive: true })
    await mkdir(path.join(worktree, 'zzz-candidates'), { recursive: true })
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(worktree, 'aaa-extra', `${index}.txt`), 'x'.repeat(4096))
    }
    await writeFile(path.join(worktree, 'zzz-candidates', 'one.txt'), 'one-before\n')
    await writeFile(path.join(worktree, 'zzz-candidates', 'two.txt'), 'two-before\n')
    const before = writeTree()

    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(worktree, 'aaa-extra', `${index}.txt`), 'y'.repeat(4096))
    }
    await writeFile(path.join(worktree, 'zzz-candidates', 'one.txt'), 'one-after\n')
    await writeFile(path.join(worktree, 'zzz-candidates', 'two.txt'), 'two-after\n')
    const after = writeTree()

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['zzz-candidates/one.txt', 'zzz-candidates/two.txt'],
      limits: {
        maxFiles: 20,
        maxBytesPerTextFile: 1024 * 1024,
        maxTotalBytes: 16 * 1024,
        timeoutMs: 3000,
      },
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    const byPath = new Map(result.files.map(file => [file.relativePath, file]))
    expect(result.files.map(file => file.relativePath).sort()).toEqual([
      'zzz-candidates/one.txt',
      'zzz-candidates/two.txt',
    ])
    expect(byPath.get('zzz-candidates/one.txt')?.beforeContent).toBe('one-before\n')
    expect(byPath.get('zzz-candidates/one.txt')?.afterContent).toBe('one-after\n')
    expect(byPath.get('zzz-candidates/two.txt')?.beforeContent).toBe('two-before\n')
    expect(byPath.get('zzz-candidates/two.txt')?.afterContent).toBe('two-after\n')
    expect(result.diagnostics.filter(item => item.startsWith('snapshot-path-not-touched: aaa-extra/'))).toHaveLength(40)
    expect(result.diagnostics.join('\n')).not.toContain('snapshot-total-byte-cap-exceeded')
  })

  test('caps matching candidate files before fetching snapshot blobs', async () => {
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(worktree, 'src', `${index}.txt`), `before-${index}\n`)
    }
    const before = writeTree()
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(worktree, 'src', `${index}.txt`), `after-${index}\n`)
    }
    const after = writeTree()

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['src/0.txt', 'src/1.txt', 'src/2.txt', 'src/3.txt', 'src/4.txt'],
      limits: {
        maxFiles: 2,
        maxBytesPerTextFile: 1024 * 1024,
        maxTotalBytes: 1024 * 1024,
        timeoutMs: 3000,
      },
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(result.files).toHaveLength(2)
    expect(result.files.map(file => file.relativePath)).toEqual(['src/0.txt', 'src/1.txt'])
    expect(result.diagnostics.join('\n')).toContain('snapshot-file-cap: captured first 2 snapshot files; remaining files skipped.')
  })

  test('scopes snapshot diff to session directory and keeps outside touched paths metadata-only', async () => {
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    await writeFile(path.join(worktree, 'src/file.txt'), 'src-before\n')
    await writeFile(path.join(worktree, 'root.txt'), 'root-before\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'src/file.txt'), 'src-after\n')
    await writeFile(path.join(worktree, 'root.txt'), 'root-after\n')
    const after = writeTree()

    const result = await reader().read(baseInput({
      directory: path.join(worktree, 'src'),
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['src/file.txt', 'root.txt'],
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(result.files.map(file => file.relativePath)).toEqual(['src/file.txt'])
    expect(result.diagnostics.join('\n')).toContain(
      'snapshot-touched-path-not-in-diff: root.txt was requested but absent from the scoped snapshot diff.',
    )
  })

  test('keeps binary and large file evidence metadata-only', async () => {
    await writeFile(path.join(worktree, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(worktree, 'large.txt'), 'small\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]))
    await writeFile(path.join(worktree, 'large.txt'), 'x'.repeat(64))
    const after = writeTree()

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['binary.bin', 'large.txt'],
      limits: {
        maxFiles: 20,
        maxBytesPerTextFile: 16,
        maxTotalBytes: 1024,
        timeoutMs: 3000,
      },
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    const byPath = new Map(result.files.map(file => [file.relativePath, file]))
    expect(byPath.get('binary.bin')?.binary).toBe(true)
    expect(byPath.get('binary.bin')?.beforeContent).toBeUndefined()
    expect(byPath.get('binary.bin')?.afterState.unavailableReason).toBe('snapshot-content-binary')
    expect(byPath.get('large.txt')?.afterContent).toBeUndefined()
    expect(byPath.get('large.txt')?.afterState.unavailableReason).toBe('snapshot-content-too-large')
  })

  test('fails closed on invalid input, missing gitdir, and case-colliding touched paths', async () => {
    const invalidHash = await reader().read(baseInput({ fromSnapshot: '1234' }))
    expect(invalidHash.supported).toBe(false)
    expect(invalidHash.supported ? '' : invalidHash.code).toBe('snapshot-invalid-input')

    const collision = await reader().read(baseInput({
      touchedRelativePaths: ['src/File.ts', 'src/file.ts'],
    }))
    expect(collision.supported).toBe(false)
    expect(collision.supported ? '' : collision.code).toBe('snapshot-invalid-input')
    expect(collision.supported ? [] : collision.diagnostics.join('\n')).toContain('snapshot-case-collision')

    const missing = await reader().read(baseInput({
      projectId: 'missing-project',
    }))
    expect(missing.supported).toBe(false)
    expect(missing.supported ? '' : missing.code).toBe('snapshot-gitdir-missing')
  })

  test('returns unsupported diagnostic on git timeout', async () => {
    await writeFile(path.join(worktree, 'file.txt'), 'a\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'file.txt'), 'b\n')
    const after = writeTree()

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      limits: {
        maxFiles: 20,
        maxBytesPerTextFile: 1024,
        maxTotalBytes: 1024,
        timeoutMs: 1,
      },
    }))

    if (result.supported) {
      expect(result.diagnostics.join('\n')).toContain('snapshot-git-timeout')
    } else {
      expect(result.code).toBe('snapshot-diff-read-failed')
      expect(result.diagnostics.join('\n')).toContain('snapshot-git-timeout')
    }
  })

  test('keeps typechange, symlink, gitlink, and chmod-only changes metadata-only', async () => {
    await writeFile(path.join(worktree, 'chmod.sh'), '#!/bin/sh\necho one\n')
    await writeFile(path.join(worktree, 'link-target.txt'), 'target\n')
    await symlink('link-target.txt', path.join(worktree, 'link.txt'))
    await mkdir(path.join(worktree, 'submodule'), { recursive: true })
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], tempDir)
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'update-index', '--add', '--cacheinfo', '160000', '1111111111111111111111111111111111111111', 'submodule'], tempDir)
    const before = runGit(['--git-dir', gitDir, '--work-tree', worktree, 'write-tree'], tempDir)

    await chmod(path.join(worktree, 'chmod.sh'), 0o755)
    await rm(path.join(worktree, 'link.txt'))
    await writeFile(path.join(worktree, 'link.txt'), 'now regular\n')
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], tempDir)
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'update-index', '--chmod=+x', 'chmod.sh'], tempDir)
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'update-index', '--cacheinfo', '160000', '2222222222222222222222222222222222222222', 'submodule'], tempDir)
    const after = runGit(['--git-dir', gitDir, '--work-tree', worktree, 'write-tree'], tempDir)

    const result = await reader().read(baseInput({
      fromSnapshot: before,
      toSnapshot: after,
      touchedRelativePaths: ['chmod.sh', 'link.txt', 'submodule'],
    }))

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    const byPath = new Map(result.files.map(file => [file.relativePath, file]))
    expect(byPath.get('chmod.sh')?.beforeContent).toBeUndefined()
    expect(byPath.get('chmod.sh')?.warnings).toContain('snapshot-mode-only-change')
    expect(byPath.get('link.txt')?.beforeState.unavailableReason).toBe('snapshot-symlink-mode')
    expect(byPath.get('link.txt')?.beforeContent).toBeUndefined()
    expect(byPath.get('submodule')?.beforeState.unavailableReason).toBe('snapshot-gitlink-mode')
  })
})

describe('OpenCode snapshot raw parsers', () => {
  test('supports spaces, unicode, tabs, colon, leading dash, and newline in filenames', () => {
    const objectA = 'a'.repeat(40)
    const objectB = 'b'.repeat(40)
    const raw = Buffer.concat([
      Buffer.from(`:100644 100644 ${objectA} ${objectB} M\0`),
      Buffer.from('dir/- spaced\tфайл:name\nnext.txt\0'),
    ])
    const diagnostics: string[] = []

    expect(parseOpenCodeSnapshotRawDiffZ(raw, diagnostics)).toEqual([
      {
        oldMode: '100644',
        newMode: '100644',
        oldObjectId: objectA,
        newObjectId: objectB,
        status: 'M',
        relativePath: 'dir/- spaced\tфайл:name\nnext.txt',
      },
    ])
    expect(diagnostics).toEqual([])
  })

  test('escapes unsafe path text in diagnostics', () => {
    const objectA = 'a'.repeat(40)
    const objectB = 'b'.repeat(40)
    const unsafePath = 'dir/bad\nname.txt'
    const raw = Buffer.concat([
      Buffer.from(`:100644 100644 ${objectA} ${objectB} R100\0`),
      Buffer.from(`${unsafePath}\0`),
    ])
    const diagnostics: string[] = []

    expect(parseOpenCodeSnapshotRawDiffZ(raw, diagnostics)).toEqual([])
    expect(diagnostics).toContain(
      `snapshot-raw-diff-unsupported-relation: R100 for ${JSON.stringify(unsafePath)} is not supported.`,
    )
    expect(diagnostics.join('\n')).not.toContain(unsafePath)
  })

  test('rejects abbreviated raw object ids even when full-index would be present elsewhere', () => {
    const diagnostics: string[] = []
    const raw = Buffer.from(':100644 100644 abc1234 def5678 M\0file.txt\0')

    expect(parseOpenCodeSnapshotRawDiffZ(raw, diagnostics)).toEqual([])
    expect(diagnostics.join('\n')).toContain('snapshot-raw-diff-malformed')
  })

  test('rejects unsupported non-SHA-1 raw object ids with an explicit diagnostic', () => {
    const diagnostics: string[] = []
    const objectA = 'a'.repeat(64)
    const objectB = 'b'.repeat(64)
    const raw = Buffer.from(`:100644 100644 ${objectA} ${objectB} M\0file.txt\0`)

    expect(parseOpenCodeSnapshotRawDiffZ(raw, diagnostics)).toEqual([])
    expect(diagnostics.join('\n')).toContain('snapshot-object-id-algorithm-unsupported')
  })

  test('skips invalid UTF-8 path bytes with diagnostic', () => {
    const objectA = 'a'.repeat(40)
    const objectB = 'b'.repeat(40)
    const diagnostics: string[] = []
    const raw = Buffer.concat([
      Buffer.from(`:100644 100644 ${objectA} ${objectB} M\0`),
      Buffer.from([0xff, 0x00]),
    ])

    expect(parseOpenCodeSnapshotRawDiffZ(raw, diagnostics)).toEqual([])
    expect(diagnostics.join('\n')).toContain('snapshot-raw-diff-path: invalid UTF-8 bytes skipped')
  })

  test('parses binary numstat and rejects unsafe numstat paths', () => {
    const diagnostics: string[] = []
    const parsed = parseOpenCodeSnapshotNumstatZ(Buffer.from('-\t-\tbinary.bin\0+1\t0\t../bad.txt\0'), diagnostics)

    expect(parsed.get('binary.bin')).toEqual({ additions: 0, deletions: 0, binary: true })
    expect(parsed.has('../bad.txt')).toBe(false)
    expect(diagnostics.join('\n')).toContain('snapshot-numstat-unsafe-path')
  })

  test('allows only read-only snapshot git commands', () => {
    const prefix = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.longpaths=true',
      '--git-dir',
      '/snapshot/gitdir',
      '--work-tree',
      '/worktree',
    ]

    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'diff', '--no-ext-diff', '--raw'])).toBeNull()
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'cat-file', '--batch'])).toBeNull()
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'cat-file', '--batch-check'])).toBeNull()
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'add', '--all'])).toContain('git add is not allowed')
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'write-tree'])).toContain('git write-tree is not allowed')
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'gc', '--prune=now'])).toContain('git gc is not allowed')
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'diff', '--raw'])).toContain('must include --no-ext-diff')
    expect(validateOpenCodeSnapshotGitStoreArgs([...prefix, 'cat-file', '-p', 'HEAD'])).toContain('must use batch mode')
  })
})
