import { randomUUID } from 'crypto';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import type {
  AgentTeamsCapabilitiesRecord,
  AgentTeamsSessionRecord,
  AgentTeamsState,
} from './types.js';

let hydrated = false;
let cachedState: AgentTeamsState = {};

function cloneState(state: AgentTeamsState | undefined): AgentTeamsState {
  if (!state) {
    return {};
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
  };
}

function ensureHydrated(): void {
  if (hydrated) {
    return;
  }
  cachedState = cloneState(getGlobalConfig().agentTeams);
  hydrated = true;
}

function writeState(nextState: AgentTeamsState): void {
  cachedState = cloneState(nextState);
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: isEmptyState(nextState) ? undefined : cloneState(nextState),
  }));
}

function isEmptyState(state: AgentTeamsState): boolean {
  return !state.clientId && !state.session && !state.capabilities;
}

export function getAgentTeamsState(): AgentTeamsState {
  ensureHydrated();
  return cloneState(cachedState);
}

export function ensureAgentTeamsClientId(): string {
  ensureHydrated();
  if (cachedState.clientId) {
    return cachedState.clientId;
  }

  const nextState: AgentTeamsState = {
    ...cachedState,
    clientId: randomUUID(),
  };
  writeState(nextState);
  return nextState.clientId!;
}

export function saveAgentTeamsSession(session: AgentTeamsSessionRecord): void {
  ensureHydrated();
  writeState({
    ...cachedState,
    session: {
      ...session,
      subject: { ...session.subject },
    },
  });
}

export function getStoredAgentTeamsSession(): AgentTeamsSessionRecord | null {
  ensureHydrated();
  return cachedState.session
    ? {
        ...cachedState.session,
        subject: { ...cachedState.session.subject },
      }
    : null;
}

export function saveAgentTeamsCapabilities(
  capabilities: AgentTeamsCapabilitiesRecord,
): void {
  ensureHydrated();
  writeState({
    ...cachedState,
    capabilities: cloneState({ capabilities }).capabilities,
  });
}

export function getStoredAgentTeamsCapabilities(): AgentTeamsCapabilitiesRecord | null {
  ensureHydrated();
  return cloneState({ capabilities: cachedState.capabilities }).capabilities ?? null;
}

export function clearAgentTeamsStateForTesting(): void {
  hydrated = true;
  cachedState = {};
  saveGlobalConfig(current => ({
    ...current,
    agentTeams: undefined,
  }));
}

export function setAgentTeamsCapabilitiesForTesting(
  capabilities: AgentTeamsCapabilitiesRecord | null,
): void {
  ensureHydrated();
  writeState({
    ...cachedState,
    capabilities: capabilities ? cloneState({ capabilities }).capabilities : undefined,
  });
}
