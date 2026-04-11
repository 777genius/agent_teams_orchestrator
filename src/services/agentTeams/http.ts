import { logForDebugging } from '../../utils/debug.js';
import { getProxyFetchOptions } from '../../utils/proxy.js';

const DEFAULT_AGENT_TEAMS_API_BASE_URL = 'https://api.voicetext.site';

type ApiSuccess<T> = {
  success: true;
  data: T;
};

type ApiFailure = {
  success: false;
  error?: {
    code?: string;
    message?: string;
  };
};

type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export class AgentTeamsHttpError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, options?: { status?: number; code?: string }) {
    super(message);
    this.name = 'AgentTeamsHttpError';
    this.status = options?.status;
    this.code = options?.code;
  }
}

export function getAgentTeamsApiBaseUrl(): string {
  return (
    process.env.AGENT_TEAMS_API_BASE_URL?.trim() ||
    DEFAULT_AGENT_TEAMS_API_BASE_URL
  );
}

function buildAgentTeamsUrl(pathname: string): string {
  return new URL(pathname, `${getAgentTeamsApiBaseUrl().replace(/\/+$/, '')}/`).toString();
}

function createTimeoutSignal(timeoutMs?: number): {
  signal?: AbortSignal;
  clear: () => void;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return {
      clear: () => {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

export async function agentTeamsFetchJson<T>(
  pathname: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs, headers, ...requestInit } = init;
  const { signal, clear } = createTimeoutSignal(timeoutMs);
  const url = buildAgentTeamsUrl(pathname);

  try {
    const response = await fetch(url, {
      ...requestInit,
      ...getProxyFetchOptions(),
      signal,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });

    let body: ApiResponse<T> | null = null;
    try {
      body = (await response.json()) as ApiResponse<T>;
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new AgentTeamsHttpError(
        body?.error?.message || `agent_teams request failed with ${response.status}`,
        {
          status: response.status,
          code: body?.error?.code,
        },
      );
    }

    if (!body?.success) {
      throw new AgentTeamsHttpError(
        body?.error?.message || 'agent_teams request failed',
        {
          status: response.status,
          code: body?.error?.code,
        },
      );
    }

    return body.data;
  } catch (error) {
    if (error instanceof AgentTeamsHttpError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logForDebugging(`[agent_teams] request failed: ${pathname} - ${message}`, {
      level: 'warn',
    });
    throw new AgentTeamsHttpError(message);
  } finally {
    clear();
  }
}
