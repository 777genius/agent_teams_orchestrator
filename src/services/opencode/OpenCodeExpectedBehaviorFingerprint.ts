import { createHash } from 'node:crypto'

import { readOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'

import type {
  OpenCodeExpectedBehaviorEvidence,
  OpenCodePreparedProfile,
} from './types.js'

export const OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION = 2
export const OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_RE = /^[a-f0-9]{64}$/
const EXPECTED_BEHAVIOR_DOMAIN = 'agent-teams.opencode.expected-behavior/v2'
const SELECTED_AUTH_DOMAIN = 'agent-teams.opencode.effective-selected-auth/v2'
const EXPECTED_BEHAVIOR_EVIDENCE_KEYS = [
  'canonicalProjectPathFingerprint',
  'modelProviderId',
  'fullModelId',
  'projectBehaviorFingerprint',
  'effectiveConfigFingerprint',
  'effectiveSelectedAuthFingerprint',
  'expectedBehaviorFingerprint',
] as const
export const OPEN_CODE_KNOWN_ABSENT_AUTH_FINGERPRINT =
  '9a5fd1a6c36a41f1220b95f95694fa491c40e00c5ae9895c31d4eeeb6958592b'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as Record<string, unknown>)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .reduce<Record<string, unknown>>((result, key) => {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = stableValue(item)
      return result
    }, {})
}

function requireFingerprint(value: string, field: string): string {
  if (!OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_RE.test(value)) {
    throw new Error(`OpenCode ${field} must be lowercase SHA-256`)
  }
  return value
}

export function computeOpenCodeExpectedBehaviorFingerprint(
  evidence: Omit<OpenCodeExpectedBehaviorEvidence, 'expectedBehaviorFingerprint'>,
): string {
  return sha256(JSON.stringify([
    EXPECTED_BEHAVIOR_DOMAIN,
    requireFingerprint(evidence.canonicalProjectPathFingerprint, 'canonical project path fingerprint'),
    evidence.modelProviderId,
    evidence.fullModelId,
    requireFingerprint(evidence.projectBehaviorFingerprint, 'project behavior fingerprint'),
    requireFingerprint(evidence.effectiveConfigFingerprint, 'effective config fingerprint'),
    requireFingerprint(evidence.effectiveSelectedAuthFingerprint, 'effective selected auth fingerprint'),
  ]))
}

export function validateOpenCodeExpectedBehaviorEvidence(
  evidence: OpenCodeExpectedBehaviorEvidence,
): boolean {
  try {
    const keys = Object.keys(evidence)
    return keys.length === EXPECTED_BEHAVIOR_EVIDENCE_KEYS.length
      && EXPECTED_BEHAVIOR_EVIDENCE_KEYS.every(key => keys.includes(key))
      && /^[a-z0-9][a-z0-9._-]*$/.test(evidence.modelProviderId)
      && typeof evidence.fullModelId === 'string'
      && evidence.fullModelId.length > 0
      && OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_RE.test(evidence.expectedBehaviorFingerprint)
      && computeOpenCodeExpectedBehaviorFingerprint(evidence) === evidence.expectedBehaviorFingerprint
  } catch {
    return false
  }
}

export async function buildOpenCodeExpectedBehaviorEvidence(input: {
  profile: OpenCodePreparedProfile
  fullModelId: string
  effectiveConfigFingerprint: string | null
  platform?: NodeJS.Platform
  readCredential?: typeof readOpenCodeAuthCredential
}): Promise<OpenCodeExpectedBehaviorEvidence> {
  const separator = input.fullModelId.indexOf('/')
  const modelProviderId = separator > 0
    ? input.fullModelId.slice(0, separator).toLowerCase()
    : ''
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(modelProviderId)) {
    throw new Error('OpenCode expected behavior requires a provider-qualified model')
  }
  if (!input.effectiveConfigFingerprint) {
    throw new Error('OpenCode effective live config fingerprint is unavailable')
  }
  const canonicalProjectPath = input.profile.canonicalProjectPath
    ?? normalizeOpenCodeProjectIdentity(input.profile.projectPath, input.platform)
  let credential: Record<string, unknown> | null
  try {
    credential = await (input.readCredential ?? readOpenCodeAuthCredential)({
      authPath: input.profile.managedAuthPath,
      providerId: modelProviderId,
    })
  } catch {
    throw new Error('OpenCode effective selected authentication is unavailable')
  }
  const unsigned = {
    canonicalProjectPathFingerprint: sha256(
      normalizeOpenCodeProjectIdentity(canonicalProjectPath, input.platform),
    ),
    modelProviderId,
    fullModelId: `${modelProviderId}${input.fullModelId.slice(separator)}`,
    projectBehaviorFingerprint: requireFingerprint(
      input.profile.projectBehaviorFingerprint,
      'project behavior fingerprint',
    ),
    effectiveConfigFingerprint: requireFingerprint(
      input.effectiveConfigFingerprint,
      'effective config fingerprint',
    ),
    effectiveSelectedAuthFingerprint: input.profile.profileScope
      && input.profile.authoritySourceFingerprint
      ? sha256(JSON.stringify([
          SELECTED_AUTH_DOMAIN,
          modelProviderId,
          credential === null ? 'absent' : 'present',
          credential === null ? null : stableValue(credential),
          requireFingerprint(input.profile.authoritySourceFingerprint, 'authority source fingerprint'),
        ]))
      : credential === null ? OPEN_CODE_KNOWN_ABSENT_AUTH_FINGERPRINT
        : sha256(JSON.stringify([
          SELECTED_AUTH_DOMAIN,
          modelProviderId,
          'present',
          stableValue(credential),
        ])),
  }
  return {
    ...unsigned,
    expectedBehaviorFingerprint: computeOpenCodeExpectedBehaviorFingerprint(unsigned),
  }
}
