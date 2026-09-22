import type {
  AgentTeamsCapabilitiesRecord,
  AgentTeamsCapabilityGrant,
} from './types.js';
import { getCachedAgentTeamsCapabilities } from './capabilities.js';
import { isCodexModel } from '../../utils/model/codex.js';

function normalizeResolvedModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/i, '');
}

function extractProviderFromModelKey(modelKey: string): string | null {
  const [provider] = modelKey.split('/', 1);
  return provider?.trim() || null;
}

export function getAgentTeamsCapabilitiesSnapshot(): AgentTeamsCapabilitiesRecord | null {
  return getCachedAgentTeamsCapabilities();
}

export function getAgentTeamsModelKeyForResolvedModel(
  resolvedModel: string,
): string | null {
  const normalized = normalizeResolvedModel(resolvedModel);
  if (!normalized) {
    return null;
  }

  if (normalized.includes('/')) {
    const [provider, model] = normalized.split('/', 2);
    if (provider && model) {
      return `${provider}/${model}`;
    }
  }

  if (isCodexModel(normalized)) {
    return `codex/${normalized}`;
  }

  if (normalized.startsWith('claude-')) {
    return `anthropic/${normalized}`;
  }

  return null;
}

export function isProviderAllowedByAgentTeams(provider: string): boolean {
  const snapshot = getCachedAgentTeamsCapabilities();
  if (!snapshot) {
    return true;
  }

  const claim = snapshot.claims.providers[provider];
  return claim ? claim.granted : true;
}

function getGrantForResolvedModel(
  resolvedModel: string,
): AgentTeamsCapabilityGrant | null {
  const snapshot = getCachedAgentTeamsCapabilities();
  if (!snapshot) {
    return null;
  }

  const modelKey = getAgentTeamsModelKeyForResolvedModel(resolvedModel);
  if (!modelKey) {
    return null;
  }

  const directClaim = snapshot.claims.models[modelKey];
  if (directClaim) {
    return directClaim;
  }

  const providerKey = extractProviderFromModelKey(modelKey);
  if (!providerKey) {
    return null;
  }

  return snapshot.claims.providers[providerKey] ?? null;
}

export function isModelAllowedByAgentTeamsResolvedModel(
  resolvedModel: string,
): boolean {
  const grant = getGrantForResolvedModel(resolvedModel);
  return grant ? grant.granted : true;
}

export function getFirstAgentTeamsAllowedResolvedModel(
  candidateModels: string[],
): string | null {
  const seen = new Set<string>();

  for (const candidate of candidateModels) {
    const normalized = normalizeResolvedModel(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (isModelAllowedByAgentTeamsResolvedModel(candidate)) {
      return candidate;
    }
  }

  return null;
}
