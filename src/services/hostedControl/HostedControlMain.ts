import { readHostedControlBootstrap } from './HostedControlBootstrap.js'

export async function runHostedControlFromDescriptors(): Promise<void> {
  const admission = await readHostedControlBootstrap()
  const { HostedControlRuntime } = await import('./HostedControlRuntime.js')
  const { createHostedControlProductionPorts } = await import('./HostedControlProductionComposition.js')
  const runtime = new HostedControlRuntime(admission, createHostedControlProductionPorts)
  try {
    await runtime.start()
    await admission.guard.lost
  } finally {
    await runtime.stop()
  }
}
