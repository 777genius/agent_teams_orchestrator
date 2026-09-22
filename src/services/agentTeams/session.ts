import { logForDebugging } from '../../utils/debug.js';
import { AgentTeamsHttpError, agentTeamsFetchJson } from './http.js';
import {
  ensureAgentTeamsClientId,
  getStoredAgentTeamsSession,
  saveAgentTeamsSession,
} from './store.js';
import type {
  AgentTeamsSessionRecord,
  AgentTeamsSessionResponse,
} from './types.js';

const ACCESS_TOKEN_SKEW_MS = 30_000;
const REFRESH_TOKEN_SKEW_MS = 60_000;

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid agent_teams ${field}`);
  }
  return parsed;
}

function normalizeSessionResponse(
  response: AgentTeamsSessionResponse,
): AgentTeamsSessionRecord {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    accessExpiresAt: parseTimestamp(
      response.access_expires_at,
      'access_expires_at',
    ),
    refreshExpiresAt: parseTimestamp(
      response.refresh_expires_at,
      'refresh_expires_at',
    ),
    subject: {
      ...response.subject,
    },
  };
}

function isAccessTokenFresh(session: AgentTeamsSessionRecord): boolean {
  return session.accessExpiresAt - ACCESS_TOKEN_SKEW_MS > Date.now();
}

function isRefreshTokenFresh(session: AgentTeamsSessionRecord): boolean {
  return session.refreshExpiresAt - REFRESH_TOKEN_SKEW_MS > Date.now();
}

async function createGuestSession(
  clientId: string,
  timeoutMs?: number,
): Promise<AgentTeamsSessionRecord> {
  const response = await agentTeamsFetchJson<AgentTeamsSessionResponse>(
    '/v1/agent_teams/session/guest',
    {
      method: 'POST',
      timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
      }),
    },
  );
  const session = normalizeSessionResponse(response);
  saveAgentTeamsSession(session);
  return session;
}

async function refreshSession(
  session: AgentTeamsSessionRecord,
  clientId: string,
  timeoutMs?: number,
): Promise<AgentTeamsSessionRecord> {
  const response = await agentTeamsFetchJson<AgentTeamsSessionResponse>(
    '/v1/agent_teams/session/refresh',
    {
      method: 'POST',
      timeoutMs,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        refresh_token: session.refreshToken,
        client_id: clientId,
      }),
    },
  );
  const refreshed = normalizeSessionResponse(response);
  saveAgentTeamsSession(refreshed);
  return refreshed;
}

export async function ensureAgentTeamsSession(options?: {
  forceRefresh?: boolean;
  timeoutMs?: number;
}): Promise<AgentTeamsSessionRecord | null> {
  const clientId = ensureAgentTeamsClientId();
  const stored = getStoredAgentTeamsSession();

  try {
    if (stored && !options?.forceRefresh && isAccessTokenFresh(stored)) {
      return stored;
    }

    if (stored && isRefreshTokenFresh(stored)) {
      return await refreshSession(stored, clientId, options?.timeoutMs);
    }

    return await createGuestSession(clientId, options?.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logForDebugging(`[agent_teams] failed to ensure session - ${message}`, {
      level: 'warn',
    });

    if (
      stored &&
      !(error instanceof AgentTeamsHttpError && error.status === 401) &&
      isRefreshTokenFresh(stored)
    ) {
      return stored;
    }

    return null;
  }
}
