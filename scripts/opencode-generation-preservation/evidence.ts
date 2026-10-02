import type { Reader, Variant } from './fixtures'

export function assess(reader: Reader, variant: Variant, operation: string, observed: any,
  changed: boolean, added: string[]) {
  if (observed.qualification === 'MISSING') return { status: 'MISSING', reason: observed.reason ?? observed.error?.message ?? 'Reader unavailable' }
  if (observed.effects?.length) return { status: 'FAIL', reason: 'Forbidden effect attempted' }
  const unknown = ['future', 'future-envelope', 'corrupt', 'truncated', 'partial', 'unreadable'].includes(variant)
  if (!unknown) return { status: 'OBSERVED', reason: 'Known V1 or truly missing control; no final-support claim' }
  if (changed) return { status: 'FAIL', reason: 'Unknown original bytes overwritten or removed on TEST copy' }
  if (added.some(file => file.endsWith('.quarantine'))) return { status: 'FAIL', reason: 'Preserve-only forbids quarantine of unknown authority' }
  const value = observed.result
  if (observed.returned && operation === 'resolveOwnedSessionEndpoint' && value?.baseUrl) return { status: 'FAIL', reason: 'Unknown/partial containing host authority accepted endpoint without uncertainty veto; original bytes retained' }
  if (observed.returned && operation === 'query' && value?.record === null) return { status: 'FAIL', reason: 'Unknown authority returned null outcome (empty fallback)' }
  if (observed.returned && operation === 'query' && variant === 'partial') return { status: 'FAIL', reason: 'Partial containing authority filtered without uncertainty veto' }
  if (observed.returned && operation === 'list-get') return { status: 'FAIL', reason: value?.list?.length === 0 ? 'Unknown authority returned empty session list' : 'Partial ownership rows exposed without uncertainty veto' }
  if (observed.returned && reader === 'manifest-evidence' && variant === 'future-envelope') return { status: 'FAIL', reason: 'Evidence reader ignored future outer envelope version' }
  if (observed.returned && ['upsert', 'claim', 'prune', 'delete', 'update', 'retainHostLease', 'releaseHostLeaseStrict'].includes(operation)) return { status: 'FAIL', reason: 'Unknown authority allowed mutation/prune/cleanup attempt without explicit read failure veto' }
  if (observed.returned && operation === 'read' && value?.ok !== false) return { status: 'FAIL', reason: 'Unknown authority treated as loaded or missing' }
  return { status: 'OBSERVED', reason: 'Public reader rejected; original bytes retained. This is a baseline observation, not final preservation qualification.' }
}
export const boundaryGaps = [
  { reader: 'host', operation: 'reconcilePersistentHosts/disposeHost', status: 'MISSING',
    reason: 'Public cleanup includes process attribution scans/native tree cleanup not fully isolated by HostManagerDeps. Not invoked by reader-only S5a.',
    extraction: 'O1a: expose preserve-only registry inspection (known/missing/future/corrupt/partial/read-error) and veto under existing lock; keep native cleanup in lifecycle owner.' },
  { reader: 'session', operation: 'dead-owner reclaim', status: 'MISSING',
    reason: 'Native process-birth/liveness reclaim is outside narrow file-reader scope; claimMaterialization tests only fresh TEST claims.',
    extraction: 'O1a: validate containing authority before normalization/claims; typed preserve-only errors precede existing process checks.' },
  { reader: 'product', operation: 'prepare lane/reset/prune/native history downgrade', status: 'MISSING',
    reason: 'Reader-only API probe cannot qualify production lane reset or S5b native disk downgrade.',
    extraction: 'A2a: explicit future/read-error veto at evidence and VersionedJsonStore boundaries before launch/reset; S5b replays old readers against final namespaced stores.' },
]

export function decodeObservation(receipt: { stdout: string; stderr: string; code: number | null }) {
  let observation: any
  try { observation = JSON.parse(receipt.stdout.trim().split('\n').at(-1)!) }
  catch { observation = { qualification: 'MISSING', reason: 'Reader child did not emit valid observation', code: receipt.code, stderr: receipt.stderr } }
  if (receipt.code !== 0) observation = { qualification: 'MISSING', reason: 'Reader process failed', processResult: receipt, priorObservation: observation }
  return observation
}
