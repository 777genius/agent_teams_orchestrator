/** Shared model-route DTOs, independent of policy execution and inventory acquisition. */
export type OpenCodeModelAccessKind =
  | 'no_model'
  | 'unknown_model'
  | 'credentialed'
  | 'builtin_free'
  | 'configured_authless'
  | 'verified'
  | 'not_authenticated'
  | 'execution_failed'

export type OpenCodeModelRouteKind =
  | 'connected_provider'
  | 'builtin_free'
  | 'configured_local'
  | 'catalog_provider'

export type OpenCodeModelProofState =
  | 'not_required'
  | 'needs_probe'
  | 'verified'
  | 'failed'

export type OpenCodeModelRouteMetadata = {
  providerId: string | null
  modelId: string | null
  sourceLabel: string | null
  accessKind: OpenCodeModelAccessKind
  routeKind: OpenCodeModelRouteKind
  proofState: OpenCodeModelProofState
  requiresExecutionProof: boolean
  reason: string | null
  failureCode?: 'free_tier_restricted'
}
