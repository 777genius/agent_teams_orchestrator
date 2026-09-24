import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/work-sync-admission-hash.json'),
    'utf8',
  ),
) as { excludedAdmissionTicketFields: string[] }

const EXCLUDED = [
  'workSyncRuntimeTicketId',
  'workSyncRuntimeGeneration',
  'workSyncRuntimeInstanceId',
  'workSyncAdmissionPayloadHash',
  'workSyncTeamIncarnation',
] as const

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function admissionHash(payload: Record<string, unknown>): Promise<string> {
  const hashed = { ...payload }
  for (const field of EXCLUDED) {
    delete hashed[field]
  }
  return sha256Hex(stableJson(hashed))
}

describe('work-sync admission hash fixture', () => {
  test('matches the shared excluded ticket field list', () => {
    expect(fixture.excludedAdmissionTicketFields).toEqual([...EXCLUDED])
  })

  test('does not treat ticket fields as part of the reserved execution hash', async () => {
    const base = {
      text: 'continue remaining work',
      workSyncControlRevision: 4,
      taskRefs: [{ taskId: 'task-1' }],
    }
    const ticketed = {
      ...base,
      workSyncRuntimeTicketId: 'nonce-1',
      workSyncRuntimeGeneration: 2,
      workSyncRuntimeInstanceId: 'runtime-1',
      workSyncAdmissionPayloadHash: 'placeholder',
      workSyncTeamIncarnation: 'inc-1',
    }
    expect(await admissionHash(ticketed)).toBe(await admissionHash(base))
    expect(await admissionHash({ ...base, text: 'tampered' })).not.toBe(
      await admissionHash(base),
    )
  })
})
