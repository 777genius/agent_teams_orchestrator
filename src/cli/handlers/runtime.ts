/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  getUnifiedRuntimeStatusPayload,
} from '../../services/runtimeBackends/registry.js'
import type {
  RuntimeProviderId,
  RuntimeProviderStatus,
} from '../../services/runtimeBackends/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type RuntimeProviderTarget = RuntimeProviderId | 'all'

function formatValue(value: string | null | undefined, fallback = 'none'): string {
  return value && value.length > 0 ? value : fallback
}

function printProviderStatus(provider: RuntimeProviderStatus): void {
  process.stdout.write(`${provider.displayName}:\n`)
  process.stdout.write(`  authenticated: ${provider.authenticated ? 'yes' : 'no'}\n`)
  process.stdout.write(`  auth method: ${formatValue(provider.authMethod)}\n`)
  process.stdout.write(`  verification: ${provider.verificationState}\n`)
  process.stdout.write(`  selected backend: ${formatValue(provider.selectedBackendId)}\n`)
  process.stdout.write(`  resolved backend: ${formatValue(provider.resolvedBackendId)}\n`)
  process.stdout.write(`  status: ${formatValue(provider.statusMessage)}\n`)
  if (provider.detailMessage) {
    process.stdout.write(`  detail: ${provider.detailMessage}\n`)
  }
  if (provider.backend) {
    process.stdout.write(`  runtime: ${provider.backend.label}\n`)
    if (provider.backend.endpointLabel) {
      process.stdout.write(`  endpoint: ${provider.backend.endpointLabel}\n`)
    }
    if (provider.backend.projectId) {
      process.stdout.write(`  project: ${provider.backend.projectId}\n`)
    }
  }
  if (provider.availableBackends.length > 0) {
    process.stdout.write('  backends:\n')
    for (const backend of provider.availableBackends) {
      process.stdout.write(
        `    - ${backend.id}: ${backend.available ? 'ready' : 'unavailable'}${backend.recommended ? ' [recommended]' : ''}\n`,
      )
    }
  }
  if (provider.externalRuntimeDiagnostics.length > 0) {
    process.stdout.write('  diagnostics:\n')
    for (const diagnostic of provider.externalRuntimeDiagnostics) {
      process.stdout.write(
        `    - ${diagnostic.label}: ${diagnostic.detected ? 'detected' : 'missing'}\n`,
      )
    }
  }
  if (provider.models.length > 0) {
    process.stdout.write(`  models: ${provider.models.join(', ')}\n`)
  }
}

export async function runtimeStatus(opts: {
  json?: boolean
  text?: boolean
  provider?: RuntimeProviderTarget
}): Promise<void> {
  const providerFilter =
    opts.provider && opts.provider !== 'all' ? opts.provider : undefined
  const payload = await getUnifiedRuntimeStatusPayload(providerFilter)

  if (opts.text) {
    const providerOrder: RuntimeProviderId[] = ['anthropic', 'codex', 'gemini']
    for (const providerId of providerOrder) {
      const provider = payload.providers[providerId]
      if (!provider) continue
      printProviderStatus(provider)
    }
  } else {
    process.stdout.write(jsonStringify(payload, null, 2) + '\n')
  }

  process.exit(0)
}
