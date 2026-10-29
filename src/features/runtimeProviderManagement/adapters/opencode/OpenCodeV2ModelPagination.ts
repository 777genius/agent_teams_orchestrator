import { createHash } from 'node:crypto'
import type { LoadProviderModelsInput, RuntimeProviderModel } from '../../domain/types.js'

/** Settings pages are display-only, but must still represent the same native catalog. */
export function pageOpenCodeV2ProviderModels(
  models: readonly RuntimeProviderModel[],
  input: Pick<LoadProviderModelsInput, 'providerId' | 'projectPath' | 'query' | 'limit' | 'cursor'>,
) {
  const query = input.query?.trim().toLowerCase() ?? ''
  const matching = models.filter(model => !query || `${model.modelId} ${model.displayName}`.toLowerCase().includes(query))
    .sort((left, right) => left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0)
  if (input.limit != null && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new Error('provider_catalog_page_invalid')
  }
  const limit = input.limit == null ? null : Math.min(200, input.limit)
  const cursor = input.cursor?.trim() || null
  const fingerprint = createHash('sha256').update(JSON.stringify([
    input.providerId, input.projectPath ?? null, query, matching,
  ])).digest('hex')
  let offset = 0
  if (cursor) {
    const match = /^v2:([1-9]\d*):([a-f0-9]{64})$/.exec(cursor)
    offset = match ? Number(match[1]) : NaN
    if (!Number.isSafeInteger(offset) || offset >= matching.length || match?.[2] !== fingerprint) {
      throw new Error('provider_catalog_page_changed')
    }
  }
  const page = limit === null ? matching.slice(offset) : matching.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  return { totalCount: matching.length, returnedCount: page.length, limit, cursor,
    nextCursor: nextOffset < matching.length ? `v2:${nextOffset}:${fingerprint}` : null,
    models: page }
}
