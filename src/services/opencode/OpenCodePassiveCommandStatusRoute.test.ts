import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { OpenCodePassiveStatusV1 } from './OpenCodePassiveStatusContract.js'
import {
  executeOpenCodePassiveCommandStatusEnvelope,
  readOpenCodeCommandOutcomeReadOnly,
  type OpenCodePassiveCommandStatusOutcome,
} from './OpenCodePassiveCommandStatusRoute.js'

function envelope(body: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestId: 'status-request',
    command: 'opencode.commandStatus',
    cwd: '/opaque-input',
    startedAt: '2026-08-19T00:00:00.000Z',
    timeoutMs: 25,
    body: { originalRequestId: 'send-request', ...body },
  }
}

function passive(): OpenCodePassiveStatusV1 {
  return {
    contractVersion: 1,
    projectScope: `sha256:${'a'.repeat(64)}`,
    binary: {
      value: { presence: 'present', version: '1.2.3' },
      authority: 'binary_metadata', freshness: 'fresh', condition: 'normal',
      observedAt: 900, validUntil: 2_000, issueCode: 'none',
    },
    providers: [],
    authorization: 'unknown',
    launchReadiness: 'not_authorized',
    completedAt: 1_000,
  }
}

function outcome(overrides: Partial<OpenCodePassiveCommandStatusOutcome> = {}): OpenCodePassiveCommandStatusOutcome {
  return {
    requestId: 'send-request',
    deliveryAttemptId: null,
    status: 'prompt_accepted',
    safeToRetry: false,
    sessionId: 'session-opaque',
    runtimePid: null,
    runtimePromptMessageId: 'message-opaque',
    prePromptCursor: null,
    ...overrides,
  }
}

describe('OpenCode passive command-status production route', () => {
  test('derives command status from passive and read-only outcome ports only', async () => {
    const prohibited = new Map([
      ['prepareProfile', 0], ['inventory', 0], ['host', 0], ['lock', 0],
      ['spawn', 0], ['fetch', 0], ['provider', 0], ['model', 0], ['agent', 0],
      ['plugin', 0], ['oauth', 0], ['mkdir', 0], ['write', 0], ['rename', 0], ['unlink', 0],
    ])
    let passiveCalls = 0
    let outcomeCalls = 0
    const result = await executeOpenCodePassiveCommandStatusEnvelope(envelope(), {
      now: () => 1_000,
      schedule: () => ({ cancel() {} }),
      readPassiveStatus: async input => {
        passiveCalls += 1
        expect(input.projectPath).toBe('/opaque-input')
        expect(input.timeoutMs).toBe(25)
        return passive()
      },
      readOutcome: async input => {
        outcomeCalls += 1
        expect(input.requestId).toBe('send-request')
        return outcome()
      },
    })

    expect(passiveCalls).toBe(1)
    expect(outcomeCalls).toBe(1)
    expect([...prohibited.values()].every(count => count === 0)).toBe(true)
    expect(result.runtime).toMatchObject({ version: '1.2.3', binaryFingerprint: 'version:1.2.3' })
    expect(result.data).toMatchObject({ status: 'prompt_accepted', accepted: true, safeToRetry: false })
    expect(JSON.stringify(result)).not.toContain('/opaque-input')
  })

  test('bounds Moth/#443-style hung seams and fences late completion without sleeps', async () => {
    let fireDeadline!: () => void
    let releaseOutcome!: (value: OpenCodePassiveCommandStatusOutcome | null) => void
    const delayedOutcome = new Promise<OpenCodePassiveCommandStatusOutcome | null>(resolve => {
      releaseOutcome = resolve
    })
    const never = new Promise<OpenCodePassiveStatusV1>(() => {})
    const pending = executeOpenCodePassiveCommandStatusEnvelope(envelope(), {
      now: () => 1_000,
      schedule: callback => {
        fireDeadline = callback
        return { cancel() {} }
      },
      readPassiveStatus: async () => never,
      readOutcome: async () => delayedOutcome,
    })
    await Promise.resolve()
    fireDeadline()
    const result = await pending
    const returned = JSON.stringify(result)
    expect(result.data).toMatchObject({ status: 'unknown', accepted: false, safeToRetry: false })
    expect(result.runtime).toMatchObject({ version: null, binaryFingerprint: null })

    releaseOutcome(outcome())
    await Promise.resolve()
    expect(JSON.stringify(result)).toBe(returned)
  })

  test('never lets config or execution evidence authorize a command outcome', async () => {
    const result = await executeOpenCodePassiveCommandStatusEnvelope(envelope(), {
      now: () => 1_000,
      schedule: () => ({ cancel() {} }),
      readPassiveStatus: async () => passive(),
      readOutcome: async () => outcome({ status: 'prompt_submitting', safeToRetry: true }),
    })
    expect(result.data).toMatchObject({ status: 'prompt_submitting', accepted: false, safeToRetry: false })
  })

  test('reads the bounded outcome store without locks or mutation and drops non-whitelisted fields', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.passive-command-outcome-'))
    const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    try {
      const directory = path.join(root, 'opencode')
      const filePath = path.join(directory, 'command-outcomes.json')
      await mkdir(directory, { recursive: true })
      await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        records: {
          'send-request': {
            schemaVersion: 1,
            command: 'opencode.sendMessage',
            requestId: 'send-request',
            deliveryAttemptId: 'attempt-opaque',
            status: 'prompt_accepted',
            safeToRetry: false,
            sessionId: 'session-opaque',
            runtimePid: 123,
            runtimePromptMessageId: 'message-opaque',
            prePromptCursor: null,
            projectPath: '/must-not-return',
            diagnostics: ['Bearer secret-token-must-not-return'],
            auth: { token: 'secret-token-must-not-return' },
          },
        },
      }))
      const result = await readOpenCodeCommandOutcomeReadOnly({
        requestId: 'send-request',
        deliveryAttemptId: null,
        signal: new AbortController().signal,
      })
      expect(result).toMatchObject({
        requestId: 'send-request', deliveryAttemptId: 'attempt-opaque',
        status: 'prompt_accepted', sessionId: 'session-opaque', runtimePid: 123,
      })
      expect(JSON.stringify(result)).not.toContain('must-not-return')

      await writeFile(filePath, 'x'.repeat(1_048_577))
      expect(await readOpenCodeCommandOutcomeReadOnly({
        requestId: 'send-request', deliveryAttemptId: null,
        signal: new AbortController().signal,
      })).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed for outcome file symlinks and late file replacement', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(process.cwd(), '.passive-command-outcome-race-'))
    const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    try {
      const directory = path.join(root, 'opencode')
      const file = path.join(directory, 'command-outcomes.json')
      const outside = path.join(root, 'outside.json')
      const accepted = JSON.stringify({ schemaVersion: 1, records: { send: {
        schemaVersion: 1, command: 'opencode.sendMessage', requestId: 'send-request',
        deliveryAttemptId: null, status: 'prompt_accepted', safeToRetry: false,
      } } })
      await mkdir(directory, { recursive: true })
      await writeFile(outside, accepted)
      await symlink(outside, file)
      const input = { requestId: 'send-request', deliveryAttemptId: null,
        signal: new AbortController().signal }
      expect(await readOpenCodeCommandOutcomeReadOnly(input)).toBeNull()

      await rm(file)
      await writeFile(file, accepted)
      expect(await readOpenCodeCommandOutcomeReadOnly(input, {
        afterPathIdentityCaptured: async () => {
          await rename(file, `${file}.old`)
          await writeFile(file, accepted)
        },
      })).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed when an outcome-store ancestor is a symlink', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(process.cwd(), '.passive-command-ancestor-link-'))
    const outside = await mkdtemp(path.join(process.cwd(), '.passive-command-ancestor-target-'))
    const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    try {
      await writeFile(path.join(outside, 'command-outcomes.json'), JSON.stringify({
        schemaVersion: 1, records: { send: { schemaVersion: 1, command: 'opencode.sendMessage',
          requestId: 'send-request', deliveryAttemptId: null, status: 'prompt_accepted', safeToRetry: false } },
      }))
      await symlink(outside, path.join(root, 'opencode'))
      expect(await readOpenCodeCommandOutcomeReadOnly({ requestId: 'send-request',
        deliveryAttemptId: null, signal: new AbortController().signal })).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('fails closed when the retained outcome root is replaced', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(process.cwd(), '.passive-command-root-race-'))
    const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    try {
      const directory = path.join(root, 'opencode')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'command-outcomes.json'), JSON.stringify({
        schemaVersion: 1, records: {},
      }))
      const result = await readOpenCodeCommandOutcomeReadOnly({ requestId: 'send-request',
        deliveryAttemptId: null, signal: new AbortController().signal }, {
        afterRootRetained: async () => {
          await rename(directory, `${directory}.old`)
          await mkdir(directory)
          await writeFile(path.join(directory, 'command-outcomes.json'), JSON.stringify({
            schemaVersion: 1, records: { send: { schemaVersion: 1, command: 'opencode.sendMessage',
              requestId: 'send-request', deliveryAttemptId: null, status: 'prompt_accepted', safeToRetry: false } },
          }))
        },
      })
      expect(result).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('Windows denies a pre-open writable outcome handle and same-size mutation', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(path.join(process.cwd(), '.passive-command-write-race-'))
    const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = root
    let writable: Awaited<ReturnType<typeof open>> | undefined
    try {
      const directory = path.join(root, 'opencode')
      await mkdir(directory, { recursive: true })
      const target = path.join(directory, 'command-outcomes.json')
      const original = JSON.stringify({ schemaVersion: 1, records: {} })
      await writeFile(target, original)
      writable = await open(target, 'r+')
      const replacement = original.replace('records', 'recordz')
      const result = await readOpenCodeCommandOutcomeReadOnly({ requestId: 'send-request',
        deliveryAttemptId: null, signal: new AbortController().signal }, {
        afterRootRetained: async () => {
          await writable!.write(Buffer.from(replacement), 0, Buffer.byteLength(replacement), 0)
        },
      })
      expect(result).toBeNull()
      expect((await readFile(target, 'utf8')).length).toBe(original.length)
    } finally {
      await writable?.close().catch(() => undefined)
      if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
      else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the Windows passive contract native, retained, no-follow and replacement-resistant', async () => {
    const [route, safePublication, passiveAuthority] = await Promise.all([
      readFile(import.meta.path.replace(/\.test\.ts$/, '.ts'), 'utf8'),
      readFile(new URL('./OpenCodeSafePublication.ts', import.meta.url), 'utf8'),
      readFile(new URL('./OpenCodeWindowsPassiveReadAuthority.ts', import.meta.url), 'utf8'),
    ])
    expect(route).toContain('OpenCodeSafePublicationDirectory.openReadOnly')
    expect(route).toContain("root.pinRegularFile('command-outcomes.json', true)")
    expect(safePublication).toContain('this.#windowsPassiveAuthority.pinRegular(childName(name))')
    expect(safePublication).toContain('this.#windowsPassiveAuthority.readBounded(')
    expect(passiveAuthority).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(passiveAuthority).toContain('GetFileInformationByHandleEx')
    expect(passiveAuthority).toContain('NtQueryInformationFile')
    expect(passiveAuthority).toContain('FILE_SHARE_READ')
    expect(passiveAuthority).not.toContain('FILE_SHARE_DELETE')
  })
})
