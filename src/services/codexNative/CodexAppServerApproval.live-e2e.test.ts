import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import { runCodexNativeAppServer } from './appServerRunner.js'
import type { CodexNativeExecObservation } from './execRunner.js'

const liveTest =
  process.env.CODEX_APP_SERVER_APPROVAL_LIVE_E2E === '1'
    ? test
    : test.skip

async function collectWithTimeout(
  iterator: AsyncGenerator<CodexNativeExecObservation, unknown, unknown>,
  timeoutMs: number,
): Promise<{ observations: CodexNativeExecObservation[]; summary: unknown }> {
  const observations: CodexNativeExecObservation[] = []
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next()
          if (next.done) {
            return { observations, summary: next.value }
          }
          observations.push(next.value)
        }
      })(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Codex app-server live approval smoke timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    await iterator.return(undefined).catch(() => undefined)
  }
}

function hasCodexUsageLimitWarning(observations: CodexNativeExecObservation[]): boolean {
  return observations.some(observation => {
    if (observation.type !== 'normalized_event' || observation.event.type !== 'warning') {
      return false
    }
    return (
      observation.event.text.includes('usageLimitExceeded') ||
      observation.event.text.toLowerCase().includes('usage limit')
    )
  })
}

describe('Codex app-server approval live e2e', () => {
  liveTest('launches real codex app-server, surfaces command approval, and resumes after allow', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'codex-app-server-approval-live-'))
    await writeFile(path.join(projectPath, 'README.md'), '# Codex approval smoke\n', 'utf8')
    const approvals: string[] = []

    try {
      const { observations, summary } = await collectWithTimeout(
        runCodexNativeAppServer({
          prompt: [
            'Use the shell command tool, not a filesystem API.',
            'Run exactly: printf codex-approval-smoke > codex-approval-smoke.txt',
            'Then reply with the file content.',
          ].join('\n'),
          cwd: projectPath,
          model: process.env.CODEX_APP_SERVER_APPROVAL_LIVE_MODEL ?? 'gpt-5.3-codex',
          reasoningEffort: 'low',
          requestApproval: async approval => {
            approvals.push(`${approval.method}:${approval.toolName}`)
            return { allow: true }
          },
          idleTimeoutMs: 180_000,
          absoluteTimeoutMs: 240_000,
        }),
        260_000,
      )

      if (hasCodexUsageLimitWarning(observations)) {
        throw new Error('Codex app-server live approval smoke could not run: usage limit exceeded')
      }
      expect(approvals.some(approval => approval.includes('requestApproval:'))).toBe(true)
      expect(
        await readFile(path.join(projectPath, 'codex-approval-smoke.txt'), 'utf8'),
      ).toBe('codex-approval-smoke')
      expect(summary).toMatchObject({
        threadId: expect.any(String),
        finalHistoryCompleteness: 'explicit-hydration-required',
      })
    } finally {
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
