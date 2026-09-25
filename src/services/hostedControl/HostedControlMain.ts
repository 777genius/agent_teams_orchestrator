import { feature } from 'bun:bundle'
import { realpath } from 'node:fs/promises'
import {
  HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND,
  readHostedControlBootstrap,
  type HostedControlBootstrapAdmission,
} from './HostedControlBootstrap.js'
import type { HostedControlRuntimePortFactory } from './HostedControlRuntime.js'
import type { HostedPersonalHostLocalConfig } from './HostedPersonalHostLocalComposition.js'

declare const HOSTED_CONTROL_BUILD_OWNER_EXECUTABLE_DIGEST: string | undefined

export type HostedControlMainDependencies = {
  expectedOwnerExecutableDigest: unknown
  readBootstrap(options: {
    expectedOwnerExecutableDigest: `sha256:${string}`
  }): Promise<HostedControlBootstrapAdmission>
  runAdmission(admission: HostedControlBootstrapAdmission): Promise<void>
}

export async function runHostedControlFromDescriptors(): Promise<void> {
  await runHostedControlFromDescriptorsWithDependencies({
    expectedOwnerExecutableDigest: feature('HOSTED_CONTROL_BUILT_OWNER_PIN') &&
      typeof HOSTED_CONTROL_BUILD_OWNER_EXECUTABLE_DIGEST === 'string'
      ? HOSTED_CONTROL_BUILD_OWNER_EXECUTABLE_DIGEST
      : undefined,
    readBootstrap: readHostedControlBootstrap,
    runAdmission: runHostedControlAdmission,
  })
}

export async function runHostedControlFromDescriptorsWithDependencies(
  dependencies: HostedControlMainDependencies,
): Promise<void> {
  const { expectedOwnerExecutableDigest } = dependencies
  if (typeof expectedOwnerExecutableDigest !== 'string' ||
    expectedOwnerExecutableDigest.length !== 71 ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedOwnerExecutableDigest)) {
    throw new Error('Hosted control owner executable digest pin was rejected')
  }
  const admission = await dependencies.readBootstrap({
    expectedOwnerExecutableDigest: expectedOwnerExecutableDigest as `sha256:${string}`,
  })
  await dependencies.runAdmission(admission)
}

export type HostedControlPortFactories = Readonly<{
  standard: HostedControlRuntimePortFactory
  personalHost(config: HostedPersonalHostLocalConfig): HostedControlRuntimePortFactory
}>

/** The admission kind is the only switch between no lanes and host-local lanes. */
export function selectHostedControlPortFactory(
  admission: Pick<HostedControlBootstrapAdmission, 'admissionKind' | 'appMcp'>,
  factories: HostedControlPortFactories,
): HostedControlRuntimePortFactory {
  return admission.admissionKind === HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND
    ? factories.personalHost({ appMcp: admission.appMcp ?? null })
    : factories.standard
}

/**
 * bun auto-loads `.env` from cwd, so ambient MCP wiring is removed rather than
 * trusted. A personal-host owner uses the signed Claude root as its config
 * root so bridge, mailbox and task paths match the hosted team root.
 */
export function prepareHostedControlEnvironment(
  admission: Pick<HostedControlBootstrapAdmission, 'admissionKind'>,
  claudeRoot: string,
  ignoredKeys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const key of ignoredKeys) delete env[key]
  if (admission.admissionKind === HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND) {
    env.CLAUDE_CONFIG_DIR = claudeRoot
  }
}

async function runHostedControlAdmission(
  admission: HostedControlBootstrapAdmission,
): Promise<void> {
  const claudeRoot = await realpath(admission.config.claudeRoot)
  const {
    HOSTED_IGNORED_APP_MCP_ENV_KEYS,
    installHostedAppMcpAuthority,
  } = await import('../opencode/OpenCodeMcpManager.js')
  prepareHostedControlEnvironment(admission, claudeRoot, HOSTED_IGNORED_APP_MCP_ENV_KEYS)
  installHostedAppMcpAuthority({
    descriptor: admission.admissionKind === HOSTED_CONTROL_PERSONAL_HOST_ADMISSION_KIND
      ? admission.appMcp ?? null
      : null,
    claudeRoot,
  })
  const { HostedControlRuntime } = await import('./HostedControlRuntime.js')
  const { createHostedControlProductionPorts } = await import('./HostedControlProductionComposition.js')
  const { createHostedPersonalHostLocalPortFactory } = await import('./HostedPersonalHostLocalComposition.js')
  const runtime = new HostedControlRuntime(admission, selectHostedControlPortFactory(admission, {
    standard: createHostedControlProductionPorts,
    personalHost: createHostedPersonalHostLocalPortFactory,
  }))
  try {
    await runtime.start()
    await admission.guard.lost
  } finally {
    await runtime.stop()
  }
}
