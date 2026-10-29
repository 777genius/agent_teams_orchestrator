import { openCodeBunVersion } from '../constants/openCodeBunVersion.js'
import { recordOpenCodeV2ProviderFailure } from '../features/runtimeProviderManagement/adapters/opencode/OpenCodeV2ProviderManagement.js'
import { classifyOpenCodeV2ExecutionDelivery } from '../services/opencode/host/OpenCodeV2ExecutionDelivery.js'
import { assertExecutionPlatformAvailable } from '../services/opencode/host/OpenCodeV2ExecutionPlatform.js'
import { executionAssert, executionRecord } from '../services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { startOpenCodeV2RunSupervisor, validateRunLaunchPlan } from '../services/opencode/bridge/OpenCodeV2RunOwner.js'
import type { RunLaunchPlan } from '../services/opencode/bridge/OpenCodeV2RunTypes.js'

// Dedicated IPC entry. Native endpoint passwords and lease authority are
// never emitted. Launch configuration is not written to a file or log.
assertExecutionPlatformAvailable()
executionAssert(process.versions.bun === openCodeBunVersion() && process.connected, 'run_source_entry_required')
// Before private IPC, only layout/Bun/transport are known. The parent seals manifest authority in the plan.
classifyOpenCodeV2ExecutionDelivery(import.meta.url)
let started = false
let supervisor: Awaited<ReturnType<typeof startOpenCodeV2RunSupervisor>> | undefined
let startup: Promise<Awaited<ReturnType<typeof startOpenCodeV2RunSupervisor>>> | undefined
let retiring: Promise<void> | undefined
const retire = (): Promise<void> => retiring ??= (async () => {
  if (!supervisor && startup) supervisor = await startup.catch(() => undefined)
  if (supervisor) await supervisor.retire()
})()
const exitOwned = () => { void retire().finally(() => process.exit(0)) }
process.once('SIGTERM', exitOwned)
process.once('SIGINT', exitOwned)
// A successful launcher disconnect does not terminate the run. The run owner
// has its own deadline and closes only its exact member leases.
process.on('disconnect', () => {
  if (!started) process.exit(1)
})
process.on('message', (message: unknown) => {
  if (started) return
  started = true
  void (async () => {
    const frame = executionRecord(message)
    executionAssert(frame.type === 'start' && Object.keys(frame).sort().join(',') === 'directory,plan,sourceSha256,type' &&
      typeof frame.directory === 'string' && typeof frame.sourceSha256 === 'string', 'run_start_invalid')
    const plan = frame.plan as RunLaunchPlan
    validateRunLaunchPlan(plan)
    startup = startOpenCodeV2RunSupervisor(plan, frame.directory, frame.sourceSha256)
    supervisor = await startup
    // Publish the run endpoint before readiness. The initiating CLI receives
    // only a start acknowledgement and later verifies exact record/birth.
    process.send?.({ type: 'ready' })
    void supervisor.owner.stopped.then(() => {
      // Let an in-flight stop response flush before closing the private socket.
      setTimeout(exitOwned, 100)
    })
    await supervisor.owner.ready()
  })().catch(async failure => {
    await recordOpenCodeV2ProviderFailure('run-owner-initialization', failure, true)
    process.send?.({ type: 'failed' })
    await retire().catch(() => undefined)
    process.exit(1)
  })
})
const startTimeout = setTimeout(() => { if (!started) process.exit(1) }, 5000)
startTimeout.unref()
