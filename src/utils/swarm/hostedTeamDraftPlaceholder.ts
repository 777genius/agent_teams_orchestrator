/**
 * Hosted Product publishes `teams/<legacyKey>/config.json` as exactly
 * `{"name":"<legacyKey>","pendingCreate":true}` before the first launch. It
 * reserves the team directory but is not a team yet: the deterministic
 * bootstrap of that same team replaces it with the real team file instead of
 * attaching to it or creating the team under another name. Desktop drafts
 * never live in config.json, so nothing else matches this shape.
 */
export function isHostedTeamDraftPlaceholder(value: unknown, teamName: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return keys.length === 2 && keys.includes('name') && keys.includes('pendingCreate') &&
    record.name === teamName && record.pendingCreate === true
}
