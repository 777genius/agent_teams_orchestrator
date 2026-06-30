import { randomUUID } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'fs'
import { dirname, join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import type {
  AgentTeamsCapabilitiesRecord,
  AgentTeamsSessionRecord,
  AgentTeamsState,
} from './types.js'

export const AGENT_TEAMS_IDENTITY_STORE_PATH_ENV = 'AGENT_TEAMS_IDENTITY_STORE_PATH'

const IDENTITY_SCHEMA_VERSION = 1
const IDENTITY_DIR_MODE = 0o700
const IDENTITY_FILE_MODE = 0o600

let hydrated = false
let hydratedStoreKey: string | null = null
let cachedState: AgentTeamsState = {}
let cachedCreatedAt: string | null = null

function cloneState(state: AgentTeamsState | undefined): AgentTeamsState {
  if (!state) {
    return {}
  }
  return {
    clientId: state.clientId,
    session: state.session
      ? {
          ...state.session,
          subject: { ...state.session.subject },
        }
      : undefined,
    capabilities: state.capabilities
      ? {
          ...state.capabilities,
          claims: {
            ...state.capabilities.claims,
            features: { ...state.capabilities.claims.features },
            providers: { ...state.capabilities.claims.providers },
            models: { ...state.capabilities.claims.models },
            killswitches: { ...state.capabilities.claims.killswitches },
          },
        }
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function normalizeSession(value: unknown): AgentTeamsSessionRecord | undefined {
  const record = asRecord(value)
  const subject = asRecord(record?.subject)
  if (
    !record ||
    !subject ||
    typeof record.accessToken !== 'string' ||
    typeof record.refreshToken !== 'string' ||
    typeof record.accessExpiresAt !== 'number' ||
    typeof record.refreshExpiresAt !== 'number' ||
    typeof subject.id !== 'string' ||
    typeof subject.tier !== 'string'
  ) {
    return undefined
  }

  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    accessExpiresAt: record.accessExpiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
    subject: {
      id: subject.id,
      tier: subject.tier,
    },
  }
}

function normalizeCapabilities(
  value: unknown,
): AgentTeamsCapabilitiesRecord | undefined {
  const record = asRecord(value)
  const claims = asRecord(record?.claims)
  if (
    !record ||
    !claims ||
    typeof record.token !== 'string' ||
    record.tokenType !== 'JWT' ||
    typeof record.expiresAt !== 'number' ||
    typeof record.fetchedAt !== 'number' ||
    (record.integrity !== 'verified' && record.integrity !== 'transport') ||
    typeof claims.iss !== 'string' ||
    typeof claims.aud !== 'string' ||
    typeof claims.sub !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.jti !== 'string' ||
    typeof claims.tier !== 'string'
  ) {
    return undefined
  }

  const features = asRecord(claims.features)
  const providers = asRecord(claims.providers)
  const models = asRecord(claims.models)
  const killswitches = asRecord(claims.killswitches)

  return {
    token: record.token,
    tokenType: 'JWT',
    expiresAt: record.expiresAt,
    fetchedAt: record.fetchedAt,
    integrity: record.integrity,
    claims: {
      iss: claims.iss,
      aud: claims.aud,
      sub: claims.sub,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
      tier: claims.tier,
      features: (features ?? {}) as AgentTeamsCapabilitiesRecord['claims']['features'],
      providers: (providers ?? {}) as AgentTeamsCapabilitiesRecord['claims']['providers'],
      models: (models ?? {}) as AgentTeamsCapabilitiesRecord['claims']['models'],
      killswitches: (killswitches ?? {}) as AgentTeamsCapabilitiesRecord['claims']['killswitches'],
    },
  }
}

function normalizeState(value: unknown): AgentTeamsState {
  const record = asRecord(value)
  if (!record) {
    return {}
  }

  return {
    clientId: isValidClientId(record.clientId) ? record.clientId : undefined,
    session: normalizeSession(record.session),
    capabilities: normalizeCapabilities(record.capabilities),
  }
}

function getIdentityStorePath(): string | null {
  const raw = process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]
  if (!isNonEmptyString(raw)) {
    return null
  }
  return raw
}

function getStoreKey(): string {
  return getIdentityStorePath() ?? 'legacy-global-config'
}

function readJsonFileSync(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown
  } catch {
    return null
  }
}

function readAppDataState(storePath: string): {
  state: AgentTeamsState
  createdAt: string | null
  validStore: boolean
  fileExists: boolean
} {
  const fileExists = existsSync(storePath)
  const value = readJsonFileSync(storePath)
  const record = asRecord(value)
  if (!record || record.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    return {
      state: {},
      createdAt: null,
      validStore: false,
      fileExists,
    }
  }

  const state = normalizeState(record)
  if (!state.clientId) {
    return {
      state: {},
      createdAt: null,
      validStore: false,
      fileExists,
    }
  }

  return {
    state,
    createdAt: isNonEmptyString(record.createdAt) ? record.createdAt : null,
    validStore: true,
    fileExists,
  }
}

function hydrateFromAppData(storePath: string): void {
  const appData = readAppDataState(storePath)
  if (appData.validStore) {
    cachedState = cloneState(appData.state)
    cachedCreatedAt = appData.createdAt
    return
  }

  if (appData.fileExists) {
    cachedState = {}
    cachedCreatedAt = null
    return
  }

  cachedState = normalizeState(getGlobalConfig().agentTeams)
  cachedCreatedAt = null
  if (!isEmptyState(cachedState)) {
    writeAppDataState(storePath, cachedState)
  }
}

function ensureHydrated(): void {
  const storeKey = getStoreKey()
  if (hydrated && hydratedStoreKey === storeKey) {
    return
  }

  const storePath = getIdentityStorePath()
  if (storePath) {
    hydrateFromAppData(storePath)
  } else {
    cachedState = cloneState(getGlobalConfig().agentTeams)
    cachedCreatedAt = null
  }

  hydrated = true
  hydratedStoreKey = storeKey
}

function writeState(nextState: AgentTeamsState): void {
  const storePath = getIdentityStorePath()
  if (storePath) {
    const stateForWrite =
      !nextState.clientId && !isEmptyState(nextState)
        ? { ...nextState, clientId: randomUUID() }
        : nextState
    cachedState = cloneState(stateForWrite)
    writeAppDataState(storePath, stateForWrite)
    return
  }

  cachedState = cloneState(nextState)
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: isEmptyState(nextState) ? undefined : cloneState(nextState),
  }))
}

function isEmptyState(state: AgentTeamsState): boolean {
  return !state.clientId && !state.session && !state.capabilities
}

function writeAppDataState(storePath: string, state: AgentTeamsState): void {
  if (isEmptyState(state)) {
    rmSync(storePath, { force: true })
    cachedCreatedAt = null
    return
  }

  const now = new Date().toISOString()
  const record = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    clientId: state.clientId ?? randomUUID(),
    session: state.session,
    capabilities: state.capabilities,
    createdAt: cachedCreatedAt ?? now,
    updatedAt: now,
  }
  cachedCreatedAt = record.createdAt

  const dir = dirname(storePath)
  mkdirSync(dir, { recursive: true, mode: IDENTITY_DIR_MODE })
  try {
    chmodSync(dir, IDENTITY_DIR_MODE)
  } catch {
    // chmod is best-effort on platforms/filesystems that support it.
  }

  writeFileAtomicSync(storePath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: IDENTITY_FILE_MODE,
  })
  try {
    chmodSync(storePath, IDENTITY_FILE_MODE)
  } catch {
    // chmod is best-effort on platforms/filesystems that support it.
  }
}

export function getAgentTeamsState(): AgentTeamsState {
  ensureHydrated()
  return cloneState(cachedState)
}

export function ensureAgentTeamsClientId(): string {
  ensureHydrated()
  if (cachedState.clientId) {
    return cachedState.clientId
  }

  const nextState: AgentTeamsState = {
    ...cachedState,
    clientId: randomUUID(),
  }
  writeState(nextState)
  return nextState.clientId!
}

export function saveAgentTeamsSession(session: AgentTeamsSessionRecord): void {
  ensureHydrated()
  writeState({
    ...cachedState,
    session: {
      ...session,
      subject: { ...session.subject },
    },
  })
}

export function getStoredAgentTeamsSession(): AgentTeamsSessionRecord | null {
  ensureHydrated()
  return cachedState.session
    ? {
        ...cachedState.session,
        subject: { ...cachedState.session.subject },
      }
    : null
}

export function saveAgentTeamsCapabilities(
  capabilities: AgentTeamsCapabilitiesRecord,
): void {
  ensureHydrated()
  writeState({
    ...cachedState,
    capabilities: cloneState({ capabilities }).capabilities,
  })
}

export function getStoredAgentTeamsCapabilities(): AgentTeamsCapabilitiesRecord | null {
  ensureHydrated()
  return cloneState({ capabilities: cachedState.capabilities }).capabilities ?? null
}

export function clearAgentTeamsStateForTesting(): void {
  hydrated = true
  hydratedStoreKey = getStoreKey()
  cachedState = {}
  cachedCreatedAt = null

  const storePath = getIdentityStorePath()
  if (storePath) {
    rmSync(storePath, { force: true })
    return
  }

  saveGlobalConfig(current => ({
    ...current,
    agentTeams: undefined,
  }))
}

export function setAgentTeamsCapabilitiesForTesting(
  capabilities: AgentTeamsCapabilitiesRecord | null,
): void {
  ensureHydrated()
  writeState({
    ...cachedState,
    capabilities: capabilities ? cloneState({ capabilities }).capabilities : undefined,
  })
}
