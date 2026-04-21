import { createHash } from 'node:crypto'

import type {
  CodexNativeExecObservation,
  CodexNativeExecRunnerOptions,
  CodexNativeExecSummary,
} from './execRunner.js'
import { runCodexNativeExec } from './execRunner.js'
import { CodexNativeTranscriptProjector } from './transcriptProjector.js'
import { CODEX_NATIVE_PHASE0_EXEC_CAPABILITY_PROFILE } from './capabilities.js'
import {
  createCodexNativeExecutionSummaryMessage,
  createCodexNativeThreadStatusMessage,
} from './statusAuthority.js'

type RunExecFn = (
  options: CodexNativeExecRunnerOptions,
) => AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown>

export type CodexNativePhase0SignOffHarnessOptions = {
  cwd: string
  prompt: string
  model?: string | null
  reasoningEffort?: CodexNativeExecRunnerOptions['reasoningEffort']
  sandboxMode?: CodexNativeExecRunnerOptions['sandboxMode']
  additionalWritableDirectories?: string[]
  ephemeral?: boolean
  apiKey?: string | null
}

export type CodexNativePhase0ProjectedMessageEvidence =
  | {
      type: 'assistant'
      text: string
      usage?: {
        inputTokens: number
        cachedInputTokens: number
        outputTokens: number
      }
    }
  | {
      type: 'system'
      level?: string
      subtype?: string
      content?: string
      codexNativeWarningSource?: string
      codexNativeThreadStatus?: string
      codexNativeThreadId?: string
      codexNativeCompletionPolicy?: string
      codexNativeHistoryCompleteness?: string
      codexNativeFinalUsageAuthority?: string
      codexNativeExecutableSource?: string
      codexNativeExecutableVersion?: string | null
    }

export type CodexNativePhase0SignOffEvidence = {
  schemaVersion: 1
  capturedAt: string
  command: {
    cwd: string
    ephemeral: boolean
    model: string | null
    reasoningEffort: string | null
    sandboxMode: string | null
    additionalWritableDirectories: string[]
    promptSha256: string
  }
  capabilityProfile: typeof CODEX_NATIVE_PHASE0_EXEC_CAPABILITY_PROFILE
  apiKeyInputSource: 'CODEX_API_KEY' | 'OPENAI_API_KEY' | 'explicit' | 'none'
  summary: CodexNativeExecSummary
  normalizedEventTypes: string[]
  projectedMessages: CodexNativePhase0ProjectedMessageEvidence[]
  finalAssistantText: string | null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function summarizeProjectedMessages(
  messages: readonly unknown[],
): CodexNativePhase0ProjectedMessageEvidence[] {
  return messages.flatMap(message => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'assistant'
    ) {
      const assistantMessage = message as {
        type: 'assistant'
        message: {
          content: Array<{ type: string; text?: string }>
          usage?: {
            input_tokens: number
            cache_read_input_tokens?: number
            output_tokens: number
          }
        }
      }
      const text =
        assistantMessage.message.content.find(block => block.type === 'text')
          ?.text ?? ''
      return [
        {
          type: 'assistant',
          text,
          usage: assistantMessage.message.usage
            ? {
                inputTokens: assistantMessage.message.usage.input_tokens,
                cachedInputTokens:
                  assistantMessage.message.usage.cache_read_input_tokens ?? 0,
                outputTokens: assistantMessage.message.usage.output_tokens,
              }
            : undefined,
        },
      ]
    }

    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'system'
    ) {
      const systemMessage = message as {
        type: 'system'
        level?: string
        subtype?: string
        content?: string
        codexNativeWarningSource?: string
        codexNativeThreadStatus?: string
        codexNativeThreadId?: string
        codexNativeCompletionPolicy?: string
        codexNativeHistoryCompleteness?: string
        codexNativeFinalUsageAuthority?: string
        codexNativeExecutableSource?: string
        codexNativeExecutableVersion?: string | null
      }
      return [
        {
          type: 'system',
          level: systemMessage.level,
          subtype: systemMessage.subtype,
          content: systemMessage.content,
          codexNativeWarningSource: systemMessage.codexNativeWarningSource,
          codexNativeThreadStatus: systemMessage.codexNativeThreadStatus,
          codexNativeThreadId: systemMessage.codexNativeThreadId,
          codexNativeCompletionPolicy:
            systemMessage.codexNativeCompletionPolicy,
          codexNativeHistoryCompleteness:
            systemMessage.codexNativeHistoryCompleteness,
          codexNativeFinalUsageAuthority:
            systemMessage.codexNativeFinalUsageAuthority,
          codexNativeExecutableSource:
            systemMessage.codexNativeExecutableSource,
          codexNativeExecutableVersion:
            systemMessage.codexNativeExecutableVersion,
        },
      ]
    }

    return []
  })
}

export async function runCodexNativePhase0SignOffHarness(
  options: CodexNativePhase0SignOffHarnessOptions,
  deps: {
    runExec?: RunExecFn
  } = {},
): Promise<CodexNativePhase0SignOffEvidence> {
  const runExec = deps.runExec ?? runCodexNativeExec
  const projector = new CodexNativeTranscriptProjector()
  const normalizedEventTypes: string[] = []
  const transcriptMessages: unknown[] = []

  const summary = await (async () => {
    const iterator = runExec({
      prompt: options.prompt,
      cwd: options.cwd,
      model: options.model ?? undefined,
      reasoningEffort: options.reasoningEffort ?? null,
      sandboxMode: options.sandboxMode ?? 'read-only',
      additionalWritableDirectories: options.additionalWritableDirectories ?? [],
      ephemeral: options.ephemeral,
      apiKey: options.apiKey ?? undefined,
    })

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        return next.value
      }
      if (next.value.type !== 'normalized_event') {
        continue
      }
      normalizedEventTypes.push(next.value.event.type)
      const projection = projector.apply(next.value.event)
      transcriptMessages.push(...projection.appendedMessages)
    }
  })()

  const executionSummaryMessage = createCodexNativeExecutionSummaryMessage({
    identity: summary.identity,
    threadId: summary.threadId,
    completionPolicy: summary.completionPolicy,
    finalHistoryCompleteness: summary.finalHistoryCompleteness,
    finalUsageAuthority: summary.finalUsageAuthority,
  })
  if (executionSummaryMessage) {
    transcriptMessages.push(executionSummaryMessage)
  }
  if (summary.threadId) {
    transcriptMessages.push(
      createCodexNativeThreadStatusMessage({
        status: 'completed',
        threadId: summary.threadId,
      }),
    )
  }

  const finalAssistantText =
    projector
      .getLastAssistantMessage()
      ?.message.content.find(block => block.type === 'text')?.text ?? null

  const apiKeyInputSource = options.apiKey
    ? process.env.CODEX_API_KEY && options.apiKey === process.env.CODEX_API_KEY
      ? 'CODEX_API_KEY'
      : process.env.OPENAI_API_KEY && options.apiKey === process.env.OPENAI_API_KEY
        ? 'OPENAI_API_KEY'
        : 'explicit'
    : 'none'

  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    command: {
      cwd: options.cwd,
      ephemeral: options.ephemeral !== false,
      model: options.model ?? null,
      reasoningEffort: options.reasoningEffort ?? null,
      sandboxMode: options.sandboxMode ?? 'read-only',
      additionalWritableDirectories: options.additionalWritableDirectories ?? [],
      promptSha256: sha256(options.prompt),
    },
    capabilityProfile: CODEX_NATIVE_PHASE0_EXEC_CAPABILITY_PROFILE,
    apiKeyInputSource,
    summary,
    normalizedEventTypes,
    projectedMessages: summarizeProjectedMessages(transcriptMessages),
    finalAssistantText,
  }
}
