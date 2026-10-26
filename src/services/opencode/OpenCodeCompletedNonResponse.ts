export { isGroupNonResponseText as isOpenCodeNonResponseText } from '../../utils/groupNonResponse.js'
/** Full terminal output only: never classify a truncated transcript preview. */
export const COMPLETED_NON_RESPONSE_REASON = 'assistant_child_completed_with_non_response_text'

/** A successful read-only catalog receipt, including the MCP text envelope. */
export function isSuccessfulGroupCatalogResult(value: unknown, depth = 0): boolean {
  if (depth > 3) return false
  if (typeof value === 'string') {
    try { return isSuccessfulGroupCatalogResult(JSON.parse(value), depth + 1) } catch { return false }
  }
  if (Array.isArray(value)) {
    if (value.every(row => row && typeof row === 'object' && typeof row.id === 'string' && Array.isArray(row.memberNames))) return true
    return value.length === 1 && value[0]?.type === 'text' && isSuccessfulGroupCatalogResult(value[0].text, depth + 1)
  }
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return result.isError !== true && !result.error &&
    (isSuccessfulGroupCatalogResult(result.structuredContent, depth + 1) ||
      isSuccessfulGroupCatalogResult(result.content, depth + 1))
}
