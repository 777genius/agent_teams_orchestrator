/** Native V2 costs are tiers, unlike the legacy single cost object. Unknown or
 * incomplete prices never become a claim of free access. */
export function isOpenCodeV2ZeroCost(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const row = item as Record<string, unknown>, cache = row.cache
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return false
    const cached = cache as Record<string, unknown>
    return row.input === 0 && row.output === 0 && cached.read === 0 && cached.write === 0
  })
}

/** Zero metered price in a purchased Go plan is not anonymous/free access. */
export function isOpenCodeV2ModelFree(providerId: string, cost: unknown): boolean {
  return providerId !== 'opencode-go' && isOpenCodeV2ZeroCost(cost)
}

/** Public native sentinel only; execution independently proves the exact model
 * and the empty integration connection set before issuing any prompt. */
export function isOpenCodeV2AnonymousProvider(value: Record<string, unknown>): boolean {
  const settings = value.settings
  return value.id === 'opencode' && value.activation === 'enabled' && value.integrationID === 'opencode' &&
    settings !== null && typeof settings === 'object' && !Array.isArray(settings) &&
    (settings as Record<string, unknown>).apiKey === 'public'
}
