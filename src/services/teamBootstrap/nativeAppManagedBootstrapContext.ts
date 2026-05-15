import { createHash, randomUUID } from 'crypto'
import { lstat, readFile } from 'fs/promises'
import { join } from 'path'

import { errorMessage } from '../../utils/errors.js'
import { logForDebugging } from '../../utils/debug.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { getTeamDir, sanitizeName } from '../../utils/swarm/teamHelpers.js'
import type { BootstrapProvider } from './teamBootstrapTypes.js'

export const NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV =
  'CLAUDE_CODE_NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_PATH'
export const NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_SOURCE =
  'native_app_managed_bootstrap_context_loaded'
export const NATIVE_APP_MANAGED_BOOTSTRAP_PROOF_SOURCE =
  'native_app_managed_bootstrap_private_turn'

const NATIVE_APP_MANAGED_BOOTSTRAP_MARKER =
  '<agent_teams_native_app_managed_bootstrap_check>'
const MAX_NATIVE_CONTEXT_FILE_BYTES = 96 * 1024

export type NativeAppManagedBootstrapSpec = {
  schemaVersion: 1
  mode: 'startup_context_file'
  contextText: string
  contextHash: string
  briefingHash: string
  generatedAt: string
}

export type NativeAppManagedBootstrapContextFile = NativeAppManagedBootstrapSpec & {
  kind: 'native_app_managed_bootstrap'
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  bootstrapProofToken: string
}

export type NativeAppManagedBootstrapContextInjection = {
  prefixMessagesText: string
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  contextHash: string
  briefingHash: string
  bootstrapProofToken: string
  generatedAt: string
}

export function isNativeAppManagedBootstrapProvider(
  provider?: BootstrapProvider,
): boolean {
  return provider === undefined || provider === 'anthropic' || provider === 'codex'
}

export function canonicalizeNativeBootstrapContextText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

export function hashNativeBootstrapText(input: string): string {
  return createHash('sha256')
    .update(canonicalizeNativeBootstrapContextText(input))
    .digest('hex')
}

export function isNativeAppManagedBootstrapInstructionText(text: string): boolean {
  return text.includes(NATIVE_APP_MANAGED_BOOTSTRAP_MARKER)
}

export function buildNativeAppManagedBootstrapPrivatePrompt(): string {
  return [
    NATIVE_APP_MANAGED_BOOTSTRAP_MARKER,
    'Your Agent Teams startup context was already loaded by the app.',
    'Do not call member_briefing for launch readiness.',
    'Do not send messages to the user, lead, or teammates.',
    'Reply only in this private local turn with a short acknowledgement that you received the startup context.',
    'Then stop and wait for real work.',
    '</agent_teams_native_app_managed_bootstrap_check>',
  ].join('\n')
}

export function buildNativeAppManagedBootstrapPrefixText(
  context: NativeAppManagedBootstrapContextFile,
): string {
  return canonicalizeNativeBootstrapContextText([
    '<agent_teams_native_bootstrap_control>',
    'System-level bootstrap rules:',
    '- This is a private startup check.',
    '- Do not send messages to user, lead, or teammates.',
    '- Do not call member_briefing for launch readiness.',
    '- Reply locally once, then stop.',
    '</agent_teams_native_bootstrap_control>',
    '',
    '<agent_teams_native_bootstrap_context_data>',
    context.contextText,
    '</agent_teams_native_bootstrap_context_data>',
  ].join('\n'))
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`native app-managed bootstrap context missing ${field}`)
  }
  return value.trim()
}

export async function readNativeAppManagedBootstrapContextFile(
  filePath: string,
): Promise<NativeAppManagedBootstrapContextFile> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('native app-managed bootstrap context must be a regular file')
  }
  if (stat.size > MAX_NATIVE_CONTEXT_FILE_BYTES) {
    throw new Error('native app-managed bootstrap context is too large')
  }

  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native app-managed bootstrap context must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'native_app_managed_bootstrap' ||
    record.mode !== 'startup_context_file'
  ) {
    throw new Error('native app-managed bootstrap context has unsupported schema')
  }

  const contextText = requireString(record, 'contextText')
  const contextHash = requireString(record, 'contextHash')
  const briefingHash = requireString(record, 'briefingHash')
  if (hashNativeBootstrapText(contextText) !== contextHash) {
    throw new Error('native app-managed bootstrap context hash mismatch')
  }

  const providerRaw = record.provider
  const provider =
    providerRaw === 'anthropic' || providerRaw === 'codex' || providerRaw === 'gemini'
      ? providerRaw
      : undefined
  if (!isNativeAppManagedBootstrapProvider(provider)) {
    throw new Error(`native app-managed bootstrap unsupported provider: ${String(providerRaw)}`)
  }

  return {
    schemaVersion: 1,
    kind: 'native_app_managed_bootstrap',
    mode: 'startup_context_file',
    teamName: requireString(record, 'teamName'),
    memberName: requireString(record, 'memberName'),
    agentId: requireString(record, 'agentId'),
    runId: requireString(record, 'runId'),
    ...(provider ? { provider } : {}),
    contextText,
    contextHash,
    briefingHash,
    generatedAt: requireString(record, 'generatedAt'),
    bootstrapProofToken: requireString(record, 'bootstrapProofToken'),
  }
}

export async function prepareNativeAppManagedBootstrapContextFile(params: {
  teamName: string
  memberName: string
  agentId: string
  runId: string
  provider?: BootstrapProvider
  bootstrapProofToken: string
  spec?: NativeAppManagedBootstrapSpec
}): Promise<Record<string, string>> {
  if (!params.spec || !isNativeAppManagedBootstrapProvider(params.provider)) {
    return {}
  }

  const context: NativeAppManagedBootstrapContextFile = {
    ...params.spec,
    kind: 'native_app_managed_bootstrap',
    teamName: params.teamName,
    memberName: params.memberName,
    agentId: params.agentId,
    runId: params.runId,
    ...(params.provider ? { provider: params.provider } : {}),
    bootstrapProofToken: params.bootstrapProofToken,
  }
  if (hashNativeBootstrapText(context.contextText) !== context.contextHash) {
    throw new Error(`Native app-managed bootstrap context hash mismatch for ${params.memberName}`)
  }

  const dir = join(getTeamDir(params.teamName), 'runtime', 'native-bootstrap')
  const finalPath = join(
    dir,
    `${sanitizeName(params.memberName)}-${randomUUID()}.native-bootstrap.json`,
  )
  await writeJsonFileAtomic(finalPath, context, { mode: 0o600 })
  return { [NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]: finalPath }
}

export async function loadNativeAppManagedBootstrapContextInjection(
  filePath: string,
): Promise<NativeAppManagedBootstrapContextInjection> {
  try {
    const context = await readNativeAppManagedBootstrapContextFile(filePath)
    return {
      prefixMessagesText: buildNativeAppManagedBootstrapPrefixText(context),
      teamName: context.teamName,
      memberName: context.memberName,
      agentId: context.agentId,
      runId: context.runId,
      ...(context.provider ? { provider: context.provider } : {}),
      contextHash: context.contextHash,
      briefingHash: context.briefingHash,
      bootstrapProofToken: context.bootstrapProofToken,
      generatedAt: context.generatedAt,
    }
  } catch (error) {
    logForDebugging(
      `[native-bootstrap] failed to load app-managed context: ${errorMessage(error)}`,
      { level: 'warn' },
    )
    throw error
  }
}
