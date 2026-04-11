import { createHash } from 'crypto';
import { logForDebugging } from '../../utils/debug.js';
import { AgentTeamsHttpError, agentTeamsFetchJson } from './http.js';
import { ensureAgentTeamsSession } from './session.js';
import {
  getStoredAgentTeamsCapabilities,
  saveAgentTeamsCapabilities,
} from './store.js';
import type {
  AgentTeamsCapabilitiesRecord,
  AgentTeamsCapabilitiesResponse,
  AgentTeamsCapabilityClaims,
} from './types.js';

const DEFAULT_CAPABILITIES_ISSUER = 'voicetext-agent-teams-capabilities';
const DEFAULT_CAPABILITIES_AUDIENCE = 'voicetext-agent-teams';

let refreshInFlight: Promise<AgentTeamsCapabilitiesRecord | null> | null = null;

type DecodedJwt<T> = {
  header: Record<string, unknown>;
  payload: T;
  signedPart: string;
  signature: Uint8Array;
};

function decodeBase64UrlToBuffer(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function decodeJwt<T>(token: string): DecodedJwt<T> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('Invalid JWT format');
  }

  const header = JSON.parse(
    decodeBase64UrlToBuffer(encodedHeader).toString('utf8'),
  ) as Record<string, unknown>;
  const payload = JSON.parse(
    decodeBase64UrlToBuffer(encodedPayload).toString('utf8'),
  ) as T;

  return {
    header,
    payload,
    signedPart: `${encodedHeader}.${encodedPayload}`,
    signature: new Uint8Array(decodeBase64UrlToBuffer(encodedSignature)),
  };
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid agent_teams ${field}`);
  }
  return parsed;
}

function getExpectedIssuer(): string {
  return (
    process.env.AGENT_TEAMS_CAPABILITIES_ISSUER?.trim() ||
    DEFAULT_CAPABILITIES_ISSUER
  );
}

function getExpectedAudience(): string {
  return (
    process.env.AGENT_TEAMS_CAPABILITIES_AUDIENCE?.trim() ||
    DEFAULT_CAPABILITIES_AUDIENCE
  );
}

function serializeComparable(value: unknown): string {
  return JSON.stringify(value);
}

function validateClaims(
  claims: AgentTeamsCapabilityClaims,
): AgentTeamsCapabilityClaims {
  if (claims.iss !== getExpectedIssuer()) {
    throw new Error(`Unexpected agent_teams issuer: ${claims.iss}`);
  }
  if (claims.aud !== getExpectedAudience()) {
    throw new Error(`Unexpected agent_teams audience: ${claims.aud}`);
  }
  if (claims.exp * 1000 <= Date.now()) {
    throw new Error('agent_teams capabilities token has expired');
  }

  return {
    ...claims,
    features: claims.features ?? {},
    providers: claims.providers ?? {},
    models: claims.models ?? {},
    killswitches: claims.killswitches ?? {},
  };
}

function getPublicKeyMap(): Map<string, string> {
  const keyMap = new Map<string, string>();
  const rawMap = process.env.AGENT_TEAMS_CAPABILITIES_PUBLIC_KEYS?.trim();

  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap) as Record<string, string>;
      for (const [kid, key] of Object.entries(parsed)) {
        if (kid.trim() && key.trim()) {
          keyMap.set(kid.trim(), key.trim());
        }
      }
    } catch {
      for (const entry of rawMap.split(',')) {
        const [kid, key] = entry.split(':', 2);
        if (kid?.trim() && key?.trim()) {
          keyMap.set(kid.trim(), key.trim());
        }
      }
    }
  }

  const singleKey = process.env.AGENT_TEAMS_CAPABILITIES_PUBLIC_KEY?.trim();
  if (singleKey) {
    const explicitKid = process.env.AGENT_TEAMS_CAPABILITIES_PUBLIC_KEY_KID?.trim();
    keyMap.set(explicitKid || '*', singleKey);
  }

  return keyMap;
}

function selectPublicKey(
  keys: Map<string, string>,
  kid: string | undefined,
): string | null {
  if (kid && keys.has(kid)) {
    return keys.get(kid) ?? null;
  }
  if (keys.has('*')) {
    return keys.get('*') ?? null;
  }
  if (keys.size === 1) {
    return [...keys.values()][0] ?? null;
  }
  return null;
}

async function verifyEd25519Jwt(
  decoded: DecodedJwt<AgentTeamsCapabilityClaims>,
): Promise<boolean> {
  const keyMap = getPublicKeyMap();
  if (keyMap.size === 0) {
    return false;
  }

  const publicKey = selectPublicKey(
    keyMap,
    typeof decoded.header.kid === 'string' ? decoded.header.kid : undefined,
  );
  if (!publicKey) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(publicKey, 'base64'),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    'Ed25519',
    key,
    decoded.signature,
    new TextEncoder().encode(decoded.signedPart),
  );
}

function normalizeCapabilities(
  response: AgentTeamsCapabilitiesResponse,
  claims: AgentTeamsCapabilityClaims,
  integrity: 'verified' | 'transport',
): AgentTeamsCapabilitiesRecord {
  return {
    token: response.token,
    tokenType: response.token_type,
    expiresAt: parseTimestamp(response.expires_at, 'expires_at'),
    fetchedAt: Date.now(),
    integrity,
    claims,
  };
}

async function fetchCapabilities(
  accessToken: string,
  timeoutMs?: number,
): Promise<AgentTeamsCapabilitiesRecord> {
  const response = await agentTeamsFetchJson<AgentTeamsCapabilitiesResponse>(
    '/v1/agent_teams/capabilities',
    {
      method: 'GET',
      timeoutMs,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  const decoded = decodeJwt<AgentTeamsCapabilityClaims>(response.token);
  const decodedClaims = validateClaims(decoded.payload);
  const previewClaims = validateClaims(response.claims_preview);

  if (serializeComparable(decodedClaims) !== serializeComparable(previewClaims)) {
    throw new Error('agent_teams claims preview mismatch');
  }

  const verified = await verifyEd25519Jwt(decoded);
  return normalizeCapabilities(
    response,
    verified ? decodedClaims : previewClaims,
    verified ? 'verified' : 'transport',
  );
}

async function fetchCapabilitiesWithRetry(
  timeoutMs?: number,
): Promise<AgentTeamsCapabilitiesRecord | null> {
  const session = await ensureAgentTeamsSession({ timeoutMs });
  if (!session) {
    return getStoredAgentTeamsCapabilities();
  }

  try {
    return await fetchCapabilities(session.accessToken, timeoutMs);
  } catch (error) {
    if (!(error instanceof AgentTeamsHttpError) || error.status !== 401) {
      throw error;
    }

    const refreshedSession = await ensureAgentTeamsSession({
      forceRefresh: true,
      timeoutMs,
    });
    if (!refreshedSession) {
      return getStoredAgentTeamsCapabilities();
    }

    return fetchCapabilities(refreshedSession.accessToken, timeoutMs);
  }
}

export function getCachedAgentTeamsCapabilities(): AgentTeamsCapabilitiesRecord | null {
  return getStoredAgentTeamsCapabilities();
}

export async function refreshAgentTeamsCapabilities(options?: {
  timeoutMs?: number;
}): Promise<AgentTeamsCapabilitiesRecord | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    try {
      const capabilities = await fetchCapabilitiesWithRetry(options?.timeoutMs);
      if (capabilities) {
        saveAgentTeamsCapabilities(capabilities);
      }
      return capabilities;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorHash = createHash('sha1').update(message).digest('hex').slice(0, 8);
      logForDebugging(
        `[agent_teams] capabilities refresh failed (${errorHash}) - ${message}`,
        {
          level: 'warn',
        },
      );
      return getStoredAgentTeamsCapabilities();
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function primeAgentTeamsCapabilities(): Promise<void> {
  const cached = getStoredAgentTeamsCapabilities();
  if (cached) {
    void refreshAgentTeamsCapabilities();
    return;
  }

  await refreshAgentTeamsCapabilities({
    timeoutMs: 1_500,
  });
}

export function refreshAgentTeamsCapabilitiesInBackground(): void {
  void refreshAgentTeamsCapabilities();
}
