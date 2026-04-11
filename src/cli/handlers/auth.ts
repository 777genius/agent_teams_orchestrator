/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { stdin as input, stdout as output } from 'process'
import { createInterface } from 'readline/promises'

import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { OAuthService } from '../../services/oauth/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  clearCodexOAuthTokens,
  clearOfficialCodexCliOAuthTokens,
  clearOAuthTokenCache,
  getGeminiAuthMethod,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isUsing3PServices,
  saveCodexOAuthTokens,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
} from '../../utils/status.js'
import {
  getGeminiBackendPreference,
  resolveGeminiBackend,
} from '../../services/gemini/backendResolver.js'
import { resolveCodexRuntimeSelection } from '../../services/runtimeBackends/codexBackendResolver.js'
import { runCodexOAuthFlow } from '../../services/oauth/codex-client.js'

type AuthProviderTarget = 'anthropic' | 'codex' | 'all'

export type ProviderStatusPayload = {
  supported: boolean
  authenticated: boolean
  authMethod: string | null
  verificationState: 'verified' | 'unknown' | 'offline' | 'error'
  canLoginFromUi: boolean
  capabilities: {
    teamLaunch: boolean
    oneShot: boolean
  }
  statusMessage?: string | null
}

export function getAnthropicProviderStatus(): ProviderStatusPayload {
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()

  const authenticated = hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar
  let authMethod: string | null = null

  if (authTokenSource === 'claude.ai') {
    authMethod = 'claude.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'ANTHROPIC_API_KEY' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'claude.ai'
  }

  return {
    supported: true,
    authenticated,
    authMethod,
    verificationState: 'verified',
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
  }
}

export function getCodexProviderStatus(): ProviderStatusPayload {
  const resolution = resolveCodexRuntimeSelection()

  return {
    supported: true,
    authenticated: resolution.authenticated,
    authMethod: resolution.authMethod,
    verificationState: resolution.authenticated ? 'verified' : 'unknown',
    canLoginFromUi: resolution.canLoginFromUi,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    statusMessage: resolution.statusMessage,
  }
}

export function getAllProviderStatuses(): Record<'anthropic' | 'codex', ProviderStatusPayload> {
  return {
    anthropic: getAnthropicProviderStatus(),
    codex: getCodexProviderStatus(),
  }
}

async function promptForCodexManualInput(): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    return await rl.question(
      'Paste the full redirect URL (or just the authorization code) if the browser callback does not complete automatically:\n',
    )
  } finally {
    rl.close()
  }
}

async function authLoginCodex(): Promise<void> {
  try {
    const codexTokens = await runCodexOAuthFlow(
      async url => {
        process.stdout.write('Opening browser to sign in to Codex...\n')
        process.stdout.write(`If the browser did not open, visit: ${url}\n`)
      },
      async () => promptForCodexManualInput(),
    )
    saveCodexOAuthTokens(codexTokens)
    process.stdout.write('Codex login successful.\n')
    process.exit(0)
  } catch (err) {
    logError(err)
    process.stderr.write(`Codex login failed: ${errorMessage(err)}\n`)
    process.exit(1)
  }
}

function clearLegacyOpenAIOAuthTokens(): void {
  saveGlobalConfig(cfg => {
    const { openaiOauthTokens: _legacyTokens, ...rest } = cfg
    return rest as typeof cfg
  })
}

/**
 * Returns true if the token carries any Anthropic-issued scope (user:* or org:*).
 * Codex tokens use OpenID Connect scopes (openid, profile, email, offline_access)
 * which are not Anthropic scopes, so this returns false for them.
 */
function hasAnyAnthropicScope(scopes: string[] | undefined): boolean {
  if (!scopes?.length) return false
  return scopes.some((s) => s.startsWith('user:') || s.startsWith('org:'))
}

/**
 * Shared post-token-acquisition logic. Saves tokens, fetches profile/roles,
 * and sets up the local auth state.
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // Clear old state before saving new credentials
  await performLogout({ clearOnboarding: false })

  // Reuse pre-fetched profile if available, otherwise fetch fresh
  const profile =
    tokens.profile ?? (await getOauthProfileFromOauthToken(tokens.accessToken))
  if (profile) {
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt:
        profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if (tokens.tokenAccount) {
    // Fallback to token exchange account data when profile endpoint fails
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      organizationUuid: tokens.tokenAccount.organizationUuid,
    })
  }

  const storageResult = saveOAuthTokensIfNeeded(tokens)
  clearOAuthTokenCache()

  if (storageResult.warning) {
    logEvent('tengu_oauth_storage_warning', {
      warning:
        storageResult.warning as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // Roles and first-token-date may fail for limited-scope tokens (e.g.
  // inference-only from setup-token). They're not required for core auth.
  await fetchAndStoreUserRoles(tokens.accessToken).catch(err =>
    logForDebugging(String(err), { level: 'error' }),
  )

  if (shouldUseClaudeAIAuth(tokens.scopes)) {
    await fetchAndStoreClaudeCodeFirstTokenDate().catch(err =>
      logForDebugging(String(err), { level: 'error' }),
    )
  } else if (hasAnyAnthropicScope(tokens.scopes)) {
    // API key creation is critical for Console users — let it throw.
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'Unable to create API key. The server accepted the request but did not return a key.',
      )
    }
  } else {
    // Third-party provider (e.g. OpenAI Codex) — tokens carry no Anthropic
    // scopes. Skip Anthropic API key creation entirely and store the tokens
    // in their own dedicated config slot.
    saveCodexOAuthTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt ?? Date.now() + 3600_000,
      accountId: (tokens.tokenAccount?.uuid ?? ''),
    })
  }

  await clearAuthRelatedCaches()
}

export async function authLogin({
  email,
  sso,
  console: useConsole,
  claudeai,
  provider,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  claudeai?: boolean
  provider?: AuthProviderTarget
}): Promise<void> {
  if (provider === 'codex') {
    await authLoginCodex()
    return
  }

  if (provider === 'all') {
    process.stderr.write("Error: '--provider all' is not valid for auth login.\n")
    process.exit(1)
  }

  if (provider !== 'anthropic' && getAPIProvider() === 'gemini') {
    const resolution = await resolveGeminiBackend()
    if (resolution.backend) {
      process.stdout.write(
        `Gemini authentication is configured correctly.\nBackend: gemini-${resolution.backend.kind}\n`,
      )
      process.exit(0)
    }
    process.stderr.write(
      `Gemini setup required: ${resolution.status.message ?? 'Gemini is not configured correctly.'}\n`,
    )
    if (resolution.status.hint) {
      process.stderr.write(`${resolution.status.hint}\n`)
    }
    if (getGeminiBackendPreference() !== 'cli') {
      process.stderr.write(
        "For OAuth/ADC, run: gcloud auth application-default login --client-id-file=client_secret.json --scopes='https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/generative-language.retriever'\n",
      )
      process.stderr.write(
        'Then set GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_PROJECT_ID, or GCLOUD_PROJECT to your billed Google Cloud project.\n',
      )
    }
    if (getGeminiBackendPreference() !== 'api') {
      process.stderr.write(
        'For Gemini CLI backend, sign in with the installed `gemini` CLI first or force CLAUDE_CODE_GEMINI_BACKEND=api.\n',
      )
    }
    process.exit(1)
  }

  if (useConsole && claudeai) {
    process.stderr.write(
      'Error: --console and --claudeai cannot be used together.\n',
    )
    process.exit(1)
  }

  const settings = getInitialSettings()
  // forceLoginMethod is a hard constraint (enterprise setting) — matches ConsoleOAuthFlow behavior.
  // Without it, --console selects Console; --claudeai (or no flag) selects claude.ai.
  const loginWithClaudeAi = settings.forceLoginMethod
    ? settings.forceLoginMethod === 'claudeai'
    : !useConsole
  const orgUUID = settings.forceLoginOrgUUID

  // Fast path: if a refresh token is provided via env var, skip the browser
  // OAuth flow and exchange it directly for tokens.
  const envRefreshToken = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const envScopes = process.env.CLAUDE_CODE_OAUTH_SCOPES
    if (!envScopes) {
      process.stderr.write(
        'CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n' +
          'Set it to the space-separated scopes the refresh token was issued with\n' +
          '(e.g. "user:inference" or "user:profile user:inference user:sessions:claude_code user:mcp_servers").\n',
      )
      process.exit(1)
    }

    const scopes = envScopes.split(/\s+/).filter(Boolean)

    try {
      logEvent('tengu_login_from_refresh_token', {})

      const tokens = await refreshOAuthToken(envRefreshToken, { scopes })
      await installOAuthTokens(tokens)

      const orgResult = await validateForceLoginOrg()
      if (!orgResult.valid) {
        process.stderr.write(orgResult.message + '\n')
        process.exit(1)
      }

      // Mark onboarding complete — interactive paths handle this via
      // the Onboarding component, but the env var path skips it.
      saveGlobalConfig(current => {
        if (current.hasCompletedOnboarding) return current
        return { ...current, hasCompletedOnboarding: true }
      })

      logEvent('tengu_oauth_success', {
        loginWithClaudeAi: shouldUseClaudeAIAuth(tokens.scopes),
      })
      process.stdout.write('Login successful.\n')
      process.exit(0)
    } catch (err) {
      logError(err)
      const sslHint = getSSLErrorHint(err)
      process.stderr.write(
        `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
      )
      process.exit(1)
    }
  }

  const resolvedLoginMethod = sso ? 'sso' : undefined

  const oauthService = new OAuthService()

  try {
    logEvent('tengu_oauth_flow_start', { loginWithClaudeAi })

    const result = await oauthService.startOAuthFlow(
      async url => {
        process.stdout.write('Opening browser to sign in…\n')
        process.stdout.write(`If the browser didn't open, visit: ${url}\n`)
      },
      {
        loginWithClaudeAi,
        loginHint: email,
        loginMethod: resolvedLoginMethod,
        orgUUID,
      },
    )

    await installOAuthTokens(result)

    const orgResult = await validateForceLoginOrg()
    if (!orgResult.valid) {
      process.stderr.write(orgResult.message + '\n')
      process.exit(1)
    }

    logEvent('tengu_oauth_success', { loginWithClaudeAi })

    process.stdout.write('Login successful.\n')
    process.exit(0)
  } catch (err) {
    logError(err)
    const sslHint = getSSLErrorHint(err)
    process.stderr.write(
      `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
    )
    process.exit(1)
  } finally {
    oauthService.cleanup()
  }
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
  provider?: AuthProviderTarget
}): Promise<void> {
  if (opts.provider === 'all') {
    const output = {
      schemaVersion: 1,
      providers: getAllProviderStatuses(),
    }
    if (opts.text) {
      for (const [providerId, status] of Object.entries(output.providers)) {
        process.stdout.write(
          `${providerId}: ${status.authenticated ? 'authenticated' : 'not_authenticated'}\n`,
        )
      }
    } else {
      process.stdout.write(jsonStringify(output, null, 2) + '\n')
    }
    process.exit(0)
  }

  if (opts.provider === 'anthropic') {
    const status = getAnthropicProviderStatus()
    const output = {
      schemaVersion: 1,
      provider: 'anthropic',
      status,
    }
    process.stdout.write(jsonStringify(output, null, 2) + '\n')
    process.exit(0)
  }

  if (opts.provider === 'codex') {
    const status = getCodexProviderStatus()
    const output = {
      schemaVersion: 1,
      provider: 'codex',
      status,
    }
    process.stdout.write(jsonStringify(output, null, 2) + '\n')
    process.exit(0)
  }

  if (getAPIProvider() === 'gemini') {
    const resolution = await resolveGeminiBackend()
    const loggedIn = Boolean(resolution.backend)
    const authMethod = loggedIn ? await getGeminiAuthMethod() : 'none'
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider: 'gemini',
      backend: resolution.backend ? `gemini-${resolution.backend.kind}` : null,
      apiKeySource: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : null,
      projectId: resolution.status.projectId ?? null,
      endpoint: resolution.status.endpointLabel,
      baseURL:
        resolution.backend?.kind === 'cli'
          ? null
          : process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com',
      apiVersion:
        resolution.backend?.kind === 'cli'
          ? null
          : process.env.GEMINI_API_VERSION ?? 'v1',
    }
    if (opts.text) {
      process.stdout.write('API provider: Google Gemini\n')
      if (output.backend) {
        process.stdout.write(`Backend: ${output.backend}\n`)
      }
      process.stdout.write(`Auth method: ${authMethod}\n`)
      if (output.projectId) {
        process.stdout.write(`Project ID: ${output.projectId}\n`)
      }
      process.stdout.write(`Endpoint: ${output.endpoint}\n`)
      if (resolution.backend?.kind !== 'cli') {
        process.stdout.write(`Base URL: ${output.baseURL}\n`)
        process.stdout.write(`API version: ${output.apiVersion}\n`)
      }
      if (!loggedIn) {
        process.stdout.write(
          `Not logged in. ${resolution.status.message ?? 'Configure Gemini auth.'}\n`,
        )
        if (resolution.status.hint) {
          process.stdout.write(`${resolution.status.hint}\n`)
        }
      }
    } else {
      process.stdout.write(jsonStringify(output, null, 2) + '\n')
    }
    process.exit(loggedIn ? 0 : 1)
  }

  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
  const oauthAccount = getOauthAccountInfo()
  const subscriptionType = getSubscriptionType()
  const using3P = isUsing3PServices()
  const loggedIn =
    hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar || using3P

  // Determine auth method
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (authTokenSource === 'claude.ai') {
    authMethod = 'claude.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'ANTHROPIC_API_KEY' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'claude.ai'
  }

  if (opts.text) {
    const properties = [
      ...buildAccountProperties(),
      ...buildAPIProviderProperties(),
    ]
    let hasAuthProperty = false
    for (const prop of properties) {
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    if (!hasAuthProperty && hasApiKeyEnvVar) {
      process.stdout.write('API key: ANTHROPIC_API_KEY\n')
    }
    if (!loggedIn) {
      process.stdout.write(
        'Not logged in. Run claude auth login to authenticate.\n',
      )
    }
  } else {
    const apiProvider = getAPIProvider()
    const resolvedApiKeySource =
      apiKeySource !== 'none'
        ? apiKeySource
        : hasApiKeyEnvVar
          ? 'ANTHROPIC_API_KEY'
          : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    if (authMethod === 'claude.ai') {
      output.email = oauthAccount?.emailAddress ?? null
      output.orgId = oauthAccount?.organizationUuid ?? null
      output.orgName = oauthAccount?.organizationName ?? null
      output.subscriptionType = subscriptionType ?? null
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  await authLogoutByProvider()
}

export async function authLogoutByProvider(
  provider?: AuthProviderTarget,
): Promise<void> {
  if (provider === 'codex') {
    clearCodexOAuthTokens()
    clearLegacyOpenAIOAuthTokens()
    await clearOfficialCodexCliOAuthTokens()
    process.stdout.write('Successfully logged out from Codex.\n')
    process.exit(0)
  }

  if (provider === 'all') {
    clearCodexOAuthTokens()
    clearLegacyOpenAIOAuthTokens()
    await clearOfficialCodexCliOAuthTokens()
  }

  try {
    if (!provider && getAPIProvider() === 'gemini') {
      saveGlobalConfig(current => ({
        ...current,
        geminiResolvedBackend: undefined,
        geminiLastAuthMethod: undefined,
        geminiProjectId: undefined,
      }))
      process.stdout.write(
        'Cleared local Gemini setup metadata. External Gemini CLI, Google ADC, and API key credentials were left untouched.\n',
      )
      process.exit(0)
    }
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('Failed to log out.\n')
    process.exit(1)
  }
  process.stdout.write(
    provider === 'all'
      ? 'Successfully logged out from Anthropic and Codex.\n'
      : 'Successfully logged out from your Anthropic account.\n',
  )
  process.exit(0)
}
