export type HostedOwnerBoundStage = 'received' | 'decoded' | 'rejected' | 'replied'

/**
 * One JSON line per stage of a Product owner-bound exchange. Only fixed codes, field names,
 * byte counts and socket flags: never payloads, identities, proofs or credentials.
 */
export function reportHostedOwnerBoundStage(
  operation: unknown,
  stage: HostedOwnerBoundStage,
  detail: { reason?: string; bytes?: number; writable?: boolean; peerEnded?: boolean } = {},
): void {
  const code = typeof operation === 'string' && /^[a-z_]{1,32}$/.test(operation) ? operation : 'unknown'
  process.stderr.write(`${JSON.stringify({ event: 'hosted_owner_bound', operation: code, stage, ...detail })}\n`)
}
