import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resolveGeminiAuth } from '../../utils/geminiAuth.js'
import { geminiApiBackend } from './backends/apiBackend.js'
import { geminiCliBackend } from './backends/cliBackend.js'
import {
  normalizeGeminiBackendPreference,
  normalizeGeminiBackendStorageValue,
} from '../runtimeBackends/registry.js'
import type {
  GeminiBackend,
  GeminiBackendKind,
  GeminiBackendStatus,
} from './types.js'

export type GeminiBackendPreference = 'auto' | 'api' | 'cli'

function saveGeminiResolvedRuntimeBackend(backend: 'auto' | 'api' | 'cli-sdk' | undefined): void {
  saveGlobalConfig(current => ({
    ...current,
    geminiResolvedBackend:
      backend && backend !== 'auto' ? normalizeGeminiBackendStorageValue(backend) : undefined,
  }))
}

export function getGeminiBackendPreference(): GeminiBackendPreference {
  const envPreference = normalizeGeminiBackendPreference(
    process.env.CLAUDE_CODE_GEMINI_BACKEND,
  )
  if (envPreference === 'api' || envPreference === 'cli-sdk' || envPreference === 'auto') {
    return envPreference === 'cli-sdk' ? 'cli' : envPreference
  }
  const savedPreference = getGlobalConfig().geminiBackendPreference
  return normalizeGeminiBackendStorageValue(savedPreference) ?? 'auto'
}

function getBackend(kind: GeminiBackendKind): GeminiBackend {
  return kind === 'cli' ? geminiCliBackend : geminiApiBackend
}

function withForcedMessage(
  status: GeminiBackendStatus,
  forcedBackend: GeminiBackendKind,
): GeminiBackendStatus {
  if (status.ok) {
    return status
  }
  const forcedName = forcedBackend === 'api' ? 'Gemini API backend' : 'Gemini CLI backend'
  return {
    ...status,
    message: status.message
      ? `${forcedName} is not ready. ${status.message}`
      : `${forcedName} is not ready.`,
  }
}

export async function resolveGeminiBackend(): Promise<{
  backend: GeminiBackend | null
  status: GeminiBackendStatus
  availableBackends: GeminiBackendStatus[]
}> {
  const preference = getGeminiBackendPreference()

  if (preference === 'api' || preference === 'cli') {
    const backend = getBackend(preference)
    const status = withForcedMessage(await backend.validate(), preference)
    saveGeminiResolvedRuntimeBackend(status.ok ? normalizeGeminiBackendPreference(preference) : undefined)
    return {
      backend: status.ok ? backend : null,
      status,
      availableBackends: [status],
    }
  }

  const apiStatus = (process.env.GEMINI_API_KEY || (await resolveGeminiAuth()))
    ? await geminiApiBackend.validate()
    : ({
        ok: false,
        backend: 'api',
        authMethod: 'none',
        endpointLabel: `${process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'}/${process.env.GEMINI_API_VERSION ?? 'v1'}`,
        message:
          'Gemini API authentication is not configured. Set GEMINI_API_KEY or valid Google ADC credentials.',
      } satisfies GeminiBackendStatus)

  if (apiStatus.ok) {
    saveGeminiResolvedRuntimeBackend('api')
    return {
      backend: geminiApiBackend,
      status: apiStatus,
      availableBackends: [apiStatus],
    }
  }

  if (process.env.GEMINI_API_KEY) {
    saveGeminiResolvedRuntimeBackend(undefined)
    return {
      backend: null,
      status: apiStatus,
      availableBackends: [apiStatus],
    }
  }

  const cliStatus = await geminiCliBackend.validate()

  if (cliStatus.ok) {
    saveGeminiResolvedRuntimeBackend('cli-sdk')
    return {
      backend: geminiCliBackend,
      status: cliStatus,
      availableBackends: [apiStatus, cliStatus],
    }
  }

  saveGeminiResolvedRuntimeBackend(undefined)
  return {
    backend: null,
    status: apiStatus.message ? apiStatus : cliStatus,
    availableBackends: [apiStatus, cliStatus],
  }
}
