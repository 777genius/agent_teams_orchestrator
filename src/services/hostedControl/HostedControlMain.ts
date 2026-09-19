import { readHostedControlBootstrap } from './HostedControlBootstrap.js'

export async function runHostedControlFromDescriptors(): Promise<void> {
  const admission = await readHostedControlBootstrap()
  const { HostedControlRuntime } = await import('./HostedControlRuntime.js')
  const { createHostedControlProductionPortFactory } = await import('./HostedControlProductionComposition.js')
  // Capture is explicit and descriptor-backed. The factory does not open FD9
  // or durable files until Runtime has validated and admitted the team root.
  const createPorts = createHostedControlProductionPortFactory(undefined, undefined, {
    environment: process.env,
    modulePath: import.meta.path,
    ownerGeneration: String(admission.config.ownerGeneration),
  })
  const runtime = new HostedControlRuntime(admission, createPorts)
  try {
    await runtime.start()
    await admission.guard.lost
  } finally {
    await runtime.stop()
  }
}
