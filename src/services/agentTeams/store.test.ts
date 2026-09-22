import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  AGENT_TEAMS_IDENTITY_STORE_PATH_ENV,
  clearAgentTeamsStateForTesting,
  ensureAgentTeamsClientId,
  getAgentTeamsState,
  saveAgentTeamsSession,
} from './store.js'
import type { AgentTeamsSessionRecord } from './types.js'

const LEGACY_CLIENT_ID = '11111111-1111-4111-8111-111111111111'

let tempDir: string
let previousIdentityStorePath: string | undefined

function storePath(): string {
  return join(tempDir, 'identity', 'agent-teams-client.json')
}

function readStore(): Record<string, unknown> {
  return JSON.parse(readFileSync(storePath(), 'utf8')) as Record<string, unknown>
}

function sampleSession(): AgentTeamsSessionRecord {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 120_000,
    subject: {
      id: 'guest-subject',
      tier: 'guest',
    },
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-teams-identity-store-'))
  previousIdentityStorePath = process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]
  delete process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]
  clearAgentTeamsStateForTesting()
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: undefined,
  }))
})

afterEach(() => {
  delete process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]
  clearAgentTeamsStateForTesting()
  if (previousIdentityStorePath === undefined) {
    delete process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV]
  } else {
    process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV] = previousIdentityStorePath
  }
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: undefined,
  }))
  rmSync(tempDir, { recursive: true, force: true })
})

describe('Agent Teams app-data identity store', () => {
  test('creates a stable UUID in the configured app-data store', () => {
    process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV] = storePath()

    const first = ensureAgentTeamsClientId()
    const second = ensureAgentTeamsClientId()
    const persisted = readStore()

    expect(second).toBe(first)
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.clientId).toBe(first)
    expect(getGlobalConfig().agentTeams).toBeUndefined()
  })

  test('migrates legacy agentTeams clientId into app-data without mutating legacy state', () => {
    saveGlobalConfig(current => ({
      ...current,
      agentTeams: {
        clientId: LEGACY_CLIENT_ID,
      },
    }))
    process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV] = storePath()

    const clientId = ensureAgentTeamsClientId()
    saveAgentTeamsSession(sampleSession())

    expect(clientId).toBe(LEGACY_CLIENT_ID)
    expect(readStore().clientId).toBe(LEGACY_CLIENT_ID)
    expect(getGlobalConfig().agentTeams).toEqual({
      clientId: LEGACY_CLIENT_ID,
    })
  })

  test('invalid app-data store falls back safely without crashing', () => {
    process.env[AGENT_TEAMS_IDENTITY_STORE_PATH_ENV] = storePath()
    mkdirSync(join(tempDir, 'identity'), { recursive: true })
    writeFileSync(storePath(), '{not-json', 'utf8')

    const clientId = ensureAgentTeamsClientId()

    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(readStore().clientId).toBe(clientId)
  })

  test('keeps legacy global config behavior when app-data env is absent', () => {
    const clientId = ensureAgentTeamsClientId()

    expect(getAgentTeamsState().clientId).toBe(clientId)
    expect(getGlobalConfig().agentTeams?.clientId).toBe(clientId)
  })
})
