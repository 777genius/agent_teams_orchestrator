import type {
  RuntimeExtensionCapabilities,
  RuntimeProviderStatus,
  RuntimeStatusCheckErrorCode,
  RuntimeStatusCheckOutcome,
} from './types.js'

export type OpenCodePassiveEvidenceState =
  | 'ready'
  | 'pending'
  | 'timeout'
  | 'unavailable'
  | 'runtime_missing'

/** Already-retained, redacted display evidence. Reading it must have no side effects. */
export type OpenCodePassiveStatusEvidence = {
  state: OpenCodePassiveEvidenceState
  binaryPath: string | null
  version?: string | null
  models?: readonly string[]
}

export type OpenCodePassiveStatusDeps = {
  readOpenCodePassiveEvidence?: () => OpenCodePassiveStatusEvidence
}

export function buildOpenCodePassiveStatus(
  deps: OpenCodePassiveStatusDeps = {},
): RuntimeProviderStatus {
  let evidence: OpenCodePassiveStatusEvidence
  try {
    evidence = (deps.readOpenCodePassiveEvidence ?? readKnownBinaryMetadata)()
  } catch {
    evidence = { state: 'unavailable', binaryPath: null }
  }
  if (!isEvidenceState(evidence?.state)) {
    evidence = { state: 'pending', binaryPath: null }
  }
  const { outcome, errorCode } = statusContract(evidence.state)
  const binaryKnown = Boolean(evidence.binaryPath)
  const runtimeMissing = evidence.state === 'runtime_missing'
  const models = evidence.models ? [...evidence.models] : []
  const statusMessage = passiveStatusMessage(evidence.state, binaryKnown)

  return {
    providerId: 'opencode',
    displayName: 'OpenCode (75+ LLM providers)',
    supported: binaryKnown && !runtimeMissing,
    authenticated: false,
    authMethod: null,
    verificationState: runtimeMissing ? 'offline' : 'unknown',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: passiveExtensions(),
    },
    statusMessage,
    detailMessage: evidence.version
      ? `Passive OpenCode metadata reports version ${evidence.version}.`
      : 'Passive summary does not verify authentication or launch readiness.',
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [{
      id: 'cli-bin',
      label: 'OpenCode CLI',
      detected: binaryKnown,
      statusMessage,
      detailMessage: evidence.binaryPath,
    }],
    models,
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'app-server' },
    },
    backend: binaryKnown
      ? { kind: 'opencode-cli', label: 'OpenCode CLI', authMethodDetail: null }
      : null,
    statusCheckOutcome: outcome,
    statusCheckErrorCode: errorCode,
  }
}

function readKnownBinaryMetadata(): OpenCodePassiveStatusEvidence {
  const binaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH?.trim()
    || process.env.OPENCODE_BIN_PATH?.trim()
    || null
  return {
    state: binaryPath ? 'ready' : 'runtime_missing',
    binaryPath,
  }
}

function isEvidenceState(value: unknown): value is OpenCodePassiveEvidenceState {
  return value === 'ready'
    || value === 'pending'
    || value === 'timeout'
    || value === 'unavailable'
    || value === 'runtime_missing'
}

function statusContract(state: OpenCodePassiveEvidenceState): {
  outcome: RuntimeStatusCheckOutcome
  errorCode: RuntimeStatusCheckErrorCode | null
} {
  switch (state) {
    case 'ready': return { outcome: 'model_only', errorCode: null }
    case 'pending': return { outcome: 'pending', errorCode: 'partial_response' }
    case 'timeout': return { outcome: 'transient_error', errorCode: 'timeout' }
    case 'unavailable': return { outcome: 'transient_error', errorCode: 'unavailable' }
    case 'runtime_missing': return { outcome: 'transient_error', errorCode: 'runtime_missing' }
  }
}

function passiveStatusMessage(state: OpenCodePassiveEvidenceState, binaryKnown: boolean): string {
  if (state === 'pending') return 'OpenCode passive status is pending'
  if (state === 'timeout') return 'OpenCode passive status timed out'
  if (state === 'unavailable') return 'OpenCode passive status unavailable'
  if (state === 'runtime_missing') return 'OpenCode CLI not found in known metadata'
  return binaryKnown ? 'OpenCode detected (passive)' : 'OpenCode passive status unavailable'
}

function passiveExtensions(): RuntimeExtensionCapabilities {
  const reason = 'Passive summary does not inspect or manage OpenCode runtime state.'
  return {
    plugins: { status: 'read-only', ownership: 'provider-scoped', reason },
    mcp: { status: 'read-only', ownership: 'provider-scoped', reason },
    skills: { status: 'read-only', ownership: 'provider-scoped', reason },
    apiKeys: { status: 'read-only', ownership: 'provider-scoped', reason },
  }
}
