import { createHash } from 'node:crypto'

export const CANONICAL_ACCEPTANCE_BASE = '73993bad8ff96dc08086b5ecf125084e1df4a08f'
export const REVIEWED_LATEST_COMMIT = '6294d48a6b977b11863dcb6d0944f2dedb688da7'
export const REVIEWED_LATEST_TREE = '0b8ce21881b3449a676431045b0dfbaa6488e12b'

const PRODUCTION_PREFIXES = [
  'src/services/opencode/',
  'src/features/runtimeProviderManagement/adapters/opencode/',
  'src/cli/handlers/runtimeOpenCodeCommand.ts',
  'src/entrypoints/runtimeProvidersPassiveFastPath.ts',
] as const

const COMPOSER_SUFFIXES = [
  'OpenCodePassiveCommandStatusRoute.ts',
  'OpenCodePassiveStatusProductionReader.ts',
  'OpenCodeProviderCatalogProduction.ts',
  'OpenCodeProviderManagementAdapter.ts',
  'OpenCodeLaunchAttempt.ts',
  'OpenCodeLaunchAttemptProduction.ts',
  'OpenCodeLaunchAttemptProductionComposition.ts',
  'OpenCodeLaunchProductionRouting.ts',
] as const

export type BaseVsHeadIdentity = Readonly<{
  schema: 3
  baseRevision: string
  reviewedLatestCommit: string
  reviewedLatestTree: string
  observedReviewedTree: string
  headRevision: string
  observedHeadRevision: string
  headTree: string
  observedHeadTree: string
  mergeBase: string
  reviewedIsAncestor: boolean
  commitCount: number
  committedPatchBytes: number
  changedFiles: readonly string[]
}>

/** Fail-closed validation of the committed production artifact under review. */
export function validateBaseVsHeadIdentity(value: BaseVsHeadIdentity): void {
  if (value.schema !== 3) throw new Error('evidence schema mismatch')
  if (value.baseRevision !== CANONICAL_ACCEPTANCE_BASE || value.mergeBase !== CANONICAL_ACCEPTANCE_BASE) {
    throw new Error('canonical base mismatch')
  }
  if (value.reviewedLatestCommit !== REVIEWED_LATEST_COMMIT
    || value.reviewedLatestTree !== REVIEWED_LATEST_TREE
    || value.observedReviewedTree !== REVIEWED_LATEST_TREE
    || !value.reviewedIsAncestor) throw new Error('reviewed latest tree is not bound through HEAD')
  if (!/^[0-9a-f]{40}$/.test(value.headRevision)
    || value.headRevision !== value.observedHeadRevision) throw new Error('HEAD identity mismatch')
  if (!/^[0-9a-f]{40}$/.test(value.headTree)
    || value.headTree !== value.observedHeadTree) throw new Error('HEAD tree mismatch')
  if (!Number.isSafeInteger(value.commitCount) || value.commitCount < 1
    || !Number.isSafeInteger(value.committedPatchBytes) || value.committedPatchBytes < 1) {
    throw new Error('base...HEAD committed diff is empty')
  }
  const production = value.changedFiles.filter(file => PRODUCTION_PREFIXES.some(prefix => file.startsWith(prefix)))
  if (production.length === 0) throw new Error('base...HEAD diff is unrelated to production')
  if (!production.some(file => COMPOSER_SUFFIXES.some(suffix => file.endsWith(suffix)))) {
    throw new Error('production composer bypass/facade-only change')
  }
}

export function artifactSha256(value: BaseVsHeadIdentity): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
