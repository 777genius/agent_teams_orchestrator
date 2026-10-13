import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hashNativeBootstrapText,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
} from '../teamBootstrap/nativeAppManagedBootstrapContext.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import { buildCodexManualTurnStartParams, type CodexManualTurnStartParams } from './appServerApproval.js'
import type { CodexNativeExecObservation, CodexNativeExecSummary } from './execRunner.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

const originalContextPath = process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
const temporaryRoots: string[] = []

afterEach(async () => {
  if (originalContextPath === undefined) delete process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
  else process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV] = originalContextPath
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Codex native startup context transport', () => {
  test.each(['bypassPermissions', 'default'] as const)(
    'supplies trusted context to every fresh %s turn without replaying history or private proof',
    async permissionMode => {
      const root = await mkdtemp(join(tmpdir(), 'codex-startup-context-test-'))
      temporaryRoots.push(root)
      const filePath = join(root, 'context.json')
      const contextText = 'Canonical operating rules.\nDisplay library: Table(columns: Col[])'
      const context = {
        schemaVersion: 1,
        kind: 'native_app_managed_bootstrap',
        mode: 'startup_context_file',
        teamName: 'sandbox',
        memberName: 'visualizer',
        agentId: 'visualizer@sandbox',
        runId: 'run-sandbox',
        provider: 'codex',
        contextText,
        contextHash: hashNativeBootstrapText(contextText),
        briefingHash: hashNativeBootstrapText('briefing'),
        bootstrapProofToken: 'private-proof-must-not-enter-model-input',
        generatedAt: '2026-10-13T00:00:00.000Z',
      }
      await writeFile(filePath, JSON.stringify(context))
      process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV] = filePath
      const prompts: string[] = []
      const inputs: CodexManualTurnStartParams['input'][] = []
      const images: (string[] | undefined)[] = []
      const capture = async function* (
        options: { prompt: string; input?: CodexManualTurnStartParams['input']; imagePaths?: string[] },
      ): AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown> {
        prompts.push(options.prompt)
        images.push(options.imagePaths)
        if (permissionMode === 'default') {
          inputs.push(buildCodexManualTurnStartParams({ threadId: 'fresh-thread', ...options }).input)
        }
        yield { type: 'normalized_event', event: { type: 'assistant_text', itemId: 'answer', text: 'OK' } }
        yield { type: 'normalized_event', event: { type: 'turn_completed' } }
        return {
          identity: { executablePath: '/test/codex', executableSource: 'system-path', version: 'test' },
          threadId: 'fresh-thread',
          credentialSource: 'none',
          completionPolicy: 'ephemeral',
          finalHistoryCompleteness: 'live-only',
          finalUsageAuthority: 'live-turn-completed',
        }
      }
      const execute = async (prompt: Parameters<typeof executeCodexNativeTurn>[0]['prompt']) => {
        const messages = []
        for await (const message of executeCodexNativeTurn({
          prompt,
          cwd: root,
          model: 'gpt-6.1-sol',
          effortValue: undefined,
          permissionMode,
          additionalWritableDirectories: [],
          persistSession: false,
          replayedUserMessages: [],
          transcriptMessages: [{ type: 'user', message: { content: 'UNRELATED_HISTORY' } }] as never,
          mutableMessages: [],
          totalUsage: { ...EMPTY_USAGE },
          permissionDenials: [],
          initialAppState: { fastMode: false } as never,
          startTime: Date.now(),
        }, {
          runExec: capture,
          runAppServer: capture,
          buildUserLoopbackProviderConfigOverrides: () => [],
        })) messages.push(message)
        return messages
      }
      const turns = [
        '<agent_teams_native_app_managed_bootstrap_check>Confirm startup.</agent_teams_native_app_managed_bootstrap_check>',
        'Process this queued mailbox message now. Direct user question.',
        'Process this queued GROUP CHAT message. Generate a display in the originating group.',
      ]
      for (const prompt of turns) await execute(prompt)
      expect(prompts).toEqual(turns.map(prompt => `${contextText}\n\n${prompt}`))
      for (const prompt of prompts) {
        expect(prompt).not.toContain(context.bootstrapProofToken)
        expect(prompt).not.toContain('<agent_teams_native_bootstrap_control>')
        expect(prompt).not.toContain('Startup context loaded.')
        expect(prompt).not.toContain('UNRELATED_HISTORY')
      }
      const imagePath = join(root, 'attached.png')
      const attachmentBlocks = [
        { type: 'text', text: 'Group request\n' },
        { type: 'image', source: { type: 'file', path: imagePath } },
        { type: 'text', text: 'Attached file: note.txt\n\nПривіт 世界\n' },
      ] as never
      const attachmentInput: CodexManualTurnStartParams['input'] = [
        { type: 'text', text: 'Group request\n', text_elements: [] },
        { type: 'localImage', path: imagePath },
        { type: 'text', text: 'Attached file: note.txt\n\nПривіт 世界\n', text_elements: [] },
      ]
      await execute(attachmentBlocks)
      expect(images.at(-1)).toEqual([imagePath])
      expect(prompts.at(-1)).toBe(`${contextText}\n\nGroup request\n\nAttached file: note.txt\n\nПривіт 世界`)
      if (permissionMode === 'default') {
        expect(inputs.at(-1)).toEqual([
          { type: 'text', text: contextText, text_elements: [] },
          ...attachmentInput,
        ])
      }
      delete process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
      await execute('Unbound ordinary prompt')
      expect(prompts.at(-1)).toBe('Unbound ordinary prompt')
      await execute(attachmentBlocks)
      if (permissionMode === 'default') expect(inputs.at(-1)).toEqual(attachmentInput)
      expect(JSON.stringify(inputs)).not.toContain(context.bootstrapProofToken)
      process.env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV] = filePath
      await writeFile(filePath, JSON.stringify({ ...context, contextText: 'tampered context' }))
      const messages = await execute('Must not launch with unverified context')
      expect(prompts).toHaveLength(6)
      expect(JSON.stringify(messages)).toContain('context hash mismatch')
    },
  )
})
