import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeSnapshotEvidenceProviderService } from './OpenCodeSnapshotEvidenceProvider.js'
import { OpenCodeSnapshotGitStoreReader } from './OpenCodeSnapshotGitStoreReader.js'

import type { OpenCodeOfflineSessionReadResult, OpenCodeSqlitePartRow } from './OpenCodeOfflineSessionReader.js'
import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
import type { OpenCodeSessionRecord } from './types.js'

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

function runGit(args: string[], cwd = tempDir): string {
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
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-snapshot-provider-'))
  worktree = path.join(tempDir, 'worktree')
  profileDataDir = path.join(tempDir, 'profile', 'data', 'opencode')
  projectId = 'project-fixture'
  gitDir = path.join(profileDataDir, 'snapshot', projectId, hashFast(worktree))
  await mkdir(worktree, { recursive: true })
  await mkdir(gitDir, { recursive: true })
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'init'])
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'config', 'core.autocrlf', 'false'])
}

function writeTree(): string {
  runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'])
  return runGit(['--git-dir', gitDir, '--work-tree', worktree, 'write-tree'])
}

function partRow(id: string, messageId: string, data: Record<string, unknown>): OpenCodeSqlitePartRow {
  return {
    id,
    message_id: messageId,
    session_id: 'session-1',
    time_created: 1000,
    time_updated: null,
    dataLengthBytes: JSON.stringify(data).length,
    data: JSON.stringify(data),
  }
}

function sessionRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'bob',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4',
    projectPath: worktree,
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'behavior-v1',
    opencodeSessionId: 'session-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  }
}

function change(overrides: Partial<ReconstructedOpenCodeToolChange> = {}): ReconstructedOpenCodeToolChange {
  return {
    taskId: 'task-1',
    taskRef: 'task-1',
    taskRefKind: 'canonical',
    teamName: 'team-a',
    memberName: 'bob',
    sessionId: 'session-1',
    parentUserMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    toolUseId: 'call-edit',
    sourcePartId: 'part-edit',
    sourceMessageId: 'assistant-1',
    sourceTool: 'edit',
    sourceImportKey: `opencode\0session-1\0part-edit\0${path.join(worktree, 'src/file.ts')}`,
    filePath: path.join(worktree, 'src/file.ts'),
    relativePath: 'src/file.ts',
    beforeContent: null,
    afterContent: null,
    beforeState: { exists: true, unavailableReason: 'opencode-edit-baseline-not-captured' },
    afterState: { exists: true, unavailableReason: 'opencode-edit-final-content-unavailable' },
    operation: 'modify',
    confidence: 'medium',
    attributionMethod: 'delivery-ledger-taskrefs',
    oldString: 'one',
    newString: 'two',
    warnings: [],
    timestamp: '2026-04-26T10:00:00.000Z',
    ...overrides,
  }
}

function offlineFixture(fromSnapshot: string, toSnapshot: string): OpenCodeOfflineSessionReadResult {
  return {
    source: 'opencode-sqlite',
    dbPath: path.join(profileDataDir, 'opencode.db'),
    dbFingerprint: { dbMtimeMs: 1, dbSizeBytes: 1 },
    historyShape: 'supported',
    sessionIdentity: {
      sessionId: 'session-1',
      projectId,
      directory: worktree,
      project: {
        id: projectId,
        worktree,
        vcs: 'git',
      },
      snapshotEvidenceSupported: true,
      unsupportedReasons: [],
    },
    snapshotStepParts: [],
    patchParts: [],
    snapshotWindows: [
      {
        windowId: 'assistant-1:000-step-start->zzz-step-finish',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        fromSnapshot,
        toSnapshot,
        startPartId: '000-step-start',
        finishPartId: 'zzz-step-finish',
        startPartOrder: 0,
        finishPartOrder: 2,
      },
    ],
    rawMessages: [],
    rawParts: [
      partRow('000-step-start', 'assistant-1', { type: 'step-start', snapshot: fromSnapshot }),
      partRow('part-edit', 'assistant-1', { type: 'tool', tool: 'edit' }),
      partRow('zzz-step-finish', 'assistant-1', { type: 'step-finish', snapshot: toSnapshot }),
    ],
    messages: [],
    diagnostics: [],
  }
}

function provider(): OpenCodeSnapshotEvidenceProviderService {
  return new OpenCodeSnapshotEvidenceProviderService(
    new OpenCodeSnapshotGitStoreReader({
      offlineSessionReader: new FixtureOfflineReader(),
    }),
  )
}

beforeEach(async () => {
  await setupSnapshotRepo()
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe('OpenCodeSnapshotEvidenceProviderService', () => {
  test('reads session-part snapshot evidence from the matching tool window only', async () => {
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    await writeFile(path.join(worktree, 'src/file.ts'), 'export const value = 1;\n')
    await writeFile(path.join(worktree, 'src/other.ts'), 'export const other = 1;\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'src/file.ts'), 'export const value = 2;\n')
    await writeFile(path.join(worktree, 'src/other.ts'), 'export const other = 2;\n')
    const after = writeTree()

    const result = await provider().readSessionEvidence({
      workspaceRoot: worktree,
      sessionRecord: sessionRecord(),
      offline: offlineFixture(before, after),
      changes: [change()],
      touchedRelativePaths: ['src/file.ts'],
    })

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({
      relativePath: 'src/file.ts',
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      operation: 'modify',
    })
    expect(result.diagnostics.join('\n')).toContain('snapshot-path-not-touched: src/other.ts')
  })

  test('does not use first-start/last-finish when a toolpart is outside the window', async () => {
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    await writeFile(path.join(worktree, 'src/file.ts'), 'before\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'src/file.ts'), 'after\n')
    const after = writeTree()
    const offline = {
      ...offlineFixture(before, after),
      snapshotWindows: [
        {
          ...offlineFixture(before, after).snapshotWindows[0]!,
          startPartOrder: 3,
          finishPartOrder: 4,
        },
      ],
    }

    const result = await provider().readSessionEvidence({
      workspaceRoot: worktree,
      sessionRecord: sessionRecord(),
      offline,
      changes: [change()],
      touchedRelativePaths: ['src/file.ts'],
    })

    expect(result.supported).toBe(true)
    if (!result.supported) {
      return
    }
    expect(result.files).toEqual([])
    expect(result.diagnostics.join('\n')).toContain('toolpart part-edit is outside OpenCode snapshot windows')
  })

  test('fails closed when session identity is unsupported or workspace mismatches', async () => {
    await mkdir(path.join(worktree, 'src'), { recursive: true })
    await writeFile(path.join(worktree, 'src/file.ts'), 'before\n')
    const before = writeTree()
    await writeFile(path.join(worktree, 'src/file.ts'), 'after\n')
    const after = writeTree()
    const unsupported = {
      ...offlineFixture(before, after),
      sessionIdentity: {
        ...offlineFixture(before, after).sessionIdentity!,
        snapshotEvidenceSupported: false,
        unsupportedReasons: ['snapshot-project-not-git'],
      },
    }

    const unsupportedResult = await provider().readSessionEvidence({
      workspaceRoot: worktree,
      sessionRecord: sessionRecord(),
      offline: unsupported,
      changes: [change()],
      touchedRelativePaths: ['src/file.ts'],
    })
    expect(unsupportedResult.supported).toBe(false)
    expect(unsupportedResult.supported ? '' : unsupportedResult.diagnostics.join('\n')).toContain('snapshot-project-not-git')

    const mismatchResult = await provider().readSessionEvidence({
      workspaceRoot: path.join(tempDir, 'other-worktree'),
      sessionRecord: sessionRecord(),
      offline: offlineFixture(before, after),
      changes: [change()],
      touchedRelativePaths: ['src/file.ts'],
    })
    expect(mismatchResult.supported).toBe(false)
    expect(mismatchResult.supported ? '' : mismatchResult.diagnostics.join('\n')).toContain('snapshot-project-worktree-mismatch')
  })
})
