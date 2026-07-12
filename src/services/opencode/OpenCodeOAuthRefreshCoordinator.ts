import {
  readOpenCodeAuthCredential,
  withOpenCodeOAuthRefreshLock,
} from './OpenCodeAuthStore.js'
import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'

import type { OpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import type { OpenCodePreparedProfile } from './types.js'

const XAI_PROVIDER_ID = 'xai'
const XAI_OAUTH_REFRESH_SKEW_MS = 120_000

type OpenCodeOAuthRefreshCoordinatorDeps = {
  readCredential?: typeof readOpenCodeAuthCredential
  withRefreshLock?: typeof withOpenCodeOAuthRefreshLock
  probeModel?: typeof openCodeExecutionProbe.probeModel
  nowMs?: () => number
  refreshSkewMs?: number
}

export type OpenCodeOAuthRefreshResult = {
  checked: boolean
  refreshed: boolean
}

function parseProviderId(selectedModel: string): string | null {
  const separatorIndex = selectedModel.indexOf('/')
  return separatorIndex > 0 ? selectedModel.slice(0, separatorIndex).trim().toLowerCase() : null
}

function readJwtExpiryMs(accessToken: unknown): number | null {
  if (typeof accessToken !== 'string') {
    return null
  }
  const parts = accessToken.split('.')
  if (parts.length < 2) {
    return null
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1_000
      : null
  } catch {
    return null
  }
}

export function isOpenCodeOAuthCredentialExpiring(input: {
  credential: OpenCodeAuthCredential | null
  nowMs: number
  skewMs?: number
}): boolean {
  const { credential } = input
  if (credential?.type !== 'oauth') {
    return false
  }

  const storedExpiryMs = typeof credential.expires === 'number'
    && Number.isFinite(credential.expires)
    ? credential.expires
    : null
  const jwtExpiryMs = readJwtExpiryMs(credential.access)
  const expiryMs = storedExpiryMs === null
    ? jwtExpiryMs
    : jwtExpiryMs === null
      ? storedExpiryMs
      : Math.min(storedExpiryMs, jwtExpiryMs)

  return expiryMs === null
    || expiryMs <= input.nowMs + Math.max(0, input.skewMs ?? XAI_OAUTH_REFRESH_SKEW_MS)
}

export class OpenCodeOAuthRefreshCoordinator {
  constructor(private readonly deps: OpenCodeOAuthRefreshCoordinatorDeps = {}) {}

  async ensureFreshForPrompt(input: {
    selectedModel: string
    projectPath: string
    profile: OpenCodePreparedProfile
  }): Promise<OpenCodeOAuthRefreshResult> {
    if (parseProviderId(input.selectedModel) !== XAI_PROVIDER_ID) {
      return { checked: false, refreshed: false }
    }

    const readCredential = this.deps.readCredential ?? readOpenCodeAuthCredential
    const nowMs = this.deps.nowMs ?? Date.now
    const refreshSkewMs = this.deps.refreshSkewMs ?? XAI_OAUTH_REFRESH_SKEW_MS
    const credential = await readCredential({
      authPath: input.profile.managedAuthPath,
      providerId: XAI_PROVIDER_ID,
    })
    if (credential?.type !== 'oauth') {
      return { checked: false, refreshed: false }
    }
    if (!isOpenCodeOAuthCredentialExpiring({ credential, nowMs: nowMs(), skewMs: refreshSkewMs })) {
      return { checked: true, refreshed: false }
    }

    const withRefreshLock = this.deps.withRefreshLock ?? withOpenCodeOAuthRefreshLock
    return withRefreshLock({
      authPath: input.profile.managedAuthPath,
      providerId: XAI_PROVIDER_ID,
      operation: async () => {
        const latestCredential = await readCredential({
          authPath: input.profile.managedAuthPath,
          providerId: XAI_PROVIDER_ID,
        })
        if (!isOpenCodeOAuthCredentialExpiring({
          credential: latestCredential,
          nowMs: nowMs(),
          skewMs: refreshSkewMs,
        })) {
          return { checked: true, refreshed: true }
        }

        const probeModel = this.deps.probeModel
          ?? openCodeExecutionProbe.probeModel.bind(openCodeExecutionProbe)
        const probe = await probeModel({
          selectedModel: input.selectedModel,
          projectPath: input.projectPath,
          bypassCache: true,
        })
        if (probe.outcome !== 'available') {
          throw new Error(
            `SuperGrok OAuth refresh failed before prompt: ${probe.reason || probe.outcome}`,
          )
        }

        const refreshedCredential = await readCredential({
          authPath: input.profile.managedAuthPath,
          providerId: XAI_PROVIDER_ID,
        })
        if (isOpenCodeOAuthCredentialExpiring({
          credential: refreshedCredential,
          nowMs: nowMs(),
          skewMs: refreshSkewMs,
        })) {
          throw new Error(
            'SuperGrok OAuth refreshed, but the rotated credential was not persisted. Reconnect SuperGrok before continuing.',
          )
        }

        return { checked: true, refreshed: true }
      },
    })
  }
}

export const openCodeOAuthRefreshCoordinator = new OpenCodeOAuthRefreshCoordinator()
