import { expect, test } from 'bun:test'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import { launchableStagedOpenCodeV2Pins } from '../compatibility/fixtures/stagedOpenCodeV2Pins.js'
import type { ExecutionAuthority, ExecutionContext } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createOpenCodeV2ExecutionClient } from './OpenCodeV2ExecutionClientFactory.js'

/** Public DTO resembles a persisted authority, including this process's PID. It is
 * deliberately NOT an acquired lease: no host/native effects belong in this test. */
function persistedAuthority(pin: OpenCodeV2Pin): ExecutionAuthority {
  return { generation: 'v2', pin, dialect: pin === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.32',
    graphSha256: 'a'.repeat(64), selectedCli: { path: '/TEST/opencode', sha256: 'b'.repeat(64), version: pin },
    child: { pid: process.pid, birth: { format: 'linux-start-ticks', value: '123', bootId: 'TEST-boot' },
      executablePath: process.execPath, sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-profile', profileRoot: '/TEST/profile',
    directory: '/TEST/project', leaseOwnerId: 'TEST-owner' }
}
const context: ExecutionContext = { teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane',
  memberId: 'TEST-member', deadline: Date.now() + 10_000 }
for (const pin of launchableStagedOpenCodeV2Pins) {
  test(`${pin} persisted authority cannot mint native endpoint/client/disposer authority`, async () => {
    const persisted = persistedAuthority(pin)
    await expect(createOpenCodeV2ExecutionClient(persisted, context)).rejects.toThrow('execution_lease_not_owned')
    const sameFields: ExecutionAuthority = { ...persisted, child: { ...persisted.child }, selectedCli: { ...persisted.selectedCli } }
    await expect(createOpenCodeV2ExecutionClient(sameFields, context)).rejects.toThrow('execution_lease_not_owned')
    await expect(createOpenCodeV2ExecutionClient(persisted, { ...context, runId: 'TEST-foreign-run' }))
      .rejects.toThrow('execution_lease_not_owned')
  })
}
