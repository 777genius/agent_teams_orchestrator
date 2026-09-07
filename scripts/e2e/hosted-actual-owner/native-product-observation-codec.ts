// Bounded Owner port of Product 5e5e811f contracts/hosted.ts, hosted identifiers/
// revision.ts and deriveRuntimePermissionApprovalIdentity. DATA, never a permit.
import { exactRecord, sha256 } from './native-http-contract.js'

export const HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS = Object.freeze([
  { method: 'POST', path: '/api/hosted/v1/team-approvals/page' },
  { method: 'POST', path: '/api/hosted/v1/team-approvals/preview' },
  { method: 'POST', path: '/api/hosted/v1/team-approvals/decisions' },
] as const)
export type HostedTeamApprovalPageRequest = Readonly<{
  schemaVersion: 1; teamId: string; expectedRunId: string; cursor: string | null; limit: number
}>
export type HostedTeamApprovalPreviewRequest = Readonly<{
  schemaVersion: 1; teamId: string; expectedRunId: string; approvalId: string; expectedGeneration: string; previewRef: string
}>
type Item = Readonly<{ teamId: string; runId: string; approvalId: string; generation: string;
  category: string; summary: string; requestedAtMs: number; expiresAtMs: number | null; previewRef: string | null }>
type Budget = Readonly<{ itemLimit: number; byteLimit: number; timeLimitMs: number;
  usedItems: number; usedBytes: number; elapsedMs: number }>
type Page = Readonly<{ schemaVersion: 1; kind: 'approval_page'; teamId: string;
  items: readonly Item[]; nextCursor: string | null; truncated: boolean; budget: Budget }>
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>
function check(value: unknown): asserts value { if (!value) throw new Error('native_product_observation_rejected') }
function parse<T>(read: () => T): Result<T> {
  try { return Object.freeze({ ok: true, value: read() }) } catch { return Object.freeze({ ok: false }) }
}
function record(value: unknown, keys: string) {
  const r = exactRecord(value, keys.split(','), 'product_observation')
  check(Reflect.ownKeys(r).length === keys.split(',').length)
  return r
}
function text(value: unknown, pattern: RegExp): string { check(typeof value === 'string' && pattern.test(value)); return value }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  check(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max); return value as number
}
function team(v: unknown): string { const s = text(v, /^team_[0-9a-f]{32}$/); check(s.length === 37); return s }
function run(v: unknown): string { const s = text(v, /^run_[0-9a-f]{32}$/); check(s.length === 36); return s }
const approval = (v: unknown) => text(v, /^approval_[0-9a-f]{32}$/)
const generation = (v: unknown) => text(v, /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/)
const preview = (v: unknown) => text(v, /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/)
function cursor(v: unknown): string | null {
  if (v === null) return null
  const s = text(v, /^cursor_[A-Za-z0-9][A-Za-z0-9._-]*$/); check(s.length <= 256); return s
}
function version(v: unknown): 1 { check(v === 1); return 1 }
export function parseHostedTeamApprovalPageRequest(value: unknown): Result<HostedTeamApprovalPageRequest> {
  return parse(() => {
    const r = record(value, 'schemaVersion,teamId,expectedRunId,cursor,limit')
    return Object.freeze({ schemaVersion: version(r.schemaVersion), teamId: team(r.teamId),
      expectedRunId: run(r.expectedRunId), cursor: cursor(r.cursor), limit: integer(r.limit, 1, 50) })
  })
}
export function parseHostedTeamApprovalPreviewRequest(value: unknown): Result<HostedTeamApprovalPreviewRequest> {
  return parse(() => {
    const r = record(value, 'schemaVersion,teamId,expectedRunId,approvalId,expectedGeneration,previewRef')
    return Object.freeze({ schemaVersion: version(r.schemaVersion), teamId: team(r.teamId),
      expectedRunId: run(r.expectedRunId), approvalId: approval(r.approvalId),
      expectedGeneration: generation(r.expectedGeneration), previewRef: preview(r.previewRef) })
  })
}
function item(value: unknown, expectedTeamId: string): Item {
  const r = record(value, 'teamId,runId,approvalId,generation,category,summary,requestedAtMs,expiresAtMs,previewRef')
  const teamId = team(r.teamId), runId = run(r.runId)
  check(teamId === expectedTeamId && ['file_change', 'command', 'network', 'other'].includes(r.category as string))
  const summary = r.summary
  check(typeof summary === 'string' && summary.length >= 1 && summary.length <= 512 && summary.trim() === summary)
  const requestedAtMs = integer(r.requestedAtMs, 0)
  const expiresAtMs = r.expiresAtMs === null ? null : integer(r.expiresAtMs, 0)
  check(expiresAtMs === null || expiresAtMs > requestedAtMs)
  return Object.freeze({ teamId, runId, approvalId: approval(r.approvalId), generation: generation(r.generation),
    category: r.category as string, summary, requestedAtMs, expiresAtMs,
    previewRef: r.previewRef === null ? null : preview(r.previewRef) })
}
export function parseHostedTeamApprovalPage(value: unknown): Result<Page> {
  return parse(() => {
    const r = record(value, 'schemaVersion,kind,teamId,items,nextCursor,truncated,budget')
    check(r.kind === 'approval_page' && Array.isArray(r.items) && r.items.length <= 50 && typeof r.truncated === 'boolean')
    const teamId = team(r.teamId), items = Object.freeze(r.items.map(v => item(v, teamId)))
    const b = record(r.budget, 'itemLimit,byteLimit,timeLimitMs,usedItems,usedBytes,elapsedMs')
    const budget = Object.freeze({ itemLimit: integer(b.itemLimit, 1, 50), byteLimit: integer(b.byteLimit, 1, 128 * 1024),
      timeLimitMs: integer(b.timeLimitMs, 1, 250), usedItems: integer(b.usedItems, 0),
      usedBytes: integer(b.usedBytes, 0), elapsedMs: integer(b.elapsedMs, 0) })
    check(new Set(items.map(i => i.approvalId)).size === items.length && budget.usedItems === items.length &&
      budget.usedItems <= budget.itemLimit && budget.usedBytes <= budget.byteLimit &&
      (r.truncated ? r.nextCursor !== null : r.nextCursor === null))
    return Object.freeze({ schemaVersion: version(r.schemaVersion), kind: 'approval_page', teamId, items,
      nextCursor: cursor(r.nextCursor), truncated: r.truncated, budget })
  })
}
export function deriveRuntimePermissionApprovalIdentity(input: Readonly<{
  teamId: unknown; runId: unknown; requestId: unknown; effectRef: unknown
}>) {
  const effectRef = text(input.effectRef, /^effect:[a-f0-9]{64}$/)
  const effectDigest = /^effect:([a-f0-9]{64})$/.exec(effectRef)![1]
  const teamId = team(input.teamId), runId = run(input.runId)
  const requestId = text(input.requestId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/)
  const digest = sha256(JSON.stringify({ schemaVersion: 1, teamId, runId, requestId }))
  return Object.freeze({ teamId, runId, requestId, approvalId: `approval_${digest.slice(0, 32)}`,
    approvalGeneration: `generation_runtime-permission-${effectDigest}` })
}
