import { feature } from 'bun:bundle'
import {
  readHostedControlBootstrap,
  type HostedControlBootstrapAdmission,
} from './HostedControlBootstrap.js'

declare const HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST: string | undefined

export type HostedControlMainDependencies = {
  expectedOwnerArtifactDigest: unknown
  readBootstrap(options: {
    expectedOwnerArtifactDigest: `sha256:${string}`
  }): Promise<HostedControlBootstrapAdmission>
  runAdmission(admission: HostedControlBootstrapAdmission): Promise<void>
}

export async function runHostedControlFromDescriptors(): Promise<void> {
  await runHostedControlFromDescriptorsWithDependencies({
    expectedOwnerArtifactDigest: feature('HOSTED_CONTROL_BUILT_OWNER_PIN') &&
      typeof HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST === 'string'
      ? HOSTED_CONTROL_BUILD_OWNER_ARTIFACT_DIGEST
      : undefined,
    readBootstrap: readHostedControlBootstrap,
    runAdmission: runHostedControlAdmission,
  })
}

export async function runHostedControlFromDescriptorsWithDependencies(
  dependencies: HostedControlMainDependencies,
): Promise<void> {
  const { expectedOwnerArtifactDigest } = dependencies
  if (typeof expectedOwnerArtifactDigest !== 'string' ||
    expectedOwnerArtifactDigest.length !== 71 ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedOwnerArtifactDigest)) {
    throw new Error('Hosted control owner artifact digest pin was rejected')
  }
  const admission = await dependencies.readBootstrap({
    expectedOwnerArtifactDigest: expectedOwnerArtifactDigest as `sha256:${string}`,
  })
  await dependencies.runAdmission(admission)
}

async function runHostedControlAdmission(
  admission: HostedControlBootstrapAdmission,
): Promise<void> {
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
