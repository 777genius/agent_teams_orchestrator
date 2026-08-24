import type { HostedControlRuntimePortFactory } from '../services/hostedControl/HostedControlRuntime.js'
import { HostedControlRuntime } from '../services/hostedControl/HostedControlRuntime.js'

export const HOSTED_CONTROL_CONFIG_ENV = 'CLAUDE_CODE_HOSTED_CONTROL_CONFIG'

export type HostedControlPortFactory = HostedControlRuntimePortFactory

let hostedControlPortFactory: HostedControlPortFactory | null = null
let hostedControlRuntime: HostedControlRuntime | null = null
let uninstallProductionHostedControlPortFactory: (() => void) | null = null

export function installHostedControlPortFactory(factory: HostedControlPortFactory): () => void {
  if (hostedControlPortFactory) throw new Error('Hosted control ports are already installed')
  hostedControlPortFactory = factory
  return () => {
    if (hostedControlPortFactory === factory) hostedControlPortFactory = null
  }
}

export async function startHostedControlFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostedControlRuntime | null> {
  const configPath = environment[HOSTED_CONTROL_CONFIG_ENV]?.trim()
  if (!configPath) return null
  throw new Error(
    'Hosted control launch is blocked: environment/argv file bearers are readable by same-UID workloads; an isolated non-inherited bootstrap descriptor is required',
  )
}

/** Installs the one production composition before starting the one hosted runtime. */
export async function startProductionHostedControlFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostedControlRuntime | null> {
  if (!environment[HOSTED_CONTROL_CONFIG_ENV]?.trim()) return null
  return startHostedControlFromEnvironment(environment)
}

export async function stopHostedControl(): Promise<void> {
  const runtime = hostedControlRuntime
  hostedControlRuntime = null
  const uninstall = uninstallProductionHostedControlPortFactory
  uninstallProductionHostedControlPortFactory = null
  try {
    await runtime?.stop()
  } finally {
    uninstall?.()
  }
}

// The broad experimental inbox server was removed from this source snapshot.
// Keep these exports fail-closed so a UDS_INBOX build cannot silently claim a
// listener that it does not implement.
export function getDefaultUdsSocketPath(): never {
  throw new Error('UDS_INBOX is unavailable; use the HOSTED_CONTROL feature')
}

export async function startUdsMessaging(
  _socketPath?: string,
  _options?: { isExplicit?: boolean },
): Promise<never> {
  throw new Error('UDS_INBOX is unavailable; use the HOSTED_CONTROL feature')
}
