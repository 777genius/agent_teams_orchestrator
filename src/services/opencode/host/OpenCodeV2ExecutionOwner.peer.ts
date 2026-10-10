// Test-only separate process. Private IPC barriers surround physical acquisition.
// No OpenCode server/model/runtime is launched by this regression fixture.
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { acquireExecutionProfileOwner } from './OpenCodeV2ExecutionOwner.js'
import type { SelectedExecutionProfile } from './OpenCodeV2ExecutionBinding.js'

process.on('message', async (input: unknown) => {
  if (!input || typeof input !== 'object' || !('profile' in input) || !('identity' in input)) return
  const row = input as { profile: SelectedExecutionProfile; identity: { hostInstanceId: string; leaseOwnerId: string; graphSha256: string } }
  try {
    const owner = await acquireExecutionProfileOwner(row.profile, row.identity)
    await owner.beforeSpawn()
    // This observes the losing process's mutation boundary, not a native SDK pass.
    await appendFile(path.join(row.profile.root, 'TEST-mutation-boundary.log'), row.identity.hostInstanceId + '\n')
    process.send?.({ type: 'owned', record: owner.record })
  } catch (error) {
    process.send?.({ type: 'refused', code: error instanceof Error ? error.message : 'unknown' })
  }
})
process.send?.({ type: 'barrier' })
process.once('disconnect', () => process.exit(0))
