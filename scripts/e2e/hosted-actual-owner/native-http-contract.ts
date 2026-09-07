// Owner codec port of frozen Product bd91501036637c76ffcfcc5584ecdd26e9a64a98.
// Data validation only; this module grants no admission or effect authority.
import { createHash } from 'node:crypto'

export const RAW_RECORD_PURPOSE = 'agent-teams.p3c.raw-record/v1' as const;
export const MATRIX_ROWS = Object.freeze([
  '01_pending_before_http',
  '02_browser_allow_deny',
  '03_owner_effect_settlement',
  '04_auth_replay_rejections',
  '05_restart_generation_fences',
  '06_ambiguity_reconciliation',
  '07_socket_capability_admission',
  '08_cross_team_isolation',
  '09_forced_failure_shutdown',
  '10_normal_shutdown_cleanup',
] as const);
export type MatrixRow = (typeof MATRIX_ROWS)[number];

export const RAW_ORIGINS = Object.freeze([
  'browser',
  'product-http',
  'product-sse',
  'owner-wal',
  'opencode',
  'supervisor',
] as const);
export type RawOrigin = (typeof RAW_ORIGINS)[number];


export interface RawRecord {
  readonly schemaVersion: 1;
  readonly purpose: typeof RAW_RECORD_PURPOSE;
  readonly controllerNonce: string;
  readonly origin: RawOrigin;
  readonly row: MatrixRow;
  readonly sequence: number;
  readonly monotonicNs: string;
  readonly processStartToken: string;
  readonly recordId: string;
  readonly event: string;
  readonly correlation: string;
  readonly effectCount: number;
  readonly payloadBase64: string;
  readonly payloadSha256: string;
}


export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('p3c_non_canonical_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError('p3c_non_json_value');
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`p3c_${label}`);
  const item = value as Record<string, unknown>;
  const actual = Object.keys(item).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new TypeError(`p3c_${label}_keys`);
  return item;
}
