import { access, readFile } from 'fs/promises'
import { join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from './config.js'

export type GeminiAuthMethod =
  | 'api_key'
  | 'adc_authorized_user'
  | 'adc_service_account'

export type GeminiAuthResolution = {
  method: GeminiAuthMethod
  apiKey?: string
  accessToken?: string
  projectId?: string
  source: 'env' | 'adc'
}

export function getGeminiBaseUrl(): string {
  return (
    process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'
  )
}

export function getGeminiApiVersion(): string {
  return process.env.GEMINI_API_VERSION ?? 'v1'
}

export function getGeminiProjectId(): string | undefined {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GOOGLE_CLOUD_PROJECT_ID ??
    process.env.GCLOUD_PROJECT ??
    getGlobalConfig().geminiProjectId
  )
}

export function getGeminiCliCredentialPath(): string {
  return join(process.env.HOME ?? '~', '.gemini', 'oauth_creds.json')
}

export function getDefaultGoogleAdcPath(): string {
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? process.env.HOME ?? '~',
      'gcloud',
      'application_default_credentials.json',
    )
  }

  return join(
    process.env.HOME ?? '~',
    '.config',
    'gcloud',
    'application_default_credentials.json',
  )
}

export async function hasGeminiCliCredentials(): Promise<boolean> {
  try {
    await access(getGeminiCliCredentialPath())
    return true
  } catch {
    return false
  }
}

export async function hasGoogleAdcCredentials(): Promise<boolean> {
  try {
    await access(
      process.env.GOOGLE_APPLICATION_CREDENTIALS ?? getDefaultGoogleAdcPath(),
    )
    return true
  } catch {
    return false
  }
}

export async function resolveGeminiAuth(): Promise<GeminiAuthResolution | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (apiKey) {
    const projectId = getGeminiProjectId()
    persistGeminiAuth(projectId, 'api_key')
    return {
      method: 'api_key',
      apiKey,
      projectId,
      source: 'env',
    }
  }

  const [{ GoogleAuth }, credentialMetadata] = await Promise.all([
    import('google-auth-library'),
    readGoogleCredentialMetadata(),
  ])
  const projectId = getGeminiProjectId() ?? credentialMetadata.projectId
  if (!projectId) {
    return null
  }

  try {
    const auth = new GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/generative-language.retriever',
      ],
      projectId,
    })
    const client = await auth.getClient()
    const token = await client.getAccessToken()
    if (!token?.token) {
      return null
    }
    const method =
      credentialMetadata.type === 'service_account'
        ? 'adc_service_account'
        : 'adc_authorized_user'
    persistGeminiAuth(projectId, method)
    return {
      method,
      accessToken: token.token,
      projectId,
      source: 'adc',
    }
  } catch {
    return null
  }
}

async function readGoogleCredentialMetadata(): Promise<{
  type: 'authorized_user' | 'service_account'
  projectId?: string
}> {
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (credentialsPath) {
    try {
      const raw = await readFile(credentialsPath, 'utf8')
      const parsed = JSON.parse(raw) as { type?: string; project_id?: string }
      if (parsed.type === 'service_account') {
        return {
          type: 'service_account',
          projectId: parsed.project_id,
        }
      }
    } catch {
      // fall through
    }
  }
  return { type: 'authorized_user' }
}

function persistGeminiAuth(
  projectId: string | undefined,
  method: GeminiAuthMethod,
): void {
  saveGlobalConfig(current => ({
    ...current,
    geminiProjectId: projectId ?? current.geminiProjectId,
    geminiLastAuthMethod: method,
  }))
}

export async function validateGeminiAuth(): Promise<{
  ok: boolean
  auth?: GeminiAuthResolution
  message?: string
  hint?: string
}> {
  const auth = await resolveGeminiAuth()
  if (!auth) {
    const [hasCliCredentials, hasAdcCredentials] = await Promise.all([
      hasGeminiCliCredentials(),
      hasGoogleAdcCredentials(),
    ])
    if (hasAdcCredentials && !getGeminiProjectId()) {
      return {
        ok: false,
        message:
          'Google ADC credentials were detected, but Gemini OAuth requires GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_PROJECT_ID, or GCLOUD_PROJECT.',
      }
    }
    return {
      ok: false,
      message: 'Gemini is not configured. Set GEMINI_API_KEY or valid Google ADC credentials.',
      hint: hasCliCredentials
        ? 'Gemini CLI login was detected, but its token cannot be used as Gemini API runtime auth. Configure GEMINI_API_KEY or ADC instead.'
        : undefined,
    }
  }
  if (auth.method !== 'api_key' && !auth.projectId) {
    return {
      ok: false,
      message:
        'Gemini ADC auth requires GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_PROJECT_ID, or GCLOUD_PROJECT.',
    }
  }

  const url = `${getGeminiBaseUrl().replace(/\/$/, '')}/${getGeminiApiVersion()}/models`
  const headers: Record<string, string> = {}
  if (auth.method === 'api_key') {
    headers['x-goog-api-key'] = auth.apiKey!
  } else {
    headers.Authorization = `Bearer ${auth.accessToken}`
    headers['x-goog-user-project'] = auth.projectId!
  }

  try {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      const body = await response.text()
      return {
        ok: false,
        message: `Gemini auth validation failed (${response.status}): ${body}`,
      }
    }
    return { ok: true, auth }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
