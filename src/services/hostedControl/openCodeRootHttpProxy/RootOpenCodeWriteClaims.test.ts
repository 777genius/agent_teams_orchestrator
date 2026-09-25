import { expect, test } from 'bun:test'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'

import { RootOpenCodeWriteClaims } from './RootOpenCodeWriteClaims.js'

test('root claim survives restart and rejects conflicting reuse of an operation id', async () => {
  const directory = await realpath(await mkdtemp('/tmp/root-opencode-claims-'))
  await chmod(directory, 0o700)
  try {
    const first = new RootOpenCodeWriteClaims(directory, true)
    expect(first.claim('operation_12345678', 'a'.repeat(64))).toBe('created')
    const restarted = new RootOpenCodeWriteClaims(directory, true)
    expect(restarted.claim('operation_12345678', 'a'.repeat(64))).toBe('already_claimed')
    expect(restarted.claim('operation_12345678', 'b'.repeat(64))).toBe('claim_conflict')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
